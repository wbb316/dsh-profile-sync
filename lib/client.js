/**
 * dsh-profile-sync —— 客户端面板
 *
 * 左侧栏加一行「插件迁移」，点开是一个整页面板：选源/目标 profile、算差异、
 * 生成执行脚本、核对上一次迁移是否落地。
 *
 * 走的是 0.2.0 宿主**原生席位**：`sidebar.panellist`（左栏一行）+ `main`（主区页面）。
 * 席位由宿主自带的 shell 插件声明，`slots.inject` 只在席位真被声明后才回调 ——
 * 宿主没这个席位就只是面板不出现，不会拖垮加载。
 *
 * 规矩（照这个 app 里已经跑通的插件写的）：
 *   · React 从浏览器模块表拿（require('react')），不重复安装、不引 CDN
 *   · 不 import 任何 @deepseek-ai/* 客户端包
 *   · 工厂函数里不做副作用；资源在 apply 里用 ctx.effect 注册并返回清理函数
 *   · 样式只注入自己的一份 <style>，容器/控件继承宿主（color: inherit）
 */

window.__ModuleLoader__.load({
  id: 'dsh-profile-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'dsh-profile-sync'
    const PANEL_ORDER = 61
    const LABEL = '插件迁移'

    // 勾选行右侧的动作标签。键必须与 lib/plan.js 里 selectablePlugins() 推的
    // actions 值一致（add / change / repin / bundle / allowBuilds）——
    // 这里只是显示名，不做任何判断。
    const ACTION_LABEL = { add: '新增', change: '变更', repin: '仅钉法', bundle: '启用', allowBuilds: '授权' }

    // 这里写的是**服务名**，不是包名 —— 这个区别是把桌面端搞崩过的地方。
    //
    // 两处 inject 属于两个不同的命名空间，别混：
    //   · package.json 的 `dsh.client.inject` → **包名行**（要先注册的模块）
    //   · 客户端半返回的 `inject`             → **服务名**（fiber 依赖的服务）
    // slot 目录里 ~50 处例子全写 `inject: ['slots']`，dsh-cordis-client-runner 的
    // 报错文案也明说 "service ... is not declared by your plugin"。
    //
    // 我原先照抄了 dsh-novel 的写法（那儿写的是包名），结果这个 fiber 永远在等一个
    // 名为 `@deepseek-ai/dsh-client-ui-slots` 的**服务**，客户端启动审计因此报
    // "1 entry did not activate"，桌面端直接拒绝开窗口。而宿主侧一切正常 ——
    // 所以只看服务端日志根本发现不了。
    const inject = ['slots']

    // ─────────────────────────── 样式 ───────────────────────────
    const CSS = [
      '.ps_page{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;font-size:13px}',
      '.ps_head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;font-weight:600;border-bottom:1px solid rgba(128,128,128,.25)}',
      '.ps_pick{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid rgba(128,128,128,.18)}',
      '.ps_sel{font:inherit;font-size:12px;padding:3px 7px;border-radius:7px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}',
      '.ps_arrow{opacity:.6}',
      '.ps_btn{cursor:pointer;font:inherit;font-size:12px;padding:3px 10px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}',
      '.ps_btn:hover:not(:disabled){background:rgba(128,128,128,.15)}',
      '.ps_btn:disabled{opacity:.45;cursor:default}',
      '.ps_btn.primary{background:#1976d2;border-color:transparent;color:#fff}',
      '.ps_lab{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}',
      '.ps_body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px}',
      '.ps_row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      '.ps_stat{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:2px 8px;border-radius:999px;background:rgba(128,128,128,.13)}',
      '.ps_stat b{font-weight:600}',
      '.ps_stat.add{background:rgba(46,125,50,.16)}',
      '.ps_stat.warn{background:rgba(255,152,0,.18)}',
      '.ps_stat.bad{background:rgba(192,57,43,.16)}',
      '.ps_picklist{margin:8px 0;border:1px solid rgba(128,128,128,.22);border-radius:8px;overflow:hidden}',
      '.ps_pickhead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 9px;background:rgba(128,128,128,.09);font-size:11.5px}',
      '.ps_pickhead .ps_btn{padding:1px 7px;font-size:11px}',
      '.ps_plist{max-height:238px;overflow:auto}',
      '.ps_prow{display:flex;align-items:center;gap:8px;padding:4px 9px;font-size:12px;border-top:1px solid rgba(128,128,128,.12);cursor:pointer}',
      '.ps_prow:hover{background:rgba(128,128,128,.07)}',
      '.ps_prow input{margin:0;flex:0 0 auto;cursor:pointer}',
      '.ps_pname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:11.5px}',
      '.ps_pacts{display:flex;gap:4px;flex:0 0 auto}',
      '.ps_act{font-size:10.5px;padding:1px 5px;border-radius:999px;background:rgba(128,128,128,.16);white-space:nowrap}',
      '.ps_act.add{background:rgba(46,125,50,.2)}',
      '.ps_act.change{background:rgba(255,152,0,.22)}',
      '.ps_act.bundle{background:rgba(25,118,210,.2)}',
      '.ps_act.allowBuilds{background:rgba(128,128,128,.2)}',
      '.ps_act.repin{background:rgba(128,128,128,.12)}',
      '.ps_msg{margin:6px 0;padding:7px 9px;border-radius:7px;font-size:11.5px;line-height:1.65}',
      '.ps_msg.err{background:rgba(192,57,43,.14);color:#c0392b}',
      '.ps_msg.ok{background:rgba(46,125,50,.14);color:#2e7d32}',
      '.ps_msg.warn{background:rgba(255,152,0,.14);color:#b26a00}',
      '.ps_msg.info{background:rgba(128,128,128,.13)}',
      '.ps_pre{margin:8px 0 0;padding:9px 10px;white-space:pre-wrap;word-break:break-word;font:12px/1.7 ui-monospace,"Cascadia Mono",Consolas,"Microsoft YaHei",monospace;border-radius:8px;background:rgba(128,128,128,.08)}',
      '.ps_steps{margin:10px 0 0;padding:9px 10px;border-radius:8px;background:rgba(25,118,210,.09);font-size:12px;line-height:1.85}',
      '.ps_steps code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;background:rgba(128,128,128,.18);padding:1px 4px;border-radius:4px;word-break:break-all}',
      '.ps_mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;word-break:break-all}',
      '.ps_ph{padding:10px 12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.7;font-size:12px}',
      '.ps_foot{padding:7px 12px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#999);border-top:1px solid rgba(128,128,128,.18)}',
    ].join('\n')

    let cssDone = false
    function ensureCss() {
      if (cssDone || typeof document === 'undefined') return
      cssDone = true
      const tag = document.createElement('style')
      tag.setAttribute('data-dsh-profile-sync', '1')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ─────────────────────────── 宿主接口 ───────────────────────────

    /**
     * 把失败响应变成一句**有信息量**的话。
     *
     * 宿主各条路由的失败形状并不统一：`get`/`post` 包装器给的是
     * `{ ok:false, message }`，而 apply 那条路给的是 `{ ok:false, reason, text }`。
     * 以前这里只看 `payload.message` —— 于是 apply 的**所有**失败（拿不到管理器、
     * 目标不是当前 profile、官方管理器拒绝、有阻断项）都退化成了同一句
     * 「接口报错」，用户拿不到任何可行动的信息，而真正的原因就躺在 `text` 里。
     */
    function describeFailure(payload, status) {
      const parts = []
      const main = payload && (payload.text || payload.message)
      if (main) parts.push(String(main))
      if (payload && payload.reason) parts.push('（原因：' + payload.reason + '）')
      if (payload && Array.isArray(payload.blockers) && payload.blockers.length > 0) {
        parts.push('阻断项：' + payload.blockers.join('；'))
      }
      if (parts.length === 0) return '接口报错（HTTP ' + status + '，且响应里没有 text / message / reason）'
      return parts.join('\n')
    }

    async function api(path, body) {
      const init =
        body === undefined
          ? undefined
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      let res
      try {
        res = await fetch('/profile-sync/api' + path, init)
      } catch (e) {
        throw new Error('连不上 DSH：' + String((e && e.message) || e))
      }
      let payload = null
      try {
        payload = await res.json()
      } catch {
        throw new Error('接口返回的不是 JSON（HTTP ' + res.status + '）')
      }
      if (payload && payload.ok === false) throw new Error(describeFailure(payload, res.status))
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return payload
    }

    function Stat(props) {
      return h('span', { className: 'ps_stat ' + (props.tone || '') }, props.label, h('b', null, String(props.value)))
    }

    // ─────────────────────────── 图标 ───────────────────────────
    function SyncIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M2.5 6.2h8.2' }),
        h('path', { d: 'M8.6 4.1 10.9 6.2 8.6 8.3' }),
        h('path', { d: 'M13.5 9.8H5.3' }),
        h('path', { d: 'M7.4 7.7 5.1 9.8 7.4 11.9' })
      )
    }

    // ─────────────────────────── 主面板 ───────────────────────────
    function Panel() {
      const [profiles, setProfiles] = useState([])
      const [source, setSource] = useState('')
      const [target, setTarget] = useState('')
      const [plan, setPlan] = useState(null)
      const [text, setText] = useState('')
      const [artifacts, setArtifacts] = useState(null)
      const [verify, setVerify] = useState(null)
      const [applyResult, setApplyResult] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      // 可勾选的插件行 —— 来自 /plan 的 selectable，算自**未筛选**的完整计划
      const [selectable, setSelectable] = useState([])
      // 勾选状态：null = 还没算过差异；算完差异默认**全勾**，与原先的一键迁移完全一致
      const [checked, setChecked] = useState(null)

      const isChecked = (name) => checked === null || checked.has(name)
      const selectedNames = selectable.filter((r) => isChecked(r.name)).map((r) => r.name)
      const nothingSelected = selectable.length > 0 && selectedNames.length === 0

      // 传给宿主的 only。没算过差异、或本来就没有可勾的插件时不传 —— 不传 = 全部，
      // 也就是老调用方的行为，一个字都不变。
      const onlyArg = () => {
        if (selectable.length === 0 || checked === null) return undefined
        return selectable.filter((r) => checked.has(r.name)).map((r) => r.name)
      }

      const loadProfiles = useCallback(async () => {
        try {
          const data = await api('/profiles')
          const rows = data.profiles || []
          setProfiles(rows)
          const cur = data.current
          setTarget((prev) => prev || cur || (rows[0] && rows[0].name) || '')
          setSource((prev) => {
            if (prev) return prev
            const other = rows.find((r) => r.name !== cur)
            return other ? other.name : ''
          })
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [])

      const refreshStatus = useCallback(async () => {
        try {
          const data = await api('/status')
          setVerify(data.verify && data.verify.state !== 'none' ? data.verify : null)
        } catch {
          /* 状态拿不到就先不显示 */
        }
      }, [])

      useEffect(() => {
        ensureCss()
        loadProfiles()
        refreshStatus()
      }, [loadProfiles, refreshStatus])

      const doPlan = useCallback(async () => {
        setBusy('plan')
        setError('')
        setArtifacts(null)
        try {
          const data = await api(`/plan?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`)
          setPlan(data.plan)
          setText(data.text || '')
          const rows = Array.isArray(data.selectable) ? data.selectable : []
          setSelectable(rows)
          // 每次算差异都重置成全勾：这样「算差异 → 直接应用」还是原来的一键迁移
          setChecked(new Set(rows.map((r) => r.name)))
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }, [source, target])

      const doWrite = useCallback(async () => {
        setBusy('write')
        setError('')
        try {
          const data = await api('/write', { source, target, only: onlyArg() })
          setPlan(null)
          setSelectable([])
          setChecked(null)
          setText(data.text || '')
          setArtifacts(data)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }, [source, target, selectable, checked])

      const doApply = useCallback(async () => {
        setBusy('apply')
        setError('')
        setApplyResult(null)
        try {
          const data = await api('/apply', { source, target, only: onlyArg() })
          setApplyResult(data)
          // 应用之后计划就过期了：清掉旧报告和旧勾选，让用户重新算
          setPlan(null)
          setSelectable([])
          setChecked(null)
          setArtifacts(null)
          setText('')
          await refreshStatus()
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }, [source, target, refreshStatus, selectable, checked])

      const doStatus = useCallback(async () => {
        setBusy('status')
        setError('')
        try {
          await refreshStatus()
        } finally {
          setBusy('')
        }
      }, [refreshStatus])

      const opts = profiles.map((p) => h('option', { key: p.name, value: p.name }, `${p.name}${p.port ? ` (${p.port})` : ''}`))

      const canRun = source !== '' && target !== '' && source !== target && busy === ''

      return h(
        'div',
        { className: 'ps_page', 'data-dsh-plugin': PANEL_ID },
        h(
          'div',
          { className: 'ps_head' },
          h('span', null, LABEL),
          h(
            'button',
            { className: 'ps_btn', onClick: doStatus, disabled: busy !== '' },
            busy === 'status' ? '核对中…' : '核对上次迁移'
          )
        ),

        h(
          'div',
          { className: 'ps_pick' },
          h('span', { className: 'ps_lab' }, '源'),
          h('select', { className: 'ps_sel', value: source, onChange: (e) => setSource(e.target.value) }, opts),
          h('span', { className: 'ps_arrow' }, '→'),
          h('span', { className: 'ps_lab' }, '目标'),
          h('select', { className: 'ps_sel', value: target, onChange: (e) => setTarget(e.target.value) }, opts),
          h('button', { className: 'ps_btn primary', onClick: doPlan, disabled: !canRun }, busy === 'plan' ? '计算中…' : '算差异'),
          h(
            'button',
            {
              className: 'ps_btn primary',
              onClick: doApply,
              disabled: !canRun || nothingSelected,
              title: nothingSelected ? '先在下面的列表里勾选要迁移的插件' : '只迁移勾选的插件',
            },
            busy === 'apply' ? '应用中…' : '应用（当场生效）'
          ),
          h(
            'button',
            {
              className: 'ps_btn',
              onClick: doWrite,
              disabled: !canRun || nothingSelected,
              title: nothingSelected
                ? '先在下面的列表里勾选要迁移的插件'
                : '生成的 plan.json / apply.cmd 只包含勾选的插件',
            },
            busy === 'write' ? '生成中…' : '生成执行脚本'
          )
        ),

        error !== '' ? h('div', { className: 'ps_msg err' }, error) : null,

        applyResult !== null
          ? h(
              'div',
              { className: 'ps_msg ' + (applyResult.ok ? 'ok' : 'warn') },
              h('div', null, applyResult.text || (applyResult.ok ? '✓ 已应用。' : '✗ 未应用。')),
              applyResult.reason === 'no-manager'
                ? h('div', { style: { marginTop: 4 } }, '拿不到官方插件管理器时不会退回 CLI —— 桌面端禁止 CLI，请改用「生成执行脚本」。')
                : null,
              applyResult.reason === 'not-app-owned'
                ? h('div', { style: { marginTop: 4 } }, '目标不是当前应用自有的 profile，请改用「生成执行脚本」。')
                : null
            )
          : null,

        verify !== null
          ? h(
              'div',
              { className: 'ps_msg ' + (verify.state === 'match' ? 'ok' : 'warn') },
              verify.state === 'match'
                ? `✓ 上一次迁移已落地（目标 ${verify.pending && verify.pending.target ? verify.pending.target.name : '?'}）。`
                : verify.state === 'manifest-only'
                  ? `△ manifest 写对了，但那次 apply 用了 --no-install，包并没有真的装。要装上：dsh plugin --profile ${verify.pending && verify.pending.target ? verify.pending.target.name : '?'} install`
                  : `✗ 上一次迁移没完全落地：缺依赖 ${verify.missingDeps.length}、版本不符 ${verify.driftedDeps.length}、缺 bundle ${verify.missingBundles.length}。`
            )
          : null,

        h(
          'div',
          { className: 'ps_body' },
          plan === null && text === ''
            ? h(
                'div',
                { className: 'ps_ph' },
                '选好源和目标，点「算差异」——算完会列出这次要迁移的插件，默认全勾，',
                '想只搬几个就取消勾选其余的。',
                h('br'),
                h('br'),
                '「应用（当场生效）」走应用内官方管理器，只能写当前这个应用自己的 profile；',
                '目标若是别的 profile，请用「生成执行脚本」，等目标端完全退出后双击执行 ——',
                '那是为了避开 Windows 上已加载原生模块的 EPERM，以及正在运行的 loader 早已挂好旧模块图的问题。'
              )
            : null,

          plan !== null
            ? h(
                'div',
                { className: 'ps_row' },
                h(Stat, { label: '新增 ', value: plan.add.length, tone: plan.add.length > 0 ? 'add' : '' }),
                h(Stat, { label: '变更 ', value: plan.change.length }),
                h(Stat, { label: '仅钉法 ', value: plan.repin.length }),
                h(Stat, { label: 'bundle+ ', value: plan.bundles.add.length, tone: plan.bundles.add.length > 0 ? 'add' : '' }),
                h(Stat, { label: 'allowBuilds+ ', value: plan.allowBuilds.add.length }),
                plan.blockers.length > 0
                  ? h(Stat, { label: '阻断 ', value: plan.blockers.length, tone: 'bad' })
                  : h(Stat, { label: '提醒 ', value: plan.warnings.length, tone: plan.warnings.length > 0 ? 'warn' : '' })
              )
            : null,

          plan !== null && selectable.length > 0
            ? h(
                'div',
                { className: 'ps_picklist' },
                h(
                  'div',
                  { className: 'ps_pickhead' },
                  h('span', null, `要迁移的插件：已勾 ${selectedNames.length}/${selectable.length}`),
                  h('button', { className: 'ps_btn', onClick: () => setChecked(new Set(selectable.map((r) => r.name))) }, '全选'),
                  h('button', { className: 'ps_btn', onClick: () => setChecked(new Set()) }, '全不选'),
                  h(
                    'button',
                    {
                      className: 'ps_btn',
                      onClick: () =>
                        setChecked(
                          new Set(
                            selectable
                              .filter((r) => r.actions.includes('add') || r.actions.includes('change'))
                              .map((r) => r.name)
                          )
                        ),
                    },
                    '只勾新增/变更'
                  )
                ),
                h(
                  'div',
                  { className: 'ps_plist' },
                  ...selectable.map((r) =>
                    h(
                      'label',
                      { className: 'ps_prow', key: r.name },
                      h('input', {
                        type: 'checkbox',
                        checked: isChecked(r.name),
                        onChange: () =>
                          setChecked((prev) => {
                            const next = new Set(prev === null ? selectable.map((x) => x.name) : prev)
                            if (next.has(r.name)) next.delete(r.name)
                            else next.add(r.name)
                            return next
                          }),
                      }),
                      h('span', { className: 'ps_pname', title: r.spec ? `${r.name}  ${r.spec}` : r.name }, r.name),
                      h(
                        'span',
                        { className: 'ps_pacts' },
                        ...r.actions.map((a) => h('span', { className: 'ps_act ' + a, key: a }, ACTION_LABEL[a] || a))
                      )
                    )
                  )
                )
              )
            : null,

          nothingSelected
            ? h('div', { className: 'ps_msg err' }, '一个插件都没勾 —— 这次不会迁移任何东西。')
            : null,

          plan !== null && selectable.length > 0 && selectedNames.length < selectable.length
            ? h(
                'div',
                { className: 'ps_msg info' },
                `上面那排数字是「完整计划」的（共 ${selectable.length} 个插件）；没勾的 ${selectable.length - selectedNames.length} 个这次不会迁移。`
              )
            : null,

          plan !== null && plan.blockers.length > 0
            ? h(
                'div',
                { className: 'ps_msg err' },
                '有阻断项，不会生成执行脚本：',
                ...plan.blockers.map((b, i) => h('div', { key: i }, '· ' + b.message))
              )
            : null,

          artifacts !== null
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'ps_msg ' + (artifacts.cmdFile ? 'ok' : 'warn') },
                  artifacts.cmdFile
                    ? '已生成执行脚本。'
                    : `有 ${artifacts.blockers ? artifacts.blockers.length : 0} 个阻断项，只写了计划文件。`
                ),
                h(
                  'div',
                  { className: 'ps_steps' },
                  h('div', null, '下一步：'),
                  h('div', null, '1. 把 DeepSeek Harness 完全退出（托盘也退掉）'),
                  h('div', null, '2. 双击 ', h('code', null, artifacts.cmdFile || '(未生成)')),
                  h('div', null, '3. 重新打开桌面端 —— 它会自动核对这次迁移；也可以回到本面板点「核对上次迁移」')
                ),
                artifacts.cmdFile
                  ? h(
                      'div',
                      { style: { marginTop: 8 } },
                      h(
                        'button',
                        {
                          className: 'ps_btn',
                          onClick: () => {
                            try {
                              navigator.clipboard.writeText(artifacts.cmdFile)
                            } catch {
                              /* 剪贴板不可用就算了 */
                            }
                          },
                        },
                        '复制脚本路径'
                      )
                    )
                  : null
              )
            : null,

          text !== '' ? h('pre', { className: 'ps_pre' }, text) : null
        ),

        h(
          'div',
          { className: 'ps_foot' },
          '同步范围：dependencies + dsh.profile.bundles + allowBuilds，且只针对勾选的插件。',
          h('br'),
          '取消勾选 = 那个插件这次不迁（它的 bundle 启用项和 allowBuilds 授权也跟着不迁，不会单独漏进去）。',
          h('br'),
          'cordis.patch.yml 里的实例配置（端口、坐标、地址）只报告差异，绝不自动抄 —— 那会直接端口冲突。'
        )
      )
    }

    /** 主区页面：只有「插件迁移」被选中时宿主才挂载它 */
    function PanelPage() {
      return h('div', { className: 'ps_page', 'data-dsh-plugin': PANEL_ID }, h(Panel))
    }

    function apply(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.warn('[dsh-profile-sync] 宿主没有 slots 服务，面板未注册')
        return
      }
      const register = () => {
        const disposers = []
        disposers.push(
          slots.inject('sidebar.panellist', () =>
            slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => LABEL },
              SyncIcon
            )
          )
        )
        disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, PanelPage)))
        return () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              /* 注销失败不该影响别的 */
            }
          }
        }
      }
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-profile-sync: 原生面板席位')
      else register()
      console.log('[dsh-profile-sync] 面板已注册到宿主原生席位（左侧栏「' + LABEL + '」）')
    }

    return { apply, inject }
  },
})
