#!/usr/bin/env node
/**
 * dsh-profile-sync —— 客户端启动验证器
 *
 * ## 它为什么存在
 *
 * 我的插件曾经把桌面端搞到**开不了窗口**，错误是客户端启动审计给的：
 *
 *     web boot: 1 entry did not activate
 *     dsh-profile-sync: pending (waiting for service: @deepseek-ai/dsh-client-ui-slots)
 *
 * 而我当时做的所有验证 —— 宿主半真 import、清单不变式、79 项测试 —— **一个都碰不到这条链路**。
 * 最刺眼的是：出错时宿主半明明装载成功（日志里有「已注册工具」「已注册面板接口 5 条」），
 * 只有客户端那一半是死的。盲区就在这里。
 *
 * 所以这个脚本做的事只有一件：**把那句 did not activate 变成可自动判定的**。
 *
 *   1. 建一个一次性 profile（默认 dshpsverify，**永远拒绝 desktop / web / headless**）
 *   2. 把目标插件 link 装进去
 *   3. 起服务，**加 --no-open**（不许弹用户的浏览器）
 *   4. 用无头 Edge/Chrome 的 `--dump-dom` 抓那个页面的真实文本
 *   5. 断言：不含 did not activate / Failed to load plugins，且含我面板的标签
 *   6. 无论成败，杀进程 + 删 profile + 删浏览器临时目录
 *
 * 判定用的就是用户当初在浏览器里看到的那段字 —— 同一条判据，只是自动化了。
 *
 * 用法：
 *   node bin/verify-client.mjs                      # 验本目录这个插件
 *   node bin/verify-client.mjs --plugin-dir <目录>   # 验别处的一份（阳性对照用）
 *   node bin/verify-client.mjs --port 3081 --keep    # 换端口 / 保留现场排查
 *
 * 退出码：0 = 通过；1 = 不通过；2 = 环境问题（端口占用 / 找不到浏览器等）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { profilesRoot } from '../lib/plan.js'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 绝不允许拿来当试验田的 profile 名 —— 这几个是用户真实在用的。 */
const FORBIDDEN_PROFILES = new Set(['desktop', 'web', 'headless', 'default', 'main', 'tui'])

// ─────────────────────────── 参数 ───────────────────────────

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (key === 'keep' || key === 'help') {
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
  console.log(
    [
      '用法: node bin/verify-client.mjs [选项]',
      '',
      '  --plugin-dir <目录>   要验证的插件目录（默认本插件目录）',
      '  --profile <名字>      一次性 profile 名（默认 dshpsverify；desktop/web/headless 一律拒绝）',
      '  --port <端口>         期望的 web 端口（默认 3080）',
      '  --browser <路径>      无头浏览器可执行文件（默认自动找 Edge/Chrome）',
      '  --dsh-bin <路径>      dsh 的 bin.js（默认从全局 npm root 推出来）',
      '  --expect <文本>       判定「面板真的挂上了」的期望文本（默认 插件迁移）',
      '  --timeout-sec <秒>    等页面渲染的上限（默认 25）',
      '  --keep                跑完保留 profile 与浏览器临时目录，便于排查',
    ].join('\n')
  )
  process.exit(0)
}

const pluginDir = path.resolve(typeof args['plugin-dir'] === 'string' ? args['plugin-dir'] : PLUGIN_DIR)
const profile = typeof args.profile === 'string' ? args.profile : 'dshpsverify'
const port = typeof args.port === 'string' ? Number(args.port) : 3080
const expectText = typeof args.expect === 'string' ? args.expect : '插件迁移'
const timeoutSec = typeof args['timeout-sec'] === 'string' ? Number(args['timeout-sec']) : 25
const keep = args.keep === true

// ─────────────────────────── 前置检查 ───────────────────────────

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

if (FORBIDDEN_PROFILES.has(profile.toLowerCase())) {
  fail(2, `拒绝：profile「${profile}」是你真实在用的，验证器只允许建一次性 profile。`)
}
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profile)) {
  fail(2, `profile 名不合法：${JSON.stringify(profile)}（只允许字母数字点横线）`)
}
if (!fs.existsSync(path.join(pluginDir, 'package.json'))) {
  fail(2, `插件目录里没有 package.json：${pluginDir}`)
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fail(2, `端口不合法：${args.port}`)
}

/** 找 dsh 的 bin.js：全局 npm root 下的 @deepseek-ai/dsh。 */
function resolveDshBin() {
  if (typeof args['dsh-bin'] === 'string') return path.resolve(args['dsh-bin'])
  const candidates = []
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true }).trim()
    if (root !== '') candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  } catch {
    /* 试下面的候选 */
  }
  // PATH 上的 dsh 通常在 <nodeDir>\dsh.cmd，bin.js 就在同级的 node_modules 下
  try {
    const where = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    for (const line of where.split(/\r?\n/)) {
      const dir = path.dirname(line.trim())
      if (dir !== '') candidates.push(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
  } catch {
    /* 交给下面的判定 */
  }
  for (const candidate of candidates) {
    if (candidate !== '' && fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 找无头浏览器。 */
function resolveBrowser() {
  if (typeof args.browser === 'string') return path.resolve(args.browser)
  const candidates =
    process.platform === 'win32'
      ? [
          // Chrome 排前面：实测 `--headless=new --dump-dom` 最稳
          path.join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  for (const candidate of candidates) {
    if (candidate !== '' && fs.existsSync(candidate)) return candidate
  }
  return null
}

const dshBin = resolveDshBin()
if (dshBin === null) {
  fail(2, '找不到 dsh 的 lib/bin.js。用 --dsh-bin <路径> 指一个，或确认 dsh 在 PATH / 全局 npm 上。')
}
const browser = resolveBrowser()
if (browser === null) {
  fail(2, '找不到无头浏览器（Edge / Chrome）。用 --browser <路径> 指一个。')
}

const profileDir = path.join(profilesRoot(), profile)

// ─────────────────────────── 小工具 ───────────────────────────

function run(argsList, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dshBin, ...argsList], {
      cwd: options.cwd ?? os.tmpdir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => {
      out += c
    })
    child.stderr.on('data', (c) => {
      err += c
    })
    child.on('close', (code) => resolve({ code, out, err }))
    child.on('error', (e) => resolve({ code: -1, out, err: String(e?.message ?? e) }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForHttp(url, deadlineMs) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status > 0) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(700)
  }
  return false
}

/**
 * 抓页面真实 DOM。
 *
 * 这里有两个**实测出来的坑**，别改回去：
 *
 * 1. **不要加 `--virtual-time-budget`。** 页面有一条 SSE 长连接（HMR 用的），
 *    虚拟时间永远等不到「网络空闲」，`--dump-dom` 就永远不返回 —— 实测 40 秒超时、
 *    输出 0 字节。去掉它，`--headless=new` 直接就能 dump 出 49 万字符的完整页面。
 *
 * 2. **超时不要用 throw 丢掉输出。** spawnSync 超时会抛 ETIMEDOUT，但
 *    `err.stdout` 里往往已经有内容了 —— 拿到非空就当成结果，比整轮失败有用得多。
 *
 * 配方按顺序试，取第一个拿到非空 DOM 的。
 */
function dumpDom(userDataDir) {
  const common = [
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    `--user-data-dir=${userDataDir}`,
    '--dump-dom',
    url,
  ]
  const recipes = [
    { label: '--headless=new', flags: ['--headless=new'] },
    { label: '--headless +--timeout', flags: ['--headless', `--timeout=${timeoutSec * 1000}`] },
  ]
  const notes = []
  for (const recipe of recipes) {
    let out = ''
    try {
      out = execFileSync(browser, [...recipe.flags, ...common], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: (timeoutSec + 20) * 1000,
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (err) {
      // 超时/被杀时，err.stdout 里可能已经有 DOM 了
      if (typeof err?.stdout === 'string' && err.stdout !== '') out = err.stdout
      notes.push(`${recipe.label} 未干净退出（${String(err?.code ?? err?.message ?? err)}）`)
    }
    if (typeof out === 'string' && out.length > 1000) {
      return { dom: out, recipe: recipe.label, notes }
    }
    notes.push(`${recipe.label} 只拿到 ${out.length} 字节`)
  }
  return { dom: '', recipe: null, notes }
}

// ─────────────────────────── 主流程 ───────────────────────────

let server = null
let userDataDir = null
let url = null

const cleanup = () => {
  if (server !== null && server.exitCode === null && server.signalCode === null) {
    try {
      server.kill('SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
  if (!keep) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶尔被占 */
    }
    if (userDataDir !== null) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        /* 同上 */
      }
    }
  }
}

let exitCode = 1
try {
  console.log(`验证目标：${pluginDir}`)
  console.log(`一次性 profile：${profileDir}`)
  console.log(`dsh：${dshBin}`)
  console.log(`浏览器：${browser}`)
  console.log(`端口：${port}`)
  console.log('')

  // 1) 建一个干净的一次性 profile（从 web 模板）
  if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true })
  const init = await run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  if (init.code !== 0 || !fs.existsSync(path.join(profileDir, 'package.json'))) {
    fail(2, `初始化一次性 profile 失败（退出码 ${init.code}）：\n${init.err || init.out}`)
  }
  console.log('✓ 一次性 profile 已建好')

  // 2) link 安装目标插件
  const spec = 'link:' + pluginDir.replace(/\\/g, '/')
  const added = await run(['plugin', '--profile', profile, 'add', spec])
  if (added.code !== 0) {
    fail(2, `安装失败（退出码 ${added.code}）：\n${added.err || added.out}`)
  }
  console.log(`✓ 已装入：${spec}`)

  // 3) 起服务（--no-open：绝不许弹用户的浏览器）
  server = spawn(process.execPath, [dshBin, '--profile', profile, '--no-open'], {
    cwd: os.tmpdir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverOut = ''
  let serverErr = ''
  server.stdout.on('data', (c) => {
    serverOut += c
  })
  server.stderr.on('data', (c) => {
    serverErr += c
  })

  const base = `http://127.0.0.1:${port}`
  const up = await waitForHttp(`${base}/`, 40000)
  if (!up) {
    console.error('启用日志：')
    console.error(serverOut)
    console.error(serverErr)
    fail(2, `服务在 ${base} 上没起来（可能端口被占）`)
  }
  // 启动横幅是**异步**打印的：端口先能连上，带 token 的那一行可能还没出现。
  // 早先这里只匹配一次，拿不到就退回不带 token 的 URL —— 而那种页面只回 222 字节，
  // 于是正负两个对照都被误报成「浏览器 dump 不到」。等它出现再往下走。
  const tokenRe = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/
  let tokenMatch = tokenRe.exec(serverOut)
  const tokenDeadline = Date.now() + 20000
  while (tokenMatch === null && Date.now() < tokenDeadline) {
    await sleep(500)
    tokenMatch = tokenRe.exec(serverOut)
  }
  if (tokenMatch === null) {
    console.error('启用日志：')
    console.error(serverOut)
    console.error(serverErr)
    fail(2, '服务起来了，但没等到带 token 的 URL —— 不带 token 的页面拿不到内容。')
  }
  url = `http://127.0.0.1:${tokenMatch[1]}/?token=${tokenMatch[2]}`
  console.log(`✓ 服务已起：${url}`)

  const hostLoaded = /已注册面板接口/.test(serverOut) || /已注册工具/.test(serverOut)
  console.log(`  宿主半装载：${hostLoaded ? '✓ 成功' : '✗ 没看到注册日志'}`)

  // 4) 无头浏览器抓页面真实文本
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshps-verify-'))
  console.log('  正在用无头浏览器渲染页面…')
  const dumped = dumpDom(userDataDir)
  if (dumped.recipe === null) {
    fail(2, `无头浏览器没能 dump 出页面：${dumped.notes.join('；')}`)
  }
  const dom = dumped.dom
  console.log(`  DOM 已抓到：${dom.length} 字符（配方 ${dumped.recipe}）`)
  for (const note of dumped.notes) console.log(`  注意：${note}`)

  // 5) 断言
  const problems = []
  if (/did not activate/i.test(dom)) {
    const line = /[^\n]*did not activate[^\n]*/.exec(dom)?.[0] ?? ''
    const detail = /[^\n]*pending[^\n]*/.exec(dom)?.[0] ?? ''
    problems.push(`页面报「entry did not activate」：${line.trim()} ${detail.trim()}`)
  }
  if (/Failed to load plugins/i.test(dom)) problems.push('页面显示 "Failed to load plugins"')
  if (!dom.includes(expectText)) {
    problems.push(`页面里没找到期望文本「${expectText}」—— 面板席位可能没挂上`)
  }
  if (!dom.includes('dsh-profile-sync')) {
    problems.push('页面里完全没有 dsh-profile-sync 这个 id —— 宿主可能没把这一行注入模块图')
  }

  console.log('')
  if (problems.length === 0) {
    console.log('✓ 通过：客户端启动审计没有报错，面板席位已挂上。')
    exitCode = 0
  } else {
    console.log('✗ 不通过：')
    for (const p of problems) console.log(`  · ${p}`)
    exitCode = 1
  }
} catch (err) {
  console.error(`验证器自身出错：${String(err?.stack ?? err)}`)
  exitCode = 2
} finally {
  if (keep) console.log(`（--keep：保留了 ${profileDir} 和 ${userDataDir ?? '(无浏览器目录)'}）`)
  cleanup()
}

process.exit(exitCode)
