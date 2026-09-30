# dsh-profile-sync

在 dsh 的各个 **profile** 之间安全迁移插件。默认方向是 **网页版 `web` → 桌面版 `desktop`**。

这个插件的形状是刻意的：**它自己不改任何 profile**。它只做四件事 ——
算差异、预检、写一个「退出后执行的脚本」、**重启后核对是否真的落地**。
真正的安装交给官方通道 `dsh plugin --profile <p> install`。

---

## 为什么不能真的做到「一键粘贴」

这不是保守，是这套系统里的三个硬事实：

**1. 桌面端 profile 禁止用 `dsh` CLI 修改 —— 这是硬拦，不是"要先退出"。**
`@deepseek-ai/dsh/lib/bin.js` 里有一条按名字拦死一切 CLI 调用的守卫：

```js
function rejectElectronProfile(program, profile) {
  if (profile.toLowerCase() === 'desktop')
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
}
```

它对**所有** CLI 调用生效，连 `dsh --profile desktop --dump-config` 都被拒。
dshmarket 的源码里有一行注释写着同一件事：
「Never fall back to `dsh plugin --profile desktop`: that CLI is forbidden.」

所以桌面端唯一的写入器是**应用内的官方插件管理器**（cordis 服务 `pluginManager`，
也就是「设置 → 插件」页面用的那个）。本插件因此有两条应用路径：

| 目标 profile | 走哪条 | 应用时机 |
|---|---|---|
| `desktop`（app 自有） | 应用内官方管理器 `installBundle` | **当场生效**，无需退出 |
| `web` / `headless`（CLI 拥有） | `dsh plugin` 或生成的离线脚本 | 目标端退出后 |

（`installBundle` 自己负责改 `dependencies`、注册 `dsh.profile.bundles`、
跑兼容性校验、失败回滚 —— 所以走这条路时本插件**不自己写 manifest**，
写了只会跟它打架。）

**2. 要同步的不是 `node_modules`，是五样东西，少一样就静默失效。**

| 要搬的 | 漏掉/搬错的后果 |
|---|---|
| `package.json` 的 `dependencies` | 包不在，加载失败 |
| `package.json` 的 `dsh.profile.bundles` | **包装了但永远不加载，而且不报错** —— 最阴的失败 |
| `pnpm-workspace.yaml` 的 `allowBuilds` | pnpm 静默跳过原生构建（`node-pty` 的 `conpty.dll` 铺不出来） |
| `compatibility.json` 的精确版本豁免 | 目标核心不认识该插件时只给你一句看不懂的拒绝 |
| `cordis.patch.yml` | **故意不同步**，见下条 |

**3. `cordis.patch.yml` 里的东西是实例配置，不是插件配置。**
里面有端口（web 绑 `3080`、桌面端绑 `19387`）、宠物坐标、`remote-web-ui` 的
Tailscale 地址。整份抄过去直接端口冲突。所以本插件**只把差异列出来给你看**，
一个字节都不写。

---

## 安装

**桌面端不需要退出 —— 恰恰相反，它必须在运行。**

```
1. 打开 DeepSeek Harness（正在运行就对了）
2. 双击 install.cmd
3. 刷新页面 —— 左侧栏出现「插件迁移」
```

`install.cmd` 做的事：装前自检 → 确认官方的 `/api/plugin-manager` 端点在跑 →
把 `link:<本目录>` 提交给**应用内的官方插件管理器** → 轮询到包真的出现在已装列表里才算成功。

这条路是桌面端**唯一**合法的写入器（CLI 被按名字禁止，见上）。官方管理器自己负责
改 `package.json`、注册 `dsh.profile.bundles`、跑兼容性校验、失败回滚 ——
所以本插件不自己写 manifest，写了只会跟它打架。

宿主半装完会**通过 HMR 当场生效**（工具立即可用）；左侧栏面板刷新页面即可。

### 装前自检（为什么它很重要）

`install.cmd` **在调官方通道之前**会先跑一次自检（`node bin/check.mjs`）：

- **清单不变式**：`package.json` 的 `name`、`cordis.patch.yml` 里的挂载名、
  客户端 loader 的 `id` **三者必须一致**；`dsh.client.inject` 必须和客户端代码里的
  `inject` 一致（前者写**包名**，后者写**服务名**，写混是这个生态的经典错误）。
- **真加载**：真的 `import` 一次宿主半和客户端半，确认 `apply` 导出了、
  客户端半确实按模块加载器契约注册了自己。**语法对 ≠ 加载得起来** ——
  顶层 import 一个不存在的相对路径就能骗过 `--check`。

挡的是最坏的失败模式：bundle 被写进 `dsh.profile.bundles` 却加载不起来 →
profile 组装失败 → **桌面端连窗口都打不开**，而那时候你已经在应用外面了，
只能用文本编辑器改 `package.json` 才救得回来。

自检不通过会**拒绝安装**（退出码 1），不会硬着头皮往下走。

需要 **Node.js 20+ 在 PATH 上**。
`install.cmd` / `sync-plan.cmd` / 生成的 `apply.cmd` 都会自己找 node，
找不到就明确报错退出 —— **不会**退回去执行桌面端 exe（见下面那条坑）。

**装插件之前也能用**：`bin/plan-cli.mjs` 是完全独立的，不依赖 DSH 在跑。
现在就可以双击 `sync-plan.cmd` 看一份真实的差异报告。

---

## 用法

### 双击

| 文件 | 作用 |
|---|---|
| `install.cmd` | 装前自检 + 把本插件装进 profile（需先退出桌面端） |
| `sync-plan.cmd` | 算差异并生成计划 + `apply.cmd` |

### 命令行

```bash
# 算差异并落成产物（plans/<时间>/plan.json + plan.txt + apply.cmd）
node bin/plan-cli.mjs plan --source web --target desktop --write

# 只看报告
node bin/plan-cli.mjs plan

# 核对上一次迁移是否真的落地
node bin/plan-cli.mjs status

# 应用计划（会先查目标端是否还在运行）
node bin/apply.mjs --plan "<plans/.../plan.json>"

# 只算不写，看看会改什么
node bin/apply.mjs --plan "<...>" --dry-run

# 退回最近一次快照
node bin/apply.mjs --rollback

# 只做进程检查
node bin/apply.mjs --guard-only --profile desktop

# 装前自检（清单不变式 + 真加载；也可以对别的插件目录用 --dir）
node bin/check.mjs
```

退出码（方便写脚本串起来）：

`bin/plan-cli.mjs`：

| 码 | 含义 |
|---|---|
| 0 | 计划无阻断 |
| 1 | 用法 / 运行时错误 |
| 3 | 有阻断项（**不会**生成 apply.cmd） |

`bin/check.mjs`：0 = 可以装；1 = **不要装**。

`bin/apply.mjs`：

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 用法 / 运行时错误 |
| 2 | 目标端还在运行（或被守卫拦下）—— 退出应用后重跑 |
| 3 | 核对不通过（含 `manifest-only`：manifest 写对了但包没装） |
| 4 | 官方安装通道失败，**已自动回滚**到快照 |

### 面板

左侧栏「插件迁移」：选源/目标 → 算差异 → 生成执行脚本 → 核对上次迁移。
显示每个 profile 的端口和插件数，计划里给出「新增 / 变更 / 仅钉法不同 /
bundle 新增 / allowBuilds 新增 / 阻断 / 提醒」的分项摘要。

### 给 agent 的工具

`profile_sync`，`action` 取 `plan` / `write` / `status` / `profiles`。

---

## 预检会挡住什么

装之前查这五件事（**官方 `dsh plugin add` 不查第 2、3 条**）：

1. **本机路径型 spec**：`link:` / `file:` 指的本机路径是否存在、类型对不对。
2. **cordis entry id 撞车**：两个 bundle 插入同一个 loader entry id 时，
   cordis 会**拒绝启动整棵树**，而不是跳过其中一个。官方通道不查这件事，
   所以必须在装之前自查 —— 这是 `blockers` 里的 `entry-id-collision`。
   只统计 `insert:` 块里的 id：patch 里另一类是「给别人的行改配置」，那类不算。
3. **没有可加载入口的包**：源码签出没有 `lib/` 的包被提升进 bundle 层，
   下一次启动就是 `ERR_MODULE_NOT_FOUND` —— 整个 profile 起不来。
4. **声明了 `dsh.bundle.patch` 吗**：进了 `bundles` 列表却没声明的包，
   官方只会当普通依赖装（并打印同样的警告），不会成为 profile 层。
5. **引擎范围**（建议性）：只认 `>=x.y.z` / `>x.y.z` / `^x.y.z` / 裸版本，
   并且**正确处理预发布号**（这个生态全是 `0.2.0-rc.2`；只比数字三元组会把
   `>=0.2.0-rc.3` 对着 `0.2.0-rc.2` 判成满足）。复合范围老实说「不认识」。
   权威判断交给官方通道。

## 钉法不同 ≠ 版本变更

这台机器上桌面端是**故意**把版本钉成精确号的（`0.11.3`），网页端用的是范围号
（`^0.11.3`）。两者指向同一个版本，只是钉的松紧不同。

朴素 diff 会把它当成「变更」并覆盖掉桌面端那个加固。所以本工具单独归一类
`repin`，**只报告、默认不动**。

## 执行顺序（以及为什么是这个顺序）

```
1. 快照 package.json / pnpm-workspace.yaml / pnpm-lock.yaml
        / cordis.patch.yml / compatibility.json
2. 先合并 allowBuilds   ← 必须在 install 之前，否则 pnpm 静默跳过原生构建
3. 写 pending 日志      ← 必须在 install 之前，进程被杀也还知道「本来期望什么」
4. 原子写 package.json（自己写，见下）
5. dsh plugin --profile <p> install   ← 官方：兼容性校验 + 自动回滚 + reconcile 激活
6. 失败就把快照整个退回去
```

**第 4 步为什么不直接用 `dsh plugin add name@^0.11.3`**：
Windows 上 `dsh` 是 `.cmd`，spawn 必须走 shell，而 cmd.exe 把 `^` 当转义字符 ——
`dsh-x@^0.11.3` 传到 pnpm 手里就成了 `dsh-x@0.11.3`，**静默**把范围号变成精确号。
所以改成自己原子写 manifest（可单测、无转义问题），再让官方做安装。

## 重启后核对

官方 `install` 退出码为 0，只说明 pnpm 装完了 ——
说明不了新 bundle 真的进了加载层（可能没声明 `dsh.bundle`、
可能被上层 patch 覆盖、也可能装完又被兼容性拒绝回滚）。

唯一可信的确认是**下次启动后读 manifest 和 bundles 对一遍**。
`pending.json` 就是那个对账依据，插件在每次启动时自动核对并打印结果。

---

## 状态目录

```
~/.dsh/profile-sync/
  plans/<时间>/     plan.json（可复核）+ plan.txt + apply.cmd
  backups/<时间>/   快照 + meta.json（记着哪些文件原本不存在）
  pending.json      上次 apply 的期望值，重启后用它核对
```

## 测试

```bash
node test-plan.mjs         # 18 项：纯函数 + 合成 fixture + 对真实 profile 算一遍
node test-apply.mjs        #  7 项：快照/回滚/原子写/dry-run/拒绝条件（用合成 profile）
node test-host.mjs         # 12 项：路由与工具契约、客户端席位注册与注销
node test-regressions.mjs  # 13 项：每个用例对应一个**真实修过的 bug**
node test-manifest.mjs     # 14 项：清单不变式 + 真加载（坏包必须被挡住）
node test-managed.mjs      # 15 项：官方管理器解析、进程内应用、HTTP 端点通道
```

共 79 项，都不启动 DSH、不占端口、不跑 pnpm（runner 是注入的假函数）。
`test-apply.mjs` / `test-regressions.mjs` 会在 `~/.dsh/profiles/` 下建
`synctest-*` 合成 profile，跑完删掉 —— 不碰真实的 `web` / `desktop`。

### 客户端启动验证（`bin/verify-client.mjs`）

上面那些测试**碰不到客户端启动审计** —— 而这正是我踩过的坑：宿主半装载成功、
日志一切正常，客户端那一半却是死的，桌面端直接打不开窗口。

```bash
node bin/verify-client.mjs                 # 验本插件
node bin/verify-client.mjs --plugin-dir X  # 验别处一份（阳性对照用）
```

它做的事：建一个**一次性 profile**（名字硬拒绝 `desktop` / `web` / `headless`）→
link 装入目标插件 → 起服务（**加 `--no-open`，绝不许弹用户的浏览器**）→
用无头 Chrome/Edge 的 `--dump-dom` 抓那个页面的真实文本 → 断言
「不含 `did not activate`」且「含面板标签」→ 无论成败都杀进程、删 profile、删浏览器临时目录。

两个实测出来的坑，别改回去：

- **不能加 `--virtual-time-budget`**：页面有 SSE 长连接（HMR 用的），虚拟时间永远
  等不到「网络空闲」，`--dump-dom` 就永不返回（实测 40 秒超时、0 字节）。
- **带 token 的 URL 是异步打印的**：端口先能连上，`?token=…` 那一行稍后才出现。
  早一步拿就只能拿到 `authentication required` 的 222 字节页面。

**它必须配阳性对照才有意义**：先把 `client.js` 的 `inject` 故意改回包名（用一份
临时副本，不碰源码），验证器**必须报失败**；再改回服务名，**必须通过**。
没有这一步，它就可能变成第二个「假安全网」。

### 修过的 bug（`test-regressions.mjs` 盯着不让回来）

1. **面板生成的 `apply.cmd` 会去再启一遍桌面端。** 规划时用的是 `process.execPath`，
   而在 Electron 里那是 `DeepSeek Harness.exe`。这个构建的 `ELECTRON_RUN_AS_NODE=1`
   还是失效的（实测无输出、无退出码 —— 打包时 `RunAsNode` fuse 被关了），
   所以只能去 PATH 上找真 node；找不到就明确报错，**绝不退回应用 exe**。
   （之前测出来是对的，只因为 `plan-cli.mjs` 是在真 node 下跑的，掩盖了这条。）
2. **`--prune` 之后自己报「缺依赖」。** 期望值在 `writePending` 里照计划又推导了一遍，
   而 apply 层是按 `prune` 删的 —— 两份推导逻辑一漂就自己骗自己。
   现在期望值只从「即将写入的那份 manifest」抽一次。
3. **`--no-install` 会在核对时假装「已落地」。** 现在 pending 里如实记 `installed`，
   核对结果多一个 `manifest-only` 状态，明说「包没装」。
4. **目标没有 `pnpm-workspace.yaml` 时会凭空造一个残废文件**（只含 `allowBuilds`，
   丢掉 `nodeLinker: hoisted`，pnpm 会用 isolated 把安装搞坏）。现在跳过并警告。
5. **校验函数自己会崩。** 它先记下「`add` 必须是数组」，然后又拿那个非数组值
   去 `.entries()` —— 校验函数崩了等于没校验。
6. **预发布号被当成不存在。** `>=0.2.0-rc.3` 对着运行时 `0.2.0-rc.2` 会被判成「满足」。
   这个生态全是 rc 版本，属常态；现在按 semver 正确比较预发布段。

## 诚实的边界

- **不自动同步配置层**。`cordis.patch.yml` 只报告差异，这是设计，不是没做完。
- **默认不删目标端多出来的依赖**（只报告）；要删得显式 `--prune`。
- **兼容性判断以官方为准**。本工具的引擎检查是建议性的，读不到运行时版本时说「不知道」。
- **不支持显式目录形式的 profile**。`dsh plugin --profile` 按 profile 名解析目录，
  所以 `apply` 会拒绝目标目录不等于 `profiles/<名字>` 的情况。
- **`allowBuilds` 的 YAML 处理是抄 `dshmarket` 的**（CRLF、作用域包名要加引号、
  已经坏成两个 `allowBuilds:` 块的会合并成一个）。那块被真实 bug 打磨过，不重写。
- **进程守卫靠进程名 + 命令行**。桌面端命令行里没有 `--profile desktop`
  （是 `DeepSeek Harness.exe` + host 脚本），只能按进程名认；两路检查都跑不起来时
  会拒绝并要求 `--yes`，而不是默默继续。
