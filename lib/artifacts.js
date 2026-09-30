/**
 * dsh-profile-sync —— 产物与日志层
 *
 * 负责「磁盘上的东西」：
 *   · 状态目录 ~/.dsh/profile-sync/（plans/ backups/ pending.json）
 *   · 写迁移产物：plan.json（可复核的计划）+ apply.cmd（双击执行的脚本）
 *   · pending 日志：apply 之前写下去，**重启后**用它核对计划到底落地了没有
 *
 * 为什么要有 pending 日志（而不是 apply 完就算成功）：
 * 官方 `dsh plugin install` 退出码为 0，只能说明 pnpm 装完了；
 * 不能说明新 bundle 真的被 profile 加载了（可能被上层 patch 覆盖、
 * 可能 dsh.bundle 没声明、也可能装完又被兼容性拒绝回滚）。
 * 唯一可信的确认是「下次启动后读 manifest 和 bundles 对一遍」。
 * 这个模块就是那个对账器。
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  readBundles,
  readCommunityDependencies,
  syncHome,
  profilesRoot,
} from './plan.js'

export { syncHome }

export function plansDir() {
  return path.join(syncHome(), 'plans')
}

export function backupsDir() {
  return path.join(syncHome(), 'backups')
}

export function pendingFile() {
  return path.join(syncHome(), 'pending.json')
}

/** 文件系统安全的时间戳：2026-09-30T21-30-36 */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function findOnPath(names, env) {
  const dirs = String(env?.PATH ?? '')
    .split(path.delimiter)
    .filter((d) => d !== '')
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* 试下一个 */
      }
    }
  }
  return null
}

/**
 * 找**真正是 node** 的那个可执行文件。
 *
 * 为什么不能用 `process.execPath`：
 * 面板是在桌面端（Electron）里跑的，那里 `process.execPath` 是
 * `DeepSeek Harness.exe` —— 拿它去执行 apply.mjs，结果是**把桌面端再启一遍**，
 * 而不是应用计划。这个构建里 `ELECTRON_RUN_AS_NODE=1` 也是失效的
 * （实测：无输出、无退出码，说明 RunAsNode 这个 fuse 在打包时被关掉了），
 * 所以只能老老实实去找 PATH 上的 node。
 *
 * @param {{isElectron?: boolean, env?: object, execPath?: string}} [overrides]
 *        仅用于测试注入；生产调用不传。
 * @returns {string|null} node 的绝对路径；找不到返回 null（此时生成的 .cmd
 *   会在运行期自己再找一次，找不到就明确报错，而不是去启桌面端）
 */
export function resolveNodeExe(overrides = {}) {
  const env = overrides.env ?? process.env
  const execPath = overrides.execPath ?? process.execPath
  const isElectron = overrides.isElectron ?? process.versions.electron !== undefined

  const override = env.DSH_PROFILE_SYNC_NODE
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  // 不在 Electron 里：我们本身就是 node，用它最准（就是当前跑着的这个）
  if (!isElectron) return execPath
  // 在 Electron 里：绝不能返回应用 exe
  const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node']
  const found = findOnPath(names, env)
  if (found === null) return null
  // 万一 PATH 上指的又是个 Electron 系的东西，宁可返回 null 让 .cmd 运行期再判
  return /electron/i.test(path.basename(found)) ? null : found
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(temp, file)
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, file)
}

export function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

// ─────────────────────────── pending 日志 ───────────────────────────

/**
 * 记下「这次 apply 期望目标 profile 变成什么样」。
 *
 * 期望值**由调用方从「即将写入的那份 manifest」里抽出来**，而不是在这里
 * 重新推导一遍。理由：推导逻辑一旦有两份，早晚会漂 —— 这正是
 * `--prune` 那个 bug 的成因（apply 层按 prune 删了依赖，这里却按旧
 * manifest 记期望，于是重启后核对必然报「缺依赖」，是自己骗自己）。
 *
 * @param {object} options
 * @param {{dependencies: Record<string,string>, bundles: string[]}} options.expect
 * @param {boolean} [options.installed] 是否真的跑了官方安装（`--no-install` 时为 false）
 */
export function writePending(options) {
  const { plan, planFile, backupDir, expect, installed = true, appliedAt = new Date().toISOString() } = options
  if (expect === undefined || typeof expect !== 'object' || expect.dependencies === undefined) {
    throw new Error('writePending 需要显式的 expect.dependencies（不要再在这里推导一遍期望值）')
  }

  const payload = {
    version: 2,
    appliedAt,
    planFile,
    backupDir,
    source: plan.source,
    target: plan.target,
    prune: plan.prune === true,
    installed: installed !== false,
    expect: {
      dependencies: { ...expect.dependencies },
      bundles: Array.isArray(expect.bundles) ? [...expect.bundles] : [],
    },
    installedSpecs: [...(plan.add ?? []), ...(plan.change ?? [])].map((e) => `${e.name}@${e.spec}`),
  }
  writeJsonAtomic(pendingFile(), payload)
  return payload
}

export function readPending() {
  return readJson(pendingFile())
}

export function clearPending() {
  try {
    fs.rmSync(pendingFile(), { force: true })
  } catch {
    /* 删不掉就算了，下次 apply 会覆盖 */
  }
}

/**
 * 核对上一次 apply 是否真的落地了。
 * 这是「重启后验证」那一步的实现，纯读文件、无副作用。
 *
 * 三种不通过要分清楚，因为它们指向完全不同的补救：
 *   · missing  —— 期望的依赖整个不在，像是被上层还原了
 *   · drifted  —— 在，但版本/名单对不上
 *   · manifest-only —— manifest 写对了，但这次 apply 用了 `--no-install`，
 *                      包根本没装。此时说「已落地」是骗人的
 *
 * @returns {{state: 'none'|'match'|'missing'|'drifted'|'manifest-only', ...}}
 */
export function verifyPending() {
  const pending = readPending()
  if (pending === null) return { state: 'none' }

  const dir = pending.target?.dir
  if (typeof dir !== 'string' || dir === '') {
    return { state: 'drifted', reason: 'pending 日志里没有目标目录', pending }
  }

  const actualDeps = readCommunityDependencies(dir)
  const actualBundles = readBundles(dir)
  const wantDeps = pending.expect?.dependencies ?? {}
  const wantBundles = pending.expect?.bundles ?? []
  const installSkipped = pending.installed === false

  const missingDeps = []
  const driftedDeps = []
  for (const [name, spec] of Object.entries(wantDeps)) {
    if (!(name in actualDeps)) missingDeps.push({ name, spec })
    else if (actualDeps[name] !== spec) {
      driftedDeps.push({ name, want: spec, got: actualDeps[name] })
    }
  }
  const missingBundles = wantBundles.filter((n) => !actualBundles.includes(n))
  const extraBundles = actualBundles.filter((n) => !wantBundles.includes(n))

  const bad = missingDeps.length + driftedDeps.length + missingBundles.length
  let state
  if (bad > 0) {
    const wantCount = Object.keys(wantDeps).length
    state = wantCount > 0 && missingDeps.length === wantCount ? 'missing' : 'drifted'
  } else if (installSkipped) {
    state = 'manifest-only'
  } else {
    state = 'match'
  }

  return {
    state,
    pending,
    installSkipped,
    missingDeps,
    driftedDeps,
    missingBundles,
    extraBundles,
    ok: state === 'match',
  }
}

// ─────────────────────────── 迁移产物 ───────────────────────────

/** .cmd 里安全地引一个路径（双引号内不做任何转义处理，最省心）。 */
function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/**
 * 生成「双击就能跑」的 apply.cmd。
 *
 * 脚本本身不做任何判断 —— 所有判断（桌面端是否在跑、快照、回滚、
 * 调官方 install）都在 bin/apply.mjs 里，因为 Node 里能写测试，批处理里不能。
 * 这里只负责两件事：把人送进去，以及**用真正的 node** 把人送进去。
 *
 * 关于 node 的解析：规划时如果能确定一个真 node（`resolveNodeExe()`），就把它烘进脚本；
 * 烘不进去（在 Electron 里且 PATH 上没有 node）就让脚本运行期自己 `where node` 找一次，
 * 找不到就明确报错退出。**任何情况下都不会去执行桌面端 exe** ——
 * 那只会把桌面端再启一遍，而计划一个字都不会被应用。
 */
export function buildApplyCmd({ planFile, applyScript, nodeExe }) {
  const baked = typeof nodeExe === 'string' && nodeExe.trim() !== '' ? nodeExe.trim() : ''
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'title dsh-profile-sync',
    'echo.',
    'echo   dsh 插件迁移 —— 应用计划',
    'echo   ----------------------------------------',
    `echo   计划：${planFile}`,
    'echo.',
    'echo   如果这里报「桌面端还在运行」，先把 DeepSeek Harness 完全退出再双击本文件。',
    'echo.',
  ]
  if (baked !== '') {
    lines.push(`set "DSH_NODE=${baked}"`)
  } else {
    lines.push('set "DSH_NODE="')
  }
  lines.push(
    'if not defined DSH_NODE for /f "delims=" %%i in (\'where node 2^>nul\') do if not defined DSH_NODE set "DSH_NODE=%%i"',
    'if not defined DSH_NODE (',
    '  echo [X] 找不到 node.exe。请装 Node.js（并把 node 加到 PATH）后重试。',
    '  echo     本脚本不会用桌面端 exe 去执行 —— 那只会把桌面端再启一遍。',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    `"%DSH_NODE%" ${cmdQuote(applyScript)} --plan ${cmdQuote(planFile)}`,
    'set EXITCODE=%ERRORLEVEL%',
    'echo.',
    'if not "%EXITCODE%"=="0" echo   退出码 %EXITCODE% —— 上面有写明原因和回滚情况。',
    'if "%EXITCODE%"=="0" echo   完成。现在重新打开 DeepSeek Harness，插件会自动核对这次迁移。',
    'echo.',
    'pause',
    ''
  )
  return lines.join('\r\n')
}

/**
 * 把一次计划落成产物：plans/<stamp>/plan.json + apply.cmd。
 * 有阻断项时**拒绝**生成脚本（只写 plan.json 供人看），除非 force。
 */
export function writePlanArtifacts(plan, options = {}) {
  const { applyScript, force = false, dir } = options
  // 没显式给 nodeExe 就自己解析一个「真 node」；解析不到就传空，
  // 由 .cmd 在运行期自己找（绝不能退回成 Electron 的应用 exe）
  const nodeExe = options.nodeExe === undefined ? resolveNodeExe() : options.nodeExe
  const targetDir = dir ?? path.join(plansDir(), stamp())
  ensureDir(targetDir)

  const planFile = path.join(targetDir, 'plan.json')
  writeJsonAtomic(planFile, plan)

  const reportFile = path.join(targetDir, 'plan.txt')
  writeTextAtomic(reportFile, options.reportText ?? '')

  let cmdFile = null
  if (plan.ok || force) {
    cmdFile = path.join(targetDir, 'apply.cmd')
    writeTextAtomic(cmdFile, buildApplyCmd({ planFile, applyScript, nodeExe }))
  }

  return { dir: targetDir, planFile, reportFile, cmdFile, blocked: !plan.ok, nodeExe }
}

export { profilesRoot }
