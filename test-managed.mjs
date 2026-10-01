/**
 * dsh-profile-sync 受管通道测试（真正能写桌面端 profile 的那条路）。
 *
 * 为什么这份测试重要：`apply` 与 bootstrap 现在都依赖「官方插件管理器」，
 * 而它是**唯一**能写 app 自有 profile 的东西（CLI 被按名字禁止）。
 * 这条链路错了，插件的核心功能就等于没有。
 *
 * HTTP 端点那条用一个本地假服务器真跑一遍（POST + 轮询），不碰真的 DSH。
 * 跑法：node test-managed.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

import {
  applyManaged,
  installViaEndpoint,
  managedSpec,
  managedSpecs,
  prepareAllowBuilds,
  profilePort,
  profilePortInfo,
  resolvePluginManager,
} from './lib/managed.js'
import { profilesRoot } from './lib/plan.js'

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

console.log('\nspec 拼法')

await test('managedSpec：registry 拼 name@range；link/file 原样给', () => {
  assert.equal(managedSpec({ name: 'a', spec: '^1.2.3', kind: 'registry' }), 'a@^1.2.3')
  assert.equal(managedSpec({ name: 'dsh-novel', spec: 'link:D:/p', kind: 'link' }), 'link:D:/p')
  assert.equal(managedSpec({ name: 'x', spec: 'file:D:/t.tgz', kind: 'file' }), 'file:D:/t.tgz')
  // 没给 kind 时按 registry 处理（computePlan 的 entry 总是带 kind）
  assert.equal(managedSpec({ name: 'b', spec: '1.0.0' }), 'b@1.0.0')
})

await test('managedSpecs：add + change，顺序稳定', () => {
  const plan = {
    add: [{ name: 'a', spec: '^1.0.0', kind: 'registry' }],
    change: [{ name: 'b', spec: '2.0.0', kind: 'registry' }],
  }
  assert.deepEqual(managedSpecs(plan), ['a@^1.0.0', 'b@2.0.0'])
})

console.log('\n管理器解析')

await test('resolvePluginManager：从 ctx.get 拿到', () => {
  const fake = { installBundle: () => {}, removeBundle: () => {} }
  assert.equal(resolvePluginManager({ get: (k) => (k === 'pluginManager' ? fake : undefined) }), fake)
})

await test('resolvePluginManager：从 ctx.reflect.get 拿到', () => {
  const fake = { installBundle: () => {} }
  assert.equal(resolvePluginManager({ reflect: { get: (k) => (k === 'pluginManager' ? fake : undefined) } }), fake)
})

await test('resolvePluginManager：取不到 / 形状不对 → undefined（绝不猜一个回去）', () => {
  assert.equal(resolvePluginManager(undefined), undefined)
  assert.equal(resolvePluginManager(null), undefined)
  assert.equal(resolvePluginManager({}), undefined)
  assert.equal(resolvePluginManager({ get: () => undefined }), undefined)
  // 有这个名字但没 installBundle —— 不能当成可用
  assert.equal(resolvePluginManager({ get: () => ({ nope: 1 }) }), undefined)
  // get 抛错也不能炸出去
  assert.equal(
    resolvePluginManager({
      get: () => {
        throw new Error('boom')
      },
    }),
    undefined
  )
})

console.log('\n进程内应用（官方管理器）')

function fakeManager(behavior = {}) {
  const calls = []
  return {
    calls,
    installBundle: async (spec) => {
      calls.push({ op: 'install', spec })
      if (behavior.failOn === spec) return { application: 'failed', error: `${spec} 被拒绝` }
      return { application: behavior.application ?? 'applied', packageResult: { output: `ok ${spec}` } }
    },
    async removeBundle(name) {
      calls.push({ op: 'remove', name })
      return { application: 'applied' }
    },
  }
}

const plan = () => ({
  add: [{ name: 'plug-a', spec: '^1.0.0', kind: 'registry' }],
  change: [{ name: 'plug-b', spec: '2.0.0', kind: 'registry' }],
  extraInTarget: [],
})

await test('applyManaged：每个 spec 各调一次 installBundle，spec 拼对', async () => {
  const manager = fakeManager()
  const r = await applyManaged(plan(), { manager })
  assert.equal(r.ok, true)
  assert.deepEqual(
    manager.calls,
    [
      { op: 'install', spec: 'plug-a@^1.0.0' },
      { op: 'install', spec: 'plug-b@2.0.0' },
    ]
  )
  assert.equal(r.results.length, 2)
})

await test('applyManaged：restart-required / overridden 也算成功', async () => {
  for (const application of ['restart-required', 'overridden']) {
    const r = await applyManaged(plan(), { manager: fakeManager({ application }) })
    assert.equal(r.ok, true, `${application} 应当算成功`)
  }
})

await test('applyManaged：失败就停在那一条，不再继续往下装', async () => {
  const manager = fakeManager({ failOn: 'plug-b@2.0.0' })
  const r = await applyManaged(plan(), { manager })
  assert.equal(r.ok, false)
  assert.equal(r.failedSpec, 'plug-b@2.0.0')
  assert.match(String(r.error), /被拒绝/)
  assert.equal(manager.calls.length, 2, '第一条成功了、第二条失败后必须停住，不要继续')
})

await test('applyManaged：installBundle 抛异常也要变成结果，不能炸穿', async () => {
  const manager = {
    installBundle: async () => {
      throw new Error('磁盘炸了')
    },
  }
  const r = await applyManaged(plan(), { manager })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /磁盘炸了/)
})

await test('applyManaged：prune 时逐个 removeBundle', async () => {
  const manager = fakeManager()
  const p = { ...plan(), prune: true, extraInTarget: [{ name: 'old-x', spec: '1.0.0' }] }
  const r = await applyManaged(p, { manager })
  assert.equal(r.ok, true)
  assert.ok(manager.calls.some((c) => c.op === 'remove' && c.name === 'old-x'))
  assert.equal(r.removals.length, 1)
})

await test('applyManaged：没有管理器就抛错（不许偷偷退回 CLI）', async () => {
  let threw = null
  try {
    await applyManaged(plan(), { manager: undefined })
  } catch (err) {
    threw = err
  }
  assert.ok(threw !== null)
  assert.match(String(threw.message), /不能退回 CLI/)
})

console.log('\nallowBuilds（受管路径也必须补，且必须在 install 之前）')

/** 造一个只含最小内容的临时 profile 目录。 */
function tempProfile(workspaceText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshps-allow-'))
  if (workspaceText !== null) fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), workspaceText)
  return dir
}

await test('prepareAllowBuilds：合并缺的键，保留已有键与其余内容', () => {
  const dir = tempProfile('packages:\n  - .\n\nallowBuilds:\n  cloudflared: true\n')
  try {
    const file = path.join(dir, 'pnpm-workspace.yaml')
    const build = prepareAllowBuilds({
      target: { dir },
      allowBuilds: { add: ['node-pty'], addValues: { 'node-pty': 'false' } },
    })
    assert.deepEqual(build.added, ['node-pty'])
    const text = fs.readFileSync(file, 'utf8')
    assert.equal((text.match(/allowBuilds:/g) || []).length, 1, '不能写出第二个 allowBuilds 块（那是非法 YAML）')
    assert.match(text, /cloudflared: true/, '已有的键不能被动')
    assert.match(text, /node-pty: false/, '新增键必须沿用源侧的值，不能一律写 true')
    assert.match(text, /packages:/, '文件其余内容必须原样保留')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('prepareAllowBuilds：幂等 —— 已经有的键不再算新增', () => {
  const dir = tempProfile('allowBuilds:\n  node-pty: true\n')
  try {
    const build = prepareAllowBuilds({ target: { dir }, allowBuilds: { add: ['node-pty'] } })
    assert.deepEqual(build.added, [])
    assert.equal(build.undo, null, '没有改动就不该有 undo（否则会把别人的内容覆盖回去）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('prepareAllowBuilds：目标没有 pnpm-workspace.yaml → 跳过且不新建残废文件', () => {
  const dir = tempProfile(null)
  try {
    const build = prepareAllowBuilds({ target: { dir }, allowBuilds: { add: ['node-pty'] } })
    assert.deepEqual(build.added, [])
    assert.deepEqual(build.skipped, ['node-pty'])
    assert.equal(fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')), false, '不能凭空造一个只含 allowBuilds 的文件')
    assert.match(build.warnings.join('\n'), /没有 pnpm-workspace\.yaml/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('applyManaged：allowBuilds 在**第一次 installBundle 之前**就已落盘', async () => {
  // 这是这个 bug 的核心：管理器的每次 installBundle 都是一次真的 pnpm 安装，
  // 授权如果晚一步写，那次安装就已经在缺少授权的状态下跑完了。
  const dir = tempProfile('packages:\n  - .\n')
  try {
    const file = path.join(dir, 'pnpm-workspace.yaml')
    const seen = []
    const manager = {
      installBundle: async (spec) => {
        seen.push({ spec, yaml: fs.readFileSync(file, 'utf8') })
        return { application: 'applied' }
      },
    }
    const p = { ...plan(), target: { dir }, allowBuilds: { add: ['node-pty'], addValues: { 'node-pty': 'true' } } }
    const r = await applyManaged(p, { manager })
    assert.equal(r.ok, true)
    assert.deepEqual(r.allowBuildsAdded, ['node-pty'])
    assert.ok(seen.length >= 1, '应当真的装了东西')
    for (const s of seen) {
      assert.match(s.yaml, /node-pty: true/, `${s.spec} 安装时授权必须已经在文件里了`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('applyManaged：安装失败时把 allowBuilds 退回原样（不留半成品）', async () => {
  const original = 'packages:\n  - .\n'
  const dir = tempProfile(original)
  try {
    const file = path.join(dir, 'pnpm-workspace.yaml')
    const manager = fakeManager({ failOn: 'plug-a@^1.0.0' })
    const p = { ...plan(), target: { dir }, allowBuilds: { add: ['node-pty'] } }
    const r = await applyManaged(p, { manager })
    assert.equal(r.ok, false)
    assert.equal(r.allowBuildsReverted, true)
    assert.equal(fs.readFileSync(file, 'utf8'), original, '失败后不能留下我们写入的授权项')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('applyManaged：没有 allowBuilds 缺口时不碰 pnpm-workspace.yaml', async () => {
  const original = 'packages:\n  - .\n\nallowBuilds:\n  node-pty: true\n'
  const dir = tempProfile(original)
  try {
    const file = path.join(dir, 'pnpm-workspace.yaml')
    const r = await applyManaged({ ...plan(), target: { dir }, allowBuilds: { add: [] } }, { manager: fakeManager() })
    assert.equal(r.ok, true)
    assert.deepEqual(r.allowBuildsAdded, [])
    assert.equal(fs.readFileSync(file, 'utf8'), original, '没有缺口就必须一个字节都不动')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log('\n端口读取')

await test('profilePort：旧签名只是薄包装，不存在的目录返回 null', () => {
  const desktopDir = path.join(profilesRoot(), 'desktop')
  // 这里**不断言「这台机器一定读得到 19387」**：没带 DSH_WEB_URL、patch 里也没写
  // port 的环境（另一套安装就是）读不到才是正确结果。只断言旧签名与新函数一致。
  assert.equal(profilePort(desktopDir), profilePortInfo(desktopDir, 'desktop').port)
  assert.equal(profilePort(path.join(profilesRoot(), 'definitely-not-here')), null)
})

await test('profilePortInfo：三档来源按权威性排序，且读不到时**不猜**', () => {
  // 端口现在的归属是**启动参数**（桌面端宿主 --port 19387；web 走 bundle 层
  // `ctx.webStartup.port ?? 3080`）。所以「当前 profile」这一档必须优先 ——
  // 只有它能正确处理 --port 0（操作系统随机端口）和用户自定义端口。
  const saved = {
    dir: process.env.DSH_PROFILE_DIR,
    name: process.env.DSH_PROFILE,
    url: process.env.DSH_WEB_URL,
  }
  const restore = () => {
    if (saved.dir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = saved.dir
    if (saved.name === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = saved.name
    if (saved.url === undefined) delete process.env.DSH_WEB_URL
    else process.env.DSH_WEB_URL = saved.url
  }
  try {
    const desktopDir = path.join(profilesRoot(), 'desktop')

    // 第 1 档：当前 profile + DSH_WEB_URL（即使它自己的 patch 里写的是别的端口）
    process.env.DSH_PROFILE_DIR = desktopDir
    process.env.DSH_PROFILE = 'desktop'
    process.env.DSH_WEB_URL = 'http://127.0.0.1:19999'
    const runtime = profilePortInfo(desktopDir, 'desktop')
    assert.equal(runtime.port, 19999)
    assert.match(runtime.source, /DSH_WEB_URL/)
    // 换成随机端口也必须跟得上（--port 0 场景）
    process.env.DSH_WEB_URL = 'http://127.0.0.1:54321'
    assert.equal(profilePortInfo(desktopDir, 'desktop').port, 54321)

    // 第 2 档：不是当前 profile → 读它自己的 patch
    process.env.DSH_PROFILE = 'somewhere-else'
    process.env.DSH_PROFILE_DIR = path.join(profilesRoot(), 'somewhere-else')
    const viaPatch = profilePortInfo(path.join(profilesRoot(), 'web'), 'web')
    assert.equal(viaPatch.port, 3080)
    assert.match(viaPatch.source, /cordis\.patch\.yml/)

    // 第 3 档：web 的出厂默认（目录不存在、名字叫 web）
    const shipped = profilePortInfo(path.join(profilesRoot(), 'no-such-profile-dir'), 'web')
    assert.equal(shipped.port, 3080)
    assert.match(shipped.source, /出厂默认/)

    // 都不成立 → null + 说明原因（**不猜**：猜错会把安装请求发到别的进程上）
    const none = profilePortInfo(path.join(profilesRoot(), 'no-such-profile-dir'), 'not-web')
    assert.equal(none.port, null)
    assert.match(none.source, /读不到/)
  } finally {
    restore()
  }
})

console.log('\nHTTP 端点通道（本地假服务器真跑）')

/** 起一个假管理器服务器，按脚本回答 install / list。 */
async function fakeServer(script) {
  let listCalls = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/plugin-manager/install') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        const answer = script.install(parsed)
        res.writeHead(answer.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(answer.body))
      })
      return
    }
    if (req.method === 'GET' && req.url === '/api/plugin-manager/list') {
      listCalls += 1
      const plugins = script.list(listCalls)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ plugins }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { port, close: () => new Promise((resolve) => server.close(resolve)), listCalls: () => listCalls }
}

await test('installViaEndpoint：POST 受理后轮询到包出现 → ok', async () => {
  const seen = []
  const srv = await fakeServer({
    install: (body) => {
      seen.push(body)
      return { status: 200, body: { jobId: 'job-1' } }
    },
    list: (n) => (n < 2 ? [] : [{ id: 'dsh-profile-sync', name: 'dsh-profile-sync' }]),
  })
  try {
    const r = await installViaEndpoint('link:D:/p', { port: srv.port, name: 'dsh-profile-sync', pollMs: 30, timeoutMs: 5000 })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.jobId, 'job-1')
    assert.deepEqual(seen, [{ spec: 'link:D:/p' }], 'POST 的 body 必须是 { spec }')
    assert.ok(srv.listCalls() >= 2, '必须真的轮询过（第一次空、第二次才有）')
  } finally {
    await srv.close()
  }
})

await test('installViaEndpoint：端点报错 → ok=false 且带上原因', async () => {
  const srv = await fakeServer({
    install: () => ({ status: 400, body: { message: 'spec 不合法' } }),
    list: () => [],
  })
  try {
    const r = await installViaEndpoint('bad', { port: srv.port, name: 'bad', pollMs: 20, timeoutMs: 1000 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 400)
    assert.match(String(r.message), /spec 不合法/)
  } finally {
    await srv.close()
  }
})

await test('installViaEndpoint：受理了但包一直不出现 → 超时报错（不谎报成功）', async () => {
  const srv = await fakeServer({ install: () => ({ status: 200, body: { jobId: 'j' } }), list: () => [] })
  try {
    const r = await installViaEndpoint('link:D:/p', { port: srv.port, name: 'never', pollMs: 20, timeoutMs: 300 })
    assert.equal(r.ok, false)
    assert.match(String(r.message), /还没看到 never/)
  } finally {
    await srv.close()
  }
})

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
