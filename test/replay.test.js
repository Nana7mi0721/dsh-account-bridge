/**
 * `replayState` 的回归测试（W4）。
 *
 * 这一层最危险的地方不是「报错」，而是**静默丢东西**：宿主的
 * `BlockAssembler.assembled()` 只在 `envelope.blocks.length === 它见过的块数` 时才留信封，
 * 对不上就把整个信封扔掉、而且一句话都不说。所以这里的用例重点不在「能读出来」，
 * 而在「读不出来时到底是哪一种读不出来」，以及**块数一定对得上**。
 *
 * 另一半是回放开关：默认关，关着的时候请求体必须与以前**逐字节相同**。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANTHROPIC_REPLAY_KIND,
  REPLAY_VERSION,
  RESPONSES_REPLAY_KIND,
  makeEnvelope,
  readReplay,
  replayItem,
  replayValue,
} from '../src/wire/replay.js'
import { toAnthropicMessages, translateAnthropicStream } from '../src/wire/anthropic.js'
import { toResponsesInput, translateResponsesStream } from '../src/wire/responses.js'

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

/** 从 chunk 流里取收尾块。 */
function finishOf(chunks) {
  return chunks.find((chunk) => chunk.type === 'finish')
}

/** 一条 Anthropic 风格的思考轮：思考块带签名，然后一段正文。 */
function thinkingTurn({ stopReason = 'end_turn', signature = 'sig-abc', tool = false } = {}) {
  const events = [
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 11 } } } },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } },
    },
  ]
  if (signature !== undefined) {
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
    })
  }
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } })
  events.push({
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  })
  events.push({
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } },
  })
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } })
  if (tool) {
    events.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } },
    })
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"p":1}' } },
    })
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } })
  }
  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason } } })
  return sseResponse(events)
}

/** 一条带思考的助手消息（历史），信封由 `envelope` 决定。 */
function assistantWithThinking(blocks, envelope) {
  // 真实的会话里 `source.model` 就是信封上那个模型（宿主逐字比对）。
  const model = envelope?.response?.model ?? 'claude-sonnet-4'
  return {
    role: 'assistant',
    content: blocks,
    source: { kind: 'model', provider: 'acct-claude', model, replayState: envelope },
  }
}

// ---------------------------------------------------------------------------
// 信封本身
// ---------------------------------------------------------------------------

test('an envelope carries the kind, the version and the model it was made for', () => {
  const envelope = makeEnvelope(ANTHROPIC_REPLAY_KIND, 'claude-sonnet-4', [{ type: 'reasoning', signature: 's' }])
  assert.deepEqual(envelope, {
    response: { kind: 'account-bridge/anthropic-messages', version: REPLAY_VERSION, model: 'claude-sonnet-4' },
    blocks: [{ type: 'reasoning', signature: 's' }],
  })
})

test('an envelope from another family is invisible, not an error', () => {
  // 我们 11 条 route 共用同一个 adapter 对象，宿主的 forAdapter() 不会替我们挡住
  // 「codex 写的信封被 claude 读走」——只能自己按 kind 查。
  const blocks = [{ type: 'reasoning', encryptedContent: 'zzz' }]
  const message = assistantWithThinking([{ type: 'reasoning', text: 't' }], makeEnvelope(RESPONSES_REPLAY_KIND, 'gpt-5', blocks))
  assert.equal(readReplay(message, ANTHROPIC_REPLAY_KIND), undefined)
  assert.equal(replayValue(message, ANTHROPIC_REPLAY_KIND, 0), undefined)
  // 反过来也一样：Responses 的读法读不出 Anthropic 的信封。
  const other = assistantWithThinking([{ type: 'reasoning', text: 't' }], makeEnvelope(ANTHROPIC_REPLAY_KIND, 'm', blocks))
  assert.equal(replayItem(other, 0), undefined)
})

test('the two kinds do not even share a field name', () => {
  // 字段名一样会让「读错族的信封」在 kind 检查之外还有第二条看不见的路。
  const message = assistantWithThinking(
    [{ type: 'reasoning', text: 't' }],
    makeEnvelope(RESPONSES_REPLAY_KIND, 'gpt-5', [{ type: 'reasoning', encryptedContent: 'zzz' }]),
  )
  assert.equal(readReplay(message, RESPONSES_REPLAY_KIND), message.source.replayState.blocks)
  assert.equal(replayValue(message, RESPONSES_REPLAY_KIND, 0), 'zzz')
  // 换一个字种来读同一块：字段名对不上，读到的就是「没有」。
  const swapped = assistantWithThinking(
    [{ type: 'reasoning', text: 't' }],
    makeEnvelope(ANTHROPIC_REPLAY_KIND, 'gpt-5', [{ type: 'reasoning', encryptedContent: 'zzz' }]),
  )
  assert.equal(replayValue(swapped, ANTHROPIC_REPLAY_KIND, 0), undefined)
})

test('every way an envelope can be wrong reads as "no envelope" instead of throwing', () => {
  const content = [{ type: 'reasoning', text: 't' }]
  const good = makeEnvelope(ANTHROPIC_REPLAY_KIND, 'claude-sonnet-4', [{ type: 'reasoning', signature: 's' }])
  const cases = {
    'not an assistant message': { role: 'user', content, source: { kind: 'model', model: 'claude-sonnet-4', replayState: good } },
    'no source at all': { role: 'assistant', content },
    'source is not a model': { role: 'assistant', content, source: { kind: 'tool', model: 'claude-sonnet-4', replayState: good } },
    'envelope is not an object': assistantWithThinking(content, 'nope'),
    'envelope is an array': assistantWithThinking(content, []),
    'no response block': assistantWithThinking(content, { blocks: good.blocks }),
    'response is not an object': assistantWithThinking(content, { response: 'x', blocks: good.blocks }),
    'unknown kind': assistantWithThinking(content, { response: { kind: 'other', version: 1, model: 'claude-sonnet-4' }, blocks: good.blocks }),
    'future version': assistantWithThinking(content, { response: { kind: ANTHROPIC_REPLAY_KIND, version: 99, model: 'claude-sonnet-4' }, blocks: good.blocks }),
    'no model in the envelope': assistantWithThinking(content, { response: { kind: ANTHROPIC_REPLAY_KIND, version: 1 }, blocks: good.blocks }),
    'envelope model is not the source model': {
      role: 'assistant',
      content,
      source: {
        kind: 'model',
        model: 'claude-sonnet-4',
        replayState: makeEnvelope(ANTHROPIC_REPLAY_KIND, 'claude-opus-4', good.blocks),
      },
    },
    'envelope model is not the requested model': assistantWithThinking(content, good),
    'block count mismatch': assistantWithThinking(content, makeEnvelope(ANTHROPIC_REPLAY_KIND, 'claude-sonnet-4', [])),
    'content is not an array': {
      role: 'assistant',
      content: 'text',
      source: { kind: 'model', model: 'claude-sonnet-4', replayState: good },
    },
  }
  for (const [name, message] of Object.entries(cases)) {
    const model = name === 'envelope model is not the requested model' ? 'claude-opus-4' : undefined
    assert.equal(readReplay(message, ANTHROPIC_REPLAY_KIND, model), undefined, name)
  }
})

test('a signature is only ever read off a reasoning block', () => {
  // 「块类型必须与内容块逐字相同」是宿主自己的校验规则（block type mismatch），
  // 我们提前一步按它判，免得把一个注定被丢掉的信封写进会话文件。
  const envelope = makeEnvelope(ANTHROPIC_REPLAY_KIND, 'm', [
    { type: 'text', signature: 'sig-on-text' },
    { type: 'reasoning', signature: '' },
    { type: 'reasoning', signature: 'good' },
  ])
  const message = assistantWithThinking(
    [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }, { type: 'reasoning', text: 'c' }],
    envelope,
  )
  assert.equal(replayValue(message, ANTHROPIC_REPLAY_KIND, 0), undefined, 'signature on a text block is not a signature')
  assert.equal(replayValue(message, ANTHROPIC_REPLAY_KIND, 1), undefined, 'an empty signature is not a signature')
  assert.equal(replayValue(message, ANTHROPIC_REPLAY_KIND, 2), 'good')
  assert.equal(replayValue(message, ANTHROPIC_REPLAY_KIND, 3), undefined, 'past the end')
})

// ---------------------------------------------------------------------------
// Anthropic 线：累积
// ---------------------------------------------------------------------------

test('a stream that carried a signature finishes with an envelope', async () => {
  const chunks = await collect(translateAnthropicStream(thinkingTurn(), { model: 'claude-sonnet-4' }))
  const finish = finishOf(chunks)
  assert.deepEqual(finish.replayState, {
    response: { kind: ANTHROPIC_REPLAY_KIND, version: 1, model: 'claude-sonnet-4' },
    blocks: [{ type: 'reasoning', signature: 'sig-abc' }, { type: 'text' }],
  })
})

test('a signature that arrives on the opening block is not lost either', async () => {
  const events = [
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'sig-open' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '-more' } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
  ]
  const chunks = await collect(translateAnthropicStream(sseResponse(events), { model: 'm' }))
  assert.deepEqual(finishOf(chunks).replayState.blocks, [{ type: 'reasoning', signature: 'sig-open-more' }])
})

test('no signature anywhere means no envelope at all', async () => {
  // 一个空壳信封会跟着每一条助手消息存进会话文件，换不来任何东西。
  const chunks = await collect(translateAnthropicStream(thinkingTurn({ signature: null }), { model: 'm' }))
  assert.equal(finishOf(chunks).replayState, undefined)
  assert.equal('replayState' in finishOf(chunks), false)
})

test('without a model the translator does not pretend it can be replayed', async () => {
  const chunks = await collect(translateAnthropicStream(thinkingTurn(), {}))
  assert.equal(finishOf(chunks).replayState, undefined)
})

test('the envelope keeps a placeholder for a tool call that max-tokens will drop', async () => {
  // 宿主在 max-tokens 时会丢掉工具调用块，然后**按同样的位置**过滤信封：
  // 我们少留一个占位，它就会觉得「块数对不上」把整个信封扔掉。
  const chunks = await collect(
    translateAnthropicStream(thinkingTurn({ stopReason: 'max_tokens', tool: true }), { model: 'm' }),
  )
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'max-tokens')
  assert.deepEqual(finish.replayState.blocks, [
    { type: 'reasoning', signature: 'sig-abc' },
    { type: 'text' },
    { type: 'tool-call' },
  ])

  // 照着宿主的算法重演一遍：块数一样，过滤之后信封里留下的正好是留下的那些块。
  const all = finish.replayState.blocks
  const kept = all.map((block) => block.type !== 'tool-call')
  assert.equal(all.length, 3)
  assert.deepEqual(
    all.filter((_, position) => kept[position]),
    [{ type: 'reasoning', signature: 'sig-abc' }, { type: 'text' }],
  )
})

test('a delta for an index we never saw opened still gets an envelope slot', async () => {
  // 宿主那边是每收到一个带 index 的 chunk 就 ensure(index) 一次。
  // 我们只在 content_block_start 上记账的话，这里就会少一个位置。
  const events = [
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 4, delta: { type: 'thinking_delta', thinking: 'x' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: 'sig-4' } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 4 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
  ]
  const chunks = await collect(translateAnthropicStream(sseResponse(events), { model: 'm' }))
  assert.deepEqual(finishOf(chunks).replayState.blocks, [{ type: 'reasoning', signature: 'sig-4' }])
})

// ---------------------------------------------------------------------------
// Anthropic 线：回放
// ---------------------------------------------------------------------------

test('replay is off by default: the thinking block is dropped, exactly as before', () => {
  const message = assistantWithThinking(
    [{ type: 'reasoning', text: 'let me think' }, { type: 'text', text: 'hi' }],
    makeEnvelope(ANTHROPIC_REPLAY_KIND, 'claude-sonnet-4', [
      { type: 'reasoning', signature: 'sig-abc' },
      { type: 'text' },
    ]),
  )
  const messages = toAnthropicMessages([{ role: 'user', content: [{ type: 'text', text: 'q' }] }, message], {
    cache: false,
  })
  assert.deepEqual(messages[1].content, [{ type: 'text', text: 'hi' }])
})

test('with replay on, the signed thinking block goes back first, in place', () => {
  const message = assistantWithThinking(
    [{ type: 'reasoning', text: 'let me think' }, { type: 'text', text: 'hi' }],
    makeEnvelope(ANTHROPIC_REPLAY_KIND, 'claude-sonnet-4', [
      { type: 'reasoning', signature: 'sig-abc' },
      { type: 'text' },
    ]),
  )
  const messages = toAnthropicMessages([{ role: 'user', content: [{ type: 'text', text: 'q' }] }, message], {
    cache: false,
    replay: true,
  })
  assert.deepEqual(messages[1].content, [
    { type: 'thinking', thinking: 'let me think', signature: 'sig-abc' },
    { type: 'text', text: 'hi' },
  ])
})

test('with replay on but nothing stored, the block is skipped rather than sent unsigned', () => {
  // Anthropic 对「没有签名的 thinking 块」是直接拒的：放一个空签名的块等于
  // 把「这里本来有思考」说给上游听却拿不出证据。
  const message = { role: 'assistant', content: [{ type: 'reasoning', text: 't' }, { type: 'text', text: 'hi' }] }
  const messages = toAnthropicMessages([message], { cache: false, replay: true })
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'hi' }])
})

test('a reasoning block in a user or system message never becomes a thinking block', () => {
  // `thinking` 只允许出现在助手轮里，放错角色就是 400。
  const message = {
    role: 'user',
    content: [{ type: 'reasoning', text: 't' }, { type: 'text', text: 'hi' }],
    source: {
      kind: 'model',
      provider: 'p',
      model: 'm',
      replayState: makeEnvelope(ANTHROPIC_REPLAY_KIND, 'm', [{ type: 'reasoning', signature: 's' }, { type: 'text' }]),
    },
  }
  const messages = toAnthropicMessages([message], { cache: false, replay: true })
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'hi' }])
})

test('a stream round-trips: what the translator stored is what the next turn sends back', async () => {
  const chunks = await collect(translateAnthropicStream(thinkingTurn(), { model: 'claude-sonnet-4' }))
  const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
  const message = assistantWithThinking(blocks, finishOf(chunks).replayState)
  const messages = toAnthropicMessages([{ role: 'user', content: [{ type: 'text', text: 'q' }] }, message], {
    cache: false,
    replay: true,
  })
  assert.deepEqual(messages[1].content, [
    { type: 'thinking', thinking: 'let me think', signature: 'sig-abc' },
    { type: 'text', text: 'hi' },
  ])
})

// ---------------------------------------------------------------------------
// Responses 线
// ---------------------------------------------------------------------------

/** 一条 Responses 风格的事件流：思考项带加密内容，然后一段正文。 */
function responsesTurn({ encrypted = 'enc-blob', stopReason = 'completed', summary = 'thinking', streamSummary = true } = {}) {
  // `null` = 这一项干脆不要那个字段（用默认值的话 `undefined` 会被解构成默认值）。
  const reasoningItem = {
    type: 'reasoning',
    id: 'rs_1',
    ...(encrypted === null ? {} : { encrypted_content: encrypted }),
    ...(summary === null ? {} : { summary: [{ type: 'summary_text', text: summary }] }),
  }
  const events = [
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } } },
    ...(streamSummary
      ? [{ event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1', delta: 'thin' } }]
      : []),
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: reasoningItem } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', delta: 'hi' } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'hi' }] } } },
    { event: stopReason, data: { type: stopReason, response: { usage: { input_tokens: 5, output_tokens: 2 } } } },
  ]
  return sseResponse(events)
}

test('an encrypted reasoning item is recorded when replay is on', async () => {
  const chunks = await collect(translateResponsesStream(responsesTurn(), { model: 'gpt-5-codex', replay: true }))
  assert.deepEqual(finishOf(chunks).replayState, {
    response: { kind: RESPONSES_REPLAY_KIND, version: 1, model: 'gpt-5-codex' },
    blocks: [{ type: 'reasoning', id: 'rs_1', encryptedContent: 'enc-blob' }, { type: 'text' }],
  })
})

test('replay off means the default request and the default stream are untouched', async () => {
  const chunks = await collect(translateResponsesStream(responsesTurn(), { model: 'gpt-5-codex' }))
  assert.equal('replayState' in finishOf(chunks), false)
  // 而且那条记录根本不会被造出来。
  const withEncrypted = await collect(
    translateResponsesStream(responsesTurn({ encrypted: 'enc-blob' }), { model: 'm' }),
  )
  assert.equal(finishOf(withEncrypted).replayState, undefined)
})

test('a reasoning item that carries no summary keeps what was streamed', async () => {
  // 真机上见过：`output_item.done` 的 reasoning 项不带 summary，而收尾块是权威的。
  // 没有这条兜底时，一段刚才已经显示过的思考会在收尾被换成空块。
  const off = await collect(translateResponsesStream(responsesTurn({ encrypted: 'enc-blob', summary: null }), { model: 'm' }))
  assert.deepEqual(off.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [
    { type: 'reasoning', text: 'thin' },
    { type: 'text', text: 'hi' },
  ])

  const on = await collect(translateResponsesStream(responsesTurn({ encrypted: 'enc-blob', summary: null }), { model: 'm', replay: true }))
  assert.deepEqual(on.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [
    { type: 'reasoning', text: 'thin' },
    { type: 'text', text: 'hi' },
  ])
})

test('a reasoning item with no text at all is dropped by default and kept when replaying', async () => {
  // 这是上一条的对照：**一个字都没流过**、`.done` 里也没有 summary，
  // 这时默认丢掉（界面上不该多出一个空的思考块），开着回放才留一个空块
  // 当载体——那是这一轮唯一能把加密状态带回去的东西。
  const onlyEncrypted = responsesTurn({ encrypted: 'enc-blob', summary: null, streamSummary: false })
  const off = await collect(translateResponsesStream(onlyEncrypted, { model: 'm' }))
  assert.deepEqual(off.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [
    { type: 'text', text: 'hi' },
  ])

  const on = await collect(
    translateResponsesStream(responsesTurn({ encrypted: 'enc-blob', summary: null, streamSummary: false }), {
      model: 'm',
      replay: true,
    }),
  )
  assert.deepEqual(on.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [
    { type: 'reasoning', text: '' },
    { type: 'text', text: 'hi' },
  ])
})

test('a reasoning item with no encrypted content never produces an envelope', async () => {
  const chunks = await collect(translateResponsesStream(responsesTurn({ encrypted: null }), { model: 'm', replay: true }))
  assert.equal(finishOf(chunks).replayState, undefined)
})

test('the Responses envelope stays aligned with a block that never got an output_item.done', async () => {
  // 宿主照样会给它 assemble 一个空块（partial 不需要 block-end 也能成形），
  // 所以它在 order 里、也必须在我们信封里占一个位置。
  const events = [
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-blob' } } },
    { event: 'response.reasoning_text.delta', data: { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'rs_1', delta: 'x' } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', delta: 'hi' } },
    { event: 'response.completed', data: { type: 'response.completed', response: { usage: {} } } },
  ]
  const chunks = await collect(translateResponsesStream(sseResponse(events), { model: 'm', replay: true }))
  assert.deepEqual(finishOf(chunks).replayState.blocks, [
    { type: 'reasoning', id: 'rs_1', encryptedContent: 'enc-blob' },
    { type: 'text' },
  ])
})

test('the Responses input puts the reasoning item back before the text it belongs to', () => {
  const message = {
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'thin' }, { type: 'text', text: 'hi' }],
    source: {
      kind: 'model',
      provider: 'acct-codex',
      model: 'gpt-5-codex',
      replayState: makeEnvelope(RESPONSES_REPLAY_KIND, 'gpt-5-codex', [
        { type: 'reasoning', id: 'rs_1', encryptedContent: 'enc-blob' },
        { type: 'text' },
      ]),
    },
  }
  const off = toResponsesInput([message])
  assert.deepEqual(off.input, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }])

  const on = toResponsesInput([message], { replay: true })
  assert.deepEqual(on.input, [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-blob' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  ])
})

test('a stream round-trips on the Responses line too', async () => {
  const chunks = await collect(translateResponsesStream(responsesTurn(), { model: 'gpt-5-codex', replay: true }))
  const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
  const message = {
    role: 'assistant',
    content: blocks,
    source: { kind: 'model', provider: 'acct-codex', model: 'gpt-5-codex', replayState: finishOf(chunks).replayState },
  }
  const { input } = toResponsesInput([message], { replay: true })
  assert.deepEqual(input[0], { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-blob' })
})
