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
