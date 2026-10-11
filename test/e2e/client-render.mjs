/**
 * 前端那一半的端到端：**在 Node 里把 `src/client.js` 真跑一遍**。
 *
 * 为什么它不能待在探针里（`test/e2e/probe/index.js`）：探针跑在**真宿主**的 Node 进程里，
 * 那里没有 `document`、没有 React、也没有浏览器。而 `src/client.js` 只在 GUI 里被加载，
 * 于是「面板有没有坏」这件事在改前端时**一条自动检查都碰不到**——改错了类名、写错了字段、
 * 搬掉一个 hook，全部只会静静地不生效。
 *
 * 这里补的就是那一块：一个约 100 行的 mini-react（`createElement` + 三个 hook + 一次遍历）
 * + 假 `document` + 假 `fetch`，把三处席位渲染出来，看渲染树里到底有什么。
 *
 * **它能证明的**：工厂跑得起来、三个组件在真实数据形状（照 `src/api.js` 的 `snapshot()`
 * 抄的）下不抛错、渲染出来的树里确实带着我们以为的那些类名与文案、以及额度百分比真的
 * 换算成了 `--value`。
 * **它证明不了的**（写在 README 里也一样）：
 *   · 看起来对不对——这不是 React，也不是浏览器，「Liquid Glass 在这个页面上好不好看」只有人眼睛能判；
 *   · **任何布局与层叠**——样式表只是被当成一段文本查了关键词，没有一个像素被算过。
 *     所以像「未知额度不画条」这种结论，一半靠渲染树（有没有那个类、文字写的是什么），
 *     另一半只能靠直接查样式表里那条 `display:none`（两条检查都在下面）。
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../src/client.js', import.meta.url))

// ---------------------------------------------------------------- mini-react

/**
 * 够用的 React 替身。
 *
 * 三个 hook 都按「同一个组件、同一个出现次序」分配槽位（键是 `组件名#本次第几个`），
 * effect 在提交后跑、卸载时按反序清理——面板在有族正在登录时会起 `setInterval`，
 * 不清理就会让测试进程吊着一个定时器不退出。
 */
function createMiniReact() {
  const store = new Map()
  let cursor = null
  let currentKey = null
  let slots = new Map()
  let dirty = false
  let effects = []
  let budget = 0
  let lastType = '-'

  function createElement(type, props, ...children) {
    const list = []
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || typeof child === 'boolean') continue
      list.push(child)
    }
    return { type, props: { ...(props ?? {}), children: list } }
  }

  function sameDeps(previous, deps) {
    if (deps === undefined) return false
    if (!Array.isArray(previous) || previous.length !== deps.length) return false
    return previous.every((item, at) => Object.is(item, deps[at]))
  }

  function slotOf(make, stale) {
    const index = cursor.index
    cursor.index += 1
    const held = cursor.values[index]
    if (held === undefined) {
      cursor.values[index] = { value: make(), deps: undefined }
      return cursor.values[index]
    }
    if (stale !== undefined && stale(held.deps)) held.value = make()
    return held
  }

  const React = {
    createElement,
    useState(initial) {
      const slot = slotOf(() => (typeof initial === 'function' ? initial() : initial))
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }
      return [slot.value, set]
    },
    useEffect(fn, deps) {
      const slot = slotOf(() => undefined)
      // 没给依赖数组 = 每次提交都跑（跟 React 一样）。给了就只在数组变了时跑。
      if (slot.ran === true && sameDeps(slot.deps, deps)) return
      slot.deps = Array.isArray(deps) ? [...deps] : undefined
      slot.ran = true
      effects.push({ fn, key: currentKey })
    },
    useCallback(fn, deps) {
      const slot = slotOf(() => fn, (previous) => !sameDeps(previous, deps))
      slot.deps = Array.isArray(deps) ? [...deps] : undefined
      return slot.value
    },
  }

  /** 深度优先走一遍，函数组件就地调用，把类名、文字、内联样式抓下来。 */
  function walk(node, out) {
    budget += 1
    if (budget > 200_000) throw new Error(`渲染失控：走过 20 万个节点，最后停在 ${lastType}`)
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node).trim()
      if (text) out.texts.push(text)
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out)
      return
    }
    lastType = typeof node.type === 'function' ? node.type.name || 'anonymous' : String(node.type)
    if (typeof node.type === 'function') {
      const name = node.type.name || 'anonymous'
      const key = `${name}#${slots.get(name) ?? 0}`
      slots.set(name, (slots.get(name) ?? 0) + 1)
      if (!store.has(key)) store.set(key, { values: [], cleanups: [] })
      const previous = cursor
      const previousKey = currentKey
      cursor = store.get(key)
      currentKey = key
      cursor.index = 0
      try {
        walk(node.type(node.props), out)
      } finally {
        cursor = previous
        currentKey = previousKey
      }
      return
    }
    const props = node.props ?? {}
    if (typeof props.className === 'string') {
      for (const name of props.className.split(/\s+/)) if (name) out.classes.push(name)
    }
    if (props.style && props.style['--value'] !== undefined) out.values.push(props.style['--value'])
    // 记下可点的东西：菜单是点开才渲染的，不点一次就永远检查不到它里面有什么。
    if (typeof props.onClick === 'function') {
      out.handlers.push({ className: props.className, haspopup: props['aria-haspopup'], onClick: props.onClick })
    }
    walk(props.children ?? [], out)
  }

  return {
    React,
    /** 渲染到状态稳定；每次提交后跑 effect。effect 抛错就抛出去——静默吞掉等于假绿。 */
    async mount(element) {
      for (let pass = 0; pass < 20; pass += 1) {
        slots = new Map()
        effects = []
        dirty = false
        currentKey = null
        cursor = { values: [], index: 0 }
        budget = 0
        const out = { classes: [], texts: [], values: [], handlers: [] }
        walk(element, out)
        const running = effects.map(({ fn, key }) => {
          const cleanup = fn()
          if (typeof cleanup === 'function') {
            const instance = store.get(key) ?? { values: [], cleanups: [] }
            instance.cleanups.push(cleanup)
            store.set(key, instance)
          }
          return cleanup
        })
        await Promise.all(running.map((item) => Promise.resolve(item)))
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!dirty) return out
      }
      throw new Error('渲染 20 轮还没稳定（像是 setState 在渲染期间被无条件调用）')
    },
    /** 卸载：按登记的反序跑清理函数。面板登录中会起 `setInterval`，不清理进程会吊着不退出。 */
    unmount() {
      for (const instance of store.values()) {
        for (const cleanup of instance.cleanups.reverse()) cleanup()
        instance.cleanups = []
      }
    },
  }
}

// ---------------------------------------------------------------- 假宿主

/**
 * 一份照 `src/api.js` 的 `snapshot()` 与 `publicAccount()` 抄的现场。
 *
 * 三个族刻意各占一类：有额度、没额度、空池；账号上把「冷却中 / 已停用 / token 已过期 /
 * 共用 / 不可续期」五个状态都摆出来——它们正是面板里最容易漏掉的分支。
 */
function fixture() {
  const now = Date.now()
  const account = (over) => ({
    family: 'codex',
    externallyOwned: false,
    disabled: false,
    renewable: true,
    expiresAt: now + 3_600_000,
    authKind: 'oauth',
    createdAt: 1,
    updatedAt: 1,
    status: 'ready',
    limits: { maxRpm: 0, maxConcurrency: 0, from: 'global' },
    ...over,
  })
  return {
    affinity: { mode: 'auto', modes: ['auto', 'session', 'turn', 'off'], persisted: true, remembered: 3, why: [] },
    families: [
      {
        family: 'codex',
        displayName: 'ChatGPT (Codex)',
        route: 'acct-codex',
        risk: 'low',
        discoverable: true,
        loginMethods: [
          { id: 'oauth', label: '登录 ChatGPT' },
          { id: 'apikey', label: '用 API Key' },
        ],
        accounts: [
          account({
            id: 'codex-1',
            label: 'bridge@example.com',
            source: 'client-import',
            externallyOwned: true,
            quota: [
              { id: '5h', name: '5 小时窗口', remainingFraction: 0.82, resetAt: now + 5_400_000 },
              { id: 'week', name: '一周窗口', remainingFraction: 0.04, resetAt: now + 86_400_000 },
            ],
          }),
          account({
            id: 'codex-2',
            label: 'second@example.com',
            source: 'manual',
            renewable: false,
            expiresAt: now - 1000,
            proxy: 'http://127.0.0.1:8888',
            status: 'cooling',
            cooldownUntil: now + 600_000,
            limits: { maxRpm: 60, maxConcurrency: 2, from: 'account' },
            quota: [],
          }),
        ],
        login: { status: 'running', url: 'https://example.com/authorize?x=1', message: '在浏览器里完成授权' },
      },
      {
        family: 'generic',
        displayName: 'OpenAI 兼容端点',
        route: 'acct-generic',
        risk: 'medium',
        discoverable: false,
        loginMethods: [{ id: 'manual', label: '手动添加' }],
        accounts: [],
        login: { status: 'failed', error: '密钥被拒绝：401' },
      },
      {
        family: 'qoder',
        displayName: 'Qoder',
        route: 'acct-qoder',
        risk: 'high',
        discoverable: false,
        loginMethods: [{ id: 'paste', label: '粘贴令牌' }],
        accounts: [
          account({
            id: 'qoder-1',
            family: 'qoder',
            source: 'apikey',
            disabled: true,
            authKind: 'apikey',
            host: 'api.qoder.com',
            expiresAt: undefined,
            limits: { maxRpm: 0, maxConcurrency: 0, from: 'family' },
            quota: undefined,
          }),
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------- 一轮

const NEEDLES_IN_SHEET = [
  '--mac-control-height-regular: 24px', // 主题真的进来了（不是只剩面板那一层）
  '--mac-blur-menu',
  '.mac-group-box',
  '.mac-switch',
  '.mac-list-row',
  '.dab-root', // 面板那一层也进来了
  '.dab-quota--unknown',
]

/** 跑一轮，返回和探针同形的报告。 */
export async function runClientRender() {
  const checks = []
  const check = (name, pass, detail) => checks.push({ name, pass: pass === true, detail: detail ?? '' })
  const realFetch = globalThis.fetch
  let runtime

  try {
    const source = fs.readFileSync(CLIENT, 'utf8')
    const head = []
    const document = {
      head: { appendChild: (node) => head.push(node) },
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    }
    let loaded
    const window = { __ModuleLoader__: { load: (mod) => { loaded = mod } } }
    runtime = createMiniReact()
    const requireModule = (name) => {
      if (name === 'react') return runtime.React
      throw new Error(`客户端只该 require('react')，却要了 '${name}'`)
    }

    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'require', 'console', source)(window, document, requireModule)
    if (typeof loaded?.factory !== 'function') throw new Error('没有捕获到 window.__ModuleLoader__.load 的工厂')

    const state = fixture()
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: state }) })

    const app = loaded.factory(requireModule)
    const registered = []
    app.apply({
      effect: (fn) => {
        fn()
      },
      slots: {
        inject: (_name, callback) => callback(),
        register: (declaration, component) => {
          registered.push({ declaration, component })
          return () => {}
        },
      },
    })

    check('三处席位都注册上了，样式也挂上了', head.length === 1 && registered.length === 3, `style=${head.length} registered=${registered.length}`)

    const sheet = head[0]?.textContent ?? ''
    const missing = NEEDLES_IN_SHEET.filter((needle) => !sheet.includes(needle))
    check('注入的样式里主题与面板那一层都在', missing.length === 0 && sheet.length > 90_000, missing.length ? `少了 ${missing.join(' / ')}` : `${sheet.length} 字节`)

    check(
      '样式表：未知额度那条进度条是被 CSS 藏起来的',
      sheet.includes('.dab-quota--unknown .dab-quota__bar{display:none}'),
      '渲染树里看不到 display，所以这条只能查样式表本身',
    )

    const pool = await runtime.mount(runtime.React.createElement(app.AccountPoolSection))
    const has = (name) => pool.classes.includes(name)
    const anyText = (needle) => pool.texts.some((text) => String(text).includes(needle))

    check('族卡片用 group box，账号行用 list row', has('mac-group-box') && has('mac-list-row'))
    check('开关用的是 kit 的 switch，且 knob 在里面', has('mac-switch') && has('mac-switch__knob'))
    // 条宽（`--value`）与右边那个百分数**是两处各自算的**，所以两处都要看：
    // 只查一处的话，另一处写成 `0.82%` 这种「原样输出」不会被发现。
    check(
      '额度条：用 kit 的 progress，条宽与文字都是算过的百分数',
      has('mac-progress--small') && pool.values.includes('82%') && pool.values.includes('4%') && pool.texts.includes('82%') && pool.texts.includes('4%'),
      `条=${pool.values.join(',')} 文字=${pool.texts.filter((text) => String(text).includes('%')).join(',')}`,
    )
    check('低额度被标成 low', has('dab-quota--low'))
    check('额度未知的账号标成 unknown，而且不写成 0%', has('dab-quota--unknown') && !pool.texts.includes('0%'), pool.texts.filter((text) => String(text).includes('%')).join(','))
    check(
      '五个账号状态都写出来了',
      ['冷却中', '已停用', 'token 已过期', '共用', '本机导入'].every(anyText),
      pool.texts.join(' | ').slice(0, 200),
    )
    check('空池的族说清楚「还没有账号」，而不是画一张空卡', anyText('还没有账号'))
    check('登录中的族给了授权链接，登录失败的族给了原因', has('dab-link') && anyText('密钥被拒绝'))
    check('可导入的族才出现「从本机导入」', anyText('从本机导入'))

    // 动作菜单是点开才渲染的：不点一次，菜单里那几项永远检查不到。
    const trigger = pool.handlers.find((node) => node.haspopup === 'menu')
    trigger.onClick()
    const opened = await runtime.mount(runtime.React.createElement(app.AccountPoolSection))
    check(
      '动作菜单展开后是 kit 的菜单，删除项标成 destructive',
      trigger !== undefined && opened.classes.includes('mac-menu') && opened.classes.includes('mac-menu-item') && opened.classes.includes('mac-menu-item--destructive'),
      `菜单项=${opened.texts.filter((text) => ['续期', '设置代理', '改代理', '删除账号'].includes(String(text))).join('/')}`,
    )

    const card = await runtime.mount(runtime.React.createElement(app.ProviderCardSummary, { provider: { provider: 'acct-codex' } }))
    const other = await runtime.mount(runtime.React.createElement(app.ProviderCardSummary, { provider: { provider: 'acct-nope' } }))
    check(
      '卡片摘要只对自己那条 route 说话',
      card.texts.join(' ').includes('2 个账号') && other.texts.length === 0,
      `命中=${card.texts.join('/')} 别的=${other.texts.length}`,
    )

    const footer = await runtime.mount(runtime.React.createElement(app.ModelsFooter))
    check('模型页页脚报了整池的族数与账号数', footer.texts.join(' ').includes('3 族') && footer.texts.join(' ').includes('3 个账号'), footer.texts.join(' | '))
  } catch (error) {
    return { error: String(error?.stack ?? error?.message ?? error), checks }
  } finally {
    // 清理两件会影响**同一个进程里别人**的东西：面板登录中起的轮询定时器，以及被换掉的 fetch。
    runtime?.unmount()
    globalThis.fetch = realFetch
  }

  return { error: null, checks }
}
