/**
 * OpenAI **Responses** 流翻译层的单测（`src/wire/responses.js`）。
 *
 * 为什么单独开一个文件：这一层原先**一个用例都没有**，而它是 codex 族每一轮对话的必经之路。
 * 结果就是两个只在真机上显形的缺陷一直躺在那里：
 *
 * 1. **收尾永远回 `'stop'`**，即使这一轮产出的是工具调用。宿主以为模型把话说完了，
 *    而它其实在等工具结果。本仓别的翻译层（anthropic / chat-completions / qoder / grok）
 *    都推 `'tool-calls'`，只有这一层不推。
 * 2. **`response.output_item.done` 不带顶层 `output_index` 时会落到 `?? 0`**，
 *    于是它关掉的是第 0 个块而不是该关的那个——界面上同一段文本出现两遍，
 *    外加一个空的 `block-end`。同一族的 grok 翻译层踩的就是这个坑。
 *
 * 这两个都是「写得出来、单测不写就发现不了」的类型，所以这里把它们逐条钉住。
 *
 * @module dsh-account-bridge/test/responses
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { translateResponsesStream } from '../src/wire/responses.js'

/** 假的 SSE 响应体：`frame.raw` 原样发，其余按 `data: <json>` 发。 */
function sseResponse(frames) {
  const body = (async function* generate() {
    for (const frame of frames) {
      yield frame?.raw ?? `data: ${JSON.stringify(frame)}\n\n`
    }
  })()
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body }
}

/** 收完整个流。 */
async function collect(frames) {
  const chunks = []
  for await (const chunk of translateResponsesStream(sseResponse(frames))) chunks.push(chunk)
  return chunks
}

/** 收流并把抛出的错误交回来（`{error}`）而不是让用例炸掉。 */
async function collectError(frames) {
  try {
    await collect(frames)
    return {}
  } catch (error) {
    return { error }
  }
}

/** 一个文本输出项的完整生命周期。 */
function textItem({ index = 0, id = 'msg_0', text = 'hello' } = {}) {
  return [
    { type: 'response.output_item.added', output_index: index, item: { id, type: 'message' } },
    { type: 'response.output_text.delta', output_index: index, item_id: id, delta: text },
    {
      type: 'response.output_item.done',
      output_index: index,
      item: { id, type: 'message', content: [{ type: 'output_text', text }] },
    },
  ]
}

// ------------------------------------------------------------ 收尾原因

test('a text-only turn finishes as stop', async () => {
  const chunks = await collect(textItem())
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('a turn that produced a tool call finishes as tool-calls, not stop', async () => {
  const chunks = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_0', type: 'function_call', name: 'read_file' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_0', delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_0', delta: '"a.txt"}' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'read_file', arguments: '{"path":"a.txt"}' },
    },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4 } } },
  ])
  // 这一条以前是 'stop'。
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('a tool call that never produced deltas still finishes as tool-calls', async () => {
  // 有些上游把整个 function_call 一次性放在 output_item.done 里，中间没有任何 delta。
  const chunks = await collect([
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'ping', arguments: '{}' },
    },
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('text plus a tool call is still tool-calls (the model is waiting on a tool)', async () => {
  const chunks = await collect([
    ...textItem({ index: 0, id: 'msg_0', text: 'let me look' }),
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
    },
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('response.incomplete wins over tool-calls: truncation is max-tokens', async () => {
  const chunks = await collect([
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'ping', arguments: '{}' },
    },
    { type: 'response.incomplete', response: { usage: { output_tokens: 999 } } },
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('every finish reason is one DSH actually accepts', async () => {
  // 写别的词**不报错但语义静默丢失**——这正是要钉住的东西。
  const allowed = new Set(['stop', 'tool-calls', 'max-tokens'])
  for (const frames of [textItem(), [{ type: 'response.incomplete', response: {} }].concat(textItem())]) {
    const chunks = await collect(frames)
    assert.equal(allowed.has(chunks.at(-1).reason.kind), true, `unexpected kind ${chunks.at(-1).reason.kind}`)
  }
})

// ------------------------------------------------------------ 分槽

test('output_item.done without a top-level output_index still closes the right block', async () => {
  // 这是第 2 个缺陷的回归用例：第 0 项是文本、第 1 项是工具调用，
  // 收尾事件只带巢状的 `item.id`。以前它会落到 `?? 0`，把第 0 个块关掉。
  const chunks = await collect([
    ...textItem({ index: 0, id: 'msg_0', text: 'hello' }).slice(0, 2),
    { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', name: 'read_file' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{}' },
    // 注意：这里**没有** output_index。
    {
      type: 'response.output_item.done',
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' },
    },
    {
      type: 'response.output_item.done',
      item: { id: 'msg_0', type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
    },
  ])
  const ends = chunks.filter((chunk) => chunk.type === 'block-end')
  assert.deepEqual(
    ends.map((chunk) => [chunk.index, chunk.block.type]),
    [
      [1, 'tool-call'],
      [0, 'text'],
    ],
  )
  // 每个块只被关一次——重复的 block-end 意味着界面上多出一条空块。
  assert.equal(new Set(ends.map((chunk) => chunk.index)).size, ends.length)
})

test('a text delta with no item_id falls back to index 0 rather than inventing a slot', async () => {
  const chunks = await collect([
    { type: 'response.output_text.delta', delta: 'bare' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'msg_0', type: 'message', content: [{ type: 'output_text', text: 'bare' }] },
    },
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

// ------------------------------------------------------------ 块内容

test('reasoning and text land in separate blocks with their own types', async () => {
  const chunks = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_0', type: 'reasoning' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_0', delta: 'thinking…' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'rs_0', type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking…' }] },
    },
    ...textItem({ index: 1, id: 'msg_1', text: 'answer' }),
  ])
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [
    { type: 'reasoning', text: 'thinking…' },
    { type: 'text', text: 'answer' },
  ])
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').length, 1)
})

test('a reasoning item that arrives without its summary still keeps the streamed text', async () => {
  // 真机上见过：`output_item.done` 的 reasoning 项不带 summary。收尾块是权威的，
  // 所以没有这条兜底时，一段刚才已经显示过的思考会在收尾被换成空块。
  // 这个缺陷是 golden 快照第一次生成时照出来的。
  const chunks = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_0', type: 'reasoning' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_0', delta: 'thinking…' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_0', type: 'reasoning' } },
  ])
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [
    { type: 'reasoning', text: 'thinking…' },
  ])
})

test('a message item that arrives without its content keeps the streamed text too', async () => {
  const chunks = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_0', type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_0', delta: 'answer' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_0', type: 'message', content: [] } },
  ])
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [
    { type: 'text', text: 'answer' },
  ])
})

test('a tool call delta carries the call id, and the block end carries the full arguments', async () => {
  const chunks = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_0', type: 'function_call', name: 'read_file' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_0', delta: '{"path":' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'read_file', arguments: '{"path":"a.txt"}' },
    },
  ])
  const delta = chunks.find((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(delta.id, 'fc_0')
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call_0', name: 'read_file', arguments: '{"path":"a.txt"}' })
})

test('usage rides along before the finish chunk', async () => {
  const chunks = await collect([
    ...textItem(),
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 120,
          output_tokens: 8,
          total_tokens: 128,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    },
  ])
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage.usage, {
    inputTokens: 120,
    outputTokens: 8,
    totalTokens: 128,
    cachedInputTokens: 100,
    reasoningTokens: 3,
  })
  assert.equal(chunks.indexOf(usage) < chunks.length - 1, true)
})

// ------------------------------------------------------------ 失败

test('an empty stream is EMPTY_RESPONSE, not a silent empty answer', async () => {
  const { error } = await collectError([{ type: 'response.completed', response: {} }])
  assert.equal(error?.code, 'EMPTY_RESPONSE')
})

test('a stream that only carried usage is still empty', async () => {
  const { error } = await collectError([
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 0 } } },
  ])
  assert.equal(error?.code, 'EMPTY_RESPONSE')
})

test('response.failed throws with the upstream message and a mapped code', async () => {
  const { error } = await collectError([
    ...textItem(),
    { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } } },
  ])
  assert.equal(error?.code, 'RATE_LIMIT')
  assert.match(error.message, /Rate limit reached/)
})

test('an in-band error event wins even when some text already arrived', async () => {
  const { error } = await collectError([
    ...textItem(),
    { type: 'error', code: 'invalid_api_key', message: 'Unauthorized: bad key' },
  ])
  assert.equal(error?.code, 'AUTH')
})

test('a [DONE] frame is ignored rather than parsed as JSON', async () => {
  const chunks = await collect([...textItem(), { raw: 'data: [DONE]\n\n' }])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('garbage frames are skipped instead of throwing', async () => {
  const chunks = await collect([
    { raw: 'data: not json at all\n\n' },
    { raw: ': a comment line\n\n' },
    ...textItem(),
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})
