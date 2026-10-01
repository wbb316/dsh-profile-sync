/**
 * dsh-profile-sync —— 宿主侧
 *
 * 给 agent 一个 profile_sync 工具、给面板一组 HTTP 接口，并把「计划 → 退出 → 执行 → 重启核对」
 * 这条链路串起来。
 *
 * 三条这个生态里踩过的硬规矩（照 dsh-novel 的教训写的）：
 *
 * 1) **不要 import 任何 `@deepseek-ai/*` 宿主包**。它们是 peerDependencies，
 *    link 安装时 Node 从物理路径往上找 → ERR_MODULE_NOT_FOUND。
 *    所以这里只用 node 内置模块 + 自己的相对路径文件。
 *
 * 2) 工具的 `parameters` / `output.schema` 必须是**原始 JSON Schema**
 *    （`{ type:'object', properties:{...}, required:[...] }`），
 *    不是 schemastery 那种 `{ x: { type:'string', required:true } }`。
 *
 * 3) 同一路径只注册一条路由，重复注册会抛 duplicate 并让**整张路由表**失效。
 *
 * 关于「谁有权写 profile」——这里有一处**踩过才知道的硬约束**：
 *
 * 桌面端（app 自有）的 profile **禁止用 dsh CLI 修改**。`@deepseek-ai/dsh/lib/bin.js`
 * 里有一条按名字硬拦的守卫，对一切 CLI 调用生效（连 `--dump-config` 都被拒）：
 *
 *     error: profile "desktop" is managed exclusively by the Electron application
 *
 * 所以桌面端唯一的写入器是**应用内的官方插件管理器**（cordis 服务 `pluginManager`，
 * 即「设置 → 插件」页面用的那个），见 lib/managed.js。
 * 而 web / headless 这类 CLI 拥有的 profile 才走 `dsh plugin ...` 或生成的脚本。
 *
 * 本插件因此有两种应用方式：`apply`（走应用内管理器，当场生效）与
 * `write`（生成离线脚本，给 CLI 拥有的 profile 用）。
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  computePlan,
  currentProfileFromEnv,
  filterPlan,
  isProfileName,
  renderPlanText,
  profilesRoot,
  selectablePlugins,
} from './plan.js'
import { readPending, resolveNodeExe, verifyPending, writePlanArtifacts } from './artifacts.js'
import { applyManaged, profilePortInfo, resolvePluginManager } from './managed.js'

/** 本插件的根目录（lib/ 的上一层）—— 用来定位 bin/apply.mjs。 */
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const APPLY_SCRIPT = path.join(PLUGIN_DIR, 'bin', 'apply.mjs')

/** 面板席位 id（客户端注册时用同一个）。 */
export const PANEL_ID = 'dsh-profile-sync'

/** 文本型工具的共用输出契约：execute 返回 { text }，render 转成文本块。 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string', description: '返回给模型的文本' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String((value && value.text) ?? '') }],
}

// ─────────────────────────── 小工具 ───────────────────────────

/**
 * 「当前 profile」的最终判定结果。由 {@link resolveHostProfile} 在 apply() 里落定：
 * 优先问宿主的 `profileContext` 服务，再退回环境变量。
 *
 * 为什么不能只看环境变量：`DSH_PROFILE` 只在 **shell 调用**里存在（宿主注入给 shell 的），
 * 宿主进程自己的环境里**没有** —— 原先 `?? 'desktop'` 的兜底会让网页版把自己认成 desktop，
 * 于是默认目标变成 desktop，还会对着错误的一对 profile 报「已经一致」。
 * 所以这里初始为「未解析」，且**绝不给名字兜底**。
 */
let hostProfileName = null
let hostProfileResolved = false

/**
 * 在插件激活时把「我是谁」定下来。
 * 取不到就留 null —— 调用方必须明确报错，而不是猜一个。
 */
export function resolveHostProfile(ctx) {
  const candidates = []
  try {
    const pc = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
    if (pc !== null && typeof pc === 'object') {
      for (const key of ['name', 'profile', 'profileName']) {
        if (typeof pc[key] === 'string' && pc[key].trim() !== '') candidates.push(pc[key].trim())
      }
      if (typeof pc.dir === 'string' && pc.dir.trim() !== '') {
        const base = path.basename(pc.dir.trim())
        if (isProfileName(base) && base !== 'profiles') candidates.push(base)
      }
    }
  } catch {
    /* 服务取不到就换下一条来源 */
  }
  const fromEnv = currentProfileFromEnv()
  if (fromEnv !== null) candidates.push(fromEnv)

  hostProfileName = candidates.length > 0 ? candidates[0] : null
  hostProfileResolved = true
  return hostProfileName
}

function currentProfileName() {
  if (hostProfileResolved) return hostProfileName
  // 还没解析过（单测/CLI 直接调用）：只认环境，认不出返回 null
  return currentProfileFromEnv()
}

/**
 * 这个目标 profile 能不能由**应用内的官方管理器**写。
 *
 * 唯一的硬约束是：**管理器只写它自己所属的那个 profile**
 * （dshmarket 的 official runtime 会直接拒绝 `profile !== profileName`）。
 * 所以规则跟 profile 叫什么名字无关，只看「目标是不是当前这个 profile」：
 *
 *   · 目标是当前 profile → 走管理器，当场生效，不用退出应用
 *   · 目标不是当前 profile → 管理器爱莫能助，走 CLI / 生成的脚本
 *
 * 早先这里写死了 `=== 'desktop'`，因为当时只验证过桌面端。
 * 实测确认网页版也暴露同一套管理器（`/api/plugin-manager/*` 在两个端口上都在），
 * 所以放宽成通用规则 —— 两个方向都能当场生效，也不再依赖 profile 名字的字面量。
 *
 * 取不到 `pluginManager` 服务时由调用方另行拒绝（这里不管），
 * 因为取不到就不该装作能写。
 */
export function canApplyInApp(targetName, current = currentProfileName()) {
  const target = String(targetName ?? '').trim().toLowerCase()
  const me = String(current ?? '').trim().toLowerCase()
  return target !== '' && target === me
}

/** profiles/ 下有哪些 profile（附带各自装了几个插件，给人看）。 */
function listProfiles() {
  const root = profilesRoot()
  const out = []
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const dir = path.join(root, name)
    let isDir = false
    try {
      isDir = fs.statSync(dir).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    let count = 0
    let port = null
    let portSource = null
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const deps = manifest?.dependencies ?? {}
      count = Object.keys(deps).filter((n) => !n.startsWith('@deepseek-ai/dsh-')).length
    } catch {
      /* 没 manifest 也算一个 profile，只是数为 0 */
    }
    try {
      const info = profilePortInfo(dir, name)
      port = info.port
      portSource = info.source
    } catch (err) {
      // 不静默：把原因带出去。这条 catch 曾经把「函数名/导入写错」这类错误
      // 完全吞掉，面板上只显示一个空白端口，查起来毫无线索。
      portSource = `读取失败：${String(err?.message ?? err)}`
    }
    out.push({ name, dir, plugins: count, port, portSource, current: name === currentProfileName() })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function safePlan(options) {
  const source = options?.source ?? 'web'
  const target = options?.target ?? currentProfileName()
  // 认不出「我是谁」时必须明确报错，**不能**猜一个默认目标 ——
  // 猜错的后果是算了一对错误的 profile 还报「已经一致」（真踩过）。
  if (target === null || target === undefined || String(target).trim() === '') {
    throw new Error(
      '无法确定当前 profile，所以不知道默认目标是谁。请显式给 target（例如 target: "web"）。' +
        '（宿主的 profileContext 服务与此进程的环境变量都没提供这个信息。）'
    )
  }
  return computePlan({ source, target, prune: options?.prune === true })
}

/**
 * 「一个插件都没勾」是合法输入，但语义是「什么都不做」——
 * 它筛出来的计划是空的，而 `ok` 仍为 true，与「目标已经一致」在 ok 字段上
 * **分不出来**（test-plan.mjs 里有一条用例专门钉这个）。所以每条真会动手的
 * 路径都必须在动手前显式拦一下，不能只看 plan.ok。
 */
function isNothingSelected(only) {
  return Array.isArray(only) && only.length === 0
}

/** 生成产物，返回 { dir, planFile, cmdFile, blocked } 或抛出可读错误。 */
function generateArtifacts(options) {
  if (isNothingSelected(options?.only)) {
    throw new Error('一个插件都没勾 —— 生成这样的脚本没有任何意义。要么勾几个，要么别传 only（= 全部）。')
  }
  // options.only（包名数组）在**生成产物这一层**就筛掉未勾选的插件 ——
  // 于是 plan.json 与 apply.cmd 天然只包含勾中的部分，离线脚本不需要
  // 再理解一次选择语义（同一判断两份实现必然漂，allowBuilds 那条路吃过这个亏）。
  const plan = filterPlan(safePlan(options), options?.only)
  // 不传 process.execPath：面板跑在桌面端（Electron）里，那里 execPath 是
  // DeepSeek Harness.exe —— 拿它执行 apply.mjs 只会把桌面端再启一遍。
  // resolveNodeExe() 会去找 PATH 上的真 node，找不到就返回 null，
  // 由生成的 .cmd 在运行期自己找并明确报错。
  const out = writePlanArtifacts(plan, {
    nodeExe: resolveNodeExe(),
    applyScript: APPLY_SCRIPT,
    reportText: renderPlanText(plan),
  })
  return { plan, ...out }
}

// ─────────────────────────── 工具 ───────────────────────────

function buildProfileSyncTool(ctx) {
  return {
    name: 'profile_sync',
    description:
      '在 dsh 的多个 profile（例如网页版 web 与桌面版 desktop）之间迁移插件。' +
      '可用 only 指定只迁移哪几个插件（包名数组；不传 = 全部，也就是原来的一键全迁）；' +
      'action=plan 只算差异（不改任何东西）并列出可勾选的插件名单；action=apply 真正应用差异（目标就是当前 profile 时走应用内官方管理器，' +
      '当场生效、失败自动回滚）；action=write 生成计划文件和一份可离线执行的 apply.cmd；' +
      'action=status 核对上一次迁移是否真的落地；action=profiles 列出本机所有 profile。' +
      '注意：应用内管理器只能写它自己所属的 profile；要改别的 profile 得用 action=write 生成脚本，' +
      '而且 desktop 那个 profile 禁止用 dsh CLI 修改（bin.js 按名字硬拦）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['plan', 'apply', 'write', 'status', 'profiles'],
          description:
            'plan=算差异；apply=应用差异（目标为当前 profile 时走应用内官方管理器）；write=生成计划文件和离线脚本；' +
            'status=核对上次迁移；profiles=列出本机所有 profile',
        },
        source: { type: 'string', description: '源 profile 名（默认 web，即网页版）' },
        target: { type: 'string', description: '目标 profile 名（默认当前 profile）' },
        prune: { type: 'boolean', description: 'true 时连「只在目标端有」的依赖也删掉（默认 false，只报告）' },
        only: {
          type: 'array',
          items: { type: 'string' },
          description:
            '只迁移这些插件（包名，例如 ["dsh-wechat","dsh-novel"]）。不传 = 全部。' +
            '每个名字会连同它的 bundle 启用项与 allowBuilds 授权一起搬；' +
            '名字不在可勾选名单里时会被忽略。先用 action=plan 看名单。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = String(args?.action ?? 'plan')
      try {
        if (action === 'profiles') {
          const rows = listProfiles()
          if (rows.length === 0) return { text: `没有找到任何 profile（${profilesRoot()}）。` }
          const body = rows
            .map((r) => `  ${r.current ? '*' : ' '} ${r.name}${r.port ? `（端口 ${r.port}）` : ''} —— ${r.plugins} 个社区插件`)
            .join('\n')
          return { text: `本机 profile（${profilesRoot()}，* 为当前）：\n${body}` }
        }

        if (action === 'apply') {
          if (isNothingSelected(args?.only)) {
            return { text: '一个插件都没勾 —— 没有可应用的改动。要么勾几个，要么别传 only（= 全部）。' }
          }
          const plan = filterPlan(safePlan(args), args?.only)
          if (!plan.ok) {
            return {
              text:
                `拒绝应用：有 ${plan.blockers.length} 个阻断项。\n\n` +
                plan.blockers.map((b) => `  · [${b.code}] ${b.message}`).join('\n') +
                `\n\n完整报告用 action=plan 看。`,
            }
          }
          if (plan.add.length + plan.change.length === 0 && !(plan.prune && plan.extraInTarget.length > 0)) {
            return { text: `目标 ${plan.target.name} 已经和源 ${plan.source.name} 一致，没有要改的。` }
          }
          if (!canApplyInApp(plan.target.name)) {
            return {
              text:
                `目标 ${plan.target.name} 不是当前这个 profile —— 应用内管理器只写它自己所属的 profile，改不了别人。\n` +
                `请用 action=write 生成脚本，在目标端执行；注意 desktop 那个 profile 不能用 dsh CLI 改，` +
                `只能由跑在桌面端里的这一行去 apply。`,
            }
          }
          const manager = resolvePluginManager(ctx)
          if (manager === undefined) {
            return {
              text:
                '拿不到官方插件管理器（pluginManager 服务）——**不能**退回 dsh CLI，那条路对桌面端是被禁止的。\n' +
                '可以改用桌面端「设置 → 插件」页面，或 action=write 生成脚本。',
            }
          }
          const result = await applyManaged(plan, {
            manager,
            prune: args?.prune === true,
            log: (line) => console.log(`[dsh-profile-sync] ${line}`),
          })
          if (!result.ok) {
            return {
              text:
                `✗ 官方管理器拒绝了 ${result.failedSpec}：${result.error}\n` +
                `（它自己会回滚这一次改动，profile 不会留下半成品。）`,
            }
          }
          const lines = [`✓ 已通过应用内官方管理器应用（${result.results.length} 项）：`]
          for (const r of result.results) lines.push(`  · ${r.spec} → ${r.application}`)
          for (const r of result.removals) lines.push(`  · 移除 ${r.name} → ${r.ok ? 'ok' : r.error}`)
          if (result.results.some((r) => r.application === 'restart-required')) {
            lines.push('')
            lines.push('注意：有项返回 restart-required —— 要重启桌面端才会真正加载。')
          }
          return { text: lines.join('\n') }
        }

        if (action === 'status') {
          const result = verifyPending()
          if (result.state === 'none') return { text: '没有待核对的迁移记录。' }
          const who = result.pending.target?.name
          if (result.state === 'match') {
            return { text: `✓ 上一次迁移已落地（目标 ${who}，应用时间 ${result.pending.appliedAt}）。` }
          }
          if (result.state === 'manifest-only') {
            return {
              text:
                `△ 目标 ${who} 的 manifest 写对了，但那次 apply 用了 --no-install，包并没有真的装。\n` +
                `  要装上：dsh plugin --profile ${who} install`,
            }
          }
          const lines = [`✗ 上一次迁移没完全落地（目标 ${who}）：`]
          for (const d of result.missingDeps) lines.push(`  · 缺依赖 ${d.name}@${d.spec}`)
          for (const d of result.driftedDeps) lines.push(`  · 版本不符 ${d.name}：计划 ${d.want}，实际 ${d.got}`)
          for (const b of result.missingBundles) lines.push(`  · 缺 bundle ${b}（装了但没进加载层）`)
          return { text: lines.join('\n') }
        }

        if (action === 'write') {
          const out = generateArtifacts(args)
          if (out.cmdFile === null) {
            return {
              text:
                `计划有 ${out.plan.blockers.length} 个阻断项，**没有生成执行脚本**（只写了 plan.json 供查看）。\n\n` +
                renderPlanText(out.plan) +
                `\n\n产物目录：${out.dir}`,
            }
          }
          return {
            text:
              `已生成迁移产物：\n` +
              `  计划：${out.planFile}\n` +
              `  报告：${out.reportFile}\n` +
              `  脚本：${out.cmdFile}\n\n` +
              renderPlanText(out.plan) +
              `\n\n下一步：把 DeepSeek Harness 完全退出，然后双击 apply.cmd（或跑 node "${APPLY_SCRIPT}" --plan "${out.planFile}"）。`,
          }
        }

        if (action !== 'plan') {
          return { text: `不认识的 action：${action}（只支持 plan / write / status / profiles）` }
        }
        const full = safePlan(args)
        const plan = filterPlan(full, args?.only)
        const list = selectablePlugins(full)
        const head =
          list.length === 0
            ? ''
            : `可勾选的插件 ${list.length} 个` +
              (plan.selection?.all === false ? `（这次只迁其中 ${plan.selection.only.length} 个）` : '') +
              '：\n' +
              list.map((r) => `  · ${r.name} —— ${r.actions.join(' + ')}`).join('\n') +
              '\n（用 only:["名字", …] 只迁移其中几个；不传 only = 全部。）\n\n'
        return { text: head + renderPlanText(plan) }
      } catch (err) {
        return { text: `profile_sync 失败：${String((err && err.message) || err)}` }
      }
    },
  }
}

// ─────────────────────────── 浏览器 API ───────────────────────────

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1024 * 1024) raw = raw.slice(0, 1024 * 1024)
    })
    req.on('end', () => {
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function query(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function get(route, fn) {
  return {
    kind: 'exact',
    path: route,
    async handler(req, res) {
      // 方法要校验：这些处理器里有会**写文件**的（/write 会生成计划产物），
      // 不校验的话一次 GET 抓取就会真的动手（我自己就这么误触发过一次）。
      // req.method 缺失时放行，是为了让本地测试可以直接喂假 req 调用。
      if (req?.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, message: `这条路径只接受 GET（收到 ${req.method}）` })
        return
      }
      try {
        sendJson(res, 200, { ok: true, ...(await fn(query(req))) })
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String((err && err.message) || err) })
      }
    },
  }
}

function post(route, fn) {
  return {
    kind: 'exact',
    path: route,
    async handler(req, res) {
      if (req?.method !== undefined && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, message: `这条路径只接受 POST（收到 ${req.method}）` })
        return
      }
      try {
        const body = await readBody(req)
        sendJson(res, 200, { ok: true, ...(await fn(body || {})) })
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String((err && err.message) || err) })
      }
    },
  }
}

export const API_ROUTES = [
  get('/profile-sync/api/profiles', () => ({
    profiles: listProfiles(),
    current: currentProfileName(),
    profilesRoot: profilesRoot(),
  })),

  get('/profile-sync/api/plan', (params) => {
    const plan = safePlan({
      source: params.get('source') || undefined,
      target: params.get('target') || undefined,
      prune: params.get('prune') === '1',
    })
    // selectable 来自**未筛选**的完整计划 —— 面板要靠它渲染勾选行。
    return { plan, selectable: selectablePlugins(plan), text: renderPlanText(plan) }
  }),

  get('/profile-sync/api/status', () => {
    const verify = verifyPending()
    const pending = verify.state === 'none' ? null : readPending()
    return { verify, pending }
  }),

  post('/profile-sync/api/write', (body) => {
    const out = generateArtifacts({
      source: body.source,
      target: body.target,
      prune: body.prune === true,
      only: body.only,
    })
    return {
      dir: out.dir,
      planFile: out.planFile,
      reportFile: out.reportFile,
      cmdFile: out.cmdFile,
      blocked: out.blocked,
      blockers: out.plan.blockers,
      text: renderPlanText(out.plan),
      summary: {
        add: out.plan.add.length,
        change: out.plan.change.length,
        repin: out.plan.repin.length,
        bundlesAdd: out.plan.bundles.add.length,
        warnings: out.plan.warnings.length,
        blockers: out.plan.blockers.length,
      },
    }
  }),
]

/**
 * 真正应用差异的那条路由（走官方进程内管理器）。
 * 单独一个工厂是因为它需要 ctx 去取 `pluginManager` 服务，
 * 而模块级的 API_ROUTES 是在 import 时构造的、拿不到宿主上下文。
 */
export function makeApplyRoute(ctx) {
  return post('/profile-sync/api/apply', async (body) => {
    if (isNothingSelected(body?.only)) {
      return {
        ok: false,
        reason: 'empty-selection',
        text: '一个插件都没勾 —— 没有可应用的改动。要么勾几个，要么别传 only（= 全部）。',
      }
    }
    const plan = filterPlan(safePlan(body), body?.only)
    if (!plan.ok) {
      return { ok: false, blocked: true, blockers: plan.blockers, text: '有阻断项，拒绝应用' }
    }
    if (!canApplyInApp(plan.target.name)) {
      return {
        ok: false,
        reason: 'not-app-owned',
        text:
          `目标 ${plan.target.name} 不是当前这个 profile —— 应用内管理器只写它自己所属的 profile。` +
          `请用 /write 生成脚本（desktop 那个 profile 不能用 dsh CLI 改，只能从跑在桌面端里的会话 apply）。`,
      }
    }
    const manager = resolvePluginManager(ctx)
    if (manager === undefined) {
      return {
        ok: false,
        reason: 'no-manager',
        text: '拿不到官方插件管理器（pluginManager）——不能退回 dsh CLI，那条路对桌面端是被禁止的。',
      }
    }
    const result = await applyManaged(plan, {
      manager,
      prune: body?.prune === true,
      log: (line) => console.log(`[dsh-profile-sync] ${line}`),
    })
    const summary = planSummaryOf(plan)

    if (!result.ok) {
      return {
        ...result,
        summary,
        text:
          `✗ 官方管理器拒绝了 ${result.failedSpec}：${result.error}\n` +
          '（这一次的改动它会自己回滚，profile 不会留下半成品。）' +
          (result.allowBuildsReverted === true
            ? '\npnpm-workspace.yaml 里的 allowBuilds 也已退回原样（那部分不归它管，是我们自己写的）。'
            : ''),
      }
    }

    // 无可改动时也要给人一句话 —— 早先这里返回 ok:true 但 text 是空的，
    // 面板上就是一片空白，看不出到底做了什么。
    const installed = result.results.length
    const removed = (result.removals ?? []).length
    const allowAdded = result.allowBuildsAdded ?? []
    if (installed === 0 && removed === 0 && allowAdded.length === 0) {
      return {
        ...result,
        summary,
        text: `目标 ${plan.target.name} 已经和源 ${plan.source.name} 一致，没有要改的。`,
      }
    }
    const lines = [`✓ 已通过应用内官方管理器应用（${installed} 项）：`]
    for (const r of result.results) lines.push(`  · ${r.spec} → ${r.application}`)
    for (const r of result.removals ?? []) lines.push(`  · 移除 ${r.name} → ${r.ok ? 'ok' : r.error}`)
    if (allowAdded.length > 0) {
      lines.push(`  · allowBuilds 补 ${allowAdded.length} 项（值沿用源侧）：${allowAdded.join('、')}`)
    }
    if ((result.allowBuildsSkipped ?? []).length > 0) {
      lines.push(
        `  ! allowBuilds 有 ${result.allowBuildsSkipped.length} 项被跳过：` +
          '目标 profile 没有 pnpm-workspace.yaml（不凭空造一个残废文件）。'
      )
    }
    if (result.results.some((r) => r.application === 'restart-required')) {
      lines.push('', '注意：有项返回 restart-required —— 要重启桌面端才会真正加载。')
    }
    return { ...result, summary, text: lines.join('\n') }
  })
}

function planSummaryOf(plan) {
  return {
    add: plan.add.length,
    change: plan.change.length,
    bundleAdd: plan.bundles.add.length,
    extraInTarget: plan.extraInTarget.length,
    allowBuildsAdd: (plan.allowBuilds?.add ?? []).length,
  }
}

/**
 * 挂路由；返回注册条数（便于自检）。同路径重复注册会让整张表失效，所以这里自防一手。
 * @param webServer 宿主 web 服务
 * @param ctx 宿主上下文（用于取 pluginManager；不传则只挂只读路由）
 */
export function registerApi(webServer, ctx) {
  if (!webServer || typeof webServer.register !== 'function') return 0
  const routes = [...API_ROUTES]
  if (ctx !== undefined && ctx !== null) routes.push(makeApplyRoute(ctx))
  const seen = new Set()
  let n = 0
  for (const route of routes) {
    const key = `${route.kind} ${route.path}`
    if (seen.has(key)) throw new Error(`[dsh-profile-sync] 路由重复：${key}`)
    seen.add(key)
    webServer.register(route)
    n += 1
  }
  return n
}

// ─────────────────────────── 插件声明 ───────────────────────────

export const name = 'dsh-profile-sync'
export const inject = ['tools']

export { buildProfileSyncTool, generateArtifacts, listProfiles }

export function apply(ctx) {
  // 先定下「我是谁」：apply 的默认目标、以及「能不能当场生效」都依赖它。
  // 这一步必须在任何请求之前完成，否则当前 profile 会一直算不清。
  {
    const who = resolveHostProfile(ctx)
    const via = who === null ? '没找到任何可靠来源（profileContext / DSH_PROFILE / DSH_PROFILE_DIR 都没有）' : `来源已确认`
    if (who === null) {
      console.warn(`[dsh-profile-sync] ⚠ 无法确定当前 profile：${via}`)
      console.warn('[dsh-profile-sync]   影响：apply 的默认目标与「当场生效」判定都会要求你显式指定 target。')
    } else {
      console.log(`[dsh-profile-sync] 当前 profile 判定为「${who}」（${via}）`)
    }
  }

  // 开机核对：上一次迁移到底落地了没有。
  // 这才是「重启验证」那一步 —— 官方 install 退出码 0 只说明 pnpm 装完了，
  // 说明不了新 bundle 真的进了加载层（可能没声明 dsh.bundle、可能被上层 patch 覆盖、
  // 也可能装完又被兼容性拒绝回滚）。
  try {
    const verify = verifyPending()
    const who = verify.pending?.target?.name
    if (verify.state === 'none') {
      console.log('[dsh-profile-sync] 没有待核对的迁移记录')
    } else if (verify.state === 'match') {
      console.log(`[dsh-profile-sync] ✓ 上一次迁移已落地（目标 ${who}）`)
    } else if (verify.state === 'manifest-only') {
      console.warn(
        `[dsh-profile-sync] △ 目标 ${who} 的 manifest 写对了，但那次 apply 用了 --no-install —— 包并没有真的装。` +
          ` 跑 dsh plugin --profile ${who} install`
      )
    } else {
      console.warn(
        `[dsh-profile-sync] ✗ 上一次迁移没完全落地（${verify.state}）：` +
          `缺依赖 ${verify.missingDeps.length}、版本不符 ${verify.driftedDeps.length}、缺 bundle ${verify.missingBundles.length}` +
          ` —— 跑 node bin/apply.mjs --status 看详情，或 --rollback 退回`
      )
    }
  } catch (err) {
    console.warn(`[dsh-profile-sync] 核对上一次迁移时出错：${String((err && err.message) || err)}`)
  }

  const tools = typeof ctx.reflect?.get === 'function' ? ctx.reflect.get('tools', false) : undefined
  if (tools === undefined || tools === null) {
    console.log('[dsh-profile-sync] tools 服务不可用，跳过工具注册')
  } else {
    tools.register(buildProfileSyncTool(ctx))
    console.log('[dsh-profile-sync] 已注册工具：profile_sync（plan / apply / write / status / profiles）')
  }

  // 官方插件管理器在不在？在的话 apply 能当场生效；不在就只能生成脚本。
  // 这里只报告事实，不做回退猜测。
  const manager = resolvePluginManager(ctx)
  if (manager === undefined) {
    console.warn('[dsh-profile-sync] 拿不到 pluginManager 服务 —— apply 将不可用（桌面端禁止用 dsh CLI，不会回退）')
  } else {
    console.log('[dsh-profile-sync] ✓ 官方插件管理器可用，apply 可当场生效')
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      const webServer =
        (typeof httpCtx.get === 'function' ? httpCtx.get('webServer') : undefined) ??
        (httpCtx.reflect ? httpCtx.reflect.get('webServer', false) : undefined)
      if (!webServer) {
        console.log('[dsh-profile-sync] webServer 不可用，面板接口未注册')
        return
      }
      try {
        const n = registerApi(webServer, httpCtx)
        console.log(`[dsh-profile-sync] 已注册面板接口 ${n} 条：/profile-sync/api/{profiles,plan,status,write,apply}`)
      } catch (err) {
        console.warn(`[dsh-profile-sync] 注册面板接口失败：${String((err && err.message) || err)}`)
      }
    })
  }
}
