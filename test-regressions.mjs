/**
 * dsh-profile-sync 回归测试 —— 每一个用例对应一个**真实修过的 bug**。
 *
 * 这些是最容易再犯回去的地方，所以单独一份、写清「当初怎么错的」。
 * 跑法：node test-regressions.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

import { buildApplyCmd, resolveNodeExe, writePending } from './lib/artifacts.js'
import { applyPlan, validatePlanForApply } from './lib/apply.js'
import { computePlan, profilesRoot } from './lib/plan.js'
import { clearPending, verifyPending } from './lib/artifacts.js'

const SRC = 'synctest-rsrc'
const TGT = 'synctest-rtgt'
const srcDir = path.join(profilesRoot(), SRC)
const tgtDir = path.join(profilesRoot(), TGT)

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`      ${String((err && err.message) || err).split('\n').join('\n      ')}`)
  }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function cleanup() {
  for (const dir of [srcDir, tgtDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 占文件时忽略 */
    }
  }
}

/** 两个合成 profile：源有一个带 patch 的插件 + 一个普通插件；目标干净 */
function setup({ targetHasWorkspace = true, targetExtra = null } = {}) {
  cleanup()
  write(
    path.join(srcDir, 'package.json'),
    JSON.stringify({
      name: 'p-rsrc',
      dependencies: { '@deepseek-ai/dsh-base': '0.2.0-rc.2', 'plug-a': '^1.0.0', 'plug-plain': '^2.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'plug-a'] } },
    }) + '\n'
  )
  for (const [name, version, withPatch] of [
    ['plug-a', '1.0.0', true],
    ['plug-plain', '2.0.0', false],
  ]) {
    const dir = path.join(srcDir, 'node_modules', name)
    const manifest = { name, version, main: 'index.js' }
    if (withPatch) manifest.dsh = { bundle: { patch: './cordis.patch.yml' } }
    write(path.join(dir, 'package.json'), JSON.stringify(manifest) + '\n')
    write(path.join(dir, 'index.js'), 'export function apply() {}\n')
    if (withPatch) write(path.join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n`)
  }
  write(path.join(srcDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nallowBuilds:\n  node-pty: true\n')

  const tgtDeps = { '@deepseek-ai/dsh-base': '0.2.0-rc.2' }
  if (targetExtra !== null) tgtDeps[targetExtra] = '^9.9.9'
  write(
    path.join(tgtDir, 'package.json'),
    JSON.stringify({
      name: 'p-rtgt',
      dependencies: tgtDeps,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }) + '\n'
  )
  if (targetHasWorkspace) {
    write(path.join(tgtDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\n')
  }
  write(path.join(tgtDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    preference: dark\n')
}

console.log('\n回归 1：Electron 里 process.execPath 是应用 exe（不能用它执行脚本）')

await test('resolveNodeExe：不在 Electron 里就用当前 node', () => {
  assert.equal(resolveNodeExe({ isElectron: false, execPath: 'D:/node/node.exe' }), 'D:/node/node.exe')
})

await test('resolveNodeExe：在 Electron 里**绝不**返回应用 exe', () => {
  const appExe = 'D:\\dsh\\dsh-desktop\\DeepSeek Harness.exe'
  // PATH 上什么都没有 → 必须返回 null，而不是退回应用 exe
  const none = resolveNodeExe({ isElectron: true, execPath: appExe, env: { PATH: 'C:\\definitely\\empty' } })
  assert.equal(none, null, `在 Electron 里找不到 node 时必须返回 null，实际：${none}`)
})

await test('resolveNodeExe：在 Electron 里能从 PATH 找到真 node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ps-node-'))
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  const fake = path.join(dir, name)
  fs.writeFileSync(fake, '#!/bin/sh\n')
  const found = resolveNodeExe({
    isElectron: true,
    execPath: 'D:\\dsh\\dsh-desktop\\DeepSeek Harness.exe',
    env: { PATH: dir },
  })
  assert.equal(found, fake)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('resolveNodeExe：PATH 上指的是 electron 系的东西也不认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ps-el-'))
  const fake = path.join(dir, 'electron.exe')
  fs.writeFileSync(fake, 'x')
  const found = resolveNodeExe({ isElectron: true, execPath: 'x', env: { PATH: dir } })
  assert.equal(found, null, 'electron.exe 不能被当成 node')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('buildApplyCmd：烘了 node 路径就直接用，且绝不执行桌面端 exe', () => {
  const cmd = buildApplyCmd({ planFile: 'P:\\plan.json', applyScript: 'A:\\apply.mjs', nodeExe: 'D:\\node\\node.exe' })
  assert.match(cmd, /set "DSH_NODE=D:\\node\\node\.exe"/)
  assert.match(cmd, /--plan/)
  // 提示文字里出现「DeepSeek Harness」是正常的；要挡的是**拿它当可执行文件**
  assert.ok(!/DeepSeek Harness\.exe/i.test(cmd), '生成的脚本里不该把桌面端 exe 当命令执行')
  assert.ok(!/\bexecPath\b/.test(cmd))
})

await test('buildApplyCmd：烘不进 node 时运行期自己找，找不到要明确报错（而不是启桌面端）', () => {
  const cmd = buildApplyCmd({ planFile: 'P:\\plan.json', applyScript: 'A:\\apply.mjs', nodeExe: null })
  assert.match(cmd, /where node/, '应当有运行期查找')
  assert.match(cmd, /找不到 node\.exe/, '应当有明确的报错分支')
  assert.match(cmd, /exit \/b 1/, '找不到就退出，不能继续')
  assert.ok(!/DeepSeek Harness\.exe/i.test(cmd), '绝不能把桌面端 exe 当命令')
})

console.log('\n回归 2：--prune 时期望值必须和实际写下去的 manifest 一致')

await test('apply(--prune) 之后核对必须是 match（曾经会自己报「缺依赖」）', async () => {
  setup({ targetExtra: 'only-on-target' })
  clearPending()
  const plan = computePlan({ source: SRC, target: TGT, prune: true })
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers))
  assert.ok(
    plan.extraInTarget.some((e) => e.name === 'only-on-target'),
    '合成 fixture 应能算出「只在目标端」的依赖'
  )

  const result = await applyPlan({ plan, prune: true, runner: async () => 0 })
  assert.equal(result.ok, true)

  const manifest = JSON.parse(fs.readFileSync(path.join(tgtDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['only-on-target'], undefined, 'prune 应当把它删掉')

  const verify = verifyPending()
  assert.equal(verify.state, 'match', `prune 之后核对必须是 match，实际 ${verify.state}：${JSON.stringify(verify.driftedDeps)}`)
})

console.log('\n回归 3：--no-install 不能在核对时假装「已落地」')

await test('apply(无 runner) 之后核对是 manifest-only，不是 match', async () => {
  setup()
  clearPending()
  const plan = computePlan({ source: SRC, target: TGT })
  const result = await applyPlan({ plan, runner: undefined })
  assert.equal(result.ok, true, '写 manifest 这一步本身是成功的')

  const verify = verifyPending()
  assert.equal(verify.state, 'manifest-only', `应当是 manifest-only，实际 ${verify.state}`)
  assert.equal(verify.ok, false, '没跑安装就不能算 ok')
  assert.equal(verify.installSkipped, true)
})

console.log('\n回归 4：目标没有 pnpm-workspace.yaml 时不能造一个残废文件')

await test('缺 pnpm-workspace.yaml：跳过 allowBuilds，不新建文件', async () => {
  setup({ targetHasWorkspace: false })
  clearPending()
  const wsFile = path.join(tgtDir, 'pnpm-workspace.yaml')
  assert.equal(fs.existsSync(wsFile), false, '前置条件：目标没有 workspace 文件')

  const plan = computePlan({ source: SRC, target: TGT })
  assert.ok(plan.allowBuilds.add.includes('node-pty'), '源侧的 node-pty 应当算进 allowBuilds 缺口')

  const result = await applyPlan({ plan, runner: async () => 0 })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(wsFile), false, '不该凭空造出一个只含 allowBuilds 的文件（会丢掉 nodeLinker）')
  assert.ok(result.summary.workspaceWarnings.length > 0, '必须给出警告')
  assert.deepEqual(result.summary.allowBuildsSkipped, ['node-pty'])
  assert.deepEqual(result.summary.allowBuildsAdded, [])
})

await test('有 pnpm-workspace.yaml 时照常合并，且 nodeLinker 不能被弄丢', async () => {
  setup({ targetHasWorkspace: true })
  clearPending()
  const plan = computePlan({ source: SRC, target: TGT })
  const result = await applyPlan({ plan, runner: async () => 0 })
  assert.equal(result.ok, true)
  const ws = fs.readFileSync(path.join(tgtDir, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(ws, /node-pty: true/)
  assert.match(ws, /nodeLinker: hoisted/)
  assert.equal((ws.match(/allowBuilds:/g) || []).length, 1)
})

console.log('\n回归 5：手改过的 plan.json 必须被拒，而不是写进 package.json')

await test('validatePlanForApply：缺 target / 坏包名 / spec 带控制字符 / add 不是数组 都要拒', () => {
  assert.equal(validatePlanForApply(null).ok, false)
  assert.equal(validatePlanForApply({}).ok, false)
  assert.equal(validatePlanForApply({ target: {} }).ok, true, '空计划本身是合法的')
  assert.equal(validatePlanForApply({ target: {}, add: 'nope' }).ok, false)
  assert.equal(validatePlanForApply({ target: {}, add: [{ name: 'bad name!', spec: '1.0.0' }] }).ok, false)
  assert.equal(validatePlanForApply({ target: {}, add: [{ name: 'ok', spec: '1.0.0\nx' }] }).ok, false)
  assert.equal(validatePlanForApply({ target: {}, add: [{ name: 'ok', spec: '' }] }).ok, false)
  assert.equal(validatePlanForApply({ target: {}, bundles: { add: [123] } }).ok, false)
  // allowBuilds 的键允许 `包名@git+https://…` 这种形态
  assert.equal(
    validatePlanForApply({ target: {}, allowBuilds: { add: ['x@git+https://h/r.git'] } }).ok,
    true,
    'git 形态的 allowBuilds 键必须放行'
  )
})

await test('applyPlan 拿到坏计划时抛错，且不动磁盘', async () => {
  setup()
  const before = fs.readFileSync(path.join(tgtDir, 'package.json'), 'utf8')
  const bad = { target: { name: TGT, dir: tgtDir }, ok: true, add: [{ name: '../evil', spec: '1.0.0' }] }
  let threw = null
  try {
    await applyPlan({ plan: bad, runner: async () => 0 })
  } catch (err) {
    threw = err
  }
  assert.ok(threw !== null, '应当抛错')
  assert.match(String(threw.message), /不合法/)
  assert.equal(fs.readFileSync(path.join(tgtDir, 'package.json'), 'utf8'), before, '磁盘不应被改动')
})

await test('writePending 没有显式 expect 时必须抛错（防止再长出第二份推导逻辑）', () => {
  let threw = null
  try {
    writePending({ plan: { target: {}, add: [], change: [] }, planFile: null, backupDir: null })
  } catch (err) {
    threw = err
  }
  assert.ok(threw !== null)
  assert.match(String(threw.message), /expect/)
})

console.log('\n回归 6：apply 的失败原因不能再被吞成「接口报错」')

// 客户端半是浏览器模块（`window.__ModuleLoader__.load`），没法 import 进来直接单测，
// 所以这里对**源码契约**下断言。它锁的正是当初那个一行 bug 的两半：
// 客户端必须读 `text`，宿主必须给 `text`。改坏任意一半，这一节都会红。
const clientSrc = fs.readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
const hostSrc = fs.readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')

await test('client：失败时读 payload.text（apply 返回的是 { ok:false, reason, text }，没有 message）', () => {
  assert.ok(
    !/payload\.message \|\| '接口报错'/.test(clientSrc),
    '不能再只看 payload.message —— apply 的失败里根本没有 message，会退化成一句「接口报错」'
  )
  assert.match(clientSrc, /payload\.text \|\| payload\.message/, 'describeFailure 必须先读 text')
  assert.match(clientSrc, /describeFailure\(payload, res\.status\)/, '兜底文案要带上真实的 HTTP 状态')
})

await test('client：reason 与 blockers 也要带出来（否则等于没说清为什么被拒）', () => {
  assert.match(clientSrc, /payload\.reason/)
  assert.match(clientSrc, /blockers/)
})

await test('宿主：apply 路由每条失败都带 text（这就是面板唯一的信息来源）', () => {
  const start = hostSrc.indexOf('export function makeApplyRoute')
  const end = hostSrc.indexOf('function planSummaryOf')
  assert.ok(start > 0 && end > start, '找不到 makeApplyRoute 的源码区间（重构后请同步改这里）')
  const body = hostSrc.slice(start, end)
  const fails = [...body.matchAll(/ok: false/g)].length
  const texts = [...body.matchAll(/\btext:/g)].length
  assert.ok(fails >= 3, `应当至少有 3 条 ok:false 失败分支，实际 ${fails}`)
  assert.ok(texts >= fails, `每条 ok:false 都要有 text；实际 ok:false=${fails}、text=${texts}`)
})

console.log('\n回归 7：面板「只迁勾中的」必须真的传到宿主（两条路都要），且选择只有一份实现')

// 这一节锁的是「选择」这件事的三个失败方式：
//   1. 只给 apply 传 only、忘了 write（或反过来）→ 一半的操作偷偷迁全部
//   2. 客户端自己再实现一遍筛选 → 出现第二份选择语义，两边必然漂
//   3. 空选择没拦 → 筛出来是 ok:true 的空计划，看着像成功、实际什么都没做

await test('client：/apply 与 /write 都必须带上 only（少一处就会有一半偷偷迁全部）', () => {
  const sent = [...clientSrc.matchAll(/only: onlyArg\(\)/g)].length
  assert.equal(sent, 2, `apply 与 write 各需一处 only: onlyArg()，实际找到 ${sent} 处`)
})

await test('client：算完差异默认全勾（等于原来的一键迁移）', () => {
  assert.match(
    clientSrc,
    /setChecked\(new Set\(rows\.map\(\(r\) => r\.name\)\)\)/,
    '算完差异要默认全勾；否则「算差异 → 应用」不再是原来的一键行为'
  )
  assert.match(clientSrc, /isNothingSelected|nothingSelected/, '面板要能识别「一个都没勾」并拦住按钮')
})

await test('client：勾选行只来自宿主的 selectable，客户端不得重算选择语义', () => {
  assert.match(clientSrc, /Array\.isArray\(data\.selectable\)/, '勾选行必须来自 /plan 的 selectable')
  assert.ok(!/filterPlan/.test(clientSrc), '客户端不得自己实现筛选 —— 选择语义只有 lib/plan.js 一份')
  assert.ok(
    !/allowBuilds\.add\.filter/.test(clientSrc),
    '客户端不得自己筛 allowBuilds：勾选联动（bundle / allowBuilds 跟着包走）由 filterPlan 统一负责'
  )
})

await test('宿主：/api/plan 给出 selectable，write 与 apply 都接受 only', () => {
  assert.match(hostSrc, /selectable: selectablePlugins\(plan\)/, '/api/plan 要返回可勾选名单')
  assert.match(hostSrc, /only: body\.only/, '/api/write 要把 only 交给产物生成')
  assert.match(hostSrc, /filterPlan\(safePlan\(body\), body\?\.only\)/, 'apply 路由要先筛再判 ok')
})

await test('宿主：空选择在每条会动手的路径上都被显式拦住', () => {
  const hits = [...hostSrc.matchAll(/isNothingSelected\(/g)].length
  assert.ok(hits >= 4, `定义 1 处 + 至少 3 处调用（generateArtifacts / 工具 apply / apply 路由），实际 ${hits}`)
  assert.match(hostSrc, /reason: 'empty-selection'/, 'apply 路由要给一个能区分的 reason')
})

// ─────────────────────────── 清理 ───────────────────────────
cleanup()
clearPending()

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
