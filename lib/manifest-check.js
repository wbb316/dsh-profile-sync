/**
 * dsh-profile-sync —— 装前自检（清单不变式 + 真加载）
 *
 * 存在的理由是一个**最坏的失败模式**：bundle 一旦被写进 `dsh.profile.bundles`
 * 却加载不起来，profile 组装就会失败 —— 桌面端**直接打不开窗口**，
 * 而且这时候你已经在应用外面，没法用界面去修。
 * 所以装之前必须先把「这个包真的能被加载」验清楚。
 *
 * 查两类东西：
 *
 * A. 清单不变式（`checkPluginPackage`，纯同步、无副作用）
 *    · package.json 的 name、cordis.patch.yml 里的 name、client.js 的 loader id
 *      **三者必须一致** —— 不一致是最典型的静默坏法（插件装上了但永远不挂载）
 *    · `dsh.client.inject`（package.json）与客户端半返回的 `inject` 属于**两个命名空间**：
 *      前者写**包名行**，后者写**服务名**。它们绝不该拿来比相等 —— 我第一版就是这么比的，
 *      结果既会报假错、又漏掉了真正的坑（把包名写进服务名的位置会让整个界面起不来）。
 *      现在查的是形态：服务名不该带 `@` 或 `/`。
 *    · main / exports / patch 文件真的存在
 *    · 声明了 dsh.bundle.patch 吗（没声明的包进 bundles 也不会成为加载层）
 *
 * B. 真加载（`checkHostModuleLoads` / `checkClientModuleLoads`，异步）
 *    真的 import 一次宿主半和客户端半，确认 `apply` 导出了、
 *    客户端半确实按模块加载器契约注册了。语法对 ≠ 加载得起来。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 从 patch 文本里取 `insert:` 块内的 name / id 行（和 plan.js 同一套缩进规则）。 */
export function parseInsertRows(text) {
  const rows = []
  let insertIndent = null
  let current = null
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
    if (id !== null) {
      if (insertIndent !== null && indent > insertIndent) {
        current = { id: id[1], name: null }
        rows.push(current)
      } else {
        current = null
        if (indent <= (insertIndent ?? -1)) insertIndent = null
      }
      continue
    }
    const name = /^\s*-?\s*name:\s*['"]?([^'"\s]+)/.exec(line)
    if (name !== null && current !== null && current.name === null) current.name = name[1]
  }
  return rows
}

/** 从 client.js 文本里取 loader 的 id 和 `inject` 数组（客户端半不能 import，只能读文本）。 */
export function parseClientContract(text) {
  const src = String(text ?? '')
  // 只在 load( 调用附近找 id，避免被文件里别的 `id:` 干扰
  const loadIdx = src.search(/__ModuleLoader__\s*\.\s*load\s*\(/)
  const loaderCall = loadIdx >= 0
  const head = loaderCall ? src.slice(loadIdx, loadIdx + 500) : ''
  const loaderId = /\bid:\s*['"]([^'"]+)['"]/.exec(head)
  const injectMatch = /\binject\s*=\s*\[([^\]]*)\]/.exec(src)
  let injectList = null
  if (injectMatch !== null) {
    injectList = [...injectMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
  }
  return {
    loaderCall,
    loaderId: loaderId === null ? null : loaderId[1],
    inject: injectList,
  }
}

/**
 * 清单不变式检查。纯同步，不 import 任何东西，可以在宿主进程里安全调用。
 * @returns {{ok: boolean, errors: string[], warnings: string[], facts: object}}
 */
export function checkPluginPackage(dir) {
  const errors = []
  const warnings = []
  const facts = { dir }

  const manifestFile = path.join(dir, 'package.json')
  const manifest = readJson(manifestFile)
  if (manifest === null) {
    return { ok: false, errors: [`读不到或解析不了 ${manifestFile}`], warnings, facts }
  }
  facts.name = manifest.name
  facts.version = manifest.version

  if (typeof manifest.name !== 'string' || !PACKAGE_NAME_RE.test(manifest.name)) {
    errors.push(`package.json 的 name 不是合法包名：${JSON.stringify(manifest.name)}`)
  }
  if (manifest.type !== 'module') {
    warnings.push('package.json 没有 "type": "module"；本插件是 ESM，缺了可能加载失败。')
  }

  // main / exports 指向的入口必须真的存在
  const entries = []
  if (typeof manifest.main === 'string') entries.push(manifest.main)
  const rootExport = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.']
  if (typeof rootExport === 'string') entries.push(rootExport)
  if (entries.length === 0) {
    errors.push('package.json 没有可用的 main / exports["."] —— 宿主找不到入口。')
  }
  for (const rel of entries) {
    if (!fs.existsSync(path.join(dir, rel))) errors.push(`声明的入口不存在：${rel}`)
  }

  // bundle patch
  const patchRel = manifest.dsh?.bundle?.patch
  if (typeof patchRel !== 'string' || patchRel === '') {
    errors.push('没有声明 dsh.bundle.patch —— 这样装上去只会当普通依赖，永远不成为加载层。')
  } else {
    const patchFile = path.join(dir, patchRel)
    if (!fs.existsSync(patchFile)) {
      errors.push(`dsh.bundle.patch 指向的文件不存在：${patchRel}`)
    } else {
      const rows = parseInsertRows(readText(patchFile) ?? '')
      facts.insertRows = rows
      if (rows.length === 0) {
        errors.push(`patch 里没有 insert 块：${patchRel} —— 装上去不会挂载任何东西。`)
      } else {
        const names = rows.map((r) => r.name).filter((n) => typeof n === 'string')
        if (!names.includes(manifest.name)) {
          errors.push(
            `patch 的 insert 行里没有 name: ${manifest.name}（实际：${JSON.stringify(names)}）—— ` +
              `包名和挂载名不一致，插件装上了也不会加载。`
          )
        }
      }
    }
  }

  // 客户端半
  const client = manifest.dsh?.client
  const clientRel = typeof manifest.exports?.['./client'] === 'string' ? manifest.exports['./client'] : null
  if (client !== undefined && client !== null) {
    if (client.platform !== 'web') warnings.push(`dsh.client.platform 是 ${JSON.stringify(client.platform)}，本项目只针对 web。`)
    if (!Array.isArray(client.inject)) {
      errors.push('dsh.client.inject 必须是字符串数组。')
    } else if (clientRel === null) {
      errors.push('声明了 dsh.client 但没有 exports["./client"] —— 宿主找不到客户端半。')
    } else if (!fs.existsSync(path.join(dir, clientRel))) {
      errors.push(`exports["./client"] 指向的文件不存在：${clientRel}`)
    } else {
      const contract = parseClientContract(readText(path.join(dir, clientRel)) ?? '')
      facts.client = contract
      if (!contract.loaderCall) {
        errors.push(`${clientRel} 里没有 window.__ModuleLoader__.load(...) —— 宿主不会把它当客户端模块。`)
      }
      if (contract.loaderId !== manifest.name) {
        errors.push(
          `客户端 loader 的 id 是 ${JSON.stringify(contract.loaderId)}，但包名是 ${JSON.stringify(manifest.name)} —— ` +
            `两者必须一致（id 就是包名）。`
        )
      }
      if (contract.inject === null) {
        warnings.push(`${clientRel} 里没找到 inject 数组（应当导出 inject）。`)
      } else {
        // 注意：两处 inject 是**两个不同的命名空间**，绝不能拿来比相等 ——
        //   package.json 的 dsh.client.inject = 包名行（要先注册的模块）
        //   客户端半返回的 inject              = 服务名（fiber 依赖的服务）
        // 能查的是形态：服务名是 'slots' 这种标识符，不带 @ 或 /。
        // 这条检查正好能抓住我自己踩过的那个坑：把包名写进服务名的位置，
        // fiber 会永远等一个不存在的服务，客户端启动审计报 "entry did not activate"，
        // 整个 Web 界面起不来（而服务端日志一切正常，所以极难从日志看出来）。
        const suspicious = contract.inject.filter((name) => typeof name === 'string' && /[@/]/.test(name))
        if (suspicious.length > 0) {
          errors.push(
            `${clientRel} 导出的 inject 里出现了像包名的东西：${JSON.stringify(suspicious)}。` +
              `这里必须写**服务名**（slots / theme 这种），不是包名 —— 写包名会让这个 fiber ` +
              `永远等一个不存在的服务，客户端启动审计报「entry did not activate」，整个 Web 界面起不来。`
          )
        }
        if (!contract.inject.includes('slots')) {
          warnings.push(
            `${clientRel} 的 inject 里没有 'slots'：如果它要用 ctx.slots 注册席位，就必须声明这个服务。`
          )
        }
      }
    }
  }

  // 引擎范围
  const engines = manifest.dsh?.engines?.dsh
  if (typeof engines !== 'string' || engines.trim() === '') {
    warnings.push('没有声明 dsh.engines.dsh —— 官方通道就无法替你判断兼容性。')
  } else {
    facts.engines = engines
  }

  return { ok: errors.length === 0, errors, warnings, facts }
}

/**
 * 真的 import 一次宿主半。语法对不等于加载得起来：
 * 顶层 import 了一个不存在的相对路径，或者 ESM 循环引用，都能骗过 --check。
 */
export async function checkHostModuleLoads(dir) {
  const manifest = readJson(path.join(dir, 'package.json'))
  const rel = typeof manifest?.main === 'string' ? manifest.main : manifest?.exports?.['.']
  if (typeof rel !== 'string') return { ok: false, error: '没有可加载的入口' }
  const file = path.join(dir, rel)
  try {
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.apply !== 'function') {
      return { ok: false, error: `${rel} 没有导出 apply 函数（宿主插件必须是 apply 或默认导出服务类）` }
    }
    return { ok: true, exports: Object.keys(mod).sort(), file }
  } catch (err) {
    return { ok: false, error: `import ${rel} 失败：${String(err?.message ?? err)}`, file }
  }
}

/**
 * 真的 import 一次客户端半。它引用了 `window`，所以先塞一个假的模块加载器接住调用 ——
 * 顺带就验证了「它确实按契约注册了自己」。
 */
export async function checkClientModuleLoads(dir) {
  const manifest = readJson(path.join(dir, 'package.json'))
  const rel = manifest?.exports?.['./client']
  if (typeof rel !== 'string') return { ok: false, error: '没有 exports["./client"]' }
  const file = path.join(dir, rel)

  const loaded = []
  const savedWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } }
  try {
    await import(`${pathToFileURL(file).href}?probe=${Date.now()}`)
  } catch (err) {
    return { ok: false, error: `import ${rel} 失败：${String(err?.message ?? err)}`, file }
  } finally {
    if (savedWindow === undefined) delete globalThis.window
    else globalThis.window = savedWindow
  }

  if (loaded.length !== 1) {
    return { ok: false, error: `期望加载器被调用 1 次，实际 ${loaded.length} 次`, file }
  }
  const spec = loaded[0]
  if (typeof spec?.factory !== 'function') {
    return { ok: false, error: '加载契约缺少 factory 函数', file }
  }
  return { ok: true, id: spec.id, file }
}

/** 一站式自检：清单 + 真加载。装之前跑这个。 */
export async function selfCheck(dir) {
  const manifest = checkPluginPackage(dir)
  if (!manifest.ok) return { ok: false, errors: manifest.errors, warnings: manifest.warnings, facts: manifest.facts }

  const errors = []
  const host = await checkHostModuleLoads(dir)
  if (!host.ok) errors.push(`宿主半加载失败：${host.error}`)

  const client = await checkClientModuleLoads(dir)
  if (!client.ok) errors.push(`客户端半加载失败：${client.error}`)

  return {
    ok: errors.length === 0,
    errors,
    warnings: manifest.warnings,
    facts: { ...manifest.facts, hostExports: host.exports ?? null, clientId: client.id ?? null },
  }
}
