/**
 * 客户端面板的回归测试。
 *
 * 这一层最容易「装了但什么都没发生」——客户端模块格式错一个字，宿主的模块加载器
 * 会静默跳过，用户看到的是「设置页里没有这一项」，而日志里可能什么都没有。
 * 所以这里钉的是：**模块格式**、**席位注册的形状**、**请求路径是文档相对的**、
 * 以及**面板在真实数据下渲染出正确的字**。
 *
 * React 由 `test/mini-react.js` 提供（本仓库不依赖真的 React）。
 *
 * **每个用例一棵全新的组件树**：hook 状态挂在组件实例上，共用一棵树会让上一个
 * 用例的数据漏进下一个，测出来的绿是假的。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMiniReact, findAll, hostsOf, textOf } from './mini-react.js'

// ---------------------------------------------------------------- 浏览器环境

/** 被捕获的模块定义。 */
let loaded
/** 被记录的 `setInterval` 调用。 */
let intervals
/** 挂进 head 的 style。 */
let styles
/** 所有建过的渲染器，收尾时统一卸载。 */
const renderers = []

function installBrowser() {
  loaded = undefined
  intervals = []
  styles = []

  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
        return definition
      },
    },
    confirm: () => true,
  }

  globalThis.document = {
    head: {
      appendChild(node) {
        styles.push(node)
        return node
      },
    },
    createElement(tag) {
      return {
        tagName: tag,
        dataset: {},
        textContent: '',
        removed: false,
        remove() {
          this.removed = true
        },
      }
    },
  }

  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms })
    // 面板里的轮询绝不真的跑起来——测试要确定性，不要定时器。
    return { unref() {} }
  }
  globalThis.clearInterval = () => {}

  return () => {
    globalThis.setInterval = realSetInterval
    delete globalThis.window
    delete globalThis.document
  }
}

const restoreBrowser = installBrowser()

// 必须在装好 `window` 之后动态 import：客户端模块在**模块顶层**就调用了
// `window.__ModuleLoader__.load(...)`，静态 import 会被提升到装桩之前。
await import('../src/client.js')

/** 用指定的 React 实现把客户端模块实例化出来（每次都是新的组件函数）。 */
function clientModule(react) {
  assert.ok(loaded, 'the client module never called window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-account-bridge')
  assert.equal(typeof loaded.factory, 'function')
  return loaded.factory((id) => {
    if (id === 'react') return react.React
    throw new Error(`unexpected require("${id}")`)
  })
}

/** 不带 React 的模块契约检查用。 */
function bareModule() {
  return clientModule(createMiniReact())
}

// ---------------------------------------------------------------- 假数据面

/** 一份默认的 `state` 响应。 */
function defaultFamilies() {
  return [
    {
      family: 'codex',
      displayName: 'ChatGPT (Codex)',
      route: 'acct-codex',
      risk: 'medium',
      discoverable: false,
      loginMethods: [{ id: 'import', label: '导入本机 Codex 登录' }],
      login: { status: 'idle' },
      accounts: [],
    },
  ]
}

/** 一个带账号的族，省得每个用例都手搓一遍。 */
function familyWithAccounts(accounts, overrides = {}) {
  return [
    {
      family: 'codex',
      displayName: 'ChatGPT (Codex)',
      route: 'acct-codex',
      risk: 'medium',
      discoverable: false,
      loginMethods: [{ id: 'import', label: '导入本机 Codex 登录' }],
      login: { status: 'idle' },
      accounts,
      ...overrides,
    },
  ]
}

/**
 * 装一个假数据面。`handlers` 按 action 覆盖默认应答，返回值是**信封里的 `value`**。
 * 记录每一次请求，供断言路径与载荷。
 *
 * 默认的 `state` 应答刻意照着 `src/api.js` 的真实信封抄：`{families: [...]}`。
 * 早先这里直接回了裸数组，于是每个渲染用例都在测「数据没到」那条分支——
 * 假数据面的形状错了，测试会一路绿着骗人，所以形状必须对着真实现抄。
 */
function installBackend(handlers = {}, options = {}) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop()
    calls.push({ url, action, body: JSON.parse(init.body) })
    const handler = handlers[action]
    if (typeof handler === 'function') {
      const result = await handler(calls.at(-1).body, calls.length)
      if (result && result.__raw) return { status: result.status ?? 500, json: async () => result.__raw }
      return { status: 200, json: async () => ({ ok: true, value: result }) }
    }
    if (action === 'state') {
      return { status: 200, json: async () => ({ ok: true, value: { families: options.families ?? defaultFamilies() } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: {} }) }
  }
  return calls
}

/** 让挂起的 promise 链跑完（fetch → setState → 重渲染）。 */
async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * 起一棵全新的组件树并等首屏数据落地。
 * 返回的 `rerender()` 用**同一个渲染器与同一个组件函数**重画——这正是
 * 点击按钮之后测试要看到的东西。
 */
async function mountPanel(handlers, options) {
  const calls = installBackend(handlers, options)
  const mini = createMiniReact()
  renderers.push(mini)
  const module = clientModule(mini)
  const element = () => mini.React.createElement(module.AccountPoolSection, {})
  mini.render(element())
  await settle()
  return { mini, module, calls, tree: mini.render(element()), rerender: () => mini.render(element()) }
}

/** 按钮的文案匹配。 */
function buttonSaying(tree, text) {
  return hostsOf(tree, 'button').find((node) => textOf(node).trim() === text)
}

/** 找一个按钮（文案包含即可）。 */
function buttonContaining(tree, text) {
  return hostsOf(tree, 'button').find((node) => textOf(node).includes(text))
}

// ---------------------------------------------------------------- 测试

test.after(() => {
  for (const mini of renderers) mini.unmount()
  restoreBrowser()
})

test('the module registers under the documented id and only requires react', () => {
  const module = bareModule()
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.AccountPoolSection, 'function')
})

test('apply waits for the slot declaration and registers with an id', () => {
  const module = bareModule()
  const injections = []
  const registrations = []
  const effects = []

  const ctx = {
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose
    },
    slots: {
      inject(name, callback) {
        injections.push(name)
        callback()
      },
      register(definition, Component) {
        registrations.push({ definition, Component })
        return () => {}
      },
    },
  }

  module.apply(ctx)

  assert.deepEqual(
    injections,
    ['settings.section', 'settings.models.provider-card', 'settings.models.footer'],
    'must go through slots.inject, not register directly',
  )
  assert.equal(registrations.length, 3)
  assert.deepEqual(registrations[0].definition, {
    name: 'settings.section',
    id: 'account-bridge',
    order: 30,
    label: '账号池',
  })
  assert.equal(registrations[0].Component, module.AccountPoolSection)

  // 卡片摘要：keyed 席位，key 是**空字符串**——我们的 provider 都没在可配置目录里
  // 声明过，joinProviderDirectory 给它们填的 settingsNs 就是 ""。
  assert.deepEqual(registrations[1].definition, {
    name: 'settings.models.provider-card',
    key: '',
    order: 30,
  })
  assert.equal(registrations[1].Component, module.ProviderCardSummary)

  // 页脚：list 席位，要 id。
  assert.deepEqual(registrations[2].definition, {
    name: 'settings.models.footer',
    id: 'account-bridge',
    order: 40,
    label: '账号池',
  })
  assert.equal(registrations[2].Component, module.ModelsFooter)

  // 样式进了 head，而且卸载时会被摘掉。
  assert.equal(effects.length, 1)
  assert.equal(styles.length, 1)
  assert.equal(styles[0].dataset.plugin, 'dsh-account-bridge')
  assert.ok(styles[0].textContent.includes('.dab-root'))
  for (const effect of effects) effect.dispose()
  assert.equal(styles[0].removed, true, 'the <style> must be removed on dispose')
})

test('the data plane is document-relative — a leading slash escapes the GUI base', async () => {
  const { calls, module } = await mountPanel()
  assert.ok(calls.length > 0, 'the panel should have asked for state')
  assert.equal(calls[0].url, 'account-bridge/state')
  assert.ok(!calls[0].url.startsWith('/'), 'a leading slash resolves against the origin, not <base href="./">')
  assert.equal(module.__internal.API, 'account-bridge')
})

test('an empty pool renders the family with its login button and an empty-state hint', async () => {
  const { tree } = await mountPanel()
  const text = textOf(tree)
  assert.ok(text.includes('账号池 · 1 族 / 0 个账号'), text)
  assert.ok(text.includes('ChatGPT (Codex)'))
  assert.ok(text.includes('route acct-codex'))
  assert.ok(text.includes('风险 medium'))
  assert.ok(text.includes('+ 导入本机 Codex 登录'))
  assert.ok(text.includes('还没有账号。点上面的「+ 添加账号」开始登录。'))
})

test('a pool with accounts offers 从本机导入, and warns when there is nothing to add', async () => {
  const families = familyWithAccounts([], { discoverable: true, loginMethods: [] })
  const { tree, rerender, calls } = await mountPanel(
    { discover: () => ({ importable: [], blocked: [] }) },
    { families },
  )
  assert.ok(textOf(tree).includes('装过这个客户端的话点「从本机导入」能直接捡到登录态'))

  buttonContaining(tree, '从本机导入').props.onClick()
  await settle()
  const scanned = rerender()
  assert.ok(textOf(scanned).includes('没扫到可用的登录态。'), textOf(scanned))
  assert.ok(calls.some((call) => call.action === 'discover'))
})

test('the panel degrades to a retry button when the data plane is unreachable', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  const mini = createMiniReact()
  renderers.push(mini)
  const module = clientModule(mini)
  const element = () => mini.React.createElement(module.AccountPoolSection, {})
  mini.render(element())
  await settle()
  const tree = mini.render(element())
  const text = textOf(tree)
  assert.ok(text.includes('账号池读取失败'), text)
  assert.ok(text.includes('连不上插件的数据面'))
  assert.ok(buttonSaying(tree, '重试'), 'the only way out of a dead data plane is to retry')
})

test('a non-JSON reply is reported, not swallowed', async () => {
  globalThis.fetch = async () => ({
    status: 502,
    json: async () => {
      throw new SyntaxError('bad')
    },
  })
  const mini = createMiniReact()
  renderers.push(mini)
  const module = clientModule(mini)
  const element = () => mini.React.createElement(module.AccountPoolSection, {})
  mini.render(element())
  await settle()
  assert.ok(textOf(mini.render(element())).includes('非 JSON（HTTP 502）'))
})

test('an empty envelope is reported instead of rendering a blank panel', async () => {
  globalThis.fetch = async () => ({ status: 200, json: async () => null })
  const mini = createMiniReact()
  renderers.push(mini)
  const module = clientModule(mini)
  const element = () => mini.React.createElement(module.AccountPoolSection, {})
  mini.render(element())
  await settle()
  assert.ok(textOf(mini.render(element())).includes('空信封'))
})

test('"unknown quota" and "zero quota" are different sentences on screen', async () => {
  const account = (id, extra) => ({ id, family: 'grok', label: `${id}@example.com`, authKind: 'oauth', renewable: true, source: 'oauth', ...extra })
  const families = [
    {
      family: 'grok',
      displayName: 'Grok',
      route: 'acct-grok',
      loginMethods: [],
      login: { status: 'idle' },
      accounts: [
        account('grok-1'),
        account('grok-2', { quota: [{ id: 'weekly', name: '周', remainingFraction: 0 }] }),
        account('grok-3', { quota: [{ id: 'weekly', name: '周', remainingFraction: 0.62 }] }),
      ],
    },
  ]
  const { tree } = await mountPanel(undefined, { families })
  const rows = findAll(tree, (node) => node.kind === 'host' && node.props.className === 'dab-account-main')
  assert.equal(rows.length, 3)

  // 账号 1：没有 quota 字段 → 「未知」。
  assert.ok(textOf(rows[0]).includes('未知'), `expected 未知, got ${textOf(rows[0])}`)
  // 账号 2：真实的 0% 必须原样显示——它不是「查不到」。
  assert.ok(textOf(rows[1]).includes('0%'), `expected 0%, got ${textOf(rows[1])}`)
  // 账号 3：62%。
  assert.ok(textOf(rows[2]).includes('62%'), `expected 62%, got ${textOf(rows[2])}`)

  // 进度条只在**有读数**的账号上出现：账号 1 是「未知」，没有条（有一条 0 宽的
  // 条会被读成「读数就是 0」——那正是这一条要防的事）。
  const bars = findAll(tree, (node) => node.kind === 'host' && node.props.className === 'dab-bar-fill')
  assert.deepEqual(bars.map((node) => node.props.style.width), ['0%', '62%'])
  assert.equal(findAll(rows[0], (node) => node.kind === 'host' && node.props.className === 'dab-bar').length, 0)

  // 一族里「最佳剩余」取的是最小值（配额是木桶原理，最紧的那条才决定还能不能干活）。
  assert.ok(textOf(tree).includes('最佳剩余 0%'), textOf(tree))
})

test('an expired token and a cooling account are both called out on the row', async () => {
  const families = familyWithAccounts([
    { id: 'codex-1', family: 'codex', label: 'a@example.com', authKind: 'oauth', renewable: true, source: 'oauth', expiresAt: Date.now() - 1000 },
    { id: 'codex-2', family: 'codex', label: 'b@example.com', authKind: 'oauth', renewable: false, source: 'oauth', status: 'cooling' },
    { id: 'codex-3', family: 'codex', label: 'c@example.com', authKind: 'oauth', renewable: true, source: 'client-import', externallyOwned: true, disabled: true },
  ])
  const { tree } = await mountPanel(undefined, { families })
  const text = textOf(tree)
  assert.ok(text.includes('token 已过期'), 'an expired token must be visible, not discovered at request time')
  assert.ok(text.includes('冷却中'))
  assert.ok(text.includes('不可续期'))
  assert.ok(text.includes('本机导入'))
  assert.ok(text.includes('共用'), 'externally-owned credentials need a warning — we write back to them')
  assert.ok(text.includes('已停用'))
})

test('a running login shows its URL, and starts polling so the panel follows to the end', async () => {
  const families = familyWithAccounts([], {
    login: { status: 'running', message: '在浏览器里完成授权', url: 'https://auth.example.com/authorize?x=1' },
  })
  intervals.length = 0
  const { tree } = await mountPanel(undefined, { families })

  const links = hostsOf(tree, 'a')
  assert.equal(links.length, 1)
  assert.equal(links[0].props.href, 'https://auth.example.com/authorize?x=1')
  assert.equal(links[0].props.rel, 'noreferrer noopener')
  assert.ok(textOf(tree).includes('在浏览器里完成授权'))
  assert.ok(
    intervals.some((entry) => entry.ms === 2000),
    'a running login must be polled — it finishes in another process, minutes later',
  )
})

test('an idle pool opens no polling at all', async () => {
  intervals.length = 0
  await mountPanel()
  assert.deepEqual(intervals, [], 'polling an idle pool would hammer the upstream with no user action')
})

test('deleting asks for confirmation and reports the account id it removed', async () => {
  const families = familyWithAccounts([{ id: 'codex-1', family: 'codex', label: 'me@example.com', authKind: 'oauth', renewable: true, source: 'oauth' }])
  let asked
  const { tree, rerender, calls } = await mountPanel({ remove: (body) => ({ removed: body.account }) }, { families })

  globalThis.window.confirm = (message) => {
    asked = message
    return true
  }
  buttonSaying(tree, '删除').props.onClick()
  await settle()

  assert.ok(asked.includes('codex-1'), `confirmation should name the account, got ${asked}`)
  assert.deepEqual(calls.find((call) => call.action === 'remove').body, { account: 'codex-1' })
  assert.ok(calls.filter((call) => call.action === 'state').length >= 2, 'the panel must reload after a mutation')
  rerender()
})

test('cancelling the confirmation issues no request', async () => {
  const families = familyWithAccounts([{ id: 'codex-1', family: 'codex', label: 'me@example.com', authKind: 'oauth', renewable: true, source: 'oauth' }])
  const { tree, calls } = await mountPanel({}, { families })
  const before = calls.length
  globalThis.window.confirm = () => false
  buttonSaying(tree, '删除').props.onClick()
  await settle()
  assert.equal(calls.length, before, 'declining the confirmation must not touch the data plane')
})

test('toggle sends the opposite of whatever the row currently says', async () => {
  const families = familyWithAccounts([
    { id: 'codex-1', family: 'codex', label: 'a@example.com', authKind: 'oauth', renewable: true, source: 'oauth' },
    { id: 'codex-2', family: 'codex', label: 'b@example.com', authKind: 'oauth', renewable: true, source: 'oauth', disabled: true },
  ])
  const { tree, rerender, calls } = await mountPanel({ toggle: () => ({}) }, { families })

  buttonSaying(tree, '停用').props.onClick()
  await settle()
  buttonSaying(rerender(), '启用').props.onClick()
  await settle()

  assert.deepEqual(
    calls.filter((call) => call.action === 'toggle').map((call) => call.body),
    [
      { account: 'codex-1', disabled: true },
      { account: 'codex-2', disabled: false },
    ],
  )
})

test('a non-renewable account offers no 续期 button', async () => {
  const families = familyWithAccounts([
    { id: 'codex-1', family: 'codex', label: 'a@example.com', authKind: 'apikey', renewable: false, source: 'manual' },
  ])
  const { tree } = await mountPanel(undefined, { families })
  assert.equal(buttonSaying(tree, '续期'), undefined, 'there is nothing to renew without a refresh token')
})

test('the proxy editor only sends a request when saved, and can clear the proxy', async () => {
  const families = familyWithAccounts([
    { id: 'codex-1', family: 'codex', label: 'a@example.com', authKind: 'oauth', renewable: true, source: 'oauth', proxy: 'http://127.0.0.1:7890' },
  ])
  const { tree, rerender, calls } = await mountPanel({ proxy: (body) => ({ proxy: body.proxy || undefined }) }, { families })

  // 已经配了代理时，面板要把它显示出来。
  assert.ok(textOf(tree).includes('出口代理：http://127.0.0.1:7890'))

  buttonSaying(tree, '改代理').props.onClick()
  await settle()
  const input = hostsOf(rerender(), 'input')[0]
  assert.equal(input.props.value, 'http://127.0.0.1:7890', 'the editor should start from the current value')

  // 打字本身不发请求。
  input.props.onChange({ target: { value: '' } })
  await settle()
  assert.equal(calls.filter((call) => call.action === 'proxy').length, 0, 'typing must not hit the data plane')

  // 保存才发，而且空串要原样送上去（由数据面负责删掉这个键）。
  buttonSaying(rerender(), '保存').props.onClick()
  await settle()
  assert.deepEqual(calls.filter((call) => call.action === 'proxy').at(-1).body, { account: 'codex-1', proxy: '' })
})

test('a scan shows what is importable and why the rest is blocked', async () => {
  const families = familyWithAccounts([], { discoverable: true })
  const { tree, rerender, calls } = await mountPanel(
    {
      discover: () => ({
        importable: [{ family: 'codex', sourcePath: 'C:/Users/x/.codex/auth.json', label: 'me@example.com' }],
        blocked: [
          {
            family: 'workbuddy',
            sourcePath: 'C:/Users/x/auth/workbuddy-desktop.info',
            label: 'WorkBuddy',
            reason: '凭据是加密的，需要借客户端自己的进程解密',
          },
        ],
      }),
      import: () => ({ imported: [{ id: 'codex-1', family: 'codex' }] }),
    },
    { families },
  )

  buttonContaining(tree, '从本机导入').props.onClick()
  await settle()

  const scanned = rerender()
  const text = textOf(scanned)
  assert.ok(text.includes('me@example.com'), text)
  // 被挡下的那一行必须带上原因——「发现了但导不进」不说为什么，用户只能来问我们。
  assert.ok(text.includes('凭据是加密的'), text)

  buttonSaying(scanned, '导入可用的').props.onClick()
  await settle()
  assert.ok(calls.some((call) => call.action === 'import'), 'the import button must reach the data plane')
})

test('a mutation that fails shows the error and keeps the panel usable', async () => {
  const families = familyWithAccounts([{ id: 'codex-1', family: 'codex', label: 'a@example.com', authKind: 'oauth', renewable: true, source: 'oauth' }])
  const { tree, rerender } = await mountPanel(
    {
      refresh: () => ({
        __raw: { ok: false, error: { code: 'AUTH', message: 'refresh token 已被上游作废' } },
        status: 400,
      }),
    },
    { families },
  )
  buttonSaying(tree, '续期').props.onClick()
  await settle()
  const text = textOf(rerender())
  assert.ok(text.includes('AUTH：refresh token 已被上游作废'), text)
  // 出错之后按钮必须还能按——一次失败的续期不是终态。
  assert.ok(buttonSaying(rerender(), '续期'), 'the panel must stay usable after a failure')
})

test('loginStatusText and sourceText read the way a user would', () => {
  const { loginStatusText, sourceText } = bareModule().__internal
  assert.equal(loginStatusText({ status: 'running', url: 'https://x' }), '等待你在浏览器里完成授权…')
  assert.equal(loginStatusText({ status: 'running', message: '扫码' }), '扫码')
  assert.equal(loginStatusText({ status: 'authorized', accountId: 'codex-2' }), '登录成功，账号 codex-2 已入池。')
  assert.equal(loginStatusText({ status: 'failed' }), '登录失败。')
  assert.equal(loginStatusText({ status: 'cancelled' }), '登录已取消。')
  assert.equal(sourceText({ source: 'client-import' }), '本机导入')
  assert.equal(sourceText({ source: 'manual' }), '手动填写')
  assert.equal(sourceText({ authKind: 'endpoint' }), '端点')
  assert.equal(sourceText({ authKind: 'apikey' }), 'API Key')
  assert.equal(sourceText({ authKind: 'cli' }), '本机 CLI')
  assert.equal(sourceText({}), 'OAuth')
})

test('untilText never prints a negative countdown', () => {
  const { untilText } = bareModule().__internal
  assert.equal(untilText(Date.now() - 1000), '已到期')
  assert.equal(untilText(undefined), undefined)
  // 30 秒不能说成「1 分钟后」——那会让人以为还有富余。
  assert.equal(untilText(Date.now() + 30_000), '30 秒后')
  assert.equal(untilText(Date.now() + 5 * 60_000), '5 分钟后')
  assert.equal(untilText(Date.now() + 3 * 3600_000), '3.0 小时后')
  assert.equal(untilText(Date.now() + 3 * 86400_000), '3 天后')
})

test('percentText keeps "unknown" and 0% apart', () => {
  const { percentText } = bareModule().__internal
  assert.equal(percentText(undefined), '未知')
  assert.equal(percentText(Number.NaN), '未知')
  assert.equal(percentText(0), '0%')
  assert.equal(percentText(0.615), '62%')
  assert.equal(percentText(1), '100%')
})

test('bestRemaining picks the tightest window, and ignores rows with no reading', () => {
  const { bestRemaining } = bareModule().__internal
  assert.equal(bestRemaining([]), undefined)
  assert.equal(bestRemaining([{}]), undefined)
  assert.equal(bestRemaining([{ quota: [{ remainingFraction: 0.8 }] }, { quota: [{ remainingFraction: 0.2 }] }]), 0.2)
  assert.equal(bestRemaining([{ quota: [{ remainingFraction: 0.8 }] }, { quota: [{ name: 'no reading' }] }]), 0.8)
})

// ------------------------------------------------ 设置 → 模型页上的两处摘要

/**
 * 把任意组件挂成一棵新树并等首屏数据落地。
 *
 * `pick` 收的是**同一个模块实例**里的组件：`clientModule()` 每次调用都会新建一份
 * 闭包，组件函数会把 hook 记在**它自己那个 React** 的注册表里，所以拿 A 实例的
 * 组件往 B 实例的渲染器里画，会得到 `hook called outside a component (path root)`。
 */
async function mountComponent(pick, props, handlers, options) {
  const calls = installBackend(handlers, options)
  const mini = createMiniReact()
  renderers.push(mini)
  const module = clientModule(mini)
  const Component = pick(module)
  const element = () => mini.React.createElement(Component, props ?? {})
  mini.render(element())
  await settle()
  return { mini, module, calls, tree: mini.render(element()), rerender: () => mini.render(element()) }
}

/** 摘要行本身（`.dab-card-summary` 那个 div），找不到就是没渲染。 */
function summaryRows(tree) {
  return hostsOf(tree, 'div').filter((node) => String(node.props.className ?? '').includes('dab-card-summary'))
}

test('familySummary writes "unknown" and "0%" as two different sentences', () => {
  const module = bareModule()
  const { familySummary } = module.__internal

  assert.match(familySummary({ accounts: [], loginMethods: [{ id: 'pat', label: '粘贴 PAT' }] }), /还没有账号 · 可用登录：粘贴 PAT/)
  assert.match(familySummary({ accounts: [] }), /^还没有账号$/)

  const withQuota = familySummary({
    accounts: [
      { id: 'codex-1', quota: [{ id: 'weekly', name: '周', remainingFraction: 0 }] },
      { id: 'codex-2', quota: [{ id: 'weekly', name: '周', remainingFraction: 0.4 }] },
    ],
  })
  // 0% 是真实读数：它必须出现在句子里，而不是被当成「没有读数」吞掉。
  assert.match(withQuota, /2 个账号/)
  assert.match(withQuota, /最佳剩余 0%/)

  const noReading = familySummary({ accounts: [{ id: 'codex-1', quota: [] }] })
  assert.match(noReading, /额度未知/)
  assert.ok(!/0%/.test(noReading), '"查不到" 不能写成 "0%"')

  const mixed = familySummary({
    accounts: [
      { id: 'codex-1', disabled: true, quota: [{ id: 'weekly', remainingFraction: 0.9 }] },
      { id: 'codex-2', cooldownUntil: Date.now() + 60_000, quota: [{ id: 'weekly', remainingFraction: 0.5 }] },
    ],
  })
  assert.match(mixed, /2 个账号 · 1 个已停用 · 1 个冷却中 · 最佳剩余 50%/, '停用的账号不该把「最佳剩余」拉上去')
})

test('the provider-card summary renders only on our own provider cards', async () => {
  const options = { families: familyWithAccounts([{ id: 'codex-1', label: 'a@b.c', quota: [{ id: 'weekly', name: '周', remainingFraction: 0.31 }] }]) }

  const ours = await mountComponent((m) => m.ProviderCardSummary, { provider: { provider: 'acct-codex' } }, {}, options)
  assert.match(textOf(ours.tree), /账号池/)
  assert.match(textOf(ours.tree), /1 个账号 · 最佳剩余 31%/)

  const theirs = await mountComponent((m) => m.ProviderCardSummary, { provider: { provider: 'deepseek-official' } }, {}, options)
  assert.deepEqual(summaryRows(theirs.tree), [], '别人的卡片上什么都不该画')

  const nameless = await mountComponent((m) => m.ProviderCardSummary, {}, {}, options)
  assert.deepEqual(summaryRows(nameless.tree), [], '拿不到 provider id 时不该猜')
})

test('three cards on one page share a single state request', async () => {
  // 模型页可能有十几张卡片。每张各打一次 HTTP 就是十几次请求，
  // 而且会在用户没做任何事的时候反复碰账号。共享快照就是为这个存在的。
  const mini = createMiniReact()
  renderers.push(mini)
  const calls = installBackend({}, { families: familyWithAccounts([{ id: 'codex-1', label: 'a@b.c' }]) })
  const module = clientModule(mini)

  const tree = () =>
    mini.render(
      mini.React.createElement(
        'div',
        null,
        mini.React.createElement(module.ProviderCardSummary, { key: 1, provider: { provider: 'acct-codex' } }),
        mini.React.createElement(module.ProviderCardSummary, { key: 2, provider: { provider: 'acct-codex' } }),
        mini.React.createElement(module.ProviderCardSummary, { key: 3, provider: { provider: 'other' } }),
      ),
    )

  tree()
  await settle()
  assert.equal(calls.filter((call) => call.action === 'state').length, 1, 'three cards, one request')

  // 再画一遍（依赖没变、快照还在保鲜期内）也不该再打一次。
  tree()
  await settle()
  assert.equal(calls.filter((call) => call.action === 'state').length, 1)

  // 快照过期之后才允许再取一次。
  module.__internal.summaryStore.at = Date.now() - module.__internal.SUMMARY_FRESH_MS - 1
  module.__internal.summaryStore.load()
  await settle()
  assert.equal(calls.filter((call) => call.action === 'state').length, 2)
})

test('the models footer tells the truth about an empty pool, a full pool and a broken data plane', async () => {
  const module = bareModule()

  const empty = await mountComponent((m) => m.ModelsFooter, {}, {}, { families: [] })
  assert.match(textOf(empty.tree), /还没有账号/)
  assert.match(textOf(empty.tree), /\/pool/)

  const full = await mountComponent((m) => m.ModelsFooter, {}, {}, {
    families: [
      ...familyWithAccounts([{ id: 'codex-1', label: 'a@b.c', cooldownUntil: Date.now() + 60_000 }]),
      { family: 'agy', displayName: 'Antigravity', route: 'acct-agy', accounts: [{ id: 'agy-1', label: 'x' }] },
    ],
  })
  assert.match(textOf(full.tree), /2 族 · 2 个账号 · 1 个冷却中/)

  const broken = await mountComponent((m) => m.ModelsFooter, {}, {
    // 信封本身是坏的：数据面挂了的时候页脚要说话，而不是画成「一个账号都没有」。
    state: () => ({ __raw: { nope: true }, status: 500 }),
  })
  assert.match(textOf(broken.tree), /账号池读取失败/)
  assert.ok(!/还没有账号/.test(textOf(broken.tree)), '读不到和「没有账号」是两件事')
})

test('the footer renders nothing at all while the first read is still in flight', async () => {
  const mini = createMiniReact()
  renderers.push(mini)
  installBackend({ state: () => new Promise(() => {}) })
  const module = clientModule(mini)
  const element = () => mini.React.createElement(module.ModelsFooter, {})
  mini.render(element())
  // 刻意不 settle：这一刻是「已挂载、还没数据」。
  assert.deepEqual(summaryRows(mini.render(element())), [], '没数据就不该画一行空话')
})
