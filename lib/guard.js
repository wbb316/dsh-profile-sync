/**
 * dsh-profile-sync —— 进程守卫
 *
 * 「目标 profile 是不是还在运行」这件事必须查两路，因为桌面端和 CLI profile
 * 的进程长相**完全不同**：
 *
 *   ① 桌面端：命令行里只有 `"D:\dsh\dsh-desktop\DeepSeek Harness.exe"` 和
 *      `--expose-internals ...dsh-desktop-host\lib\index.js`，**没有** `--profile desktop`。
 *      所以只能按进程名认 —— 只查 `--profile` 会漏掉它。
 *   ② CLI 起的 profile：命令行里有 `--profile <name>`，按命令行认。
 *
 * 为什么这道守卫是必要的（官方其实不管这一段）：
 * `dsh plugin --profile desktop` 的 requireDesktopProfile() 只检查 profile 是否初始化过，
 * 那句「先完全退出桌面端」只在 profile 不存在时才打印。也就是说官方通道在桌面端运行时
 * **会照跑**，然后 pnpm 去重写 node_modules —— 在 Windows 上撞上已加载的原生 addon
 * 就是 EPERM（Node 没有 dlclose，装过的 .node 到进程退出前都拿不回来），
 * 而且正在运行的 loader 早就挂好旧的模块图了。
 */

import process from 'node:process'
import { execFileSync } from 'node:child_process'

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param {string} profileName 目标 profile 名
 * @returns {{hits: string[], checked: boolean, errors: string[]}}
 *   hits 非空 = 目标端在跑；checked=false 表示两路检查都没跑起来（无法确认）
 */
export function detectRunning(profileName) {
  const hits = []
  const errors = []
  let checked = false

  if (process.platform === 'win32') {
    // ① 桌面端：按进程名
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      })
      checked = true
      if (/DeepSeek Harness\.exe/i.test(out)) hits.push('桌面端进程 DeepSeek Harness.exe 还在运行')
    } catch (err) {
      errors.push(`tasklist 检查失败：${String(err?.message ?? err)}`)
    }

    // ② 命令行里带 --profile <name> 的进程（CLI 起的 profile）
    try {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine'],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }
      )
      checked = true
      const re = new RegExp(`--profile(?:=|\\s+)["']?${escapeRe(profileName)}\\b`)
      for (const line of String(out).split(/\r?\n/)) {
        const text = line.trim()
        if (text === '') continue
        // 别把自己算进去：守卫自己也是 node 在跑
        if (/apply\.mjs|plan-cli\.mjs|bootstrap\.mjs/.test(text)) continue
        if (re.test(text)) hits.push(`有进程带着 --profile ${profileName} 在跑：${text.slice(0, 120)}`)
      }
    } catch (err) {
      errors.push(`命令行扫描失败：${String(err?.message ?? err)}`)
    }
  } else {
    try {
      const out = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 15000 })
      checked = true
      const re = new RegExp(`--profile(?:=|\\s+)["']?${escapeRe(profileName)}\\b`)
      for (const line of String(out).split('\n')) {
        const text = line.trim()
        if (text === '') continue
        if (/apply\.mjs|plan-cli\.mjs|bootstrap\.mjs/.test(text)) continue
        if (re.test(text)) hits.push(`有进程带着 --profile ${profileName} 在跑：${text.slice(0, 120)}`)
      }
    } catch (err) {
      errors.push(`ps 检查失败：${String(err?.message ?? err)}`)
    }
  }

  return { hits, checked, errors }
}

/** 守卫的共用输出：返回退出码（0 可继续，2 拦下）。 */
export function guardOrReport(profileName, { yes = false, log = console.log, error = console.error } = {}) {
  const guard = detectRunning(profileName)
  for (const e of guard.errors) error(`警告：${e}`)
  if (guard.hits.length > 0) {
    if (yes) {
      for (const hit of guard.hits) error(`注意：${hit}（--yes，继续）`)
      return 0
    }
    error('✗ 目标端看起来还在运行，拒绝安装：')
    for (const hit of guard.hits) error('  · ' + hit)
    error('')
    error('  请把 DeepSeek Harness 完全退出（托盘也退掉）再重新运行。确实要继续就加 --yes。')
    return 2
  }
  if (!guard.checked) {
    error('✗ 无法确认目标端是否在运行（两路检查都没跑起来）。')
    error('  确认已退出后可加 --yes 继续。')
    return yes ? 0 : 2
  }
  log(`✓ 已确认 ${profileName} 没有在运行`)
  return 0
}
