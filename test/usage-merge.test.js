/**
 * usage 的合并纪律（W2c）：**后到的非零值覆盖，零值绝不擦除**。
 *
 * 为什么值得一套跨层的用例：宿主读 usage 是
 *
 * ```js
 * case "usage": this._usage = chunk.usage;   // dsh-llm/lib/index.js:998-999
 * ```
 *
 * ——**整体替换，最后一帧说了算**。而 usage 在流式协议里是分片上报的：Anthropic 在
 * `message_start` 报输入、在 `message_delta` 报输出；兼容端点则经常在后面的帧里
 * 顺手回一个 `{input_tokens: 0}`。两种写法会导致同一个偏差：
 *
 * - 我们**发多帧** ⇒ 宿主让最后一帧替换掉前面所有读数；
 * - 我们**合并时让 0 覆盖** ⇒ 自己先把读数擦掉。
 *
 * 所以规矩是「每个翻译层各自合并成一帧，且零值不擦除」。这份文件按层各钉一条——
 * 因为「最后一帧说了算」在很多实现里是**默认写法**，漏掉哪一层都不会报错。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeUsageFrames, mergeUsageNonZero } from '../src/wire/usage.js'
import { translateChatStream } from '../src/wire/chat-completions.js'
import { translateResponsesStream } from '../src/wire/responses.js'
import { translateGrokStream } from '../src/wire/grok.js'
import { translateQoderStream } from '../src/wire/qoder.js'
import { translateTraeStream } from '../src/wire/trae.js'
import { translateAgyStream } from '../src/wire/agy.js'
import { translateCommandCodeStream } from '../src/wire/commandcode.js'

/** 一个只有 body 的假 Response（`readSse` 只认 async iterable）。 */
function bodyOf(chunks) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: (async function* generate() {
      for (const chunk of chunks) yield chunk
    })(),
  }
}

/** `data: {...}` 行。 */
function sse(frames) {
  return bodyOf(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`))
}

/**
 * `event: <名>` + `data: {...}` 两行。
 *
 * trae 的事件名走 SSE 自己的 `event:` 字段（`classifyStreamEvent` 读的是
 * `{event, data}` 的第一个参数，不看 data 里有没有 `event` 键），所以它没法用上面
 * 那个只发 `data:` 的 helper。
 */
function sseNamed(events) {
  return bodyOf(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 流里唯一那一帧 usage。 */
function usageOf(chunks) {
  const frames = chunks.filter((chunk) => chunk.type === 'usage')
  assert.equal(frames.length, 1, `expected exactly one usage frame, saw ${frames.length}`)
  return frames[0].usage
}

// ---------------------------------------------------------------- 纯函数

test('a later non-zero reading overrides, key by key', () => {
  assert.deepEqual(mergeUsageNonZero({ inputTokens: 5 }, { inputTokens: 7 }), { inputTokens: 7 })
})

test('an explicit zero never erases a reading we already have', () => {
  assert.deepEqual(mergeUsageNonZero({ inputTokens: 1234 }, { inputTokens: 0 }), { inputTokens: 1234 })
})

test('a zero is kept when there was nothing there — that is a real reading', () => {
  // 「未上报」与「显式为 0」必须在类型上分得开：前者不出现在对象里，后者是 0。
  assert.deepEqual(mergeUsageNonZero(undefined, { cachedInputTokens: 0 }), { cachedInputTokens: 0 })
  assert.deepEqual(mergeUsageNonZero({}, { cachedInputTokens: 0 }), { cachedInputTokens: 0 })
})

test('undefined, null, NaN and non-numbers are all "this frame said nothing"', () => {
  const previous = { inputTokens: 9 }
  for (const next of [undefined, null, {}, { inputTokens: undefined }, { inputTokens: null }, { inputTokens: NaN }, { inputTokens: '12' }]) {
    assert.deepEqual(mergeUsageNonZero(previous, next), previous, JSON.stringify(next))
  }
})

test('merging never mutates the object it was handed', () => {
  const previous = { inputTokens: 1 }
  const merged = mergeUsageNonZero(previous, { outputTokens: 2 })
  assert.deepEqual(previous, { inputTokens: 1 })
  assert.notEqual(merged, previous)
  // 没有新东西可写时连副本都不该造——省掉一次分配，也让「没变」这件事看得出来。
  assert.equal(mergeUsageNonZero(previous, {}), previous)
})

test('mergeUsageFrames folds a whole stream worth of frames', () => {
  assert.deepEqual(
    mergeUsageFrames([{ inputTokens: 100 }, undefined, { inputTokens: 0, outputTokens: 3 }, { outputTokens: 9 }]),
    { inputTokens: 100, outputTokens: 9 },
  )
})

// ---------------------------------------------------------------- 各层

test('chat-completions: a trailing zero does not wipe the prompt count', async () => {
  const chunks = await collect(
    translateChatStream(
      sse([
        { choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
        { choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } } },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 9 } },
      ]),
    ),
  )
  assert.deepEqual(usageOf(chunks), { inputTokens: 100, cachedInputTokens: 50, outputTokens: 9 })
})

test('responses: a second completion frame only adds what it knows', async () => {
  const chunks = await collect(
    translateResponsesStream(
      sse([
        { type: 'response.output_text.delta', item_id: 'i1', delta: 'hi' },
        { type: 'response.completed', response: { usage: { input_tokens: 700, output_tokens: 5 } } },
        { type: 'response.completed', response: { usage: { output_tokens: 11 } } },
      ]),
    ),
  )
  assert.deepEqual(usageOf(chunks), { inputTokens: 700, outputTokens: 11 })
})

test('grok: an incomplete frame that reports nothing keeps the completed one', async () => {
  // 旧写法是 `usage = usageOf(payload.response?.usage)`，而 `usageOf` 在「这一帧
  // 什么都没报」时返回 `undefined` ⇒ **整份读数被 undefined 覆盖掉**。
  const chunks = await collect(
    translateGrokStream(
      sse([
        { type: 'response.output_text.delta', item_id: 'i1', delta: 'hi' },
        { type: 'response.completed', response: { usage: { input_tokens: 300, output_tokens: 4 } } },
        { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
      ]),
    ),
  )
  assert.deepEqual(usageOf(chunks), { inputTokens: 300, outputTokens: 4 })
})

test('qoder: the inner frame merges instead of replacing', async () => {
  const envelope = (inner) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`
  const chunks = await collect(
    translateQoderStream(
      bodyOf([
        envelope({ choices: [{ delta: { content: 'hi' } }], usage: { prompt_tokens: 11, completion_tokens: 2 } }),
        envelope({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0 } }),
      ]),
    ),
  )
  assert.deepEqual(usageOf(chunks), { inputTokens: 11, outputTokens: 2 })
})

test('trae: several token_usage events become exactly one merged frame', async () => {
  // 原来是一帧事件发一帧 usage，而宿主是**整体替换** ⇒ 后到的那半份说了算。
  const chunks = await collect(
    translateTraeStream(
      sseNamed([
        { event: 'output', data: { response: 'hi' } },
        { event: 'token_usage', data: { prompt_tokens: 11 } },
        { event: 'token_usage', data: { completion_tokens: 4, cache_read_input_tokens: 2 } },
        { event: 'done', data: { finish_reason: 'stop' } },
      ]),
    ),
  )
  assert.deepEqual(usageOf(chunks), { inputTokens: 11, outputTokens: 4, cachedInputTokens: 2 })
  // 契约要求的顺序：block-* → usage → finish。usage 在 finish 之前、内容之后。
  assert.deepEqual(chunks.map((chunk) => chunk.type).slice(-2), ['usage', 'finish'])
})

test('agy: a final result without usage keeps what the steps reported', async () => {
  const lines = [
    JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hi' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 200, output_tokens: 3 } } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'hi' } }),
  ]
  const chunks = await collect(translateAgyStream(lines))
  assert.deepEqual(usageOf(chunks), { inputTokens: 200, outputTokens: 3 })
})

test('commandcode: a standalone usage packet is not dropped when finish omits it', async () => {
  // 这条传输的 standalone usage 包原先被 `if (chunk.type === 'usage') continue` 丢掉，
  // 只剩 finish 包里那一份；finish 包里没有就什么都不剩。
  const chunks = await collect(
    translateCommandCodeStream(
      sse([
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [], usage: { prompt_tokens: 64, completion_tokens: 2 } },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
      'openai',
      {},
    ),
  )
  assert.deepEqual(usageOf(chunks), { inputTokens: 64, outputTokens: 2 })
})

test('commandcode: the finish packet wins for the fields it does report', async () => {
  const chunks = await collect(
    translateCommandCodeStream(
      sse([
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [], usage: { prompt_tokens: 64, completion_tokens: 2 } },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 9 } },
      ]),
      'openai',
      {},
    ),
  )
  assert.deepEqual(usageOf(chunks), { inputTokens: 64, outputTokens: 9 })
})
