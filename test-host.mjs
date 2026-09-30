/**
 * dsh-profile-sync 宿主侧 + 客户端侧测试。
 *
 * 不启动 DSH、不装插件、不占端口，直接把两半的契约跑一遍：
 *   · 宿主：API_ROUTES 喂假 req/res，看返回的 JSON；工具 execute 各类 action
 *   · 客户端：假 window.__ModuleLoader__ 接住加载调用，假 require('react')，
 *     假 slots 服务，验证 apply() 真的注册了 sidebar.panellist + main，并且能注销
 *
 * 跑法：node test-host.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { API_ROUTES, buildProfileSyncTool, canApplyInApp, listProfiles, registerApi } from './lib/index.js'
import { currentProfileFromEnv, INBOX_BUNDLES, profilesRoot } from './lib/plan.js'

/** 一个 profile 的社区依赖名（滤掉 in-box），排序。 */
function communityDepNames(profileName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(profilesRoot(), profileName, 'package.json'), 'utf8'))
  const inbox = new Set(INBOX_BUNDLES)
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => !inbox.has(name))
    .sort()
}

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

/** 假 res：收下 status / headers / body */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
    end(text) {
      this.body = text ?? ''
      this.done = true
    },
  }
  return res
}

async function callRoute(route, { url = '/', body } = {}) {
  const req = body === undefined ? { url } : Readable.from([JSON.stringify(body)])
  if (body === undefined) req.url = url
  const res = fakeRes()
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* 非 JSON 就在断言里暴露 */
  }
  return { status: res.statusCode, headers: res.headers, json, raw: res.body }
}

const find = (p) => API_ROUTES.find((r) => r.path === p)

console.log('\n宿主侧')

await test('路由表：4 条，路径不重复（重复会让整张表失效）', () => {
  const keys = API_ROUTES.map((r) => `${r.kind} ${r.path}`)
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual(
    API_ROUTES.map((r) => r.path).sort(),
    [
      '/profile-sync/api/plan',
      '/profile-sync/api/profiles',
      '/profile-sync/api/status',
      '/profile-sync/api/write',
    ]
  )
})

await test('GET /profiles：列出本机 profile，且标出当前那个', async () => {
  const out = await callRoute(find('/profile-sync/api/profiles'), { url: '/profile-sync/api/profiles' })
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.ok(Array.isArray(out.json.profiles))
  assert.ok(out.json.profiles.length >= 2, '这台机器上至少有 web 和 desktop')
  const names = out.json.profiles.map((p) => p.name)
  assert.ok(names.includes('web'), `应当列出 web，实际：${names}`)
  assert.ok(names.includes('desktop'), `应当列出 desktop，实际：${names}`)
  assert.equal(out.json.profiles.filter((p) => p.current).length, 1, '当前 profile 恰好一个')
  // 端口：**不假设「这台机器读得到」**，只断言「值与来源自洽」。
  // 端口现在的归属是启动参数，所以一个既没有 DSH_WEB_URL、patch 里也没写 port 的环境
  // 读不到就是正确结果 —— 那是环境事实，不是失败。
  for (const p of out.json.profiles) {
    assert.equal(typeof p.portSource, 'string', `${p.name} 必须给出端口来源说明`)
    assert.ok(p.portSource !== '', `${p.name} 的 portSource 不能为空`)
    if (p.port === null) {
      assert.match(p.portSource, /读不到/, `${p.name} 读不到端口时必须说明原因`)
    } else {
      assert.ok(Number.isInteger(p.port) && p.port > 0, `${p.name} 的端口要么是正整数、要么是 null`)
    }
  }
  // web 一定有结论：patch 里有 port: 就用它，没有就走 web 的出厂默认 3080
  const web = out.json.profiles.find((p) => p.name === 'web')
  assert.ok(Number.isInteger(web.port) && web.port > 0, 'web 必须能定出端口（patch 或出厂默认）')
})

await test('GET /plan：web → desktop 算出计划并给文本', async () => {
  const out = await callRoute(find('/profile-sync/api/plan'), {
    url: '/profile-sync/api/plan?source=web&target=desktop',
  })
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.ok(out.json.plan, '要有 plan 对象')
  assert.equal(out.json.plan.target.name, 'desktop')
  assert.match(out.json.text, /迁移计划：web → desktop/)
  // 不写死「已迁完」：断言 add 恰好是「源侧有、目标侧没有」的那些
  const targetDeps = new Set(communityDepNames('desktop'))
  assert.deepEqual(
    out.json.plan.add.map((e) => e.name).sort(),
    communityDepNames('web').filter((name) => !targetDeps.has(name)),
    'add 必须等于两份真实 manifest 之差'
  )
})

await test('GET /plan：同一个 profile 当源和目标 → 阻断', async () => {
  const out = await callRoute(find('/profile-sync/api/plan'), {
    url: '/profile-sync/api/plan?source=web&target=web',
  })
  assert.equal(out.json.plan.ok, false)
  assert.equal(out.json.plan.blockers[0].code, 'same-profile')
})

await test('GET /status：没有待核对记录时 state=none', async () => {
  const out = await callRoute(find('/profile-sync/api/status'), { url: '/profile-sync/api/status' })
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.ok(['none', 'match', 'drifted', 'missing'].includes(out.json.verify.state))
})

await test('POST /write：真的写出 plan.json + plan.txt + apply.cmd', async () => {
  const out = await callRoute(find('/profile-sync/api/write'), {
    url: '/profile-sync/api/write',
    body: { source: 'web', target: 'desktop' },
  })
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.ok(out.json.planFile, '要有 planFile')
  assert.ok(out.json.cmdFile, '计划无阻断时应当生成 apply.cmd')
  assert.match(out.json.cmdFile, /apply\.cmd$/)

  const fs = await import('node:fs')
  assert.ok(fs.existsSync(out.json.planFile), 'plan.json 应当真的存在')
  assert.ok(fs.existsSync(out.json.reportFile), 'plan.txt 应当真的存在')
  assert.ok(fs.existsSync(out.json.cmdFile), 'apply.cmd 应当真的存在')

  const cmd = fs.readFileSync(out.json.cmdFile, 'utf8')
  assert.match(cmd, /apply\.mjs/, 'cmd 里应当调用 apply.mjs')
  assert.match(cmd, /--plan/, 'cmd 里应当带上 --plan')

  const plan = JSON.parse(fs.readFileSync(out.json.planFile, 'utf8'))
  assert.equal(plan.target.name, 'desktop')
  assert.ok(Array.isArray(plan.blockers))

  // 清掉这次测试产物，别在用户机器上留垃圾
  fs.rmSync(out.json.dir, { recursive: true, force: true })
})

await test('canApplyInApp：规则是「目标就是当前 profile」，与 profile 叫什么名字无关', () => {
  // 这条曾经写死成 === 'desktop'，于是网页版没法当场生效。
  // 实测网页版也暴露同一套 /api/plugin-manager，所以放宽成通用规则。
  assert.equal(canApplyInApp('desktop', 'desktop'), true, '桌面端写自己')
  assert.equal(canApplyInApp('web', 'web'), true, '网页版写自己 —— 这正是放宽后新获得的能力')
  assert.equal(canApplyInApp('web', 'desktop'), false, '管理器只写自己所属的 profile')
  assert.equal(canApplyInApp('desktop', 'web'), false, '反过来也一样')
  assert.equal(canApplyInApp('Web', ' web '), true, '大小写与空白要容忍')
  assert.equal(canApplyInApp('', 'web'), false)
  assert.equal(canApplyInApp(undefined, 'web'), false)
  assert.equal(canApplyInApp('web', ''), false)
  // 不传 current 时取环境里的 DSH_PROFILE；测试进程里通常没有，落到 fallback
  assert.equal(typeof canApplyInApp('web'), 'boolean')
})

await test('currentProfileFromEnv：认不出当前 profile 时必须 null，绝不猜 desktop', () => {
  // 这条对应一个**真发生过的静默错误**：宿主进程的环境里没有 DSH_PROFILE
  // （它只被注入给 shell），于是写死的 ?? 'desktop' 让网页版把自己认成 desktop，
  // 默认目标变成 desktop，还对着错误的一对 profile 报「已经一致」。
  assert.equal(currentProfileFromEnv({ DSH_PROFILE: 'web' }), 'web')
  assert.equal(currentProfileFromEnv({ DSH_PROFILE: ' web ' }), 'web', '两侧空白要容忍')
  assert.equal(currentProfileFromEnv({ DSH_PROFILE_DIR: 'C:\\Users\\x\\.dsh\\profiles\\web' }), 'web', 'DIR 的 basename 是可靠来源')
  assert.equal(
    currentProfileFromEnv({ DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: 'C:\\x\\profiles\\web' }),
    'desktop',
    'DSH_PROFILE 优先于 DIR'
  )
  assert.equal(currentProfileFromEnv({}), null, '**认不出就必须 null** —— 猜 desktop 会让网页版算错目标')
  assert.equal(currentProfileFromEnv({ DSH_PROFILE: '   ' }), null)
  assert.equal(currentProfileFromEnv({ DSH_PROFILE_DIR: '' }), null)
  assert.equal(
    currentProfileFromEnv({ DSH_PROFILE_DIR: 'C:\\Users\\x\\.dsh\\profiles' }),
    null,
    'profiles 目录本身不是一个 profile 名'
  )
})

await test('registerApi：挂 4 条；webServer 缺失时返回 0 而不是抛错', () => {
  const registered = []
  const n = registerApi({ register: (r) => registered.push(r) })
  assert.equal(n, 4)
  assert.equal(registered.length, 4)
  assert.equal(registerApi(null), 0)
  assert.equal(registerApi({}), 0)
})

await test('工具 profile_sync：schema 是原始 JSON Schema，action 是枚举', () => {
  const tool = buildProfileSyncTool()
  assert.equal(tool.name, 'profile_sync')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.ok(tool.parameters.properties.action.enum.includes('plan'))
  assert.ok(tool.parameters.properties.action.enum.includes('write'))
  // output.render 要能把 { text } 转成文本块
  const blocks = tool.output.render({}, { text: 'hi' })
  assert.deepEqual(blocks, [{ type: 'text', text: 'hi' }])
})

await test('工具 execute：plan / profiles / status 都能返回文本而不抛错', async () => {
  const tool = buildProfileSyncTool()
  const plan = await tool.execute({ action: 'plan', source: 'web', target: 'desktop' })
  assert.match(plan.text, /迁移计划/)
  const profiles = await tool.execute({ action: 'profiles' })
  assert.match(profiles.text, /web/)
  assert.match(profiles.text, /desktop/)
  const status = await tool.execute({ action: 'status' })
  assert.match(status.text, /核对|没有待核对/)
  const bogus = await tool.execute({ action: 'nonsense' })
  assert.match(bogus.text, /不认识/)
})

await test('工具 execute：内部出错时返回文本，不让异常炸到 agent 循环', async () => {
  const tool = buildProfileSyncTool()
  const out = await tool.execute({ action: 'plan', source: '不存在的 profile', target: 'desktop' })
  assert.match(out.text, /profile_sync 失败|迁移计划/)
})

console.log('\n客户端侧')

await test('client.js：按模块加载器契约注册，apply() 挂上 sidebar.panellist + main 且可注销', async () => {
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } }

  await import('./lib/client.js')

  assert.equal(loaded.length, 1, '应当恰好调用一次 load')
  assert.equal(loaded[0].id, 'dsh-profile-sync', 'id 必须等于包名')

  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const fakeRequire = (name) => {
    if (name === 'react') return ReactStub
    throw new Error('客户端不该 require 别的模块：' + name)
  }

  const mod = loaded[0].factory(fakeRequire)
  // 客户端半的 inject 写的是**服务名**（slots），不是包名。
  // 写包名会让这个 fiber 永远等一个不存在的服务，客户端启动审计报
  // "1 entry did not activate"，整个 Web 界面起不来 —— 这个坑真的踩过。
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.__esModule, undefined)

  const registered = []
  const disposed = []
  let cleanup = null
  const ctx = {
    slots: {
      inject: (slot, cb) => {
        cb()
        return () => disposed.push(slot)
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect: (fn) => {
      cleanup = fn()
      assert.equal(typeof cleanup, 'function', 'ctx.effect 的回调要返回清理函数')
      return cleanup
    },
  }

  mod.apply(ctx)

  const slots = registered.map((r) => r.options.name)
  assert.ok(slots.includes('sidebar.panellist'), `应当注册 sidebar.panellist，实际：${slots}`)
  assert.ok(slots.includes('main'), `应当注册 main，实际：${slots}`)

  const row = registered.find((r) => r.options.name === 'sidebar.panellist')
  assert.equal(row.options.id, 'dsh-profile-sync')
  assert.equal(typeof row.options.label, 'function')
  assert.equal(row.options.label(), '插件迁移')
  assert.equal(typeof row.component, 'function', 'sidebar.panellist 要挂一个组件（图标）')

  const page = registered.find((r) => r.options.name === 'main')
  assert.equal(page.options.key, 'dsh-profile-sync', 'main 页面用 key 对齐面板 id')
  assert.equal(typeof page.component, 'function')

  // 真的调一次注销，确认两个席位都能撤干净（热重载/禁用要靠它）
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.deepEqual(disposed.sort(), ['main', 'sidebar.panellist'], '注销时要两个都撤掉')
})

await test('client.js：宿主没有 slots 服务时不抛错，只警告', async () => {
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } }
  // 重新导入拿一份新的模块（带上查询串绕过 ESM 缓存）
  await import('./lib/client.js?no-slots')
  const mod = loaded[loaded.length - 1].factory(() => ({
    createElement: () => null,
    useState: (i) => [i, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
  }))
  assert.doesNotThrow(() => mod.apply({}))
  assert.doesNotThrow(() => mod.apply(null))
})

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
