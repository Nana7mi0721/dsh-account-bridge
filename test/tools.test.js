/**
 * `account_bridge_add_endpoint` 的方言开关。
 *
 * 这一条是被**真机验收**逼出来的：假上游不认 `stream_options`，于是**每一笔** OpenAI
 * 方言的请求都被 400 挡回来——而 `compat.streamUsage` 这个逃生口只有直接改凭据记录
 * 才够得着（工具过去只在 `protocol: 'anthropic'` 时写 `compat`）。
 * 也就是说：网关拒收这个字段的用户，装完插件只会看到一个恒定的 400。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountStore } from '../src/store.js'
import { genericFamily } from '../src/families/generic.js'
import { booleanish, createToolDefinitions, parseModelList } from '../src/tools.js'
import { createMemoryCredentials } from './harness.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一套能跑 `add_endpoint` 的最小依赖。 */
function makeTools() {
  const store = new AccountStore(createMemoryCredentials(), silent)
  const definitions = createToolDefinitions({
    adapter: { invalidate() {} },
    broker: {},
    store,
    families: [genericFamily],
    log: silent,
    ctx: {},
  })
  const add = definitions.find((definition) => definition.name === 'account_bridge_add_endpoint')
  assert.ok(add, 'account_bridge_add_endpoint must be registered')
  return { add, store }
}

/** 跑一次 add_endpoint，把刚落盘的记录读回来。 */
async function addAndRead(args) {
  const { add, store } = makeTools()
  const output = await add.execute({ baseUrl: 'https://relay.example.com/v1', apiKey: 'k', ...args })
  assert.match(output, /已添加账号/, `add_endpoint 应当成功：${output}`)
  const records = await store.list('generic')
  assert.equal(records.length, 1)
  return records[0]
}

test('by default no compat block is written at all', async () => {
  const record = await addAndRead({})
  // 默认值属于代码，不属于记录：写一个「和默认值一样」的键会让以后改默认值时
  // 老账号僵在旧行为上。
  assert.equal(record.auth.compat, undefined)
})

test('streamUsage=0 turns the field off for gateways that reject it', async () => {
  const record = await addAndRead({ streamUsage: '0' })
  assert.deepEqual(record.auth.compat, { streamUsage: false })
})

test('streamUsage only writes its own key, and composes with the protocol', async () => {
  const record = await addAndRead({ protocol: 'anthropic', streamUsage: 'false' })
  assert.deepEqual(record.auth.compat, { protocol: 'anthropic', streamUsage: false })
})

test('an unrecognised streamUsage value leaves the default alone', async () => {
  const record = await addAndRead({ streamUsage: 'maybe' })
  // 看不懂的词猜成 false 是最坏的一种：它会静静地关掉用量统计。
  assert.equal(record.auth.compat, undefined)
})

test('booleanish reads the usual spellings and refuses to guess', () => {
  for (const raw of ['1', 'true', 'TRUE', ' yes ', 'on']) assert.equal(booleanish(raw), true, raw)
  for (const raw of ['0', 'false', 'No', 'off']) assert.equal(booleanish(raw), false, raw)
  for (const raw of [undefined, null, '', '  ', 'maybe', 2]) assert.equal(booleanish(raw), undefined, String(raw))
})

test('parseModelList still reads id and id:contextWindow', () => {
  // 条目的形状是**混的**：没写窗口就是裸字符串，写了才是对象。
  // `declaredModels()` 两种都收（`typeof entry === 'string' ? { id: entry } : entry`），
  // 所以这里钉住现状，免得以后有人「顺手统一」成一种而漏改另一边。
  assert.deepEqual(parseModelList('a,b:32000,c'), ['a', { id: 'b', contextWindow: 32000 }, 'c'])
  // 只有冒号没有数字 ⇒ 当普通 id，不要把 NaN 或 0 塞进记录。
  assert.deepEqual(parseModelList('a:'), ['a'])
  assert.deepEqual(parseModelList(''), [])
  assert.deepEqual(parseModelList(undefined), [])
})
