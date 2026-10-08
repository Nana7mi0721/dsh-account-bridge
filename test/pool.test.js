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
