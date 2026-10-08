/**
 * dsh-account-bridge 的网页客户端插件：设置页里的「账号池」面板。
 *
 * 这是一个**手写的**客户端模块，不经 esbuild。原因很实际：本仓库没有构建链，
 * 而客户端模块的格式本身很简单——`window.__ModuleLoader__.load({id, factory})`，
 * `factory` 拿到一个按**模块 id** 解析的 `require`，导出的东西与宿主插件同形
 * （`{ apply, inject }`）。已装的社区插件（cost-meter、reasoning-effort、all-usage）
 * 都是「一道 esbuild 把同样的东西压成一行」，格式本身没有别的秘密。
 *
 * 三件必须照做的事（错一条面板就整个不出现）：
 * 1. **`inject` 里必须有 `'slots'`**，否则 `apply` 不会跑。
 * 2. **必须用 `ctx.slots.inject(name, cb)` 再注册**。`settings.section` 是设置壳
 *    （`dsh-client-ui-settings-general`）声明的 list 席位；在它声明之前注册会抛
 *    `slot "…" is not declared`，`slots.inject` 就是等那个声明。
 * 3. **`id` 必须有**（list 席位的注册强制要求），否则导航行拿不到 key。
 *
 * 数据面走自己开的 HTTP 路由（见 src/api.js）。**路径是文档相对的，不能带前导斜杠**：
 * GUI 由 `<base href="./">` 提供，带斜杠会逃出 base 前缀，请求永远到不了宿主路由。
 * @module dsh-account-bridge/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-account-bridge',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')

    /** 席位名。 */
    const SETTINGS_SLOT = 'settings.section'

    /** 数据面的基地址：**文档相对**，不带前导斜杠。 */
    const API = 'account-bridge'

    // ---------------------------------------------------------------- 通信

    /**
     * 打一次数据面。
     * 永远不抛：网络断/宿主没挂上路由/信封坏了，都变成 `{ok:false, error}`。
     * 面板上一条明确的错误，比一个白屏有用得多。
     */
    async function call(action, body) {
      let response
      try {
        response = await fetch(`${API}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
      } catch (error) {
        return { ok: false, error: { code: 'TRANSPORT', message: `连不上插件的数据面：${String(error?.message ?? error)}` } }
      }
      let envelope
      try {
        envelope = await response.json()
      } catch {
        return { ok: false, error: { code: 'TRANSPORT', message: `数据面返回了非 JSON（HTTP ${response.status}）` } }
      }
      if (!envelope || typeof envelope !== 'object') {
        return { ok: false, error: { code: 'TRANSPORT', message: '数据面返回了空信封' } }
      }
      if (envelope.ok === true) return { ok: true, value: envelope.value }
      return { ok: false, error: envelope.error ?? { code: 'UNKNOWN', message: '未知错误' } }
    }

    // ---------------------------------------------------------------- 小工具

    const h = React.createElement

    /** 剩余比例 → 文案。`undefined` 是「查不到」，与 0% 分开。 */
    function percentText(fraction) {
      if (!Number.isFinite(fraction)) return '未知'
      return `${Math.round(fraction * 100)}%`
    }

    /** 时间戳 → 「2h14m 后」这种人话。 */
    function untilText(at) {
      if (!Number.isFinite(at)) return undefined
      const remaining = at - Date.now()
      if (remaining <= 0) return '已到期'
      // 先按秒判，再进分钟：`Math.round(30_000 / 60_000)` 是 1，
      // 直接算分钟会把「还有 30 秒」说成「1 分钟后」。
      if (remaining < 60_000) return `${Math.max(1, Math.round(remaining / 1000))} 秒后`
      const minutes = Math.round(remaining / 60_000)
      if (minutes < 90) return `${minutes} 分钟后`
      if (minutes < 60 * 36) return `${(minutes / 60).toFixed(1)} 小时后`
      return `${Math.round(minutes / 1440)} 天后`
    }

    /** 一族里最好的剩余额度；全都查不到就返回 undefined。 */
    function bestRemaining(accounts) {
      let best
      for (const account of accounts) {
        const windows = account.quota
        if (!Array.isArray(windows)) continue
        for (const window of windows) {
          if (!Number.isFinite(window.remainingFraction)) continue
          if (best === undefined || window.remainingFraction < best) best = window.remainingFraction
        }
      }
      return best
    }

    /** 一个额度窗口的进度条。 */
    function QuotaBar({ window: quotaWindow }) {
      const fraction = Number.isFinite(quotaWindow.remainingFraction) ? quotaWindow.remainingFraction : undefined
      const reset = untilText(quotaWindow.resetAt)
      const filled = fraction === undefined ? 0 : Math.max(0, Math.min(1, fraction))
      // 剩余低于 15% 标红——这就是「该换号了」的那条线。
      const tone = fraction === undefined ? 'dab-unknown' : fraction <= 0.15 ? 'dab-low' : fraction <= 0.4 ? 'dab-mid' : 'dab-ok'
      return h(
        'span',
        { className: `dab-quota ${tone}`, title: reset ? `${quotaWindow.name ?? quotaWindow.id} · ${reset}重置` : quotaWindow.name ?? quotaWindow.id },
        h('span', { className: 'dab-quota-name' }, quotaWindow.name ?? quotaWindow.id),
        h('span', { className: 'dab-bar' }, h('span', { className: 'dab-bar-fill', style: { width: `${filled * 100}%` } })),
        h('span', { className: 'dab-quota-pct' }, percentText(fraction)),
        reset ? h('span', { className: 'dab-quota-reset' }, `⟳${reset}`) : null,
      )
    }

    /** 一个小按钮。 */
    function Button({ onClick, disabled, tone, children, title }) {
      return h(
        'button',
        {
          type: 'button',
          className: `dab-btn${tone ? ` dab-btn-${tone}` : ''}`,
          onClick,
          disabled: disabled === true,
          title,
        },
        children,
      )
    }

    // ---------------------------------------------------------------- 面板

    /**
     * 「账号池」设置段。
     *
     * 数据只在挂载时取一次，其余靠显式按钮触发——这个面板每动一次都会真的去
     * 打上游（登录、续期、查额度），做成自动轮询等于把用户的账号拿去刷风控。
     * 唯一的例外是登录进行中：那是一个**跨进程、跨分钟**的状态，必须自动跟。
     */
    function AccountPoolSection() {
      const [snapshot, setSnapshot] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [busy, setBusy] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [discovery, setDiscovery] = React.useState(undefined)
      const [proxyDraft, setProxyDraft] = React.useState(undefined)

      const load = React.useCallback(async () => {
        const answer = await call('state')
        if (answer.ok) {
          setSnapshot(answer.value.families)
          setError(undefined)
        } else {
          setError(answer.error)
        }
        return answer
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      /** 有没有登录在跑——决定要不要开轮询。 */
      const loginRunning = Array.isArray(snapshot)
        && snapshot.some((family) => family.login?.status === 'running')

      React.useEffect(() => {
        if (!loginRunning) return undefined
        const timer = setInterval(() => {
          void load()
        }, 2000)
        return () => clearInterval(timer)
      }, [loginRunning, load])

      /** 跑一个动作，然后刷新。 */
      const run = React.useCallback(
        async (label, action, body, { refresh = true } = {}) => {
          setBusy(label)
          setNotice(undefined)
          const answer = await call(action, body)
          if (!answer.ok) {
            setError(answer.error)
          } else {
            setError(undefined)
            if (refresh) await load()
          }
          setBusy(undefined)
          return answer
        },
        [load],
      )

      const onLogin = async (family, method) => {
        const answer = await run(`login:${family}`, 'login', { family, method })
        if (answer.ok) setNotice(`已发起 ${family} 的登录，按提示在浏览器里完成即可（这个面板会自动跟到结束）。`)
      }

      const onDiscover = async (family) => {
        setBusy(`discover:${family ?? '*'}`)
        const answer = await call('discover', family ? { family } : {})
        setBusy(undefined)
        if (answer.ok) {
          setDiscovery(answer.value)
          setError(undefined)
        } else {
          setError(answer.error)
        }
      }

      const onImport = async () => {
        const answer = await run('import', 'import', {})
        if (answer.ok) {
          const imported = answer.value.imported
          setNotice(imported.length > 0 ? `已导入 ${imported.length} 个账号：${imported.map((entry) => entry.id).join(', ')}` : '没有可导入的新账号。')
          setDiscovery(undefined)
        }
      }

      const onRemove = (account) => {
        if (!window.confirm(`删除账号 ${account.id}？凭据会被一并删掉。`)) return
        void run(`remove:${account.id}`, 'remove', { account: account.id })
      }

      const onRefreshAccount = async (account) => {
        const answer = await run(`refresh:${account.id}`, 'refresh', { account: account.id })
        if (answer.ok) setNotice(`${account.id} 已续期${answer.value.expiresAt ? `，有效至 ${new Date(answer.value.expiresAt).toLocaleString()}` : ''}。`)
      }

      const onProxy = async (account, value) => {
        const answer = await run(`proxy:${account.id}`, 'proxy', { account: account.id, proxy: value })
        setProxyDraft(undefined)
        if (answer.ok) setNotice(value ? `${account.id} 的出口代理已设为 ${value}` : `${account.id} 的出口代理已取消。`)
      }

      // ---- 渲染

      if (error && snapshot === undefined) {
        return h(
          'div',
          { className: 'dab-root' },
          h('div', { className: 'dab-error' }, `账号池读取失败：${error.message}`),
          h(Button, { onClick: () => void load() }, '重试'),
        )
      }

      if (snapshot === undefined) {
        return h('div', { className: 'dab-root dab-muted' }, '正在读取账号池…')
      }

      const totalAccounts = snapshot.reduce((sum, family) => sum + family.accounts.length, 0)

      return h(
        'div',
        { className: 'dab-root' },
        h(
          'div',
          { className: 'dab-toolbar' },
          h('span', { className: 'dab-title' }, `账号池 · ${snapshot.length} 族 / ${totalAccounts} 个账号`),
          h('span', { className: 'dab-spacer' }),
          h(Button, { onClick: () => void load(), disabled: busy !== undefined }, '刷新'),
          h(
            Button,
            { onClick: () => void run('check', 'check', {}), disabled: busy !== undefined, title: '逐账号向上游查额度，会真的发请求' },
            busy === 'check' ? '检查中…' : '检查额度',
          ),
        ),

        notice ? h('div', { className: 'dab-notice' }, notice) : null,
        error ? h('div', { className: 'dab-error' }, `${error.code}：${error.message}`) : null,

        discovery
          ? h(
              'div',
              { className: 'dab-discovery' },
              h('div', { className: 'dab-discovery-head' }, '本机客户端扫描结果'),
              discovery.importable.length === 0 && discovery.blocked.length === 0
                ? h('div', { className: 'dab-muted' }, '没扫到可用的登录态。')
                : null,
              ...discovery.importable.map((entry) =>
                h(
                  'div',
                  { className: 'dab-discovery-row', key: `${entry.family}:${entry.sourcePath}` },
                  h('span', { className: 'dab-badge dab-badge-ok' }, entry.family),
                  h('span', {}, entry.label ?? '未命名'),
                  entry.alreadyImported ? h('span', { className: 'dab-muted' }, '已导入') : null,
                  h('span', { className: 'dab-muted dab-ellipsis', title: entry.sourcePath }, entry.sourcePath),
                ),
              ),
              ...discovery.blocked.map((entry) =>
                h(
                  'div',
                  { className: 'dab-discovery-row dab-muted', key: `blocked:${entry.family}:${entry.sourcePath}` },
                  h('span', { className: 'dab-badge' }, entry.family),
                  h('span', {}, entry.label ?? '未命名'),
                  h('span', { className: 'dab-ellipsis', title: entry.reason }, entry.reason),
                ),
              ),
              h(
                'div',
                { className: 'dab-discovery-actions' },
                h(Button, { onClick: () => void onImport(), disabled: busy !== undefined }, '导入可用的'),
                h(Button, { onClick: () => setDiscovery(undefined) }, '关闭'),
              ),
            )
          : null,

        ...snapshot.map((family) => {
          const best = bestRemaining(family.accounts)
          return h(
            'div',
            { className: 'dab-family', key: family.family },
            h(
              'div',
              { className: 'dab-family-head' },
              h('span', { className: 'dab-family-name' }, family.displayName ?? family.family),
              h('span', { className: 'dab-muted' }, `route ${family.route}`),
              family.risk ? h('span', { className: `dab-badge dab-risk-${family.risk}` }, `风险 ${family.risk}`) : null,
              h('span', { className: 'dab-spacer' }),
              h(
                'span',
                { className: 'dab-muted' },
                `${family.accounts.length} 个账号`,
                family.accounts.length > 0 ? ` · 最佳剩余 ${percentText(best)}` : '',
              ),
              ...(family.loginMethods ?? []).map((method) =>
                h(
                  Button,
                  {
                    key: method.id,
                    onClick: () => void onLogin(family.family, method.id),
                    disabled: busy !== undefined || family.login?.status === 'running',
                    tone: 'primary',
                  },
                  `+ ${method.label ?? method.id}`,
                ),
              ),
              family.discoverable
                ? h(Button, { onClick: () => void onDiscover(family.family), disabled: busy !== undefined }, '从本机导入')
                : null,
            ),

            family.login
              ? h(
                  'div',
                  { className: `dab-login dab-login-${family.login.status}` },
                  h('span', {}, loginStatusText(family.login)),
                  family.login.url
                    ? h('a', { href: family.login.url, target: '_blank', rel: 'noreferrer noopener', className: 'dab-link' }, '打开授权页面')
                    : null,
                  family.login.error ? h('span', { className: 'dab-error-text' }, family.login.error) : null,
                )
              : null,

            family.accounts.length === 0
              ? h(
                  'div',
                  { className: 'dab-empty' },
                  family.discoverable
                    ? '还没有账号。装过这个客户端的话点「从本机导入」能直接捡到登录态；否则点上面的「+ 添加账号」走一遍登录。'
                    : '还没有账号。点上面的「+ 添加账号」开始登录。',
                )
              : null,

            ...family.accounts.map((account) =>
              h(
                'div',
                { className: `dab-account${account.disabled ? ' dab-disabled' : ''}`, key: account.id },
                h(
                  'div',
                  { className: 'dab-account-main' },
                  h('span', { className: 'dab-account-label' }, account.label ?? account.id),
                  h('span', { className: 'dab-muted dab-account-id' }, account.id),
                  h('span', { className: 'dab-badge' }, sourceText(account)),
                  account.externallyOwned ? h('span', { className: 'dab-badge dab-badge-warn', title: '令牌与桌面客户端共用一份，我们会写回' }, '共用') : null,
                  account.status === 'cooling' ? h('span', { className: 'dab-badge dab-badge-warn' }, '冷却中') : null,
                  account.disabled ? h('span', { className: 'dab-badge' }, '已停用') : null,
                  !account.renewable && account.authKind === 'oauth' ? h('span', { className: 'dab-badge dab-badge-warn' }, '不可续期') : null,
                  Number.isFinite(account.expiresAt) && account.expiresAt < Date.now()
                    ? h('span', { className: 'dab-badge dab-badge-warn' }, 'token 已过期')
                    : null,
                  h('span', { className: 'dab-spacer' }),
                  // 没有读数时也要**说出来**。留空会让「还没查」看起来像「查了、是 0」，
                  // 而这两件事对用户的意义完全相反（C3：查不到就显示未知，不许记 0）。
                  (account.quota ?? []).length === 0
                    ? h('span', { className: 'dab-quota dab-unknown' }, h('span', { className: 'dab-quota-name' }, '额度'), h('span', { className: 'dab-quota-pct' }, '未知'))
                    : null,
                  ...(account.quota ?? []).map((quotaWindow) => h(QuotaBar, { window: quotaWindow, key: quotaWindow.id })),
                ),
                h(
                  'div',
                  { className: 'dab-account-actions' },
                  h(Button, { onClick: () => void run(`toggle:${account.id}`, 'toggle', { account: account.id, disabled: !account.disabled }), disabled: busy !== undefined }, account.disabled ? '启用' : '停用'),
                  account.renewable ? h(Button, { onClick: () => void onRefreshAccount(account), disabled: busy !== undefined }, '续期') : null,
                  h(Button, { onClick: () => setProxyDraft(proxyDraft === account.id ? undefined : account.id) }, account.proxy ? '改代理' : '代理'),
                  h(Button, { tone: 'danger', onClick: () => onRemove(account), disabled: busy !== undefined }, '删除'),
                ),
                proxyDraft === account.id
                  ? h(ProxyEditor, {
                      initial: account.proxy ?? '',
                      onSubmit: (value) => void onProxy(account, value),
                      onCancel: () => setProxyDraft(undefined),
                    })
                  : null,
                account.proxy && proxyDraft !== account.id ? h('div', { className: 'dab-muted dab-proxy-hint' }, `出口代理：${account.proxy}`) : null,
              ),
            ),
          )
        }),

        h(
          'div',
          { className: 'dab-foot' },
          '这一页的作用是「谁在池子里、谁还能用」。切号的策略、冷却时长、粘性会话都在插件内部按族自动跑，不需要在这里调。',
        ),
      )
    }

    /** 登录状态一行字。 */
    function loginStatusText(login) {
      switch (login.status) {
        case 'running':
          return login.message ?? (login.url ? '等待你在浏览器里完成授权…' : '正在启动登录流程…')
        case 'authorized':
          return `登录成功${login.accountId ? `，账号 ${login.accountId} 已入池` : ''}。`
        case 'cancelled':
          return '登录已取消。'
        case 'failed':
          return '登录失败。'
        default:
          return String(login.status)
      }
    }

    /** 凭据来源一句话。 */
    function sourceText(account) {
      if (account.source === 'client-import') return '本机导入'
      if (account.source === 'manual') return '手动填写'
      if (account.authKind === 'endpoint') return '端点'
      if (account.authKind === 'apikey') return 'API Key'
      if (account.authKind === 'cli') return '本机 CLI'
      return 'OAuth'
    }

    /** 代理输入框。 */
    function ProxyEditor({ initial, onSubmit, onCancel }) {
      const [value, setValue] = React.useState(initial)
      const submit = () => onSubmit(value.trim())
      return h(
        'div',
        { className: 'dab-proxy-editor' },
        h('input', {
          className: 'dab-input',
          value,
          placeholder: 'http://127.0.0.1:7890（留空 = 不走代理）',
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') onCancel()
          },
        }),
        h(Button, { onClick: submit, tone: 'primary' }, '保存'),
        h(Button, { onClick: onCancel }, '取消'),
      )
    }

    // ---------------------------------------------------------------- 样式

    /**
     * 面板样式。用宿主自己的 CSS 变量（`--dsw-alias-*`），这样深浅色主题不用各写一套；
     * 变量取不到时后面的字面量兜底，面板至少还是能看的。
     */
    const CSS = `
.dab-root{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328)}
.dab-muted{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}
.dab-ellipsis{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}
.dab-spacer{flex:1 1 auto}
.dab-toolbar,.dab-family-head,.dab-account-main,.dab-account-actions,.dab-discovery-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dab-toolbar{padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.dab-title{font-weight:600}
.dab-family{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dab-family-name{font-weight:600}
.dab-account{border-top:1px solid var(--dsw-alias-border-l1,#eceff1);padding-top:8px;display:flex;flex-direction:column;gap:6px}
.dab-account:first-of-type{border-top:0;padding-top:0}
.dab-disabled{opacity:.55}
.dab-account-label{font-weight:500;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-account-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dab-badge{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f0f2f4);color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;white-space:nowrap}
.dab-badge-ok{background:rgba(63,185,80,.14);color:#2da44e}
.dab-badge-warn{background:rgba(210,153,34,.16);color:#9a6700}
.dab-risk-low{background:rgba(63,185,80,.14);color:#2da44e}
.dab-risk-medium{background:rgba(210,153,34,.16);color:#9a6700}
.dab-risk-high{background:rgba(248,81,73,.14);color:#cf222e}
.dab-quota{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}
.dab-bar{display:inline-block;width:72px;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,#e6e8ea);overflow:hidden}
.dab-bar-fill{display:block;height:100%;background:#2da44e}
.dab-mid .dab-bar-fill{background:#d29922}
.dab-low .dab-bar-fill{background:#cf222e}
.dab-unknown .dab-bar-fill{background:#8b949e;width:0!important}
.dab-btn{height:24px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:12px;cursor:pointer}
.dab-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}
.dab-btn:disabled{opacity:.5;cursor:default}
.dab-btn-primary{border-color:transparent;background:#1f6feb;color:#fff}
.dab-btn-primary:hover:not(:disabled){background:#1a60d0}
.dab-btn-danger{border-color:rgba(207,34,46,.4);color:#cf222e}
.dab-error,.dab-notice,.dab-discovery,.dab-login{border-radius:8px;padding:8px 10px;font-size:12px}
.dab-error{background:rgba(248,81,73,.1);color:#cf222e}
.dab-notice{background:rgba(31,111,235,.1);color:#1f6feb}
.dab-discovery{background:var(--dsw-alias-bg-layer-2,#f6f8fa);display:flex;flex-direction:column;gap:6px}
.dab-discovery-head{font-weight:600;font-size:12px}
.dab-discovery-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dab-login{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-2,#f6f8fa)}
.dab-login-running{background:rgba(31,111,235,.1)}
.dab-login-failed{background:rgba(248,81,73,.1)}
.dab-link{color:#1f6feb;text-decoration:none}
.dab-link:hover{text-decoration:underline}
.dab-empty{padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}
.dab-proxy-editor{display:flex;align-items:center;gap:8px}
.dab-input{flex:1 1 auto;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:12px}
.dab-proxy-hint{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dab-foot{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb);padding-top:8px}
`

    // ---------------------------------------------------------------- 插件

    /** 客户端服务依赖。少一个 `apply` 就不会跑，所以只列真正要用的。 */
    const inject = ['slots']

    function apply(ctx) {
      // 样式挂到 document.head，卸载时摘掉。这是客户端插件的社区惯例
      // （宿主不给插件样式隔离，所以类名统一加前缀）。
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-account-bridge'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'account-bridge: styles')

      // `slots.inject` 等的是**席位声明**，不是服务就绪：`settings.section` 由设置壳声明，
      // 声明之前注册会抛 `slot "…" is not declared`。
      ctx.slots.inject(SETTINGS_SLOT, () =>
        ctx.slots.register(
          {
            name: SETTINGS_SLOT,
            id: 'account-bridge',
            order: 30,
            label: '账号池',
          },
          AccountPoolSection,
        ),
      )
    }

    module.exports = {
      apply,
      inject,
      AccountPoolSection,
      // 纯函数对测试开放。这里不做摇树优化，多这几个属性对体积没有意义，
      // 但「剩余 0%」与「查不到」必须能被单独钉住——它们在面板上是两句话。
      __internal: { call, percentText, untilText, bestRemaining, loginStatusText, sourceText, API, SETTINGS_SLOT },
    }
    return module.exports
  },
})
