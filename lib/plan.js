/**
 * dsh-profile-sync —— 计划层（纯逻辑，不依赖 DSH 运行时）
 *
 * 把「源 profile（默认网页版 web）的插件集」算成一份可审阅、可回滚的迁移计划。
 * 这一层只读文件和算 diff，**不跑 pnpm、不改任何东西**；执行交给 bin/apply.mjs，
 * 由它在桌面端完全退出之后调用官方的 `dsh plugin --profile <p> add`。
 *
 * 为什么需要这一层（三条都是它存在的理由，踩过才知道）：
 *
 * 1) profile 之间要同步的**不是 node_modules**，而是这几样：
 *      · package.json 的 dependencies（可能含 link: / file: 本机路径）
 *      · package.json 的 dsh.profile.bundles  ← 漏了最阴：包装上了、永远不加载、也不报错
 *      · pnpm-workspace.yaml 的 allowBuilds   ← 漏了 pnpm 静默跳过原生构建
 *      · compatibility.json 的精确版本豁免     ← 漏了目标核心会拒绝加载
 *      · cordis.patch.yml                     ← **故意不自动同步**，见第 3 条
 *
 * 2) cordis 对「两个 bundle 插入同一个 loader entry id」是**直接拒绝启动整棵树**，
 *    而不是跳过那一个。官方 `dsh plugin add` 不检查这件事（dshmarket 检查），
 *    所以必须在装之前自查：这就是 blockers 里的 entry-id-collision。
 *
 * 3) 配置层绝不自动抄。cordis.patch.yml 里躺着端口（web 3080 / desktop 19387）、
 *    宠物坐标、remote-web-ui 的 Tailscale 地址 —— 那是**实例配置**，不是插件配置。
 *    整份抄过去会直接端口冲突。本模块只把差异列出来给人看（configDiff）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** dsh 自带的 in-box bundle：不算「用户的插件」，两边本来就有，同步时要滤掉。 */
export const INBOX_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/** 本插件自己的状态目录（计划、脚本、备份、日志）。 */
export const SYNC_HOME_NAME = 'profile-sync'

// ───────────────────────────── 路径 ─────────────────────────────

export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return path.join(os.homedir(), '.dsh')
}

export function profilesRoot() {
  return path.join(dshHome(), 'profiles')
}

export function syncHome() {
  return path.join(dshHome(), SYNC_HOME_NAME)
}

/**
 * profile 名的合法性契约：抄 `@deepseek-ai/dsh-app-boot` 的 resolveProfileDir。
 * 点、空格、Unicode 都是正常字符；只有空的、穿越形状的、launcher 保留的、带分隔符的才拒。
 */
export function isProfileName(name) {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    name !== 'node_modules' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}

/**
 * 把「profile 名」或「显式目录」统一解析成 { name, dir, explicit }。
 * 显式目录是给 DSH Desktop 这种自己持有 profile 位置的宿主用的（同 dshmarket 的 profileDir）。
 */
export function resolveProfileRef(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('profile 名不能为空')
  }
  const raw = ref.trim()
  if (path.isAbsolute(raw)) {
    return { name: path.basename(raw), dir: raw, explicit: true }
  }
  if (!isProfileName(raw)) {
    throw new Error(`非法的 profile 名：${JSON.stringify(raw)}`)
  }
  return { name: raw, dir: path.join(profilesRoot(), raw), explicit: false }
}

// ─────────────────────────── 读 profile ───────────────────────────

export function readManifest(profileDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** 依赖表全量（含 in-box）。 */
export function readDependencies(profileDir) {
  const manifest = readManifest(profileDir)
  const deps = manifest?.dependencies
  return deps && typeof deps === 'object' ? { ...deps } : {}
}

/** 只留社区插件（滤掉 in-box）。 */
export function readCommunityDependencies(profileDir) {
  const all = readDependencies(profileDir)
  const out = {}
  for (const [name, spec] of Object.entries(all)) {
    if (!INBOX_BUNDLES.includes(name)) out[name] = spec
  }
  return out
}

/** `dsh.profile.bundles` —— profile 真正会加载的层次。 */
export function readBundles(profileDir) {
  const manifest = readManifest(profileDir)
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((n) => typeof n === 'string') : []
}

export function readCompatibility(profileDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(profileDir, 'compatibility.json'), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export function readWorkspaceYaml(profileDir) {
  try {
    return fs.readFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
  } catch {
    return ''
  }
}

/** 某个 profile 的 pnpm-workspace.yaml 里放行的原生构建脚本。 */
export function readAllowBuilds(profileDir) {
  return parseAllowBuilds(readWorkspaceYaml(profileDir))
}

/** 读兼容性豁免里记录的「插件@版本」键（值是被批准的 dsh 版本数组）。 */
export function readExemptionKeys(profileDir) {
  return Object.keys(readCompatibility(profileDir))
}

// ─────────────────────── allowBuilds 解析与合并 ───────────────────────
// 这段抄的是 dshmarket/lib/profile.js 里被真实 bug 打磨过的规则：
//  · 必须容忍 CRLF（Windows 编辑器 / core.autocrlf 会把 \r 塞在 allowBuilds: 和换行之间，
//    老写法会匹配不到已有块，于是**追加第二个** allowBuilds: —— 两个同名顶层键 = 非法 YAML，
//    pnpm 从此拒绝该 profile 的一切安装）
//  · 作用域包名以 @ 开头，是 YAML 保留指示符，必须加引号，否则整个文件坏掉
//  · 已经坏成两个块的，要合并成一个（顺便修复）

export function parseAllowBuilds(yaml) {
  const map = {}
  const blockRe = /allowBuilds:[ \t]*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/g
  for (const match of String(yaml ?? '').matchAll(blockRe)) {
    for (const line of match[1].split(/\r?\n/)) {
      const m = /^[ \t]+(\S.*?)\s*:\s*(true|false)?\s*$/.exec(line)
      if (m === null || m[1] === '') continue
      let key = m[1]
      if (
        key.length >= 2 &&
        ((key[0] === "'" && key[key.length - 1] === "'") || (key[0] === '"' && key[key.length - 1] === '"'))
      ) {
        key = key.slice(1, -1)
      }
      map[key] = m[2] ?? 'true'
    }
  }
  return map
}

function quoteYamlKey(key) {
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(key) || /:(\s|$)/.test(key)) {
    return `'${key.replace(/'/g, "''")}'`
  }
  return key
}

/**
 * 把 names 合并进 yaml 的 allowBuilds 块。幂等：已存在的键不动。
 *
 * `values` 是 name → `'true'` / `'false'`。**新增的键必须沿用源侧的值，
 * 不能一律写 true**：源侧显式写着 `node-pty: false` 是「有意关掉这个原生构建」，
 * 一律写 true 会在目标侧把它打开 —— 语义反转，而且这种反转不会报任何错，
 * 只会静静生效（这正是另一套安装上跑测试时暴露出来的问题）。
 *
 * @param {string} yaml
 * @param {string[]} names
 * @param {Record<string, string>} [values]
 * @returns {{ text: string, added: string[] }}
 */
export function mergeAllowBuildsText(yaml, names, values) {
  const text0 = String(yaml ?? '')
  const existing = parseAllowBuilds(text0)
  const added = names.filter((name) => !(name in existing))
  if (added.length === 0) return { text: text0, added: [] }

  const map = { ...existing }
  for (const name of added) map[name] = values?.[name] ?? 'true'

  const eol = /\r\n/.test(text0) ? '\r\n' : '\n'
  const blockText =
    `allowBuilds:${eol}` +
    Object.entries(map)
      .map(([k, v]) => `  ${quoteYamlKey(k)}: ${v}`)
      .join(eol) +
    eol

  const blockRe = /allowBuilds:[ \t]*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/g
  const matches = [...text0.matchAll(blockRe)]
  if (matches.length === 0) {
    const base = text0 === '' ? '' : text0.replace(/\r?\n?$/, eol)
    return { text: base + blockText, added }
  }
  let seen = 0
  const text = text0.replace(blockRe, () => (seen++ === 0 ? blockText : ''))
  return { text, added }
}

// ───────────────────────── install spec 解析 ─────────────────────────

/** pnpm 的 spec 形态。决定「能不能在目标机上装出来」。 */
export function specKind(spec) {
  const s = String(spec ?? '').trim()
  if (/^link:/i.test(s)) return 'link'
  if (/^file:/i.test(s)) return 'file'
  if (
    /^(git\+|github:|gitlab:|bitbucket:|gitea:)/i.test(s) ||
    /^https?:\/\/.+\.git(?:#|$)/i.test(s)
  ) {
    return 'git'
  }
  if (/^https?:\/\//i.test(s)) return 'url'
  return 'registry'
}

/**
 * registry spec 的「版本核心」：去掉 ^ ~ >= 之类修饰，只留 x.y.z(-预发布)。
 *
 * 为什么需要它：本机上桌面端是**故意**把版本钉成精确号的（0.11.3），
 * 网页端用的是范围号（^0.11.3）—— 两者指向同一个版本，只是钉的松紧不同。
 * 朴素 diff 会把它当成「变更」并覆盖掉桌面端那个加固。所以这种要单独归到 repin，
 * 只报告、默认不动。
 */
export function registryVersionCore(spec) {
  const s = String(spec ?? '').trim()
  if (specKind(s) !== 'registry') return null
  // 拆掉包名：作用域包名带前导 @，所以版本分隔符是**最后一个** @（且不能在位置 0）
  const at = s.lastIndexOf('@')
  const range = at > 0 ? s.slice(at + 1) : s
  const m = /(?:[\^~]|>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(range)
  return m === null ? null : m[1]
}

/** `link:` / `file:` 后面的本机路径（pnpm 要求绝对路径）。 */
export function localSpecPath(spec) {
  const m = /^(?:link|file):(.+)$/i.exec(String(spec ?? '').trim())
  if (m === null) return null
  let p = m[1]
  try {
    p = decodeURIComponent(p)
  } catch {
    /* 保留 pnpm 的字面路径 */
  }
  if (p.startsWith('//')) return null
  return p
}

/**
 * 从 git 源 spec 推出「能绕开 git 的 tarball URL」。
 *
 * 为什么需要它：git 源是整个迁移里唯一**没有本地预检可做**的形态 —— `link:` / `file:`
 * 有本机路径可查，`git:` 什么都没有，所以「目标机装不上」只能等到 install 阶段、以一句
 * pnpm 报错暴露出来。而只报一句「注意网络」是没用的：看的人知道会挂，却不知道怎么绕。
 *
 * 绕法是实测出来的（2026-10-06）：同一个仓库、同一台机器，
 *     pnpm add github:owner/repo                       → 失败（走 git 自己的 TLS）
 *     pnpm add https://github.com/owner/repo/archive/refs/tags/x.tar.gz → 成功（走 pnpm 自己的 HTTPS）
 * 即 tarball URL 能把这条依赖从 git 传输层上摘下来，且包名不变（下游声明一个字都不用改）。
 *
 * 只认 github：GitLab / Bitbucket 的 archive 路径形态不同，硬猜会给出**错的** URL ——
 * 那种情况宁可返回 null，让上层退化成通用建议。ssh 形态与自建服务同样返回 null。
 *
 * @param {string} spec   源侧那一行的原文，例如 `github:wbb316/dsh-novel`
 * @param {string|null} version 源侧实际装出来的版本号（有就填进 tag，没有就留占位符）
 * @returns {string|null} 可直接粘贴的 tarball URL；认不出来时为 null
 */
export function tarballUrlHint(spec, version) {
  let s = String(spec ?? '').trim()
  let ref = null
  const hash = s.indexOf('#')
  if (hash >= 0) {
    ref = s.slice(hash + 1)
    s = s.slice(0, hash)
  }
  // `#semver:^1.0.0` 这类不是 tag，不能塞进 archive 路径
  if (ref !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) ref = null

  let rest = null
  if (/^github:/i.test(s)) rest = s.slice('github:'.length)
  else {
    const m = /^(?:git\+)?https?:\/\/github\.com\/(.+)$/i.exec(s)
    if (m !== null) rest = m[1]
  }
  if (rest === null) return null
  const parts = rest
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((piece) => piece !== '')
  if (parts.length !== 2) return null
  const [owner, repo] = parts
  const tag =
    ref ?? (typeof version === 'string' && version !== '' ? `v${version}` : '<tag>')
  return `https://github.com/${owner}/${repo}/archive/refs/tags/${tag}.tar.gz`
}

/** 一个依赖在这台机器上的包目录（link: 指向源目录，其余读 node_modules）。 */
export function packageDirFor(profileDir, name, spec) {
  const local = localSpecPath(spec)
  if (local !== null && specKind(spec) === 'link') {
    return path.isAbsolute(local) ? local : path.resolve(profileDir, local)
  }
  return path.join(profileDir, 'node_modules', name)
}

export function readPackageManifest(pkgDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** 包声明的 bundle patch 文件（`dsh.bundle.patch`，可能在子目录里），没有则 null。 */
export function declaredBundlePatchFile(pkgDir) {
  const manifest = readPackageManifest(pkgDir)
  const declared = manifest?.dsh?.bundle?.patch
  if (typeof declared !== 'string' || declared === '') return null
  return path.join(pkgDir, declared)
}

/**
 * 从 patch 文本里取「本包 **插入** 的 entry id」。
 *
 * 关键区别（dshmarket #147 的血泪）：patch 里有两类行
 *     - insert:
 *         - id: vision-router     ← 本包插入的，会创建 entry
 *     - id: attachment-local      ← 别人的行，本包只是改配置
 * 只有插入型才会跟别人撞 id，把配置型也算进来会误报、把合法插件拒之门外。
 */
export function parsePatchInsertedIds(text) {
  const ids = []
  let insertIndent = null
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '')
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (insertIndent !== null && indent <= insertIndent && !/^\s*-?\s*(id|name|config):/u.test(line)) {
      insertIndent = null
    }
    if (/^\s*-?\s*insert:\s*$/u.test(line)) {
      insertIndent = indent
      continue
    }
    const id = /^\s*-?\s*id:\s*['"]?([^'"\s]+)/.exec(line)
    if (id === null) continue
    if (insertIndent !== null && indent > insertIndent) {
      if (!ids.includes(id[1])) ids.push(id[1])
    } else if (indent <= (insertIndent ?? -1)) {
      insertIndent = null
    }
  }
  return ids
}

export function readInsertedIds(profileDir, name, spec) {
  const pkgDir = packageDirFor(profileDir, name, spec)
  const patchFile = declaredBundlePatchFile(pkgDir)
  if (patchFile === null) return []
  try {
    return parsePatchInsertedIds(fs.readFileSync(patchFile, 'utf8'))
  } catch {
    return []
  }
}

/** 包有没有可加载的入口产物（源码签出没有 lib/ 的那种，提升进 bundle 层会炸整个 profile）。 */
export function hasLoadableEntry(pkgDir) {
  const manifest = readPackageManifest(pkgDir)
  const candidates = []
  if (typeof manifest?.main === 'string') candidates.push(manifest.main)
  const root = manifest?.exports
  const rootExport = typeof root === 'string' ? root : root?.['.']
  if (typeof rootExport === 'string') candidates.push(rootExport)
  else if (rootExport && typeof rootExport === 'object') {
    for (const value of Object.values(rootExport)) {
      if (typeof value === 'string') candidates.push(value)
    }
  }
  if (candidates.length === 0) candidates.push('index.js')
  return candidates.some((rel) => fs.existsSync(path.join(pkgDir, rel)))
}

/** 包声明的 dsh 引擎范围（`dsh.engines.dsh`）。 */
export function readEnginesRange(pkgDir) {
  const manifest = readPackageManifest(pkgDir)
  const range = manifest?.dsh?.engines?.dsh
  return typeof range === 'string' && range.trim() !== '' ? range.trim() : null
}

/** 尽力找目标运行时的 dsh 版本（找不到就 null，只影响一条建议性提示）。 */
export function detectRuntimeVersion(targetDir) {
  const env = process.env.DSH_VERSION
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  const candidates = [
    path.join(targetDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    path.join(profilesRoot(), 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    path.join(dshHome(), 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
  ]
  for (const file of candidates) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof value?.version === 'string') return value.version
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/**
 * 解析 x.y.z(-预发布)(+构建)。构建元数据按 semver 忽略。
 * 预发布部分必须留着 —— 这个生态全是 `0.2.0-rc.2` 这种版本，
 * 只比数字三元组会把 `>=0.2.0-rc.3` 对着 `0.2.0-rc.2` 判成「满足」（错的）。
 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(v ?? '').trim()
  )
  if (m === null) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? null : m[4].split('.'),
  }
}

/** semver 优先级比较：数字三元组 → 预发布（数字 < 字母，短的更小，有预发布 < 无）。 */
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) return null
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const nx = Number(x)
      const ny = Number(y)
      if (nx !== ny) return nx < ny ? -1 : 1
      continue
    }
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 引擎范围的**建议性**判断。只认 `>=x.y.z` / `>x.y.z` / `^x.y.z` / 裸版本，
 * 其余（`||`、`~`、范围区间）一律返回 'unknown' —— 官方 add 才是权威，
 * 它会真的校验并在不通过时自动回滚 package.json + lockfile + node_modules。
 * @returns {'ok'|'violated'|'unknown'|'no-range'}
 */
export function advisoryEngineCheck(range, runtime) {
  if (range === null || range === undefined) return 'no-range'
  if (runtime === null || runtime === undefined) return 'unknown'
  const r = String(range).trim()
  let op = null
  let want = null
  let m
  if ((m = /^>=\s*(.+)$/.exec(r)) !== null) { op = '>='; want = m[1] }
  else if ((m = /^>\s*(.+)$/.exec(r)) !== null) { op = '>'; want = m[1] }
  else if ((m = /^\^\s*(.+)$/.exec(r)) !== null) { op = '^'; want = m[1] }
  else if (/^\d+\.\d+\.\d+/.test(r)) { op = '='; want = r }
  else return 'unknown'

  // 复合范围（`>=1.0.0 || <0.5.0`、`>=1.0.0 <2.0.0`、连字符区间）超出本函数的能力：
  // 只要取出来的版本号不是干净的一个版本，就老实说「不认识」，别给出错误的 violated。
  const CLEAN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  if (want === null || !CLEAN.test(want)) return 'unknown'

  const cmp = compareVersions(runtime, want)
  if (cmp === null) return 'unknown'
  if (op === '>=') return cmp >= 0 ? 'ok' : 'violated'
  if (op === '>') return cmp > 0 ? 'ok' : 'violated'
  if (op === '=') return cmp === 0 ? 'ok' : 'violated'
  // ^：同主版本且 >= want（预发布的细节在 compareVersions 里已按 semver 处理）
  const pr = parseVersion(runtime)
  const pw = parseVersion(want)
  if (pr === null || pw === null) return 'unknown'
  return pr.nums[0] === pw.nums[0] && cmp >= 0 ? 'ok' : 'violated'
}

// ─────────────────────────── 计划计算 ───────────────────────────

function describeSpec(name, spec, profileDir, specName) {
  const kind = specKind(spec)
  const entry = { name, spec, kind, from: specName }
  if (kind === 'link' || kind === 'file') {
    const local = localSpecPath(spec)
    entry.localPath = local
    entry.localExists = local !== null && fs.existsSync(local)
    entry.localIsDir = entry.localExists ? fs.statSync(local).isDirectory() : false
  }
  const pkgDir = packageDirFor(profileDir, name, spec)
  entry.pkgDir = pkgDir
  entry.pkgPresent = fs.existsSync(pkgDir)
  entry.declaresBundle = declaredBundlePatchFile(pkgDir) !== null
  entry.loadable = entry.pkgPresent ? hasLoadableEntry(pkgDir) : null
  entry.engines = readEnginesRange(pkgDir)
  return entry
}

/**
 * 「我是谁」—— 从环境推断当前 profile 名。
 *
 * 这里有个**踩过的真 bug**，别再写回去：`DSH_PROFILE` 只在 **shell 调用**里有
 * （是宿主注入给 shell 的），**宿主进程自己的环境里没有**。
 * 所以我原先写的兜底 `?? 'desktop'` 会在网页版里把「当前 profile」静默算成 desktop ——
 * 于是默认方向被当成「web → desktop」，甚至对着**错误的一对** profile 报「已经一致」。
 * 表面上一切正常，结论却是错的。这类 bug 比崩溃难查得多。
 *
 * 所以：只认可靠来源；认不出来就返回 null，让调用方**明确报错**。绝不猜。
 *
 * @param {object} [env] 环境对象（默认 process.env；测试可注入）
 * @returns {string|null}
 */
export function currentProfileFromEnv(env = process.env) {
  const direct = env?.DSH_PROFILE
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  // DSH_PROFILE_DIR 的 basename 也是可靠来源（比 DSH_PROFILE 更常出现在宿主里）
  const dir = env?.DSH_PROFILE_DIR
  if (typeof dir === 'string' && dir.trim() !== '') {
    const base = path.basename(dir.trim())
    if (isProfileName(base) && base !== 'profiles') return base
  }
  return null
}

/**
 * 算出从 source 到 target 的迁移计划。
 * @param {{source?: string, target?: string, prune?: boolean}} options
 */
export function computePlan(options = {}) {
  const sourceRef = resolveProfileRef(options.source ?? 'web')
  const targetName = options.target ?? currentProfileFromEnv()
  if (targetName === null || targetName === undefined || String(targetName).trim() === '') {
    throw new Error(
      '无法确定当前 profile（环境里既没有 DSH_PROFILE 也没有可用的 DSH_PROFILE_DIR），' +
        '所以不知道该默认算到哪个目标。请显式指定 target。'
    )
  }
  const targetRef = resolveProfileRef(targetName)
  const prune = options.prune === true

  const blockers = []
  const warnings = []
  const notes = []

  if (sourceRef.dir === targetRef.dir) {
    return {
      generatedAt: new Date().toISOString(),
      ok: false,
      source: { name: sourceRef.name, dir: sourceRef.dir },
      target: { name: targetRef.name, dir: targetRef.dir },
      add: [], change: [], repin: [], same: [], extraInTarget: [],
      bundles: { add: [], same: [], extraInTarget: [] },
      allowBuilds: { add: [], addValues: {}, same: [], valueMismatch: [] },
      compatibility: { missingInTarget: [] },
      configDiff: [],
      blockers: [{ code: 'same-profile', message: '源和目标指向同一个 profile，没有可迁移的内容。' }],
      warnings,
      notes,
    }
  }

  const sourceManifest = readManifest(sourceRef.dir)
  if (sourceManifest === null) {
    blockers.push({
      code: 'source-missing',
      message: `源 profile 不可读（没有 package.json）：${sourceRef.dir}`,
    })
  }
  const targetManifest = readManifest(targetRef.dir)
  if (targetManifest === null) {
    blockers.push({
      code: 'target-missing',
      message: `目标 profile 不可读（没有 package.json）：${targetRef.dir}`,
    })
  }

  const sourceDeps = readCommunityDependencies(sourceRef.dir)
  const targetDeps = readCommunityDependencies(targetRef.dir)
  const runtimeVersion = detectRuntimeVersion(targetRef.dir)

  const add = []
  const change = []
  const repin = []
  const same = []
  // 源侧比目标侧**旧**的条目 —— 也就是「应用这一步等于把目标降级」。见下面的注释。
  const downgrades = []
  for (const [name, spec] of Object.entries(sourceDeps)) {
    if (!(name in targetDeps)) {
      add.push(describeSpec(name, spec, sourceRef.dir, sourceRef.name))
      continue
    }
    if (targetDeps[name] === spec) {
      same.push({ name, spec })
      continue
    }
    const entry = describeSpec(name, spec, sourceRef.dir, sourceRef.name)
    entry.fromSpec = targetDeps[name]
    const coreSource = registryVersionCore(spec)
    const coreTarget = registryVersionCore(targetDeps[name])
    if (coreSource !== null && coreSource === coreTarget) {
      // 同一个版本，只是钉的松紧不同（^0.11.3 vs 0.11.3）→ 保住目标端原有的钉法
      entry.repinOnly = true
      repin.push(entry)
    } else {
      // 版本倒退检查（**只报告，不阻断**）。
      //
      // 分类只看「版本核心是否相等」，不看向哪边 —— 所以源侧比目标侧旧时，
      // 这条改动实际是**把目标降级**。官方管理器会拒绝它并回滚这条改动，
      // 于是用户看到的是一个能点的「应用」和一句没有信息量的失败；
      // 面板上「迁移成功」与「迁移后插件不正常」也会因此分不清。
      // 提前说清楚，是因为「照搬源侧版本号」在两侧跨世代时是**逆着版本走**的，
      // 而那正是这套工具最容易被误用的地方。
      //
      // 不做成 blocker：`bin/apply.mjs --no-install` 下故意回滚某个插件版本是
      // 合法用法，硬拦会把这条路一起封死。与 engine-advisory 同一档。
      if (coreSource !== null && coreTarget !== null) {
        const cmp = compareVersions(coreSource, coreTarget)
        if (cmp !== null && cmp < 0) {
          entry.downgradeFrom = coreTarget
          downgrades.push({ name, from: targetDeps[name], to: spec, fromCore: coreTarget, toCore: coreSource })
        }
      }
      change.push(entry)
    }
  }

  // 版本倒退的提醒放在最前面：它的后果最容易被误判成「工具坏了」。
  for (const d of downgrades) {
    warnings.push({
      code: 'version-downgrade',
      message:
        `${d.name}：源侧是 ${d.to}（${d.toCore}），目标侧已经是 ${d.from}（${d.fromCore}）—— ` +
        '这一步是**把目标降级**，官方管理器会拒绝它并回滚。若目标侧那个版本才是你要的，别勾这个插件。',
      package: d.name,
    })
  }
  const extraInTarget = Object.entries(targetDeps)
    .filter(([name]) => !(name in sourceDeps))
    .map(([name, spec]) => ({ name, spec }))

  const sourceBundles = readBundles(sourceRef.dir)
  const targetBundles = readBundles(targetRef.dir)
  const bundleAdd = sourceBundles.filter(
    (n) => !targetBundles.includes(n) && !INBOX_BUNDLES.includes(n)
  )
  const bundleSame = sourceBundles.filter((n) => targetBundles.includes(n))
  const bundleExtra = targetBundles.filter(
    (n) => !sourceBundles.includes(n) && !INBOX_BUNDLES.includes(n)
  )

  // ── 预检 1：本机路径型 spec 必须真的存在（同一台机器上一般没问题，但 link 断了就装不上）
  for (const entry of [...add, ...change]) {
    if (entry.kind !== 'link' && entry.kind !== 'file') continue
    if (entry.localPath === null) {
      blockers.push({
        code: 'spec-path-unreadable',
        message: `${entry.name} 的 spec「${entry.spec}」解析不出本机路径，pnpm 会拒绝。`,
        package: entry.name,
      })
      continue
    }
    if (!entry.localExists) {
      blockers.push({
        code: 'spec-path-missing',
        message: `${entry.name} 指向的本机路径不存在：${entry.localPath}`,
        package: entry.name,
        localPath: entry.localPath,
      })
      continue
    }
    if (entry.kind === 'link' && !entry.localIsDir) {
      blockers.push({
        code: 'link-not-dir',
        message: `${entry.name} 用的是 link:，但 ${entry.localPath} 不是目录。`,
        package: entry.name,
      })
    }
    if (entry.kind === 'file' && entry.localIsDir) {
      // file: 也可以指目录，但声明成 file: 又给目录通常是想用 link:
      warnings.push({
        code: 'file-points-to-dir',
        message: `${entry.name} 用的是 file:，但路径是目录（${entry.localPath}）；若是本地开发请改用 link:。`,
        package: entry.name,
      })
    }
  }

  // ── 预检 2：装不出来的包（源码签出没有 lib/ 这类）—— 提升进 bundle 层会炸整个 profile
  for (const entry of [...add, ...change]) {
    if (entry.pkgPresent && entry.loadable === false) {
      blockers.push({
        code: 'no-loadable-entry',
        message: `${entry.name} 在源 profile 里没有可加载的入口产物（main/exports/index.js 都不存在）。把它放进 bundle 层会让目标 profile 起不来。先在源侧确认它装好了。`,
        package: entry.name,
        pkgDir: entry.pkgDir,
      })
    }
  }

  // ── 预检 3：cordis entry id 撞车 —— 官方 add 不查，撞了两个 bundle 会让整棵树拒绝启动
  const targetInserted = new Map()
  for (const name of targetBundles) {
    const spec = targetDeps[name] ?? readDependencies(targetRef.dir)[name] ?? name
    for (const id of readInsertedIds(targetRef.dir, name, spec)) {
      if (!targetInserted.has(id)) targetInserted.set(id, name)
    }
  }
  const candidateIds = new Map()
  for (const name of bundleAdd) {
    const spec = sourceDeps[name] ?? readDependencies(sourceRef.dir)[name] ?? name
    for (const id of readInsertedIds(sourceRef.dir, name, spec)) {
      if (!candidateIds.has(id)) candidateIds.set(id, name)
    }
  }
  for (const [id, owner] of candidateIds) {
    const clash = targetInserted.get(id)
    if (clash !== undefined && clash !== owner) {
      blockers.push({
        code: 'entry-id-collision',
        message: `loader entry id「${id}」撞车：待装 ${owner} 与已加载 ${clash} 都插入这个 id。cordis 会拒绝启动整棵树（不是跳过其中一个），必须先解决。`,
        entryId: id,
        candidate: owner,
        conflictWith: clash,
      })
    }
  }

  // ── 预检 4：声明了 dsh.bundle 吗？没声明的只会作为普通依赖装上，不会成为 profile 层
  for (const entry of [...add, ...change]) {
    if (entry.pkgPresent && entry.declaresBundle === false && bundleAdd.includes(entry.name)) {
      warnings.push({
        code: 'no-bundle-declaration',
        message: `${entry.name} 在源的 bundles 列表里，但它没有声明 dsh.bundle.patch —— 官方 add 会把它当普通依赖装（并打印同样的警告），不会成为 profile 层。`,
        package: entry.name,
      })
    }
  }

  // ── 预检 5：引擎范围（建议性）
  const engineAdvisory = []
  for (const entry of [...add, ...change]) {
    const verdict = advisoryEngineCheck(entry.engines, runtimeVersion)
    if (verdict === 'violated') {
      warnings.push({
        code: 'engine-advisory',
        message: `${entry.name} 声明 dsh.engines.dsh = ${entry.engines}，目标运行时是 ${runtimeVersion} —— 看起来不满足。官方 add 会真的校验并在不通过时自动回滚。`,
        package: entry.name,
      })
    }
    if (verdict === 'ok') engineAdvisory.push({ package: entry.name, range: entry.engines })
  }
  if (runtimeVersion === null) {
    notes.push('读不到目标运行时的 dsh 版本，引擎范围只做了形态检查；权威判断由官方 add 完成。')
  }

  // ── 预检 6：git 源的「目标机条件」（只提醒，不阻断）
  //
  // 为什么这一条必须存在：`link:` / `file:` 有本地路径可查 —— 预检 1 会在**计划阶段**
  // 就报 spec-path-missing；而 `git:` 源没有任何本地检查可做（describeSpec 只给
  // link / file 填 localPath / localExists / localIsDir，git 什么都不填）。于是
  // 「目标机装不上」只能等到 install 阶段、以一句 pnpm 报错的形式暴露出来。
  //
  // 这不是纸上推演，是实测的（2026-10-06）：同一台机器上
  //     git ls-remote https://github.com/...   → 成功，能拿到 HEAD sha
  //     pnpm add github:...                    → ERR_PNPM_GIT_RESOLVE_FAILED
  //                                              schannel: failed to receive handshake
  // 即「本机有 git」并不等于「pnpm 调 git 的那条链路能通」。
  //
  // 但只提醒、不阻断：目标机的网络状况无法在计划阶段判定，判死会把本来能装的情况误拦。
  //
  // 提醒里带上 tarball URL（见 tarballUrlHint）：只报一句「注意网络」是没用的 ——
  // 看的人知道这条路会挂，却仍然不知道怎么绕。给出可直接粘贴的替代声明，
  // 这条提醒才算真的解决了问题，而不是把「一句看不懂的 pnpm 报错」换成
  // 「一句看不懂的警告」。
  for (const entry of [...add, ...change]) {
    if (entry.kind !== 'git') continue
    // 能读到源侧装出来的版本，就把 tag 一起填好 —— 让这条提醒**直接可粘贴**，
    // 而不是留给看的人一句「你自己去查该写哪个 tag」。
    const installed = entry.pkgPresent === true ? readPackageManifest(entry.pkgDir) : null
    const installedVersion = typeof installed?.version === 'string' ? installed.version : null
    const tarball = tarballUrlHint(entry.spec, installedVersion)
    const fix =
      tarball === null
        ? '绕法：把源侧那一行从 git 源换成 registry 版本号，或换成该仓库 release 的 tarball 地址。'
        : `绕法：把源侧那一行直接换成 tarball URL —— ${tarball}` +
          (tarball.includes('<tag>') ? '（把 <tag> 换成实际 tag）' : '') +
          '。它走 pnpm 自己的 HTTPS、不经过 git，而且包名不变（下游声明一个字都不用改）。'
    warnings.push({
      code: 'git-source-needs-network',
      message: `${entry.name} 的版本声明是 git 源（${entry.spec}）：装它要用目标机上的 git 去 clone 远端，既要 git 可执行、也要那条网络通路能通 —— 实测「git 自己能连」不等于「pnpm 调 git 能连」（同一台机器上 git ls-remote 拿到了 HEAD sha，pnpm add github:… 却报 ERR_PNPM_GIT_RESOLVE_FAILED）。${fix}另：不要顺手把它改成普通版本号 —— 先确认 npm 上同名包确实是你自己的，名字被别人占用时（例如 dsh-novel）那样写会装成别人的包。`,
      package: entry.name,
    })
  }

  // ── allowBuilds：源侧有、目标侧没有的键（沿用源侧的值）；以及两边都有但值不同的
  const sourceAllow = readAllowBuilds(sourceRef.dir)
  const targetAllow = readAllowBuilds(targetRef.dir)
  const allowAdd = Object.keys(sourceAllow).filter((name) => !(name in targetAllow))
  const allowSame = Object.keys(sourceAllow).filter((name) => name in targetAllow)
  // 新增的键带上源侧的值 —— 不能默认 true（源侧写 false 是「有意关掉」）
  const allowAddValues = {}
  for (const name of allowAdd) allowAddValues[name] = sourceAllow[name]
  // 两边都有但值不同：这是**真差异**（true 会跑原生构建、false 不会），
  // 但绝不自动改 —— 目标侧完全可能是故意关着的（见 dshmarket 的注释：
  // 「Native build scripts intentionally NOT approved」）。只报告，让人自己决定。
  const allowValueMismatch = allowSame
    .filter((name) => String(sourceAllow[name]) !== String(targetAllow[name]))
    .map((name) => ({ name, source: sourceAllow[name], target: targetAllow[name] }))

  // ── compatibility.json：源侧有豁免、目标侧没有的
  const sourceExempt = readExemptionKeys(sourceRef.dir)
  const targetExempt = readExemptionKeys(targetRef.dir)
  const exemptMissing = sourceExempt.filter((key) => !targetExempt.includes(key))
  if (exemptMissing.length > 0) {
    warnings.push({
      code: 'compatibility-exemption',
      message: `源 profile 给 ${exemptMissing.join('、')} 开过精确版本豁免，目标侧没有。若目标核心同样不认这些版本，官方 add 会拒绝并自动回滚 —— 那时要在目标侧补豁免，而不是删掉检查。`,
    })
  }

  // ── 配置层：只出差异给人看，绝不自动写
  const configDiff = diffConfigPatches(sourceRef.dir, targetRef.dir)

  const ok = blockers.length === 0
  return {
    generatedAt: new Date().toISOString(),
    ok,
    prune,
    source: { name: sourceRef.name, dir: sourceRef.dir },
    target: { name: targetRef.name, dir: targetRef.dir },
    runtimeVersion,
    add,
    change,
    repin,
    same,
    downgrades,
    extraInTarget,
    bundles: { add: bundleAdd, same: bundleSame, extraInTarget: bundleExtra },
    allowBuilds: { add: allowAdd, addValues: allowAddValues, same: allowSame, valueMismatch: allowValueMismatch },
    compatibility: { sourceExempt, targetExempt, missingInTarget: exemptMissing },
    engineAdvisory,
    configDiff,
    blockers,
    warnings,
    notes,
  }
}

// ─────────────────────────── 配置层差异（只看，不写） ───────────────────────────

/**
 * 抽 cordis.patch.yml 的「顶层条目摘要」：id / 是否有 disabled / 配置键名。
 * 不解析 YAML（避免引入依赖），够用来回答「这两边配置分叉在哪」。
 */
export function summarizePatch(text) {
  const rows = []
  let current = null
  let inConfig = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '')
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const idMatch = /^\s*-\s*id:\s*['"]?([^'"\s]+)/.exec(line)
    if (idMatch !== null) {
      current = { id: idMatch[1], disabled: false, configKeys: [] }
      rows.push(current)
      inConfig = false
      continue
    }
    if (current === null) continue
    if (/^\s*-?\s*disabled:\s*true\b/.test(line)) {
      current.disabled = true
      continue
    }
    if (/^\s*(?:-?\s*)?config:\s*$/.test(line)) {
      inConfig = indent
      continue
    }
    if (inConfig !== false && indent > inConfig) {
      const key = /^\s*([A-Za-z0-9_$@.\-]+)\s*:/.exec(line)
      if (key !== null && !current.configKeys.includes(key[1])) current.configKeys.push(key[1])
    }
  }
  return rows
}

export function diffConfigPatches(sourceDir, targetDir) {
  const read = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    } catch {
      return ''
    }
  }
  const a = summarizePatch(read(sourceDir))
  const b = summarizePatch(read(targetDir))
  const aMap = new Map(a.map((r) => [r.id, r]))
  const bMap = new Map(b.map((r) => [r.id, r]))
  const ids = [...new Set([...aMap.keys(), ...bMap.keys()])]
  const rows = []
  for (const id of ids) {
    const left = aMap.get(id)
    const right = bMap.get(id)
    if (left !== undefined && right === undefined) rows.push({ id, inSource: true, inTarget: false, kind: 'only-source' })
    else if (left === undefined && right !== undefined) rows.push({ id, inSource: false, inTarget: true, kind: 'only-target' })
    else if (left.disabled !== right.disabled) {
      rows.push({ id, kind: 'disabled-differs', sourceDisabled: left.disabled, targetDisabled: right.disabled })
    } else {
      const onlyA = left.configKeys.filter((k) => !right.configKeys.includes(k))
      const onlyB = right.configKeys.filter((k) => !left.configKeys.includes(k))
      if (onlyA.length > 0 || onlyB.length > 0) {
        rows.push({ id, kind: 'config-keys-differ', onlySource: onlyA, onlyTarget: onlyB })
      }
    }
  }
  return rows
}

// ─────────────────────── 只迁移勾选的那几个插件 ───────────────────────
//
// 面板默认**全勾**（行为与原先的一键迁移完全相同），取消勾选即排除该插件。
//
// 选择筛的是**计划本身**，下游（应用内管理器 / plan.json / apply.cmd / CLI）
// 因此不需要各自再实现一遍选择语义 —— 那正是 allowBuilds 那条路出过的事：
// 同一个判断有两份实现，就一定会有一份漏掉。

/**
 * 计划里所有会被碰到的「插件」——可勾选单元，按包名去重、顺序稳定。
 *
 * 为什么 bundle / allowBuilds 的键也算进来：一个包可能**依赖已经在目标端**，
 * 只是没进加载层（bundle 没启用），或者只是缺 allowBuilds 授权 ——
 * 这两种在 add / change 里根本不会出现，但漏掉它们「迁移」就是不生效的。
 * 所以它们是独立的勾选行，而不是悄悄跟着别的包走。
 */
export function selectablePlugins(plan) {
  const rows = []
  const index = new Map()
  const touch = (name) => {
    let row = index.get(name)
    if (row === undefined) {
      row = { name, spec: null, fromSpec: null, kind: null, actions: [] }
      index.set(name, row)
      rows.push(row)
    }
    return row
  }
  for (const e of plan?.add ?? []) {
    const row = touch(e.name)
    row.spec = e.spec
    row.kind = e.kind ?? null
    row.actions.push('add')
  }
  for (const e of plan?.change ?? []) {
    const row = touch(e.name)
    row.spec = e.spec
    row.fromSpec = e.fromSpec ?? null
    row.kind = e.kind ?? null
    row.actions.push('change')
  }
  for (const e of plan?.repin ?? []) {
    const row = touch(e.name)
    row.spec = e.spec
    row.fromSpec = e.fromSpec ?? null
    row.actions.push('repin')
  }
  for (const n of plan?.bundles?.add ?? []) touch(n).actions.push('bundle')
  for (const n of plan?.allowBuilds?.add ?? []) touch(n).actions.push('allowBuilds')
  return rows
}

/**
 * 这条阻断项 / 提醒属于这次勾选的插件吗？
 * 没有归属信息的（source-missing、compatibility-exemption 这类全局问题）一律保留 ——
 * 它们说的不是某个插件，而是这次迁移整体。
 */
function belongsToSelection(item, selected) {
  if (item !== null && typeof item === 'object') {
    if (typeof item.package === 'string') return selected.has(item.package)
    if (typeof item.candidate === 'string') return selected.has(item.candidate)
  }
  return true
}

/**
 * 按 `only`（包名数组）筛出「子计划」。`only` 为 undefined / null 时**原样返回**
 * （即 CLI 与旧调用方的行为一字不变）。
 *
 * 三个容易漏的点：
 *  · 阻断项也要筛 —— 否则勾了一个无关的坏包，整次迁移都被它挡住；
 *  · `only: []`（一个都没勾）是合法输入，筛出来是一份空计划、`ok` 为 true。
 *    那不是「已经一致」，所以调用方必须自己识别空选择（见 index.js 的守卫）；
 *  · `extraInTarget`（只在目标端的依赖 / bundle）**也必须筛掉** —— 见下面的注释。
 */
export function filterPlan(plan, only) {
  if (only === undefined || only === null) return plan
  const selected = new Set((Array.isArray(only) ? only : [only]).map((n) => String(n)))
  const keep = (name) => selected.has(name)
  const allowAdd = (plan?.allowBuilds?.add ?? []).filter(keep)
  const addValues = {}
  for (const n of allowAdd) addValues[n] = plan?.allowBuilds?.addValues?.[n]
  const blockers = (plan?.blockers ?? []).filter((b) => belongsToSelection(b, selected))
  const warnings = (plan?.warnings ?? []).filter((w) => belongsToSelection(w, selected))
  const rows = selectablePlugins(plan)
  const total = rows.length

  // `extraInTarget` 是**破坏性**动作 prune 的作业对象（删依赖、removeBundle），
  // 而它们**不在 selectablePlugins 里** —— 也就是说既不可勾选、面板上也看不见。
  // 让一个没被勾中、又看不见的包因为「别的插件被勾了」而消失，是把两件事混成一件。
  // 所以勾选迁移不执行 prune；真要清就按老办法不传 only（= 全部）。
  const pruneExtra = (plan?.extraInTarget ?? []).filter((e) => keep(e?.name))
  const bundleExtra = (plan?.bundles?.extraInTarget ?? []).filter(keep)
  const prunedAway =
    (plan?.extraInTarget ?? []).length -
    pruneExtra.length +
    ((plan?.bundles?.extraInTarget ?? []).length - bundleExtra.length)
  if (prunedAway > 0) {
    warnings.push({
      code: 'prune-limited-by-selection',
      message:
        `勾选迁移不执行 prune：只在目标端的 ${prunedAway} 项（依赖 / bundle）保持不动 —— ` +
        '它们不在可勾选清单里，不该因为别的插件被勾中而消失。要连它们一起清，就别传 only（= 全部）。',
    })
  }

  return {
    ...plan,
    add: (plan?.add ?? []).filter((e) => keep(e.name)),
    change: (plan?.change ?? []).filter((e) => keep(e.name)),
    repin: (plan?.repin ?? []).filter((e) => keep(e.name)),
    extraInTarget: pruneExtra,
    bundles: {
      ...(plan?.bundles ?? {}),
      add: (plan?.bundles?.add ?? []).filter(keep),
      extraInTarget: bundleExtra,
    },
    allowBuilds: { ...(plan?.allowBuilds ?? {}), add: allowAdd, addValues },
    engineAdvisory: (plan?.engineAdvisory ?? []).filter((e) => keep(e.package)),
    // `downgrades` 也必须筛 —— 这是我修 `extraInTarget` 时差点重犯的同一个错：
    // 靠 `...plan` 漏过去的字段会在下游被当成「这次要做的」，而它其实没被勾。
    downgrades: (plan?.downgrades ?? []).filter((d) => keep(d?.name)),
    blockers,
    warnings,
    ok: blockers.length === 0,
    // `all` 必须按**逐个包含**判断：传了不存在的名字时 selected.size 会被放大，
    // 原来的 `size >= total` 会把一个真子集误报成「全部」（只影响文案，但会误导）。
    selection: {
      only: [...selected],
      total,
      all: total > 0 && rows.every((r) => selected.has(r.name)),
    },
  }
}

// ─────────────────────────── 渲染成人看的文本 ───────────────────────────

export function renderPlanText(plan) {
  const L = []
  L.push(`迁移计划：${plan.source.name} → ${plan.target.name}`)
  L.push(`生成时间：${plan.generatedAt}`)
  if (plan.runtimeVersion) L.push(`目标运行时：dsh ${plan.runtimeVersion}`)
  L.push('')

  // 勾选迁移时把范围写进报告与 plan.json —— 这份计划是要被离线脚本消费的，
  // 事后必须能看出「这次只搬了哪几个」；否则回看产物会以为搬了全部。
  if (plan.selection) {
    L.push(
      plan.selection.all
        ? `迁移范围：全部 ${plan.selection.total} 个插件`
        : `迁移范围：勾选的 ${plan.selection.only.length}/${plan.selection.total} 个 —— ${
            plan.selection.only.join('、') || '（一个都没勾）'
          }`
    )
    L.push('')
  }

  if (plan.blockers.length > 0) {
    L.push(`✗ 有 ${plan.blockers.length} 个阻断项，先解决再生成执行脚本：`)
    for (const b of plan.blockers) L.push(`  · [${b.code}] ${b.message}`)
    L.push('')
  } else {
    L.push('✓ 预检通过，可以生成执行脚本')
    L.push('')
  }

  L.push(`依赖：新增 ${plan.add.length} / 变更 ${plan.change.length} / 仅钉法不同 ${plan.repin.length} / 已一致 ${plan.same.length}`)
  for (const e of plan.add) L.push(`  + ${e.name}  ${e.spec}  (${e.kind})`)
  for (const e of plan.change) L.push(`  ~ ${e.name}  ${e.fromSpec}  →  ${e.spec}`)
  for (const e of plan.repin) L.push(`  = ${e.name}  ${e.fromSpec}  ≈  ${e.spec}  （同版本，保留目标端钉法，不动）`)
  L.push('')

  L.push(`bundle 层：新增 ${plan.bundles.add.length} / 已一致 ${plan.bundles.same.length}`)
  for (const n of plan.bundles.add) L.push(`  + ${n}`)
  L.push('')

  if (plan.allowBuilds.add.length > 0) {
    L.push(`allowBuilds 需补 ${plan.allowBuilds.add.length} 项（漏了 pnpm 会静默跳过原生构建；值沿用源侧）：`)
    for (const n of plan.allowBuilds.add) {
      const v = plan.allowBuilds.addValues?.[n]
      L.push(`  + ${n}: ${v ?? 'true'}`)
    }
    L.push('')
  }

  // 两边都有但值不同：真差异，但只报告（目标侧可能是故意关着的）
  const allowMismatch = plan.allowBuilds.valueMismatch ?? []
  if (allowMismatch.length > 0) {
    L.push(`${allowMismatch.length} 项 allowBuilds 两边都有、但值不同（**不自动改** —— 目标侧可能是故意关的）：`)
    for (const m of allowMismatch) L.push(`  · ${m.name}：源 ${m.source} / 目标 ${m.target}`)
    L.push('')
  }

  if (plan.extraInTarget.length > 0) {
    L.push(`只在目标端、源没有的依赖 ${plan.extraInTarget.length} 个${plan.prune ? '（--prune 会删掉）' : '（默认保留，不动）'}：`)
    for (const e of plan.extraInTarget) L.push(`  · ${e.name}  ${e.spec}`)
    L.push('')
  }
  if (plan.bundles.extraInTarget.length > 0) {
    L.push(`只在目标端的 bundle ${plan.bundles.extraInTarget.length} 个（默认保留）：`)
    for (const n of plan.bundles.extraInTarget) L.push(`  · ${n}`)
    L.push('')
  }

  if (plan.configDiff.length > 0) {
    L.push(`配置层分叉 ${plan.configDiff.length} 处（**只报告，不自动同步** —— 里面是端口/坐标/地址这类实例配置）：`)
    for (const row of plan.configDiff) {
      if (row.kind === 'only-source') L.push(`  · ${row.id}：只在源侧`)
      else if (row.kind === 'only-target') L.push(`  · ${row.id}：只在目标侧`)
      else if (row.kind === 'disabled-differs') {
        L.push(`  · ${row.id}：disabled 不同（源 ${row.sourceDisabled} / 目标 ${row.targetDisabled}）`)
      } else {
        const oa = row.onlySource.length > 0 ? `源独有 ${row.onlySource.join(',')}` : ''
        const ob = row.onlyTarget.length > 0 ? `目标独有 ${row.onlyTarget.join(',')}` : ''
        L.push(`  · ${row.id}：配置键不同（${[oa, ob].filter(Boolean).join('；')}）`)
      }
    }
    L.push('')
  }

  if (plan.warnings.length > 0) {
    L.push(`提醒 ${plan.warnings.length} 条：`)
    for (const w of plan.warnings) L.push(`  ! ${w.message}`)
    L.push('')
  }
  if (plan.notes.length > 0) {
    for (const n of plan.notes) L.push(`  i ${n}`)
    L.push('')
  }
  return L.join('\n')
}

/**
 * 计划里的「要装的 spec」列表（add + change），顺序稳定。
 *
 * 拼法对 spec 形态有讲究：
 *  · registry 存的是范围（^1.2.3）→ 必须拼成 `name@^1.2.3`
 *  · link: / file: / git 存的是完整 spec → 只能**原样**给
 *    （`pnpm add dsh-novel@link:D:/...` 会失败；pnpm 从目标包自己的
 *     package.json 读名字，所以不需要也 / 不能带 name@ 前缀）
 */
export function specsToInstall(plan) {
  const specs = []
  for (const entry of [...plan.add, ...plan.change]) {
    const kind = entry.kind ?? specKind(entry.spec)
    specs.push(kind === 'registry' ? `${entry.name}@${entry.spec}` : entry.spec)
  }
  return specs
}

/** 给 UI / 工具用的一句话摘要。 */
export function planSummary(plan) {
  const bits = []
  bits.push(`+${plan.add.length} 依赖`)
  if (plan.change.length > 0) bits.push(`~${plan.change.length} 变更`)
  if (plan.repin.length > 0) bits.push(`=${plan.repin.length} 仅钉法`)
  if (plan.bundles.add.length > 0) bits.push(`+${plan.bundles.add.length} bundle`)
  if (plan.allowBuilds.add.length > 0) bits.push(`allowBuilds+${plan.allowBuilds.add.length}`)
  if (plan.blockers.length > 0) bits.push(`${plan.blockers.length} 阻断`)
  else if (plan.warnings.length > 0) bits.push(`${plan.warnings.length} 提醒`)
  return bits.join(' / ')
}
