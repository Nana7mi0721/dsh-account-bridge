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
 *
 * 视觉上走 macOS 27（Liquid Glass），按 `macos-27-ui-design` 技能包的六步流程做：
 * 表面＝内容区（所以没有玻璃工具栏），窗口骨架＝侧栏里的一个设置段，组件全部取自
 * 那套量测过的 `.mac-*` 类。样式在这个文件里分成两段——`MAC_THEME_CSS` 是**生成物**
 * （Apple macOS 27 UI Kit 的 token 与组件几何，由 `_dsh_research/mac/gen_subset.py` 裁
 * 出来，不要手改），`CSS` 是面板自己那一层（只加布局与语义色）。没有构建链，
 * 也没有外链样式表：两段都是本文件里的字符串常量。
 *
 * 生成来源、哪些是量测值、以及「改了什么」见 THIRD_PARTY_NOTICES.md 的「面板主题」一节。
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
    /** 设置 → 模型 → 每张 provider 卡片下方的扩展位（keyed，key = settingsNs）。 */
    const PROVIDER_CARD_SLOT = 'settings.models.provider-card'
    /** 设置 → 模型 页脚（list 席位）。 */
    const MODELS_FOOTER_SLOT = 'settings.models.footer'

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

    // ------------------------------------------------- 设置 → 模型 页上的摘要
    //
    // 模型页给每张 provider 卡片留了一个扩展位（`settings.models.provider-card`，
    // keyed 席位，key 是该 provider 的 `settingsNs`）。我们的 11 条 `acct-*` 都**没有**
    // 在「可配置 provider 目录」里声明过，于是 `joinProviderDirectory` 给它们填的
    // `settingsNs` 就是空字符串 ⇒ 用 `key: ''` 注册一条，就能落到所有这些卡片上
    // （组件内部再按 route 过滤，别人的卡片一律返回 null）。
    //
    // 摘要读同一个数据面，但**不自己轮询**：模型页一打开可能有十几张卡片，
    // 每张各打一次 HTTP 就是十几次请求。这里用模块级共享快照，一次取数、
    // 所有卡片订阅，且 30 秒内不重复取。

    const SUMMARY_FRESH_MS = 30_000

    const summaryStore = {
      snapshot: { status: 'idle' },
      at: 0,
      inFlight: undefined,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...this.listeners]) listener()
      },
      /** 取一次账号池快照；同一时刻只有一个请求在飞，30 秒内复用上一次结果。 */
      load(now = Date.now()) {
        if (this.inFlight !== undefined) return this.inFlight
        if (this.snapshot.status === 'ready' && now - this.at < SUMMARY_FRESH_MS) return undefined
        this.inFlight = call('state')
          .then((result) => {
            this.snapshot = result.ok
              ? { status: 'ready', families: result.value?.families ?? [] }
              : { status: 'error', error: result.error }
          })
          .catch((error) => {
            this.snapshot = { status: 'error', error: { code: 'TRANSPORT', message: String(error?.message ?? error) } }
          })
          .then(() => {
            this.at = Date.now()
            this.inFlight = undefined
            this.emit()
          })
        return this.inFlight
      },
    }

    /** 订阅账号池快照；首次挂载时触发一次取数。 */
    function usePoolSummary() {
      const [snapshot, setSnapshot] = React.useState(summaryStore.snapshot)
      React.useEffect(() => {
        const unsubscribe = summaryStore.subscribe(() => setSnapshot(summaryStore.snapshot))
        summaryStore.load()
        setSnapshot(summaryStore.snapshot)
        return unsubscribe
      }, [])
      return snapshot
    }

    /** 一族池子状态的一句话。 */
    function familySummary(family) {
      const accounts = Array.isArray(family?.accounts) ? family.accounts : []
      if (accounts.length === 0) {
        const methods = (family?.loginMethods ?? []).map((method) => method.label).join(' / ')
        return methods === '' ? '还没有账号' : `还没有账号 · 可用登录：${methods}`
      }
      const now = Date.now()
      const disabled = accounts.filter((account) => account.disabled === true).length
      const cooling = accounts.filter((account) => Number.isFinite(account.cooldownUntil) && account.cooldownUntil > now).length
      const best = bestRemaining(accounts.filter((account) => account.disabled !== true))
      const parts = [`${accounts.length} 个账号`]
      if (disabled > 0) parts.push(`${disabled} 个已停用`)
      if (cooling > 0) parts.push(`${cooling} 个冷却中`)
      // 「查不到」与「就是 0%」必须写成两句话（计划书判据 C3）。
      parts.push(best === undefined ? '额度未知' : `最佳剩余 ${percentText(best)}`)
      return parts.join(' · ')
    }

    /** 挂在每一张「非可配置 provider」卡片下方的行内摘要。 */
    function ProviderCardSummary(props) {
      const providerId = props?.provider?.provider
      const snapshot = usePoolSummary()
      // 别人的卡片、以及还没取到数的这段时间，都什么都不画：
      // 模型页出错时该由页脚说一句，而不是在十几张卡片上各喊一遍。
      if (typeof providerId !== 'string' || providerId === '') return null
      if (snapshot.status !== 'ready') return null
      const family = (snapshot.families ?? []).find((candidate) => candidate.route === providerId)
      if (family === undefined) return null
      return h(
        'div',
        { className: 'dab-card-summary mac-text-callout' },
        h('span', { className: 'dab-tag dab-tag--accent' }, '账号池'),
        h('span', null, familySummary(family)),
      )
    }

    /** 模型页页脚：整池的一句话 + 入口提示。 */
    function ModelsFooter() {
      const snapshot = usePoolSummary()
      if (snapshot.status === 'idle') return null
      if (snapshot.status === 'error') {
        return h('div', { className: 'dab-card-summary mac-text-callout dab-note--error-text' }, `账号池读取失败：${snapshot.error?.message ?? '未知错误'}`)
      }
      const families = snapshot.families ?? []
      const accounts = families.flatMap((family) => (Array.isArray(family.accounts) ? family.accounts : []))
      if (accounts.length === 0) {
        return h('div', { className: 'dab-card-summary mac-text-callout' }, '账号池还没有账号 · 在「设置 → 账号池」里登录，或直接问 /pool')
      }
      const now = Date.now()
      const cooling = accounts.filter((account) => Number.isFinite(account.cooldownUntil) && account.cooldownUntil > now).length
      const coolingText = cooling > 0 ? ` · ${cooling} 个冷却中` : ''
      return h(
        'div',
        { className: 'dab-card-summary mac-text-callout' },
        h('span', { className: 'dab-tag dab-tag--accent' }, '账号池'),
        h('span', null, `${families.length} 族 · ${accounts.length} 个账号${coolingText}`),
        h('span', { className: 'dab-note' }, '在「设置 → 账号池」里管理，或问 /pool'),
      )
    }

    /** 一个额度窗口。
     *
     * `--value` 是这套进度条唯一认的自定义属性（fill 的宽度就是它）。
     * 剩余低于 15% 标红——那就是「该换号了」的那条线。
     */
    function QuotaBar({ window: quotaWindow }) {
      const fraction = Number.isFinite(quotaWindow.remainingFraction) ? quotaWindow.remainingFraction : undefined
      const reset = untilText(quotaWindow.resetAt)
      const name = quotaWindow.name ?? quotaWindow.id
      const value = fraction === undefined ? '0%' : `${Math.max(0, Math.min(1, fraction)) * 100}%`
      const tone = fraction === undefined ? 'dab-quota--unknown' : fraction <= 0.15 ? 'dab-quota--low' : fraction <= 0.4 ? 'dab-quota--mid' : ''
      return h(
        'span',
        { className: `dab-quota ${tone}`.trim(), title: reset ? `${name} · ${reset}重置` : name },
        h('span', { className: 'dab-quota__name' }, name),
        h('span', { className: 'mac-progress mac-progress--small dab-quota__bar' }, h('span', { className: 'mac-progress__fill', style: { '--value': value } })),
        h('span', { className: 'dab-quota__pct' }, percentText(fraction)),
        reset ? h('span', { className: 'dab-quota__reset' }, reset) : null,
      )
    }

    /** 一个按钮。默认就是 macOS 内容区里的「灰底」按钮，`tone` 只换语义不换几何。 */
    function Button({ onClick, disabled, tone, children, title, size }) {
      const variant = tone === 'primary' ? 'mac-button--prominent' : tone === 'danger' ? 'mac-button--destructive' : ''
      const className = ['mac-button', variant, size ? `mac-button--${size}` : ''].filter(Boolean).join(' ')
      return h('button', { type: 'button', className, onClick, disabled: disabled === true, title }, children)
    }

    /** 内联 SVG 图标。技能包的两条硬规矩：网页渲染不了 SF Symbols；不许拿 emoji 当图标。 */
    function Icon({ name }) {
      // 图形量测自技能包 references/05-components.md 的图标栅格（16×16，笔画 1.5）。
      const shapes = {
        ellipsis: [
          h('circle', { cx: 3.5, cy: 8, r: 1.25, key: 'a' }),
          h('circle', { cx: 8, cy: 8, r: 1.25, key: 'b' }),
          h('circle', { cx: 12.5, cy: 8, r: 1.25, key: 'c' }),
        ],
      }
      return h('svg', { className: 'mac-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'currentColor', stroke: 'none' }, ...(shapes[name] ?? []))
    }

    /** 每账号的动作菜单。玻璃在 macOS 里只出现在「浮在内容之上」的层——菜单正是那一层。 */
    function RowMenu({ account, disabled, onRefresh, onProxy, onRemove }) {
      const [open, setOpen] = React.useState(false)
      const item = (key, label, run, extra) =>
        h(
          'button',
          {
            type: 'button',
            className: `mac-menu-item${extra ? ` ${extra}` : ''}`,
            key,
            role: 'menuitem',
            disabled: disabled === true,
            onClick: () => {
              setOpen(false)
              run()
            },
          },
          h('span', { className: 'mac-menu-item__label' }, label),
        )
      return h(
        'span',
        { className: 'dab-menu-wrap' },
        h(
          'button',
          {
            type: 'button',
            className: 'mac-button mac-button--borderless',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            title: '更多操作',
            disabled: disabled === true,
            onClick: () => setOpen(!open),
            onKeyDown: (event) => {
              if (event.key === 'Escape') setOpen(false)
            },
          },
          h(Icon, { name: 'ellipsis' }),
        ),
        open
          ? h(
              'div',
              { className: 'mac-menu dab-menu', role: 'menu' },
              account.renewable ? item('refresh', '续期', () => onRefresh(account)) : null,
              item('proxy', account.proxy ? '改代理' : '设置代理', () => onProxy(account)),
              h('div', { className: 'mac-menu__separator', key: 'separator' }),
              item('remove', '删除账号', () => onRemove(account), 'mac-menu-item--destructive'),
            )
          : null,
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
        if (answer.ok) {
          openAuthorizationPage(answer.value?.login)
          setNotice(`已发起 ${family} 的登录，按提示在浏览器里完成即可（这个面板会自动跟到结束）。`)
        }
      }

      /** 把回答送回给正在等它的族。送出之后要紧跟着重新看一次 `state`（`run` 已经做了）。 */
      const onAnswer = async (family, value) => {
        const answer = await run(`answer:${family}`, 'answer', { family, value })
        if (answer.ok) setNotice('已把回答送回去，接着看这一步的结果。')
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
          h('div', { className: 'dab-note dab-note--box dab-note--error' }, `账号池读取失败：${error.message}`),
          h(Button, { onClick: () => void load() }, '重试'),
        )
      }

      if (snapshot === undefined) {
        return h('div', { className: 'dab-root dab-note' }, '正在读取账号池…')
      }

      const totalAccounts = snapshot.reduce((sum, family) => sum + family.accounts.length, 0)
      const cooling = snapshot.reduce((sum, family) => sum + family.accounts.filter((account) => account.status === 'cooling').length, 0)

      return h(
        'div',
        { className: 'dab-root' },
        h(
          'div',
          { className: 'dab-bar' },
          h('span', { className: 'dab-bar__text mac-text-callout' }, `账号池 · ${snapshot.length} 族 / ${totalAccounts} 个账号${cooling > 0 ? ` / ${cooling} 个冷却中` : ''}`),
          h('span', { className: 'dab-spacer' }),
          h(Button, { onClick: () => void load(), disabled: busy !== undefined }, '刷新'),
          h(
            Button,
            { onClick: () => void run('check', 'check', {}), disabled: busy !== undefined, title: '逐账号向上游查额度，会真的发请求' },
            busy === 'check' ? '检查中…' : '检查额度',
          ),
        ),

        notice ? h('div', { className: 'dab-note dab-note--box dab-note--ok' }, notice) : null,
        error ? h('div', { className: 'dab-note dab-note--box dab-note--error' }, `${error.code}：${error.message}`) : null,

        discovery
          ? h(
              'div',
              { className: 'mac-group-box dab-family' },
              h(
                'div',
                { className: 'dab-family__head' },
                h('span', { className: 'mac-text-headline' }, '本机客户端扫描结果'),
                h('span', { className: 'dab-spacer' }),
                h(Button, { onClick: () => void onImport(), disabled: busy !== undefined }, '导入可用的'),
                h(Button, { onClick: () => setDiscovery(undefined) }, '关闭'),
              ),
              discovery.importable.length === 0 && discovery.blocked.length === 0
                ? h('div', { className: 'dab-empty' }, '没扫到可用的登录态。')
                : null,
              discovery.importable.length + discovery.blocked.length > 0
                ? h(
                    'div',
                    { className: 'mac-list' },
                    ...discovery.importable.map((entry) =>
                      h(
                        'div',
                        { className: 'mac-list-row', key: `${entry.family}:${entry.sourcePath}` },
                        h('span', { className: 'mac-list-row__title' }, entry.label ?? '未命名'),
                        h('span', { className: 'dab-tag dab-tag--accent' }, entry.family),
                        entry.alreadyImported ? h('span', { className: 'dab-tag dab-tag--muted' }, '已导入') : null,
                        h('span', { className: 'dab-note dab-mono dab-ellipsis', title: entry.sourcePath }, entry.sourcePath),
                      ),
                    ),
                    ...discovery.blocked.map((entry) =>
                      h(
                        'div',
                        { className: 'mac-list-row', key: `blocked:${entry.family}:${entry.sourcePath}` },
                        h('span', { className: 'mac-list-row__title' }, entry.label ?? '未命名'),
                        h('span', { className: 'dab-tag dab-tag--muted' }, entry.family),
                        h('span', { className: 'dab-note dab-ellipsis', title: entry.reason }, entry.reason),
                      ),
                    ),
                  )
                : null,
            )
          : null,

        ...snapshot.map((family) => {
          const best = bestRemaining(family.accounts)
          const accounts = family.accounts
          const loginRunningHere = family.login?.status === 'running'
          return h(
            'fieldset',
            { className: 'mac-group-box dab-family', key: family.family },
            h('legend', null, family.displayName ?? family.family),
            h(
              'div',
              { className: 'dab-family__head' },
              h('span', { className: 'dab-tag dab-tag--muted dab-mono' }, family.route),
              family.risk ? h('span', { className: `dab-tag dab-tag--${family.risk === 'high' ? 'danger' : family.risk === 'low' ? 'ok' : 'warn'}` }, `风险 ${family.risk}`) : null,
              h('span', { className: 'dab-note' }, accounts.length === 0 ? '还没有账号' : `${accounts.length} 个账号 · 最佳剩余 ${percentText(best)}`),
              h('span', { className: 'dab-spacer' }),
              ...(family.loginMethods ?? []).map((method) =>
                h(
                  Button,
                  {
                    key: method.id,
                    onClick: () => void onLogin(family.family, method.id),
                    disabled: busy !== undefined || loginRunningHere,
                  },
                  `+ ${method.label ?? method.id}`,
                ),
              ),
              family.discoverable ? h(Button, { onClick: () => void onDiscover(family.family), disabled: busy !== undefined }, '从本机导入') : null,
            ),

            family.login
              ? h(
                  'div',
                  { className: 'dab-login' },
                  h('span', { className: 'mac-text-callout' }, loginStatusText(family.login)),
                  loginRunningHere
                    ? h('span', { className: 'mac-progress mac-progress--small mac-progress--indeterminate dab-login__bar' }, h('span', { className: 'mac-progress__fill' }))
                    : null,
                  family.login.url
                    ? h('a', { href: family.login.url, target: '_blank', rel: 'noreferrer noopener', className: 'dab-link mac-text-callout' }, '打开授权页面')
                    : null,
                  family.login.error ? h('span', { className: 'dab-note dab-note--error-text' }, family.login.error) : null,
                )
              : null,

            // 族正在等人回答（`state` 里的 `login.prompt`）。就放在状态那一行的下面。
            family.login?.prompt
              ? h(LoginPrompt, {
                  key: 'prompt',
                  prompt: family.login.prompt,
                  busy,
                  onSubmit: (value) => void onAnswer(family.family, value),
                })
              : null,

            accounts.length === 0
              ? h(
                  'div',
                  { className: 'dab-empty' },
                  family.discoverable
                    ? '还没有账号。装过这个客户端的话点「从本机导入」能直接捡到登录态；否则点上面的「+ 添加账号」走一遍登录。'
                    : '还没有账号。点上面的「+ 添加账号」开始登录。',
                )
              : null,

            accounts.length > 0
              ? h(
                  'div',
                  { className: 'mac-list' },
                  ...accounts.map((account) => {
                    const expired = Number.isFinite(account.expiresAt) && account.expiresAt < Date.now()
                    const quota = Array.isArray(account.quota) ? account.quota : []
                    return h(
                      'div',
                      { className: `mac-list-row dab-account${account.disabled ? ' dab-account--off' : ''}`, key: account.id },
                      h(
                        'div',
                        { className: 'dab-account__main' },
                        h('span', { className: 'mac-list-row__title' }, account.label ?? account.id),
                        h(
                          'span',
                          { className: 'dab-account__sub' },
                          h('span', { className: 'dab-mono' }, account.id),
                          h('span', { className: 'dab-tag' }, sourceText(account)),
                          account.externallyOwned
                            ? h('span', { className: 'dab-tag dab-tag--warn', title: '令牌与桌面客户端共用一份，我们会写回' }, '共用')
                            : null,
                          account.status === 'cooling' ? h('span', { className: 'dab-tag dab-tag--warn' }, '冷却中') : null,
                          account.disabled ? h('span', { className: 'dab-tag dab-tag--muted' }, '已停用') : null,
                          !account.renewable && account.authKind === 'oauth' ? h('span', { className: 'dab-tag dab-tag--warn' }, '不可续期') : null,
                          expired ? h('span', { className: 'dab-tag dab-tag--danger' }, 'token 已过期') : null,
                          account.proxy && proxyDraft !== account.id
                            ? h('span', { className: 'dab-note dab-mono dab-ellipsis', title: account.proxy }, `代理 ${account.proxy}`)
                            : null,
                        ),
                        proxyDraft === account.id
                          ? h(ProxyEditor, {
                              initial: account.proxy ?? '',
                              onSubmit: (value) => void onProxy(account, value),
                              onCancel: () => setProxyDraft(undefined),
                            })
                          : null,
                      ),
                      h(
                        'div',
                        { className: 'dab-account__quota' },
                        // 没有读数时也要**说出来**。留空会让「还没查」看起来像「查了、是 0」，
                        // 而这两件事对用户的意义完全相反（C3：查不到就显示未知，不许记 0）。
                        quota.length === 0
                          ? h('span', { className: 'dab-quota dab-quota--unknown' }, h('span', { className: 'dab-quota__name' }, '额度'), h('span', { className: 'dab-quota__pct' }, '未知'))
                          : quota.map((quotaWindow) => h(QuotaBar, { window: quotaWindow, key: quotaWindow.id })),
                      ),
                      h(
                        'div',
                        { className: 'dab-account__actions' },
                        h(
                          'label',
                          {
                            className: 'mac-switch-wrap',
                            title: account.disabled ? '打开后重新往这个账号派请求' : '关掉后不再往这个账号派请求，凭据留在池子里',
                          },
                          h(
                            'span',
                            { className: 'mac-switch' },
                            h('input', {
                              className: 'mac-hidden',
                              type: 'checkbox',
                              role: 'switch',
                              'aria-label': `启用 ${account.label ?? account.id}`,
                              checked: !account.disabled,
                              disabled: busy !== undefined,
                              onChange: () => void run(`toggle:${account.id}`, 'toggle', { account: account.id, disabled: !account.disabled }),
                            }),
                            h('span', { className: 'mac-switch__knob' }),
                          ),
                        ),
                        h(RowMenu, {
                          account,
                          disabled: busy !== undefined,
                          onRefresh: onRefreshAccount,
                          onProxy: (target) => setProxyDraft(proxyDraft === target.id ? undefined : target.id),
                          onRemove,
                        }),
                      ),
                    )
                  }),
                )
              : null,
          )
        }),

        h(
          'div',
          { className: 'dab-foot mac-text-footnote' },
          '这一页的作用是「谁在池子里、谁还能用」。切号的策略、冷却时长、粘性会话都在插件内部按族自动跑，不需要在这里调。',
        ),
      )
    }

    /**
     * 把授权页交给系统浏览器。
     *
     * 用户点的是「在浏览器里登录」，所以面板得**自己**开这一页：只把 URL 画成一个链接
     * 等于让人再点一次，而那条路上没有任何东西会替他开（用户就是这么报的：
     * 「点击按钮后没用正常跳转浏览器进入登录页面」）。
     *
     * 桌面版把 `window.open` 拦成 `shell.openExternal`（系统浏览器），网页版就是新开的
     * 标签页 —— 宿主自己的 markdown 链接走的正是同一条路。实测登录接口 **99ms** 就把
     * URL 交回来，所以这里仍然落在浏览器的「用户手势」窗口里，不会被弹窗拦截吃掉。
     * 真被拦了也不是死路：下面照样画着「打开授权页面」那个链接。
     */
    function openAuthorizationPage(login) {
      const url = login?.url
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch {
        // 弹窗拦截器抛错不影响面板：链接还在。这里吞掉是因为「开不了浏览器」
        // 不是这个面板能修的事，而把异常抛到渲染里会把整块面板打白。
      }
    }

    /** 登录状态一行字。 */
    function loginStatusText(login) {
      switch (login.status) {
        case 'running':
          // 有问题是**最先要说**的事：这时流程停着等人，下面那一行在等一个答案。
          if (login.prompt) return '这条登录在等你回答下面的问题。'
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

    /** 出口代理输入框。 */
    function ProxyEditor({ initial, onSubmit, onCancel }) {
      const [value, setValue] = React.useState(initial)
      const submit = () => onSubmit(value.trim())
      return h(
        'div',
        { className: 'dab-proxy' },
        h(
          'label',
          { className: 'mac-input-wrap dab-field' },
          h('span', null, '出口代理'),
          h('input', {
            className: 'mac-input',
            value,
            placeholder: 'http://127.0.0.1:7890（留空 = 不走代理）',
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') onCancel()
            },
          }),
        ),
        h(Button, { onClick: submit, tone: 'primary' }, '保存'),
        h(Button, { onClick: onCancel }, '取消'),
      )
    }

    /**
     * 登录中间族问的一个问题（粘贴令牌 / 填 baseURL / 选区域）。
     *
     * 面板是**唯一**能回答它的入口：工具与命令行那边没有人可以打字，只会收到一句
     * 「去设置界面做」。所以这里必须真的把答案送回去（`answer` 动作）——只画一行提示
     * 是不行的，那样按钮按下去会永远停在「正在启动登录流程…」。
     */
    function LoginPrompt({ prompt, busy, onSubmit }) {
      const [value, setValue] = React.useState('')
      const options = Array.isArray(prompt.options) ? prompt.options : []
      // 密钥的问题**不回显**。`kind` 是原始声明，`secret` 是快照给的便利字段——
      // 两个都认，免得面板因为少一个字段就把令牌明晃晃地画在屏幕上。
      const secret = prompt.secret === true || prompt.kind === 'secret'
      const submit = (answer) => {
        setValue('')
        void onSubmit(answer)
      }
      return h(
        'div',
        { className: 'dab-prompt' },
        h(
          'span',
          { className: 'mac-text-callout dab-prompt__ask' },
          prompt.message || (prompt.kind === 'select' ? '选一个：' : '填一个值：'),
        ),
        // 选择题：点哪个就是答案，不用再按一次提交。
        options.length > 0
          ? h(
              'span',
              { className: 'dab-prompt__options' },
              ...options.map((option) =>
                h(
                  Button,
                  {
                    key: option.value,
                    size: 'small',
                    disabled: busy !== undefined,
                    onClick: () => submit(option.value),
                  },
                  option.label ?? option.value,
                ),
              ),
            )
          : [
              h(
                'label',
                { key: 'field', className: 'mac-input-wrap dab-field dab-prompt__field' },
                h('span', null, secret ? '粘贴凭据' : '填写'),
                h('input', {
                  className: 'mac-input',
                  type: secret ? 'password' : 'text',
                  value,
                  placeholder: secret ? '粘贴到这里（不回显）' : '',
                  onChange: (event) => setValue(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && value.length > 0) submit(value)
                  },
                }),
              ),
              h(
                Button,
                {
                  key: 'send',
                  tone: 'primary',
                  disabled: busy !== undefined || value.length === 0,
                  onClick: () => submit(value),
                },
                '提交',
              ),
            ],
      )
    }

    // ---------------------------------------------------------------- 样式

    /**
     * 面板样式。
     *
     * 上面那一大块 `MAC_THEME_CSS` 是**生成物**：macOS 27 UI Kit 的量测值——token 层按
     * `var()` 传递闭包裁过，组件层按选择器白名单裁过，规则体逐字照抄。下面这一块是
     * 面板自己的那一层：只加布局与语义色，几何一律用上面那些变量，不自造数值。
     *
     * 两条来自技能包的硬规矩在这里兑现：
     *   · 表面划分（规则 4）：这个面板坐在**内容区**上，所以不该出现的玻璃 chrome
     *     一件都没有（toolbar / material 都没进生成器的白名单）；唯一一处玻璃是
     *     每行的动作菜单，菜单本来就是「浮在内容之上」的那一层。
     *   · 颜色不许写字面量：要么是 token，要么是 `light-dark(系统色亮, 系统色暗)`。
     */
    // >>> BEGIN MAC THEME（生成物；改生成器再重跑，不要手改这两行之间）
  /* ---- 生成物 · macOS 27 主题 ------------------------------------------------
     下面是 `_dsh_research/mac/gen_subset.py` 从 macOS 27 UI Kit 的
     `assets/macos27.css` 里裁出来的那一份：token 层按 var() 传递闭包裁剪，
     组件层按选择器白名单裁剪，**规则体逐字照抄，一个数值都没有改写**。

     不要手改这一段。要换组件、改配色，就改生成器再重跑：
       python _dsh_research/mac/gen_subset.py --emit-js=<这个文件>
     -------------------------------------------------------------------------- */
  const MAC_THEME_CSS = `
/* ==========================================================================
   macOS 27 (Liquid Glass) —— 账号池面板用得到的那一份。

   来源：macos-27-ui-design 技能包的 assets/macos27.css（Apple macOS 27 UI Kit 的
   量测值，676 个 token + 逐组件几何）。本文件由 _dsh_research/mac/gen_subset.py
   生成：按选择器白名单裁剪组件规则、按 var() 传递闭包裁剪 token，
   **规则体逐字照抄，一个数值都没有改写**。

   要动这里的样式，请改生成器再重跑；不要在 src/client.js 里手改下半段。
   ========================================================================== */

/* ---- token 子集：212 个自定义属性 ---- */
:root {
  /* Type — the kit's stack and the five weights */
    --mac-font-sans: "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  --mac-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --mac-weight-medium: 500;
  --mac-weight-bold: 700;
  /* Type — the eleven styles (leading variants are compositional: calc(line ± 2px)) */
    --mac-text-large-title-size: 26px;
  --mac-text-large-title-line: 32px;
  --mac-text-large-title-weight: 400;
  --mac-text-large-title-weight-em: 700;
  --mac-text-title1-size: 22px;
  --mac-text-title1-line: 26px;
  --mac-text-title1-weight: 400;
  --mac-text-title1-weight-em: 700;
  --mac-text-title2-size: 17px;
  --mac-text-title2-line: 22px;
  --mac-text-title2-weight: 400;
  --mac-text-title2-weight-em: 700;
  --mac-text-title3-size: 15px;
  --mac-text-title3-line: 20px;
  --mac-text-title3-weight: 400;
  --mac-text-title3-weight-em: 600;
  --mac-text-headline-size: 13px;
  --mac-text-headline-line: 16px;
  --mac-text-headline-weight: 700;
  --mac-text-headline-weight-em: 800;
  --mac-text-body-size: 13px;
  --mac-text-body-line: 16px;
  --mac-text-body-weight: 400;
  --mac-text-body-weight-em: 600;
  --mac-text-callout-size: 12px;
  --mac-text-callout-line: 15px;
  --mac-text-callout-weight: 400;
  --mac-text-callout-weight-em: 600;
  --mac-text-subheadline-size: 11px;
  --mac-text-subheadline-line: 14px;
  --mac-text-subheadline-weight: 400;
  --mac-text-subheadline-weight-em: 600;
  --mac-text-footnote-size: 10px;
  --mac-text-footnote-line: 13px;
  --mac-text-footnote-weight: 400;
  --mac-text-footnote-weight-em: 600;
  --mac-text-caption1-size: 10px;
  --mac-text-caption1-line: 13px;
  --mac-text-caption1-weight: 400;
  --mac-text-caption1-weight-em: 600;
  --mac-text-caption2-size: 10px;
  --mac-text-caption2-line: 13px;
  --mac-text-caption2-weight: 400;
  --mac-text-caption2-weight-em: 600;
  /* Labels — the alpha ladder (never a set of greys) */
    --mac-label-primary: rgba(0, 0, 0, 0.85);
  --mac-label-secondary: rgba(0, 0, 0, 0.5);
  --mac-label-tertiary: rgba(0, 0, 0, 0.25);
  --mac-label-quaternary: rgba(0, 0, 0, 0.1);
  /* Labels on accent — the Selected column of appearance.*.Fills */
    --mac-label-on-accent: #FFFFFF;
  --mac-label-on-accent-secondary: rgba(255, 255, 255, 0.55);
  /* Surface fills — the fill ramp (not the label Fills) */
    --mac-fill-primary: rgba(0, 0, 0, 0.1);
  --mac-fill-secondary: rgba(0, 0, 0, 0.08);
  --mac-fill-tertiary: rgba(0, 0, 0, 0.05);
  --mac-fill-quaternary: rgba(0, 0, 0, 0.03);
  --mac-fill-quinary: rgba(0, 0, 0, 0.02);
  /* Spacing — DERIVED, not a token (NAMING.md §9, references/04-metrics.md) */
    --mac-space-4: 4px;
  --mac-space-6: 6px;
  --mac-space-8: 8px;
  --mac-space-10: 10px;
  --mac-space-12: 12px;
  --mac-space-16: 16px;
  --mac-space-20: 20px;
  --mac-space-24: 24px;
  --mac-space-32: 32px;
  /* Surfaces, lines and borders */
    --mac-window-bg: #FFFFFF;
  --mac-separator: rgba(60, 60, 67, 0.29);
  /* Accent families — twelve families, accent is blue */
    --mac-accent: #0088FF;
  --mac-destructive: #FF383C;
  /* Control fills, content area — Active|Inactive x On|Off x Idle|Clicked|Disabled */
    --mac-control-off-idle: rgba(0, 0, 0, 0.1);
  --mac-control-on-idle: #0088FF;
  /* Control fills, over glass — the other appearance set (never blended) */
    --mac-control-glass-off-idle: rgba(0, 0, 0, 0.15);
  --mac-control-glass-off-clicked: rgba(0, 0, 0, 0.19);
  --mac-control-glass-on-idle: linear-gradient(rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.05)), linear-gradient(#0078F0, #0078F0);
  --mac-control-glass-on-clicked: linear-gradient(rgba(0, 0, 0, 0.07), rgba(0, 0, 0, 0.07)), linear-gradient(#0078F0, #0078F0);
  /* Buttons on a content area — one property per variant, state and layer */
    --mac-on-content-bordered-idle-bg: rgba(0, 0, 0, 0.08);
  --mac-on-content-bordered-clicked-bg: rgba(0, 0, 0, 0.16);
  --mac-on-content-bordered-disabled-bg: rgba(0, 0, 0, 0.04);
  --mac-on-content-tinted-idle-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#0088FF, #0088FF);
  --mac-on-content-tinted-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#0091FF, #0091FF);
  --mac-on-content-tinted-disabled-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#0088FF, #0088FF);
  --mac-on-content-destructive-bordered-idle-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#FF383C, #FF383C);
  --mac-on-content-destructive-bordered-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#FF383C, #FF383C);
  --mac-on-content-destructive-bordered-disabled-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#FF383C, #FF383C);
  --mac-on-content-prominent-idle-bg: linear-gradient(rgba(0, 0, 0, 0.03), rgba(0, 0, 0, 0.03)), linear-gradient(#0088FF, #0088FF);
  --mac-on-content-prominent-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#0078F0, #0078F0);
  --mac-on-content-prominent-disabled-bg: #0078F0;
  --mac-on-content-destructive-prominent-idle-bg: #FF383C;
  --mac-on-content-destructive-prominent-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#F52F32, #F52F32);
  --mac-on-content-destructive-prominent-disabled-bg: #F52F32;
  /* Buttons over glass — the kit carries three of the five variants there */
    --mac-on-glass-bordered-idle-bg: linear-gradient(rgba(0, 0, 0, 0.07), rgba(0, 0, 0, 0.07)), linear-gradient(rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.12));
  --mac-on-glass-bordered-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.13), rgba(0, 0, 0, 0.13)), linear-gradient(rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.12));
  --mac-on-glass-bordered-disabled-bg: linear-gradient(rgba(0, 0, 0, 0.025), rgba(0, 0, 0, 0.025)), linear-gradient(rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.06));
  --mac-on-glass-prominent-idle-bg: #0078F0;
  --mac-on-glass-prominent-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.15)), linear-gradient(#0078F0, #0078F0);
  --mac-on-glass-prominent-disabled-bg: #0078F0;
  --mac-on-glass-destructive-prominent-idle-bg: #FF4747;
  --mac-on-glass-destructive-prominent-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.15)), linear-gradient(#F52F32, #F52F32);
  --mac-on-glass-destructive-prominent-disabled-bg: #F52F32;
  /* Text fields — well, hairline, focus */
    --mac-input-bg-idle: #FFFFFF;
  --mac-input-border-idle: rgba(0, 0, 0, 0.05);
  --mac-input-bg-disabled: rgba(255, 255, 255, 0.5);
  --mac-input-border-disabled: rgba(0, 0, 0, 0.04);
  /* Tracks — progress bars and slider grooves */
    --mac-track-filled-idle: #0088FF;
  /* Tracks, over glass */
    --mac-track-glass-filled-idle: #0078F0;
  --mac-track-glass-unfilled-idle: linear-gradient(rgba(0, 0, 0, 0.07), rgba(0, 0, 0, 0.07)), linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2));
  --mac-track-glass-tick-mark: rgba(0, 0, 0, 0.25);
  --mac-track-glass-tick-mark-center: rgba(0, 0, 0, 0.85);
  --mac-track-glass-tick-mark-disabled: rgba(0, 0, 0, 0.1);
  --mac-track-glass-filled-idle-color: #0078F0;
  --mac-track-glass-unfilled-idle-color: rgba(0, 0, 0, 0.2);
  /* Knobs — the switch knob and the slider knob */
    --mac-knob-bg-idle: #FFFFFF;
  --mac-knob-bg-disabled: linear-gradient(rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.35)), linear-gradient(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.45)), linear-gradient(rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0.65));
  --mac-knob-shadow-idle: 0px 3px 36px 0px rgba(0, 0, 0, 0.05);
  --mac-knob-glow-clicked: inset 0 0 0 1px #D9D9D9, inset 0 0 0 1.5px rgba(255, 255, 255, 0.45);
  --mac-knob-shadow-clicked: 0 0 0 0 1px #000000;
  --mac-segmented-glass-on-bg-idle: linear-gradient(rgba(0, 0, 0, 0.03), rgba(0, 0, 0, 0.03)), linear-gradient(#0078F0, #0078F0);
  --mac-segmented-glass-on-bg-clicked: linear-gradient(rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.15)), linear-gradient(#0078F0, #0078F0);
  --mac-segmented-glass-on-bg-disabled: linear-gradient(rgba(0, 0, 0, 0.03), rgba(0, 0, 0, 0.03)), linear-gradient(#0078F0, #0078F0);
  /* Focus ring — the package-wide recipe (global.focusRing) */
    --mac-focus-ring-outer: rgba(0, 136, 255, 0.25);
  --mac-focus-ring-inner: rgba(0, 136, 255, 0.15);
  --mac-focus-ring-width-outer: 3.5px;
  --mac-focus-ring-width-inner: 1px;
  --mac-glass-menus-bg: rgba(230, 230, 230, 0.55);
  --mac-glass-menus-shadow: 0px 0px 0px 1px rgba(102, 102, 102, 0.15), 0px 0.5px 0px 0px #262626, 0px -0.5px 0px 0px #262626, 0px 4px 8px -4px #0D0D0D, 0px -4px 8px -4px #0D0D0D, 0px 0px 0px 0.5px rgba(0, 0, 0, 0.2), 0px 4px 24px 0px rgba(0, 0, 0, 0.3);
  --mac-blur-menu: 20px;
  /* Control metrics — heights, type and padding per size class */
    --mac-control-height-mini: 16px;
  --mac-control-height-small: 20px;
  --mac-control-height-regular: 24px;
  --mac-control-height-large: 28px;
  --mac-control-height-xlarge: 36px;
  --mac-control-font-mini: 10px;
  --mac-control-font-small: 11px;
  --mac-control-font-regular: 13px;
  --mac-control-font-large: 13px;
  --mac-control-font-xlarge: 13px;
  --mac-control-line-mini: 13px;
  --mac-control-line-small: 14px;
  --mac-control-line-regular: 16px;
  --mac-control-line-large: 16px;
  --mac-control-line-xlarge: 16px;
  --mac-control-pad-x-mini: 7px;
  --mac-control-pad-x-small: 10px;
  --mac-control-pad-x-regular: 16px;
  --mac-control-pad-x-large: 16px;
  --mac-control-pad-x-xlarge: 16px;
  --mac-control-height: var(--mac-control-height-regular);
  --mac-control-font: var(--mac-control-font-regular);
  --mac-control-line: var(--mac-control-line-regular);
  --mac-control-pad-x: var(--mac-control-pad-x-regular);
  --mac-radius-control-small: 5px;
  --mac-radius-control-regular: 6px;
  --mac-radius-button-mini: 4px;
  --mac-radius-button-small: 5px;
  --mac-radius-button-regular: 6px;
  --mac-radius-button-large: var(--mac-radius-pill);
  --mac-radius-button-xlarge: var(--mac-radius-pill);
  --mac-radius-menu: 8px;
  --mac-radius-group-box: 12px;
  --mac-radius-pill: 9999px;
  --mac-switch-w-mini: 36px;
  --mac-switch-w-small: 44px;
  --mac-switch-w-regular: 54px;
  --mac-switch-w-large: 64px;
  --mac-switch-w-xlarge: 80px;
  --mac-switch-h-mini: 16px;
  --mac-switch-h-small: 20px;
  --mac-switch-h-regular: 24px;
  --mac-switch-h-large: 28px;
  --mac-switch-h-xlarge: 36px;
  --mac-switch-knob-w-mini: 21px;
  --mac-switch-knob-w-small: 26px;
  --mac-switch-knob-w-regular: 32px;
  --mac-switch-knob-w-large: 38px;
  --mac-switch-knob-w-xlarge: 47px;
  --mac-switch-knob-h-mini: 13px;
  --mac-switch-knob-h-small: 16px;
  --mac-switch-knob-h-regular: 20px;
  --mac-switch-knob-h-large: 24px;
  --mac-switch-knob-h-xlarge: 30px;
  --mac-switch-knob-inset-mini: 1.5px;
  --mac-switch-knob-inset-small: 2px;
  --mac-switch-knob-inset-regular: 2px;
  --mac-switch-knob-inset-large: 2px;
  --mac-switch-knob-inset-xlarge: 3px;
  --mac-switch-knob-travel-mini: 12px;
  --mac-switch-knob-travel-small: 14px;
  --mac-switch-knob-travel-regular: 18px;
  --mac-switch-knob-travel-large: 22px;
  --mac-switch-knob-travel-xlarge: 27px;
  /* Progress indicators */
    --mac-progress-bar-small: 6px;
  --mac-progress-bar-regular: 10px;
  --mac-progress-floor-regular: 10px;
  --mac-progress-floor-small: 8px;
  --mac-duration-fast: 130ms;
  --mac-duration-base: 200ms;
  --mac-duration-slow: 300ms;
  --mac-ease-standard: cubic-bezier(0.32, 0.72, 0, 1);
  /* Tier 2 — accent families, raw per theme */
    --mac-system-red-light: #FF383C;
  --mac-system-red-dark: #FF4245;
  --mac-system-orange-light: #FF8D28;
  --mac-system-orange-dark: #FF9230;
  --mac-system-yellow-light: #FFCC00;
  --mac-system-yellow-dark: #FFD600;
  --mac-system-green-light: #34C759;
  --mac-system-green-dark: #30D158;
  --mac-system-blue-light: #0088FF;
  --mac-system-blue-dark: #0091FF;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    /* Labels — the alpha ladder (never a set of greys) */
      --mac-label-primary: #FFFFFF;
    --mac-label-secondary: rgba(255, 255, 255, 0.55);
    --mac-label-tertiary: rgba(255, 255, 255, 0.25);
    --mac-label-quaternary: rgba(255, 255, 255, 0.1);
    /* Surface fills — the fill ramp (not the label Fills) */
      --mac-fill-primary: rgba(255, 255, 255, 0.1);
    --mac-fill-secondary: rgba(255, 255, 255, 0.08);
    --mac-fill-tertiary: rgba(255, 255, 255, 0.05);
    --mac-fill-quaternary: rgba(255, 255, 255, 0.03);
    --mac-fill-quinary: rgba(255, 255, 255, 0.02);
    /* Surfaces, lines and borders */
      --mac-window-bg: #1E1E1E;
    --mac-separator: rgba(255, 255, 255, 0.29);
    /* Accent families — twelve families, accent is blue */
      --mac-accent: #0091FF;
    --mac-destructive: #FF4245;
    /* Control fills, content area — Active|Inactive x On|Off x Idle|Clicked|Disabled */
      --mac-control-off-idle: rgba(255, 255, 255, 0.1);
    --mac-control-on-idle: linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05)), linear-gradient(#0091FF, #0091FF);
    /* Control fills, over glass — the other appearance set (never blended) */
      --mac-control-glass-off-idle: rgba(255, 255, 255, 0.14);
    --mac-control-glass-off-clicked: rgba(255, 255, 255, 0.19);
    --mac-control-glass-on-idle: linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05)), linear-gradient(#0091FF, #0091FF);
    --mac-control-glass-on-clicked: linear-gradient(rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.08)), linear-gradient(#0091FF, #0091FF);
    /* Buttons on a content area — one property per variant, state and layer */
      --mac-on-content-bordered-idle-bg: rgba(255, 255, 255, 0.07);
    --mac-on-content-bordered-clicked-bg: rgba(255, 255, 255, 0.16);
    --mac-on-content-bordered-disabled-bg: rgba(255, 255, 255, 0.04);
    --mac-on-content-tinted-idle-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0091FF, #0091FF);
    --mac-on-content-tinted-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0091FF, #0091FF);
    --mac-on-content-tinted-disabled-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0091FF, #0091FF);
    --mac-on-content-destructive-bordered-idle-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#FF4245, #FF4245);
    --mac-on-content-destructive-bordered-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#FF4245, #FF4245);
    --mac-on-content-destructive-bordered-disabled-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#FF4245, #FF4245);
    --mac-on-content-prominent-idle-bg: #0091FF;
    --mac-on-content-prominent-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1)), linear-gradient(#0A99FF, #0A99FF);
    --mac-on-content-prominent-disabled-bg: #0A99FF;
    --mac-on-content-destructive-prominent-idle-bg: #FF4245;
    --mac-on-content-destructive-prominent-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1)), linear-gradient(#FF4747, #FF4747);
    --mac-on-content-destructive-prominent-disabled-bg: #FF4747;
    /* Buttons over glass — the kit carries three of the five variants there */
      --mac-on-glass-bordered-idle-bg: linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05)), linear-gradient(rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.12));
    --mac-on-glass-bordered-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0.13)), linear-gradient(rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.12));
    --mac-on-glass-bordered-disabled-bg: linear-gradient(rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0.025)), linear-gradient(rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.06));
    --mac-on-glass-prominent-idle-bg: #0A99FF;
    --mac-on-glass-prominent-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0078F0, #0078F0);
    --mac-on-glass-prominent-disabled-bg: #0A99FF;
    --mac-on-glass-destructive-prominent-idle-bg: #F52F32;
    --mac-on-glass-destructive-prominent-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.15)), linear-gradient(#FF4747, #FF4747);
    --mac-on-glass-destructive-prominent-disabled-bg: #FF4747;
    /* Text fields — well, hairline, focus */
      --mac-input-bg-idle: #1E1E1E;
    --mac-input-border-idle: rgba(255, 255, 255, 0.04);
    --mac-input-bg-disabled: rgba(30, 30, 30, 0.5);
    /* Tracks — progress bars and slider grooves */
      --mac-track-filled-idle: #0091FF;
    /* Tracks, over glass */
      --mac-track-glass-filled-idle: #0A99FF;
    --mac-track-glass-unfilled-idle: linear-gradient(rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.03)), linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04));
    --mac-track-glass-tick-mark: #404040;
    --mac-track-glass-tick-mark-center: #D9D9D9;
    --mac-track-glass-tick-mark-disabled: #1A1A1A;
    --mac-track-glass-filled-idle-color: #0A99FF;
    --mac-track-glass-unfilled-idle-color: rgba(255, 255, 255, 0.04);
    /* Knobs — the switch knob and the slider knob */
      --mac-knob-bg-idle: linear-gradient(rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.35)), linear-gradient(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.45)), linear-gradient(rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0.65));
    --mac-knob-shadow-idle: 0px 0px 1px 0px rgba(255, 255, 255, 0.1), -1.75px -2.5px 2px -1.5px #FFFFFF, 1.75px 2.5px 1px -1.5px #FFFFFF, 0px 0px 1px -0.25px rgba(0, 0, 0, 0.05), 0px 0px 4px -0.5px rgba(0, 0, 0, 0.05), 0px 0px 44px 0px rgba(0, 0, 0, 0.1);
    --mac-knob-glow-clicked: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
    --mac-segmented-glass-on-bg-idle: linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04)), linear-gradient(#0A99FF, #0A99FF);
    --mac-segmented-glass-on-bg-clicked: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0A99FF, #0A99FF);
    --mac-segmented-glass-on-bg-disabled: linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04)), linear-gradient(#0A99FF, #0A99FF);
    --mac-glass-menus-bg: rgba(90, 90, 90, 0.5);
    --mac-glass-menus-shadow: 0px 0px 0px 1px rgba(102, 102, 102, 0.4), 0px 0.5px 0px 0px #262626, 0px -0.5px 0px 0px #262626, 0px 4px 8px -4px #0D0D0D, 0px -4px 8px -4px #0D0D0D, 0px 0px 0px 0.5px rgba(0, 0, 0, 0.8), 0px 4px 24px 0px rgba(0, 0, 0, 0.3);
  }
}

html[data-theme="dark"],
[data-theme="dark"] {
  /* Labels — the alpha ladder (never a set of greys) */
    --mac-label-primary: #FFFFFF;
  --mac-label-secondary: rgba(255, 255, 255, 0.55);
  --mac-label-tertiary: rgba(255, 255, 255, 0.25);
  --mac-label-quaternary: rgba(255, 255, 255, 0.1);
  /* Surface fills — the fill ramp (not the label Fills) */
    --mac-fill-primary: rgba(255, 255, 255, 0.1);
  --mac-fill-secondary: rgba(255, 255, 255, 0.08);
  --mac-fill-tertiary: rgba(255, 255, 255, 0.05);
  --mac-fill-quaternary: rgba(255, 255, 255, 0.03);
  --mac-fill-quinary: rgba(255, 255, 255, 0.02);
  /* Surfaces, lines and borders */
    --mac-window-bg: #1E1E1E;
  --mac-separator: rgba(255, 255, 255, 0.29);
  /* Accent families — twelve families, accent is blue */
    --mac-accent: #0091FF;
  --mac-destructive: #FF4245;
  /* Control fills, content area — Active|Inactive x On|Off x Idle|Clicked|Disabled */
    --mac-control-off-idle: rgba(255, 255, 255, 0.1);
  --mac-control-on-idle: linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05)), linear-gradient(#0091FF, #0091FF);
  /* Control fills, over glass — the other appearance set (never blended) */
    --mac-control-glass-off-idle: rgba(255, 255, 255, 0.14);
  --mac-control-glass-off-clicked: rgba(255, 255, 255, 0.19);
  --mac-control-glass-on-idle: linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05)), linear-gradient(#0091FF, #0091FF);
  --mac-control-glass-on-clicked: linear-gradient(rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.08)), linear-gradient(#0091FF, #0091FF);
  /* Buttons on a content area — one property per variant, state and layer */
    --mac-on-content-bordered-idle-bg: rgba(255, 255, 255, 0.07);
  --mac-on-content-bordered-clicked-bg: rgba(255, 255, 255, 0.16);
  --mac-on-content-bordered-disabled-bg: rgba(255, 255, 255, 0.04);
  --mac-on-content-tinted-idle-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0091FF, #0091FF);
  --mac-on-content-tinted-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0091FF, #0091FF);
  --mac-on-content-tinted-disabled-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0091FF, #0091FF);
  --mac-on-content-destructive-bordered-idle-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#FF4245, #FF4245);
  --mac-on-content-destructive-bordered-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#FF4245, #FF4245);
  --mac-on-content-destructive-bordered-disabled-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#FF4245, #FF4245);
  --mac-on-content-prominent-idle-bg: #0091FF;
  --mac-on-content-prominent-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1)), linear-gradient(#0A99FF, #0A99FF);
  --mac-on-content-prominent-disabled-bg: #0A99FF;
  --mac-on-content-destructive-prominent-idle-bg: #FF4245;
  --mac-on-content-destructive-prominent-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1)), linear-gradient(#FF4747, #FF4747);
  --mac-on-content-destructive-prominent-disabled-bg: #FF4747;
  /* Buttons over glass — the kit carries three of the five variants there */
    --mac-on-glass-bordered-idle-bg: linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05)), linear-gradient(rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.12));
  --mac-on-glass-bordered-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0.13)), linear-gradient(rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.12));
  --mac-on-glass-bordered-disabled-bg: linear-gradient(rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0.025)), linear-gradient(rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.06));
  --mac-on-glass-prominent-idle-bg: #0A99FF;
  --mac-on-glass-prominent-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0078F0, #0078F0);
  --mac-on-glass-prominent-disabled-bg: #0A99FF;
  --mac-on-glass-destructive-prominent-idle-bg: #F52F32;
  --mac-on-glass-destructive-prominent-clicked-bg: linear-gradient(rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.15)), linear-gradient(#FF4747, #FF4747);
  --mac-on-glass-destructive-prominent-disabled-bg: #FF4747;
  /* Text fields — well, hairline, focus */
    --mac-input-bg-idle: #1E1E1E;
  --mac-input-border-idle: rgba(255, 255, 255, 0.04);
  --mac-input-bg-disabled: rgba(30, 30, 30, 0.5);
  /* Tracks — progress bars and slider grooves */
    --mac-track-filled-idle: #0091FF;
  /* Tracks, over glass */
    --mac-track-glass-filled-idle: #0A99FF;
  --mac-track-glass-unfilled-idle: linear-gradient(rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.03)), linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04));
  --mac-track-glass-tick-mark: #404040;
  --mac-track-glass-tick-mark-center: #D9D9D9;
  --mac-track-glass-tick-mark-disabled: #1A1A1A;
  --mac-track-glass-filled-idle-color: #0A99FF;
  --mac-track-glass-unfilled-idle-color: rgba(255, 255, 255, 0.04);
  /* Knobs — the switch knob and the slider knob */
    --mac-knob-bg-idle: linear-gradient(rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.35)), linear-gradient(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.45)), linear-gradient(rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0.65));
  --mac-knob-shadow-idle: 0px 0px 1px 0px rgba(255, 255, 255, 0.1), -1.75px -2.5px 2px -1.5px #FFFFFF, 1.75px 2.5px 1px -1.5px #FFFFFF, 0px 0px 1px -0.25px rgba(0, 0, 0, 0.05), 0px 0px 4px -0.5px rgba(0, 0, 0, 0.05), 0px 0px 44px 0px rgba(0, 0, 0, 0.1);
  --mac-knob-glow-clicked: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
  --mac-segmented-glass-on-bg-idle: linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04)), linear-gradient(#0A99FF, #0A99FF);
  --mac-segmented-glass-on-bg-clicked: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), linear-gradient(#0A99FF, #0A99FF);
  --mac-segmented-glass-on-bg-disabled: linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04)), linear-gradient(#0A99FF, #0A99FF);
  --mac-glass-menus-bg: rgba(90, 90, 90, 0.5);
  --mac-glass-menus-shadow: 0px 0px 0px 1px rgba(102, 102, 102, 0.4), 0px 0.5px 0px 0px #262626, 0px -0.5px 0px 0px #262626, 0px 4px 8px -4px #0D0D0D, 0px -4px 8px -4px #0D0D0D, 0px 0px 0px 0.5px rgba(0, 0, 0, 0.8), 0px 4px 24px 0px rgba(0, 0, 0, 0.3);
}

[data-theme="light"] {
  /* Type — the kit's stack and the five weights */
    --mac-font-sans: "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  --mac-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --mac-weight-medium: 500;
  --mac-weight-bold: 700;
  /* Type — the eleven styles (leading variants are compositional: calc(line ± 2px)) */
    --mac-text-large-title-size: 26px;
  --mac-text-large-title-line: 32px;
  --mac-text-large-title-weight: 400;
  --mac-text-large-title-weight-em: 700;
  --mac-text-title1-size: 22px;
  --mac-text-title1-line: 26px;
  --mac-text-title1-weight: 400;
  --mac-text-title1-weight-em: 700;
  --mac-text-title2-size: 17px;
  --mac-text-title2-line: 22px;
  --mac-text-title2-weight: 400;
  --mac-text-title2-weight-em: 700;
  --mac-text-title3-size: 15px;
  --mac-text-title3-line: 20px;
  --mac-text-title3-weight: 400;
  --mac-text-title3-weight-em: 600;
  --mac-text-headline-size: 13px;
  --mac-text-headline-line: 16px;
  --mac-text-headline-weight: 700;
  --mac-text-headline-weight-em: 800;
  --mac-text-body-size: 13px;
  --mac-text-body-line: 16px;
  --mac-text-body-weight: 400;
  --mac-text-body-weight-em: 600;
  --mac-text-callout-size: 12px;
  --mac-text-callout-line: 15px;
  --mac-text-callout-weight: 400;
  --mac-text-callout-weight-em: 600;
  --mac-text-subheadline-size: 11px;
  --mac-text-subheadline-line: 14px;
  --mac-text-subheadline-weight: 400;
  --mac-text-subheadline-weight-em: 600;
  --mac-text-footnote-size: 10px;
  --mac-text-footnote-line: 13px;
  --mac-text-footnote-weight: 400;
  --mac-text-footnote-weight-em: 600;
  --mac-text-caption1-size: 10px;
  --mac-text-caption1-line: 13px;
  --mac-text-caption1-weight: 400;
  --mac-text-caption1-weight-em: 600;
  --mac-text-caption2-size: 10px;
  --mac-text-caption2-line: 13px;
  --mac-text-caption2-weight: 400;
  --mac-text-caption2-weight-em: 600;
  /* Labels — the alpha ladder (never a set of greys) */
    --mac-label-primary: rgba(0, 0, 0, 0.85);
  --mac-label-secondary: rgba(0, 0, 0, 0.5);
  --mac-label-tertiary: rgba(0, 0, 0, 0.25);
  --mac-label-quaternary: rgba(0, 0, 0, 0.1);
  /* Labels on accent — the Selected column of appearance.*.Fills */
    --mac-label-on-accent: #FFFFFF;
  --mac-label-on-accent-secondary: rgba(255, 255, 255, 0.55);
  /* Surface fills — the fill ramp (not the label Fills) */
    --mac-fill-primary: rgba(0, 0, 0, 0.1);
  --mac-fill-secondary: rgba(0, 0, 0, 0.08);
  --mac-fill-tertiary: rgba(0, 0, 0, 0.05);
  --mac-fill-quaternary: rgba(0, 0, 0, 0.03);
  --mac-fill-quinary: rgba(0, 0, 0, 0.02);
  /* Spacing — DERIVED, not a token (NAMING.md §9, references/04-metrics.md) */
    --mac-space-4: 4px;
  --mac-space-6: 6px;
  --mac-space-8: 8px;
  --mac-space-10: 10px;
  --mac-space-12: 12px;
  --mac-space-16: 16px;
  --mac-space-20: 20px;
  --mac-space-24: 24px;
  --mac-space-32: 32px;
  /* Surfaces, lines and borders */
    --mac-window-bg: #FFFFFF;
  --mac-separator: rgba(60, 60, 67, 0.29);
  /* Accent families — twelve families, accent is blue */
    --mac-accent: #0088FF;
  --mac-destructive: #FF383C;
  /* Control fills, content area — Active|Inactive x On|Off x Idle|Clicked|Disabled */
    --mac-control-off-idle: rgba(0, 0, 0, 0.1);
  --mac-control-on-idle: #0088FF;
  /* Control fills, over glass — the other appearance set (never blended) */
    --mac-control-glass-off-idle: rgba(0, 0, 0, 0.15);
  --mac-control-glass-off-clicked: rgba(0, 0, 0, 0.19);
  --mac-control-glass-on-idle: linear-gradient(rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.05)), linear-gradient(#0078F0, #0078F0);
  --mac-control-glass-on-clicked: linear-gradient(rgba(0, 0, 0, 0.07), rgba(0, 0, 0, 0.07)), linear-gradient(#0078F0, #0078F0);
  /* Buttons on a content area — one property per variant, state and layer */
    --mac-on-content-bordered-idle-bg: rgba(0, 0, 0, 0.08);
  --mac-on-content-bordered-clicked-bg: rgba(0, 0, 0, 0.16);
  --mac-on-content-bordered-disabled-bg: rgba(0, 0, 0, 0.04);
  --mac-on-content-tinted-idle-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#0088FF, #0088FF);
  --mac-on-content-tinted-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#0091FF, #0091FF);
  --mac-on-content-tinted-disabled-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#0088FF, #0088FF);
  --mac-on-content-destructive-bordered-idle-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#FF383C, #FF383C);
  --mac-on-content-destructive-bordered-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#FF383C, #FF383C);
  --mac-on-content-destructive-bordered-disabled-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#FF383C, #FF383C);
  --mac-on-content-prominent-idle-bg: linear-gradient(rgba(0, 0, 0, 0.03), rgba(0, 0, 0, 0.03)), linear-gradient(#0088FF, #0088FF);
  --mac-on-content-prominent-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#0078F0, #0078F0);
  --mac-on-content-prominent-disabled-bg: #0078F0;
  --mac-on-content-destructive-prominent-idle-bg: #FF383C;
  --mac-on-content-destructive-prominent-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), linear-gradient(#F52F32, #F52F32);
  --mac-on-content-destructive-prominent-disabled-bg: #F52F32;
  /* Buttons over glass — the kit carries three of the five variants there */
    --mac-on-glass-bordered-idle-bg: linear-gradient(rgba(0, 0, 0, 0.07), rgba(0, 0, 0, 0.07)), linear-gradient(rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.12));
  --mac-on-glass-bordered-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.13), rgba(0, 0, 0, 0.13)), linear-gradient(rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.12));
  --mac-on-glass-bordered-disabled-bg: linear-gradient(rgba(0, 0, 0, 0.025), rgba(0, 0, 0, 0.025)), linear-gradient(rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.06));
  --mac-on-glass-prominent-idle-bg: #0078F0;
  --mac-on-glass-prominent-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.15)), linear-gradient(#0078F0, #0078F0);
  --mac-on-glass-prominent-disabled-bg: #0078F0;
  --mac-on-glass-destructive-prominent-idle-bg: #FF4747;
  --mac-on-glass-destructive-prominent-clicked-bg: linear-gradient(rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.15)), linear-gradient(#F52F32, #F52F32);
  --mac-on-glass-destructive-prominent-disabled-bg: #F52F32;
  /* Text fields — well, hairline, focus */
    --mac-input-bg-idle: #FFFFFF;
  --mac-input-border-idle: rgba(0, 0, 0, 0.05);
  --mac-input-bg-disabled: rgba(255, 255, 255, 0.5);
  --mac-input-border-disabled: rgba(0, 0, 0, 0.04);
  /* Tracks — progress bars and slider grooves */
    --mac-track-filled-idle: #0088FF;
  /* Tracks, over glass */
    --mac-track-glass-filled-idle: #0078F0;
  --mac-track-glass-unfilled-idle: linear-gradient(rgba(0, 0, 0, 0.07), rgba(0, 0, 0, 0.07)), linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2));
  --mac-track-glass-tick-mark: rgba(0, 0, 0, 0.25);
  --mac-track-glass-tick-mark-center: rgba(0, 0, 0, 0.85);
  --mac-track-glass-tick-mark-disabled: rgba(0, 0, 0, 0.1);
  --mac-track-glass-filled-idle-color: #0078F0;
  --mac-track-glass-unfilled-idle-color: rgba(0, 0, 0, 0.2);
  /* Knobs — the switch knob and the slider knob */
    --mac-knob-bg-idle: #FFFFFF;
  --mac-knob-bg-disabled: linear-gradient(rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.35)), linear-gradient(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.45)), linear-gradient(rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0.65));
  --mac-knob-shadow-idle: 0px 3px 36px 0px rgba(0, 0, 0, 0.05);
  --mac-knob-glow-clicked: inset 0 0 0 1px #D9D9D9, inset 0 0 0 1.5px rgba(255, 255, 255, 0.45);
  --mac-knob-shadow-clicked: 0 0 0 0 1px #000000;
  --mac-segmented-glass-on-bg-idle: linear-gradient(rgba(0, 0, 0, 0.03), rgba(0, 0, 0, 0.03)), linear-gradient(#0078F0, #0078F0);
  --mac-segmented-glass-on-bg-clicked: linear-gradient(rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.15)), linear-gradient(#0078F0, #0078F0);
  --mac-segmented-glass-on-bg-disabled: linear-gradient(rgba(0, 0, 0, 0.03), rgba(0, 0, 0, 0.03)), linear-gradient(#0078F0, #0078F0);
  /* Focus ring — the package-wide recipe (global.focusRing) */
    --mac-focus-ring-outer: rgba(0, 136, 255, 0.25);
  --mac-focus-ring-inner: rgba(0, 136, 255, 0.15);
  --mac-focus-ring-width-outer: 3.5px;
  --mac-focus-ring-width-inner: 1px;
  --mac-glass-menus-bg: rgba(230, 230, 230, 0.55);
  --mac-glass-menus-shadow: 0px 0px 0px 1px rgba(102, 102, 102, 0.15), 0px 0.5px 0px 0px #262626, 0px -0.5px 0px 0px #262626, 0px 4px 8px -4px #0D0D0D, 0px -4px 8px -4px #0D0D0D, 0px 0px 0px 0.5px rgba(0, 0, 0, 0.2), 0px 4px 24px 0px rgba(0, 0, 0, 0.3);
  --mac-blur-menu: 20px;
  /* Control metrics — heights, type and padding per size class */
    --mac-control-height-mini: 16px;
  --mac-control-height-small: 20px;
  --mac-control-height-regular: 24px;
  --mac-control-height-large: 28px;
  --mac-control-height-xlarge: 36px;
  --mac-control-font-mini: 10px;
  --mac-control-font-small: 11px;
  --mac-control-font-regular: 13px;
  --mac-control-font-large: 13px;
  --mac-control-font-xlarge: 13px;
  --mac-control-line-mini: 13px;
  --mac-control-line-small: 14px;
  --mac-control-line-regular: 16px;
  --mac-control-line-large: 16px;
  --mac-control-line-xlarge: 16px;
  --mac-control-pad-x-mini: 7px;
  --mac-control-pad-x-small: 10px;
  --mac-control-pad-x-regular: 16px;
  --mac-control-pad-x-large: 16px;
  --mac-control-pad-x-xlarge: 16px;
  --mac-control-height: var(--mac-control-height-regular);
  --mac-control-font: var(--mac-control-font-regular);
  --mac-control-line: var(--mac-control-line-regular);
  --mac-control-pad-x: var(--mac-control-pad-x-regular);
  --mac-radius-control-small: 5px;
  --mac-radius-control-regular: 6px;
  --mac-radius-button-mini: 4px;
  --mac-radius-button-small: 5px;
  --mac-radius-button-regular: 6px;
  --mac-radius-button-large: var(--mac-radius-pill);
  --mac-radius-button-xlarge: var(--mac-radius-pill);
  --mac-radius-menu: 8px;
  --mac-radius-group-box: 12px;
  --mac-radius-pill: 9999px;
  --mac-switch-w-mini: 36px;
  --mac-switch-w-small: 44px;
  --mac-switch-w-regular: 54px;
  --mac-switch-w-large: 64px;
  --mac-switch-w-xlarge: 80px;
  --mac-switch-h-mini: 16px;
  --mac-switch-h-small: 20px;
  --mac-switch-h-regular: 24px;
  --mac-switch-h-large: 28px;
  --mac-switch-h-xlarge: 36px;
  --mac-switch-knob-w-mini: 21px;
  --mac-switch-knob-w-small: 26px;
  --mac-switch-knob-w-regular: 32px;
  --mac-switch-knob-w-large: 38px;
  --mac-switch-knob-w-xlarge: 47px;
  --mac-switch-knob-h-mini: 13px;
  --mac-switch-knob-h-small: 16px;
  --mac-switch-knob-h-regular: 20px;
  --mac-switch-knob-h-large: 24px;
  --mac-switch-knob-h-xlarge: 30px;
  --mac-switch-knob-inset-mini: 1.5px;
  --mac-switch-knob-inset-small: 2px;
  --mac-switch-knob-inset-regular: 2px;
  --mac-switch-knob-inset-large: 2px;
  --mac-switch-knob-inset-xlarge: 3px;
  --mac-switch-knob-travel-mini: 12px;
  --mac-switch-knob-travel-small: 14px;
  --mac-switch-knob-travel-regular: 18px;
  --mac-switch-knob-travel-large: 22px;
  --mac-switch-knob-travel-xlarge: 27px;
  /* Progress indicators */
    --mac-progress-bar-small: 6px;
  --mac-progress-bar-regular: 10px;
  --mac-progress-floor-regular: 10px;
  --mac-progress-floor-small: 8px;
  --mac-duration-fast: 130ms;
  --mac-duration-base: 200ms;
  --mac-duration-slow: 300ms;
  --mac-ease-standard: cubic-bezier(0.32, 0.72, 0, 1);
  /* Tier 2 — accent families, raw per theme */
    --mac-system-red-light: #FF383C;
  --mac-system-red-dark: #FF4245;
  --mac-system-orange-light: #FF8D28;
  --mac-system-orange-dark: #FF9230;
  --mac-system-yellow-light: #FFCC00;
  --mac-system-yellow-dark: #FFD600;
  --mac-system-green-light: #34C759;
  --mac-system-green-dark: #30D158;
  --mac-system-blue-light: #0088FF;
  --mac-system-blue-dark: #0091FF;
}

:root {
  --mac-focus-ring-shadow:
      inset 0 0 0 var(--mac-focus-ring-width-inner) var(--mac-focus-ring-inner),
      0 0 0 var(--mac-focus-ring-width-outer) var(--mac-focus-ring-outer);
}

@media (prefers-reduced-transparency: reduce) {
  :root .mac-menu {
  -webkit-backdrop-filter: none;
      backdrop-filter: none;
  }
}

/* ---- 组件子集 ---- */

/* ==========================================================================
   Component layer — hand-written, consumes the generated properties only.
   --------------------------------------------------------------------------
   No rule below branches on the theme: every component fill comes from a
   Tier 1 property, so a component is identical in light and dark and on both
   surfaces. The literals below are the measured chrome, overlay, alert and
   progress-track values that exist in no token leaf — 11 pragma
   sites, counted at build time, each citing its measurement; the ones whose
   measurement differs by theme are written with \`light-dark()\`.
   ========================================================================== */

/* --- Reset (macOS-scoped) ------------------------------------------------ */

/* The component layer gives \`.mac-popover\` and \`.mac-sheet-scrim\` a \`display\`
   of their own, and an attribute selector ties a class selector on specificity:
   without this rule their later \`display: grid\` beats the \`hidden\` attribute. */

/* Headings carry no metrics of their own in the kit. The UA's \`1.5em\`/\`1.17em\`
   sizes and \`0.83em\` margins are relative to whatever font-size the component
   they sit in sets, so an \`<h2>\` inside a 13px popover renders at 19.5px and
   pushes the row below it out of the popover — an actual 19.5px headline was
   measured that way. Nothing in the kit places a heading without giving it a
   \`--mac-text-*\` pair, so neutralising the element costs nothing and removes the
   class of mistake. A page that wants UA-like headings restyles them, which is
   what \`assets/demo.html\` does for its own \`h1\`/\`h2\`/\`h3\`. */

/* macOS sets figures tabular in fields, rows and controls, proportional in
   prose. Apply this class where digits must line up. */

.mac-input, .mac-list-row__detail {
font-variant-numeric: tabular-nums;
}

/* --- Text styles --------------------------------------------------------
   \`.mac-text-<style>\` - one block per style in the ladder, then the three
   modifiers. The blocks below are generated by build_text_classes() from the
   token list, so a twelfth style in the token file appears here as well.
   Names, values and the modifier behaviour follow references/03-typography.md
   and tools/NAMING.md §12.1. The type classes come before every component
   rule on purpose: a component's own font-size outranks the generic class.
*/

/* Every text class is typed on its own - a style block never inherits
   its family, size or leading from a host element. */

.mac-text-large-title {
--_mac-line: var(--mac-text-large-title-line);
  --_mac-em: var(--mac-text-large-title-weight-em);
  font-size: var(--mac-text-large-title-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-large-title-weight);
}

.mac-text-title1 {
--_mac-line: var(--mac-text-title1-line);
  --_mac-em: var(--mac-text-title1-weight-em);
  font-size: var(--mac-text-title1-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-title1-weight);
}

.mac-text-title2 {
--_mac-line: var(--mac-text-title2-line);
  --_mac-em: var(--mac-text-title2-weight-em);
  font-size: var(--mac-text-title2-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-title2-weight);
}

.mac-text-title3 {
--_mac-line: var(--mac-text-title3-line);
  --_mac-em: var(--mac-text-title3-weight-em);
  font-size: var(--mac-text-title3-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-title3-weight);
}

.mac-text-headline {
--_mac-line: var(--mac-text-headline-line);
  --_mac-em: var(--mac-text-headline-weight-em);
  font-size: var(--mac-text-headline-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-headline-weight);
}

.mac-text-body {
--_mac-line: var(--mac-text-body-line);
  --_mac-em: var(--mac-text-body-weight-em);
  font-size: var(--mac-text-body-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-body-weight);
}

.mac-text-callout {
--_mac-line: var(--mac-text-callout-line);
  --_mac-em: var(--mac-text-callout-weight-em);
  font-size: var(--mac-text-callout-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-callout-weight);
}

.mac-text-subheadline {
--_mac-line: var(--mac-text-subheadline-line);
  --_mac-em: var(--mac-text-subheadline-weight-em);
  font-size: var(--mac-text-subheadline-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-subheadline-weight);
}

.mac-text-footnote {
--_mac-line: var(--mac-text-footnote-line);
  --_mac-em: var(--mac-text-footnote-weight-em);
  font-size: var(--mac-text-footnote-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-footnote-weight);
}

.mac-text-caption1 {
--_mac-line: var(--mac-text-caption1-line);
  --_mac-em: var(--mac-text-caption1-weight-em);
  font-size: var(--mac-text-caption1-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-caption1-weight);
}

.mac-text-caption2 {
--_mac-line: var(--mac-text-caption2-line);
  --_mac-em: var(--mac-text-caption2-weight-em);
  font-size: var(--mac-text-caption2-size);
  line-height: var(--_mac-line);
  font-weight: var(--mac-text-caption2-weight);
}

/* Modifiers - they read the style block's aliases, so one rule covers
   all eleven styles. Used alone a modifier has nothing to read. */

.mac-text--em {
font-weight: var(--_mac-em);
}

.mac-text--loose {
line-height: calc(var(--_mac-line) + 2px);
}

.mac-text--tight {
line-height: calc(var(--_mac-line) - 2px);
}

/* --- Continuous corners -------------------------------------------------
   The kit draws every corner with Sketch smoothing 0.6, which is Apple's
   continuous (superellipse) curvature. Where the engine can render it we ask
   for \`corner-shape: superellipse(1.2)\` at the SAME measured radius. The
   radius is never inflated to imitate a squircle: at an equal radius a
   superellipse already reads tighter than a circular arc, so inflating it
   would be a different shape, not a closer one.                       */

.mac-menu, .mac-button, .mac-input, so the
                                visible corner is this element's corner */
  .mac-list-row, .mac-switch, .mac-switch__knob, .mac-progress, .mac-progress__bar, .mac-progress__fill, .mac-group-box {
corner-shape: superellipse(1.2);
}

/* --- Window ------------------------------------------------------------- */

/* Utility panel: same window chrome, panel fill and panel shadow. */

/* --- Titlebar and toolbar ----------------------------------------------
   The token file carries no titlebar height: macOS sizes it from the control
   ladder, so 52px here is the xlarge control (36px) plus two 8px insets,
   measured against layout_metrics.md (titlebar/toolbar symbols are 36px tall
   controls in a 52px bar). The standard window controls are drawn by
   \`.mac-window__traffic\` / \`.mac-window__light\` further down; that cluster is
   positioned against the bar, so the bar establishes a containing block.   */

/* The Liquid Glass toolbar of macOS 26/27: add .mac-glass to the toolbar and
   the controls inside it switch to the over-glass appearance set, because
   .mac-glass re-points the control properties (see the glass section). */

/* --- Sidebar -----------------------------------------------------------
   A distinct surface on every non-negotiable count: its own background, its
   own inactive state, and the vibrancy it inherits from the window behind it.
   256px wide and 240px rows are measured (layout_metrics.md, Sidebars).  */

/* A window that is not key dims its sidebar and blurs it less: the kit
   measures a smaller radius for the inactive pane, not no blur at all. */

/* MEASURED selection: an 11% translucent grey, not the accent. The kit's
   selected row keeps the label colour — white text on an 11% fill would be
   unreadable — and the leading symbol and trailing detail keep theirs
   (--mac-glyph-neutral and --mac-label-secondary), so nothing recolours them.
   There is deliberately NO \`.mac-window--inactive\` override: the kit's
   Sidebars/<theme>/Examples/{Active,Inactive}/<size> records reference the same
   symbols, so no distinct inactive selection is drawn and the fill persists in a
   background window.
   The fill is painted on a pseudo-element rather than the row, because the kit's
   Background rectangle is \`f: [-4, 0, 248, H]\` against a 240px row — it bleeds
   4px past the row on each side, which \`background\` on the row cannot do. That is
   what the sidebar's 8px padding is for: the row spans x=8..248 of a 256px pane
   and the fill spans x=4..252, leaving 4px of clearance on each side.
   \`z-index: -1\` puts the fill above the sidebar's own background and below the
   row's text, so the row's children need no lifting — including a row written as
   bare text, which no child selector could reach.
   \`aria-current\` is accepted because \`aria-selected\` is not valid on a nav link:
   on an \`<a>\` inside a \`<nav>\`, \`aria-current="page"\` is the correct marking and
   the class remains the escape hatch for a listbox-style row. */

/* MEASURED selection: see the \`::before\` rule above, which paints the 248px
   rect. The row itself stays transparent so the bleed can overhang it. */

/* --- Content area ------------------------------------------------------- */

.mac-content {
flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: var(--mac-space-16); /* DERIVED, not a token: the regular control inset */
  overflow: auto;
  background: var(--mac-window-bg);
}

.mac-content__section-title {
margin: 0 0 8px;
  font-size: var(--mac-text-subheadline-size);
  line-height: var(--mac-text-subheadline-line);
  font-weight: var(--mac-text-subheadline-weight);
  color: var(--mac-label-secondary);
}

/* --- Buttons -----------------------------------------------------------
   macOS buttons change fill on press, not on hover, and never lift or glow.
   Each state is a whole fill stack from the token file: \`background\` accepts
   both a bare colour and a multi-layer gradient list.                    */

.mac-button {
display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--mac-space-6); /* DERIVED, not a token */
  height: var(--mac-control-height); /* 24 */
  min-width: var(--mac-control-height);
  padding: 0 var(--mac-control-pad-x);
  border: 0;
  border-radius: var(--mac-radius-button-regular);
  background: var(--mac-on-content-bordered-idle-bg);
  color: var(--mac-label-primary);
  font-family: inherit;
  font-size: var(--mac-control-font); /* saturates at 13px */
  line-height: var(--mac-control-line);
  font-weight: var(--mac-weight-medium);
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
  transition: background-color var(--mac-duration-fast) var(--mac-ease-standard);
}

/* \`.mac-popup\` and \`.mac-pulldown\` are two of the spellings §12.1 registers for
   the pop-up button, so each has to be a whole button on its own — not only a
   120px width on top of \`.mac-button\`. Measured before this rule existed:
   \`<button class="mac-popup">\` came out 120x19, \`border-radius: 0\`, painted with
   the UA button face \`rgb(240,240,240)\`, because the only rules naming it set
   \`justify-content\`, \`width\` and \`padding\`. The modifier rules below stay as
   they are; they now refine a real button in either spelling. */

.mac-button:active {
background: var(--mac-on-content-bordered-clicked-bg);
}

.mac-button:disabled, .mac-button[aria-disabled="true"] {
background: var(--mac-on-content-bordered-disabled-bg);
  color: var(--mac-label-quaternary);
}

.mac-button--prominent {
background: var(--mac-on-content-prominent-idle-bg);
  color: var(--mac-label-on-accent);
}

.mac-button--prominent:active {
background: var(--mac-on-content-prominent-clicked-bg);
}

.mac-button--prominent:disabled, .mac-button--prominent[aria-disabled="true"] {
background: var(--mac-on-content-prominent-disabled-bg);
  color: var(--mac-label-on-accent);
}

.mac-button--tinted {
background: var(--mac-on-content-tinted-idle-bg);
  color: var(--mac-label-on-accent);
}

.mac-button--tinted:active {
background: var(--mac-on-content-tinted-clicked-bg);
}

.mac-button--tinted:disabled, .mac-button--tinted[aria-disabled="true"] {
background: var(--mac-on-content-tinted-disabled-bg);
  color: var(--mac-label-on-accent);
}

.mac-button--destructive {
background: var(--mac-on-content-destructive-bordered-idle-bg);
  color: var(--mac-label-on-accent);
}

.mac-button--destructive:active {
background: var(--mac-on-content-destructive-bordered-clicked-bg);
}

.mac-button--destructive:disabled, .mac-button--destructive[aria-disabled="true"] {
background: var(--mac-on-content-destructive-bordered-disabled-bg);
  color: var(--mac-label-on-accent);
}

.mac-button--destructive.mac-button--prominent {
background: var(--mac-on-content-destructive-prominent-idle-bg);
}

.mac-button--destructive.mac-button--prominent:active {
background: var(--mac-on-content-destructive-prominent-clicked-bg);
}

.mac-button--destructive.mac-button--prominent:disabled {
background: var(--mac-on-content-destructive-prominent-disabled-bg);
}

/* Size ladder. Text stops growing at the regular class, as macOS text does. */

.mac-button--mini {
height: var(--mac-control-height-mini);
  min-width: var(--mac-control-height-mini);
  padding: 0 var(--mac-control-pad-x-mini);
  border-radius: var(--mac-radius-button-mini);
  font-size: var(--mac-control-font-mini);
  line-height: var(--mac-control-line-mini);
}

.mac-button--small {
height: var(--mac-control-height-small);
  min-width: var(--mac-control-height-small);
  padding: 0 var(--mac-control-pad-x-small);
  border-radius: var(--mac-radius-button-small);
  font-size: var(--mac-control-font-small);
  line-height: var(--mac-control-line-small);
}

.mac-button--large {
height: var(--mac-control-height-large);
  min-width: var(--mac-control-height-large);
  padding: 0 var(--mac-control-pad-x-large);
  border-radius: var(--mac-radius-button-large); /* pill */
  font-size: var(--mac-control-font-large);
  line-height: var(--mac-control-line-large);
}

.mac-button--xlarge {
height: var(--mac-control-height-xlarge);
  min-width: var(--mac-control-height-xlarge);
  padding: 0 var(--mac-control-pad-x-xlarge);
  border-radius: var(--mac-radius-button-xlarge); /* pill */
  font-size: var(--mac-control-font-xlarge);
  line-height: var(--mac-control-line-xlarge);
}

/* --- Text field and search field ---------------------------------------
   The well is white in light mode and bordered by a 5% hairline; focus is the
   package-wide ring, not a colour change on the border.                  */

.mac-input {
height: var(--mac-control-height);
  padding: 0 var(--mac-control-pad-x);
  border: 1px solid var(--mac-input-border-idle);
  border-radius: var(--mac-radius-control-regular);
  background: var(--mac-input-bg-idle);
  color: var(--mac-label-primary);
  font-family: inherit;
  font-size: var(--mac-control-font);
  line-height: var(--mac-control-line);
  font-weight: var(--mac-weight-medium);
  -webkit-appearance: none;
  appearance: none;
}

.mac-input::placeholder {
color: var(--mac-label-tertiary);
}

.mac-input:disabled {
background: var(--mac-input-bg-disabled);
  border-color: var(--mac-input-border-disabled);
}

/* --- Checkbox and radio -------------------------------------------------
   The kit measures the accepted box: 16px, radius 5.5, a 10% fill when off.
   Checked is the ACCENT, not a grey: \`Active, Checked, 1 - Idle\` measures
   #0088FF light / #0091FF + #FFFFFF@0.05 dark with #FFFFFF mark ink, which is
   what \`--mac-control-on-idle\` and \`--mac-glyph-primary\` carry. The 14% fill
   with the 70% mark is \`Inactive, Checked\` -- a window in the BACKGROUND -- and
   is modelled by the \`.mac-window--inactive\` rules at the end of this section:
   \`--mac-control-on-inactive\` is that fill and \`--mac-glyph-neutral\` that mark.
   Both marks are drawn with currentColor so they follow the theme without a
   data URI, and the checked ink is one \`color\` on the box.
   Two source notes. (a) The kit's Light/Over-glass TOGGLE sets are stale in
   their \`Checked\` symbols: the checkbox's only checked pair is \`Inactive\` and
   carries the OFF fill #000000@0.15, and the radio's \`Inactive, Checked\` is
   the same #000000@0.15 with a #000000@0.7 dot. The checked appearance here
   comes from that surface's own \`Active, Checked, 1 - Idle\` (#0078F0 +
   #000000@0.05), which is what \`--mac-control-glass-on-idle\` already holds and
   what the over-glass re-point delivers to these rules unchanged. (b) There is no
   \`--mac-control-glass-on-disabled\`: the glass branch carries off-idle,
   off-clicked, on-idle and on-clicked only, so a disabled CHECKED control
   inside glass inherits the content-area \`--mac-control-on-disabled\` (the
   kit's Light/Over-glass \`Active, Checked, 4 - Disabled\` measures #0078F0 +
   #000000@0.05, currently indistinguishable from that surface's on-idle).
   No token is minted for the gap.                                        */

/* The mark: a rotated two-sided border, in currentColor. */

/* The OFF control's pressed state (\`Active, Off, 3 - Clicked\`, 19% black /
   19% white). It needs no \`:not(:checked)\`: the checked rules below out-
   specify it -- \`:checked:active\` is 0,4,1 against this rule's 0,3,1 -- so a
   pressed checked control still takes the on-fill.                        */

/* Radio: the selected dot. The anatomy records only the unselected fill, so
   the selected state uses the same on-fill and mark ink as the checkbox. */

/* Disabled. Both the FILL and the INK split on whether the control is on.
   A checked disabled control keeps the accent (\`Active, Checked, 4 -
   Disabled\`: #0088FF / #0091FF plus the 5% blend, --mac-control-on-disabled)
   AND keeps its WHITE mark: the kit measures a #FFFFFF \`Check\` on all four
   theme x surface combinations, and a #FFFFFF \`Dash\` for \`Active, Mixed, 4 -
   Disabled\`. The plain disabled rule below therefore serves the OFF control
   only, which draws no glyph at all, so its neutral ink is harmless rather
   than load-bearing.                                                      */

/* INACTIVE WINDOW. A window in the background dims its toggles to a neutral:
   \`--mac-control-on-inactive\` is the kit's \`Inactive, Checked\` fill
   (rgba(0,0,0,0.14) light / rgba(255,255,255,0.10) dark) and
   \`--mac-glyph-neutral\` its mark (rgba(0,0,0,0.7) / rgba(255,255,255,0.7));
   the pair is the exact match, which is why no token had to be minted.
   These rules come last so they beat the plain bases at equal specificity;
   \`:checked:active\` also ties at 0,4,1, which is harmless because a window in
   the background does not receive presses.
   \`--mac-control-on-inactive\` now has one user: the checked half here. The
   other one, the inactive sidebar selection, is gone: the kit's
   Sidebars/<theme>/Examples/{Active,Inactive} records reference the same
   symbols, so it draws no distinct inactive selection.
   Deliberately NOT modelled, and no rule is minted for it:
   \`--mac-control-on-inactive-clicked\` and \`--mac-control-on-inactive-disabled\`
   name states a background window cannot enter, and the switch and the
   segmented control keep their active treatments below because the kit does
   not measure their inactive sets -- a value here would be a guess.
   Inside a glass surface these two rules keep the content-area neutral: the
   over-glass re-point has no inactive variant either, the same unmodelled gap
   as \`--mac-control-glass-on-disabled\` above, and no token is minted for it. */

/* --- Switch ------------------------------------------------------------
   Measured (components_anatomy.md, re-measured from the symbolMasters): the
   macOS switch is ONE rounded rect -- 54x24 at the regular size class -- with
   the knob drawn inset inside it. There is no thinner track behind the knob,
   so every length below comes from metric.toggle (switchWidth, switchHeight,
   switchKnobWidth/Height/Inset/Travel) and the whole control resizes with the
   size class. The \`--w\`, \`--h\` and \`--knob\` locals default to the regular
   rung; .mac-switch--mini/--small/--large/--xlarge re-point them.          */

.mac-switch {
--w: var(--mac-switch-w-regular);
  --h: var(--mac-switch-h-regular);
  --knob-w: var(--mac-switch-knob-w-regular);
  --knob-h: var(--mac-switch-knob-h-regular);
  --knob-inset: var(--mac-switch-knob-inset-regular);
  --knob-travel: var(--mac-switch-knob-travel-regular);
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  width: var(--w);
  height: var(--h);
  padding: var(--knob-inset);
  border-radius: var(--mac-radius-pill);
  background: var(--mac-control-off-idle);
  cursor: default;
  transition: background-color var(--mac-duration-base) var(--mac-ease-standard);
}

.mac-switch--mini {
--w: var(--mac-switch-w-mini);
  --h: var(--mac-switch-h-mini);
  --knob-w: var(--mac-switch-knob-w-mini);
  --knob-h: var(--mac-switch-knob-h-mini);
  --knob-inset: var(--mac-switch-knob-inset-mini);
  --knob-travel: var(--mac-switch-knob-travel-mini);
}

.mac-switch--small {
--w: var(--mac-switch-w-small);
  --h: var(--mac-switch-h-small);
  --knob-w: var(--mac-switch-knob-w-small);
  --knob-h: var(--mac-switch-knob-h-small);
  --knob-inset: var(--mac-switch-knob-inset-small);
  --knob-travel: var(--mac-switch-knob-travel-small);
}

.mac-switch--large {
--w: var(--mac-switch-w-large);
  --h: var(--mac-switch-h-large);
  --knob-w: var(--mac-switch-knob-w-large);
  --knob-h: var(--mac-switch-knob-h-large);
  --knob-inset: var(--mac-switch-knob-inset-large);
  --knob-travel: var(--mac-switch-knob-travel-large);
}

.mac-switch--xlarge {
--w: var(--mac-switch-w-xlarge);
  --h: var(--mac-switch-h-xlarge);
  --knob-w: var(--mac-switch-knob-w-xlarge);
  --knob-h: var(--mac-switch-knob-h-xlarge);
  --knob-inset: var(--mac-switch-knob-inset-xlarge);
  --knob-travel: var(--mac-switch-knob-travel-xlarge);
}

.mac-switch input {
position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  border: 0;
}

.mac-switch__knob {
width: var(--knob-w);
  height: var(--knob-h);
  border-radius: var(--mac-radius-pill);
  background: var(--mac-knob-bg-idle);
  box-shadow: var(--mac-knob-shadow-idle);
  transition: transform var(--mac-duration-base) var(--mac-ease-standard);
}

.mac-switch input:checked ~ .mac-switch__knob, .mac-switch--on .mac-switch__knob {
transform: translateX(var(--knob-travel));
}

/* Pressed: the kit draws the knob with strokes rather than fills -- an inner
   halo (clickedGlow) and a hard outer ring (clickedShadow). Both properties
   are Tier 1, so the pressed knob is identical in both themes. */

.mac-switch:active .mac-switch__knob {
box-shadow: var(--mac-knob-glow-clicked), var(--mac-knob-shadow-clicked),
    var(--mac-knob-shadow-idle);
}

.mac-switch:has(input:checked), .mac-switch--on {
background: var(--mac-control-on-idle);
}

.mac-switch input:disabled ~ .mac-switch__knob {
background: var(--mac-knob-bg-disabled);
  /* The token file carries no disabled knob shadow; the idle stack stands in. */
  box-shadow: var(--mac-knob-shadow-idle);
}

/* --- Segmented control --------------------------------------------------
   Measured (components_anatomy.md): a three-way regular control is 90x24, so
   each segment is 30x24 with NO container padding, and the segment radius
   equals the container radius — a selected fill therefore lands exactly on the
   container's own curve. Leaving the container unclipped (no overflow:hidden)
   is deliberate: the focus ring has to be able to draw outside it.        */

/* --- Slider -------------------------------------------------------------
   A real <input type="range"> so it stays keyboard- and screen-reader-usable,
   with the fill driven by \`--mac-slider-progress\`:

     <input class="mac-slider" type="range" min="0" max="100" value="40"
            style="--mac-slider-progress: 40%">

   The name is a contract, not an implementation detail: a slider whose fill
   never moves looks exactly like one that works, so a reader who guesses the
   wrong property gets a silent failure. \`--value\` is still honoured as a
   fallback because assets/demo.html and assets/recipes/*.md were written with
   it, and the sheet's own \`--value: 50%\` below is the default when neither is
   set. The groove needs plain colours inside linear-gradient(), which is why
   the token block publishes the base-colour form of each track fill. */

/* --- Stepper -----------------------------------------------------------
   Measured: the control is 84x24 and each of its two buttons is 20x12, so the
   value well is 64px wide. Chevrons are border triangles in currentColor. */

/* --- Standalone stepper (--bare) ----------------------------------------
   The kit draws two steppers: the 84px composite row above and the standalone
   box — 20x24 at the regular size, two equal halves with no gap (05:386,
   \`Steppers/Light/Content Area/3 Rg\`). 05:396 draws the second by redefining
   .mac-stepper inside a pattern's local <style> block, which shadows a shipped
   class name; --bare is the same box as a modifier instead. The buttons column
   above assumes a field on its left (it is rounded on the right only), so the
   bare form closes the left side as well.                                 */

/* 05:396 also writes the two halves straight into .mac-stepper with no
   __buttons wrapper, where the column direction and the box have to come from
   the stepper itself — the shape whose halves otherwise stack sideways. */

/* --- Progress indicator and spinner ------------------------------------ */

.mac-progress {
--value: 0%;
  position: relative;
  width: 100%; /* the kit's 140px is the drawn instance, not a component width */
  height: var(--mac-progress-bar-regular); /* 10 */
  border-radius: var(--mac-radius-pill);
  background: var(--mac-fill-tertiary); /* fallback: the nearest rung, 0.05 */
  /* check_style: allow-next-line MAC001 -- measured track, no token leaf: the kit's own fill is #000000@0.06 in Light and #FFFFFF@0.08 in Dark. Not glass-aware on purpose: the kit measures no over-glass progress track. */
  background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
  /* check_style: allow-next-line MAC001 -- measured 0.5px inner ring on the track (#000000@0.07 Light, #FFFFFF@0.04 Dark) */
  box-shadow: inset 0 0 0 0.5px light-dark(rgba(0, 0, 0, 0.07), rgba(255, 255, 255, 0.04));
  overflow: hidden;
}

.mac-progress--small {
height: var(--mac-progress-bar-small); /* 6 */
}

.mac-progress__bar, .mac-progress__fill {
width: var(--value);
  min-width: var(--mac-progress-floor-regular); /* measured: 0% still draws 10px */
  height: 100%;
  border-radius: inherit;
  background: var(--mac-track-filled-idle);
  transition: width var(--mac-duration-base) var(--mac-ease-standard); /* derived timing */
}

.mac-progress--small .mac-progress__bar, .mac-progress--small .mac-progress__fill {
min-width: var(--mac-progress-floor-small); /* measured: 0% at 2 Sm draws 8px, not 6 */
}

.mac-progress--indeterminate .mac-progress__bar, .mac-progress--indeterminate .mac-progress__fill {
width: 40%; /* derived */
  animation: mac-progress-slide calc(var(--mac-duration-slow) * 5) var(--mac-ease-standard) infinite; /* 1.5s, derived */
}

/* --- Menu ---------------------------------------------------------------
   A menu is Liquid Glass, never a plain card: its fill stack and its seven
   shadows come from glass.<theme>.Menus. 160px width, 24px rows and an 11px
   separator row are measured (layout_metrics.md, Menus).                  */

.mac-menu {
min-width: 160px; /* measured */
  padding: var(--mac-space-4); /* DERIVED, not a token */
  border-radius: var(--mac-radius-menu); /* 8 */
  background: var(--mac-glass-menus-bg);
  box-shadow: var(--mac-glass-menus-shadow);
  -webkit-backdrop-filter: blur(var(--mac-blur-menu)) saturate(180%);
  backdrop-filter: blur(var(--mac-blur-menu)) saturate(180%);
  color: var(--mac-label-primary);
  font-family: var(--mac-font-sans);
  font-size: var(--mac-control-font);
  line-height: var(--mac-control-line);
}

.mac-menu-item {
display: flex;
  align-items: center;
  gap: var(--mac-space-8); /* DERIVED, not a token */
  height: var(--mac-control-height); /* 24, measured */
  padding: 0 8px;
  border: 0;
  border-radius: var(--mac-radius-control-small);
  background: transparent;
  color: var(--mac-label-primary);
  font: inherit;
  font-weight: var(--mac-text-body-weight);
  text-align: left;
  cursor: default;
}

.mac-menu-item:hover, .mac-menu-item:focus, .mac-menu-item[aria-selected="true"] {
background: var(--mac-control-on-idle);
  color: var(--mac-label-on-accent);
}

.mac-menu-item[aria-disabled="true"] {
color: var(--mac-label-quaternary);
}

.mac-menu-item__check {
flex: 0 0 auto;
  width: 12px; /* measured: the checkmark column */
  color: inherit;
}

.mac-menu-item[aria-checked="true"] .mac-menu-item__check::before {
content: "";
  display: block;
  width: 4px;
  height: 8px;
  margin: 0 0 2px 3px;
  border: solid currentColor;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.mac-menu-item__shortcut {
margin-left: auto;
  padding-left: 16px;
  color: var(--mac-label-secondary);
  /* The kit reserves a 66px shortcut column; a menu with longer glyphs sets
     this itself rather than hard-coding the column here. */
}

.mac-menu-item:hover .mac-menu-item__shortcut, .mac-menu-item:focus .mac-menu-item__shortcut, .mac-menu-item[aria-selected="true"] .mac-menu-item__shortcut {
color: var(--mac-label-on-accent-secondary);
}

.mac-menu__separator {
height: 11px; /* measured */
  margin: 0 8px;
  border: 0;
  background: linear-gradient(var(--mac-separator), var(--mac-separator)) center / 100% 1px no-repeat;
}

.mac-menu__header {
padding: 0 8px;
  height: var(--mac-control-height);
  display: flex;
  align-items: center;
  color: var(--mac-label-secondary);
  /* The header follows the menu's own type, it does not drop to a caption:
     Menus/Regular/Header measures a 13px bold run (h=24) and Menus/Mini/Header
     a 10px bold one (h=19) — the same size as that menu's items, in bold. It
     used to be pinned to caption1 (10px) at 400, which put 10px regular text in
     a 13px menu and disagreed with the reference doc, which showed yet another
     pair of values. */
  font-size: inherit;
  line-height: inherit;
  font-weight: var(--mac-weight-bold);
}

/* --- Popover and tooltip -----------------------------------------------
   A popover is a Liquid Glass surface. The kit measures its fill as
   glass."Regular - Medium" (#FFFFFF@0.7 + #BFBFBF@0.1 in light) over a 30px
   backdrop blur, and 05 §9.1 rejects the opaque reading in as many words: "a
   popover built from --mac-panel-bg and one shadow reads as a card, not a
   glass surface". That card is .mac-popover--panel, opt-in. Glass carries no
   hairline in this kit, so the default has no border. --_mac-popover-bg holds
   the surface colour in one place: .mac-popover__arrow and the variants read
   it, which is also how the arrow inherits the reduced-transparency swap.  */

/* The opaque-card reading: the panel surface with its hairline, no blur, and the
   Content Area appearance set restored, because an opaque surface is not a
   vibrant one - the over-glass re-point keys on the popover class.          */

/* .mac-glass on a popover is the default now, so it changes nothing; --large
   swaps the stack and re-points the alias, and it repeats the shadow so the
   pair agrees however the two rules end up ordered.                        */

/* The kit fills a tooltip with an 85%-alpha light grey / an 80%-alpha dark grey
   and shadows it with two untokenised blacks (layout_metrics.md, Tooltips).
   Neither has a token, so the tooltip uses the thickest material and the panel
   shadow as stand-ins rather than putting a literal colour in this file. */

/* --- List row -----------------------------------------------------------
   Not the sidebar's row: in a content list the row is only as tall as the
   control ladder wants (large = 28px) and the separator is a hairline drawn
   between rows rather than a border on each of them.                     */

.mac-list-row {
display: flex;
  align-items: center;
  gap: var(--mac-space-8); /* DERIVED, not a token */
  min-height: var(--mac-control-height-large); /* 28 */
  padding: 0 8px;
  border-radius: var(--mac-radius-control-regular);
  color: var(--mac-label-primary);
  font-family: var(--mac-font-sans);
  font-size: var(--mac-text-body-size);
  line-height: var(--mac-text-body-line);
  text-align: left;
  cursor: default;
}

.mac-list-row + .mac-list-row {
box-shadow: inset 0 1px 0 var(--mac-separator);
}

.mac-list-row:hover {
background: var(--mac-fill-quinary);
}

.mac-list-row[aria-selected="true"], .mac-list-row--selected {
background: var(--mac-control-on-idle);
  color: var(--mac-label-on-accent);
}

.mac-list-row__title {
flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mac-list-row__detail {
flex: 0 0 auto;
  margin-left: auto;
  color: var(--mac-label-secondary);
}

.mac-list-row[aria-selected="true"] .mac-list-row__detail, .mac-list-row--selected .mac-list-row__detail {
color: var(--mac-label-on-accent-secondary);
}

/* --- Materials (vibrancy) -----------------------------------------------
   Five translucent fills, no glass rim: a material is a tinted layer over the
   window, so it carries the window's own shadow rather than a stack of its
   own. The five blur radii are the one DERIVED family in this file: the kit
   records a backdrop blur for every glass surface but none for a bare
   material weight, so --mac-blur-material-* tracks the measured fill alphas.
   The 180% saturation is a rendering choice, not a kit value.            */

/* --- Liquid Glass ------------------------------------------------------
   Glass is a stack, never one blur: up to thirteen low-alpha fills in the
   fill property and up to thirteen shadows with negative spread in the shadow
   property. The backdrop blur is only the part CSS can add; the rim and the
   depth come from the token stacks. The kit records a blur for the Menus and
   the Notification surfaces and none for the generic glass slabs, so those
   use --mac-blur-popover (30), the closest measured value.               */

/* --- Separator ---------------------------------------------------------- */

.mac-separator {
height: 1px;
  border: 0;
  background: var(--mac-separator);
}

.mac-separator--vertical {
width: 1px;
  height: auto;
  align-self: stretch;
  background: var(--mac-separator);
}

/* --- Focus ring --------------------------------------------------------
   One recipe for the whole package: a 1px inner line at 0.15 alpha on the
   element's own edge and a 3.5px halo at 0.25 alpha outside it, both in the
   system accent — global.focusRing. Never \`outline: 2px solid blue\`, and
   never on :focus, only on :focus-visible, so a mouse click stays quiet.

   The two layers are composed once here because a box-shadow declaration is
   replaced wholesale: an element that carries its own shadow appends the ring
   in front of it, which works because both properties hold whole lists, e.g.
     .mac-window:focus-visible { box-shadow: var(--mac-focus-ring-shadow), var(--mac-shadow-window-active); }
*/

.mac-focus-ring:focus-visible, .mac-button:focus-visible, .mac-input:focus-visible, .mac-list-row:focus-visible, .mac-menu-item:focus-visible {
outline: none;
  box-shadow: var(--mac-focus-ring-shadow);
}

/* The visually hidden inputs pass the ring to the box they paint. */

.mac-switch:has(input:focus-visible) {
box-shadow: var(--mac-focus-ring-shadow);
}

/* The Content Area appearance set, kept at the root under private names so
   an opaque surface can restore what the over-glass block re-points.
   Generated from that block - do not edit by hand. */

/* --- Over-glass appearance set -----------------------------------------
   Controls inside Liquid Glass or a material use appearance.onGlass.*, which
   is a complete second set of fills — never a blend of the two. Re-pointing
   the Tier 1 names here is what keeps every component rule above free of any
   surface or theme branch.
   This block is also the source of truth for the root mirrors above and for
   the restores inside .mac-popover--panel: both are generated from the
   declarations below, so adding a property here adds it to all three.     */

.mac-menu {
--mac-control-off-idle: var(--mac-control-glass-off-idle);
  --mac-control-off-clicked: var(--mac-control-glass-off-clicked);
  --mac-control-on-idle: var(--mac-control-glass-on-idle);
  --mac-control-on-clicked: var(--mac-control-glass-on-clicked);
  --mac-on-content-bordered-idle-bg: var(--mac-on-glass-bordered-idle-bg);
  --mac-on-content-bordered-clicked-bg: var(--mac-on-glass-bordered-clicked-bg);
  --mac-on-content-bordered-disabled-bg: var(--mac-on-glass-bordered-disabled-bg);
  --mac-on-content-prominent-idle-bg: var(--mac-on-glass-prominent-idle-bg);
  --mac-on-content-prominent-clicked-bg: var(--mac-on-glass-prominent-clicked-bg);
  --mac-on-content-prominent-disabled-bg: var(--mac-on-glass-prominent-disabled-bg);
  --mac-on-content-destructive-prominent-idle-bg: var(--mac-on-glass-destructive-prominent-idle-bg);
  --mac-on-content-destructive-prominent-clicked-bg: var(--mac-on-glass-destructive-prominent-clicked-bg);
  --mac-on-content-destructive-prominent-disabled-bg: var(--mac-on-glass-destructive-prominent-disabled-bg);
  --mac-track-filled-idle: var(--mac-track-glass-filled-idle);
  --mac-track-filled-idle-color: var(--mac-track-glass-filled-idle-color);
  --mac-track-unfilled-idle: var(--mac-track-glass-unfilled-idle);
  --mac-track-unfilled-idle-color: var(--mac-track-glass-unfilled-idle-color);
  --mac-track-tick-mark: var(--mac-track-glass-tick-mark);
  --mac-track-tick-mark-center: var(--mac-track-glass-tick-mark-center);
  --mac-track-tick-mark-disabled: var(--mac-track-glass-tick-mark-disabled);
  --mac-segmented-on-bg-idle: var(--mac-segmented-glass-on-bg-idle);
  --mac-segmented-on-bg-clicked: var(--mac-segmented-glass-on-bg-clicked);
  --mac-segmented-on-bg-disabled: var(--mac-segmented-glass-on-bg-disabled);
  --mac-segmented-track-bg: var(--mac-control-glass-off-idle);
}

/* ==========================================================================
   Reference-document classes.
   --------------------------------------------------------------------------
   Every class tools/NAMING.md §12.1 names that the sections above do not
   define, so a page written from references/05-components.md and a page
   written from these rules use one vocabulary.

   Geometry is measured in references/05-components.md, which cites the analysis
   workspace temp/macos27kit/ (outside this package, not shipped).
   Colours are the same Tier 1
   properties as everywhere else, so these rules are identical in both themes
   and re-point themselves inside a glass surface.

   Eight measured values have no token leaf: the three window-control fills,
   their two inner rings, the utility panel's control fill, the alert icon's
   drop shadow and the sheet scrim's overlay pair. They are written literally
   with a \`check_style: allow-next-line MAC001\` pragma, exactly as
   references/05-components.md writes them for the same measurements. They are
   NOT color.system.* values.
   ========================================================================== */

/* --- Icons and helpers --------------------------------------------------
   The reference markup is an inline \`<svg viewBox="0 0 16 16">\` with
   stroke="currentColor", stroke-width="1.5" and no width/height of its own, so
   the box has to be set here or the SVG falls back to its 300x150 default. */

.mac-icon {
display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  vertical-align: -0.22em; /* centres the 16px box on a 13/16 line */
}

/* Scaled variants transform instead of resizing: the stroke stays 1.5px, which
   is what the kit does — a smaller glyph is not a thinner one. */

.mac-icon--sm {
transform: scale(0.85);
}

.mac-icon--xs {
transform: scale(0.7);
}

/* Visually hidden, still announced: the shim for a control the page draws. */

.mac-hidden {
position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
  opacity: 0;
  pointer-events: none;
}

/* A 16px glyph slot pinned to the vertical centre of a field. The horizontal
   offset belongs to the app: \`style="left: 8px"\` for a leading magnifier,
   \`style="right: 4px"\` for a trailing clear button (measured). */

.mac-adornment, .mac-input__adornment {
position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  margin-top: -8px;
  color: var(--mac-label-secondary);
}

/* --- Button variants ---------------------------------------------------- */

/* A borderless button keeps its measured box and drops the chrome. The border
   is made transparent rather than removed so the label does not shift by the
   hairline the base rule reserves. */

.mac-button--borderless {
min-width: 0;
  padding: 0 6px;
  border-color: transparent;
  background: none;
}

.mac-button--borderless:active {
background: var(--mac-fill-tertiary);
}

/* A toggle is a push button that stays down. Its on state is the prominent
   stack — the accent plus the 3% black layer in light, the plain accent in
   dark — which is the property \`.mac-button--prominent\` uses, so it re-points
   to the glass stack by itself inside a glass surface. */

.mac-button--toggle {
min-width: 94px;
}

.mac-button--toggle[aria-pressed="true"] {
border-color: transparent;
  background: var(--mac-on-content-prominent-idle-bg);
  color: var(--mac-label-on-accent);
}

/* Pop-up and pulldown: one box with an indicator slot at the trailing edge.
   The pop-up's value inset is 12px so a 24px slot sits at x=96 of the 120px
   control; the pulldown keeps the regular 16px inset and drops the gap. §12.1
   registers the pair as classes of their own as well, so both spellings work. */

.mac-button--popup {
justify-content: space-between;
  width: 120px;
  padding: 0 8px 0 12px;
}

.mac-button--pulldown {
justify-content: space-between;
  gap: 0;
  width: 120px;
  padding: 0 var(--mac-control-pad-x) 0 12px;
}

/* --- Combo box ---------------------------------------------------------- */

/* The field carries the idle input-field fill and border
   (component.inputField.<theme>.idle) rather than a surface fill. */

/* The dropdown button inside the field: 24x20, 2px from the trailing edge, on
   the secondary fill. */

/* --- Disclosure button --------------------------------------------------
   The chevron is the button's own child; the button rotates from pointing
   right to pointing down. 05 declares the transition on the expanded state
   only, which animates one direction; on the base rule both do. Its timing is
   05's own derived choice.                                                */

/* --- Labelled field -----------------------------------------------------
   The caption-above-field stack, not a positioned wrapper: one column with the
   measured 4px between the caption and the box.                           */

.mac-input-wrap {
display: grid;
  gap: var(--mac-space-4); /* measured 4px */
  justify-items: start;
}

.mac-input-wrap > span {
font-size: var(--mac-text-body-size);
  line-height: var(--mac-text-body-line);
  color: var(--mac-label-secondary);
}

/* --- Search field clear button ------------------------------------------
   Measured: a 16px slot 4px in from the trailing edge; the text stops 20px
   short of it so the glyph never overlaps the value.                      */

/* --- Drawn slider knob --------------------------------------------------
   The native thumb above carries this recipe already; a slider the page draws
   itself uses the same 20x16 pill. The kit's slider symbol is 140px wide and
   .mac-slider is fluid, so give the input an explicit width to match.     */

/* \`.mac-progress__fill\` is the reference spelling of the bar; it is aliased to
   \`.mac-progress__bar\` in the progress section above, so it fills from
   component.track.filledIdle — the same accent fill the kit gives a slider
   groove — rather than hard-coding --mac-accent. Its width comes from the
   \`--value\` the container carries.                                       */

/* --- Menu --------------------------------------------------------------- */

.mac-menu-item--destructive {
color: var(--mac-destructive);
}

/* The label column is what pushes the shortcut column to the trailing edge; it
   is a sibling of __check and __shortcut. */

.mac-menu-item__label {
flex: 1 1 auto;
}

/* --- Toolbar ------------------------------------------------------------ */

/* --- Sidebar section header ---------------------------------------------
   Measured 240x20 at the large size class, SF Pro Bold 13px, #B2B2B2 — the
   tertiary rung is the nearest step on the label ladder.                  */

/* --- List --------------------------------------------------------------- */

.mac-list {
display: flex;
  flex-direction: column;
  background: var(--mac-window-bg);
  color: var(--mac-label-primary);
  font-family: var(--mac-font-sans);
  font-size: var(--mac-text-body-size);
  line-height: var(--mac-text-body-line);
}

/* 05 also draws an alternating stripe — nth-child(even) on
   var(--mac-fill-quinary) — which is the fill .mac-list-row:hover already
   uses, so a stripe would make every even row's hover invisible. The stripe is
   left out.                                                              */

/* --- Popover arrow ------------------------------------------------------
   A 12px square rotated 45deg with half of it under the panel: top -3px leaves
   the 6px point outside. The fill is the panel's own --_mac-popover-bg, so the
   arrow follows the glass default, .mac-popover--panel and mac-glass--large
   without a second source of truth, and it inherits the reduced-transparency
   swap with it. The fallback keeps an arrow that is somehow not inside its
   popover on the glass fill rather than turning it transparent.
   The blur is best-effort: a backdrop-filtered ancestor roots the backdrop
   image, so over the panel it re-blurs a flat gradient (a no-op) and the
   protruding tip frosts only where the page stays in the backdrop.        */

/* --- Popover anatomy ----------------------------------------------------
   The parts a popover is assembled from. references/06-patterns.md §6
   publishes the markup and the measured table (06:175-182): rows inside sit at
   the control height, label --mac-label-primary, value --mac-label-secondary.
   The panel itself is .mac-popover above. 06:179 and 05 §9.1 agree on the
   surface — glass "Regular - Medium" — so the default is glass and
   .mac-popover--panel is the opaque card reading.                          */

/* --- Alert --------------------------------------------------------------
   The kit draws the alert as Liquid Glass Regular - Large — the same fill
   stack and nine-shadow rim as the large glass surface — with one extra
   measured blur of 46px, which no --mac-blur-* entry covers.              */

/* Measured SF Pro Bold 13/16 at 85% black. */

/* The kit measures the body at #363636, which --mac-label-vibrant-primary
   carries exactly; 05 ships the secondary rung, which is what stays here. */

/* Used with .mac-button (as the reference markup does) so the fill comes from
   the button appearance set: the alert's covered button is the bordered idle
   fill and the preferred one is .mac-button--prominent. The alert's own button
   size is 28px with the large, pill radius. */

/* --- Sheet scrim --------------------------------------------------------
   The kit's modal overlay is a theme pair — rgba(171,171,171,0.6) over light
   content, rgba(23,23,23,0.62) over dark — with no token leaf and no place in
   a Tier 1 name, because no rule in this layer branches on light/dark.
   \`light-dark()\` reads the color-scheme the generated blocks already set on
   :root, so the pair stays one theme-resolved declaration; the material fill
   is the fallback for engines that do not support it yet.                 */

/* --- Notification -------------------------------------------------------
   Measured 344x78 on the notification glass surface, 12/10 padding, three
   columns: icon, text, trailing image.                                    */

/* The kit measures both the title and the message at #363636, so the message
   is not dimmed: one colour on the container, the title only adds weight. */

/* Measured 11px, 10px in from the top-right; the tertiary rung is the nearest
   step on the label ladder (#737373 in the kit's own measurement).        */

/* --- Window controls ----------------------------------------------------
   The kit's own chrome colours. They are NOT color.system.*: the stoplights
   are a separate measured set (Titlebars/<theme>/Window Controls/Standard) and
   #FF5C60 / #FAC800 / #35C759 appear nowhere in macos27.tokens.json, so they
   are written literally with a linter pragma, as references/05-components.md
   does for the same values.
   Markup, inside \`.mac-titlebar\`:
     <div class="mac-window__traffic">
       <span class="mac-window__light mac-window__light--close"></span>
       <span class="mac-window__light mac-window__light--minimize"></span>
       <span class="mac-window__light mac-window__light--expand"></span>
     </div>                                                                */

/* A window that is not key draws three neutral ovals. */

/* A utility panel's controls are 10px ovals 7px apart (44x10 measured). The
   kit measures the oval as white at 17%, which is the dark panel's value; on a
   light panel it is the same low-contrast shape. */

/* --- Titlebar subtitle -------------------------------------------------- */

/* --- Scroller -----------------------------------------------------------
   A 12px gutter with no rail: a transparent 2px border insets the thumb, so
   the visible bar is 8px wide.                                           */

/* --- Group box ----------------------------------------------------------
   Measured: one 3% fill layer, no border and no shadow.                   */

.mac-group-box {
padding: 12px;
  border: 0;
  border-radius: var(--mac-radius-group-box); /* 12 */
  background: var(--mac-fill-quaternary);
  color: var(--mac-label-primary);
  font-size: var(--mac-text-body-size);
  line-height: var(--mac-text-body-line);
}

.mac-group-box legend {
padding: 0 4px;
  font-weight: var(--mac-weight-bold);
  color: var(--mac-label-secondary);
}

/* --- Colour well ------------------------------------------------------- */

/* The swatch is squarer than the well it sits in: 3px against the 6px rung. */

/* --- Tab bar -----------------------------------------------------------
   Measured: a 220x30 bar holding five 44x28 tabs at y=2. The tab's own radius
   is 9px, not the 6px control rung, and the selected tab is a small glass
   surface rather than a solid fill.                                      */

/* --- Labelled switch ---------------------------------------------------
   \`.mac-switch\` is the pill and cannot host its own label, so a labelled row
   is a \`<label>\` wrapping the pill and the text, with the hidden input as the
   pill's first child — NOT a sibling of the pill. \`input:checked\` only reaches
   the knob through \`input:checked ~ .mac-switch__knob\` (below) and only reaches
   the fill through \`.mac-switch:has(input:checked)\`, so an input placed outside
   \`.mac-switch\` produces a switch that never turns on:
     <label class="mac-switch-wrap">
       <span class="mac-switch">
         <input class="mac-hidden" type="checkbox" role="switch">
         <span class="mac-switch__knob"></span>
       </span>
       Ask before closing
     </label>                                                            */

.mac-switch-wrap {
display: inline-flex;
  align-items: flex-start; /* the text starts at the top of the pill */
  gap: var(--mac-space-8);
  min-height: var(--mac-control-height); /* 24 at the regular size */
  color: var(--mac-label-primary);
  font-size: var(--mac-control-font);
  line-height: var(--mac-control-line);
  cursor: default;
}

/* --- Reduced motion ----------------------------------------------------
   Durations and easings come from motion.*, which the token file itself marks
   as derived — the kit encodes no timings.                        */

.mac-button, .mac-input, .mac-list-row, .mac-menu-item, .mac-switch, .mac-switch__knob, .mac-progress__bar, .mac-progress__fill {
transition: none;
}
/* The selection fill is painted by a pseudo-element whose own selector is
     far more specific than the \`.mac-sidebar-item\` entry above — (0,3,2)
     against (0,1,0) — so that entry cannot switch it off. Measured: without
     this rule the fill kept its 0.13s fade with
     \`prefers-reduced-motion: reduce\` forced, while every other transition in
     the sheet went to 0s. Same four selectors as the fill rule itself. */
/* A progress spinner is the one animation that carries meaning, so it slows
     down instead of stopping. 2.4s = eight times the slow duration, derived. */
.mac-progress--indeterminate .mac-progress__bar {
animation: none;
    width: 100%; /* derived: without motion an indeterminate bar reads as full */
}
`;
    // <<< END MAC THEME

    const CSS = `
.dab-root{display:flex;flex-direction:column;gap:var(--mac-space-16);font-family:var(--mac-font-sans);color:var(--mac-label-primary)}
.dab-bar{display:flex;align-items:center;gap:var(--mac-space-8);flex-wrap:wrap;min-height:var(--mac-control-height)}
.dab-bar__text{color:var(--mac-label-secondary)}
.dab-spacer{flex:1 1 auto}
.dab-row{display:flex;align-items:center;gap:var(--mac-space-8);flex-wrap:wrap}
.dab-note{color:var(--mac-label-tertiary);font-size:11px;line-height:14px}
.dab-note--box{padding:var(--mac-space-8) var(--mac-space-10);border-radius:var(--mac-radius-control-regular);background:var(--mac-fill-quaternary);color:var(--mac-label-secondary)}
.dab-note--error{background:var(--mac-fill-quaternary);color:light-dark(var(--mac-system-red-light),var(--mac-system-red-dark))}
.dab-note--error-text{color:light-dark(var(--mac-system-red-light),var(--mac-system-red-dark))}
.dab-note--ok{background:var(--mac-fill-quaternary);color:light-dark(var(--mac-system-blue-light),var(--mac-system-blue-dark))}
.dab-mono{font-family:var(--mac-font-mono);font-size:11px}
.dab-ellipsis{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-tag{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:var(--mac-radius-pill);background:var(--mac-fill-secondary);color:var(--mac-label-secondary);font-size:10px;line-height:13px;font-weight:var(--mac-weight-medium);white-space:nowrap}
.dab-tag--accent{color:light-dark(var(--mac-system-blue-light),var(--mac-system-blue-dark))}
.dab-tag--ok{color:light-dark(var(--mac-system-green-light),var(--mac-system-green-dark))}
.dab-tag--warn{color:light-dark(var(--mac-system-orange-light),var(--mac-system-orange-dark))}
.dab-tag--danger{color:light-dark(var(--mac-system-red-light),var(--mac-system-red-dark))}
.dab-tag--muted{color:var(--mac-label-tertiary)}
.dab-family{display:flex;flex-direction:column;gap:var(--mac-space-8)}
.dab-family__head{display:flex;align-items:center;gap:var(--mac-space-8);flex-wrap:wrap}
.dab-login{display:flex;align-items:center;gap:var(--mac-space-8);flex-wrap:wrap}
.dab-login__bar{flex:1 1 120px;max-width:220px}
/* 登录中间的问题：换行成一整块，问题在一行、输入与按钮在下一行。 */
.dab-prompt{display:flex;align-items:center;gap:var(--mac-space-8);flex-wrap:wrap;padding:var(--mac-space-6) var(--mac-space-8);border-radius:var(--mac-radius-group-box);background:var(--mac-fill-quinary)}
.dab-prompt__ask{flex:1 1 240px}
.dab-prompt__options{display:flex;align-items:center;gap:var(--mac-space-6);flex-wrap:wrap}
.dab-prompt__field{flex:0 1 260px}
.dab-empty{padding:var(--mac-space-10);border-radius:var(--mac-radius-group-box);background:var(--mac-fill-tertiary);color:var(--mac-label-tertiary);font-size:12px;line-height:15px}
.dab-link{color:light-dark(var(--mac-system-blue-light),var(--mac-system-blue-dark));text-decoration:none}
.dab-link:hover{text-decoration:underline}
.dab-account{padding-top:var(--mac-space-6);padding-bottom:var(--mac-space-6)}
.dab-account--off{opacity:.55}
.dab-account__main{display:flex;flex-direction:column;gap:var(--mac-space-4);flex:1 1 auto;min-width:0}
.dab-account__sub{display:flex;align-items:center;gap:var(--mac-space-6);flex-wrap:wrap;color:var(--mac-label-secondary)}
.dab-account__quota{display:flex;flex-direction:column;gap:var(--mac-space-4);flex:0 0 auto;width:200px}
.dab-account__actions{display:flex;align-items:center;gap:var(--mac-space-8);flex:0 0 auto}
.dab-quota{display:flex;align-items:center;gap:var(--mac-space-6)}
.dab-quota__name{flex:0 0 48px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mac-label-tertiary);font-size:10px;line-height:13px}
.dab-quota__bar{flex:1 1 0;min-width:48px}
.dab-quota__pct{flex:0 0 auto;min-width:34px;text-align:right;color:var(--mac-label-secondary);font-size:10px;line-height:13px;font-variant-numeric:tabular-nums}
.dab-quota__reset{flex:0 0 auto;color:var(--mac-label-quaternary);font-size:10px;line-height:13px}
.dab-quota--low .mac-progress__fill{background:light-dark(var(--mac-system-red-light),var(--mac-system-red-dark))}
.dab-quota--mid .mac-progress__fill{background:light-dark(var(--mac-system-orange-light),var(--mac-system-orange-dark))}
.dab-quota--unknown .dab-quota__bar{display:none}
.dab-menu-wrap{position:relative;display:inline-flex}
.dab-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:20}
.dab-field{justify-items:stretch;flex:1 1 auto}
.dab-field>.mac-input{width:100%}
.dab-proxy{display:flex;align-items:flex-end;gap:var(--mac-space-8);flex-wrap:wrap;margin-top:var(--mac-space-6);padding:var(--mac-space-8);border-radius:var(--mac-radius-control-regular);background:var(--mac-fill-quinary)}
.dab-foot{color:var(--mac-label-tertiary);padding-top:var(--mac-space-8);border-top:1px solid var(--mac-separator)}
.dab-card-summary{display:flex;align-items:center;gap:var(--mac-space-6);flex-wrap:wrap;color:var(--mac-label-secondary)}
.dab-card-summary__tag{flex:0 0 auto}
`



    // ---------------------------------------------------------------- 插件

    /** 客户端服务依赖。少一个 `apply` 就不会跑，所以只列真正要用的。 */
    const inject = ['slots']

    function apply(ctx) {
      // 样式挂到 document.head，卸载时摘掉。这是客户端插件的社区惯例
      // （宿主不给插件样式隔离，所以类名统一加前缀）。
      //
      // 两段拼在一起：前半是 macOS 27 主题（生成物，全是 `--mac-*` 与 `.mac-*`），
      // 后半是面板自己那一层（`.dab-*`，只加布局与语义色）。装之前 grep 过宿主的 asar：
      // 文档里没有 `mac-` 前缀的类、也没有 `--mac-*` 变量，所以是空场地，不必再套作用域。
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-account-bridge'
        style.textContent = `${MAC_THEME_CSS}\n${CSS}`
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

      // 设置 → 模型页的两处：卡片行内摘要 + 页脚。两处都**不是**必需的，
      // 任一席位被别人占了、或这一版宿主没声明它，都只警告不抛——
      // 为了让一个可选摘要把整个插件（连同账号池面板）拉下来是不划算的。
      ctx.slots.inject(PROVIDER_CARD_SLOT, () => {
        try {
          return ctx.slots.register({ name: PROVIDER_CARD_SLOT, key: '', order: 30 }, ProviderCardSummary)
        } catch (error) {
          console.warn('[dsh-account-bridge] provider 卡片摘要没挂上：', error)
          return undefined
        }
      })

      ctx.slots.inject(MODELS_FOOTER_SLOT, () => {
        try {
          return ctx.slots.register({ name: MODELS_FOOTER_SLOT, id: 'account-bridge', order: 40, label: '账号池' }, ModelsFooter)
        } catch (error) {
          console.warn('[dsh-account-bridge] 模型页页脚没挂上：', error)
          return undefined
        }
      })
    }

    module.exports = {
      apply,
      inject,
      AccountPoolSection,
      ProviderCardSummary,
      ModelsFooter,
      // 登录中间那个问题也要能单独挂起来查：三个分支（输入 / 密钥 / 选择题）
      // 只有在被问到时才渲染，挂在整块面板上就得为每个分支各造一个族。
      LoginPrompt,
      // 纯函数对测试开放。这里不做摇树优化，多这几个属性对体积没有意义，
      // 但「剩余 0%」与「查不到」必须能被单独钉住——它们在面板上是两句话。
      __internal: {
        call,
        percentText,
        untilText,
        bestRemaining,
        familySummary,
        loginStatusText,
        sourceText,
        summaryStore,
        API,
        SETTINGS_SLOT,
        PROVIDER_CARD_SLOT,
        MODELS_FOOTER_SLOT,
        SUMMARY_FRESH_MS,
      },
    }
    return module.exports
  },
})
