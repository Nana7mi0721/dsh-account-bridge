// W8 golden 快照的用例表。
//
// 一份 golden 快照不是「测试」，是一条**变更警报**：它把某条翻译线的完整输入输出
// 逐字节钉住。上游加了一个字段、我们把某个分支改了一行、某个默认值翻了面——
// 快照会红，而红的地方就是 diff 本身。
//
// 它与普通单测的分工：单测断言「这条规则成立」，golden 断言「这条线整体没变」。
// 两者都要有——单测能告诉你哪条规则破了，golden 能告诉你**有你没想到的那条也变了**。
//
// 重生成：`UPDATE_GOLDEN=1 node --test test/golden.test.js`
// 重生成之后**必须读一遍 diff**：快照变绿不代表改对了，只代表改成了现在这样。

import { toAnthropicMessages } from '../../src/wire/anthropic.js'
import { translateAnthropicStream } from '../../src/wire/anthropic.js'
import { toChatMessages, translateChatStream } from '../../src/wire/chat-completions.js'
import { toResponsesInput, translateResponsesStream } from '../../src/wire/responses.js'
import { translateGrokStream } from '../../src/wire/grok.js'
import { ANTHROPIC_REPLAY_KIND, RESPONSES_REPLAY_KIND, REPLAY_VERSION } from '../../src/wire/replay.js'

/** 假 SSE 响应：`event:` 行可选，`data:` 行必有。 */
export function sseResponse(events) {
  const body = (async function* generate() {
    for (const event of events) {
      const name = event.event === undefined ? '' : `event: ${event.event}\n`
      yield `${name}data: ${JSON.stringify(event.data)}\n\n`
    }
  })()
  return { ok: true, body }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * 一条共用的会话：system + user（含图片）+ assistant（思考带签名 + 文本 + 工具调用）
 * + 工具结果 + 再一轮 user。
 *
 * 刻意把「每个分支各来一个」塞进同一段对话：快照要能在一次比对里覆盖到它们。
 */
export function conversation() {
  return [
    { role: 'system', content: [{ type: 'text', text: 'You are a helpful agent.' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
      ],
    },
    {
      role: 'assistant',
      model: 'golden-model',
      content: [
        { type: 'reasoning', text: 'Let me look at the bytes.' },
        { type: 'text', text: 'It is a tiny PNG. Let me check the file.' },
        {
          type: 'tool-call',
          id: 'call_golden_1',
          name: 'read_file',
          arguments: '{"path":"a.png"}',
        },
      ],
      source: {
        kind: 'model',
        provider: 'acct-claude',
        model: 'golden-model',
        replayState: {
          response: { kind: ANTHROPIC_REPLAY_KIND, version: REPLAY_VERSION, model: 'golden-model' },
          blocks: [{ type: 'reasoning', signature: 'golden-signature' }, { type: 'text' }, { type: 'tool-call' }],
        },
      },
    },
    { role: 'tool', toolCallId: 'call_golden_1', content: [{ type: 'text', text: 'PNG, 1x1, 68 bytes' }] },
    { role: 'user', content: [{ type: 'text', text: 'Thanks. Anything else?' }] },
  ]
}

/** Responses 线的会话：同一段，但思考带的是 `encryptedContent` 而不是签名。 */
export function responsesConversation() {
  const messages = conversation()
  messages[2].source.replayState = {
    response: { kind: RESPONSES_REPLAY_KIND, version: REPLAY_VERSION, model: 'golden-model' },
    blocks: [
      { type: 'reasoning', id: 'rs_golden_1', encryptedContent: 'golden-encrypted-blob' },
      { type: 'text' },
      { type: 'tool-call' },
    ],
  }
  return messages
}

/** Anthropic 线的一整轮：开场 → 思考（带签名）→ 文本 → 工具调用 → 收尾。 */
export const ANTHROPIC_EVENTS = [
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 1200, cache_read_input_tokens: 1024 } } },
  },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me look' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-1' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'It is a PNG.' } } },
  { event: 'ping', data: { type: 'ping' } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_golden_1', name: 'read_file' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.png"}' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]

/** Chat Completions 线的一整轮：文本 → 思考（方言）→ 工具调用（分片）。 */
export const CHAT_EVENTS = [
  { data: { choices: [{ index: 0, delta: { reasoning_content: 'Thinking about it' } }] } },
  { data: { choices: [{ index: 0, delta: { content: 'It is ' } }] } },
  { data: { choices: [{ index: 0, delta: { content: 'a PNG.' } }] } },
  { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_golden_1', function: { name: 'read_file', arguments: '{"path"' } }] } }] } },
  { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.png"}' } }] } }] } },
  { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
  { data: { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 42 } } },
  { data: '[DONE]' },
]

/** Responses 线的一整轮：思考（加密）→ 文本 → 工具调用 → 收尾。 */
export const RESPONSES_EVENTS = [
  { event: 'response.created', data: { type: 'response.created' } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } } },
  { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1', delta: 'Thinking about it' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking about it' }], encrypted_content: 'golden-encrypted-blob' } } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', delta: 'It is a PNG.' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'It is a PNG.' }] } } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_1', type: 'function_call', call_id: 'call_golden_1', name: 'read_file' } } },
  { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '{"path":"a.png"}' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 2, item: { id: 'fc_1', type: 'function_call', call_id: 'call_golden_1', name: 'read_file', arguments: '{"path":"a.png"}' } } },
  { event: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 42 } } } },
]

/** xAI 的 Responses 线：事件词汇与 OpenAI 相同，关联键不同（靠 item_id）。 */
export const GROK_EVENTS = [
  { event: 'response.created', data: { type: 'response.created' } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { id: 'rs_grok_1', type: 'reasoning' } } },
  { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', item_id: 'rs_grok_1', delta: 'Thinking about it' } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_grok_1', output_index: 1, delta: 'It is a PNG.' } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_grok_1', type: 'function_call', call_id: 'call_golden_1', name: 'read_file' } } },
  { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_grok_1', delta: '{"path":"a.png"}' } },
  { event: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 42 } } } },
]

/**
 * 用例表：`名字 → {dir, run}`。
 *
 * 名字就是快照文件名（`test/golden/<dir>/<名字>.json`），`dir` 分请求线与流线两栏——
 * 请求线的快照是「发出去的那一坨 JSON」，流线的快照是「吐出来的 chunk 数组」。
 */
export const CASES = {
  request: {
    'dsh_to_anthropic': () => toAnthropicMessages(conversation(), { cache: true, replay: true }),
    'dsh_to_anthropic_no_replay': () => toAnthropicMessages(conversation(), { cache: false }),
    'dsh_to_chat_completions': () => toChatMessages(conversation()),
    'dsh_to_responses': () => toResponsesInput(responsesConversation(), { replay: true }),
  },
  stream: {
    'anthropic_to_dsh': () =>
      collect(translateAnthropicStream(sseResponse(ANTHROPIC_EVENTS), { model: 'golden-model' })),
    'chat_completions_to_dsh': () => collect(translateChatStream(sseResponse(CHAT_EVENTS))),
    'responses_to_dsh': () =>
      collect(translateResponsesStream(sseResponse(RESPONSES_EVENTS), { model: 'golden-model', replay: true })),
    'grok_to_dsh': () => collect(translateGrokStream(sseResponse(GROK_EVENTS))),
  },
}
