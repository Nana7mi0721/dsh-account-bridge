/**
 * HTTP 数据面（`src/api.js`）的回归测试。
 *
 * 这一层是**浏览器能碰到插件内部状态的唯一入口**，所以这里钉的几乎全是安全与边界：
 *
 * - **只服务回环**：非回环一律 403。这一面能起登录、能删账号，开放出去等于把账号池交出去。
 * - **凭据永不外传**：`publicAccount` 是白名单式重建，`auth.access` / `auth.refresh` /
 *   `auth.apiKey` 一个都不能出现在响应里——将来 auth 加了新字段，默认也是不外传。
 * - **额度「查不到」不是「0%」**：上游不报额度时必须是 `undefined`，不能是 0。
 * - **未知动作 404、非 POST 405、坏 JSON 400**：面板点错按钮不该拿到 500。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockHost } from './harness.js'
import { PREFIX, isLoopback, publicAccount, quotaOf, registerAccountBridgeRoutes } from '../src/api.js'

/** 造一个够用的假 `IncomingMessage`：异步迭代产出 body，带 socket.remoteAddress。 */
function fakeRequest({ method = 'POST', url = '/', body = {}, remoteAddress = '127.0.0.1' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = text.length > 0 ? [Buffer.from(text, 'utf8')] : []
  return {
    method,
    url,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

/** 造一个假 `ServerResponse`，把 status/body 记下来。 */
function fakeResponse() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text === undefined ? undefined : JSON.parse(text)
    },
  }
}

/** 取那个被挂上的 `/account-bridge` 路由。 */
function routeOf(host) {
  const route = host.services.webServer.routes.get(PREFIX)
  assert.ok(route, `expected a route mounted at ${PREFIX}`)
  return route
}

/** 打一次 API。 */
async function callApi(host, action, body = {}, options = {}) {
  const route = routeOf(host)
  const req = fakeRequest({ url: `${PREFIX}/${action}`, body, ...options })
  const res = fakeResponse()
  await route.handler(req, res)
  return res.captured
}

/** 往 store 里塞一个账号。 */
async function seedAccount(host, id, payload = {}) {
  await host.services.credentials.modifyRecord(`dsh-account-bridge/${id}`, () => ({
    kind: 'grant',
    payload: {
      id,
      family: id.split('-')[0],
      label: payload.label ?? `${id}@example.com`,
      source: payload.source ?? 'oauth',
      auth: { access: 'at-secret-value', refresh: 'rt-secret-value', expiresAt: Date.now() + 3_600_000, ...(payload.auth ?? {}) },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...payload,
    },
  }))
}

test('the route is mounted under the documented prefix', () => {
  const host = createMockHost()
  try {
    const route = routeOf(host)
    assert.equal(route.kind, 'prefix')
    assert.equal(typeof route.handler, 'function')
    // 重复挂载必须抛——宿主侧就是这么定义的（route 表是组合期契约）。
    assert.throws(
      () => host.services.webServer.register({ kind: 'prefix', path: PREFIX, handler: () => {} }),
      /duplicate prefix route/,
    )
  } finally {
    host.dispose()
  }
})

test('state lists families with their login methods, and never leaks credentials', async () => {
  const host = createMockHost()
  try {
    await seedAccount(host, 'codex-1', { auth: { access: 'at-secret-value', refresh: 'rt-secret-value' } })
    const answer = await callApi(host, 'state')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)

    const families = answer.body.value.families
    assert.ok(Array.isArray(families) && families.length > 0)
    const codex = families.find((row) => row.family === 'codex')
    assert.ok(codex, 'codex family should be present')
    assert.equal(codex.route, 'acct-codex')
    assert.equal(codex.accounts.length, 1)
    assert.equal(codex.accounts[0].id, 'codex-1')
    assert.equal(codex.accounts[0].renewable, true)
    assert.equal(codex.accounts[0].authKind, 'oauth')

    // 整份响应里不许出现任何凭据原文。
    const wire = JSON.stringify(answer.body)
    assert.ok(!wire.includes('at-secret-value'), 'access token leaked into the response')
    assert.ok(!wire.includes('rt-secret-value'), 'refresh token leaked into the response')
  } finally {
    host.dispose()
  }
})

test('publicAccount is a whitelist: unknown auth fields do not travel', () => {
  const row = publicAccount({
    id: 'generic-1',
    family: 'generic',
    auth: {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-should-not-travel',
      apiKeyEnv: 'EXAMPLE_KEY',
      // 将来 auth 里长出来的新字段：默认不外传。
      sessionCookie: 'cookie-should-not-travel',
      refresh: 'rt',
    },
  })
  const wire = JSON.stringify(row)
  assert.ok(!wire.includes('sk-should-not-travel'))
  assert.ok(!wire.includes('cookie-should-not-travel'))
  assert.equal(row.host, 'api.example.com')
  assert.equal(row.renewable, true)
})

test('non-loopback requests are refused, and there is no bypass', async () => {
  const host = createMockHost()
  try {
    // `null` 而不是 `undefined`：假请求的 `remoteAddress` 有默认值，
    // 显式传 `undefined` 会命中默认参数，测的就不是「没有地址」了。
    for (const remoteAddress of ['192.168.1.20', '10.0.0.7', '::ffff:192.168.1.20', null]) {
      const answer = await callApi(host, 'state', {}, { remoteAddress })
      assert.equal(answer.status, 403, `remoteAddress ${String(remoteAddress)} should be refused`)
      assert.equal(answer.body.error.code, 'FORBIDDEN')
    }
    // 连 socket 都没有（畸形请求）时也要拒绝。
    assert.equal(isLoopback({}), false)
    assert.equal(isLoopback({ socket: {} }), false)
    // 三种回环写法都放行。
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal(isLoopback({ socket: { remoteAddress } }), true)
      const answer = await callApi(host, 'state', {}, { remoteAddress })
      assert.equal(answer.status, 200)
    }
  } finally {
    host.dispose()
  }
})

test('unknown actions, wrong methods and bad bodies answer with stable codes', async () => {
  const host = createMockHost()
  try {
    const missing = await callApi(host, 'nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'NO_SUCH_ACTION')

    const wrongMethod = await callApi(host, 'state', {}, { method: 'GET' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.body.error.code, 'METHOD_NOT_ALLOWED')

    const badJson = await callApi(host, 'state', '{"not json')
    assert.equal(badJson.status, 400)
    assert.equal(badJson.body.error.code, 'BAD_BODY')

    const arrayBody = await callApi(host, 'state', '[1,2,3]')
    assert.equal(arrayBody.status, 400)
    assert.equal(arrayBody.body.error.code, 'BAD_BODY')
  } finally {
    host.dispose()
  }
})

test('toggle disables an account without touching its credentials', async () => {
  const host = createMockHost()
  try {
    await seedAccount(host, 'codex-1')
    const off = await callApi(host, 'toggle', { account: 'codex-1', disabled: true })
    assert.equal(off.body.value.disabled, true)

    const after = await host.services.credentials.readRecord('dsh-account-bridge/codex-1')
    assert.equal(after.payload.disabled, true)
    assert.equal(after.payload.auth.access, 'at-secret-value', 'toggling must not drop the credentials')

    const on = await callApi(host, 'toggle', { account: 'codex-1' })
    assert.equal(on.body.value.disabled, false, 'omitting disabled flips the current value')
  } finally {
    host.dispose()
  }
})

test('proxy is set and cleared, and clearing actually removes the key', async () => {
  const host = createMockHost()
  try {
    await seedAccount(host, 'codex-1')
    const set = await callApi(host, 'proxy', { account: 'codex-1', proxy: 'http://127.0.0.1:7890' })
    assert.equal(set.body.value.proxy, 'http://127.0.0.1:7890')

    let stored = await host.services.credentials.readRecord('dsh-account-bridge/codex-1')
    assert.equal(stored.payload.proxy, 'http://127.0.0.1:7890')

    const cleared = await callApi(host, 'proxy', { account: 'codex-1', proxy: '' })
    assert.equal(cleared.body.value.proxy, undefined)
    stored = await host.services.credentials.readRecord('dsh-account-bridge/codex-1')
    // 留一个空串会让 `createFetcher` 觉得「配了代理」然后去解析一个空 URL。
    assert.ok(!('proxy' in stored.payload), 'clearing the proxy must delete the key, not blank it')
  } finally {
    host.dispose()
  }
})

test('remove deletes exactly one account and reports 404 for strangers', async () => {
  const host = createMockHost()
  try {
    await seedAccount(host, 'codex-1')
    await seedAccount(host, 'codex-2')

    const gone = await callApi(host, 'remove', { account: 'codex-2' })
    assert.equal(gone.body.value.removed, 'codex-2')
    assert.equal(await host.services.credentials.readRecord('dsh-account-bridge/codex-2'), undefined)
    assert.ok(await host.services.credentials.readRecord('dsh-account-bridge/codex-1'))

    const stranger = await callApi(host, 'remove', { account: 'codex-9' })
    assert.equal(stranger.status, 404)
    assert.equal(stranger.body.error.code, 'NOT_FOUND')

    const noAccount = await callApi(host, 'remove', {})
    assert.equal(noAccount.status, 400)
    assert.equal(noAccount.body.error.code, 'BAD_REQUEST')
  } finally {
    host.dispose()
  }
})

test('removing an account forgets only that account; enabling one forgets nothing', async () => {
  // 这一条钉的是「别顺手把一整族的缓存亲和抹掉」。账号 id 是**会回收**的
  // （`nextAccountId()` 取最小空号），所以删号时得忘掉指向它的记录，否则下次登录拿到
  // 同一个 id 会继承上一段会话的粘性；但启用账号只是多了一个候选人——`decide()` 自己
  // 就会给 `gone`，没必要清。曾经这里两种情形都是 `clearSticky(族)`：每启用一个账号，
  // 这一族**所有**会话的上游缓存就被白烧一遍（真机跑出来的现象：盘上的记录全没了）。
  const seen = []
  const accounts = new Map([
    ['codex-1', { id: 'codex-1', family: 'codex', label: 'one', auth: {} }],
    ['codex-2', { id: 'codex-2', family: 'codex', label: 'two', auth: {} }],
  ])
  const routes = []
  const dispose = registerAccountBridgeRoutes({
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    adapter: {
      invalidate: () => seen.push('invalidate'),
      invalidateHealth: () => seen.push('invalidateHealth'),
      clearSticky: (family) => seen.push(`clearSticky:${family}`),
      forgetAccount: (id) => seen.push(`forgetAccount:${id}`),
    },
    store: {
      list: async (family) => [...accounts.values()].filter((account) => account.family === family),
      remove: async (id) => {
        accounts.delete(id)
      },
      update: async (id, mutate) => {
        const next = accounts.has(id) ? mutate(accounts.get(id)) : undefined
        if (next !== undefined) accounts.set(id, next)
        return next
      },
    },
    families: [{ id: 'codex', displayName: 'Codex', route: 'acct-codex', login: { methods: [{ id: 'import' }] }, discover: () => [] }],
    ctx: {},
    log: {},
  })
  try {
    const handler = routes[0].handler
    const post = async (action, body) => {
      const res = fakeResponse()
      await handler(fakeRequest({ url: `${PREFIX}/${action}`, body }), res)
      return res.captured
    }

    seen.length = 0
    const removed = await post('remove', { account: 'codex-2' })
    assert.equal(removed.status, 200)
    assert.ok(seen.includes('forgetAccount:codex-2'), `remove 要忘掉那个账号，实际: ${seen.join(',')}`)
    assert.ok(!seen.includes('clearSticky:codex'), 'remove 不该把一整族清掉')

    seen.length = 0
    const on = await post('toggle', { account: 'codex-1', disabled: false })
    assert.equal(on.status, 200)
    assert.ok(seen.includes('invalidate'), 'toggle 仍要作废目录缓存')
    assert.ok(!seen.some((call) => call.startsWith('clearSticky')), `toggle 不该动粘性，实际: ${seen.join(',')}`)
    assert.ok(!seen.some((call) => call.startsWith('forgetAccount')), 'toggle 也不该忘掉账号记录')
  } finally {
    dispose()
  }
})

test('login without an authorization service says so instead of typing on undefined', async () => {
  // 这个 harness 会注册 authorization，所以这里直接测 api.js 的空实现路径。
  const calls = []
  const dispose = registerAccountBridgeRoutes({
    webServer: {
      register(route) {
        calls.push(route)
        return () => {}
      },
    },
    adapter: { invalidate() {}, invalidateHealth() {}, clearSticky() {}, status: async () => [], refreshAccount: async () => ({}) },
    store: { list: async () => [] },
    families: [{ id: 'codex', displayName: 'Codex', route: 'acct-codex', login: { methods: [{ id: 'import' }] }, discover: () => [] }],
    ctx: {},
    log: {},
  })
  try {
    const res = fakeResponse()
    await calls[0].handler(fakeRequest({ url: `${PREFIX}/login`, body: { family: 'codex' } }), res)
    assert.equal(res.captured.status, 500)
    assert.equal(res.captured.body.error.code, 'NO_AUTHORIZATION')
  } finally {
    dispose()
  }
})

test('an unknown family is a 400, not a crash', async () => {
  const host = createMockHost()
  try {
    const answer = await callApi(host, 'login', { family: 'does-not-exist' })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.error.code, 'BAD_REQUEST')
  } finally {
    host.dispose()
  }
})

test('quotaOf reports "unknown" as undefined — never as zero', async () => {
  // 上游不报额度：`undefined`。
  assert.equal(await quotaOf({ quota: async () => undefined }, {}, {}), undefined)
  // 上游抛：同样是 `undefined`，而且不能把异常漏出去。
  assert.equal(await quotaOf({ quota: async () => { throw new Error('boom') } }, {}, {}), undefined)
  // 上游返回垃圾：过滤掉没有 id 的窗口。
  const windows = await quotaOf(
    { quota: async () => [{ id: 'weekly', name: '周', remainingFraction: 0.5 }, { name: 'no id' }, null] },
    {},
    {},
  )
  assert.deepEqual(windows, [{ id: 'weekly', name: '周', remainingFraction: 0.5, resetAt: undefined }])
  // 0% 是**真实读数**，必须原样保留（与「读不到」区分开）。
  const zeroed = await quotaOf({ quota: async () => [{ id: 'weekly', remainingFraction: 0 }] }, {}, {})
  assert.equal(zeroed[0].remainingFraction, 0)
  // 一族没有 quota 方法时不报错。
  assert.equal(await quotaOf({}, {}, {}), undefined)
})

test('check asks the upstream for quota and degrades to undefined when it throws', async () => {
  const host = createMockHost()
  try {
    await seedAccount(host, 'generic-1', {
      family: 'generic',
      auth: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-x' },
    })
    const answer = await callApi(host, 'check', { family: 'generic' })
    assert.equal(answer.status, 200)
    const row = answer.body.value.families.find((family) => family.family === 'generic')
    assert.ok(row)
    // generic 没有 quota()，所以这一行是 undefined——面板显示「未知」。
    assert.equal(row.accounts[0].quota, undefined)
  } finally {
    host.dispose()
  }
})
