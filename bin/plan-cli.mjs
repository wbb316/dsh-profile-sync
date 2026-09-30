#!/usr/bin/env node
/**
 * dsh-profile-sync —— 计划 CLI（独立可用，不需要 DSH 在跑）
 *
 *   node bin/plan-cli.mjs                    # 默认 plan：web → desktop，打印计划
 *   node bin/plan-cli.mjs plan --source web --target desktop --write
 *   node bin/plan-cli.mjs plan --json        # 机器可读
 *   node bin/plan-cli.mjs status             # 核对上一次 apply 是否真的落地
 *
 * 退出码：0 = 计划无阻断；3 = 有阻断项（不会写执行脚本）；1 = 用法/运行时错误
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { computePlan, renderPlanText } from '../lib/plan.js'
import { verifyPending, writePlanArtifacts } from '../lib/artifacts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const applyScript = path.join(here, 'apply.mjs')

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
    if (key === 'json' || key === 'write' || key === 'prune' || key === 'help') {
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
      '  node bin/plan-cli.mjs plan [--source web] [--target desktop] [--prune] [--write] [--json]',
      '  node bin/plan-cli.mjs status [--json]',
      '',
      '  --source <profile>  源 profile（默认 web，即网页版）',
      '  --target <profile>  目标 profile（默认 desktop，即桌面端；也接受绝对目录）',
      '  --prune             把「只在目标端有」的依赖也删掉（默认保留，只报告）',
      '  --write             落成产物：plans/<时间>/plan.json + plan.txt + apply.cmd',
      '  --json              输出 JSON',
      '  --out <dir>         --write 的输出目录（默认 ~/.dsh/profile-sync/plans/<时间>）',
    ].join('\n')
  )
}

async function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const command = args._[0] ?? 'plan'
  const asJson = args.json === true

  if (args.help === true) {
    usage()
    return 0
  }

  if (command === 'status') {
    const result = verifyPending()
    if (asJson) {
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    if (result.state === 'none') {
      console.log('没有待核对的迁移记录（~/.dsh/profile-sync/pending.json 不存在）。')
      return 0
    }
    console.log(`目标：${result.pending.target?.name}（${result.pending.target?.dir}）`)
    console.log(`应用到：${result.pending.appliedAt}`)
    if (result.state === 'match') {
      console.log('✓ 已落地：依赖与 bundle 都跟计划一致。')
      return 0
    }
    if (result.state === 'manifest-only') {
      console.log('△ manifest 写对了，但这次 apply 用了 --no-install，包并没有真的装。')
      console.log('  要装上：dsh plugin --profile ' + result.pending.target?.name + ' install')
      return 3
    }
    console.log('✗ 与计划不一致：')
    for (const d of result.missingDeps) console.log(`  · 缺依赖 ${d.name}@${d.spec}`)
    for (const d of result.driftedDeps) console.log(`  · 依赖版本不符 ${d.name}：计划 ${d.want}，实际 ${d.got}`)
    for (const b of result.missingBundles) console.log(`  · 缺 bundle ${b}（装了但没进加载层）`)
    if (result.extraBundles.length > 0) console.log(`  · 多出 bundle ${result.extraBundles.join('、')}`)
    return 3
  }

  if (command !== 'plan') {
    console.error(`不认识的子命令：${command}`)
    usage()
    return 1
  }

  const plan = computePlan({
    source: typeof args.source === 'string' ? args.source : 'web',
    target: typeof args.target === 'string' ? args.target : 'desktop',
    prune: args.prune === true,
  })

  if (asJson && args.write !== true) {
    console.log(JSON.stringify(plan, null, 2))
  } else {
    console.log(renderPlanText(plan))
  }

  if (args.write === true) {
    const text = renderPlanText(plan)
    // 不显式传 nodeExe：让 writePlanArtifacts 自己解析一个「真 node」。
    // （在 Electron 里 process.execPath 是应用 exe，绝不能拿去执行 apply.mjs）
    const out = writePlanArtifacts(plan, {
      applyScript,
      reportText: text,
      dir: typeof args.out === 'string' ? args.out : undefined,
    })
    console.log('')
    console.log('产物目录：' + out.dir)
    console.log('  plan.json   ' + out.planFile)
    console.log('  plan.txt    ' + out.reportFile)
    if (out.cmdFile !== null) {
      console.log('  apply.cmd   ' + out.cmdFile)
      if (out.nodeExe === null) {
        console.log('  （规划时没找到 node，脚本会在运行期自己找一次；找不到会明确报错而不是启动桌面端）')
      }
      console.log('')
      console.log('下一步：完全退出 DeepSeek Harness，然后双击 apply.cmd（或跑 node bin/apply.mjs --plan "' + out.planFile + '"）。')
    } else {
      console.log('  （有阻断项，未生成 apply.cmd —— 先解决上面列出的阻断项）')
    }
  }

  return plan.ok ? 0 : 3
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(String(err?.stack ?? err))
    process.exit(1)
  })
