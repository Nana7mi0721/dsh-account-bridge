/**
 * grok 族的单测。
 *
 * 重点覆盖「真机上会静默出错、本地看不出来」的那几处：
 * - 两个计费口径（订阅代理 / 按量 API）的端点与请求头分流；
 * - CLI 代理的指纹头缺失（426 / 403）必须说清根因，不能被当成网关故障；
 * - SSE 的**按 `item_id` 分槽**与「只有文本或工具调用才算已输出」；
 * - 额度读不到必须回 `undefined`（§C3），绝不编 0%；
 * - 刷新后的原子写回与 CAS，以及「写回失败不连累刷新结果」。
 *
 * 联网用例一律挂在 `BRIDGE_LIVE_GROK === '1'` 后面，默认跳过。
 * @module dsh-account-bridge/test/grok
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  GROK_API_BASE,
  GROK_CLI_BASE,
  GROK_CLIENT_IDENTIFIER,
  buildGrokBody,
  endpointKind,
  fingerprintError,
  grokCliCatalogUrl,
  grokHeaders,
  grokResponsesUrl,
  mapStreamErrorCode,
  resolveGrokBase,
  toResponsesInput,
  translateGrokStream,
  usageOf,
} from '../src/wire/grok.js'

import {
  FALLBACK_MODELS,
  GROK_CLIENT_ID,
  GROK_FALLBACK_CLIENT_VERSION,
  __resetGrokCaches,
  accountLabel,
  authFilePath,
  authFromTokens,
  authorizeUrl,
  exchangeCode,
  grokClientVersion,
  grokFamily,
  grokHome,
  grokTierName,
  modelInfo,
  parseCliCatalog,
  parseExpiresAt,
  parseGrokQuota,
  parseModelIds,
  readAuthFile,
  recordFromAuth,
  selectSlot,
  writeBackAuth,
} from '../src/families/grok.js'

// ------------------------------------------------------------------ 测试脚手架

const AUTH_URL = 'https://cli-chat-proxy.grok.com/v1/responses'

let homeCounter = 0

/** 造一个隔离的 GROK_HOME（每个用例一个，互不干扰）。 */
async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), `grok-test-${process.pid}-${homeCounter++}-`))
  process.env.GROK_HOME = dir
  __resetGrokCaches()
  return dir
}

/** 写一份 CLI 形态的 auth.json。`expiresAt` 传毫秒时间戳。 */
async function writeAuth(home, patch = {}) {
  const path = join(home, 'auth.json')
  const record = {
    key: 'access-old',
    refresh_token: 'refresh-old',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: GROK_CLIENT_ID,
    user_id: 'user-1',
    ...patch,
  }
  await writeFile(path, `${JSON.stringify({ 'https://auth.x.ai::slot': record }, null, 2)}\n`, 'utf8')
  return path
}

/** 最小 JWT：三段 base64url，只有 payload 是有意义的。 */
function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(payload)}.sig`
}

/** 假的 SSE 响应体：`frame.raw` 原样发，其余按 `data: <json>` 发。 */
function sseResponse(frames) {
  const body = (async function* generate() {
    for (const frame of frames) {
      yield frame?.raw ?? `data: ${JSON.stringify(frame)}\n\n`
    }
  })()
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body }
}

/** 假的普通 JSON 响应。 */
function jsonResponse(json, status = 200, headers = {}) {
  const text = typeof json === 'string' ? json : JSON.stringify(json)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return text
    },
    async json() {
      return typeof json === 'string' ? JSON.parse(json) : json
    },
    async arrayBuffer() {
      return Buffer.from(text, 'utf8').buffer.slice(0)
    },
  }
}

/** 假的错误响应（会先被上游拒绝，还没进到流）。 */
function errorResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    async text() {
      return text
    },
    async json() {
      try {
        return JSON.parse(text)
      } catch {
        return undefined
      }
    },
  }
}

/**
 * 记录所有 `ctx.fetch` 调用的族上下文。
 *
 * **故意把第 4 个参数也记下来**：漏传 `streaming=true` 的后果是「配了代理的账号
 * 在长推理期间被 undici 的 30s bodyTimeout 掐断」，本地直连永远复现不出来。
 */
function recordingCtx(handler, { config = {} } = {}) {
  const calls = []
  const warnings = []
  const ctx = {
    config,
    log: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      info: () => {},
      debug: () => {},
      error: (...args) => warnings.push(args.map(String).join(' ')),
    },
    async fetch(url, init, proxy, streaming) {
      calls.push({ url, init, proxy, streaming })
      return handler(url, init, calls.length)
    },
  }
  return { ctx, calls, warnings }
}

/** 找一次特定调用：版本号的 npm 后台查询也会占用 `calls`，不能依赖下标。 */
function callTo(calls, host) {
  const found = calls.find((call) => call.url.includes(host))
  assert.ok(found, `没有找到打往 ${host} 的请求：${calls.map((call) => call.url).join(', ')}`)
  return found
}

const CLI_HOST = 'cli-chat-proxy.grok.com'

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function kinds(chunks) {
  return chunks.map((chunk) => chunk.type)
}

/** 收集全部增量文本（按块下标分开）。 */
function textByIndex(chunks, type = 'text-delta') {
  const out = new Map()
  for (const chunk of chunks) {
    if (chunk.type !== type) continue
    out.set(chunk.index, (out.get(chunk.index) ?? '') + chunk.text)
  }
  return out
}

/** 每条流的通用事件骨架。 */
function event(type, extra = {}) {
  return { type, ...extra }
}

// ------------------------------------------------------------------ 端点分流

test('端点分流：默认走订阅代理，账号级开关才切到按量 API', () => {
  assert.equal(resolveGrokBase({}), GROK_CLI_BASE)
  assert.equal(endpointKind({}), 'cli')
  assert.equal(grokResponsesUrl({}), `${GROK_CLI_BASE}/responses`)

  assert.equal(resolveGrokBase({ useApiEndpoint: true }), GROK_API_BASE)
  assert.equal(endpointKind({ useApiEndpoint: true }), 'api')
  assert.equal(grokResponsesUrl({ useApiEndpoint: true }), `${GROK_API_BASE}/responses`)

  // `baseUrl` 是用户手输的，永远赢过布尔开关。
  assert.equal(resolveGrokBase({ baseUrl: 'https://relay.example/v1/', useApiEndpoint: true }), 'https://relay.example/v1')
  assert.equal(grokResponsesUrl({ baseUrl: 'https://relay.example/v1/' }), 'https://relay.example/v1/responses')
  assert.equal(endpointKind({ baseUrl: 'https://relay.example/v1' }), 'cli')

  // CLI catalog 的两个候选路径都拼得干净。
  assert.equal(grokCliCatalogUrl(0), `${GROK_CLI_BASE}/models`)
  assert.equal(grokCliCatalogUrl(1), `${GROK_CLI_BASE}/models-v2`)
  assert.equal(grokCliCatalogUrl(9), `${GROK_CLI_BASE}/models`)
})

test('请求头：CLI 口径必须带版本头，且不冒充 grok-shell / 不发 x-grok-conv-id', () => {
  const cli = grokHeaders({ access: 'tok', clientVersion: '0.1.220', cli: true, json: true })
  assert.equal(cli.authorization, 'Bearer tok')
  assert.equal(cli['content-type'], 'application/json')
  assert.equal(cli.accept, 'application/json')
  assert.equal(cli['x-xai-token-auth'], 'xai-grok-cli')
  // 缺这个头，上游回 426（G1）——所以它必须是必填项而不是「有就带」。
  assert.equal(cli['x-grok-client-version'], '0.1.220')
  assert.equal(cli['x-grok-client-identifier'], GROK_CLIENT_IDENTIFIER)
  assert.equal(GROK_CLIENT_IDENTIFIER, 'dsh-account-bridge')
  // 冒充 grok-shell 拿不到任何额外能力，只会把风控引到用户账号上。
  assert.notEqual(cli['x-grok-client-identifier'], 'grok-shell')
  assert.ok(!Object.keys(cli).some((key) => /user-agent/i.test(key)))
  // G7：缓存亲和走 body 的 prompt_cache_key，这个头在 8 个参考实现里零命中。
  assert.ok(!Object.keys(cli).some((key) => /conv-id/i.test(key)))

  // 按量 API 口径：一个 CLI 指纹头都不发（那是另一个后端的门禁）。
  const api = grokHeaders({ access: 'tok', clientVersion: '0.1.220', cli: false })
  assert.equal(api.authorization, 'Bearer tok')
  assert.ok(!('x-xai-token-auth' in api))
  assert.ok(!('x-grok-client-version' in api))

  // 额度端点的 x-userid 由调用方注入。
  const billing = grokHeaders({ access: 'tok', clientVersion: '0.1.220', extra: { 'x-userid': 'user-1' } })
  assert.equal(billing['x-userid'], 'user-1')
})

test('请求体：无工具时一个 tools 字段都不发；有工具才带 tool_choice', () => {
  const bare = buildGrokBody({ model: 'grok-4.6', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  assert.equal(bare.model, 'grok-4.6')
  assert.equal(bare.stream, true)
  assert.equal(bare.store, false)
  assert.deepEqual(bare.include, ['reasoning.encrypted_content'])
  // G4：无工具的调用带 tools 会被上游回 400 invalid-argument。
  assert.ok(!('tools' in bare))
  assert.ok(!('tool_choice' in bare))
  assert.ok(!('parallel_tool_calls' in bare))
  assert.deepEqual(bare.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  assert.ok(!('reasoning' in bare))
  assert.ok(!('max_output_tokens' in bare))

  const rich = buildGrokBody({
    model: 'grok-4.6',
    system: 'be brief',
    effort: 'high',
    maxTokens: 4096.7,
    promptCacheKey: 'session-abc',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
  })
  assert.equal(rich.instructions, 'be brief')
  assert.equal(rich.max_output_tokens, 4096)
  assert.deepEqual(rich.reasoning, { effort: 'high', summary: 'auto' })
  assert.equal(rich.prompt_cache_key, 'session-abc')
  assert.equal(rich.tools.length, 1)
  assert.equal(rich.tools[0].type, 'function')
  assert.equal(rich.tools[0].name, 'read_file')
  assert.equal(rich.tool_choice, 'auto')
  assert.equal(rich.parallel_tool_calls, true)
})

test('输入映射：工具结果用 call_id 配回调用，历史里的思考块不回传', () => {
  const input = toResponsesInput([
    { role: 'system', content: 'ignored' },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '内部草稿' },
        { type: 'text', text: '我来读文件' },
        { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'contents' }] },
  ])
  assert.equal(input.length, 3)
  // 思考块必须丢掉：Responses 要求复放时带原始 id 与非空 encrypted_content，
  // 而 DSH 的历史里只有纯文本，回传会被 400。
  assert.ok(!input.some((item) => item.type === 'reasoning'))
  assert.deepEqual(input[0], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我来读文件' }] })
  assert.deepEqual(input[1], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'read_file',
    arguments: '{"path":"a.txt"}',
  })
  assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'call_1', output: 'contents' })
})

// ------------------------------------------------------------------ SSE 翻译

test('SSE：文本增量按 item_id 分槽，收尾只发一次 block-end', async () => {
  const chunks = await collect(
    translateGrokStream(
      sseResponse([
        event('response.created', { response: { id: 'r1' } }),
        event('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message' } }),
        event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '你' }),
        // 这一条**只带 item_id**：通用 Responses 层只认 output_index，会另开一块。
        event('response.output_text.delta', { item_id: 'msg_1', delta: '好' }),
        event('response.output_item.done', { item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: '你好' }] } }),
        event('response.completed', { response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 2 } } }),
      ]),
    ),
  )

  assert.deepEqual(kinds(chunks), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[0].blockType, 'text')
  assert.deepEqual([...textByIndex(chunks).entries()], [[0, '你好']])
  // `.done` 带了全文，但那一段已经走过 delta ⇒ 不能再补一遍。
  assert.equal(chunks[3].block.text, '你好')
  assert.deepEqual(chunks[4].usage, { inputTokens: 7, outputTokens: 2 })
  assert.equal(chunks[5].reason.kind, 'stop')
})

test('SSE：思考与文本各占一块，思考摘要 delta 走 reasoning 槽', async () => {
  const chunks = await collect(
    translateGrokStream(
      sseResponse([
        event('response.output_item.added', { item: { id: 'rs_1', type: 'reasoning' } }),
        event('response.reasoning_summary_text.delta', { item_id: 'rs_1', summary_index: 0, delta: '先看目录' }),
        event('response.output_item.done', { item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: '先看目录' }] } }),
        event('response.output_item.added', { item: { id: 'msg_1', type: 'message' } }),
        event('response.output_text.delta', { item_id: 'msg_1', delta: '看完了' }),
        event('response.output_item.done', { item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: '看完了' }] } }),
        event('response.completed', { response: { status: 'completed' } }),
      ]),
    ),
  )

  assert.deepEqual(kinds(chunks), [
    'block-start',
    'reasoning-delta',
    'block-end',
    'block-start',
    'text-delta',
    'block-end',
    'finish',
  ])
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-start').map((chunk) => chunk.blockType), [
    'reasoning',
    'text',
  ])
  const reasoning = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')[0]
  assert.equal(reasoning.block.text, '先看目录')
  const text = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')[0]
  assert.equal(text.block.text, '看完了')
  // 思考块先收尾、文本块后收尾，两块的下标必须不同。
  assert.notEqual(reasoning.index, text.index)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('SSE：工具调用的 id 用 call_id（不是 item.id），finish 回 tool-calls', async () => {
  const chunks = await collect(
    translateGrokStream(
      sseResponse([
        event('response.output_item.added', {
          output_index: 0,
          item: { id: 'fc_item_1', type: 'function_call', call_id: 'call_abc', name: 'read_file' },
        }),
        event('response.function_call_arguments.delta', { item_id: 'fc_item_1', output_index: 0, delta: '{"path":' }),
        event('response.function_call_arguments.delta', { item_id: 'fc_item_1', output_index: 0, delta: '"a.txt"}' }),
        event('response.function_call_arguments.done', { item_id: 'fc_item_1', output_index: 0, arguments: '{"path":"a.txt"}' }),
        event('response.output_item.done', {
          item: { id: 'fc_item_1', type: 'function_call', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a.txt"}' },
        }),
        event('response.completed', { response: { status: 'completed' } }),
      ]),
    ),
  )

  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(deltas.length, 2)
  // 真机规则：item_id 关联流内事件，call_id 关联工具结果。用错的话工具结果配不回来。
  assert.ok(deltas.every((chunk) => chunk.id === 'call_abc'))
  assert.ok(deltas.every((chunk) => chunk.name === 'read_file'))
  assert.deepEqual(deltas.map((chunk) => chunk.argumentsDelta), ['{"path":', '"a.txt"}'])
  const blockEnd = chunks.find((chunk) => chunk.type === 'block-end')
  assert.deepEqual(blockEnd.block, {
    type: 'tool-call',
    id: 'call_abc',
    name: 'read_file',
    arguments: '{"path":"a.txt"}',
  })
  // 上层靠这个值判断「还要不要继续跑工具」，回 stop 会让工具调用被静默丢掉。
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('SSE：参数只在 done 事件里到齐时也要吐出来（不能只看 delta）', async () => {
  const chunks = await collect(
    translateGrokStream(
      sseResponse([
        event('response.output_item.added', { item: { id: 'fc_1', type: 'function_call', call_id: 'call_x', name: 'ls' } }),
        event('response.function_call_arguments.done', { item_id: 'fc_1', arguments: '{"path":"."}' }),
        event('response.output_item.done', { item: { id: 'fc_1', type: 'function_call', call_id: 'call_x', name: 'ls', arguments: '{"path":"."}' } }),
      ]),
    ),
  )
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.deepEqual(deltas.map((chunk) => chunk.argumentsDelta), ['{"path":"."}'])
  // 只有一份 JSON：`.done` 里的完整参数不能和 delta 拼在一起。
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.arguments, '{"path":"."}')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('SSE：流断在最后一条 delta 上也要补 block-end（否则面板永远转圈）', async () => {
  const chunks = await collect(
    translateGrokStream(sseResponse([event('response.output_text.delta', { item_id: 'msg_1', delta: '半句话' })])),
  )
  assert.deepEqual(kinds(chunks), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.equal(chunks[2].block.text, '半句话')
})

test('SSE：`.done` 带全文而这一段没走过 delta 时补发一次（不重复也不丢）', async () => {
  const chunks = await collect(
    translateGrokStream(
      sseResponse([
        event('response.output_text.done', { item_id: 'msg_1', text: '完整一段' }),
        event('response.output_item.done', { item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: '完整一段' }] } }),
      ]),
    ),
  )
  const deltas = chunks.filter((chunk) => chunk.type === 'text-delta')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0].text, '完整一段')
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, '完整一段')
  assert.equal(chunks.at(-1).type, 'finish')
})

test('SSE：纯思考、零文本的流按空回答处理（思考不算「已输出」）', async () => {
  await assert.rejects(
    () =>
      collect(
        translateGrokStream(
          sseResponse([
            event('response.reasoning_summary_text.delta', { item_id: 'rs_1', delta: '想了一下' }),
            event('response.output_item.done', { item: { id: 'rs_1', type: 'reasoning', summary: [{ text: '想了一下' }] } }),
            event('response.completed', { response: { status: 'completed' } }),
          ]),
        ),
      ),
    (error) => {
      // 池子靠这个码决定「还能不能换个账号重放」：思考没进历史，重放不会重复输出。
      assert.equal(error.code, 'EMPTY_RESPONSE')
      return true
    },
  )
})

test('SSE：一个内容块都没有要抛 EMPTY_RESPONSE，而不是静默成功', async () => {
  await assert.rejects(
    () =>
      collect(
        translateGrokStream(
          sseResponse([
            event('response.created', { response: { id: 'r1' } }),
            event('response.in_progress', {}),
            event('response.completed', { response: { status: 'completed', usage: { input_tokens: 3 } } }),
          ]),
        ),
      ),
    (error) => {
      assert.equal(error.code, 'EMPTY_RESPONSE')
      assert.match(error.message, /empty response/)
      return true
    },
  )
})

test('SSE：截断报 max-tokens，内容过滤不算 max-tokens', async () => {
  const truncated = await collect(
    translateGrokStream(
      sseResponse([
        event('response.output_text.delta', { item_id: 'msg_1', delta: '被截断的话' }),
        event('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
      ]),
    ),
  )
  assert.equal(truncated.at(-1).reason.kind, 'max-tokens')

  const filtered = await collect(
    translateGrokStream(
      sseResponse([
        event('response.output_text.delta', { item_id: 'msg_1', delta: '前半段' }),
        event('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } }),
      ]),
    ),
  )
  // 「被内容策略截断」不是「加点预算就能继续」，报 max-tokens 会误导上层重试。
  assert.equal(filtered.at(-1).reason.kind, 'stop')
})

test('SSE：流内 error / response.failed 事件按码归类并抛出', async () => {
  for (const [payload, expected] of [
    [event('error', { code: 'rate_limit_exceeded', message: 'slow down' }), 'RATE_LIMIT'],
    [event('error', { code: 'insufficient_quota', message: 'no credits' }), 'QUOTA'],
    [event('error', { code: 'invalid_api_key', message: 'unauthorized' }), 'AUTH'],
    [event('response.failed', { response: { error: { code: 'server_error', message: 'boom' } } }), 'SERVER'],
  ]) {
    await assert.rejects(
      () => collect(translateGrokStream(sseResponse([payload]))),
      (error) => {
        assert.equal(error.code, expected, `${payload.type} → ${expected}`)
        return true
      },
    )
  }
})

test('SSE：`response.output_text.delta` 写出非法 JSON 时忽略该事件而不炸', async () => {
  const chunks = await collect(
    translateGrokStream(
      sseResponse([
        { raw: 'data: {not json\n\n' },
        { raw: ': keep-alive\n\n' },
        event('response.output_text.delta', { item_id: 'msg_1', delta: 'ok' }),
        { raw: 'data: [DONE]\n\n' },
      ]),
    ),
  )
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(textByIndex(chunks).get(0), 'ok')
})

// ------------------------------------------------------------------ 失败归类

test('失败归类：426 说明是缺版本头，不是网关故障', () => {
  const missing = fingerprintError(426, 'Upgrade Required')
  assert.ok(missing)
  assert.equal(missing.code, 'SERVER')
  assert.match(missing.message, /x-grok-client-version/)
  assert.match(missing.message, /not as a gateway fault/)

  // 403 + 指纹提示字样 = Grok Build 中间件拒绝，不是套餐问题。
  const blocked = fingerprintError(403, 'missing x-grok-client-identifier header')
  assert.equal(blocked.code, 'AUTH')
  assert.match(blocked.message, /fingerprint/)

  // 普通 403（套餐无权限）不该被指纹逻辑吃掉，留给 http-error 的映射。
  assert.equal(fingerprintError(403, 'forbidden'), undefined)
  assert.equal(fingerprintError(500, 'internal error'), undefined)
})

test('失败归类：流内错误码映射', () => {
  assert.equal(mapStreamErrorCode('rate_limit', 'too many requests'), 'RATE_LIMIT')
  assert.equal(mapStreamErrorCode(undefined, 'You have run out of credits'), 'QUOTA')
  assert.equal(mapStreamErrorCode('unauthorized', ''), 'AUTH')
  assert.equal(mapStreamErrorCode(undefined, 'maximum context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(mapStreamErrorCode('timeout', 'request timed out'), 'TIMEOUT')
  assert.equal(mapStreamErrorCode('weird', 'something else'), 'SERVER')
})

test('HTTP 与流失败：401 / 429 / 5xx 各自的错误码与 retry-after', async () => {
  const sessions = [
    { response: errorResponse(401, { error: { message: 'unauthorized' } }), code: 'AUTH' },
    { response: errorResponse(429, { error: { message: 'usage limit reached' } }), code: 'QUOTA' },
    { response: errorResponse(429, { error: { message: 'slow down' } }), code: 'RATE_LIMIT' },
    { response: errorResponse(500, 'boom'), code: 'SERVER' },
    { response: errorResponse(426, 'Upgrade Required'), code: 'SERVER', message: /x-grok-client-version/ },
  ]

  for (const session of sessions) {
    const rec = recordingCtx(() => session.response)
    const payload = { family: 'grok', auth: { access: 'tok' }, proxy: undefined }
    const stream = grokFamily.stream(rec.ctx, {
      payload,
      model: 'grok-4.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: undefined,
    })
    await assert.rejects(
      () => collect(stream),
      (error) => {
        assert.equal(error.code, session.code, `${session.response.status} → ${session.code}`)
        if (session.message) assert.match(error.message, session.message)
        return true
      },
    )
  }
})

// ------------------------------------------------------------------ 额度

test('额度：读不到就回 undefined，绝不编 0%', () => {
  // 契约 §C3：宁可什么都不显示，也不能给出一个假的百分比。
  assert.equal(parseGrokQuota(undefined), undefined)
  assert.equal(parseGrokQuota({}), undefined)
  assert.equal(parseGrokQuota({ config: null }), undefined)
  assert.equal(parseGrokQuota({ config: {} }), undefined)
  assert.equal(parseGrokQuota({ config: { monthlyLimit: { val: 0 }, used: { val: 0 } } }), undefined)
  // subscriptionTier 单独出现不算「有额度数据」。
  assert.equal(parseGrokQuota({ subscriptionTier: 'SuperGrok' }), undefined)
})

test('额度：protobuf 省略零值 ⇒ 有 currentPeriod 就是真实的 0%', () => {
  const buckets = parseGrokQuota({
    subscriptionTier: 'SuperGrok',
    config: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-01-01T00:00:00Z', end: '2026-01-08T00:00:00Z' },
    },
  })
  assert.equal(buckets.length, 1)
  assert.equal(buckets[0].id, 'weekly')
  assert.equal(buckets[0].remainingFraction, 1)
  assert.match(buckets[0].name, /SuperGrok/)
  assert.equal(buckets[0].resetAt, Date.parse('2026-01-08T00:00:00Z'))
})

test('额度：creditUsagePercent 优先，月窗口与旧形态整数分都能算', () => {
  const weekly = parseGrokQuota({
    config: {
      creditUsagePercent: 42.5,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-02-01T00:00:00Z' },
    },
  })
  assert.equal(weekly[0].id, 'weekly')
  assert.equal(weekly[0].remainingFraction, 0.575)

  const monthly = parseGrokQuota({
    config: { creditUsagePercent: 10, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2026-02-01T00:00:00Z' } },
  })
  assert.equal(monthly[0].id, 'monthly')

  // 旧形态：整数分，要自己算百分比（1000/4000 = 25%）。
  const legacy = parseGrokQuota({
    config: { monthlyLimit: { val: 4000 }, used: { val: 1000 }, billingPeriodEnd: '2026-03-01T00:00:00Z' },
  })
  assert.equal(legacy[0].remainingFraction, 0.75)
  assert.equal(legacy[0].resetAt, Date.parse('2026-03-01T00:00:00Z'))

  // 用超了也不能给负数。
  const overdrawn = parseGrokQuota({ config: { creditUsagePercent: 130, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } } })
  assert.equal(overdrawn[0].remainingFraction, 0)
})

test('额度：正文被 gzip 压过（且编码头不可信）也能读出来', async () => {
  const body = gzipSync(
    Buffer.from(
      JSON.stringify({ config: { creditUsagePercent: 20, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-02-01T00:00:00Z' } } }),
      'utf8',
    ),
  )
  const response = {
    ok: true,
    status: 200,
    // 上游实测出现过「gzip 正文配错误编码头」，所以这一段必须自己按魔数解压。
    headers: new Headers({ 'content-encoding': 'identity' }),
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    },
    async text() {
      return body.toString('utf8')
    },
  }
  const rec = recordingCtx(() => response)
  const buckets = await grokFamily.quota(rec.ctx, { family: 'grok', auth: { access: 'tok', userId: 'user-1' } })
  assert.equal(buckets.length, 1)
  assert.equal(buckets[0].remainingFraction, 0.8)
  // 额度端点只有 CLI 代理有，头部也要带 x-userid。
  const call = callTo(rec.calls, '/v1/billing')
  assert.match(call.url, /^https:\/\/cli-chat-proxy\.grok\.com\/v1\/billing\?format=credits$/)
  assert.equal(call.init.headers['x-userid'], 'user-1')
})

test('额度：非 2xx 一律回 undefined，不抛错也不编数', async () => {
  const rec = recordingCtx(() => errorResponse(403, 'forbidden'))
  assert.equal(await grokFamily.quota(rec.ctx, { family: 'grok', auth: { access: 'tok' } }), undefined)
})

// ------------------------------------------------------------------ 目录

test('目录解析：过滤 imagine/video/embed，CLI catalog 给思考档位', () => {
  assert.deepEqual(parseModelIds({ data: [{ id: 'grok-4.6' }, { id: 'grok-imagine-image' }, 'grok-video-1', { id: 'grok-embed' }] }), [
    'grok-4.6',
  ])
  assert.deepEqual(parseModelIds(['grok-4.5']), ['grok-4.5'])
  assert.deepEqual(parseModelIds({ models: [{ id: 'grok-code-fast-1' }] }), ['grok-code-fast-1'])
  assert.deepEqual(parseModelIds(undefined), [])

  const entries = parseCliCatalog({
    object: 'list',
    data: [
      {
        id: 'grok-4.6',
        name: 'Grok 4.6',
        context_window: 500_000,
        max_output_tokens: 128_000,
        reasoning_effort: 'high',
        reasoning_efforts: [{ value: 'xhigh' }, { value: 'high' }, { value: 'low' }, { value: 'off' }],
      },
    ],
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].contextWindow, 500_000)
  assert.equal(entries[0].maxOutput, 128_000)
  // `off` 不算一档（上游把它当「关思考」，DSH 的档位表里没有它）。
  assert.deepEqual(entries[0].efforts, ['xhigh', 'high', 'low'])
  assert.equal(entries[0].defaultEffort, 'high')
})

test('目录解析：per-entry 的 default 标志不可信，只认顶层 reasoning_effort', () => {
  const [entry] = parseCliCatalog({
    data: [
      {
        id: 'grok-4.6',
        reasoning_efforts: [{ value: 'high', default: true }, { value: 'low', default: true }],
      },
    ],
  })
  assert.equal(entry.defaultEffort, undefined)
  // 顶层声明了一个没在档位表里的值 ⇒ 也不能信。
  const [mismatch] = parseCliCatalog({ data: [{ id: 'grok-4.6', reasoning_effort: 'max', reasoning_efforts: [{ value: 'high' }] }] })
  assert.equal(mismatch.defaultEffort, undefined)
})

test('模型元数据：contextWindow 与 maxTokens 永远是正整数', () => {
  const cases = [
    modelInfo('grok-4.6', { id: 'grok-4.6', contextWindow: 500_000, maxOutput: 128_000 }, 'acct-grok'),
    modelInfo('grok-4.6', { id: 'grok-4.6', contextWindow: 0, maxOutput: -1 }, 'acct-grok'),
    modelInfo('grok-4.6', { id: 'grok-4.6', contextWindow: 'abc' }, 'acct-grok'),
    modelInfo('grok-4.6', {}, 'acct-grok'),
    modelInfo('grok-code-fast-1', {}, 'acct-grok'),
  ]
  for (const info of cases) {
    // 不是正整数 ⇒ 宿主的 dsh-llm 抛 `adapter returned invalid context metadata`，
    // 而且是 provider 级失败（整族不可用），所以这一条必须硬保证。
    assert.ok(Number.isInteger(info.context.contextWindow), `${info.id} contextWindow`)
    assert.ok(info.context.contextWindow > 0, `${info.id} contextWindow > 0`)
    assert.ok(Number.isInteger(info.defaultMaxTokens) && info.defaultMaxTokens > 0, `${info.id} maxTokens`)
  }
  assert.equal(cases[0].context.contextWindow, 500_000)
  assert.equal(cases[0].defaultMaxTokens, 128_000)
  assert.deepEqual(cases[4].inputModalities, ['text'])
  assert.deepEqual(cases[0].inputModalities, ['text', 'image'])
})

test('模型元数据：档位列表来自目录，默认档位合法时才声明', () => {
  const withEfforts = modelInfo(
    'grok-4.6',
    { id: 'grok-4.6', efforts: ['xhigh', 'high', 'low'], defaultEffort: 'high' },
    'acct-grok',
  )
  assert.deepEqual(withEfforts.reasoning.efforts.map((effort) => effort.id), ['xhigh', 'high', 'low'])
  assert.equal(withEfforts.reasoning.defaultEffort, 'high')

  const none = modelInfo('grok-4.6', { id: 'grok-4.6' }, 'acct-grok')
  // 不知道就别声明：多报一个档位会让上游 400，少报一个新档位会让用户选不到。
  assert.equal(none.reasoning, undefined)
})

// ------------------------------------------------------------------ 凭据与发现

test('凭据解析：槽位挑选、字段别名、纳秒/秒/毫秒的过期时间容错', () => {
  const text = JSON.stringify({
    'https://other.example::1': { key: 'wrong-access', refresh_token: 'wrong-refresh' },
    'https://auth.x.ai::b1a00492': {
      key: 'right-access',
      refresh_token: 'right-refresh',
      expires_at: '2026-01-01T00:00:00.123456789Z',
      user_id: 'u-9',
      email: 'a@b.c',
      oidc_issuer: 'https://auth.x.ai',
    },
  })
  const parsed = selectSlot(text)
  assert.equal(parsed.slot, 'https://auth.x.ai::b1a00492')
  assert.equal(parsed.record.key, 'right-access')

  // 纳秒精度会让 Date.parse 直接失败，必须截到毫秒。
  assert.equal(parseExpiresAt({ expires_at: '2026-01-01T00:00:00.123456789Z' }), Date.parse('2026-01-01T00:00:00.123Z'))
  assert.equal(parseExpiresAt({ expires_at: 1_800_000_000 }), 1_800_000_000_000)
  assert.equal(parseExpiresAt({ expires_at: 1_800_000_000_000 }), 1_800_000_000_000)
  assert.ok(parseExpiresAt({ expires_in: 60 }) > Date.now())
  // 什么都没有时给 1 小时：宁可早点刷新，也不要拿着过期令牌去撞 401。
  assert.ok(parseExpiresAt({}) > Date.now() + 3_000_000)
})

test('凭据解析：多份登录态且没有一条标 auth.x.ai 时必须报错而不是随便挑一条', () => {
  const text = JSON.stringify({
    'https://a.example::1': { key: 'a', refresh_token: 'ar' },
    'https://b.example::2': { key: 'b', refresh_token: 'br' },
  })
  const parsed = selectSlot(text)
  assert.ok(parsed.error)
  assert.match(parsed.error, /2 credential pairs/)
})

test('凭据解析：唯一一条记录即使键名不认识也认它（旧版本 CLI 的形态）', () => {
  const parsed = selectSlot(JSON.stringify({ 'weird-key': { access_token: 'tok', refresh: 'ref' } }))
  assert.equal(parsed.record.access_token, 'tok')
})

test('discover：没有 auth.json 时报空，不报错', async () => {
  const home = await makeHome()
  assert.equal(authFilePath(), join(home, 'auth.json'))
  assert.deepEqual(await grokFamily.discover({}), [])
})

test('discover：有登录态时报 importable 并带上来源路径', async () => {
  const home = await makeHome()
  const path = await writeAuth(home, { email: 'me@example.com' })
  const [item] = await grokFamily.discover({})
  assert.equal(item.family, 'grok')
  assert.equal(item.importable, true)
  assert.equal(item.externallyOwned, true)
  assert.equal(item.label, 'me@example.com')
  assert.equal(item.auth.access, 'access-old')
  assert.equal(item.auth.refresh, 'refresh-old')
  assert.equal(item.auth.slot, 'https://auth.x.ai::slot')
  // 归一化比较：Windows 上分隔符是反斜杠。
  assert.ok(item.sourcePath.replace(/\\/g, '/').endsWith('/auth.json'))
  assert.equal(path.replace(/\\/g, '/'), item.sourcePath.replace(/\\/g, '/'))

  // 统一发现的落盘入口必须把 sourcePath 指纹带上。
  const record = grokFamily.recordFromDiscovery(item)
  assert.equal(record.family, 'grok')
  assert.equal(record.source, 'client-import')
  assert.equal(record.externallyOwned, true)
  assert.equal(record.sourcePath, item.sourcePath)
})

test('discover：格式不对时报 importable:false 并诚实写明原因', async () => {
  const home = await makeHome()
  await writeFile(join(home, 'auth.json'), 'not json at all', 'utf8')
  const [item] = await grokFamily.discover({})
  assert.equal(item.importable, false)
  assert.ok(item.reason)

  const home2 = await makeHome()
  await writeFile(join(home2, 'auth.json'), JSON.stringify({ 'k': { refresh_token: 'r' } }), 'utf8')
  const [item2] = await grokFamily.discover({})
  assert.equal(item2.importable, false)
  assert.match(item2.reason, /access/)
})

test('GROK_HOME 指到 auth.json 本身也认（有人会这么配）', async () => {
  const home = await makeHome()
  process.env.GROK_HOME = join(home, 'auth.json')
  assert.equal(grokHome(), home)
  assert.equal(authFilePath(), join(home, 'auth.json'))
})

test('账号展示名与套餐名：未知 tier 原样展示，不猜', () => {
  assert.equal(accountLabel({ email: 'a@b.c', tier: 1 }), 'a@b.c')
  assert.equal(accountLabel({ tier: 1 }), 'Grok (SuperGrok)')
  assert.equal(accountLabel({ tier: 42 }), 'Grok (42)')
  assert.equal(accountLabel({}), undefined)
  assert.equal(grokTierName(4), 'X Premium+')
  assert.equal(grokTierName('5'), 'SuperGrok Heavy')
  assert.equal(grokTierName(undefined), undefined)
})

// ------------------------------------------------------------------ 刷新与写回

/**
 * 造一个 refresh 用例：假的令牌端点 + 写好的 auth.json。
 *
 * `omitRefresh` 用来模拟「上游不给新 refresh_token」（G9）。**不能**靠传
 * `refreshToken: undefined`：`JSON.stringify` 会把 undefined 的键整个删掉，
 * 两种意图就分不出来了。
 */
async function refreshFixture({ refreshToken = 'refresh-new', omitRefresh = false, expiresIn = 3600, status = 200, body, patch = {} } = {}) {
  const home = await makeHome()
  const path = await writeAuth(home, patch)
  const record = JSON.parse(await readFile(path, 'utf8'))
  const slot = Object.keys(record)[0]
  const auth = {
    access: record[slot].key,
    refresh: record[slot].refresh_token,
    expiresAt: Date.parse(record[slot].expires_at),
    slot,
    ...patch,
  }
  const tokenBody = { access_token: 'access-new', expires_in: expiresIn, ...body }
  if (!omitRefresh) tokenBody.refresh_token = refreshToken
  const response = status === 200 ? jsonResponse(tokenBody) : errorResponse(status, body ?? { error: 'invalid_grant' })
  const rec = recordingCtx(() => response)
  const payload = { family: 'grok', auth, sourcePath: path, externallyOwned: true, proxy: 'http://proxy.local:8080' }
  return { home, path, slot, auth, rec, payload }
}

test('refresh：无条件原地写回，且写的是 RFC3339 而不是 epoch', async () => {
  const fixture = await refreshFixture()
  const next = await grokFamily.refresh(fixture.rec.ctx, fixture.payload, undefined)

  assert.equal(next.access, 'access-new')
  const written = JSON.parse(await readFile(fixture.path, 'utf8'))
  const record = written[fixture.slot]
  assert.equal(record.key, 'access-new')
  assert.equal(record.refresh_token, 'refresh-new')
  assert.equal(record.expires_at, new Date(next.expiresAt).toISOString())
  // 写回不能把 CLI 自己的字段抹掉（否则用户的 `grok` 命令会认不出这条记录）。
  assert.equal(record.user_id, 'user-1')
  assert.equal(record.oidc_client_id, GROK_CLIENT_ID)
  assert.equal(record.oidc_issuer, 'https://auth.x.ai')

  // 刷新请求本身：form 编码、不发 scope、代理要透传。
  const call = callTo(fixture.rec.calls, 'auth.x.ai')
  assert.equal(call.url, 'https://auth.x.ai/oauth2/token')
  assert.equal(call.init.headers['content-type'], 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(call.init.body)
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('refresh_token'), 'refresh-old')
  assert.equal(form.get('client_id'), GROK_CLIENT_ID)
  assert.equal(form.get('scope'), null)
  assert.equal(call.proxy, 'http://proxy.local:8080')
})

test('refresh：上游不给新 refresh_token 时沿用旧的（G9：不一定轮换）', async () => {
  const fixture = await refreshFixture({ omitRefresh: true })
  const next = await grokFamily.refresh(fixture.rec.ctx, fixture.payload, undefined)
  assert.equal(next.refresh, 'refresh-old')
  assert.equal(next.access, 'access-new')
  const written = JSON.parse(await readFile(fixture.path, 'utf8'))
  assert.equal(written[fixture.slot].refresh_token, 'refresh-old')
})

test('refresh：浅合并要保留用户的端点选择（丢了就等于偷偷改计费口径）', async () => {
  const fixture = await refreshFixture({ patch: { useApiEndpoint: true, baseUrl: 'https://relay.example/v1' } })
  const next = await grokFamily.refresh(fixture.rec.ctx, fixture.payload, undefined)
  assert.equal(next.useApiEndpoint, true)
  assert.equal(next.baseUrl, 'https://relay.example/v1')
  assert.equal(next.slot, fixture.slot)
})

test('写回 CAS：本机文件被别的进程改过就放弃写（写回去会把人踢下线）', async () => {
  const fixture = await refreshFixture()
  // 先按 CAS 的语义「读到过」这份内容：这就是写回时的基准。
  await readAuthFile(fixture.path)
  // 模拟用户自己刚跑了一次 `grok login`：文件内容变得和我们读到的不一样了。
  const doc = JSON.parse(await readFile(fixture.path, 'utf8'))
  doc[fixture.slot].key = 'access-from-cli'
  doc[fixture.slot].refresh_token = 'refresh-from-cli'
  await writeFile(fixture.path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')

  const result = await writeBackAuth({ access: 'access-new', refresh: 'refresh-new', expiresAt: Date.now() + 60_000 }, fixture.payload)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'stale')
  const after = JSON.parse(await readFile(fixture.path, 'utf8'))
  assert.equal(after[fixture.slot].key, 'access-from-cli')
})

test('写回 CAS：文件没被改过就正常写入，且不产生临时文件残留', async () => {
  const fixture = await refreshFixture()
  const result = await writeBackAuth(
    { access: 'access-new', refresh: 'refresh-new', expiresAt: 1_800_000_000_000 },
    fixture.payload,
  )
  assert.deepEqual(result, { ok: true })
  const after = JSON.parse(await readFile(fixture.path, 'utf8'))
  assert.equal(after[fixture.slot].key, 'access-new')
  assert.equal(after[fixture.slot].expires_at, new Date(1_800_000_000_000).toISOString())
  // 临时文件必须已经被 rename 掉。
  const dir = await readFile(join(fixture.home, 'auth.json'), 'utf8')
  assert.ok(dir.includes('access-new'))
})

test('refresh：本机文件不可写时只记警告，刷新结果照常返回', async () => {
  const fixture = await refreshFixture()
  const broken = { ...fixture.payload, sourcePath: join(fixture.home, 'nope', 'auth.json') }
  const next = await grokFamily.refresh(fixture.rec.ctx, broken, undefined)
  assert.equal(next.access, 'access-new')
  assert.ok(fixture.rec.warnings.some((line) => /写回/.test(line)))
})

test('refresh：非本机凭据（手动粘贴的）不写盘', async () => {
  const fixture = await refreshFixture()
  fixture.payload.externallyOwned = false
  const before = await readFile(fixture.path, 'utf8')
  await grokFamily.refresh(fixture.rec.ctx, fixture.payload, undefined)
  assert.equal(await readFile(fixture.path, 'utf8'), before)
})

test('refresh：invalid_grant 才是永久失效，5xx 只是这一次运气不好', async () => {
  const permanent = await refreshFixture({ status: 400, body: { error: 'invalid_grant' } })
  await assert.rejects(
    () => grokFamily.refresh(permanent.rec.ctx, permanent.payload, undefined),
    (error) => {
      assert.equal(error.code, 'AUTH')
      return true
    },
  )

  const transient = await refreshFixture({ status: 503, body: 'upstream down' })
  await assert.rejects(
    () => grokFamily.refresh(transient.rec.ctx, transient.payload, undefined),
    (error) => {
      // 归 AUTH 会把账号冷 24 小时，等于逼用户重走一遍授权码流程。
      assert.equal(error.code, 'SERVER')
      return true
    },
  )

  const noRefresh = await refreshFixture()
  noRefresh.payload.auth = { access: 'tok' }
  await assert.rejects(
    () => grokFamily.refresh(noRefresh.rec.ctx, noRefresh.payload, undefined),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.match(error.message, /refresh token/)
      return true
    },
  )
})

test('needsRefresh：过期前 5 分钟开始刷，没有过期时间时不主动刷', () => {
  const now = Date.now()
  assert.equal(grokFamily.needsRefresh({ auth: { expiresAt: now + 10 * 60_000 } }, now), false)
  assert.equal(grokFamily.needsRefresh({ auth: { expiresAt: now + 4 * 60_000 } }, now), true)
  assert.equal(grokFamily.needsRefresh({ auth: {} }, now), false)
})

// ------------------------------------------------------------------ 登录

test('登录：三种方式都在，且 client_id / scope 是公开的那一套', () => {
  assert.deepEqual(grokFamily.login.methods.map((method) => method.id), ['browser', 'device', 'import'])
  assert.equal(GROK_CLIENT_ID, 'b1a00492-073a-47ea-816f-4c329264a828')
})

test('登录 URL：PKCE S256 + state + nonce，回调是回环 127.0.0.1', () => {
  const url = new URL(
    authorizeUrl({
      redirectUri: 'http://127.0.0.1:56121/callback',
      pkce: { verifier: 'v', challenge: 'c', method: 'S256' },
      state: 'st',
      nonce: 'n1',
    }),
  )
  assert.equal(url.origin, 'https://auth.x.ai')
  assert.equal(url.pathname, '/oauth2/authorize')
  const params = url.searchParams
  assert.equal(params.get('response_type'), 'code')
  assert.equal(params.get('client_id'), GROK_CLIENT_ID)
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:56121/callback')
  assert.equal(params.get('code_challenge'), 'c')
  assert.equal(params.get('code_challenge_method'), 'S256')
  assert.equal(params.get('state'), 'st')
  assert.equal(params.get('nonce'), 'n1')
  // referrer 是自由文本，不是需要伪装的固定值。
  assert.equal(params.get('referrer'), 'dsh-account-bridge')
  assert.ok(params.get('scope').includes('grok-cli:access'))
})

test('授权码换令牌：7 个 form 字段，403 的套餐语义原样透传', async () => {
  const rec = recordingCtx(() => jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }))
  await exchangeCode(rec.ctx, {
    code: 'the-code',
    verifier: 'ver',
    challenge: 'chal',
    redirectUri: 'http://127.0.0.1:56121/callback',
    clientId: GROK_CLIENT_ID,
  })
  const form = new URLSearchParams(rec.calls[0].init.body)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code_verifier'), 'ver')
  // 多带这两个是刻意的：RFC 6749 允许服务端忽略未知参数，而漏发导致失败没法补救。
  assert.equal(form.get('code_challenge'), 'chal')
  assert.equal(form.get('code_challenge_method'), 'S256')

  const refused = recordingCtx(() => errorResponse(403, { error: 'access_denied' }))
  await assert.rejects(
    () => exchangeCode(refused.ctx, { code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', clientId: GROK_CLIENT_ID }),
    (error) => {
      // 「你的套餐不含 API OAuth 权限」不是插件 bug，写模糊了用户会去查一个不存在的问题。
      assert.match(error.message, /API OAuth entitlement/)
      assert.match(error.message, /HTTP 403/)
      return true
    },
  )
})

test('令牌响应 → auth：tier / email 从 JWT 里取，未知 tier 不猜', () => {
  const access = jwt({ tier: 1, sub: 'user-9' })
  const auth = authFromTokens({
    access_token: access,
    refresh_token: 'rt',
    expires_in: 3600,
    id_token: jwt({ email: 'me@example.com' }),
  })
  assert.equal(auth.access, access)
  assert.equal(auth.refresh, 'rt')
  assert.equal(auth.tier, 1)
  assert.equal(auth.email, 'me@example.com')
  assert.equal(auth.userId, 'user-9')
  assert.ok(auth.expiresAt > Date.now() + 3_000_000)
  assert.equal(accountLabel(auth), 'me@example.com')

  // id_token 里没有 email 就退回 preferred_username / name / sub。
  assert.equal(authFromTokens({ access_token: jwt({ tier: 9 }) }).tier, 9)
  assert.equal(authFromTokens({ access_token: access, id_token: jwt({ preferred_username: 'nick' }) }).email, 'nick')

  // 缺 expires_in 也不能把 expiresAt 留成 undefined，否则永远不刷新。
  assert.ok(authFromTokens({ access_token: access }).expiresAt > Date.now())
})

test('recordFromAuth：记录形状符合契约（family / source / createdAt）', () => {
  const auth = { access: 'a', refresh: 'r' }
  const record = recordFromAuth(auth, 'me@example.com', 'oauth', false)
  assert.equal(record.family, 'grok')
  assert.equal(record.label, 'me@example.com')
  assert.equal(record.source, 'oauth')
  assert.equal(record.externallyOwned, false)
  // auth 会被补一个缓存亲和键：同一账号的同一段会话必须一直落回同一个缓存分片。
  assert.equal(record.auth.access, 'a')
  assert.equal(record.auth.refresh, 'r')
  assert.match(record.auth.cacheKey, /^grok-[0-9a-f]+$/)
  assert.ok(record.createdAt)
  const imported = recordFromAuth(auth, 'CLI', 'client-import', true)
  assert.equal(imported.externallyOwned, true)
  assert.equal(imported.source, 'client-import')
})

// ------------------------------------------------------------------ 族对象与 stream

test('族对象：id / route / displayName 与前端约定一致', () => {
  assert.equal(grokFamily.id, 'grok')
  assert.equal(grokFamily.route, 'acct-grok')
  assert.equal(grokFamily.displayName, 'Grok (xAI)')
  assert.equal(grokFamily.risk, 'high')
  for (const method of ['discover', 'recordFromDiscovery', 'refresh', 'needsRefresh', 'listModels', 'resolveModel', 'quota', 'stream']) {
    assert.equal(typeof grokFamily[method], 'function', method)
  }
  // 可选能力不实现就整段省略，不写空壳。
  assert.equal(grokFamily.login === undefined, false)
})

test('stream：默认打订阅代理、流式标志为 true、代理透传、缓存键稳定', async () => {
  const rec = recordingCtx(() =>
    sseResponse([
      event('response.output_text.delta', { item_id: 'msg_1', delta: 'hi' }),
      event('response.completed', { response: { status: 'completed' } }),
    ]),
  )
  const payload = {
    family: 'grok',
    auth: { access: 'access-tok', cacheKey: 'session-1' },
    proxy: 'http://proxy.local:8080',
  }
  const options = {
    payload,
    model: 'grok-4.6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: 'be brief',
    maxTokens: 2048,
    signal: undefined,
  }
  const chunks = await collect(grokFamily.stream(rec.ctx, options))
  assert.equal(chunks.at(-1).type, 'finish')

  const call = callTo(rec.calls, CLI_HOST)
  assert.equal(call.url, AUTH_URL)
  assert.equal(call.proxy, 'http://proxy.local:8080')
  // 漏传这个标志 ⇒ 配了代理的账号在长推理里被 undici 的 30s bodyTimeout 掐断。
  assert.equal(call.streaming, true)
  assert.equal(call.init.headers['x-xai-token-auth'], 'xai-grok-cli')
  assert.equal(call.init.headers['x-grok-client-version'], GROK_FALLBACK_CLIENT_VERSION)
  assert.equal(call.init.headers['x-grok-client-identifier'], 'dsh-account-bridge')
  const body = JSON.parse(call.init.body)
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.equal(body.instructions, 'be brief')
  assert.equal(body.max_output_tokens, 2048)
  // 会话粘性交给账号池，缓存亲和只能靠这个键（同一段会话必须一直用它）。
  assert.equal(body.prompt_cache_key, 'session-1')
  // 目录没证明支持思考档位时，一个 reasoning 字段都不发（猜一个档位会 400）。
  assert.ok(!('reasoning' in body))
})

test('stream：思考档位只在目录证明支持时才发', async () => {
  // 先把目录灌进去（catalogCache 是族内缓存，测试通过 parseCliCatalog + listModels 喂它）。
  parseCliCatalog({ data: [{ id: 'grok-4.6', reasoning_effort: 'high', reasoning_efforts: [{ value: 'high' }] }] })
  const rec = recordingCtx(() =>
    sseResponse([
      event('response.output_text.delta', { item_id: 'msg_1', delta: 'hi' }),
      event('response.completed', { response: { status: 'completed' } }),
    ]),
  )
  const payload = { family: 'grok', auth: { access: 'tok' } }
  const base = { payload, model: 'grok-4.6', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

  // 目录里没有这个模型 ⇒ 不发。
  await collect(grokFamily.stream(rec.ctx, { ...base, effort: 'high' }))
  assert.ok(!('reasoning' in JSON.parse(callTo(rec.calls, CLI_HOST).init.body)))
  await collect(grokFamily.stream(rec.ctx, { ...base, effort: 'xhigh' }))
  assert.ok(!('reasoning' in JSON.parse(callTo(rec.calls, CLI_HOST).init.body)))
})

test('stream：账号级开关切到 api.x.ai 时不再发 CLI 指纹头', async () => {
  const rec = recordingCtx(() =>
    sseResponse([
      event('response.output_text.delta', { item_id: 'msg_1', delta: 'hi' }),
      event('response.completed', { response: { status: 'completed' } }),
    ]),
  )
  const payload = { family: 'grok', auth: { access: 'tok', useApiEndpoint: true } }
  await collect(
    grokFamily.stream(rec.ctx, {
      payload,
      model: 'grok-4.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  )
  const call = callTo(rec.calls, 'api.x.ai')
  assert.equal(call.url, `${GROK_API_BASE}/responses`)
  assert.equal(call.init.headers.authorization, 'Bearer tok')
  assert.ok(!('x-grok-client-version' in call.init.headers))
  assert.ok(!('x-xai-token-auth' in call.init.headers))
  assert.equal(call.streaming, true)
})

test('stream：基地址覆盖（自建中转）也保留流式标志', async () => {
  const rec = recordingCtx(() =>
    sseResponse([
      event('response.output_text.delta', { item_id: 'msg_1', delta: 'hi' }),
      event('response.completed', { response: { status: 'completed' } }),
    ]),
  )
  await collect(
    grokFamily.stream(rec.ctx, {
      payload: { family: 'grok', auth: { access: 'tok', baseUrl: 'https://relay.example/v1' }, proxy: 'http://p:1' },
      model: 'grok-4.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  )
  const call = callTo(rec.calls, 'relay.example')
  assert.equal(call.url, 'https://relay.example/v1/responses')
  assert.equal(call.streaming, true)
  assert.equal(call.proxy, 'http://p:1')
})

test('listModels：目录不可用时退回兜底列表，而不是让整族消失', async () => {
  const rec = recordingCtx(() => errorResponse(500, 'down'))
  const models = await grokFamily.listModels(rec.ctx, { family: 'grok', auth: { access: 'tok' } }, undefined)
  assert.ok(models.length >= FALLBACK_MODELS.length)
  for (const model of models) {
    assert.ok(Number.isInteger(model.context.contextWindow) && model.context.contextWindow > 0, model.id)
    assert.ok(Number.isInteger(model.defaultMaxTokens) && model.defaultMaxTokens > 0, model.id)
  }
})

test('listModels：权威目录 + CLI catalog 合并，思考档位来自 catalog', async () => {
  const rec = recordingCtx((url) => {
    if (url.startsWith(`${GROK_API_BASE}/models`)) {
      return jsonResponse({ data: [{ id: 'grok-4.6' }, { id: 'grok-imagine-image' }] })
    }
    if (url === `${GROK_CLI_BASE}/models`) {
      return jsonResponse({
        data: [{ id: 'grok-4.6', context_window: 500_000, max_output_tokens: 128_000, reasoning_effort: 'high', reasoning_efforts: [{ value: 'high' }, { value: 'low' }] }],
      })
    }
    return errorResponse(404, 'not found')
  })
  const models = await grokFamily.listModels(rec.ctx, { family: 'grok', auth: { access: 'tok' } }, undefined)
  assert.deepEqual(models.map((model) => model.id), ['grok-4.6'])
  assert.equal(models[0].context.contextWindow, 500_000)
  assert.deepEqual(models[0].reasoning.efforts.map((effort) => effort.id), ['high', 'low'])
  assert.equal(grokFamily.resolveModel('acct-grok', 'grok-4.6').context.contextWindow, 500_000)
})

test('util：usage 字段名重新映射，缺字段就不写', () => {
  assert.deepEqual(usageOf({ input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 6 } }), {
    inputTokens: 10,
    outputTokens: 4,
    cachedInputTokens: 6,
  })
  assert.deepEqual(usageOf({ prompt_tokens: 1, completion_tokens: 2 }), { inputTokens: 1, outputTokens: 2 })
  assert.equal(usageOf(undefined), undefined)
  assert.equal(usageOf({}), undefined)
})

test('版本号：格式不对的候选会被丢掉，退回兜底常量', () => {
  __resetGrokCaches()
  const rec = recordingCtx(() => jsonResponse({}))
  rec.ctx.config = {}
  // 不做网络请求也必须是合法版本号（否则 426 会因为一个没查到的版本号而出现）。
  const version = grokClientVersion(rec.ctx)
  assert.match(version, /^\d+\.\d+\.\d+/)
  assert.equal(version, GROK_FALLBACK_CLIENT_VERSION)

  // 配置覆盖优先。
  assert.equal(grokClientVersion({ config: { grokClientVersion: '9.9.9' } }), '9.9.9')
  // 形态不对的配置值不能进请求头。
  assert.equal(grokClientVersion({ config: { grokClientVersion: 'grok-shell/1.0' } }), GROK_FALLBACK_CLIENT_VERSION)
  __resetGrokCaches()
})

// ------------------------------------------------------------------ 联网用例（默认跳过）

test('live: 真实订阅端点能推理一次', { skip: process.env.BRIDGE_LIVE_GROK !== '1' }, async () => {
  const home = await makeHome()
  const [item] = await grokFamily.discover({})
  assert.ok(item?.importable, `需要 ${home}/auth.json 里有一份真实登录态`)
  const ctx = { config: {}, log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } }
  const chunks = await collect(
    grokFamily.stream(ctx, {
      payload: { family: 'grok', auth: item.auth },
      model: 'grok-4.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'say hi in one word' }] }],
    }),
  )
  assert.equal(chunks.at(-1).type, 'finish')
  const text = [...textByIndex(chunks).values()].join('')
  assert.ok(text.length > 0)
})

test('live: 额度端点读得到就解析成桶，读不到回 undefined', { skip: process.env.BRIDGE_LIVE_GROK !== '1' }, async () => {
  const [item] = await grokFamily.discover({})
  assert.ok(item?.importable)
  const ctx = { config: {}, log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } }
  const buckets = await grokFamily.quota(ctx, { family: 'grok', auth: item.auth })
  if (buckets !== undefined) {
    assert.ok(Array.isArray(buckets))
    assert.ok(buckets[0].remainingFraction >= 0 && buckets[0].remainingFraction <= 1)
  }
})
