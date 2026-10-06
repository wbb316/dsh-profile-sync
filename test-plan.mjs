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
  filterPlan,
  INBOX_BUNDLES,
  localSpecPath,
  mergeAllowBuildsText,
  parseAllowBuilds,
  parsePatchInsertedIds,
  profilesRoot,
  registryVersionCore,
  renderPlanText,
  selectablePlugins,
  specKind,
  specsToInstall,
  summarizePatch,
  tarballUrlHint,
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

// ── 选择：只迁移勾选的那几个插件 ──
// 手写计划而不是走 fixture：这里要卡的正是「哪些字段被筛、哪些必须留下」的分界，
// 用合成 profile 反而会掺进 computePlan 的行为。
const samplePlan = {
  add: [
    { name: 'plug-a', spec: '^1.0.0', kind: 'registry' },
    { name: 'plug-b', spec: 'link:D:/p', kind: 'link' },
  ],
  change: [{ name: 'plug-c', spec: '^2.0.0', fromSpec: '^1.0.0', kind: 'registry' }],
  repin: [{ name: 'plug-d', spec: '1.0.0', fromSpec: '^1.0.0' }],
  bundles: { add: ['plug-a', 'plug-b'], same: ['@deepseek-ai/dsh-base'], extraInTarget: [] },
  allowBuilds: {
    add: ['node-pty', 'plug-a'],
    addValues: { 'node-pty': false, 'plug-a': true },
    same: [],
    valueMismatch: [],
  },
  engineAdvisory: [{ package: 'plug-a', range: '^1' }],
  blockers: [
    { code: 'spec-path-missing', message: 'plug-b 的路径没了', package: 'plug-b' },
    { code: 'entry-id-collision', message: '撞车', candidate: 'plug-a', entryId: 'x' },
    { code: 'target-missing', message: '目标不可读' },
  ],
  warnings: [
    { code: 'engine-advisory', message: 'plug-a 引擎不符', package: 'plug-a' },
    { code: 'no-bundle-declaration', message: 'plug-b 没声明', package: 'plug-b' },
    { code: 'compatibility-exemption', message: '全局提醒' },
  ],
  same: [],
  extraInTarget: [],
  notes: [],
  configDiff: [],
  prune: false,
  source: { name: 'web', dir: 'W' },
  target: { name: 'desktop', dir: 'D' },
  runtimeVersion: null,
  ok: false,
}

test('选择：不传 only 时计划原样返回（旧调用方行为一字不变）', () => {
  assert.equal(filterPlan(samplePlan, undefined), samplePlan)
  assert.equal(filterPlan(samplePlan, null), samplePlan)
})

test('选择：可勾选单元 = add/change/repin + bundle + allowBuilds 键，按包名去重', () => {
  const rows = selectablePlugins(samplePlan)
  assert.deepEqual(rows.map((r) => r.name), ['plug-a', 'plug-b', 'plug-c', 'plug-d', 'node-pty'])
  // 同一个包的多重动作必须合到一行 —— 否则面板上会出现两个 plug-a
  assert.deepEqual(rows.find((r) => r.name === 'plug-a').actions, ['add', 'bundle', 'allowBuilds'])
  // 依赖已在目标端、只是缺授权的包也要能单独勾（node-pty 不在任何 add/change 里）
  assert.deepEqual(rows.find((r) => r.name === 'node-pty').actions, ['allowBuilds'])
})

test('选择：只留勾中的依赖 / bundle / allowBuilds，且 addValues 一起裁', () => {
  const sub = filterPlan(samplePlan, ['plug-a'])
  assert.deepEqual(sub.add.map((e) => e.name), ['plug-a'])
  assert.deepEqual(sub.change, [])
  assert.deepEqual(sub.repin, [])
  assert.deepEqual(sub.bundles.add, ['plug-a'])
  assert.deepEqual(sub.allowBuilds.add, ['plug-a'])
  assert.deepEqual(sub.allowBuilds.addValues, { 'plug-a': true })
  assert.ok(!('node-pty' in sub.allowBuilds.addValues), '没勾的键不能留在 addValues 里')
})

test('选择：不相关插件的阻断项被筛掉，全局阻断项留下', () => {
  const sub = filterPlan(samplePlan, ['plug-a'])
  assert.deepEqual(sub.blockers.map((b) => b.code), ['entry-id-collision', 'target-missing'])
  assert.equal(sub.ok, false, '全局阻断项还在 → 整体仍不可应用')
})

test('选择：勾掉带阻断的插件后 ok 重算为 true', () => {
  const p = { ...samplePlan, blockers: [{ code: 'spec-path-missing', message: 'plug-b 没了', package: 'plug-b' }] }
  assert.equal(filterPlan(p, ['plug-a']).ok, true)
  assert.equal(filterPlan(p, ['plug-a', 'plug-b']).ok, false)
})

test('选择：不相关的提醒也被筛掉，全局提醒留下', () => {
  const sub = filterPlan(samplePlan, ['plug-a'])
  assert.deepEqual(sub.warnings.map((w) => w.code), ['engine-advisory', 'compatibility-exemption'])
  assert.deepEqual(sub.engineAdvisory, [{ package: 'plug-a', range: '^1' }])
})

test('选择：空数组合法 —— 筛出空计划，但全局阻断项仍留下（调用方必须自己拦空选择）', () => {
  const sub = filterPlan(samplePlan, [])
  assert.deepEqual(sub.add, [])
  assert.deepEqual(sub.change, [])
  assert.deepEqual(sub.repin, [])
  assert.deepEqual(sub.bundles.add, [])
  assert.deepEqual(sub.allowBuilds.add, [])
  assert.deepEqual(sub.allowBuilds.addValues, {})
  // 没有归属信息的阻断项说的不是某个插件，而是这次迁移整体 → 不参与筛选
  assert.deepEqual(sub.blockers.map((b) => b.code), ['target-missing'])
  assert.equal(sub.selection.all, false)
  assert.equal(sub.selection.total, 5)
  // 危险的那种情况：计划本身健康 + 一个都没勾 → ok 为 true、却什么都没得做。
  // 光看 ok 分不出它和「已经一致」，所以路由层必须有显式的空选择守卫。
  const healthy = { ...samplePlan, blockers: [], warnings: [] }
  assert.equal(filterPlan(healthy, []).ok, true)
})

test('选择：全勾 == 不做选择（内容相同，只多记了 selection）', () => {
  const all = selectablePlugins(samplePlan).map((r) => r.name)
  const sub = filterPlan(samplePlan, all)
  assert.deepEqual(sub.add, samplePlan.add)
  assert.deepEqual(sub.bundles.add, samplePlan.bundles.add)
  assert.deepEqual(sub.allowBuilds.add, samplePlan.allowBuilds.add)
  assert.deepEqual(sub.blockers, samplePlan.blockers)
  assert.equal(sub.selection.all, true)
})

test('选择：报告写明迁移范围（plan.json / apply.cmd 事后可追溯）', () => {
  const one = renderPlanText(filterPlan(samplePlan, ['plug-a']))
  assert.ok(one.includes('迁移范围：勾选的 1/5 个'), one)
  assert.ok(one.includes('plug-a'), one)
  const all = renderPlanText(filterPlan(samplePlan, selectablePlugins(samplePlan).map((r) => r.name)))
  assert.ok(all.includes('迁移范围：全部 5 个'), all)
  assert.ok(!renderPlanText(samplePlan).includes('迁移范围'), '不做选择时报告不该多出这一行')
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

test('tarballUrlHint：github 短形态 → 可直接粘贴的 tarball URL（不经过 git）', () => {
  assert.equal(
    tarballUrlHint('github:wbb316/dsh-novel', '0.13.0'),
    'https://github.com/wbb316/dsh-novel/archive/refs/tags/v0.13.0.tar.gz',
  )
  // 完整 https 形态、带 .git 后缀、带 git+ 前缀都要认
  assert.equal(
    tarballUrlHint('git+https://github.com/o/r.git', null),
    'https://github.com/o/r/archive/refs/tags/<tag>.tar.gz',
  )
  // spec 自己写了 ref 就用它，别拿版本号去猜
  assert.equal(
    tarballUrlHint('github:o/r#v1.2.3', '9.9.9'),
    'https://github.com/o/r/archive/refs/tags/v1.2.3.tar.gz',
  )
  // `#semver:` 不是 tag —— 塞进 archive 路径会给出**错的** URL，所以退回版本号
  assert.equal(
    tarballUrlHint('github:o/r#semver:^1.0.0', '1.4.0'),
    'https://github.com/o/r/archive/refs/tags/v1.4.0.tar.gz',
  )
  // 认不出来就不猜：GitLab / ssh / registry 一律 null（硬猜等于给出一条错的 URL）
  assert.equal(tarballUrlHint('gitlab:o/r', '1.0.0'), null)
  assert.equal(tarballUrlHint('git+ssh://git@github.com/o/r.git', '1.0.0'), null)
  assert.equal(tarballUrlHint('^1.0.0', '1.0.0'), null)
})

test('git 源：必须给提醒、但绝不能阻断（它没有任何本地预检可做）', () => {
  const src = path.join(tmp, 'g-src')
  const tgt = path.join(tmp, 'g-tgt')
  makeProfile(src, {
    name: 'p-src',
    dependencies: { 'git-only': 'github:wbb316/dsh-novel', 'from-registry': '^1.0.0' },
    dsh: { profile: { bundles: [] } },
  })
  makeProfile(tgt, { name: 'p-tgt', dependencies: {}, dsh: { profile: { bundles: [] } } })
  // 源侧装出来了、版本可读 —— 提醒里的 tag 就应该被填好，而不是留占位符
  const pkgDir = path.join(src, 'node_modules', 'git-only')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'git-only', version: '7.7.7', main: 'index.js' }),
    'utf8',
  )
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export default {}\n', 'utf8')

  const plan = computePlan({ source: src, target: tgt })
  // 不阻断：目标机的网络状况没法在计划阶段判定，判死会把本来能装的情况误拦
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers))
  const hits = plan.warnings.filter((w) => w.code === 'git-source-needs-network')
  assert.equal(hits.length, 1, '只该给 git 源那一个发提醒：' + JSON.stringify(plan.warnings))
  assert.equal(hits[0].package, 'git-only')
  assert.match(hits[0].message, /ERR_PNPM_GIT_RESOLVE_FAILED/, '要说清装不上时该看什么报错')
  // 关键：提醒必须**可粘贴**，不能只说「注意网络」。版本可读时 tag 要填好。
  assert.ok(
    hits[0].message.includes('https://github.com/wbb316/dsh-novel/archive/refs/tags/v7.7.7.tar.gz'),
    '提醒里必须带上填好 tag 的 tarball URL：' + hits[0].message,
  )
  // 以及那个我差点自己踩的坑：改版本号之前先确认 npm 上同名包是不是自己的
  assert.match(hits[0].message, /同名包/, '必须点明「被占用时会装成别人的包」')
  // 顺带钉住这条不变式：它确实是要被装的东西，不是被误报的
  assert.ok(specsToInstall(plan).includes('github:wbb316/dsh-novel'))
})

// ── 勾选与 prune：破坏性动作不能碰「没勾中、也看不见」的东西 ──
test('选择：勾选迁移不执行 prune —— extraInTarget 被清空并给出提醒', () => {
  const withExtra = {
    ...samplePlan,
    extraInTarget: [{ name: 'only-in-target', spec: '^1.0.0' }],
    bundles: { ...samplePlan.bundles, extraInTarget: ['tgt-only-bundle'] },
  }
  const sub = filterPlan(withExtra, ['plug-a'])
  assert.deepEqual(sub.extraInTarget, [], '没勾中、也看不见的依赖不该被删')
  assert.deepEqual(sub.bundles.extraInTarget, [], '同一个道理：只在目标端的 bundle 也不能被移除')
  const w = sub.warnings.find((x) => x.code === 'prune-limited-by-selection')
  assert.ok(w, '必须有一条提醒说明 prune 被跳过了')
  assert.match(w.message, /2 项/, '要说清被保住的是几项')
})

test('选择：不传 only 时 prune 照旧（extraInTarget 原样保留）', () => {
  const withExtra = { ...samplePlan, extraInTarget: [{ name: 'only-in-target', spec: '^1.0.0' }] }
  assert.equal(filterPlan(withExtra, undefined).extraInTarget.length, 1)
})

test('选择：selection.all 按「逐个包含」判断，不被凑数的假名字放大', () => {
  // 旧实现是 `selected.size >= total`：5 个**不存在**的名字正好凑够 5，
  // 于是「一个真插件都没勾」会被说成「全部」。
  const fake = filterPlan(samplePlan, ['x1', 'x2', 'x3', 'x4', 'x5'])
  assert.equal(fake.selection.total, 5)
  assert.equal(fake.selection.all, false, '一个真插件都没勾中，不能报「全部」')
  const all = filterPlan(samplePlan, ['plug-a', 'plug-b', 'plug-c', 'plug-d', 'node-pty'])
  assert.equal(all.selection.all, true)
})

// ── 版本倒退：源侧比目标侧旧时，这一步实际是把目标降级 ──
function planBetween(tag, sourceDeps, targetDeps) {
  const src = path.join(tmp, `${tag}-src`)
  const tgt = path.join(tmp, `${tag}-tgt`)
  makeProfile(src, { name: 's', dependencies: sourceDeps, dsh: { profile: { bundles: [] } } })
  makeProfile(tgt, { name: 't', dependencies: targetDeps, dsh: { profile: { bundles: [] } } })
  return computePlan({ source: src, target: tgt })
}

test('版本倒退：源侧更旧 → 进 change + version-downgrade 提醒，但**不阻断**', () => {
  const plan = planBetween('dg', { 'web-all': '^0.3.24' }, { 'web-all': '0.4.4' })
  assert.deepEqual(plan.downgrades.map((d) => d.name), ['web-all'])
  assert.equal(plan.downgrades[0].fromCore, '0.4.4')
  assert.equal(plan.downgrades[0].toCore, '0.3.24')
  assert.ok(plan.change.some((e) => e.name === 'web-all'), '降级仍是一条 change（只报告、不阻断）')
  assert.equal(plan.ok, true, '这是提醒，不是阻断项 —— --no-install 下有意回滚是合法用法')
  const w = plan.warnings.find((x) => x.code === 'version-downgrade')
  assert.ok(w, '必须有一条 version-downgrade 提醒')
  assert.match(w.message, /降级/)
})

test('版本前进（源侧更新）不报倒退 —— 那才是正常迁移', () => {
  const plan = planBetween('up', { 'web-all': '0.4.4' }, { 'web-all': '^0.3.24' })
  assert.deepEqual(plan.downgrades, [])
  assert.ok(!plan.warnings.some((w) => w.code === 'version-downgrade'))
})

test('同版本不同钉法仍归 repin，不算倒退（^0.4.4 vs 0.4.4）', () => {
  const plan = planBetween('pin', { 'web-all': '^0.4.4' }, { 'web-all': '0.4.4' })
  assert.equal(plan.repin.length, 1)
  assert.deepEqual(plan.downgrades, [])
})

test('link: 没有可比的版本 → 不报倒退（不是所有 spec 都能比大小）', () => {
  const plan = planBetween('lnk', { 'dsh-novel': 'link:D:/dsh/plugins/dsh-novel-plugin' }, { 'dsh-novel': 'link:D:/dsh/plugins' })
  assert.deepEqual(plan.downgrades, [])
})

test('版本倒退的提醒会被 only 一起筛掉（它带 package 名）', () => {
  const withDowngrade = {
    ...samplePlan,
    downgrades: [{ name: 'plug-c', from: '0.4.4', to: '^0.3.24', fromCore: '0.4.4', toCore: '0.3.24' }],
    warnings: [...samplePlan.warnings, { code: 'version-downgrade', message: 'plug-c 要降级', package: 'plug-c' }],
  }
  const sub = filterPlan(withDowngrade, ['plug-a'])
  assert.ok(!sub.warnings.some((w) => w.code === 'version-downgrade'), '没勾 plug-c 就不该提醒它降级')
  // 这一条是补的：上面只断言了「提醒」被筛掉，数组本身却靠 `...plan` 漏了过去 ——
  // 而那正是 extraInTarget 那条 bug 的同一个形状。断言数组，别只断言提醒。
  assert.deepEqual(sub.downgrades, [], 'downgrades 数组也必须被筛掉（它靠 ...plan 漏过去过一次）')
  const sub2 = filterPlan(withDowngrade, ['plug-c'])
  assert.ok(sub2.warnings.some((w) => w.code === 'version-downgrade'), '勾了它就必须提醒')
  assert.deepEqual(sub2.downgrades.map((d) => d.name), ['plug-c'], '勾中的降级项必须留着')
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
