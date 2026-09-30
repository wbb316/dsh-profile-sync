/**
 * dsh-profile-sync 装前自检测试。
 *
 * 这些用例针对的是**最坏的失败模式**：bundle 被写进 dsh.profile.bundles
 * 却加载不起来 → profile 组装失败 → 桌面端连窗口都打不开。
 * 所以自检必须能挡住「清单不一致」和「加载不起来」这两类。
 *
 * 跑法：node test-manifest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  checkHostModuleLoads,
  checkPluginPackage,
  parseClientContract,
  parseInsertRows,
  selfCheck,
} from './lib/manifest-check.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ps-manifest-'))

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

/**
 * 造一个合成插件包。默认是**完全合法**的，用 overrides 逐项弄坏。
 */
function makePlugin(name, overrides = {}) {
  const dir = path.join(tmpRoot, name)
  const pkgName = overrides.packageName ?? name
  const loaderId = overrides.loaderId ?? pkgName
  const injectPackage = overrides.injectPackage ?? '@deepseek-ai/dsh-client-ui-slots'
  // 默认值必须用**服务名**：客户端半的 inject 是服务名，不是包名。
  // 用包名当默认值会让每个夹具都被自检判成坏的（我就是这么发现这条检查有用的）。
  const injectCode = overrides.injectCode ?? 'slots'
  const patchName = overrides.patchName ?? pkgName
  const mainRel = overrides.mainRel ?? 'lib/index.js'

  write(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: pkgName,
        version: '1.0.0',
        type: 'module',
        main: mainRel,
        exports: { '.': './' + mainRel, './client': './lib/client.js', './package.json': './package.json' },
        ...(overrides.noPatchDecl === true ? {} : { dsh: undefined }),
        dsh: overrides.noPatchDecl === true
          ? undefined
          : {
              engines: { dsh: '>=0.2.0-rc.1' },
              bundle: { patch: './cordis.patch.yml' },
              client: { platform: 'web', inject: [injectPackage] },
            },
      },
      null,
      2
    ) + '\n'
  )
  if (overrides.noMainFile !== true) {
    write(
      path.join(dir, mainRel),
      overrides.brokenMain === true
        ? "import './definitely-missing.js'\nexport function apply() {}\n"
        : 'export function apply() {}\nexport const inject = ["tools"]\n'
    )
  }
  if (overrides.noPatchDecl !== true) {
    write(path.join(dir, 'cordis.patch.yml'), overrides.patchText ?? `- insert:\n    - id: ${patchName}\n      name: '${patchName}'\n`)
  }
  write(
    path.join(dir, 'lib/client.js'),
    `window.__ModuleLoader__.load({\n  id: '${loaderId}',\n  factory(require) {\n` +
      `    const inject = [${injectCode === null ? '' : `'${injectCode}'`}]\n` +
      `    return { apply() {}, inject }\n  },\n})\n`
  )
  return dir
}

console.log('\n纯解析')

await test('parseInsertRows：取 insert 块里的 id/name，别人的配置行不算', () => {
  const rows = parseInsertRows(
    ['# 注释', '- insert:', '    - id: a', "      name: 'pkg-a'", '    - id: b', '      name: pkg-b', '- id: other', '  config:', '    x: 1', ''].join('\n')
  )
  assert.deepEqual(rows, [
    { id: 'a', name: 'pkg-a' },
    { id: 'b', name: 'pkg-b' },
  ])
})

await test('parseClientContract：对真实 client.js 取到正确的 id 与 inject', () => {
  const text = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
  const c = parseClientContract(text)
  assert.equal(c.loaderCall, true)
  assert.equal(c.loaderId, 'dsh-profile-sync', '必须取到 load({ id }) 里的那个 id')
  assert.deepEqual(c.inject, ['slots'], '客户端半的 inject 必须是服务名（slots），不是包名')
})

console.log('\n对真实插件的自检（这就是装之前会跑的那一步）')

await test('checkPluginPackage：真实插件包清单一致', () => {
  const r = checkPluginPackage(here)
  assert.deepEqual(r.errors, [], `不该有错误：${JSON.stringify(r.errors)}`)
  assert.equal(r.ok, true)
  assert.equal(r.facts.name, 'dsh-profile-sync')
  assert.equal(r.facts.client.loaderId, 'dsh-profile-sync')
  assert.deepEqual(r.facts.insertRows, [{ id: 'dsh-profile-sync', name: 'dsh-profile-sync' }])
  assert.equal(r.facts.engines, '>=0.2.0-rc.1')
})

await test('selfCheck：真实插件包宿主半与客户端半都真的加载得起来', async () => {
  const r = await selfCheck(here)
  assert.equal(r.ok, true, `自检必须通过：${JSON.stringify(r.errors)}`)
  assert.ok(r.facts.hostExports.includes('apply'))
  assert.equal(r.facts.clientId, 'dsh-profile-sync')
})

await test('checkHostModuleLoads：真实插件导出 apply 函数', async () => {
  const r = await checkHostModuleLoads(here)
  assert.equal(r.ok, true, r.error)
  assert.ok(r.exports.includes('apply'))
})

console.log('\n坏包必须被挡住')

await test('客户端 loader id 与包名不一致 → 拦下', () => {
  const dir = makePlugin('bad-id', { loaderId: 'some-other-name' })
  const r = checkPluginPackage(dir)
  assert.equal(r.ok, false)
  assert.ok(
    r.errors.some((e) => /loader 的 id/.test(e)),
    `应当报 loader id 不一致：${JSON.stringify(r.errors)}`
  )
})

await test('patch 里的挂载名与包名不一致 → 拦下（装上了也不会加载）', () => {
  const dir = makePlugin('bad-patchname', { patchName: 'totally-different' })
  const r = checkPluginPackage(dir)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /patch 的 insert 行里没有 name/.test(e)), JSON.stringify(r.errors))
})

await test('没声明 dsh.bundle.patch → 拦下', () => {
  const dir = makePlugin('no-patch-decl', { noPatchDecl: true })
  const r = checkPluginPackage(dir)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /没有声明 dsh\.bundle\.patch/.test(e)), JSON.stringify(r.errors))
})

await test('客户端 inject 写成包名 → 拦下（这就是把桌面端搞崩的那个坑）', () => {
  const dir = makePlugin('inject-is-package', {
    injectPackage: '@deepseek-ai/dsh-client-ui-slots',
    injectCode: '@deepseek-ai/dsh-client-ui-slots',
  })
  const r = checkPluginPackage(dir)
  assert.equal(r.ok, false, '把包名写进服务名的位置必须被拦下')
  assert.ok(r.errors.some((e) => /像包名的东西/.test(e)), JSON.stringify(r.errors))
  assert.ok(r.errors.some((e) => /did not activate/.test(e)), '错误信息要写明后果，方便下次一眼认出来')
})

await test('客户端 inject 用服务名则通过；缺 slots 只警告', () => {
  const good = checkPluginPackage(makePlugin('inject-good', { injectCode: 'slots' }))
  assert.equal(good.ok, true, JSON.stringify(good.errors))
  const noSlots = checkPluginPackage(makePlugin('inject-noslots', { injectCode: 'theme' }))
  assert.equal(noSlots.ok, true, JSON.stringify(noSlots.errors))
  assert.ok(noSlots.warnings.some((w) => /没有 'slots'/.test(w)), JSON.stringify(noSlots.warnings))
})

await test('声明的入口文件不存在 → 拦下', () => {
  const dir = makePlugin('no-main', { noMainFile: true })
  const r = checkPluginPackage(dir)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /入口不存在/.test(e)), JSON.stringify(r.errors))
})

await test('宿主半 import 一个不存在的模块 → 真加载能抓出来（--check 抓不到这种）', async () => {
  const dir = makePlugin('broken-main', { brokenMain: true })
  const r = await checkHostModuleLoads(dir)
  assert.equal(r.ok, false)
  assert.match(String(r.error), /import .* 失败/)
})

await test('没有 apply 导出 → 真加载能抓出来', async () => {
  const dir = makePlugin('no-apply')
  write(path.join(dir, 'lib/index.js'), 'export const notApply = 1\n')
  const r = await checkHostModuleLoads(dir)
  assert.equal(r.ok, false)
  assert.match(String(r.error), /没有导出 apply/)
})

await test('引擎范围缺失只警告、不拦（官方通道才是权威）', () => {
  const dir = makePlugin('no-engines')
  const manifestFile = path.join(dir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  delete manifest.dsh.engines
  write(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  const r = checkPluginPackage(dir)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.ok(r.warnings.some((w) => /engines/.test(w)), JSON.stringify(r.warnings))
})

// ─────────────────────────── 清理 ───────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true })

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
