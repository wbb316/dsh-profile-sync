#!/usr/bin/env node
/**
 * dsh-profile-sync —— 自举安装（把本插件自己装进目标 profile）
 *
 *   node bin/bootstrap.mjs [--profile desktop] [--yes]
 *
 * 走的是**官方通道**：`dsh plugin --profile <p> add "link:<本插件目录>"`。
 * 为什么不自已改 package.json：
 *  · 官方 add 会在装完后 reconcile，把新 bundle 自动注册进 dsh.profile.bundles
 *  · 官方 add 会做兼容性校验，不通过时自动还原 package.json + lockfile + node_modules
 * 这两件事都有人写好了、还被真实 bug 打磨过，没有理由重写一遍。
 *
 * 这里传出去的 spec 是 `link:D:/.../dsh-profile-sync`（正斜杠）—— 没有 `^`，
 * 所以不会撞上 Windows cmd 把 `^` 当转义那个坑（那正是 apply 层宁可自己写
 * manifest 也不用 `add name@^x.y.z` 的原因）。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { detectRunning } from '../lib/guard.js'
import { isProfileName, profilesRoot } from '../lib/plan.js'
import { selfCheck } from '../lib/manifest-check.js'
import { installViaEndpoint, profilePort } from '../lib/managed.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (key === 'yes' || key === 'help') {
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

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  console.log('用法: node bin/bootstrap.mjs [--profile desktop] [--yes] [--dsh <path>]')
  process.exit(0)
}

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const profile = typeof args.profile === 'string' ? args.profile : 'desktop'

if (!isProfileName(profile)) {
  console.error(`非法的 profile 名：${JSON.stringify(profile)}`)
  process.exit(1)
}

// 确认这个 profile 真的存在（存在才能让官方通道接管）
const profileDir = path.join(profilesRoot(), profile)
const exists = fs.existsSync(path.join(profileDir, 'package.json'))
if (!exists) {
  console.error(`找不到 profile：${profileDir}`)
  console.error('先把对应的应用（桌面端 / dsh --profile 名字）启动过一次，让 profile 初始化。')
  process.exit(1)
}

console.log(`安装 dsh-profile-sync → profile「${profile}」`)
console.log(`  插件目录：${pluginDir}`)
console.log(`  profile ：${profileDir}`)
console.log('')

// 装前自检：这一步挡的是最坏的失败模式 —— bundle 声明了却加载不起来，
// profile 组装就失败，桌面端连窗口都打不开，而那时你已经在应用外面了。
{
  const check = await selfCheck(pluginDir)
  for (const w of check.warnings) console.log(`  ! ${w}`)
  if (!check.ok) {
    console.error('✗ 装前自检不通过，已中止（**不要装**）：')
    for (const e of check.errors) console.error('  · ' + e)
    process.exit(1)
  }
  console.log(`✓ 装前自检通过（宿主半与客户端半都真的 import 得起来）`)
  console.log('')
}

// ── 桌面端（app 自有 profile）：唯一合法写入器是应用内的官方管理器 ──
//
// 注意这里的判断跟别的 profile **正好相反**：CLI 那条路要求应用退出，
// 而这条 HTTP 端点要求应用**开着**。因为 dsh 按名字硬拦 `--profile desktop`
// （`error: profile "desktop" is managed exclusively by the Electron application`），
// 应用内管理器是唯一能写它的东西。
if (profile.toLowerCase() === 'desktop') {
  const port = profilePort(profileDir)
  if (port === null) {
    console.error(`✗ 读不出 ${profileDir}\\cordis.patch.yml 里的端口，无法定位官方安装端点。`)
    process.exit(1)
  }
  const base = `http://127.0.0.1:${port}`
  let alive = false
  let detail = ''
  try {
    const res = await fetch(`${base}/api/plugin-manager/list`)
    alive = res.ok
    if (!res.ok) detail = `HTTP ${res.status}`
  } catch (err) {
    detail = String(err?.message ?? err)
  }
  if (!alive) {
    console.error(`✗ 官方安装端点在 ${base} 上没有响应${detail === '' ? '' : `（${detail}）`}。`)
    console.error('')
    console.error('  桌面端 profile 只能由应用内的官方管理器写，所以这一步**需要桌面端正开着**：')
    console.error('  打开 DeepSeek Harness，然后重新双击本文件。（不需要退出，退出反而用不了。）')
    process.exit(2)
  }
  console.log(`✓ 官方安装端点在 ${base} 上活着（桌面端唯一合法的写入器）`)
  console.log('')

  const spec = 'link:' + pluginDir.replace(/\\/g, '/')
  console.log(`提交给官方管理器：${spec}`)
  const result = await installViaEndpoint(spec, { port, name: 'dsh-profile-sync', log: (l) => console.log(l) })
  if (!result.ok) {
    console.error('')
    console.error(`✗ 没有装成功：${result.message ?? `HTTP ${result.status}`}`)
    console.error('  官方管理器会自己回滚它没保住的那次改动，profile 不会留下半成品。')
    process.exit(1)
  }
  console.log('')
  console.log('✓ 装好了。宿主半会通过 HMR 当场生效；左侧栏面板刷新页面就会出现。')
  process.exit(0)
}

// ── 其它 profile（CLI 拥有）：必须先退出，再走 dsh plugin ──
const guard = detectRunning(profile)
for (const e of guard.errors) console.error(`警告：${e}`)
if (guard.hits.length > 0) {
  if (args.yes !== true) {
    console.error('✗ 目标端还在运行，拒绝安装：')
    for (const hit of guard.hits) console.error('  · ' + hit)
    console.error('')
    console.error('  官方通道对 profile 是持锁的，而且运行中的 loader 已经挂好旧模块图。')
    console.error('  请把 DeepSeek Harness 完全退出（托盘也退掉）再重新运行。确实要继续就加 --yes。')
    process.exit(2)
  }
  for (const hit of guard.hits) console.error(`注意：${hit}（--yes，继续）`)
} else if (!guard.checked && args.yes !== true) {
  console.error('✗ 无法确认目标端是否在运行。确认已退出后可加 --yes 继续。')
  process.exit(2)
} else {
  console.log(`✓ 已确认 ${profile} 没有在运行`)
}
console.log('')

// pnpm / dsh 认正斜杠路径，也顺手避开 cmd 的反斜杠转义问题
const spec = 'link:' + pluginDir.replace(/\\/g, '/')
const dshExe = typeof args.dsh === 'string' ? args.dsh : 'dsh'
const cmdline = `${dshExe} plugin --profile ${profile} add "${spec}"`

console.log(`跑官方通道：${cmdline}`)
console.log('')
const res = spawnSync(cmdline, { shell: true, stdio: 'inherit', cwd: profileDir, windowsHide: false })

if (res.error) {
  console.error(`dsh 起不来：${String(res.error.message)}`)
  console.error('确认 dsh 在 PATH 上（npm i -g @deepseek-ai/dsh），或用 --dsh <路径> 指一个。')
  process.exit(127)
}
const code = res.status ?? 1
console.log('')
if (code === 0) {
  console.log('✓ 安装完成，bundle 已注册进 dsh.profile.bundles。')
  console.log('  重新打开 DeepSeek Harness，左侧栏会出现「插件迁移」。')
  process.exit(0)
}
console.error(`✗ 官方通道返回 ${code}。`)
console.error('  官方通道在兼容性拒绝时会自己回滚 package.json + lockfile + node_modules，')
console.error('  上面若提到 allow-version，那是它给的精确版本豁免入口（危险操作，自己权衡）。')
process.exit(code)
