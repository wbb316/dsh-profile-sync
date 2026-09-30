/**
 * dsh-profile-sync —— 执行层
 *
 * 把一份计划**原子地**落到目标 profile 上，失败可完整回滚。
 *
 * 这里有一个刻意的设计决定：**不在命令行上传任何 spec**。
 *
 * 原本最自然的写法是 `dsh plugin --profile desktop add dsh-x@^0.11.3`。
 * 但在这台机器上这条路是坏的：Windows 上 dsh 是 .cmd，spawn 必须走 shell，
 * 而 cmd.exe 把 `^` 当转义字符 —— `dsh-x@^0.11.3` 传到 pnpm 手里就成了 `dsh-x@0.11.3`，
 * 静默把范围号变成精确号（正好悄悄改掉桌面端故意钉的版本）。
 *
 * 所以改成两步，各用各的强项：
 *   1. 本模块自己原子地改 package.json 的 dependencies + bundles（可单测、无转义问题）
 *   2. 再调官方的 `dsh plugin --profile <p> install` 做真正的安装
 *      —— 官方那步会做兼容性校验，不通过时自动还原 package.json + lockfile + node_modules，
 *         并在成功后 reconcile 出新 bundle 的加载层。这些我们**不重写**，只复用。
 */

import fs from 'node:fs'
import path from 'node:path'

import { INBOX_BUNDLES, isProfileName, mergeAllowBuildsText, profilesRoot } from './plan.js'
import { backupsDir, ensureDir, readPending, stamp, writeJsonAtomic, writePending } from './artifacts.js'

/** 纳入快照的 profile 文件。lockfile 也收 —— 回滚要回得干净。 */
export const SNAPSHOT_FILES = Object.freeze([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'cordis.patch.yml',
  'compatibility.json',
])

/** 原子写文件（同目录临时文件 + rename），失败不会留下半个 JSON。 */
export function writeFileAtomicSync(file, text) {
  ensureDir(path.dirname(file))
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, file)
}

/** 一份 manifest 里的社区依赖（滤掉 in-box）。注意是从**对象**取，不是从磁盘读。 */
function communityDepsOf(manifest) {
  const deps = manifest?.dependencies
  if (deps === null || typeof deps !== 'object') return {}
  const out = {}
  for (const [name, spec] of Object.entries(deps)) {
    if (!INBOX_BUNDLES.includes(name)) out[name] = spec
  }
  return out
}

const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

/**
 * 计划文件是**从磁盘读回来的**（用户可能手改过、也可能是旧版本写的），
 * 所以执行前必须验一遍形状。这里不修不猜，直接拒 ——
 * 猜错的代价是往 package.json 里写进垃圾，而那会让 profile 起不来。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePlanForApply(plan) {
  const errors = []
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, errors: ['计划不是一个对象'] }
  }
  if (plan.target === null || typeof plan.target !== 'object') errors.push('缺少 target')

  for (const key of ['add', 'change', 'repin', 'same', 'extraInTarget']) {
    if (plan[key] !== undefined && !Array.isArray(plan[key])) errors.push(`${key} 必须是数组`)
  }
  for (const key of ['bundles', 'allowBuilds']) {
    const value = plan[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${key} 必须是对象`)
      continue
    }
    if (value.add !== undefined && !Array.isArray(value.add)) errors.push(`${key}.add 必须是数组`)
  }

  const checkEntries = (list, key) => {
    // 先确认它真是数组：上面那条「必须是数组」只是记了个错误，
    // 这里要是继续对它 .entries() 就会自己崩掉（而校验函数崩了，等于没校验）
    if (!Array.isArray(list)) return
    for (const [i, entry] of list.entries()) {
      if (entry === null || typeof entry !== 'object') {
        errors.push(`${key}[${i}] 不是对象`)
        continue
      }
      if (typeof entry.name !== 'string' || !PACKAGE_NAME_RE.test(entry.name)) {
        errors.push(`${key}[${i}].name 不是合法包名：${JSON.stringify(entry.name)}`)
      }
      if (typeof entry.spec !== 'string' || entry.spec.trim() === '') {
        errors.push(`${key}[${i}].spec 必须是非空字符串`)
      } else if (/[\r\n\t]/.test(entry.spec)) {
        errors.push(`${key}[${i}].spec 含控制字符，拒绝写进 package.json：${JSON.stringify(entry.spec)}`)
      }
    }
  }
  checkEntries(plan.add, 'add')
  checkEntries(plan.change, 'change')

  const bundleAdd = Array.isArray(plan.bundles?.add) ? plan.bundles.add : []
  for (const [i, name] of bundleAdd.entries()) {
    if (typeof name !== 'string' || !PACKAGE_NAME_RE.test(name)) {
      errors.push(`bundles.add[${i}] 不是合法包名：${JSON.stringify(name)}`)
    }
  }
  const allowAdd = Array.isArray(plan.allowBuilds?.add) ? plan.allowBuilds.add : []
  for (const [i, name] of allowAdd.entries()) {
    // allowBuilds 的键允许 `包名@git+https://…` 这种形态，所以只挡控制字符
    if (typeof name !== 'string' || name.trim() === '' || /[\r\n]/.test(name)) {
      errors.push(`allowBuilds.add[${i}] 非法：${JSON.stringify(name)}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 按计划算出目标 profile 新的 package.json。
 *
 * bundles 的处理有个要点：**只有真的声明了 dsh.bundle.patch 的包才写进 bundles**。
 * 没声明的包由官方 install 当普通依赖装上（并打印同样的警告），
 * 硬写进 bundles 会造出一个加载不了的层。
 */
export function buildUpdatedManifest(manifest, plan, options = {}) {
  const prune = options.prune === true
  const next = JSON.parse(JSON.stringify(manifest))
  if (next.dependencies === undefined || next.dependencies === null || typeof next.dependencies !== 'object') {
    next.dependencies = {}
  }

  for (const entry of plan.add ?? []) next.dependencies[entry.name] = entry.spec
  for (const entry of plan.change ?? []) next.dependencies[entry.name] = entry.spec

  const hadBundles = Array.isArray(next.dsh?.profile?.bundles)
  const bundles = hadBundles ? [...next.dsh.profile.bundles].filter((n) => typeof n === 'string') : []
  const warnings = []

  for (const name of plan.bundles?.add ?? []) {
    const entry = [...(plan.add ?? []), ...(plan.change ?? [])].find((e) => e.name === name)
    if (entry !== undefined && entry.declaresBundle === false) {
      warnings.push(`${name} 没有声明 dsh.bundle.patch，只作为普通依赖安装，不写进 bundles。`)
      continue
    }
    if (!bundles.includes(name)) bundles.push(name)
  }

  if (prune) {
    for (const entry of plan.extraInTarget ?? []) delete next.dependencies[entry.name]
    for (const name of plan.bundles?.extraInTarget ?? []) {
      const i = bundles.indexOf(name)
      if (i >= 0) bundles.splice(i, 1)
    }
  }

  if (hadBundles || bundles.length > 0) {
    next.dsh = { ...(next.dsh ?? {}) }
    next.dsh.profile = { ...(next.dsh?.profile ?? {}), bundles }
  }
  return { manifest: next, warnings }
}

/** 两次 manifest 的差异（用来告诉人「到底写了什么」）。 */
export function diffManifest(before, after) {
  const rows = []
  const bd = before?.dependencies ?? {}
  const ad = after?.dependencies ?? {}
  for (const name of new Set([...Object.keys(bd), ...Object.keys(ad)])) {
    if (bd[name] === ad[name]) continue
    rows.push({ kind: 'dependency', name, from: bd[name] ?? null, to: ad[name] ?? null })
  }
  const bb = before?.dsh?.profile?.bundles ?? []
  const ab = after?.dsh?.profile?.bundles ?? []
  for (const name of new Set([...bb, ...ab])) {
    if (bb.includes(name) && ab.includes(name)) continue
    rows.push({ kind: 'bundle', name, from: bb.includes(name) ? 'on' : null, to: ab.includes(name) ? 'on' : null })
  }
  return rows
}

// ─────────────────────────── 快照 / 回滚 ───────────────────────────

/**
 * 把 profile 的关键文件复制到 backups/<label>/，并记下**哪些文件原本不存在**
 * （回滚时要把这些删掉，而不是留着我们创建的空文件）。
 */
export function snapshotProfile(targetDir, options = {}) {
  // 时间戳只到秒，同一秒内跑两次会撞目录 → 加一小段随机后缀
  const label = options.label ?? `${stamp()}-${Math.random().toString(36).slice(2, 6)}`
  const dir = options.dir ?? path.join(backupsDir(), label)
  ensureDir(dir)

  const present = []
  const absent = []
  for (const name of SNAPSHOT_FILES) {
    const src = path.join(targetDir, name)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, name))
      present.push(name)
    } else {
      absent.push(name)
    }
  }

  const meta = {
    version: 1,
    createdAt: new Date().toISOString(),
    targetDir,
    present,
    absent,
    planFile: options.planFile ?? null,
  }
  writeJsonAtomic(path.join(dir, 'meta.json'), meta)
  return { dir, meta }
}

/** 回滚：把快照里的文件复制回去，并删掉当时不存在的那些。 */
export function restoreSnapshot(backupDir, targetDir) {
  const metaFile = path.join(backupDir, 'meta.json')
  let meta = null
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  } catch {
    return { ok: false, restored: [], removed: [], reason: `快照不完整（读不到 ${metaFile}）` }
  }

  const restored = []
  const removed = []
  for (const name of meta.present ?? []) {
    const src = path.join(backupDir, name)
    if (!fs.existsSync(src)) continue
    fs.copyFileSync(src, path.join(targetDir, name))
    restored.push(name)
  }
  for (const name of meta.absent ?? []) {
    const file = path.join(targetDir, name)
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      removed.push(name)
    }
  }
  return { ok: true, restored, removed, meta }
}

export function latestBackupDir() {
  const root = backupsDir()
  let names = []
  try {
    names = fs.readdirSync(root).sort()
  } catch {
    return null
  }
  return names.length === 0 ? null : path.join(root, names[names.length - 1])
}

// ─────────────────────────── 应用计划 ───────────────────────────

/**
 * 把计划应用到目标 profile。
 *
 * @param {object} options
 * @param {object} options.plan         computePlan 的结果
 * @param {string} [options.planFile]   计划文件路径（写进快照 meta 和 pending 日志）
 * @param {boolean} [options.prune]     是否删掉「只在目标端」的依赖（默认 false）
 * @param {boolean} [options.dryRun]    只算不写
 * @param {(args: string[], ctx: object) => Promise<number>} options.runner
 *        跑官方 install 的函数，返回退出码 —— 注入是为了可测
 * @param {(line: string) => void} [options.log]
 */
export async function applyPlan(options) {
  const {
    plan,
    planFile = null,
    dryRun = false,
    runner,
    log = () => {},
  } = options
  const prune = options.prune === true || plan.prune === true

  if (!plan || typeof plan !== 'object') throw new Error('缺少计划对象')

  const validation = validatePlanForApply(plan)
  if (!validation.ok) {
    throw new Error(
      `计划文件不合法（可能被手工改过，或不是本工具生成的）：\n  · ${validation.errors.join('\n  · ')}`
    )
  }

  if (!plan.ok) {
    const n = Array.isArray(plan.blockers) ? plan.blockers.length : '?'
    throw new Error(`计划有 ${n} 个阻断项，拒绝执行。先看 plan.txt 的阻断列表。`)
  }
  if (!isProfileName(plan.target?.name)) {
    throw new Error(`目标 profile 名不合法：${JSON.stringify(plan.target?.name)}`)
  }
  const expectedDir = path.join(profilesRoot(), plan.target.name)
  if (path.resolve(plan.target.dir) !== path.resolve(expectedDir)) {
    throw new Error(
      `目标 profile 目录不等于 profiles/${plan.target.name}（${plan.target.dir}）。` +
        `dsh plugin --profile 只能按 profile 名解析目录，显式目录必须手工安装。`
    )
  }

  const targetDir = plan.target.dir
  const manifestFile = path.join(targetDir, 'package.json')
  let before
  try {
    before = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (err) {
    throw new Error(`读不到目标 profile 的 package.json：${String(err?.message ?? err)}`)
  }

  const { manifest: after, warnings: manifestWarnings } = buildUpdatedManifest(before, plan, { prune })
  const changes = diffManifest(before, after)

  const workspaceFile = path.join(targetDir, 'pnpm-workspace.yaml')
  const workspaceExists = fs.existsSync(workspaceFile)
  const workspaceBefore = workspaceExists ? fs.readFileSync(workspaceFile, 'utf8') : ''
  const allow = mergeAllowBuildsText(workspaceBefore, plan.allowBuilds?.add ?? [])

  const workspaceWarnings = []
  if (allow.added.length > 0 && !workspaceExists) {
    workspaceWarnings.push(
      '目标 profile 没有 pnpm-workspace.yaml，已跳过 allowBuilds。' +
        '不敢新建：一个只含 allowBuilds 的文件会丢掉 nodeLinker: hoisted 这类必要设置，' +
        '反而会把安装搞坏（pnpm 默认是 isolated）。'
    )
  }
  const willWriteWorkspace = allow.added.length > 0 && workspaceExists

  // 期望值从「即将写入的那份 manifest」抽出来 —— 单一事实来源。
  // 不在这里照 plan 再推导一遍：推导逻辑有第二份就会漂，
  // 而 --prune 那条路上的漂法是自己骗自己（删了依赖却还期望它在）。
  const expect = {
    dependencies: communityDepsOf(after),
    bundles: Array.isArray(after.dsh?.profile?.bundles) ? [...after.dsh.profile.bundles] : [],
  }

  const summary = {
    targetDir,
    changes,
    manifestWarnings,
    workspaceWarnings,
    allowBuildsAdded: willWriteWorkspace ? allow.added : [],
    allowBuildsSkipped: willWriteWorkspace ? [] : allow.added,
    pending: readPending(),
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      applied: false,
      summary,
      manifestBefore: before,
      manifestAfter: after,
      workspaceAfter: willWriteWorkspace ? allow.text : workspaceBefore,
    }
  }

  // 1) 快照（先快照再写，任何一步炸了都能退回去）
  const snapshot = snapshotProfile(targetDir, { planFile })
  log(`快照：${snapshot.dir}`)

  // 2) allowBuilds 必须先合并 —— 否则 pnpm 会静默跳过原生构建脚本，
  //    包看来装好了，原生依赖（node-pty 的 conpty.dll 之类）却没铺出来
  if (willWriteWorkspace) {
    writeFileAtomicSync(workspaceFile, allow.text)
    log(`allowBuilds 补入 ${allow.added.length} 项：${allow.added.join('、')}`)
  } else {
    for (const w of workspaceWarnings) log(`注意：${w}`)
  }

  // 3) pending 日志先写：万一进程被杀，重启后仍然知道「本来期望什么」。
  //    installed 如实记录有没有真的跑安装 —— 用了 --no-install 就不能
  //    在核对时拍胸脯说「已落地」。
  const pending = writePending({
    plan,
    planFile,
    backupDir: snapshot.dir,
    expect,
    installed: typeof runner === 'function',
  })

  // 4) 原子写 manifest
  writeFileAtomicSync(manifestFile, JSON.stringify(after, null, 2) + '\n')
  log(`已写入 package.json（${changes.length} 处改动）`)
  for (const row of changes) {
    if (row.kind === 'dependency') log(`  · 依赖 ${row.name}：${row.from ?? '(新增)'} → ${row.to ?? '(删除)'}`)
    else log(`  · bundle ${row.name}：${row.from ?? '(新增)'} → ${row.to ?? '(删除)'}`)
  }

  // 5) 交给官方做真正的安装（兼容性校验 + 自动回滚 + reconcile 激活 bundle）
  let exitCode = 0
  if (typeof runner === 'function') {
    log('调用官方安装通道：dsh plugin --profile ' + plan.target.name + ' install')
    exitCode = await runner(['plugin', '--profile', plan.target.name, 'install'], {
      cwd: targetDir,
      targetDir,
      profile: plan.target.name,
    })
  } else {
    log('没有注入 runner，只写了 manifest（--no-install）')
  }

  if (exitCode !== 0) {
    // 官方通道在兼容性拒绝时已经自己还原过 package.json + lockfile + node_modules；
    // 我们这一步是把它没管到的（allowBuilds / cordis.patch.yml / 我们自己写的那份 manifest）也退回去
    const restored = restoreSnapshot(snapshot.dir, targetDir)
    log(`安装失败（退出码 ${exitCode}），已回滚：`)
    log(`  还原 ${restored.restored.join('、') || '(无)'}`)
    if (restored.removed.length > 0) log(`  删除 ${restored.removed.join('、')}`)
    log(`建议：在目标 profile 里跑一次 dsh plugin --profile ${plan.target.name} install --frozen-lockfile 让 node_modules 回到快照状态。`)
    return { ok: false, applied: true, exitCode, restored, snapshot: snapshot.dir, summary }
  }

  return { ok: true, applied: true, exitCode, snapshot: snapshot.dir, pending, summary }
}
