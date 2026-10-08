/**
 * Anthropic 线协议翻译的回归测试。
 *
 * 这里钉住的都是「错了不会报错、只会悄悄变贵或悄悄变白」的行为：
 * 工具顺序导致的 prompt cache 失效、思考面板空白、工具调用被降级成文本。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  toAnthropicMessages,
  toAnthropicSystem,
  toAnthropicTools,
  translateAnthropicStream,
} from '../src/wire/anthropic.js'

/** 造一个只有 body 的假 Response；readSse 只认 async iterable。 */
function sseResponse(events) {
  const body = (async function* generate() {
    for (const event of events) {
      yield `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
    }
  })()
  return { ok: true, body }
}

/** 收集整个 chunk 流。 */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('tools are sorted by name: they sit at the head of the cached prefix', () => {
  const tools = [
    { name: 'write_file', description: 'w', parameters: { type: 'object' } },
    { name: 'read_file', description: 'r', parameters: { type: 'object' } },
    { name: 'apply_patch', description: 'a', parameters: { type: 'object' } },
  ]
  assert.deepEqual(
    toAnthropicTools(tools).map((tool) => tool.name),
    ['apply_patch', 'read_file', 'write_file'],
  )
  // 同一批工具、不同入参顺序 ⇒ 逐字节相同的请求前缀，prompt cache 才命中。
  assert.deepEqual(toAnthropicTools([...tools].reverse()), toAnthropicTools(tools))
})

test('the system array is identity + prompt + leading system messages, cached at the tail', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'leading one' }] },
    { role: 'system', content: [{ type: 'text', text: 'leading two' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]
  const blocks = toAnthropicSystem('the real prompt', messages)
  assert.equal(blocks.length, 4)
  assert.match(blocks[0].text, /Claude Code/)
  assert.equal(blocks[1].text, 'the real prompt')
  assert.equal(blocks[2].text, 'leading one')
  assert.equal(blocks[3].text, 'leading two')
  // tools 渲染在 system 之前，所以尾块这一个标记同时缓存两者。
  assert.deepEqual(blocks[3].cache_control, { type: 'ephemeral' })
  assert.equal(blocks[0].cache_control, undefined)
})

test('a tool-call outside an assistant message degrades to text instead of 400ing', () => {
  // Anthropic 会因为「tool_use 没有配对的 tool_result」整条请求 400，
  // 而历史里的工具调用并不总有配对结果。
  const messages = [
    {
      role: 'user',
      content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"p":"a"}' }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_2', name: 'write_file', arguments: '{"p":"b"}' }],
    },
  ]
  const out = toAnthropicMessages(messages)
  assert.equal(out[0].content[0].type, 'text')
  assert.match(out[0].content[0].text, /\[tool call read_file:/)
  assert.equal(out[1].content[0].type, 'tool_use')
  assert.equal(out[1].content[0].id, 'call_2')
  assert.deepEqual(out[1].content[0].input, { p: 'b' })
})

test('consecutive tool results merge into a single user message', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'x', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'one' }] },
    { role: 'tool', toolCallId: 'b', content: [{ type: 'text', text: 'two' }] },
  ]
  const out = toAnthropicMessages(messages)
  assert.equal(out.length, 2)
  assert.equal(out[1].role, 'user')
  assert.equal(out[1].content.length, 2)
  assert.deepEqual(
    out[1].content.map((block) => [block.type, block.tool_use_id]),
    [
      ['tool_result', 'a'],
      ['tool_result', 'b'],
    ],
  )
})

test('streaming keeps per-index accumulators because block-end carries the whole block', async () => {
  const response = sseResponse([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 50 } } },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])

  const chunks = await collect(translateAnthropicStream(response))
  const endOf = (index) => chunks.find((chunk) => chunk.type === 'block-end' && chunk.index === index)?.block

  assert.deepEqual(endOf(0), { type: 'reasoning', text: 'weighing it' })
  assert.deepEqual(endOf(1), { type: 'text', text: 'Hello' })
  assert.deepEqual(endOf(2), { type: 'tool-call', id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.txt"}' })

  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usage.usage.inputTokens, 100)
  assert.equal(usage.usage.outputTokens, 42)
  assert.equal(usage.usage.cachedInputTokens, 50)

  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
})

test('finish kinds stay inside the three values the harness understands', async () => {
  // DSH 只认 'stop' | 'tool-calls' | 'max-tokens'；写别的词不会报错，
  // 但 'max-tokens' 是有语义的（宿主据此丢掉工具调用块），所以必须逐字对上。
  const allowed = new Set(['stop', 'tool-calls', 'max-tokens', 'error'])
  for (const [stopReason, expected] of [
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['pause_turn', 'stop'],
    [undefined, 'stop'],
    ['tool_use', 'tool-calls'],
    ['max_tokens', 'max-tokens'],
  ]) {
    const response = sseResponse([
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
      ...(stopReason === undefined
        ? []
        : [{ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason } } }]),
    ])
    const finish = (await collect(translateAnthropicStream(response))).find((chunk) => chunk.type === 'finish')
    assert.ok(allowed.has(finish.reason.kind), `${finish.reason.kind} is not a harness finish kind`)
    assert.equal(finish.reason.kind, expected, `stop_reason ${stopReason}`)
  }
})

test('a stream with no content block at all is EMPTY_RESPONSE, not a silent success', async () => {
  const response = sseResponse([{ event: 'message_stop', data: { type: 'message_stop' } }])
  await assert.rejects(
    () => collect(translateAnthropicStream(response)),
    (error) => error.code === 'EMPTY_RESPONSE',
  )
})

test('a relay that sends bare data lines, with no event name, still translates', async () => {
  // `readSse` 在缺少 `event:` 行时填 SSE 的默认事件名 `message`，而 Anthropic 的事件名里
  // 没有叫 `message` 的。自建中转常常只发 `data:`、把事件名写在 payload.type 里——
  // 这一条钉住那个回退真的走得到（它曾经被 `event.event ?? payload.type` 变成死代码）。
  // 这里自己造响应而不用上面那个 sseResponse：它**总是**会写出一行 `event:`，
  // 所以表达不了「没有事件名」这件事。
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]
  const response = {
    ok: true,
    body: (async function* generate() {
      for (const event of events) yield `data: ${JSON.stringify(event)}\n\n`
    })(),
  }
  const chunks = await collect(translateAnthropicStream(response))
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end')?.block.text, 'hi')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})
