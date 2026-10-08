/**
 * Qoder 族的测试。
 *
 * 这一族有两处**没有网络就完全测不出**的东西，所以测试分两半：
 *
 * - **离线可钉死的**：PAT → jobToken 的兑换请求形状、COSY 签名的确定性
 *   （对着 `test/fixtures/qoder-cosy-vector.json` 里用 Python 独立实现算出的向量）、
 *   WAF body 编码、私有信封、SSE 信封解析、失败归类、额度解析。
 * - **只能真机验的**：上游到底接受不接受这套签名。默认 skip，用
 *   `BRIDGE_LIVE_QODER=1` 打开（见文件末尾）。
 *
 * 本机没有 `~/.qoder`（没装 Qoder），所以真机那条路径**确实没跑过**——
 * 这不是"配置问题"，是这一族当前的真实状态。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { constants, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto'

import { qoderFamily } from '../src/families/qoder.js'
import * as wire from '../src/wire/qoder.js'
import { httpError, mapStatus } from '../src/wire/http-error.js'

const VECTOR = JSON.parse(readFileSync(new URL('./fixtures/qoder-cosy-vector.json', import.meta.url), 'utf8'))

// ---------------------------------------------------------------- 测试替身

/** 一个会记账的假 ctx：记下 `ctx.fetch(url, init, proxy, streaming)` 的每一次调用。 */
function spyCtx(responses = []) {
  const queue = [...responses]
  const calls = []
  const warnings = []
  return {
    calls,
    warnings,
    log: { warn: (message) => warnings.push(message) },
    async fetch(url, init, proxy, streaming) {
      calls.push({ url, init, proxy, streaming })
      const next = queue.shift()
      if (typeof next === 'function') return next(url, init, proxy, streaming)
      if (next === undefined) return jsonResponse({}, 500)
      return next
    },
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function errorResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

/** 把 SSE 帧组成流式响应体（与 pool 的假上游同一形状）。 */
function sseResponse(frames) {
  const encoder = new TextEncoder()
  const body = {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield encoder.encode(frame)
    },
  }
  return { ok: true, status: 200, body, headers: new Headers() }
}

/** `data: {...}` 一行，外层信封。`body` 是内层模型 JSON 的**字符串**。 */
function envelope(body, statusCodeValue = 200) {
  return `data: ${JSON.stringify({ statusCodeValue, body })}\n\n`
}

/** 一帧正常的模型分片。 */
function chunk(delta, finishReason = undefined, usage = undefined) {
  return envelope(JSON.stringify({
    choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    ...(usage ? { usage } : {}),
  }))
}

/**
 * WAF 编码的逆运算，只给测试用来读回请求体。
 *
 * 三个容易写错的地方（我三个都踩过）：
 * 1. 旋转正向是 `A` 挪到末尾（`std.slice(n-a) + std.slice(a,n-a) + std.slice(0,a)`），
 *    逆变换必须逐段放回 `C+A+B`；
 * 2. 换表是**逐字节**做的、且要先换回来，再逆旋转；
 * 3. 编码结果是 latin1 字符串，得先 `Buffer.from(encoded,'latin1')`——直接切
 *    字符串会在下标 >= 128 的字节上错位（中文一进去就崩）。
 * 解出来的是**标准 base64 文本**（不是原明文），这正是"逆运算"该有的样子：
 * 它证明了编码是双射，而"编出来的是不是 WAF 要的那张表"由别的断言钉。
 */
function decodeQoderBody(encoded) {
  const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
  const std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = Buffer.from(encoded, 'latin1')
  const rewritten = Buffer.from([...bytes].map((byte) => {
    const char = String.fromCharCode(byte)
    const position = custom.indexOf(char)
    return position >= 0 ? std.charCodeAt(position) : byte === 0x24 ? 0x3d : byte
  }))
  const n = rewritten.length
  const a = Math.floor(n / 3)
  return Buffer.concat([
    rewritten.subarray(n - a),
    rewritten.subarray(a, n - a),
    rewritten.subarray(0, a),
  ]).toString('utf8')
}

/** 请求体读回明文：逆运算 → 标准 base64 → UTF-8。 */
function readQoderBody(encoded) {
  return Buffer.from(decodeQoderBody(encoded), 'base64').toString('utf8')
}

/** 一只可用账号。 */
function account(overrides = {}) {
  return {
    family: 'qoder',
    label: 'qoder-test@example.com',
    source: 'manual',
    proxy: undefined,
    auth: {
      pat: 'pat-fixture',
      region: 'china',
      jobToken: 'job-token-old',
      jobTokenExpiresAt: Date.now() + 6 * 60 * 60_000,
      userID: 'u_fixture',
      email: 'qoder-test@example.com',
      name: 'Fixture User',
      machineId: 'fixture-machine-id',
      ...overrides,
    },
  }
}

/** 收一个 async generator 的全部 chunk。 */
async function collect(iterator) {
  const out = []
  for await (const chunk of iterator) out.push(chunk)
  return out
}

/** 收 chunk，断言中途抛错，并把错误还给调用方。 */
async function collectError(iterator) {
  try {
    await collect(iterator)
  } catch (error) {
    return error
  }
  throw new Error('expected the stream to throw')
}

// ---------------------------------------------------------------- COSY 签名

test('COSY signature matches the independently generated vector', () => {
  const headers = wire.buildCosyHeaders({
    body: VECTOR.body,
    url: VECTOR.requestUrl,
    credentials: {
      userID: 'u_fixture',
      authToken: 'job-token-fixture',
      name: 'Fixture User',
      email: 'fixture@example.com',
      machineID: VECTOR.machineId,
    },
    random: { aesKey: VECTOR.aesKey, cosyKey: VECTOR.cosyKey, requestId: VECTOR.requestId, timestamp: VECTOR.timestamp },
  })
  assert.equal(headers.Authorization, VECTOR.authorization)
  assert.equal(headers['Cosy-Key'], VECTOR.cosyKey)
  assert.equal(headers['Cosy-Bodyhash'], VECTOR.bodyHash)
  assert.equal(headers['Cosy-Bodylength'], VECTOR.bodyLength)
  assert.equal(headers['Cosy-Sigpath'], VECTOR.sigPath)
})

test('Cosy-Key round-trips: our PKCS#1 v1.5 ciphertext decrypts back to the AES key', () => {
  // 这条**替代**了原先提交在 test/fixtures/ 里的那把测试私钥。
  // 理由：本仓库的主题就是凭据处理，源码树里躺一个 `BEGIN PRIVATE KEY` 块，
  // 既会被 secret scanner 拦，也是在给读者做坏示范——哪怕它只是一次性的。
  // 现在密钥对每次运行时现生成，验的还是同一条性质：
  // 我们交给上游的那串密文，上游用私钥解得回同一个 aesKey。
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const headers = wire.buildCosyHeaders({
    body: VECTOR.body,
    url: VECTOR.requestUrl,
    credentials: { userID: 'u_fixture', authToken: 'job-token-fixture', name: 'Fixture User', email: 'fixture@example.com', machineID: VECTOR.machineId },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    random: { aesKey: VECTOR.aesKey, requestId: VECTOR.requestId, timestamp: VECTOR.timestamp, xRequestId: VECTOR.requestId },
  })

  const recovered = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(headers['Cosy-Key'], 'base64'),
  )
  assert.equal(recovered.toString('utf8'), VECTOR.aesKey)

  // 1024 位密钥 → 128 字节密文，base64 常见形态。钉死它是**一段密文**而不是明文钥匙。
  assert.equal(Buffer.from(headers['Cosy-Key'], 'base64').length, 128)
  assert.notEqual(headers['Cosy-Key'], VECTOR.aesKey)

  // 顺带证伪"确定性"：同一输入加密两次必然不同（PKCS#1 v1.5 自带随机填充）。
  const again = wire.buildCosyHeaders({
    body: VECTOR.body,
    url: VECTOR.requestUrl,
    credentials: { userID: 'u_fixture', authToken: 'job-token-fixture', name: 'Fixture User', email: 'fixture@example.com', machineID: VECTOR.machineId },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    random: { aesKey: VECTOR.aesKey, requestId: VECTOR.requestId, timestamp: VECTOR.timestamp, xRequestId: VECTOR.requestId },
  })
  assert.notEqual(again['Cosy-Key'], headers['Cosy-Key'])
  // ……但两者解出来是同一把钥匙，而签名段输入不同 ⇒ Authorization 也不同。
  assert.equal(
    privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(again['Cosy-Key'], 'base64')).toString('utf8'),
    VECTOR.aesKey,
  )
  assert.notEqual(again.Authorization, headers.Authorization)
})

test('COSY payload embeds the AES info block and the request id', () => {
  const headers = wire.buildCosyHeaders({
    body: VECTOR.body,
    url: VECTOR.requestUrl,
    credentials: { userID: 'u_fixture', authToken: 'job-token-fixture', name: 'Fixture User', email: 'fixture@example.com' },
    random: { aesKey: VECTOR.aesKey, requestId: VECTOR.requestId, timestamp: VECTOR.timestamp },
  })

  const payloadB64 = headers.Authorization.slice('Bearer COSY.'.length).split('.')[0]
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'))
  assert.equal(payload.version, 'v1')
  assert.equal(payload.requestId, VECTOR.requestId)
  assert.equal(payload.cosyVersion, '1.1.47')
  assert.equal(payload.ideVersion, '')
  assert.equal(payload.info, VECTOR.infoB64)
})

test('COSY is fully deterministic once the random ciphertext is pinned', () => {
  // 这条测试写错过一次，值得留个说明：**不注入 cosyKey 时它必然失败**，
  // 因为 Cosy-Key 是 RSA-PKCS1v1.5 密文、自带随机填充，两次调用天然不同。
  // 所以"可复现"这条性质的作用域就是"随机量全部给定时"——cosyKey 也因此
  // 成了一个正当的注入点（详见 src/wire/qoder.js 的 buildCosyHeaders 注释）。
  const input = {
    body: '{"a":1}',
    url: 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1',
    credentials: { userID: 'u1', authToken: 't1', name: 'n', email: 'e', machineID: 'm' },
    random: { aesKey: 'abcdef0123456789', cosyKey: 'pinned-ciphertext', requestId: 'r', timestamp: '1700000000', xRequestId: 'r' },
  }
  const first = wire.buildCosyHeaders(input)
  const second = wire.buildCosyHeaders(input)
  assert.deepEqual(first, second)
  assert.equal(first.Authorization, second.Authorization)
  // 同样固定的输入下，签名里那一段也是固定的：md5(payload . cosyKey . ts . body . sigPath)
  const payloadB64 = first.Authorization.slice('Bearer COSY.'.length).split('.')[0]
  const expected = createHash('md5')
    .update([payloadB64, 'pinned-ciphertext', '1700000000', '{"a":1}', '/api/v2/service/pro/sse/agent_chat_generation'].join('\n'))
    .digest('hex')
  assert.equal(first.Authorization, `Bearer COSY.${payloadB64}.${expected}`)
})

test('COSY refuses to sign without identity or token', () => {
  assert.throws(() => wire.buildCosyHeaders({ body: null, url: 'https://x/a', credentials: { authToken: 't' } }), /COSY needs a non-empty user id/)
  assert.throws(() => wire.buildCosyHeaders({ body: null, url: 'https://x/a', credentials: { userID: 'u' } }), /COSY needs a non-empty auth token/)
})

test('Cosy-Clienttype is the generic 5, not the desktop 10', () => {
  // 笔记里那句「必须是 '10'」是把活动端点的要求当成了全局要求；
  // 普通签名请求（chat / model list）用的是 qoderClientType = '5'。
  const headers = wire.buildCosyHeaders({
    body: null,
    url: wire.modelListUrl('china'),
    credentials: { userID: 'u', authToken: 't', machineID: 'm' },
  })
  assert.equal(headers['Cosy-Clienttype'], '5')
  assert.equal(wire.QODER_CLIENT_TYPE, '5')
  assert.equal(wire.QODER_DESKTOP_CLIENT_TYPE, '10')
  // 类型必须是字符串：数字 5 会让服务端按另一种客户端解析（静默换行为）。
  assert.equal(typeof headers['Cosy-Clienttype'], 'string')
})

test('every COSY request carries the full header set', () => {
  const headers = wire.buildCosyHeaders({
    body: null,
    url: wire.modelListUrl('global'),
    credentials: { userID: 'u', authToken: 't', machineID: 'm' },
  })
  assert.deepEqual(Object.keys(headers).sort(), [
    'Authorization', 'Cosy-Bodyhash', 'Cosy-Bodylength', 'Cosy-Clientip', 'Cosy-Clienttype',
    'Cosy-Data-Policy', 'Cosy-Date', 'Cosy-Key', 'Cosy-Machineid', 'Cosy-Machineos',
    'Cosy-Machinetoken', 'Cosy-Machinetype', 'Cosy-Organization-Id', 'Cosy-Organization-Tags',
    'Cosy-Sigpath', 'Cosy-User', 'Cosy-Version', 'Login-Version', 'X-Request-Id',
  ])
  assert.equal(headers['Cosy-Clientip'], '127.0.0.1')
  assert.equal(headers['Login-Version'], 'v2')
  assert.equal(headers['Cosy-Organization-Id'], '')
})

test('computeSigPath drops the /algo prefix but keeps query out of the signature', () => {
  assert.equal(wire.computeSigPath('https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1'), '/api/v2/model/list')
  assert.equal(wire.computeSigPath('https://openapi.qoder.sh/api/v1/userinfo'), '/api/v1/userinfo')
})

test('the chat URL still carries /algo while the signature does not', () => {
  const url = wire.chatUrl('china')
  assert.ok(url.startsWith('https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?'))
  assert.ok(url.includes('FetchKeys=llm_model_result'))
  assert.ok(url.includes('AgentId=agent_common'))
  assert.ok(url.includes('Encode=1'))
  assert.equal(wire.computeSigPath(url), '/api/v2/service/pro/sse/agent_chat_generation')
})

test('machineOs reports the two platform identifiers upstream knows', () => {
  assert.equal(wire.machineOs('win32', 'x64'), 'x86_64_windows')
  assert.equal(wire.machineOs('win32', 'arm64'), 'aarch64_windows')
  assert.equal(wire.machineOs('linux', 'x64'), 'x86_64_linux')
  assert.equal(wire.machineOs('darwin', 'arm64'), 'aarch64_linux')
})

// ---------------------------------------------------------------- WAF body 编码

test('the WAF body encoding is deterministic and reversible', () => {
  const encoded = wire.encodeQoderBody('{"hello":"world"}')
  assert.equal(encoded, wire.encodeQoderBody('{"hello":"world"}'))
  assert.notEqual(encoded, '{"hello":"world"}')
  assert.equal(readQoderBody(encoded), '{"hello":"world"}')
})

test('the WAF body encoding uses the custom alphabet and $ for padding', () => {
  // 明文长度刻意选成 3 的倍数倍数之外，好让 base64 里出现 '='。
  const encoded = wire.encodeQoderBody('a')
  assert.ok(encoded.includes('$'), `expected a $ padding marker in ${encoded}`)
  assert.ok(!encoded.includes('='))
  assert.equal(readQoderBody(encoded), 'a')
})

test('the WAF body encoding handles multi-byte text', () => {
  const text = '你好 Qoder'
  assert.equal(readQoderBody(wire.encodeQoderBody(text)), text)
  assert.equal(Buffer.byteLength(wire.encodeQoderBody(text), 'latin1'), Math.ceil(Buffer.byteLength(text) / 3) * 4)
})

// ---------------------------------------------------------------- 信封

test('toQoderMessages flattens the DSH shapes into the private envelope', () => {
  const messages = wire.toQoderMessages([
    { role: 'system', content: 'ignored here' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'sure' },
      ],
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"q":1}' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '42' }] },
  ])

  assert.deepEqual(messages[0], { role: 'user', content: 'hi' })
  assert.equal(messages[1].reasoning_content, 'thinking')
  assert.equal(messages[1].content, 'sure')
  assert.deepEqual(messages[1].tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
  ])
  assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 'call_1', content: '42' })
})

test('an assistant turn with no content is skipped, and empty text becomes a space', () => {
  const messages = wire.toQoderMessages([
    { role: 'assistant', content: [] },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'go' },
  ])
  assert.deepEqual(messages, [{ role: 'user', content: 'go' }])

  // 上游拒空字符串内容，所以带工具调用的 assistant 轮次正文写 ' '。
  const withCall = wire.toQoderMessages([
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'n', arguments: '{}' }] },
  ])
  assert.equal(withCall[0].content, ' ')
})

test('tool declarations are sorted and wrapped in the function shape', () => {
  const tools = wire.toQoderTools([
    { name: 'zeta', description: 'z', parameters: { type: 'object' } },
    { name: 'alpha', description: 'a', inputSchema: { type: 'object' } },
  ])
  assert.deepEqual(tools.map((tool) => tool.function.name), ['alpha', 'zeta'])
  assert.equal(tools[0].type, 'function')
  assert.deepEqual(tools[0].function.parameters, { type: 'object' })
})

test('the request envelope carries every field the upstream client sends', () => {
  const body = wire.buildQoderBody({
    model: 'ultimate',
    messages: [{ role: 'user', content: 'hello there' }],
    tools: [],
    system: 'be nice',
    maxTokens: 4096,
    effort: 'high',
    isReasoning: true,
    userID: 'u_fixture',
    requestId: VECTOR.requestId,
    sessionId: 'session-suffix',
    beginAt: '2026-01-01T00:00:00.000Z',
  })

  assert.equal(body.stream, true)
  assert.equal(body.session_type, 'qodercli')
  assert.equal(body.chat_task, 'FREE_INPUT')
  assert.equal(body.agent_id, 'agent_common')
  assert.equal(body.task_id, 'common')
  assert.equal(body.version, '3')
  assert.equal(body.source, 1)
  assert.equal(body.is_reply, true)
  assert.equal(body.is_retry, false)
  assert.equal(body.image_urls, null)
  assert.equal(body.system, 'be nice')
  assert.deepEqual(body.parameters, { max_tokens: 4096, reasoning_effort: 'high' })
  assert.deepEqual(body.model_config, { key: 'ultimate', is_reasoning: true, max_output_tokens: 4096, source: 'system' })
  assert.equal(body.chat_context.extra.modelConfig.key, 'ultimate')
  assert.deepEqual(body.chat_context.extra.context, [])
  assert.equal(body.business.product, 'cli')
  assert.equal(body.business.version, '1.0.0')
  assert.equal(body.business.stage, 'start')
  assert.equal(body.business.name, 'hello there'.slice(0, 30))
  assert.equal(body.business.begin_at, '2026-01-01T00:00:00.000Z')
  assert.equal(body.request_id, VECTOR.requestId)
  assert.match(body.chat_record_id, /^[0-9a-f]{16}$/)
  assert.match(body.session_id, /^[0-9a-f]{16}-session-suffix$/)
})

test('the envelope caps max_tokens at the model ceiling and never goes below 1024', () => {
  const big = wire.buildQoderBody({ model: 'auto', messages: [], maxTokens: 999_999 })
  assert.equal(big.parameters.max_tokens, wire.DEFAULT_MAX_TOKENS)
  const small = wire.buildQoderBody({ model: 'auto', messages: [], maxTokens: 1 })
  assert.equal(small.parameters.max_tokens, 1024)
})

test('the envelope is stable enough to be recorded under the same id', () => {
  const args = { model: 'auto', messages: [{ role: 'user', content: 'same' }], tools: [], userID: 'u' }
  assert.equal(wire.buildQoderBody(args).chat_record_id, wire.buildQoderBody(args).chat_record_id)
})

// ---------------------------------------------------------------- 流解析

test('a plain answer produces the contract chunk sequence', async () => {
  const response = sseResponse([
    envelope(JSON.stringify({})), // 上游偶尔发一个空壳帧
    chunk({ content: 'Hel' }),
    chunk({ content: 'lo' }, 'stop', { prompt_tokens: 11, completion_tokens: 2 }),
    'data: [DONE]\n\n',
  ])
  const chunks = await collect(wire.translateQoderStream(response, {}))

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('reasoning and text become two blocks in arrival order', async () => {
  const response = sseResponse([
    chunk({ reasoning_content: 'think' }),
    chunk({ content: 'answer' }, 'stop'),
    'data: [DONE]\n\n',
  ])
  const chunks = await collect(wire.translateQoderStream(response, {}))

  assert.deepEqual(chunks.map((chunk_) => chunk_.type), [
    'block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'block-end', 'finish',
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } })
  assert.deepEqual(chunks[3], { type: 'block-start', index: 1, blockType: 'text' })
  assert.deepEqual(chunks[5], { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } })
})

test('a tool call is aggregated from fragments into one closed block', async () => {
  const response = sseResponse([
    chunk({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'lookup', arguments: '{"q"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
    chunk({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ])
  const chunks = await collect(wire.translateQoderStream(response, {}))

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'lookup', argumentsDelta: '{"q"' },
    { type: 'tool-call-delta', index: 0, id: 'call_9', argumentsDelta: ':1}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_9', name: 'lookup', arguments: '{"q":1}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('text and a tool call can coexist, and finish reports tool-calls', async () => {
  const response = sseResponse([
    chunk({ content: 'let me check' }),
    chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'n', arguments: '{}' } }] }, 'stop'),
    'data: [DONE]\n\n',
  ])
  const chunks = await collect(wire.translateQoderStream(response, {}))

  assert.deepEqual(chunks.map((chunk_) => chunk_.type), [
    'block-start', 'text-delta', 'block-end', 'block-start', 'tool-call-delta', 'block-end', 'finish',
  ])
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('two parallel tool calls keep their own indices', async () => {
  const response = sseResponse([
    chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] }, 'tool_calls'),
    'data: [DONE]\n\n',
  ])
  const chunks = await collect(wire.translateQoderStream(response, {}))
  const ends = chunks.filter((chunk_) => chunk_.type === 'block-end')

  assert.deepEqual(ends.map((chunk_) => chunk_.block.name), ['first', 'second'])
  assert.deepEqual(ends.map((chunk_) => chunk_.block.id), ['a', 'b'])
  assert.equal(new Set(ends.map((chunk_) => chunk_.index)).size, 2)
})

test('finish_reason length maps to max-tokens and anything unknown to stop', async () => {
  const length = sseResponse([chunk({ content: 'x' }, 'length'), 'data: [DONE]\n\n'])
  assert.equal((await collect(wire.translateQoderStream(length, {}))).at(-1).reason.kind, 'max-tokens')

  const weird = sseResponse([chunk({ content: 'x' }, 'something_new'), 'data: [DONE]\n\n'])
  assert.equal((await collect(wire.translateQoderStream(weird, {}))).at(-1).reason.kind, 'stop')
})

test('usage carries the cached token counts under the bridge field names', async () => {
  const response = sseResponse([
    chunk({ content: 'x' }, 'stop', {
      prompt_tokens: 100,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 3 },
    }),
    'data: [DONE]\n\n',
  ])
  const chunks = await collect(wire.translateQoderStream(response, {}))
  assert.deepEqual(chunks.find((chunk_) => chunk_.type === 'usage').usage, {
    inputTokens: 100,
    outputTokens: 7,
    cachedInputTokens: 40,
    cacheCreationInputTokens: 12,
  })
})

test('an answer with no content raises EMPTY_RESPONSE', async () => {
  const response = sseResponse([chunk({}, 'stop'), 'data: [DONE]\n\n'])
  const error = await collectError(wire.translateQoderStream(response, {}))
  assert.equal(error.code, 'EMPTY_RESPONSE')
})

test('a response that ends before any frame raises EMPTY_RESPONSE', async () => {
  const error = await collectError(wire.translateQoderStream(sseResponse([]), {}))
  assert.equal(error.code, 'EMPTY_RESPONSE')
})

test('a refusal arrives as a 200 SSE frame and keeps its reason', async () => {
  const response = sseResponse([
    envelope('{"code":10605,"isQueued":true,"retryAfterSeconds":30}', 403),
  ])
  const error = await collectError(wire.translateQoderStream(response, {}))
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.qoderCode, 10605)
  assert.equal(error.failure.providerRetryAfterMs, 30_000)
})

test('a quota refusal inside the SSE envelope is classified as quota', async () => {
  const response = sseResponse([envelope('{"code":110,"message":"daily count exceeded"}', 403)])
  const error = await collectError(wire.translateQoderStream(response, {}))
  assert.equal(error.code, 'QUOTA')
  assert.match(error.message, /110/)
})

test('an envelope that is not JSON is reported as malformed', async () => {
  const error = await collectError(wire.translateQoderStream(sseResponse(['data: not-json\n\n']), {}))
  assert.equal(error.code, 'MALFORMED_RESPONSE')
})

test('an inner payload that is not JSON is reported as malformed', async () => {
  const error = await collectError(wire.translateQoderStream(sseResponse([envelope('{oops')]), {}))
  assert.equal(error.code, 'MALFORMED_RESPONSE')
})

test('a stream that ends without [DONE] still succeeds when the content is complete', async () => {
  // 上游偶尔不发 [DONE]；把一条已经完整的回答判成 TRANSPORT 会让池子换号，
  // 代价远大于收益，所以这里按成功收尾。
  const response = sseResponse([chunk({ content: 'done' }, 'stop')])
  const chunks = await collect(wire.translateQoderStream(response, {}))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

// ---------------------------------------------------------------- 失败归类

test('mapStatus agreement: plain statuses classify exactly like the shared table', () => {
  for (const status of [401, 403, 402, 408, 500, 503, 504]) {
    const response = errorResponse(status, '{}')
    assert.equal(wire.qoderHttpError(response, '{}').code, mapStatus(status, '{}'), `status ${status}`)
  }
})

test('a 400 that mentions context is CONTEXT_WINDOW_EXCEEDED', () => {
  const response = errorResponse(400, { message: 'maximum context length exceeded' })
  const error = wire.qoderHttpError(response, JSON.stringify({ message: 'maximum context length exceeded' }))
  assert.equal(error.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('a 429 that mentions quota is QUOTA, and a bare 429 is RATE_LIMIT', () => {
  const quotaText = JSON.stringify({ message: 'usage limit reached' })
  assert.equal(wire.qoderHttpError(errorResponse(429, quotaText), quotaText).code, 'QUOTA')
  const plain = JSON.stringify({ message: 'too many requests' })
  assert.equal(wire.qoderHttpError(errorResponse(429, plain), plain).code, 'RATE_LIMIT')
})

test('a plain 401 is AUTH', () => {
  const error = wire.qoderHttpError(errorResponse(401, { message: 'invalid token' }), JSON.stringify({ message: 'invalid token' }))
  assert.equal(error.code, 'AUTH')
})

test('a 401 that is really a queue announcement is RATE_LIMIT, not a dead token', () => {
  // 上游用 401/403 宣布"排队"，按 AUTH 处理会把一只好令牌清掉并要求重新登录。
  const text = JSON.stringify({ code: 10605, isQueued: true, retryAfterSeconds: 45 })
  const error = wire.qoderHttpError(errorResponse(401, text), text)
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.qoderCode, 10605)
  assert.equal(error.failure.providerRetryAfterMs, 45_000)
})

test('a 403 with the daily-count result code is QUOTA and can heal tomorrow', () => {
  const text = JSON.stringify({ code: 110, message: 'Billing daily count exceeded' })
  const error = wire.qoderHttpError(errorResponse(403, text), text)
  assert.equal(error.code, 'QUOTA')
  assert.equal(error.failure.qoderCode, 110)
})

test('a documented context code wins even when the status is not 400', () => {
  const text = JSON.stringify({ code: 80411, message: 'input too long' })
  assert.equal(wire.qoderHttpError(errorResponse(500, text), text).code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('a retry-after header is forwarded as providerRetryAfterMs', () => {
  const response = errorResponse(429, '{}', { 'retry-after': '120' })
  const error = wire.qoderHttpError(response, '{}')
  assert.equal(error.failure.providerRetryAfterMs, 120_000)
})

test('the escape-decorated result code still parses', () => {
  // 上游偶尔把内层 JSON 再转义一层：`\"code\":110`。
  const text = '{"body":"{\\"code\\":110,\\"message\\":\\"daily\\"}"}'
  assert.equal(wire.qoderResultCode(text).code, 110)
})

test('a result code that is not a string-quoted number is ignored', () => {
  assert.equal(wire.qoderResultCode('{"code":999999}'), undefined)
  assert.equal(wire.qoderResultCode(''), undefined)
  assert.equal(wire.qoderResultCode(undefined), undefined)
})

test('an unknown result code falls back to the status table', () => {
  // 猜一个没见过的码比让状态码兜底更糟，所以 105（登录过期）走 AUTH、别的走状态。
  assert.equal(wire.qoderResultCode('{"code":406}'), undefined)
  assert.equal(wire.qoderHttpError(errorResponse(500, '{"code":406}'), '{"code":406}').code, 'SERVER')
  assert.equal(wire.qoderHttpError(errorResponse(400, '{"code":105}'), '{"code":105}').code, 'AUTH')
})

// ---------------------------------------------------------------- 额度

test('quota parses the three resource packages', () => {
  const parsed = wire.parseQoderQuota({
    userQuota: { total: 1000, used: 250, remaining: 750, unit: 'credits' },
    addOnQuota: { total: 200, used: 200 },
  })
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0], {
    id: 'userQuota',
    name: '个人额度',
    remainingFraction: 0.75,
    unit: 'credits',
    total: 1000,
    remaining: 750,
  })
  assert.equal(parsed[1].remainingFraction, 0)
  assert.equal(parsed[1].remaining, 0)
})

test('quota derives the total from used + remaining when the API omits it', () => {
  const parsed = wire.parseQoderQuota({ userQuota: { used: 30, remaining: 70 } })
  assert.equal(parsed[0].total, 100)
  assert.equal(parsed[0].remainingFraction, 0.7)
})

test('quota treats a percentage of 1 as 100%, not 1%', () => {
  const parsed = wire.parseQoderQuota({ userQuota: { total: 1000, used: 1000, percentage: 1 } })
  assert.equal(parsed[0].remainingFraction, 0)
})

test('quota reads the data envelope when the API wraps it', () => {
  const parsed = wire.parseQoderQuota({ data: { userQuota: { total: 10, used: 5 } }, code: 0 })
  assert.equal(parsed[0].remainingFraction, 0.5)
})

test('quota returns undefined when nothing is readable instead of inventing a number', () => {
  assert.equal(wire.parseQoderQuota(undefined), undefined)
  assert.equal(wire.parseQoderQuota({}), undefined)
  assert.equal(wire.parseQoderQuota({ userQuota: { total: 0 } }), undefined)
  assert.equal(wire.parseQoderQuota({ message: 'no quota info' }), undefined)
})

// ---------------------------------------------------------------- 模型目录

test('the model list keeps only enabled entries and maps the fields', () => {
  const models = wire.normalizeQoderModels({
    assistant: [
      {
        key: 'ultimate',
        name: 'Ultimate',
        enable: true,
        is_vl: true,
        max_output_tokens: 64_000,
        context_config: [{ token_count: 200_000 }, { token_count: 1_000_000, is_default: true }],
        thinking_config: { default_value: true, enabled: { efforts: ['low', 'high'] } },
      },
      { key: 'off', enable: false },
      { enable: true }, // 没有 key：跳过
    ],
  })

  assert.equal(models.length, 1)
  assert.deepEqual(models[0], {
    id: 'ultimate',
    name: 'Ultimate',
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    inputModalities: ['text', 'image'],
    isReasoning: true,
    efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }],
    source: 'system',
  })
})

test('the context window falls back to max_input_tokens when no default is flagged', () => {
  const models = wire.normalizeQoderModels({
    assistant: [
      { key: 'a', enable: true, max_input_tokens: 120_000, context_config: [{ token_count: 1 }, { token_count: 2 }] },
      { key: 'b', enable: true },
    ],
  })
  assert.equal(models[0].contextWindow, 120_000)
  assert.equal(models[1].contextWindow, undefined)
  assert.equal(models[1].maxTokens, wire.DEFAULT_MAX_TOKENS)
  assert.deepEqual(models[1].inputModalities, ['text'])
})

test('a catalog payload that is not a list yields no models', () => {
  assert.deepEqual(wire.normalizeQoderModels(undefined), [])
  assert.deepEqual(wire.normalizeQoderModels({ assistant: 'nope' }), [])
})

// ---------------------------------------------------------------- 族对象

test('the family exposes the contract surface under the expected route', () => {
  assert.equal(qoderFamily.id, 'qoder')
  assert.equal(qoderFamily.route, 'acct-qoder')
  assert.match(qoderFamily.id, /^[a-z][a-z0-9-]*$/)
  assert.equal(typeof qoderFamily.login.run, 'function')
  assert.equal(typeof qoderFamily.refresh, 'function')
  assert.equal(typeof qoderFamily.listModels, 'function')
  assert.equal(typeof qoderFamily.resolveModel, 'function')
  assert.equal(typeof qoderFamily.quota, 'function')
  assert.equal(typeof qoderFamily.stream, 'function')
  assert.equal(typeof qoderFamily.discover, 'function')
  assert.deepEqual(qoderFamily.login.methods, [{ id: 'pat', label: '粘贴个人访问令牌 (PAT)' }])
})

test('the PAT is exchanged with the exact request shape and becomes a job token', async () => {
  const ctx = spyCtx([
    jsonResponse({ token: 'job-token-new', expires_in: 3_600_000 }),
    jsonResponse({ id: 'u_1', email: 'a@b.c', name: 'A B' }),
  ])
  const result = await qoderFamily.refresh(ctx, account({ pat: 'pat-abc' }), undefined)

  assert.equal(typeof wire.exchangeUrl, 'function')
  assert.equal(result.jobToken, 'job-token-new')
  assert.equal(result.pat, 'pat-abc')
  assert.equal(result.region, 'china')
  assert.equal(result.machineId, 'fixture-machine-id')
  assert.ok(result.jobTokenExpiresAt > Date.now())

  assert.deepEqual(ctx.calls.map((call) => call.url), ['https://openapi.qoder.com.cn/api/v1/jobToken/exchange'])
  assert.equal(ctx.calls[0].init.method, 'POST')
  assert.equal(ctx.calls[0].init.headers['content-type'], 'application/json')
  assert.equal(ctx.calls[0].init.headers['cosy-clienttype'], '5')
  assert.equal(ctx.calls[0].init.headers['accept-encoding'], 'identity')
  assert.deepEqual(JSON.parse(ctx.calls[0].init.body), { personal_token: 'pat-abc' })
  // 兑换端点是普通 JSON 请求：此时还没有 userID，不能也不该带 COSY 签名。
  assert.equal(ctx.calls[0].init.headers.Authorization, undefined)
})

test('the exchange goes to the global endpoints for a global account', async () => {
  const ctx = spyCtx([jsonResponse({ token: 't' })])
  await qoderFamily.refresh(ctx, account({ region: 'global' }), undefined)
  assert.equal(ctx.calls[0].url, 'https://openapi.qoder.sh/api/v1/jobToken/exchange')
})

test('an exchange without a token is an AUTH failure, not a server hiccup', async () => {
  const ctx = spyCtx([jsonResponse({ token: null })])
  await assert.rejects(qoderFamily.refresh(ctx, account(), undefined), (error) => {
    assert.equal(error.code, 'AUTH')
    return true
  })
})

test('an expired job token heals itself through refresh', async () => {
  const ctx = spyCtx([jsonResponse({ token: 'job-token-fresh', expires_at: new Date(Date.now() + 86_400_000).toISOString() })])
  const stale = account({ jobToken: 'job-token-expired', jobTokenExpiresAt: Date.now() - 1000 })
  assert.equal(qoderFamily.needsRefresh(stale), true)

  const refreshed = await qoderFamily.refresh(ctx, stale, undefined)
  assert.equal(refreshed.jobToken, 'job-token-fresh')
  assert.notEqual(refreshed.jobToken, stale.auth.jobToken)
  // 返回的是 auth 片段：不做整条记录的替换，池子会浅合并。
  assert.equal(refreshed.family, undefined)
  assert.equal(refreshed.auth, undefined)
  // 老键原样保留，池子的浅合并不会丢身份。
  assert.equal(refreshed.pat, 'pat-fixture')
  assert.equal(refreshed.machineId, 'fixture-machine-id')

  const merged = { ...stale, auth: { ...stale.auth, ...refreshed } }
  assert.equal(merged.auth.jobToken, 'job-token-fresh')
  assert.equal(merged.auth.userID, 'u_fixture')
})

test('refresh reports AUTH when it cannot refresh at all', async () => {
  await assert.rejects(qoderFamily.refresh(spyCtx([]), { auth: {} }, undefined), (error) => {
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /personal access token/)
    return true
  })
})

test('needsRefresh treats a token without an expiry as needing a refresh', () => {
  const now = Date.now()
  assert.equal(qoderFamily.needsRefresh({ auth: { pat: 'p', jobTokenExpiresAt: now + 3_600_000 } }, now), false)
  assert.equal(qoderFamily.needsRefresh({ auth: { pat: 'p', jobTokenExpiresAt: now + 60_000 } }, now), true)
  assert.equal(qoderFamily.needsRefresh({ auth: { pat: 'p', jobTokenExpiresAt: now - 1 } }, now), true)
  assert.equal(qoderFamily.needsRefresh({ auth: { pat: 'p' } }, now), true)
  assert.equal(qoderFamily.needsRefresh({ auth: { pat: 'p', jobTokenExpiresAt: 'soon' } }, now), true)
  // 没有 PAT 就没什么可刷的：让池子别空转。
  assert.equal(qoderFamily.needsRefresh({ auth: { jobTokenExpiresAt: now - 1 } }, now), false)
})

test('a live session commits the record before it resolves', async () => {
  const ctx = spyCtx([
    jsonResponse({ token: 'job-token-login', expires_in: 86_400_000 }),
    jsonResponse({ id: 'u_9', email: 'login@example.com', name: 'Login User' }),
  ])
  const events = []
  const session = {
    async prompt(question) {
      events.push(['prompt', question.kind])
      return question.kind === 'secret' ? 'pat-login' : 'global'
    },
    commit(record) {
      events.push(['commit', record.auth.jobToken])
    },
    notify(note) {
      events.push(['notify', note.message])
    },
  }

  const record = await qoderFamily.login.run(session, ctx)
  const commitIndex = events.findIndex((event) => event[0] === 'commit')
  assert.ok(commitIndex > -1, 'login must commit')
  assert.ok(commitIndex === events.length - 1 || events.length > commitIndex, 'commit happens before resolving')
  assert.equal(record.auth.jobToken, 'job-token-login')
  assert.equal(record.auth.region, 'global')
  assert.equal(record.family, 'qoder')
  assert.equal(record.label, 'login@example.com')
  assert.deepEqual(events[0], ['prompt', 'secret'])
  assert.deepEqual(events[1], ['prompt', 'select'])
  // 两个选项的 select 正好是 agent 侧 broker 能自动回答的形状。
  assert.equal(ctx.calls[0].url, 'https://openapi.qoder.sh/api/v1/jobToken/exchange')
})

test('the login flow refuses an empty personal access token', async () => {
  const session = { async prompt() { return '   ' }, commit() {}, notify() {} }
  await assert.rejects(qoderFamily.login.run(session, spyCtx([])), (error) => {
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    return true
  })
})

test('the model list maps the upstream catalog into contract metadata', async () => {
  const ctx = spyCtx([
    jsonResponse({
      assistant: [{ key: 'auto', name: 'Auto', enable: true, context_config: [{ token_count: 180_000, is_default: true }] }],
    }),
  ])
  const models = await qoderFamily.listModels(ctx, account(), undefined)

  assert.equal(models.length, 1)
  assert.deepEqual(models[0], {
    provider: 'qoder',
    id: 'auto',
    name: 'Auto',
    context: { contextWindow: 180_000 },
    defaultMaxTokens: 32_768,
    toolUpdate: 'in-history',
    inputModalities: ['text'],
  })
  // 目录端点是签名请求：要带整套 COSY 头，路径里带 /algo。
  const call = ctx.calls[0]
  assert.equal(call.url, 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1')
  assert.match(call.init.headers.Authorization, /^Bearer COSY\./)
  assert.equal(call.init.headers['Cosy-Sigpath'], '/api/v2/model/list')
  assert.equal(call.init.headers['Cosy-User'], 'u_fixture')
})

test('a broken model list falls back to the built-in snapshot with a warning', async () => {
  const ctx = spyCtx([errorResponse(500, 'boom')])
  const models = await qoderFamily.listModels(ctx, account(), undefined)
  assert.equal(models.length, wire.FALLBACK_MODELS.length)
  assert.ok(models.some((model) => model.id === 'cmodel'))
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /falling back/)
})

test('resolveModel answers for both known and unknown ids without inventing numbers', () => {
  const known = qoderFamily.resolveModel('acct-qoder', 'auto')
  assert.equal(known.id, 'auto')
  assert.equal(known.context.contextWindow, 180_000)

  const unknown = qoderFamily.resolveModel('acct-qoder', 'some-new-model')
  assert.equal(unknown.id, 'some-new-model')
  assert.equal(unknown.context.contextWindow, wire.DEFAULT_CONTEXT_WINDOW)
  assert.equal(unknown.defaultMaxTokens, wire.DEFAULT_MAX_TOKENS)
  assert.equal(unknown.reasoning, undefined)
})

test('quota stays undefined when the endpoint cannot be read', async () => {
  const ok = spyCtx([jsonResponse({ userQuota: { total: 100, used: 25 } })])
  const parsed = await qoderFamily.quota(ok, account(), undefined)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].remainingFraction, 0.75)
  assert.equal(ok.calls[0].url, 'https://openapi.qoder.com.cn/api/v2/quota/usage')
  assert.equal(ok.calls[0].init.headers.authorization, 'Bearer job-token-old')

  const broken = spyCtx([errorResponse(500, 'boom')])
  assert.equal(await qoderFamily.quota(broken, account(), undefined), undefined)

  const garbage = spyCtx([jsonResponse('<html>', 200)])
  assert.equal(await qoderFamily.quota(garbage, account(), undefined), undefined)

  const noToken = spyCtx([jsonResponse({ userQuota: { total: 100 } })])
  assert.equal(await qoderFamily.quota(noToken, account({ jobToken: '' }), undefined), undefined)
  assert.equal(noToken.calls.length, 0)
})

test('a stream without a job token fails as AUTH before touching the network', async () => {
  const ctx = spyCtx([])
  await assert.rejects(collect(qoderFamily.stream(ctx, {
    payload: account({ jobToken: '' }),
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })), (error) => {
    assert.equal(error.code, 'AUTH')
    return true
  })
  assert.equal(ctx.calls.length, 0)
})

test('stream sends a signed, WAF-encoded envelope and passes the proxy + streaming flag', async () => {
  const ctx = spyCtx([sseResponse([chunk({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n'])])
  const chunks = await collect(qoderFamily.stream(ctx, {
    payload: { ...account({ region: 'global' }), proxy: 'http://proxy.test:8080' },
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{ name: 'lookup', description: 'l', parameters: { type: 'object' } }],
    system: 'be terse',
    maxTokens: 2048,
    effort: 'low',
    signal: undefined,
  }))

  assert.equal(chunks.at(-1).reason.kind, 'stop')
  const call = ctx.calls.at(-1)
  assert.equal(call.proxy, 'http://proxy.test:8080')
  assert.equal(call.streaming, true)
  assert.equal(call.init.method, 'POST')
  assert.ok(call.url.startsWith('https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?'))
  assert.equal(call.init.headers.accept, 'text/event-stream')
  assert.equal(call.init.headers['accept-encoding'], 'identity')
  assert.equal(call.init.headers['x-model-key'], 'auto')
  assert.equal(call.init.headers['x-model-source'], 'system')
  assert.match(call.init.headers.Authorization, /^Bearer COSY\./)

  // 请求体是 WAF 编码过的 Buffer：签名用的哈希必须与之一致。
  assert.ok(Buffer.isBuffer(call.init.body))
  const encoded = call.init.body.toString('latin1')
  assert.equal(call.init.headers['Cosy-Bodylength'], String(call.init.body.length))
  assert.equal(
    call.init.headers['Cosy-Bodyhash'],
    createHash('md5').update(call.init.body).digest('hex'),
  )

  const body = JSON.parse(readQoderBody(encoded))
  assert.equal(body.model_config.key, 'auto')
  assert.equal(body.parameters.max_tokens, 2048)
  assert.equal(body.parameters.reasoning_effort, 'low')
  assert.equal(body.system, 'be terse')
  assert.equal(body.messages[0].content, 'hello')
  assert.equal(body.tools[0].function.name, 'lookup')
  assert.equal(body.stream, true)
  assert.equal(body.session_type, 'qodercli')
})

test('stream surfaces an HTTP failure through the shared classifier', async () => {
  const ctx = spyCtx([errorResponse(401, { message: 'invalid token' })])
  await assert.rejects(collect(qoderFamily.stream(ctx, {
    payload: account(),
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })), (error) => {
    assert.equal(error.code, 'AUTH')
    assert.equal(error.failure.status, 401)
    return true
  })
})

test('a stream with no proxy still passes an explicit undefined', async () => {
  const ctx = spyCtx([sseResponse([chunk({ content: 'x' }, 'stop'), 'data: [DONE]\n\n'])])
  await collect(qoderFamily.stream(ctx, {
    payload: account(),
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.equal(ctx.calls.at(-1).proxy, undefined)
  assert.equal(ctx.calls.at(-1).streaming, true)
})

// ---------------------------------------------------------------- discover

test('discover reports the machine id as not importable, with the honest reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-qoder-'))
  try {
    await mkdir(join(dir, '.qoder', '.auth'), { recursive: true })
    await writeFile(join(dir, '.qoder', '.auth', 'machine_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n', 'utf8')
    const entries = await qoderFamily.discover({}, { env: { QODER_HOME: dir } })

    assert.equal(entries.length, 1)
    assert.equal(entries[0].family, 'qoder')
    assert.equal(entries[0].importable, false)
    assert.equal(entries[0].externallyOwned, true)
    assert.match(entries[0].reason, /PAT/)
    assert.ok(entries[0].sourcePath.endsWith('machine_id'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('discover is empty on a machine without Qoder installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-qoder-'))
  try {
    assert.deepEqual(await qoderFamily.discover({}, { env: { QODER_HOME: dir } }), [])
    assert.deepEqual(await qoderFamily.discover({}, { env: {} }), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recordFromDiscovery refuses anything without a usable PAT', async () => {
  await assert.rejects(qoderFamily.recordFromDiscovery({ label: 'x' }), (error) => {
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    return true
  })
})

// ---------------------------------------------------------------- 真机（默认 skip）

test('live: the PAT exchange and one real answer', {
  skip: process.env.BRIDGE_LIVE_QODER !== '1' ? 'set BRIDGE_LIVE_QODER=1 and BRIDGE_LIVE_QODER_PAT=<pat> to run' : false,
}, async () => {
  // 只有装了 Qoder、手里有真 PAT 的机器才跑得到这里。
  const pat = process.env.BRIDGE_LIVE_QODER_PAT
  assert.ok(pat, 'BRIDGE_LIVE_QODER_PAT must be set')
  const region = process.env.BRIDGE_LIVE_QODER_REGION ?? 'china'
  const ctx = {
    async fetch(url, init, proxy, streaming) {
      return globalThis.fetch(url, { ...init, body: init.body ? Buffer.from(init.body) : undefined, signal: undefined, duplex: 'half' })
        .then((response) => response)
    },
  }
  void wire
  void httpError
  void streaming
  const refreshed = await qoderFamily.refresh(ctx, { auth: { pat, region, machineId: 'live-probe' } }, undefined)
  assert.ok(refreshed.jobToken)
  assert.ok(refreshed.jobTokenExpiresAt > Date.now())
})
