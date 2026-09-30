#!/usr/bin/env node
/**
 * dsh-profile-sync —— 装前自检 CLI
 *
 *   node bin/check.mjs [--dir <插件目录>]
 *
 * 查「清单不变式」+「真的 import 得起来」两件事。
 * 之所以要单独一个命令：这个包一旦被写进 dsh.profile.bundles 却加载不了，
 * profile 组装就会失败，桌面端**连窗口都打不开** —— 而那时候你已经在应用外面了。
 * 所以装之前先把这件事验掉。
 *
 * 退出码：0 = 可以装；1 = 有问题，**不要装**。
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { selfCheck } from '../lib/manifest-check.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const dir = typeof args.dir === 'string' ? path.resolve(args.dir) : path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const result = await selfCheck(dir)

console.log(`装前自检：${dir}`)
if (result.facts.name !== undefined) {
  console.log(`  包名    ：${result.facts.name}${result.facts.version ? `@${result.facts.version}` : ''}`)
}
if (result.facts.engines !== undefined) console.log(`  引擎要求：dsh.engines.dsh = ${result.facts.engines}`)
if (result.facts.insertRows !== undefined) {
  const rows = result.facts.insertRows.map((r) => `${r.id}${r.name ? ` → ${r.name}` : ''}`).join('、')
  console.log(`  patch 挂载：${rows || '(空)'}`)
}
if (result.facts.clientId !== undefined) console.log(`  客户端 id：${result.facts.clientId}`)
if (result.facts.hostExports != null) console.log(`  宿主导出：${result.facts.hostExports.join(', ')}`)
console.log('')

for (const w of result.warnings) console.log(`  ! ${w}`)
if (result.warnings.length > 0) console.log('')

if (result.ok) {
  console.log('✓ 通过：清单一致、宿主半和客户端半都真的加载得起来，可以安装。')
  process.exit(0)
}
console.log('✗ 不通过 —— **不要装**（声明了却加载不了的 bundle 会让桌面端打不开窗口）：')
for (const e of result.errors) console.log(`  · ${e}`)
process.exit(1)
