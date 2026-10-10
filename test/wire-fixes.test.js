/**
 * 三个「上游发的是畸形流，而我们会把整条流弄坏」的回归用例。
 *
 * 共同点：错误都不会抛、也不会变慢，只会让宿主把整条流判失败或者把已经交付的东西
 * 记成失败——用户看到的是「这一轮一个字都没有」或者「明明调了工具却报错」。
 * 三条都是独立 review 时用合成流测出来的。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { translateAnthropicStream } from '../src/wire/anthropic.js'
import { translateChatStream } from '../src/wire/chat-completions.js'

/** 造一个只有 body 的假 Response；`readSse` 只认 async iterable。 */
function sseResponse(raw) {
  const body = (async function* generate() {
    yield raw
  })()
  return { ok: true, body }
}

/** 带事件名的 SSE 帧（Anthropic 的形状）。 */
function anthropicSse(events) {
  return sseResponse(events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(''))
}

/** 只发 `data:` 的 SSE 帧（OpenAI 方言的形状）。 */
function chatSse(events) {
  return sseResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 每个开过的块必须恰好关一次——悬空与重复关都是宿主会整条流判失败的事。 */
function assertBalanced(chunks) {
  const counts = new Map()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') counts.set(chunk.index, (counts.get(chunk.index) ?? 0) + 1)
    if (chunk.type === 'block-end') counts.set(chunk.index, (counts.get(chunk.index) ?? 0) - 1)
  }
  for (const [index, delta] of counts) assert.equal(delta, 0, `block ${index} is not balanced`)
}

test('anthropic: a delta with no content_block_start opens the block itself', async () => {
  // 自建中转常常只发 delta。以前这里直接吐 text-delta，宿主报
  // `requires an open text block, got undefined`，整条流作废。
  const chunks = await collect(
    translateAnthropicStream(
      anthropicSse([
        { event: 'message_start', data: { message: { usage: { input_tokens: 5 } } } },
        { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'hi' } } },
        { event: 'content_block_stop', data: { index: 0 } },
        { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
        { event: 'message_stop', data: {} },
      ]),
      { model: 'm' },
    ),
  )
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.equal(chunks[0].blockType, 'text')
  assert.deepEqual(chunks[2].block, { type: 'text', text: 'hi' })
  assertBalanced(chunks)
})

test('anthropic: a content_block_stop for a block that never opened stays silent', async () => {
  // 凭空发一个 block-end 会让宿主报 `block-end index 3 has no open block`。
  const chunks = await collect(
    translateAnthropicStream(
      anthropicSse([
        { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'hi' } } },
        { event: 'content_block_stop', data: { index: 0 } },
        { event: 'content_block_stop', data: { index: 3 } },
        { event: 'message_stop', data: {} },
      ]),
      { model: 'm' },
    ),
  )
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.index), [0])
  assertBalanced(chunks)
})

test('chat-completions: a tool call with no arguments is content, not an empty response', async () => {
  // 零参工具调用（`arguments: ""`）以前会先发完一个合法的 tool-call 块，紧接着被判成
  // 空响应抛 EMPTY_RESPONSE ⇒ 已经交付的工具轮被记成失败、换号、还罚 60 秒。
  const chunks = await collect(
    translateChatStream(
      chatSse([
        {
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '' } }],
              },
              finish_reason: null,
            },
          ],
        },
        { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]),
      { model: 'm' },
    ),
  )
  const blockEnd = chunks.find((chunk) => chunk.type === 'block-end')
  assert.deepEqual(blockEnd.block, { type: 'tool-call', id: 'call_1', name: 'get_time', arguments: '{}' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('chat-completions: a nameless tool shell is still an empty response', async () => {
  // 对照：只有 index 的空壳（上游偶尔先发一个再补名字，但这一轮从头到尾没补）
  // 确实是垃圾，该判空。上面那条放宽不能把这一条也放过。
  await assert.rejects(
    collect(
      translateChatStream(
        chatSse([
          {
            id: 'c2',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { arguments: '' } }] },
                finish_reason: null,
              },
            ],
          },
          { id: 'c2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]),
        { model: 'm' },
      ),
    ),
    (error) => error.code === 'EMPTY_RESPONSE',
  )
})

test('assertApiReply：不是 HTML 的 text/html 错误响应，正文不能被吞掉', async () => {
  // 非 2xx 且 `content-type: text/html` 时我们会把 body 读出来嗅一嗅。看走眼（正文
  // 根本不是网页）之后原样返回，就等于交回一份**已经读空**的响应：调用方随后
  // `.text()` 只会拿到空串，而且五个调用点都写成 `.catch(() => '')` —— 上游到底说了
  // 什么就永久丢了，排障时看到一句「没原因」的 403。
  const { assertApiReply } = await import('../src/wire/assert-reply.js')
  const original = new Response('blocked by the company proxy', {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  const checked = await assertApiReply(original, { who: 'mock' })
  assert.equal(await checked.text(), 'blocked by the company proxy')
  assert.equal(checked.status, 403)
})

test('assertApiReply：真的是网页照旧拒绝', async () => {
  const { assertApiReply } = await import('../src/wire/assert-reply.js')
  const page = new Response('<!DOCTYPE html><html><body>login</body></html>', {
    status: 403,
    headers: { 'content-type': 'text/html' },
  })
  await assert.rejects(assertApiReply(page, { who: 'mock' }), (error) => error.code === 'NOT_AN_API_REPLY')
})
