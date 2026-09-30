/**
 * dsh-profile-sync 本地测试。
 *
 * 三种测试，都不启动 DSH、不占端口、不跑 pnpm：
 *   A. 纯函数单测（allowBuilds 合并、patch 解析、spec 分类、版本核心）
 *   B. 合成 fixture：跨 profile 计划 + entry id 撞车必须报阻断
 *   C. 真实 profile：对这台机器上真实的 web → desktop 算一遍计划并打印
 *
 * 跑法：node test-plan.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

import {
  advisoryEngineCheck,
  computePlan,
  INBOX_BUNDLES,
  localSpecPath,
  mergeAllowBuildsText,
  parseAllowBuilds,
  parsePatchInsertedIds,
  profilesRoot,
  registryVersionCore,
  renderPlanText,
  specKind,
  specsToInstall,
  summarizePatch,
} from './lib/plan.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
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

/** 造一个假 profile：manifest + 若干 bundle 包 */
function makeProfile(root, manifest, bundles = {}) {
  write(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const [name, spec] of Object.entries(bundles)) {
    const pkgDir = path.join(root, 'node_modules', name)
    // 关键契约：patch 必须在 manifest 里**声明** dsh.bundle.patch 才会成为加载层。
    // 只放一个 cordis.patch.yml 文件而没声明，dsh 根本不会把它当 bundle 用。
    const pkgManifest = spec.patch
      ? { ...spec.manifest, dsh: { bundle: { patch: './' + spec.patch.file } } }
      : spec.manifest
    write(path.join(pkgDir, 'package.json'), JSON.stringify(pkgManifest, null, 2) + '\n')
    write(path.join(pkgDir, 'index.js'), 'export function apply() {}\n')
    if (spec.patch) write(path.join(pkgDir, spec.patch.file), spec.patch.text)
  }
  return root
}

// ─────────────────────────── A. 纯函数 ───────────────────────────
console.log('\nA. 纯函数')

test('mergeAllowBuildsText：新键会加、已有的不动、幂等', () => {
  const yaml = 'packages:\n  - .\n\nallowBuilds:\n  node-pty: true\n'
  const once = mergeAllowBuildsText(yaml, ['node-pty', 'ssh2'])
  assert.deepEqual(once.added, ['ssh2'])
  assert.match(once.text, /ssh2: true/)
  assert.match(once.text, /node-pty: true/)
  assert.equal((once.text.match(/allowBuilds:/g) || []).length, 1)
  const twice = mergeAllowBuildsText(once.text, ['node-pty', 'ssh2'])
  assert.deepEqual(twice.added, [])
  assert.equal(twice.text, once.text)
})

test('mergeAllowBuildsText：作用域包名会加引号（@ 是 YAML 保留指示符）', () => {
  const out = mergeAllowBuildsText('', ['@scope/pkg'])
  assert.match(out.text, /'@scope\/pkg': true/)
})

test('mergeAllowBuildsText：CRLF 文件能匹配到已有块，不会追加第二个块', () => {
  const yaml = 'allowBuilds:\r\n  node-pty: true\r\n'
  const out = mergeAllowBuildsText(yaml, ['cloudflared'])
  assert.equal((out.text.match(/allowBuilds:/g) || []).length, 1)
  assert.match(out.text, /\r\n/)
})

test('mergeAllowBuildsText：已经坏成两个块的会被合并成一个（顺带修复）', () => {
  const yaml = 'allowBuilds:\n  a: true\nallowBuilds:\n  b: true\n'
  const out = mergeAllowBuildsText(yaml, ['c'])
  assert.equal((out.text.match(/allowBuilds:/g) || []).length, 1)
  const map = parseAllowBuilds(out.text)
  assert.deepEqual(Object.keys(map).sort(), ['a', 'b', 'c'])
})

test('mergeAllowBuildsText：新增的键沿用源侧的值，不能一律写 true', () => {
  // 源侧显式写 false 是「有意关掉这个原生构建」，
  // 一律写 true 会在目标侧把它打开 —— 语义反转且不报错。
  const out = mergeAllowBuildsText('', ['node-pty', 'cloudflared'], {
    'node-pty': 'false',
    cloudflared: 'true',
  })
  const map = parseAllowBuilds(out.text)
  assert.equal(map['node-pty'], 'false', '源侧 false 必须原样带过去')
  assert.equal(map.cloudflared, 'true')
  // 不给 values 时仍退回 true（向后兼容）
  const fallback = parseAllowBuilds(mergeAllowBuildsText('', ['x']).text)
  assert.equal(fallback.x, 'true')
})

test('parsePatchInsertedIds：只认 insert 块里的 id，别人的配置行不算（#147）', () => {
  const text = [
    '# 注释要忽略',
    '- insert:',
    '    - id: vision-router',
    "      name: dsh-vision-router",
    '- id: attachment-local',
    '  config:',
    '    maxImageBytes: 1',
    '',
  ].join('\n')
  assert.deepEqual(parsePatchInsertedIds(text), ['vision-router'])
})

test('parsePatchInsertedIds：insert 块在顶层 id 行处正确收尾', () => {
  const text = '- insert:\n    - id: a\n- id: b\n'
  assert.deepEqual(parsePatchInsertedIds(text), ['a'])
})

test('specKind / localSpecPath', () => {
  assert.equal(specKind('^0.4.4'), 'registry')
  assert.equal(specKind('link:D:/dsh/plugins/dsh-novel-plugin'), 'link')
  assert.equal(specKind('file:D:/tools/x.tar.gz'), 'file')
  assert.equal(specKind('github:o/r'), 'git')
  assert.equal(localSpecPath('link:D:/dsh/plugins/x'), 'D:/dsh/plugins/x')
  assert.equal(localSpecPath('file:D:/tools/x.tar.gz'), 'D:/tools/x.tar.gz')
  assert.equal(localSpecPath('^1.0.0'), null)
})

test('registryVersionCore：范围与精确号的核心一致', () => {
  assert.equal(registryVersionCore('^0.11.3'), '0.11.3')
  assert.equal(registryVersionCore('0.11.3'), '0.11.3')
  assert.equal(registryVersionCore('@changfenhuang/dsh-genui@^0.11.3'), '0.11.3')
  assert.equal(registryVersionCore('@changfenhuang/dsh-genui'), null)
  assert.equal(registryVersionCore('link:D:/x'), null)
  assert.equal(
    registryVersionCore('@linxin666/dsh-web-all@^0.4.4'),
    registryVersionCore('@linxin666/dsh-web-all@0.4.4')
  )
})

test('advisoryEngineCheck：认得的形态给判断，认不得的说不认识', () => {
  assert.equal(advisoryEngineCheck('>=0.2.0-rc.1', '0.2.0-rc.2'), 'ok')
  assert.equal(advisoryEngineCheck('>=0.2.0-rc.3', '0.2.0-rc.2'), 'violated')
  assert.equal(advisoryEngineCheck('^1.2.0', '1.5.0'), 'ok')
  assert.equal(advisoryEngineCheck('^1.2.0', '2.0.0'), 'violated')
  assert.equal(advisoryEngineCheck('>=1.0.0 || <0.5.0', '0.2.0'), 'unknown')
  assert.equal(advisoryEngineCheck(null, '0.2.0'), 'no-range')
})

test('summarizePatch：抽出 id / disabled / config 键', () => {
  const rows = summarizePatch(
    ['- id: ui-theme', '  name: x', '  config:', '    preference: dark', '- id: dsh-market', '  disabled: true', ''].join('\n')
  )
  assert.deepEqual(rows.map((r) => r.id), ['ui-theme', 'dsh-market'])
  assert.deepEqual(rows[0].configKeys, ['preference'])
  assert.equal(rows[1].disabled, true)
})

test('specsToInstall：registry 拼 name@range；link/file 原样给（不能加 name@）', () => {
  const plan = {
    add: [
      { name: 'a', spec: '^1.0.0', kind: 'registry' },
      { name: 'dsh-novel', spec: 'link:D:/p', kind: 'link' },
    ],
    change: [{ name: 'b', spec: 'file:D:/t.tgz', kind: 'file' }],
  }
  assert.deepEqual(specsToInstall(plan), ['a@^1.0.0', 'link:D:/p', 'file:D:/t.tgz'])
})

// ─────────────────────── B. 合成 fixture 计划 ───────────────────────
console.log('\nB. 合成 fixture')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-sync-test-'))

test('跨 profile：能算出新增依赖 / 新增 bundle / allowBuilds 缺口', () => {
  const src = path.join(tmp, 'b-src')
  const tgt = path.join(tmp, 'b-tgt')
  makeProfile(
    src,
    {
      name: 'p-src',
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0', 'plug-a': '^1.0.0', 'plug-b': '^2.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'plug-a', 'plug-b'] } },
    },
    {
      'plug-a': { manifest: { name: 'plug-a', version: '1.0.0', main: 'index.js' }, patch: { file: 'cordis.patch.yml', text: '- insert:\n    - id: plug-a\n' } },
      'plug-b': { manifest: { name: 'plug-b', version: '2.0.0', main: 'index.js' } },
    }
  )
  write(path.join(src, 'pnpm-workspace.yaml'), 'allowBuilds:\n  node-pty: true\n')
  makeProfile(
    tgt,
    {
      name: 'p-tgt',
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }
  )
  const plan = computePlan({ source: src, target: tgt })
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers))
  assert.deepEqual(plan.add.map((e) => e.name), ['plug-a', 'plug-b'])
  assert.deepEqual(plan.bundles.add, ['plug-a', 'plug-b'])
  assert.deepEqual(plan.allowBuilds.add, ['node-pty'])
  // plug-b 没有声明 dsh.bundle 却进了 bundles 列表 → 必须给提醒
  assert.ok(plan.warnings.some((w) => w.code === 'no-bundle-declaration' && w.package === 'plug-b'))
})

test('entry id 撞车：必须报阻断（cordis 会拒绝启动整棵树）', () => {
  const src = path.join(tmp, 'c-src')
  const tgt = path.join(tmp, 'c-tgt')
  makeProfile(
    src,
    {
      name: 'p-src',
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0', 'has-storage': '1.0.0', 'also-storage': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'has-storage', 'also-storage'] } },
    },
    {
      'has-storage': { manifest: { name: 'has-storage', version: '1.0.0', main: 'index.js' }, patch: { file: 'cordis.patch.yml', text: '- insert:\n    - id: storage\n' } },
      'also-storage': { manifest: { name: 'also-storage', version: '1.0.0', main: 'index.js' }, patch: { file: 'cordis.patch.yml', text: '- insert:\n    - id: storage\n' } },
    }
  )
  makeProfile(
    tgt,
    {
      name: 'p-tgt',
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0', 'has-storage': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'has-storage'] } },
    },
    {
      'has-storage': { manifest: { name: 'has-storage', version: '1.0.0', main: 'index.js' }, patch: { file: 'cordis.patch.yml', text: '- insert:\n    - id: storage\n' } },
    }
  )
  const plan = computePlan({ source: src, target: tgt })
  assert.equal(plan.ok, false)
  const hit = plan.blockers.find((b) => b.code === 'entry-id-collision')
  assert.ok(hit, JSON.stringify(plan.blockers))
  assert.equal(hit.entryId, 'storage')
  assert.equal(hit.candidate, 'also-storage')
  assert.equal(hit.conflictWith, 'has-storage')
})

test('本机路径不存在：必须报阻断', () => {
  const src = path.join(tmp, 'd-src')
  const tgt = path.join(tmp, 'd-tgt')
  makeProfile(src, {
    name: 'p-src',
    dependencies: { 'gone-plugin': 'link:D:/definitely/not/here/xyz' },
    dsh: { profile: { bundles: [] } },
  })
  makeProfile(tgt, { name: 'p-tgt', dependencies: {}, dsh: { profile: { bundles: [] } } })
  const plan = computePlan({ source: src, target: tgt })
  assert.equal(plan.ok, false)
  assert.ok(plan.blockers.some((b) => b.code === 'spec-path-missing'))
})

test('钉法不同（^1.0.0 vs 1.0.0）归到 repin，不算变更', () => {
  const src = path.join(tmp, 'e-src')
  const tgt = path.join(tmp, 'e-tgt')
  makeProfile(src, { name: 's', dependencies: { p: '^1.0.0' }, dsh: { profile: { bundles: [] } } })
  makeProfile(tgt, { name: 't', dependencies: { p: '1.0.0' }, dsh: { profile: { bundles: [] } } })
  const plan = computePlan({ source: src, target: tgt })
  assert.equal(plan.change.length, 0)
  assert.equal(plan.repin.length, 1)
  assert.equal(plan.repin[0].name, 'p')
  assert.deepEqual(specsToInstall(plan), [])
})

test('源和目标同一个 profile → 拒绝', () => {
  const plan = computePlan({ source: tmp, target: tmp })
  assert.equal(plan.ok, false)
  assert.equal(plan.blockers[0].code, 'same-profile')
})

test('没有可加载入口的包 → 阻断（否则提升进 bundle 层会炸整个 profile）', () => {
  const src = path.join(tmp, 'f-src')
  const tgt = path.join(tmp, 'f-tgt')
  const pkgDir = path.join(src, 'node_modules', 'src-only')
  write(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'src-only', version: '1.0.0', main: 'lib/index.js' }))
  makeProfile(src, {
    name: 's',
    dependencies: { 'src-only': '1.0.0' },
    dsh: { profile: { bundles: ['src-only'] } },
  })
  makeProfile(tgt, { name: 't', dependencies: {}, dsh: { profile: { bundles: [] } } })
  const plan = computePlan({ source: src, target: tgt })
  assert.equal(plan.ok, false)
  assert.ok(plan.blockers.some((b) => b.code === 'no-loadable-entry' && b.package === 'src-only'))
})

// ─────────────────────── C. 真实 profile ───────────────────────
console.log('\nC. 真实 profile（这台机器上的 web → desktop）')

/** 一个 profile 的社区依赖名（滤掉 in-box），排序。 */
function communityDepNames(profileName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(profilesRoot(), profileName, 'package.json'), 'utf8'))
  const inbox = new Set(INBOX_BUNDLES)
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => !inbox.has(name))
    .sort()
}

test('对真实 web/desktop 算一遍计划并打印（断言与真实 manifest 一致，不依赖「已迁完」）', () => {
  const plan = computePlan({ source: 'web', target: 'desktop' })
  console.log('\n' + renderPlanText(plan).split('\n').map((l) => '      ' + l).join('\n') + '\n')

  // 关键：断言的是**不变量**，不是「这台机器已经迁完」。
  // 早先这里写死 `plan.add.length === 0`，在一台还没迁的机器上必然红 ——
  // 而那种红会诱使人把断言改成通过，于是丢掉「计划必须等于两份真实 manifest 之差」
  // 这个真正该守的性质。另一套安装上跑测试时正是这么红的（新增 3）。
  const sourceDeps = communityDepNames('web')
  const targetDeps = new Set(communityDepNames('desktop'))

  assert.deepEqual(
    plan.add.map((e) => e.name).sort(),
    sourceDeps.filter((name) => !targetDeps.has(name)),
    'add 必须恰好是「源侧有、目标侧没有」的那些'
  )

  // 每个源侧社区依赖恰好落进一个桶：add / change / repin / same，不重不漏
  const buckets = [
    ...plan.add.map((e) => e.name),
    ...plan.change.map((e) => e.name),
    ...plan.repin.map((e) => e.name),
    ...plan.same.map((e) => e.name),
  ]
  assert.equal(buckets.length, new Set(buckets).size, '一个依赖不能同时落进两个桶')
  assert.deepEqual([...new Set(buckets)].sort(), sourceDeps, '源侧每个社区依赖都要有归宿')

  // ok 与 blockers 自洽
  assert.equal(plan.ok, plan.blockers.length === 0)
})

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n通过 ${passed} / 失败 ${failed}`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
