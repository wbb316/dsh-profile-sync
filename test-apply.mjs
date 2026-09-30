/**
 * dsh-profile-sync 执行层测试。
 *
 * 在 ~/.dsh/profiles/ 下建两个**合成 profile**（名字带 synctest- 前缀）跑完整的
 * 快照 → 写 manifest → 合并 allowBuilds → 写 pending → 核对 → 回滚 流程。
 *
 * 不碰真实的 web / desktop，不跑 pnpm（runner 是注入的假函数），不占端口。
 * 跑法：node test-apply.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

import { computePlan, profilesRoot } from './lib/plan.js'
import { applyPlan, buildUpdatedManifest, restoreSnapshot, snapshotProfile } from './lib/apply.js'
import { clearPending, readPending, verifyPending } from './lib/artifacts.js'

const SRC = 'synctest-src'
const TGT = 'synctest-tgt'
const srcDir = path.join(profilesRoot(), SRC)
const tgtDir = path.join(profilesRoot(), TGT)

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') throw new Error('异步用例请用 await，不要放进 test()')
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`      ${String((err && err.message) || err).split('\n').join('\n      ')}`)
  }
}
async function testAsync(name, fn) {
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
      /* Windows 上文件被占时忽略 */
    }
  }
}

function setup() {
  cleanup()
  // 源 profile：两个插件，一个声明了 bundle，一个没有
  write(
    path.join(srcDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-synctest-src',
        private: true,
        dependencies: {
          '@deepseek-ai/dsh-base': '0.2.0-rc.2',
          'plug-with-bundle': '^1.0.0',
          'plug-plain': '^2.0.0',
          'plug-in-list-but-no-decl': '^3.0.0',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'plug-with-bundle', 'plug-in-list-but-no-decl'] } },
      },
      null,
      2
    ) + '\n'
  )
  write(
    path.join(srcDir, 'node_modules', 'plug-with-bundle', 'package.json'),
    JSON.stringify({
      name: 'plug-with-bundle',
      version: '1.0.0',
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }) + '\n'
  )
  write(path.join(srcDir, 'node_modules', 'plug-with-bundle', 'index.js'), 'export function apply() {}\n')
  write(path.join(srcDir, 'node_modules', 'plug-with-bundle', 'cordis.patch.yml'), '- insert:\n    - id: plug-with-bundle\n')
  write(
    path.join(srcDir, 'node_modules', 'plug-plain', 'package.json'),
    JSON.stringify({ name: 'plug-plain', version: '2.0.0', main: 'index.js' }) + '\n'
  )
  write(path.join(srcDir, 'node_modules', 'plug-plain', 'index.js'), 'export function apply() {}\n')
  // 这个包**进了源侧 bundles 列表却没声明 dsh.bundle.patch** —— 非法的层，
  // 官方会当普通依赖装并警告，我们必须给出同样的警告且不把它写进目标 bundles
  write(
    path.join(srcDir, 'node_modules', 'plug-in-list-but-no-decl', 'package.json'),
    JSON.stringify({ name: 'plug-in-list-but-no-decl', version: '3.0.0', main: 'index.js' }) + '\n'
  )
  write(path.join(srcDir, 'node_modules', 'plug-in-list-but-no-decl', 'index.js'), 'export function apply() {}\n')
  write(path.join(srcDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nallowBuilds:\n  node-pty: true\n')

  // 目标 profile：干净的起点
  write(
    path.join(tgtDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-synctest-tgt',
        private: true,
        dependencies: { '@deepseek-ai/dsh-base': '0.2.0-rc.2' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      },
      null,
      2
    ) + '\n'
  )
  write(path.join(tgtDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nallowBuilds:\n  cloudflared: true\n')
  write(path.join(tgtDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    preference: dark\n')
}

const readTargetManifest = () => JSON.parse(fs.readFileSync(path.join(tgtDir, 'package.json'), 'utf8'))
const readTargetWorkspace = () => fs.readFileSync(path.join(tgtDir, 'pnpm-workspace.yaml'), 'utf8')

console.log('\n执行层')

setup()
clearPending()

test('buildUpdatedManifest：声明了 bundle 的进 bundles，进列表却没声明的被拦下并警告', () => {
  const plan = computePlan({ source: SRC, target: TGT })
  const before = readTargetManifest()
  const { manifest, warnings } = buildUpdatedManifest(before, plan, {})

  // 普通依赖：装上，但不进 bundles（它本来就不在源的 bundles 列表里）
  assert.equal(manifest.dependencies['plug-plain'], '^2.0.0')
  assert.ok(!manifest.dsh.profile.bundles.includes('plug-plain'))
  assert.ok(!warnings.some((w) => w.includes('plug-plain')), '普通依赖不该有警告')

  // 声明了 patch 的：既装上也进 bundles
  assert.equal(manifest.dependencies['plug-with-bundle'], '^1.0.0')
  assert.ok(manifest.dsh.profile.bundles.includes('plug-with-bundle'))

  // 在 bundles 列表里却没声明的：不写进 bundles，并给警告
  assert.ok(!manifest.dsh.profile.bundles.includes('plug-in-list-but-no-decl'))
  const hit = warnings.find((w) => w.includes('plug-in-list-but-no-decl'))
  assert.ok(hit, `应当为 plug-in-list-but-no-decl 给出警告，实际警告：${JSON.stringify(warnings)}`)
  assert.match(hit, /没有声明 dsh\.bundle/)
})

await testAsync('applyPlan（runner 成功）：manifest/allowBuilds/pending 都落地，核对通过', async () => {
  clearPending()
  const plan = computePlan({ source: SRC, target: TGT })
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers))

  let calledWith = null
  const result = await applyPlan({
    plan,
    runner: async (args) => {
      calledWith = args
      return 0
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calledWith, ['plugin', '--profile', TGT, 'install'])

  const manifest = readTargetManifest()
  assert.equal(manifest.dependencies['plug-with-bundle'], '^1.0.0')
  assert.ok(manifest.dsh.profile.bundles.includes('plug-with-bundle'))

  const ws = readTargetWorkspace()
  assert.match(ws, /node-pty: true/, '源侧放行的 node-pty 应合并进来')
  assert.match(ws, /cloudflared: true/, '目标侧原有的 cloudflared 不能被弄丢')
  assert.equal((ws.match(/allowBuilds:/g) || []).length, 1, '不能写出第二个 allowBuilds 块')

  const pending = readPending()
  assert.ok(pending !== null, 'pending 日志应写下来')
  assert.equal(pending.target.name, TGT)

  // 核对：现在磁盘状态应当与 pending 期望一致
  const verify = verifyPending()
  assert.equal(verify.state, 'match', JSON.stringify(verify))
  assert.equal(verify.ok, true)
})

await testAsync('applyPlan（runner 失败）：自动回滚，文件回到快照状态', async () => {
  clearPending()
  setup()
  const before = fs.readFileSync(path.join(tgtDir, 'package.json'), 'utf8')
  const beforeWs = readTargetWorkspace()

  const plan = computePlan({ source: SRC, target: TGT })
  const result = await applyPlan({
    plan,
    runner: async () => 1, // 模拟官方兼容性拒绝
  })

  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.equal(fs.readFileSync(path.join(tgtDir, 'package.json'), 'utf8'), before, 'package.json 必须回到原样')
  assert.equal(readTargetWorkspace(), beforeWs, 'pnpm-workspace.yaml 必须回到原样')
})

await testAsync('applyPlan（dry-run）：什么都不写', async () => {
  setup()
  const before = fs.readFileSync(path.join(tgtDir, 'package.json'), 'utf8')
  const plan = computePlan({ source: SRC, target: TGT })
  const result = await applyPlan({ plan, dryRun: true, runner: async () => 0 })
  assert.equal(result.dryRun, true)
  assert.equal(fs.readFileSync(path.join(tgtDir, 'package.json'), 'utf8'), before)
  assert.ok(result.summary.changes.some((c) => c.name === 'plug-with-bundle'))
})

await testAsync('applyPlan：有阻断项时拒绝执行', async () => {
  setup()
  const plan = computePlan({ source: SRC, target: TGT })
  plan.ok = false
  plan.blockers = [{ code: 'x', message: 'test' }]
  let threw = null
  try {
    await applyPlan({ plan, runner: async () => 0 })
  } catch (err) {
    threw = err
  }
  assert.ok(threw !== null, '应当抛错拒绝')
  assert.match(String(threw.message), /阻断/)
})

await testAsync('applyPlan：目标目录不是 profiles/<name> 时拒绝（官方通道按名字解析）', async () => {
  const plan = computePlan({ source: SRC, target: TGT })
  plan.target = { ...plan.target, dir: path.join(profilesRoot(), 'somewhere-else') }
  let threw = null
  try {
    await applyPlan({ plan, runner: async () => 0 })
  } catch (err) {
    threw = err
  }
  assert.ok(threw !== null)
  assert.match(String(threw.message), /目标 profile 目录/)
})

test('snapshotProfile / restoreSnapshot：原本不存在的文件在回滚时被删掉', () => {
  setup()
  const extra = path.join(tgtDir, 'compatibility.json')
  fs.rmSync(extra, { force: true })
  const snap = snapshotProfile(tgtDir, { label: 'unit-test-snapshot' })
  // 模拟 apply 造出一个原本不存在的文件
  write(extra, '{"x@1.0.0":["0.2.0-rc.2"]}')
  write(path.join(tgtDir, 'cordis.patch.yml'), '- id: changed\n')
  const result = restoreSnapshot(snap.dir, tgtDir)
  assert.equal(result.ok, true)
  assert.ok(result.removed.includes('compatibility.json'), '原本不存在的文件应被删掉')
  assert.ok(result.restored.includes('cordis.patch.yml'))
  assert.match(fs.readFileSync(path.join(tgtDir, 'cordis.patch.yml'), 'utf8'), /ui-theme/)
  fs.rmSync(snap.dir, { recursive: true, force: true })
})

// ─────────────────────────── 清理 ───────────────────────────
cleanup()
clearPending()
try {
  fs.rmSync(path.join(profilesRoot(), '..', 'profile-sync', 'plans'), { recursive: true, force: true })
} catch {
  /* 忽略 */
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
