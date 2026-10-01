/**
 * dsh-profile-sync —— 受管安装通道（真正能写桌面端 profile 的那一条）
 *
 * ## 为什么需要这个模块
 *
 * 我原来的设计是「退出桌面端 → `dsh plugin --profile desktop install`」。
 * **那条路根本不存在。** `@deepseek-ai/dsh/lib/bin.js` 里有一条按名字硬拦的守卫：
 *
 *     function rejectElectronProfile(program, profile) {
 *       if (profile.toLowerCase() === "desktop")
 *         program.error('error: profile "desktop" is managed exclusively by the Electron application')
 *     }
 *
 * 它对**一切** CLI 调用生效 —— 连 `--dump-config` 都被拒。dshmarket 的源码里
 * 也有一行注释写着同一件事：「Never fall back to `dsh plugin --profile desktop`:
 * that CLI is forbidden.」
 *
 * 所以桌面端 profile 唯一的写入器是**应用内的官方插件管理器**
 * （cordis 服务名 `pluginManager`，也就是官方「设置 → 插件」页面用的那个）。
 * 它同时提供两条可用的入口，本模块都实现了：
 *
 *   1. **进程内**（宿主插件自己用，最干净）
 *      `ctx.get('pluginManager').installBundle(spec, { requestId })` / `.removeBundle(name)`
 *      返回 `{ application, packageResult, error }`，
 *      `application` 是 `applied` / `restart-required` / `overridden` 才算成功。
 *
 *   2. **HTTP 端点**（脚本、应用外面用）
 *      `POST /api/plugin-manager/install  { spec }` → `{ jobId }`，异步；
 *      loopback 围栏（socket 地址 + Host 头 + 同源标记），本机直连即可。
 *      装完之后要靠轮询 `/api/plugin-manager/list` 才知道结果。
 *
 * 两条路都**不接受** pnpm 的附加参数（官方管理器自己决定怎么装），
 * 所以本模块只传 spec 本身。
 */

import path from 'node:path'
import { readFileSync } from 'node:fs'

import { mergeAllowBuildsText } from './plan.js'
import { writeFileAtomicSync } from './apply.js'

/** 官方管理器认为「这次改动被保住了」的三种 application 取值。 */
const APPLIED = new Set(['applied', 'restart-required', 'overridden'])

/**
 * 从宿主上下文里取官方插件管理器。
 * 形状抄 dshmarket/lib/index.js:177 —— `hostCtx.get('pluginManager')`。
 * 多试几条路径是因为不同宿主暴露服务的方式略有差别，而取不到时必须**老实说取不到**，
 * 不能默默退回 CLI（那条路对桌面端必然失败）。
 * @returns {object|undefined}
 */
export function resolvePluginManager(ctx) {
  if (ctx === null || ctx === undefined) return undefined
  const candidates = []
  try {
    if (typeof ctx.get === 'function') candidates.push(ctx.get('pluginManager'))
  } catch {
    /* 试下一条 */
  }
  try {
    if (ctx.reflect !== undefined && typeof ctx.reflect.get === 'function') {
      candidates.push(ctx.reflect.get('pluginManager', false))
    }
  } catch {
    /* 试下一条 */
  }
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && typeof candidate.installBundle === 'function') {
      return candidate
    }
  }
  return undefined
}

/**
 * 计划里一条 entry 该以什么 spec 交给官方管理器。
 * 拼法抄 apply 层的规矩（也是 pnpm 的规矩）：
 *   · registry 存的是范围 → 必须拼成 `name@range`
 *   · link: / file: / git 存的是完整 spec → 只能原样给（前面不能加 name@）
 */
export function managedSpec(entry) {
  const kind = entry.kind ?? 'registry'
  return kind === 'registry' ? `${entry.name}@${entry.spec}` : entry.spec
}

/** 要装/要改的 spec 列表（顺序稳定）。 */
export function managedSpecs(plan) {
  return [...(plan.add ?? []), ...(plan.change ?? [])].map(managedSpec)
}

/**
 * 受管路径也必须自己补 `allowBuilds` —— **官方管理器不管 `pnpm-workspace.yaml`**。
 *
 * 离线路径（`lib/apply.js` 里 install 之前那一步）早就做这件事了，注释写着原因：
 * 少了授权，pnpm 不会铺原生依赖的构建产物，包看着装好了、`node-pty` 的
 * `conpty.dll` 却没出来。两条路不等价的话，「面板应用（当场生效）」就会在
 * 任何需要 `allowBuilds` 的 profile 上比离线路径表现更差 —— 同一个计划换条路
 * 执行就换个结果，正是最难发现的那种漂移。
 *
 * 官方管理器只负责 `package.json` 与 `bundles`，所以这一步只能我们自己做；
 * 也因为它不在管理器的回滚范围内，失败时**必须由我们退回原样**。
 *
 * @param {object} plan computePlan 的结果
 * @returns {{added: string[], skipped: string[], warnings: string[], undo: (() => void)|null}}
 */
export function prepareAllowBuilds(plan) {
  const none = { added: [], skipped: [], warnings: [], undo: null }
  const targetDir = plan?.target?.dir
  const add = Array.isArray(plan?.allowBuilds?.add) ? plan.allowBuilds.add : []
  if (typeof targetDir !== 'string' || targetDir === '' || add.length === 0) return none

  const file = path.join(targetDir, 'pnpm-workspace.yaml')
  let before = null
  try {
    before = readFileSync(file, 'utf8')
  } catch {
    before = null
  }
  const merged = mergeAllowBuildsText(before ?? '', add, plan.allowBuilds?.addValues)

  if (before === null) {
    return {
      added: [],
      skipped: merged.added,
      warnings: [
        '目标 profile 没有 pnpm-workspace.yaml，已跳过 allowBuilds。' +
          '不敢新建：一个只含 allowBuilds 的文件会丢掉 nodeLinker: hoisted 这类必要设置，' +
          '反而会把安装搞坏（pnpm 默认是 isolated）。',
      ],
      undo: null,
    }
  }
  if (merged.added.length === 0) return none

  writeFileAtomicSync(file, merged.text)
  return { added: merged.added, skipped: [], warnings: [], undo: () => writeFileAtomicSync(file, before) }
}

function failureText(result) {
  if (result === null || result === undefined) return '管理器没有给出结果'
  if (typeof result.error === 'string' && result.error !== '') return result.error
  if (result.error !== undefined) {
    try {
      return JSON.stringify(result.error)
    } catch {
      return String(result.error)
    }
  }
  return `application=${JSON.stringify(result.application ?? null)}`
}

/**
 * 用**进程内**官方管理器应用计划。
 *
 * 重要：这个模式下**不要自己写 package.json**。官方管理器就是那个写入器 ——
 * 它自己负责改 dependencies、注册 dsh.profile.bundles、跑兼容性校验、
 * 失败时回滚。我们再写一遍只会打架。
 *
 * @param {object} plan computePlan 的结果
 * @param {object} options
 * @param {object} options.manager resolvePluginManager 拿到的管理器
 * @param {boolean} [options.prune] 是否顺带移除「只在目标端」的依赖
 * @param {(line: string) => void} [options.log]
 */
export async function applyManaged(plan, options) {
  const { manager } = options
  const prune = options.prune === true || plan.prune === true
  const log = options.log ?? (() => {})
  if (manager === undefined || manager === null || typeof manager.installBundle !== 'function') {
    throw new Error('拿不到官方插件管理器（pluginManager 服务）——不能退回 CLI，那条路对桌面端是被禁止的')
  }

  // allowBuilds 必须在**第一次 installBundle 之前**落盘：管理器的每一次
  // installBundle 都是一次真的 pnpm 安装，装的时候授权就得已经在文件里了。
  const build = prepareAllowBuilds(plan)
  for (const w of build.warnings) log(`注意：${w}`)
  if (build.added.length > 0) log(`allowBuilds 补入 ${build.added.length} 项：${build.added.join('、')}`)

  const results = []
  const specs = managedSpecs(plan)
  log(`交给官方进程内管理器：${specs.length} 个安装/更新`)
  for (const spec of specs) {
    log(`  → installBundle(${spec})`)
    let result
    try {
      result = await manager.installBundle(spec, { requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    } catch (err) {
      result = { application: 'failed', error: String(err?.message ?? err) }
    }
    const ok = APPLIED.has(result?.application)
    results.push({ spec, ok, application: result?.application ?? null, output: result?.packageResult?.output ?? '', error: ok ? null : failureText(result) })
    log(`    ${ok ? '✓' : '✗'} application=${result?.application ?? '(none)'}${ok ? '' : ' — ' + failureText(result)}`)
    if (!ok) {
      // 管理器自己会回滚这一次；后面的不必再试（通常同一个原因）。
      // 但 allowBuilds 是我们写的、不在它的回滚范围里，得自己退。
      const reverted = build.undo !== null
      if (reverted) {
        build.undo()
        log('已把 pnpm-workspace.yaml 的 allowBuilds 退回原样（这次迁移不留半成品）')
      }
      return {
        ok: false,
        mode: 'managed',
        results,
        failedSpec: spec,
        error: failureText(result),
        allowBuildsAdded: [],
        allowBuildsSkipped: build.skipped,
        allowBuildsReverted: reverted,
      }
    }
  }

  // ── 组合包（bundle）启用 ──────────────────────────────────────────────
  //
  // 官方管理器只在**安装**那一刻顺带启用新组合包；「依赖早就装好了、只是没进
  // 加载层」这种差异它不碰。而离线路径（`lib/apply.js` 把 `bundles` 并进 manifest）
  // 会启用 —— 两条路必须等价，否则「只勾了带 bundle 的那一行」在受管路径上会
  // **什么都没做却报成功**（index.js 的「已经一致」文案还会把它盖过去）。
  //
  // 只对**不在安装清单里**的名字调用：官方 README 明写「启用会把组合包追加到列表
  // 末尾」，可能改变配置优先级 —— 已经装过、顺带启用过的那批不该被再重排一次。
  const installedNames = new Set([...(plan.add ?? []), ...(plan.change ?? [])].map((e) => e.name))
  const bundleResults = []
  for (const name of (plan.bundles?.add ?? []).filter((n) => !installedNames.has(n))) {
    if (typeof manager.setBundleEnabled !== 'function') {
      // 如实失败。**不能** continue 之后还报 ok：那样 index.js 的「已经一致」
      // 文案会把这个缺口盖过去，用户看到的又是一次假成功。
      const why = '这个宿主的管理器没有 setBundleEnabled，组合包启用不了'
      bundleResults.push({ name, ok: false, application: null, error: why })
      log(`  ✗ ${why}：${name}`)
      return {
        ok: false,
        mode: 'managed',
        results,
        bundleResults,
        failedBundle: name,
        error: why,
        allowBuildsAdded: build.added,
        allowBuildsSkipped: build.skipped,
        allowBuildsReverted: false,
      }
    }
    log(`  → setBundleEnabled(${name}, true)`)
    let result
    try {
      result = await manager.setBundleEnabled(name, true)
    } catch (err) {
      result = { application: 'failed', error: String(err?.message ?? err) }
    }
    const ok = APPLIED.has(result?.application)
    bundleResults.push({ name, ok, application: result?.application ?? null, error: ok ? null : failureText(result) })
    log(`    ${ok ? '✓' : '✗'} application=${result?.application ?? '(none)'}${ok ? '' : ' — ' + failureText(result)}`)
    if (!ok) {
      // 已经装好的那些**不回滚** —— 它们是真实成功的，而且刚补的 allowBuilds
      // 授权正是它们需要的。只把这一项如实报上去（allowBuildsReverted=false）。
      return {
        ok: false,
        mode: 'managed',
        results,
        bundleResults,
        failedBundle: name,
        error: failureText(result),
        allowBuildsAdded: build.added,
        allowBuildsSkipped: build.skipped,
        allowBuildsReverted: false,
      }
    }
  }

  const removals = []
  if (prune) {
    for (const entry of plan.extraInTarget ?? []) {
      if (typeof manager.removeBundle !== 'function') {
        removals.push({ name: entry.name, ok: false, error: '这个宿主的管理器没有 removeBundle' })
        continue
      }
      log(`  → removeBundle(${entry.name})`)
      let result
      try {
        result = await manager.removeBundle(entry.name)
      } catch (err) {
        result = { application: 'failed', error: String(err?.message ?? err) }
      }
      const ok = APPLIED.has(result?.application)
      removals.push({ name: entry.name, ok, application: result?.application ?? null, error: ok ? null : failureText(result) })
      log(`    ${ok ? '✓' : '✗'} ${ok ? '' : '— ' + failureText(result)}`)
    }
  }

  return {
    ok: true,
    mode: 'managed',
    results,
    bundleResults,
    removals,
    allowBuildsAdded: build.added,
    allowBuildsSkipped: build.skipped,
  }
}

// ─────────────────────────── HTTP 端点通道 ───────────────────────────

/**
 * 目标 profile 的 web 端口。**多来源，按权威性排序**：
 *
 * 1. **当前 profile + `DSH_WEB_URL`** —— 运行时最权威。端口现在的归属是**启动参数**：
 *    桌面端宿主写死 `--port 19387`，web 走 bundle 层的
 *    `port: !!js ctx.webStartup.port ?? 3080`（见
 *    `@deepseek-ai/dsh-web-app/cordis.patch.yml`）。只有这一档能正确处理
 *    `--port 0`（操作系统随机分配）或用户自定义的端口。
 * 2. **profile 自己的 patch 里的 `port:`** —— 旧版 DSH、或用户手写 patch 的场景。
 * 3. **`web` profile 的出厂默认 3080** —— 有依据的常量（同上那行 `?? 3080`），
 *    但**只对名为 web 的 profile** 用：别的 profile 未必是 web 服务器，
 *    拿 3080 去猜会让 installViaEndpoint 打到错误的服务器上。
 *
 * 三档都读不到就返回 null —— **不猜**（猜错的代价是往别的进程发安装请求）。
 *
 * @param {string} profileDir
 * @param {string} [profileName] 不给就从目录名取
 * @returns {{port: number|null, source: string}}
 */
export function profilePortInfo(profileDir, profileName) {
  const name =
    typeof profileName === 'string' && profileName !== '' ? profileName : path.basename(String(profileDir ?? ''))

  // 1) 当前 profile：运行时 URL 最权威
  const currentDir = process.env.DSH_PROFILE_DIR
  const currentName = process.env.DSH_PROFILE
  const isCurrent =
    (typeof currentDir === 'string' &&
      currentDir !== '' &&
      typeof profileDir === 'string' &&
      path.resolve(currentDir) === path.resolve(profileDir)) ||
    (typeof currentName === 'string' && currentName !== '' && currentName.toLowerCase() === name.toLowerCase())
  if (isCurrent) {
    const url = process.env.DSH_WEB_URL
    if (typeof url === 'string' && url !== '') {
      try {
        const parsed = new URL(url)
        if (parsed.port !== '') {
          return { port: Number(parsed.port), source: 'DSH_WEB_URL（当前 profile 的运行时地址）' }
        }
        if (parsed.protocol === 'http:') return { port: 80, source: 'DSH_WEB_URL（未写端口 → http 默认 80）' }
        if (parsed.protocol === 'https:') return { port: 443, source: 'DSH_WEB_URL（未写端口 → https 默认 443）' }
      } catch {
        /* URL 不合法就继续往下试 */
      }
    }
  }

  // 2) profile 自己的 patch
  try {
    const patch = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
    const m = /(?:^|\n)\s*port:\s*(\d+)/.exec(patch)
    if (m !== null) return { port: Number(m[1]), source: 'profiles/<name>/cordis.patch.yml 里的 port:' }
  } catch {
    /* 没有 patch 文件，或读不了 */
  }

  // 3) web 的出厂默认
  if (name.toLowerCase() === 'web') {
    return { port: 3080, source: 'web 的出厂默认 3080（可能被 --port 覆盖）' }
  }
  return { port: null, source: '读不到（patch 无 port、非当前 profile）' }
}

/** 只要端口数字的旧签名。读不到返回 null。 */
export function profilePort(profileDir, profileName) {
  return profilePortInfo(profileDir, profileName).port
}

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 就原样带回去 */
    }
    return { status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    const text = await res.text()
    try {
      return { status: res.status, json: JSON.parse(text) }
    } catch {
      return { status: res.status, json: null, text }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用**官方管理器的 HTTP 端点**装一个 spec（脚本、应用外面用这条）。
 *
 * 端点是异步的：POST 回 `{jobId}`，真正的结果要靠轮询 `list` 看包有没有出现。
 * 没有 jobId 的查询接口（`status` 需要参数，形状未公开），所以轮询 list 是
 * 唯一稳的判据 —— 它读的就是 profile 的真实状态，本来也是我们要的答案。
 *
 * @returns {{ok: boolean, jobId?: string, status: number, message?: string}}
 */
export async function installViaEndpoint(spec, options = {}) {
  const port = options.port
  const base = options.base ?? `http://127.0.0.1:${port}`
  const log = options.log ?? (() => {})
  const timeoutMs = options.timeoutMs ?? 180000
  const pollMs = options.pollMs ?? 2000

  const name = options.name ?? null
  const posted = await postJson(`${base}/api/plugin-manager/install`, { spec }, 30000)
  if (posted.status !== 200) {
    return { ok: false, status: posted.status, message: posted.json?.message ?? posted.json?.error ?? posted.text ?? `HTTP ${posted.status}` }
  }
  const jobId = posted.json?.jobId ?? null
  log(`已提交给官方管理器（jobId=${jobId ?? '?'}），等待落盘…`)

  if (name === null) return { ok: true, status: 200, jobId, message: '已提交（未给包名，无法确认落盘）' }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    let listed
    try {
      listed = await getJson(`${base}/api/plugin-manager/list`, 15000)
    } catch (err) {
      log(`  轮询失败（继续等）：${String(err?.message ?? err)}`)
      continue
    }
    const plugins = listed.json?.plugins
    if (Array.isArray(plugins)) {
      const hit = plugins.find((p) => p?.id === name || p?.name === name)
      if (hit !== undefined) {
        return { ok: true, status: 200, jobId, installed: hit }
      }
    }
  }
  return { ok: false, status: 200, jobId, message: `等了 ${Math.round(timeoutMs / 1000)} 秒还没看到 ${name} 出现在已装列表里` }
}
