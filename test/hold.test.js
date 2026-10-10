/**
 * 换号窗口：**思考不算输出**（P7-W1）。
 *
 * 要防的事故：Claude 会在想了 10–25 秒之后用安全策略**拒绝整轮**。如果一看到
 * `reasoning-delta` 就认为「已经输出了、不能再换号」，用户吃到的就是那条拒绝，
 * 而**下一个账号从来没被问过**（magpie issue #248 的现场）。
 *
 * 但也不能无限憋着，所以有三个上限，且**到期一律原样放行、不是丢弃**。
 * 这里每条都钉一个「只有它才解释得通」的可观测差异：到期放行之后，
 * **账号就不能再换了**——因为调用方已经在屏幕上看见了那些块。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { AccountStore } from '../src/store.js'
import { CooldownTable } from '../src/health.js'
import { AccountBridgeAdapter, refusesAfterThinking } from '../src/pool.js'
import { createMemoryCredentials } from './harness.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

const CLAUDE = 'claude-sonnet-4-5'
const GLM = 'glm-4.6'

/**
 * 造一个两账号的适配器。
 *
 * @param {(options: {id: string, n: number}) => AsyncIterable<any>} impl
 *   按账号产出 chunk 的函数。`n` 是**第几次**调用（1 起），比按 id 分支更好读。
 * @param {object} [options]
 * @param {string} [options.familyId] 族 id（影响 `refusesAfterThinking` 的兜底判定）
 * @param {string} [options.route]
 * @param {string} [options.model]
 * @param {object} [options.hold] 覆盖换号窗口的三个上限
 */
async function makePool(impl, { familyId = 'claude', route = 'acct-claude', model = CLAUDE, hold } = {}) {
  const calls = []
  const family = {
    id: familyId,
    displayName: 'Fake',
    route,
    async listModels() {
      return [{ provider: route, id: model, name: model }]
    },
    resolveModel(provider, id) {
      return { provider, id, name: id }
    },
    needsRefresh() {
      return false
    },
    stream(ctx, options) {
      const id = options.payload.id
      calls.push(id)
      return impl({ id, n: calls.length })[Symbol.asyncIterator]()
    },
  }

  // 账号 id 必须是 `<族>-<序号>`：`AccountStore.list()` 按这个形状解析族名，
  // 形状不对的会被直接过滤掉（写错了会看到「一个账号都没有」）。
  const ids = [`${familyId}-1`, `${familyId}-2`]
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  for (const id of ids) {
    await store.write(id, {
      id,
      family: familyId,
      label: id,
      auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 },
    })
  }
  const adapter = new AccountBridgeAdapter({
    ctx: { fetch: async () => {} },
    store,
    health: new CooldownTable(),
    families: [family],
    log: silent,
    hold,
  })
  return { adapter, calls, ids, model, route }
}

/** 收完整个流，把「收到什么」和「怎么结束的」都带回来。 */
async function drain(adapter, route, model) {
  const chunks = []
  try {
    for await (const chunk of adapter.stream({ provider: route, model, messages: [{ id: 'u1', role: 'user' }] })) {
      chunks.push(chunk)
    }
    return { chunks, error: undefined }
  } catch (error) {
    return { chunks, error }
  }
}

const reasoning = (value, index = 0) => ({ type: 'reasoning-delta', index, text: value })
const text = (value, index = 0) => ({ type: 'text-delta', index, text: value })
const types = (chunks) => chunks.map((chunk) => chunk.type)

// ---------------------------------------------------------------- 判据

test('refusesAfterThinking is decided by the model name, not by the family', () => {
  const generic = { id: 'generic' }
  assert.equal(refusesAfterThinking(generic, 'claude-sonnet-4-5'), true)
  assert.equal(refusesAfterThinking(generic, 'gpt-5-codex'), true)
  assert.equal(refusesAfterThinking(generic, 'o3-mini'), true)
  assert.equal(refusesAfterThinking(generic, 'gemini-3-pro'), true)
  // `provider/model` 两段形态只看最后一段（generic 族常见）。
  assert.equal(refusesAfterThinking(generic, 'google/gemini-3-pro'), true)
  // 别家不能憋：憋着会让它们的思考在正文开始时一次性吐出来。
  assert.equal(refusesAfterThinking(generic, 'glm-4.6'), false)
  assert.equal(refusesAfterThinking(generic, 'deepseek-chat'), false)
  assert.equal(refusesAfterThinking(generic, 'MiniMax-M3'), false)
  assert.equal(refusesAfterThinking(generic, 'kimi-k2'), false)
  // 认不出模型名时退回族：这两族只有一家的模型。
  assert.equal(refusesAfterThinking({ id: 'codex' }, 'some-internal-name'), true)
  assert.equal(refusesAfterThinking({ id: 'claude' }, 'some-internal-name'), true)
  assert.equal(refusesAfterThinking({ id: 'qoder' }, 'auto'), false)
  // 族自己说了算时以族为准。
  assert.equal(refusesAfterThinking({ id: 'claude', refusesAfterThinking: () => false }, 'claude-x'), false)
})

// ---------------------------------------------------------------- 只思考 ⇒ 还能换号

test('thinking alone does not close the failover window (the #248 regression)', async () => {
  const { adapter, calls, ids, route, model } = await makePool(async function* ({ n }) {
    if (n > 1) {
      yield text('served by the second account')
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    for (let i = 0; i < 20; i += 1) yield reasoning(`thinking ${i}…`)
    throw Object.assign(new Error('refused after 20 reasoning events'), { code: 'RATE_LIMIT' })
  })

  const { chunks, error } = await drain(adapter, route, model)
  assert.equal(error, undefined, 'the second account must have answered')
  assert.deepEqual(calls, ids, 'the next account must have been asked')
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'reasoning-delta'),
    [],
    'the discarded account’s reasoning must not reach the caller',
  )
  assert.deepEqual(types(chunks), ['text-delta', 'finish'])
})

test('once text shows up the window is closed, and a later failure is not retried', async () => {
  const { adapter, calls, ids, route, model } = await makePool(async function* () {
    yield reasoning('hmm')
    yield text('here is the answer')
    throw Object.assign(new Error('mid-stream'), { code: 'TRANSPORT' })
  })

  const { chunks, error } = await drain(adapter, route, model)
  assert.match(String(error?.message), /mid-stream/)
  assert.deepEqual(calls, [ids[0]], 'content was already shown — replaying would duplicate it')
  assert.deepEqual(types(chunks), ['reasoning-delta', 'text-delta'])
})

test('a family that does not refuse after thinking commits on the first reasoning event', async () => {
  // 对照实验：同一份实现，换个不「想完就拒」的族/模型，第一个思考事件就该提交。
  const { adapter, calls, ids, route, model } = await makePool(
    async function* () {
      yield reasoning('hmm')
      throw Object.assign(new Error('mid-stream'), { code: 'TRANSPORT' })
    },
    { familyId: 'generic', route: 'acct-generic', model: GLM },
  )

  const { chunks, error } = await drain(adapter, route, model)
  assert.match(String(error?.message), /mid-stream/)
  assert.deepEqual(calls, [ids[0]], 'the thinking was already handed over — no replay')
  assert.deepEqual(types(chunks), ['reasoning-delta'])
})

// ---------------------------------------------------------------- 三个上限

test('nothing meaningful for holdLongestMs: the buffer is let through, and the window closes', async () => {
  // 「到期放行」唯一解释得通的证据：放行之后账号不能再换，所以第二家不会被问。
  const { adapter, calls, ids, route, model } = await makePool(
    async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await sleep(80) // 远长于 holdLongestMs，远短于测试超时
      throw Object.assign(new Error('slow upstream gave up'), { code: 'SERVER' })
    },
    { hold: { longestMs: 20 } },
  )

  const { chunks, error } = await drain(adapter, route, model)
  assert.match(String(error?.message), /slow upstream gave up/)
  assert.deepEqual(calls, [ids[0]], 'the buffered block-start was already handed over')
  assert.deepEqual(types(chunks), ['block-start'], 'the buffer is let through as-is')
})

test('with the default window the same stream still fails over', async () => {
  // 上面那条的对照组：把窗口放到比上游的沉默更长，就还能换号。
  const { adapter, calls, ids, route, model } = await makePool(
    async function* ({ n }) {
      if (n > 1) {
        yield text('second')
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await sleep(40)
      throw Object.assign(new Error('slow upstream gave up'), { code: 'SERVER' })
    },
    { hold: { longestMs: 5_000 } },
  )

  const { chunks, error } = await drain(adapter, route, model)
  assert.equal(error, undefined)
  assert.deepEqual(calls, ids)
  assert.deepEqual(types(chunks), ['text-delta', 'finish'])
})

test('thinking alone is held longer than an empty buffer, but only for a refuser', async () => {
  const { adapter, calls, ids, route, model } = await makePool(
    async function* () {
      yield reasoning('one')
      yield reasoning('two')
      await sleep(90) // 长于 thinkingMs=30，短于测试超时
      throw Object.assign(new Error('refused'), { code: 'RATE_LIMIT' })
    },
    { hold: { thinkingMs: 30, longestMs: 5_000 } },
  )

  const { chunks, error } = await drain(adapter, route, model)
  assert.match(String(error?.message), /refused/)
  assert.deepEqual(calls, [ids[0]], 'the reasoning was flushed at the deadline, so it cannot be replayed')
  assert.deepEqual(
    chunks.map((chunk) => chunk.text),
    ['one', 'two'],
    'the flush keeps arrival order',
  )
})

test('the buffer is capped: a runaway upstream cannot eat memory', async () => {
  const { adapter, calls, ids, route, model } = await makePool(
    async function* () {
      yield reasoning('0123456789')
      yield reasoning('abcdefghij')
      await sleep(80)
      throw Object.assign(new Error('mid-stream'), { code: 'TRANSPORT' })
    },
    { hold: { mostBytes: 8, thinkingMs: 5_000, longestMs: 5_000 } },
  )

  const { chunks, error } = await drain(adapter, route, model)
  assert.match(String(error?.message), /mid-stream/)
  assert.deepEqual(calls, [ids[0]], 'the cap flushed the hold, closing the window')
  assert.equal(chunks.length, 2, 'both reasoning events were let through before the failure')
})

// ---------------------------------------------------------------- 顺序与内容

test('a successful turn keeps the reasoning and the text in arrival order', async () => {
  // 最容易写坏的一条：憋过又放行，块与块的顺序、块内的文字都不能变。
  const { adapter, route, model } = await makePool(async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield reasoning('let me ')
    yield reasoning('think')
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'let me think' } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield text('the ', 1)
    yield text('answer', 1)
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'the answer' } }
    yield { type: 'usage', usage: { inputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })

  const { chunks, error } = await drain(adapter, route, model)
  assert.equal(error, undefined)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'let me ' },
    { type: 'reasoning-delta', index: 0, text: 'think' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'let me think' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'the ' },
    { type: 'text-delta', index: 1, text: 'answer' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'the answer' } },
    { type: 'usage', usage: { inputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('a stream that only ever emits metadata is still an empty response', async () => {
  // 放行窗口不能把「一个字都没有」变成「成功」：那块 block-start 从来没被交出去。
  const { adapter, calls, ids, route, model } = await makePool(async function* ({ n }) {
    if (n > 1) {
      yield text('second')
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })

  const { chunks, error } = await drain(adapter, route, model)
  assert.equal(error, undefined)
  assert.deepEqual(calls, ids, 'an empty turn must be allowed to fail over')
  assert.deepEqual(types(chunks), ['text-delta', 'finish'])
})
