/**
 * W6 的接线：额度、Sink、近期用量真的影响了池子**先派谁上**。
 *
 * `test/select.test.js` 钉的是排序规则本身；这一份钉的是**池子有没有把该喂的东西喂进去**：
 * 额度是不是真读了、读得慢会不会拖住请求、被限流过的账号下一轮是不是真的排到了后面。
 *
 * 所有用例都构造成「按旧实现（`usable.sort((a, b) => a.account.id.localeCompare(...))`）
 * 会给出**相反**结果」的形状，所以它们能在改坏接线时失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { CooldownTable } from '../src/health.js'
import { AccountBridgeAdapter } from '../src/pool.js'
import { AccountStore } from '../src/store.js'
import { createMemoryCredentials } from './harness.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }
const HOUR = 3_600_000

/** 等已经排上队的微任务跑完——后台额度查询是 fire-and-forget。 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** 正常的一轮。 */
async function* ok() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'ok' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
  yield { type: 'finish', reason: { kind: 'success' } }
}

function rateLimited() {
  return Object.assign(new Error('codex: HTTP 429 Rate limit exceeded'), { code: 'RATE_LIMIT' })
}

/**
 * 造一个两账号的池子。
 * `readings(id)` 返回该账号的额度窗口；返回 `undefined` ＝ 上游什么都没说（仍然「未知」）。
 * 不传 `readings` 就连 `quota()` 方法都没有。
 */
async function build({ readings, stream = ok, accounts = ['codex-1', 'codex-2'] } = {}) {
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  for (const id of accounts) {
    await store.write(id, {
      id,
      family: 'codex',
      label: id,
      auth: { access: 't', refresh: 'r', expiresAt: Date.now() + HOUR, accountId: id },
    })
  }
  const tried = []
  const family = {
    id: 'codex',
    displayName: 'Fake Codex',
    route: 'acct-codex',
    quotaCalls: [],
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
      tried.push(options.payload.id)
      yield* stream(options.payload.id, tried.length)
    },
  }
  if (readings) {
    family.quota = async (ctx, payload) => {
      family.quotaCalls.push(payload.id)
      return readings(payload.id)
    }
  }
  const health = new CooldownTable()
  const adapter = new AccountBridgeAdapter({
    ctx: { fetch: async () => {}, log: silent, config: {} },
    store,
    health,
    families: [family],
    log: silent,
  })
  return { adapter, family, health, tried, store }
}

/** 触发一次池子装配（后台额度查询由此起飞），再等它们落地。 */
async function warm(adapter) {
  await adapter.listModels('acct-codex')
  await settle()
  await settle()
}

/** 跑一轮，返回这一轮**试过**的账号。 */
async function attempt(adapter, conversation) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'acct-codex',
    model: 'm1',
    messages: [{ id: conversation, role: 'user' }],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

/** 一个「还剩这么多」的额度读数。 */
function left(fraction) {
  return [{ id: 'weekly', name: '周窗口', remainingFraction: fraction, resetAt: Date.now() + 2 * HOUR }]
}

test('额度决定顺序：还剩 95% 的排在只剩 5% 的前面', async () => {
  const { adapter, tried } = await build({
    readings: (id) => left(id === 'codex-2' ? 0.95 : 0.05),
  })
  await warm(adapter)
  await attempt(adapter, 'u1')
  // codex-1 的 id 更靠前，旧实现一定选它；额度说该选 codex-2
  assert.deepEqual(tried, ['codex-2'])
})

test('额度查询慢不拖住请求：选择永不等待它', async () => {
  const { adapter, tried } = await build({
    // 永不落地：只要选择路径上有人 await 它，这一轮就永远结束不了
    readings: () => new Promise(() => {}),
  })
  const chunks = await attempt(adapter, 'u1')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(tried, ['codex-1'], '读不到额度时退回 id 顺序')
})

test('额度查询报错只是「未知」，不影响请求', async () => {
  const { adapter, tried } = await build({
    readings: () => {
      throw new Error('quota endpoint exploded')
    },
  })
  await warm(adapter)
  const chunks = await attempt(adapter, 'u1')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(tried, ['codex-1'])
})

test('额度未知但这一族读得出额度：先让它答一次（learns）', async () => {
  const { adapter, family, tried } = await build({
    // codex-1 读得到，codex-2 上游什么都没说 ⇒ 它仍然是「未知」
    readings: (id) => (id === 'codex-1' ? left(0.95) : undefined),
  })
  await warm(adapter)
  assert.deepEqual(family.quotaCalls.sort(), ['codex-1', 'codex-2'], '两个账号都要问过一遍')
  await attempt(adapter, 'u1')
  // 只按额度排的话 codex-1（用 5%）在「可用」档、codex-2 未知也在这档但 pace 极低，
  // 会排到后面；`learns` 让它先答一次，否则它永远不会被知道。
  assert.deepEqual(tried, ['codex-2'])
})

test('额度一模一样时，上一轮用过的账号让位（近期用量）', async () => {
  const { adapter, tried } = await build({ readings: () => left(0.95) })
  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried.slice(0, 1), ['codex-1'])
  await attempt(adapter, 'u2')
  assert.deepEqual(tried.slice(1), ['codex-2'], '两个账号额度相同，近期用得少的先上')
})

test('还有额度却吃了限流的账号会沉到后面：冷却结束了也一样', async () => {
  let firstRound = true
  const { adapter, tried } = await build({
    // codex-1 的额度明显更好，只按额度排它永远第一
    readings: (id) => left(id === 'codex-1' ? 0.95 : 0.05),
    stream: async function* (id) {
      if (id === 'codex-1' && firstRound) {
        firstRound = false
        yield { type: 'block-start', index: 0, blockType: 'text' }
        throw rateLimited()
      }
      yield* ok()
    },
  })
  await warm(adapter)

  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1', 'codex-2'], '第一轮按额度先派 codex-1，它吃了限流才换号')
  assert.ok(adapter.debugState().sunk.length === 1, '限流过就要沉一次')

  // 冷却结束（用户手动解冻，等于「rest 过去了」）
  assert.equal(adapter.unfreeze('codex', 'codex-1'), 1)
  await attempt(adapter, 'u2')
  assert.deepEqual(tried.slice(2), ['codex-2'], '沉过的排在没沉过的后面，哪怕它的额度更好')
})

test('额度用尽与欠费**不**沉：那是「它现在不能用」，不是我们打得太急', async () => {
  const exhausted = () =>
    Object.assign(new Error('codex: HTTP 429 quota exhausted'), { code: 'QUOTA' })
  let firstRound = true
  const { adapter, tried } = await build({
    readings: (id) => left(id === 'codex-1' ? 0.95 : 0.05),
    stream: async function* (id) {
      if (id === 'codex-1' && firstRound) {
        firstRound = false
        yield { type: 'block-start', index: 0, blockType: 'text' }
        throw exhausted()
      }
      yield* ok()
    },
  })
  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(adapter.debugState().sunk, [], '额度用尽不该沉')
})

test('没有 quota() 的族照常按 id 选', async () => {
  const { adapter, tried } = await build({})
  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1'])
})
