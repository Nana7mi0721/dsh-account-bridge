import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockHost } from './harness.js'
import { AccountStore } from '../src/store.js'
import { createMemoryCredentials } from './harness.js'
import { CooldownTable } from '../src/health.js'
import { AccountBridgeAdapter } from '../src/pool.js'
import { FAMILIES, familyIds } from '../src/families/registry.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一个最小可用的族。 */
function makeFamily(overrides = {}) {
  const calls = []
  const family = {
    id: 'codex',
    displayName: 'Fake Codex',
    route: 'acct-codex',
    risk: 'medium',
    calls,
    async listModels() {
      return [{ provider: 'acct-codex', id: 'm1', name: 'M1' }]
    },
    resolveModel(provider, model) {
      return { provider, id: model, name: model }
    },
    needsRefresh() {
      return false
    },
    async refresh() {
      throw new Error('should not refresh')
    },
    async *stream(ctx, options) {
      calls.push(options.payload.id)
      yield* family.impl(options)
    },
    impl: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'success' } }
    },
    ...overrides,
  }
  return family
}

async function makeAdapter(family, accountIds) {
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  for (const id of accountIds) {
    await store.write(id, {
      id,
      family: family.id,
      label: id,
      source: 'oauth',
      auth: { access: 'token', refresh: 'refresh', expiresAt: Date.now() + 3_600_000, accountId: id },
    })
  }
  const health = new CooldownTable()
  const adapter = new AccountBridgeAdapter({ ctx: { fetch: async () => { throw new Error('no fetch') }, log: silent, config: {} }, store, health, families: [family], log: silent })
  return { adapter, health, store }
}

test('buffer/failover: a failure before any real output switches account', async () => {
  const family = makeFamily({
    async *impl() {
      // 只发了 block-start 就炸：这不算「已输出」，必须允许换号
      yield { type: 'block-start', index: 0, blockType: 'text' }
      throw Object.assign(new Error('boom'), { code: 'SERVER' })
    },
  })
  // 第二个账号正常
  const family2 = makeFamily()
  let second = 0
  const original = family2.impl
  family2.impl = async function* (options) {
    second += 1
    yield* original.call(this, options)
  }

  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  for (const id of ['codex-1', 'codex-2']) {
    await store.write(id, { id, family: 'codex', label: id, auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 } })
  }
  const health = new CooldownTable()

  // 两个账号各自的目录都要有 m1：用一个按账号分派的族
  const dispatch = {
    ...family2,
    async *stream(ctx, options) {
      const id = options.payload.id
      if (id === 'codex-1') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        throw Object.assign(new Error('boom'), { code: 'SERVER' })
      }
      yield* family2.impl(options)
    },
  }

  const adapter = new AccountBridgeAdapter({ ctx: { fetch: async () => {} }, store, health, families: [dispatch], log: silent })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'acct-codex', model: 'm1', messages: [{ id: 'u1', role: 'user' }] })) {
    chunks.push(chunk)
  }
  assert.equal(second, 1, 'second account must have served the request')
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'finish'],
    'the buffered block-start must be flushed exactly once, before the new account output',
  )
  assert.ok(health.why('codex', 'codex-1', 'm1'), 'the failing member must be recorded as unhealthy')
})

test('no failover once real output has been emitted', async () => {
  let secondCalls = 0
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  for (const id of ['codex-1', 'codex-2']) {
    await store.write(id, { id, family: 'codex', label: id, auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 } })
  }
  const health = new CooldownTable()
  const family = {
    id: 'codex',
    displayName: 'Fake',
    route: 'acct-codex',
    async listModels() {
      return [{ provider: 'acct-codex', id: 'm1', name: 'M1' }]
    },
    resolveModel(provider, model) {
      return { provider, id: model, name: model }
    },
    needsRefresh() {
      return false
    },
    async *stream(ctx, options) {
      if (options.payload.id === 'codex-2') {
        secondCalls += 1
        yield { type: 'finish', reason: { kind: 'success' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hello' }
      throw Object.assign(new Error('mid-stream'), { code: 'TRANSPORT' })
    },
  }
  const adapter = new AccountBridgeAdapter({ ctx: { fetch: async () => {} }, store, health, families: [family], log: silent })
  const chunks = []
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ provider: 'acct-codex', model: 'm1', messages: [{ id: 'u1', role: 'user' }] })) {
      chunks.push(chunk)
    }
  }, /mid-stream/)
  assert.equal(secondCalls, 0, 'must not replay a request that already produced content')
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta'],
    'everything produced before the failure must still reach the caller',
  )
})

test('isMeaningful matches the documented rule', () => {
  const meaningful = (chunk) => AccountBridgeAdapter.isMeaningful(chunk)
  assert.equal(meaningful({ type: 'block-start', index: 0, blockType: 'text' }), false)
  assert.equal(meaningful({ type: 'usage', usage: { inputTokens: 1 } }), false)
  assert.equal(meaningful({ type: 'finish', reason: { kind: 'success' } }), false)
  assert.equal(meaningful({ type: 'text-delta', index: 0, text: '' }), false)
  assert.equal(meaningful({ type: 'text-delta', index: 0, text: 'x' }), true)
  assert.equal(meaningful({ type: 'block-end', index: 0, block: { type: 'text', text: '' } }), false)
  assert.equal(meaningful({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }), true)
})

test('an empty response is classified as EMPTY_RESPONSE and allowed to fail over', async () => {
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  for (const id of ['codex-1', 'codex-2']) {
    await store.write(id, { id, family: 'codex', label: id, auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 } })
  }
  const health = new CooldownTable()
  const family = {
    id: 'codex',
    displayName: 'Fake',
    route: 'acct-codex',
    async listModels() {
      return [{ provider: 'acct-codex', id: 'm1', name: 'M1' }]
    },
    resolveModel(provider, model) {
      return { provider, id: model, name: model }
    },
    needsRefresh() {
      return false
    },
    async *stream(ctx, options) {
      if (options.payload.id === 'codex-1') {
        yield { type: 'finish', reason: { kind: 'success' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'from second' }
      yield { type: 'finish', reason: { kind: 'success' } }
    },
  }
  const adapter = new AccountBridgeAdapter({ ctx: { fetch: async () => {} }, store, health, families: [family], log: silent })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'acct-codex', model: 'm1', messages: [{ id: 'u1', role: 'user' }] })) {
    chunks.push(chunk)
  }
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['text-delta', 'finish'],
  )
  assert.equal(chunks[0].text, 'from second')
})

test('a failed refresh is recorded as a cooldown instead of leaving the account looking healthy', async () => {
  // 真机上是这样暴露的：`account_bridge_accounts` 说 minimax 那个账号「健康」，
  // 而 `llm.listModels('acct-minimax')` 返回空数组。因为目录要拿刷新后的 payload 去拉，
  // 刷新一失败目录就空，而失败没进健康表 ⇒ 两句话互相矛盾，看不出是账号死了。
  let refreshCalls = 0
  const family = makeFamily({
    needsRefresh: () => true,
    async refresh() {
      refreshCalls += 1
      const error = new Error('invalid_grant: this refresh token can no longer be used')
      error.code = 'AUTH'
      throw error
    },
  })
  const { adapter } = await makeAdapter(family, ['codex-1'])

  assert.deepEqual(await adapter.listModels('acct-codex'), [], '刷新失败就该列不出模型')
  assert.equal(refreshCalls, 1)
  assert.match(
    String(adapter.healthOf('codex', 'codex-1')),
    /24\.0 小时后可用|小时后可用/,
    'AUTH 失败要落成一条冷却，账号列表才不会说谎',
  )
})

test('a cooling account is not asked to refresh again on every catalog lookup', async () => {
  // 目录**不缓存失败**，所以没有这道闸的话，一条已经作废的刷新令牌会被每一次
  // listModels 重新拿去打上游。真机上那条死令牌就是这么被反复使用的。
  let refreshCalls = 0
  const family = makeFamily({
    needsRefresh: () => true,
    async refresh() {
      refreshCalls += 1
      const error = new Error('invalid_grant')
      error.code = 'AUTH'
      throw error
    },
  })
  const { adapter } = await makeAdapter(family, ['codex-1'])

  await adapter.listModels('acct-codex')
  await adapter.listModels('acct-codex')
  await adapter.listModels('acct-codex')

  assert.equal(refreshCalls, 1, '冷却期间不该再拿那条死令牌去打上游')
})

test('the plugin registers one route and one login flow per family', async () => {
  const host = createMockHost()
  try {
    // 从登记处推期望值，这样加族只要改 registry.js，不用回来改测试。
    assert.deepEqual(
      [...host.services.llm.routes.keys()],
      FAMILIES.map((family) => family.route),
    )
    assert.deepEqual(
      [...host.services.authorization.flows.keys()],
      familyIds().map((id) => `dsh-account-bridge/${id}-login`),
    )
    for (const family of FAMILIES) {
      const flow = host.services.authorization.flows.get(`dsh-account-bridge/${family.id}-login`)
      assert.equal(flow.label, family.displayName)
      assert.deepEqual(
        flow.methods.map((method) => method.id),
        family.login.methods.map((method) => method.id),
      )
    }
  } finally {
    host.dispose()
  }
})

test('disposing the plugin releases the registered routes', async () => {
  const host = createMockHost()
  assert.equal(host.services.llm.routes.size, FAMILIES.length)
  host.dispose()
  assert.equal(host.services.llm.routes.size, 0)
})

test('clearAccount removes the account key and every per-model member key under it', async () => {
  // 这条用例的由来：`/pool unfreeze` 需要一个**按账号**的入口（人记不住
  // 「上次是哪个模型把这个号烧了」），而 `clear()` 需要一个确切的模型名。
  // 实现时踩过一次：前缀写成 `${accountKey(...)}/`（也就是 `.../*/`）会一条都匹配不上，
  // 而且**不报错**——命令会安安静静地什么都不做。所以这里逐条断言键真的没了。
  const health = new CooldownTable()
  const verdict = { action: 'switch', cooldownMs: 60_000, reason: 'RATE_LIMIT', scope: 'member' }
  health.record('codex', 'codex-1', 'gpt-5-codex', verdict)
  health.record('codex', 'codex-1', 'gpt-5', verdict)
  health.record('codex', 'codex-2', 'gpt-5-codex', verdict)
  health.record('claude', 'claude-1', 'sonnet', verdict)

  const frozen = health.snapshot()
  assert.equal(frozen.filter((entry) => entry.blocked).length, 4)

  const removed = health.clearAccount('codex', 'codex-1')
  assert.equal(removed, 2, '账号级那条 + 两个模型分线里属于 codex-1 的两条')
  assert.equal(health.available('codex', 'codex-1', 'gpt-5-codex'), true)
  assert.equal(health.available('codex', 'codex-1', 'gpt-5'), true)
  // 别的账号、别的族不受影响。
  assert.equal(health.available('codex', 'codex-2', 'gpt-5-codex'), false)
  assert.equal(health.available('claude', 'claude-1', 'sonnet'), false)
})

test('clearAccount with no account id clears one family, not every family', async () => {
  const health = new CooldownTable()
  const verdict = { action: 'switch', cooldownMs: 60_000, reason: 'QUOTA', scope: 'account' }
  health.record('codex', 'codex-1', 'gpt-5', verdict)
  health.record('claude', 'claude-1', 'sonnet', verdict)

  assert.equal(health.clearAccount('codex'), 1)
  assert.equal(health.available('codex', 'codex-1', 'gpt-5'), true)
  assert.equal(health.available('claude', 'claude-1', 'sonnet'), false)
  // 清空一个本来就没东西的族 ⇒ 0，而且不该白白把 generation 推高（那会让池缓存无谓失效）。
  const before = health.generation
  assert.equal(health.clearAccount('codex'), 0)
  assert.equal(health.generation, before)
})

test('adapter.unfreeze reports how many cooldowns it cleared and drops the caches', async () => {
  const family = makeFamily()
  const { adapter, health } = await makeAdapter(family, ['codex-1'])

  // 直接往健康表里放两条：一条**账号级**（`healthOf` 看的就是它），
  // 一条**模型分线**（只有 `clearAccount` 的前缀匹配才会碰到）。
  health.record('codex', 'codex-1', 'gpt-5', { action: 'switch', cooldownMs: 60_000, reason: 'QUOTA', scope: 'account' })
  health.record('codex', 'codex-1', 'gpt-5-codex', { action: 'switch', cooldownMs: 60_000, reason: 'RATE_LIMIT', scope: 'member' })
  assert.match(String(adapter.healthOf('codex', 'codex-1')), /后可用/)

  const removed = adapter.unfreeze('codex', 'codex-1')
  assert.ok(removed >= 1, `expected at least one cooldown to be cleared, got ${removed}`)
  assert.equal(adapter.healthOf('codex', 'codex-1'), undefined, '解冻后不该再报告冷却')

  // 已经解冻过的账号再解冻一次 ⇒ 0，且不抛。
  assert.equal(adapter.unfreeze('codex', 'codex-1'), 0)
  assert.equal(health.snapshot().filter((entry) => entry.blocked).length, 0)
})

test('adapter.unfreeze on a healthy account is a no-op', async () => {
  const family = makeFamily()
  const { adapter } = await makeAdapter(family, ['codex-1'])
  assert.equal(adapter.unfreeze('codex', 'codex-1'), 0)
  assert.equal(adapter.healthOf('codex', 'codex-1'), undefined)
})

test('replay reaches the first candidate only: no account is handed a signature another account made', async () => {
  // 签名是**某一个账号**签的。换号之后把上一家签的东西发给下一家，是既没验过、
  // 也不该发生的事（上游会拒，而且我们无从分辨那是「格式不对」还是「这不是你签的」）。
  const seen = []
  const family = makeFamily({
    async *stream(ctx, options) {
      seen.push(options.replay === true)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if (options.payload.id === 'codex-1') {
        throw Object.assign(new Error('boom'), { code: 'SERVER' })
      }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const run = async (replay) => {
    seen.length = 0
    const credentials = createMemoryCredentials()
    const store = new AccountStore(credentials, silent)
    for (const id of ['codex-1', 'codex-2']) {
      await store.write(id, {
        id,
        family: 'codex',
        label: id,
        auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 },
      })
    }
    const adapter = new AccountBridgeAdapter({
      ctx: { fetch: async () => {}, log: silent, config: {} },
      store,
      health: new CooldownTable(),
      families: [family],
      log: silent,
      replay,
    })
    for await (const _ of adapter.stream({
      provider: 'acct-codex',
      model: 'm1',
      messages: [{ id: 'u1', role: 'user' }],
    })) {
      // 读干净就行
    }
  }

  await run(true)
  assert.deepEqual(seen, [true, false], 'the first candidate replays, the one that took over does not')
  await run(false)
  assert.deepEqual(seen, [false, false], 'with replay off nobody replays, not even the first')
})

test('what the translator dropped is collected, said once, and readable afterwards', async () => {
  // W8 的承诺是「翻译层不再静默丢东西」。翻译层自己会报告，但**得有一个人在听**——
  // 池子是那个人：它把一次请求的损失收进一本账，说完一句就完事，并留给 `/pool lost`。
  const said = []
  const log = { info: (...a) => said.push(a.join(' ')), warn: (...a) => said.push(a.join(' ')), error() {}, debug() {} }
  const quiet = { on: false }
  const family = makeFamily({
    async *stream(ctx, options) {
      if (!quiet.on) {
        options.onDiagnostic?.({ code: 'IMAGE_WITHOUT_DATA', severity: 'error', phase: 'request', path: 'messages[0].content[1]' })
        options.onDiagnostic?.({ code: 'IMAGE_WITHOUT_DATA', severity: 'error', phase: 'request', path: 'messages[0].content[1]' })
        options.onDiagnostic?.({ code: 'UNKNOWN_STOP_REASON', severity: 'warning', phase: 'stream', from: 'something_new' })
      }
      yield* family.impl(options)
    },
  })
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  await store.write('codex-1', {
    id: 'codex-1',
    family: 'codex',
    label: 'codex-1',
    auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 },
  })
  const adapter = new AccountBridgeAdapter({
    ctx: { fetch: async () => {}, log, config: {} },
    store,
    health: new CooldownTable(),
    families: [family],
    log,
  })
  const drain = async () => {
    for await (const _ of adapter.stream({ provider: 'acct-codex', model: 'm1', messages: [{ id: 'u1', role: 'user' }] })) {
      // 读干净就行
    }
  }

  await drain()
  const book = adapter.diagnostics()
  // 同一个 code 同一个位置只说一次，次数记在 count 上——一个坏流能刷出上万条同样的。
  assert.equal(book.entries.length, 2)
  assert.equal(book.entries[0].count, 2)
  assert.equal(book.hasErrors, true, 'a picture the model never saw is not a cosmetic loss')
  assert.equal(book.describe, 'lost content: IMAGE_WITHOUT_DATA×2 UNKNOWN_STOP_REASON×1')
  // 说的话正好一句，而且用 warn（有 error 级）。
  assert.equal(said.length, 1)
  assert.match(said[0], /lost content: IMAGE_WITHOUT_DATA×2/)

  // 第二趟请求从一本**干净**的账开始：上一个坏流不该把接下来的日志都染上味道。
  said.length = 0
  quiet.on = true
  await drain()
  assert.deepEqual(said, [], 'nothing lost means nothing said')
  // 但账本要记得刚才那次——用户是**事后**来问「模型为什么没看到我的图片」的，
  // 那时候最后那次请求多半已经是干净的了（回传工具结果那一轮）。
  const after = adapter.diagnostics()
  assert.equal(after.requests, 2, 'the ring keeps every request it saw')
  assert.equal(after.lostRequests, 1, 'only one of them lost anything')
  assert.match(after.describe, /IMAGE_WITHOUT_DATA×2/, 'the loss from the earlier request is still there')
})

test('a caller who walks away still gets the loss recorded', async () => {
  // 用户按了停止、宿主换了账号——那正是最需要知道「刚才丢了什么」的时刻。
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  let reported = 0
  const family = makeFamily({
    async *stream(ctx, options) {
      options.onDiagnostic?.({ code: 'UNRENDERED_BLOCK_TYPE', severity: 'warning', phase: 'stream' })
      reported += 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'first' }
      yield { type: 'text-delta', index: 0, text: 'second' }
    },
  })
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  await store.write('codex-1', {
    id: 'codex-1',
    family: 'codex',
    label: 'codex-1',
    auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 },
  })
  const adapter = new AccountBridgeAdapter({
    ctx: { fetch: async () => {}, log, config: {} },
    store,
    health: new CooldownTable(),
    families: [family],
    log,
  })
  const iterator = adapter
    .stream({ provider: 'acct-codex', model: 'm1', messages: [{ id: 'u1', role: 'user' }] })
    [Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  await iterator.return?.()

  assert.equal(reported, 1)
  assert.equal(adapter.diagnostics().entries.length, 1, 'abandoning the stream must not lose the book')
})

test('the loss book remembers the last few requests, newest loss first', async () => {
  // 只留最后一次是不够的：agent 一轮里有好几次请求，最后一次常常是干净的。
  // 那时候用户来问「模型为什么没看到我的图片」，只留最后一次的账本会答「什么都没丢」。
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  let losing = true
  const family = makeFamily({
    async *stream(ctx, options) {
      if (losing) options.onDiagnostic?.({ code: 'IMAGE_WITHOUT_DATA', severity: 'error', phase: 'request' })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
    },
  })
  const store = new AccountStore(createMemoryCredentials(), silent)
  await store.write('codex-1', {
    id: 'codex-1',
    family: 'codex',
    label: 'codex-1',
    auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 },
  })
  const adapter = new AccountBridgeAdapter({
    ctx: { fetch: async () => {}, log, config: {} },
    store,
    health: new CooldownTable(),
    families: [family],
    log,
  })
  const drain = async () => {
    for await (const _ of adapter.stream({ provider: 'acct-codex', model: 'm1', messages: [{ id: 'u1', role: 'user' }] })) {
      // 读干净就行
    }
  }

  await drain()
  losing = false
  for (let i = 0; i < 5; i += 1) await drain()

  const book = adapter.diagnostics()
  assert.equal(book.requests, 6)
  assert.equal(book.lostRequests, 1, 'the one bad request is the one it reports')
  assert.equal(book.entries[0].code, 'IMAGE_WITHOUT_DATA')
  assert.equal(book.hasErrors, true)
  assert.equal(typeof book.at, 'number', 'it says when the loss happened')

  // 环是有界的：再走三次干净请求，那次坏的就掉出去了。
  for (let i = 0; i < 3; i += 1) await drain()
  const aged = adapter.diagnostics()
  assert.equal(aged.requests, 8, 'the ring is bounded')
  assert.equal(aged.lostRequests, 0, 'the old loss has aged out')
  assert.deepEqual(aged.entries, [])

  // 新的坏请求一来，报的就是新的那一次。
  losing = true
  await drain()
  const fresh = adapter.diagnostics()
  assert.equal(fresh.requests, 8)
  assert.equal(fresh.lostRequests, 1)
  assert.equal(fresh.entries[0].code, 'IMAGE_WITHOUT_DATA')
})
