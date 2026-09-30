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
      // 管理器自己会回滚这一次；后面的不必再试（通常同一个原因）
      return { ok: false, mode: 'managed', results, failedSpec: spec, error: failureText(result) }
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

  return { ok: true, mode: 'managed', results, removals }
}

// ─────────────────────────── HTTP 端点通道 ───────────────────────────

/** 目标 profile 的 web 端口（从它的 cordis.patch.yml 里读）。读不到返回 null。 */
export function profilePort(profileDir) {
  try {
    const patch = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
    const m = /(?:^|\n)\s*port:\s*(\d+)/.exec(patch)
    return m === null ? null : Number(m[1])
  } catch {
    return null
  }
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
