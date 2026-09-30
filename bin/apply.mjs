#!/usr/bin/env node
/**
 * dsh-profile-sync —— 执行 CLI（**必须在目标端完全退出之后跑**）
 *
 *   node bin/apply.mjs --plan <plan.json>               # 应用计划（先查目标端是否还在运行）
 *   node bin/apply.mjs --plan <plan.json> --dry-run     # 只算不写，看看会改什么
 *   node bin/apply.mjs --plan <plan.json> --no-install  # 只写 manifest，不跑官方安装
 *   node bin/apply.mjs --rollback                       # 退回最近一次快照
 *   node bin/apply.mjs --status                         # 核对上一次 apply 是否落地
 *   node bin/apply.mjs --guard-only --profile desktop    # 只做「是否在运行」检查
 *
 * 退出码：0 = 成功；1 = 用法/运行时错误；2 = 目标端还在运行（或被守卫拦下）；
 *         3 = 核对不通过；4 = 官方安装通道失败（已自动回滚）；其他 = 官方通道的退出码
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

import { readPending, verifyPending } from '../lib/artifacts.js'
import { applyPlan, latestBackupDir, restoreSnapshot } from '../lib/apply.js'
import { detectRunning } from '../lib/guard.js'
import { resolveProfileRef } from '../lib/plan.js'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      args._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (['dry-run', 'no-install', 'yes', 'prune', 'rollback', 'status', 'guard-only', 'json', 'help'].includes(key)) {
      args[key] = true
      continue
    }
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    i += 1
  }
  return args
}

function usage() {
  console.log(
    [
      '用法:',
      '  node bin/apply.mjs --plan <plan.json> [--dry-run] [--no-install] [--prune] [--yes]',
      '  node bin/apply.mjs --rollback',
      '  node bin/apply.mjs --status [--json]',
      '',
      '  --plan <file>   要应用的 plan.json（由 plan-cli.mjs --write 生成）',
      '  --dry-run       只算出会改什么，不落盘',
      '  --no-install    只写 manifest 和 allowBuilds，不调用官方安装',
      '  --prune         同时删掉「只在目标端」的依赖',
      '  --yes           即使检测到目标端可能在运行也继续（危险，自行承担）',
      '  --dsh <path>    指定 dsh 可执行文件（默认走 PATH 上的 dsh）',
    ].join('\n')
  )
}

/** 真跑官方安装通道。返回退出码。 */
function makeRunner(dshExe) {
  return async (args, ctx) => {
    const cmdline = [dshExe, ...args].join(' ')
    const res = spawnSync(cmdline, {
      shell: true,
      stdio: 'inherit',
      cwd: ctx?.cwd ?? process.cwd(),
      windowsHide: false,
    })
    if (res.error) {
      console.error(`dsh: 起不来（${String(res.error.message)}）`)
      return 127
    }
    return res.status ?? 1
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    usage()
    return 0
  }

  // ── status：核对上一次 apply
  if (args.status === true) {
    const result = verifyPending()
    if (args.json === true) {
      console.log(JSON.stringify(result, null, 2))
      return result.ok || result.state === 'none' ? 0 : 3
    }
    if (result.state === 'none') {
      console.log('没有待核对的迁移记录。')
      return 0
    }
    if (result.state === 'match') {
      console.log('✓ 上一次迁移已落地：依赖与 bundle 都和计划一致。')
      return 0
    }
    if (result.state === 'manifest-only') {
      console.log('△ manifest 写对了，但那次 apply 用了 --no-install，包并没有真的装。')
      console.log(`  要装上：dsh plugin --profile ${result.pending.target?.name} install`)
      return 3
    }
    console.log('✗ 上一次迁移没完全落地：')
    for (const d of result.missingDeps) console.log(`  · 缺依赖 ${d.name}@${d.spec}`)
    for (const d of result.driftedDeps) console.log(`  · 版本不符 ${d.name}：计划 ${d.want}，实际 ${d.got}`)
    for (const b of result.missingBundles) console.log(`  · 缺 bundle ${b}`)
    return 3
  }

  // ── rollback：退回最近一次快照
  if (args.rollback === true) {
    const backup = typeof args.backup === 'string' ? args.backup : latestBackupDir()
    if (backup === null) {
      console.error('没有可用的快照（~/.dsh/profile-sync/backups/ 是空的）。')
      return 1
    }
    let meta = null
    try {
      meta = JSON.parse(fs.readFileSync(path.join(backup, 'meta.json'), 'utf8'))
    } catch {
      console.error(`快照不完整：${backup}`)
      return 1
    }
    if (typeof meta.targetDir === 'string') {
      const profileName = path.basename(meta.targetDir)
      const guard = detectRunning(profileName)
      if (guard.hits.length > 0 && args.yes !== true) {
        console.error('目标端还在运行，先完全退出再回滚：')
        for (const h of guard.hits) console.error('  · ' + h)
        return 2
      }
    }
    const result = restoreSnapshot(backup, meta.targetDir)
    if (!result.ok) {
      console.error(result.reason)
      return 1
    }
    console.log(`已回滚 ${backup}`)
    console.log(`  还原 ${result.restored.join('、') || '(无)'}`)
    if (result.removed.length > 0) console.log(`  删除 ${result.removed.join('、')}`)
    console.log(`接下来：dsh plugin --profile ${path.basename(meta.targetDir)} install --frozen-lockfile 让 node_modules 对上。`)
    return 0
  }

  // ── guard-only：只查进程
  if (args['guard-only'] === true) {
    const name = typeof args.profile === 'string' ? args.profile : 'desktop'
    const guard = detectRunning(name)
    console.log(JSON.stringify(guard, null, 2))
    return guard.hits.length === 0 ? 0 : 2
  }

  // ── apply：应用计划
  if (typeof args.plan !== 'string') {
    console.error('必须给 --plan <plan.json>（或用 --status / --rollback / --guard-only）')
    usage()
    return 1
  }
  const planFile = path.resolve(args.plan)
  let plan
  try {
    plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  } catch (err) {
    console.error(`读不到计划文件 ${planFile}：${String(err?.message ?? err)}`)
    return 1
  }
  if (plan.target === undefined) {
    console.error('计划文件里没有 target 字段，不是本工具生成的计划。')
    return 1
  }

  // 计划里的目标目录可能是过期的，重新解析一次，确保打的是当前这台机器的位置
  const targetRef = resolveProfileRef(plan.target.dir ?? plan.target.name)

  // 桌面端 profile **禁止**用 CLI 写 —— dsh 按名字硬拦一切 CLI 调用
  // （bin.js 的 rejectElectronProfile）。在这里就拦住，免得用户拿到一条
  // 看起来像别的原因的失败。
  if (String(targetRef.name).toLowerCase() === 'desktop') {
    console.error('✗ 桌面端 profile 不能用 CLI 修改：dsh 按名字硬拦它')
    console.error('    error: profile "desktop" is managed exclusively by the Electron application')
    console.error('')
    console.error('  桌面端唯一的写入器是应用内的官方插件管理器。请改用：')
    console.error('    · 桌面端左侧栏「插件迁移」面板里的「应用」，或')
    console.error('    · 让我调 profile_sync action=apply（当场生效，失败自动回滚），或')
    console.error('    · 桌面端「设置 → 插件」页面')
    console.error('')
    console.error('  这条脚本通道只适用于 web / headless 这类 CLI 拥有的 profile。')
    return 2
  }

  console.log(`应用计划：${plan.source?.name ?? '?'} → ${targetRef.name}`)
  console.log(`目标目录：${targetRef.dir}`)
  console.log('')

  const guard = detectRunning(targetRef.name)
  for (const e of guard.errors) console.error(`警告：${e}`)
  if (guard.hits.length > 0) {
    if (args.yes !== true) {
      console.error('✗ 目标端看起来还在运行，拒绝安装：')
      for (const h of guard.hits) console.error('  · ' + h)
      console.error('')
      console.error('  请把 DeepSeek Harness 完全退出（托盘也退掉）再重新运行本命令。')
      console.error('  确实要继续的话加 --yes。')
      return 2
    }
    for (const h of guard.hits) console.error(`注意：${h}（--yes，继续）`)
  } else if (!guard.checked && args.yes !== true) {
    console.error('✗ 无法确认目标端是否在运行（两路检查都没跑起来）。')
    console.error('  确认已退出后可加 --yes 继续。')
    return 2
  } else {
    console.log(`✓ 已确认 ${targetRef.name} 没有在运行`)
  }
  console.log('')

  const dryRun = args['dry-run'] === true
  const runner =
    args['no-install'] === true ? undefined : makeRunner(typeof args.dsh === 'string' ? args.dsh : 'dsh')

  const result = await applyPlan({
    plan: { ...plan, ok: plan.ok !== false, target: { ...plan.target, dir: targetRef.dir, name: targetRef.name } },
    planFile,
    dryRun,
    prune: args.prune === true,
    runner,
    log: (line) => console.log(line),
  })

  if (dryRun) {
    console.log('')
    console.log('（--dry-run，没有落盘）会改这些：')
    for (const row of result.summary.changes) {
      console.log(`  · ${row.kind} ${row.name}：${row.from ?? '(新增)'} → ${row.to ?? '(删除)'}`)
    }
    if (result.summary.allowBuildsAdded.length > 0) {
      console.log(`  · allowBuilds 补 ${result.summary.allowBuildsAdded.join('、')}`)
    }
    for (const w of result.summary.manifestWarnings) console.log(`  ! ${w}`)
    for (const w of result.summary.workspaceWarnings ?? []) console.log(`  ! ${w}`)
    if (result.summary.changes.length === 0 && result.summary.allowBuildsAdded.length === 0) {
      console.log('  （没有需要改动的地方 —— 目标 profile 已经和计划一致）')
    }
    return 0
  }

  console.log('')
  if (result.ok) {
    console.log('✓ 已完成。')
    console.log('  接下来：重新打开 DeepSeek Harness。启动后它自己会核对这次迁移；')
    console.log(`  也可以随时跑 node bin/apply.mjs --status 看核对结果。`)
    if (readPending() !== null) console.log('  （待核对记录已写下：~/.dsh/profile-sync/pending.json）')
    return 0
  }
  console.log(`✗ 官方安装通道返回 ${result.exitCode}，已回滚到快照 ${result.snapshot}`)
  return 4
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(String(err?.stack ?? err))
    process.exit(1)
  })
