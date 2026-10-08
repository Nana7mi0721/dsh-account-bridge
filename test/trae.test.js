/**
 * `trae` 族的测试。
 *
 * 三条原则，都是这一族特有的坑逼出来的：
 *
 *   1. **解密不能靠「加密再解密等于自己」自证**。测试自己按上游算法（盐、派生、
 *      摘要布局全部独立重写一遍）造密文，再让被测代码去解——两边共享的只有
 *      「Trae 的算法」这件事本身。真机上拿到的密文结构就是这样，所以这一步等价于
 *      用已知向量验证。另外还会直接钉死四组盐与两个算法头部的字节。
 *   2. **HTTP 200 不等于成功**。这一族几乎所有业务失败都是 200，所以「错误归类」
 *      的用例和「正常路径」的用例一样多。
 *   3. **`contextWindow` / `maxTokens` 必须是正整数**。宿主 `dsh-llm` 校验它，
 *      不满足是 **provider 级**失败（整族加载不出来），所以这个不变量要锁死。
 *
 * 真机联网的用例挂在 `BRIDGE_LIVE_TRAE === '1'` 后面，默认跳过——本机没有 Trae
 * 登录态（`%APPDATA%` 下没有 Trae 目录、`~/.trae` 里没有 storage.json），
 * 这几条**没有被验证过**，不要当成已验证。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  AUTH_STORAGE_KEY,
  CHAT_PATH,
  FALLBACK_MODELS,
  IDE_VERSION,
  REFRESH_CLIENT_ID,
  VERSION_CODE,
  chatFunctionFor,
  chatHeaders,
  classifyStreamEvent,
  decryptTraeStorageValue,
  detailFunctionsFor,
  encryptionType,
  envelopeError,
  exchangeBody,
  finishKind,
  normalizeTraeMessages,
  normalizeTraeTools,
  normalizeVersionCode,
  parseCheckinResult,
  parseDetailParam,
  parseEntitlementUsage,
  parseRemoteCatalog,
  parseTraeAuthValue,
  preferStrongerRow,
  prepareTraeBody,
  refreshClientId,
  streamCodeKind,
  streamCodeMessage,
  streamError,
  toolCallDeltas,
  translateTraeStream,
  ugHeaders,
  usageFromEvent,
} from '../src/wire/trae.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DESKTOP_VARIANTS,
  LOGIN_CALLBACK_PORT,
  LOGIN_CALLBACK_PATH,
  cliTokenPaths,
  desktopStoragePaths,
  discover,
  decodeJwtPayload,
  deriveDeviceId,
  deriveMachineId,
  expiresAtFromToken,
  buildLoginUrl,
  extractStorage,
  isRealDeviceId,
  listModels,
  modelInfo,
  needsRefresh,
  newDeviceId,
  parseLoginCallback,
  parseStorageAuth,
  quota,
  recordFromDiscovery,
  refresh,
  resolveModel,
  timeToMs,
  traeFamily,
} from '../src/families/trae.js'

/* ------------------------------------------------------------------ *
 * 测试夹具
 * ------------------------------------------------------------------ */

/** 造 AEAD 之外的密文：与上游算法逐字节一致，但盐表在测试里独立写一份。 */
const TEST_SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52,
  142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46,
  161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
])
const TEST_SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229,
  122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4,
  126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
])
const TEST_SALT_C = Uint8Array.from([
  191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211,
  102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18,
  140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209,
])
const TEST_SALT_D = Uint8Array.from([
  246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54,
  244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86,
  56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170,
])

const HEADER_AES = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00])
const HEADER_AES_PRIVATE = Buffer.from([0x12, 0x39, 0x20, 0x20, 0x02, 0x03])

function xorBytes(a, b) {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)))
}

/**
 * 按上游算法造一段密文。**这是独立的第二实现**：它不复用被测代码的任何函数，
 * 所以「解出来等于原文」是有意义的断言。
 */
function encryptTraeStorageValue(plaintext, { type = 'aes', random } = {}) {
  const prefix = type === 'aes-private' ? HEADER_AES_PRIVATE : HEADER_AES
  const nonce = Buffer.from(random ?? randomBytes(32))
  assert.equal(nonce.length, 32)
  const salt = type === 'aes-private' ? xorBytes(TEST_SALT_C, TEST_SALT_D) : xorBytes(TEST_SALT_A, TEST_SALT_B)
  const first = createHash('sha512').update(nonce).digest()
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const body = Buffer.concat([createHash('sha512').update(Buffer.from(plaintext, 'utf8')).digest(), Buffer.from(plaintext, 'utf8')])
  const cipher = createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.concat([prefix, nonce, encrypted]).toString('base64')
}

/** 造一个 SSE Response。事件写成数组，`event` 为空表示上游只发 `data:`。 */
function sseResponse(events, { status = 200, headers = {} } = {}) {
  const chunks = []
  for (const entry of events) {
    const event = typeof entry === 'string' ? { data: entry } : entry
    let block = ''
    if (event.event !== undefined && event.event !== '') block += `event: ${event.event}\n`
    const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
    for (const line of String(data).split('\n')) block += `data: ${line}\n`
    chunks.push(`${block}\n`)
  }
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/**
 * 记录每一次上游调用的 ctx。`handler(url, init, callIndex)` 返回 Response。
 * 顺便断言了「上游调用一律经 ctx.fetch」——族里任何一次直接 `fetch` 都不会进 calls。
 */
function recordingCtx(handler) {
  const calls = []
  return {
    calls,
    ctx: {
      log: { info() {}, warn() {}, debug() {}, error() {} },
      async fetch(url, init, proxy, streaming) {
        const call = { url: String(url), init, proxy, streaming, headers: init?.headers ?? {}, body: init?.body }
        calls.push(call)
        return handler(call, calls.length - 1)
      },
    },
  }
}

function authFixture(overrides = {}) {
  return {
    accessToken: 'jwt-access-token',
    refreshToken: 'refresh-token',
    machineId: 'a'.repeat(64),
    deviceId: '1711320556112436',
    versionCode: VERSION_CODE,
    region: 'cn',
    ...overrides,
  }
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

async function expectRejection(promise, code) {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code, `expected code=${code}, got ${error.code} (${error.message})`)
    return error
  }
  throw new Error(`expected rejection with code=${code}`)
}

/* ------------------------------------------------------------------ *
 * 一、Electron storage.json 的 AES-128-CBC 解密
 * ------------------------------------------------------------------ */

test('decrypt: round-trips a ciphertext built by an independent implementation', () => {
  const plaintext = JSON.stringify({ accessToken: 'tok', refreshToken: 'ref', expiresAt: 1_800_000_000 })
  const encoded = encryptTraeStorageValue(plaintext)
  assert.equal(decryptTraeStorageValue(encoded), plaintext)
})

test('decrypt: handles the aes-private salt pair as well', () => {
  const plaintext = '{"accessToken":"private"}'
  assert.equal(decryptTraeStorageValue(encryptTraeStorageValue(plaintext, { type: 'aes-private' })), plaintext)
})

test('decrypt: the two algorithm headers are matched byte for byte', () => {
  assert.equal(encryptionType(HEADER_AES), 'aes')
  assert.equal(encryptionType(HEADER_AES_PRIVATE), 'aes-private')
  // 差一个字节就必须抛——猜错算法只会得到一段乱码，不会得到异常。
  const wrong = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x01])
  assert.throws(() => encryptionType(wrong), /unsupported auth encryption header/u)
})

test('decrypt: reads the algorithm out of the ciphertext, not out of a parameter', () => {
  // 同一份明文、同样的 random，两种头必须解出同样的结果——如果实现把类型搞混，
  // 两条里必然有一条摘要校验失败。
  const random = Buffer.alloc(32, 7)
  const plaintext = '{"accessToken":"x"}'
  const aes = encryptTraeStorageValue(plaintext, { random })
  const aesPrivate = encryptTraeStorageValue(plaintext, { random, type: 'aes-private' })
  assert.notEqual(aes, aesPrivate)
  assert.equal(decryptTraeStorageValue(aes), plaintext)
  assert.equal(decryptTraeStorageValue(aesPrivate), plaintext)
})

test('decrypt: rejects a corrupted payload instead of returning garbage', () => {
  const encoded = encryptTraeStorageValue('{"accessToken":"tamper-me"}')
  const bytes = Buffer.from(encoded, 'base64')
  bytes[bytes.length - 1] ^= 0xff
  assert.throws(() => decryptTraeStorageValue(bytes.toString('base64')), /integrity check failed|bad decrypt|wrong final block/u)
})

test('decrypt: rejects ciphertext that is too short to be well formed', () => {
  assert.throws(() => decryptTraeStorageValue(Buffer.alloc(64).toString('base64')), /too short/u)
})

test('decrypt: plaintext values starting with { bypass decryption entirely', () => {
  const plaintext = '{"accessToken":"hand-written"}'
  assert.equal(parseTraeAuthValue(`  ${plaintext}  `), plaintext)
})

test('decrypt: the four salts stay exactly 64 bytes and the derived key is 32 bytes', () => {
  // 盐表是硬编码的；这一条防的是「顺手格式化把数组改短了」这类事故。
  for (const salt of [TEST_SALT_A, TEST_SALT_B, TEST_SALT_C, TEST_SALT_D]) assert.equal(salt.length, 64)
  const encoded = encryptTraeStorageValue('{"accessToken":"s"}')
  const derived = createHash('sha512').update(Buffer.alloc(0)).digest()
  assert.equal(derived.length, 64)
  assert.equal(decryptTraeStorageValue(encoded).includes('accessToken'), true)
})

/* ------------------------------------------------------------------ *
 * 二、私有请求信封
 * ------------------------------------------------------------------ */

test('envelope: model and config_name must carry the same value', () => {
  const body = prepareTraeBody({ model: 'glm-5.3', messages: [] })
  assert.equal(body.model, 'glm-5.3')
  assert.equal(body.config_name, 'glm-5.3')
  assert.equal(body.stream, true)
  // 默认 function 是 solo_work_lite；调用方会用目录里学到的那个覆盖它。
  assert.equal(body.function, 'solo_work_lite')
})

test('envelope: config_name follows the wire config name, not the display id', () => {
  const body = prepareTraeBody({ model: 'GLM-5.2', config_name: 'glm-5.2', messages: [] })
  assert.equal(body.model, 'GLM-5.2')
  assert.equal(body.config_name, 'glm-5.2')
})

test('envelope: content is array-ified and developer becomes system', () => {
  const messages = normalizeTraeMessages([
    { role: 'developer', content: 'be terse' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '' },
  ])
  assert.deepEqual(messages[0], { role: 'system', content: [{ type: 'text', text: 'be terse' }] })
  assert.deepEqual(messages[1], { role: 'user', content: [{ type: 'text', text: 'hello' }] })
  // 空字符串内容上游不认，转成一个空数组而不是 [{text:''}]。
  assert.deepEqual(messages[2], { role: 'assistant', content: [] })
})

test('envelope: array content passes through untouched', () => {
  const content = [{ type: 'text', text: 'already structured' }]
  const [message] = normalizeTraeMessages([{ role: 'user', content }])
  assert.deepEqual(message.content, content)
})

test('envelope: assistant tool_calls[].function is RENAMED to function_call', () => {
  const [message] = normalizeTraeMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    },
  ])
  assert.equal(message.tool_calls[0].function, undefined, '上游读的是 function_call，留着 function 只会两边都发')
  assert.deepEqual(message.tool_calls[0].function_call, { name: 'read_file', arguments: '{"path":"a"}' })
  assert.equal(message.tool_calls[0].id, 'call_1')
})

test('envelope: tool_calls without a name are dropped, and an empty list disappears', () => {
  const [message] = normalizeTraeMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: '', arguments: '{}' } }] },
  ])
  assert.equal('tool_calls' in message, false)
})

test('envelope: tool result messages without tool_call_id are dropped, not forwarded', () => {
  const messages = normalizeTraeMessages([
    { role: 'tool', content: 'result' },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].tool_call_id, 'call_1')
})

test('envelope: tools[].function.parameters is stringified', () => {
  const tools = normalizeTraeTools([
    { type: 'function', function: { name: 'read_file', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ])
  assert.equal(typeof tools[0].function.parameters, 'string')
  assert.deepEqual(JSON.parse(tools[0].function.parameters), { type: 'object', properties: { path: { type: 'string' } } })
})

test('envelope: a tool without a legal function is dropped', () => {
  assert.deepEqual(normalizeTraeTools([{ type: 'function', function: { name: '' } }, {}]), [])
})

test('envelope: OpenAI-only fields are NOT forwarded', () => {
  const body = prepareTraeBody({
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.7,
    max_tokens: 4096,
    tool_choice: 'auto',
    response_format: { type: 'json_object' },
    top_p: 0.9,
  })
  for (const key of ['temperature', 'max_tokens', 'tool_choice', 'response_format', 'top_p']) {
    assert.equal(key in body, false, `${key} 不是这个端点的字段，多发一个就可能让每个模型都校验失败`)
  }
})

test('envelope: an empty tools array does not add a tools key', () => {
  assert.equal('tools' in prepareTraeBody({ model: 'm', messages: [], tools: [] }), false)
})

/* ------------------------------------------------------------------ *
 * 三、请求头
 * ------------------------------------------------------------------ */

test('headers: Authorization uses Cloud-IDE-JWT, never Bearer', () => {
  const headers = chatHeaders(authFixture(), { stream: true })
  assert.equal(headers.Authorization, 'Cloud-IDE-JWT jwt-access-token')
  assert.equal(headers.Authorization.includes('Bearer'), false)
  assert.equal(headers['X-Ide-Token'], 'jwt-access-token')
  assert.equal(headers['X-Cloudide-Token'], 'jwt-access-token')
})

test('headers: chat requests carry the full IDE identity set', () => {
  const headers = chatHeaders(authFixture(), { stream: true })
  assert.equal(headers.Accept, 'text/event-stream')
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['X-Ide-Version'], IDE_VERSION)
  // 版本码决定上游返回哪张模型表，纯数字，且必须是 20260820 这一支。
  assert.equal(headers['X-Ide-Version-Code'], VERSION_CODE)
  assert.equal(headers['X-App-Version-Code'], VERSION_CODE)
  assert.equal(headers['X-App-Id'], '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
  assert.equal(headers['X-Device-Id'], '1711320556112436')
  assert.equal(headers['X-Machine-Id'], 'a'.repeat(64))
  assert.equal(headers['Request-Traffic-Type'], 'prod')
  assert.equal(headers['X-Ide-Version-Type'], 'stable')
})

test('headers: non-streaming requests ask for JSON', () => {
  assert.equal(chatHeaders(authFixture(), { stream: false }).Accept, 'application/json')
})

test('headers: a dotted build version must not leak into the version code', () => {
  // 客户端存储里的 iCubeLastVersion 形如 2.3.76922；上游把这个字段绑定成数字，
  // 点分串的后果是 4001（参数类型不匹配），而不是「版本不认识」。
  const headers = chatHeaders(authFixture({ versionCode: '2.3.76922' }), { stream: true })
  assert.equal(headers['X-Ide-Version-Code'], '20260716')
  assert.equal(normalizeVersionCode('2.3.76922'), '20260716')
  assert.equal(normalizeVersionCode('20260820'), '20260820')
  assert.equal(normalizeVersionCode(undefined), '20260716')
})

test('headers: the check-in/credits identity is a DIFFERENT client from the chat one', () => {
  const chat = chatHeaders(authFixture(), { stream: true })
  const ug = ugHeaders(authFixture())
  assert.equal(ug['User-Agent'], 'VSCode 1.107.1 (TRAE SOLO CN)')
  assert.equal(chat['User-Agent'], 'Trae/0.1.61')
  assert.notEqual(ug['User-Agent'], chat['User-Agent'])
  // X-Market-Client-Id 与 UA 同源但**不带 CN 后缀**。
  assert.equal(ug['X-Market-Client-Id'], 'VSCode 1.107.1')
  assert.equal(ug.Accept, '*/*')
  assert.equal(ug['Sec-Fetch-Mode'], 'no-cors')
  assert.equal(ug['X-User-Region'], 'CN')
  assert.equal(ug.Authorization, 'Cloud-IDE-JWT jwt-access-token')
})

test('headers: the market user id is only sent once it has been persisted', () => {
  assert.equal('X-Market-User-Id' in ugHeaders(authFixture()), false)
  const ug = ugHeaders(authFixture({ marketUserId: '00000000-0000-4000-8000-000000000000' }))
  assert.equal(ug['X-Market-User-Id'], '00000000-0000-4000-8000-000000000000')
})

/* ------------------------------------------------------------------ *
 * 四、私有 SSE 事件模型
 * ------------------------------------------------------------------ */

test('sse: classifies every documented event kind', () => {
  assert.equal(classifyStreamEvent({ event: 'output', data: '{"response":"hi"}' }).kind, 'delta')
  assert.equal(classifyStreamEvent({ event: 'token_usage', data: '{"prompt_tokens":1}' }).kind, 'usage')
  assert.equal(classifyStreamEvent({ event: 'done', data: '{"finish_reason":"stop"}' }).kind, 'done')
  assert.equal(classifyStreamEvent({ event: 'error', data: '{"code":1005}' }).kind, 'error')
  assert.equal(classifyStreamEvent({ event: 'progress_notice', data: '{"stage":"x"}' }).kind, 'unknown')
  assert.equal(classifyStreamEvent({ event: 'request_wait_in_queue', data: '{"position":3}' }).kind, 'queued')
  assert.equal(classifyStreamEvent({ event: '', data: '[DONE]' }).kind, 'done')
})

test('sse: recognises events by payload shape when the batch carries no event name', () => {
  // 有些批次不带 `event:`，只能靠形状认——只认名字会把这些批次的正文全丢掉。
  assert.equal(classifyStreamEvent({ event: '', data: '{"response":"hi"}' }).kind, 'delta')
  assert.equal(classifyStreamEvent({ event: '', data: '{"reasoning_content":"hmm"}' }).kind, 'delta')
  assert.equal(classifyStreamEvent({ event: '', data: '{"finish_reason":"stop"}' }).kind, 'done')
  assert.equal(classifyStreamEvent({ event: 'message', data: '{"tool_calls":[{"index":0}]}' }).kind, 'delta')
})

test('sse: unknown events are preserved losslessly instead of being dropped', () => {
  // progress_notice 在 5 份历史日志里出现过 7829 次；不认识就丢等于丢内容。
  const event = classifyStreamEvent({ event: 'some_new_event', data: '{"whatever":1}' })
  assert.equal(event.kind, 'unknown')
  assert.equal(event.event, 'some_new_event')
  assert.equal(event.data, '{"whatever":1}')
})

test('sse: translates text, reasoning, usage and finish in contract order', async () => {
  const response = sseResponse([
    { event: 'output', data: { response: 'Hel' } },
    { event: 'output', data: { response: 'lo' } },
    { event: 'output', data: { reasoning_content: 'thinking' } },
    { event: 'token_usage', data: { prompt_tokens: 11, completion_tokens: 4, cache_read_input_tokens: 2 } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ])
  const chunks = await collect(translateTraeStream(response, {}))

  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'Hel' })
  assert.deepEqual(chunks[2], { type: 'text-delta', index: 0, text: 'lo' })
  assert.deepEqual(chunks[3], { type: 'block-start', index: 1, blockType: 'reasoning' })
  assert.deepEqual(chunks[4], { type: 'reasoning-delta', index: 1, text: 'thinking' })
  assert.deepEqual(chunks[5], { type: 'usage', usage: { inputTokens: 11, outputTokens: 4, cachedInputTokens: 2 } })
  assert.deepEqual(chunks[6], { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })
  assert.deepEqual(chunks[7], { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'thinking' } })
  assert.deepEqual(chunks[8], { type: 'finish', reason: { kind: 'stop' } })
})

test('sse: block-end carries the full text so the pool knows the turn produced output', async () => {
  const chunks = await collect(translateTraeStream(sseResponse([{ event: 'output', data: { response: 'done' } }]), {}))
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(end.block.text, 'done')
})

test('sse: tool calls accumulate arguments across deltas by index', async () => {
  const response = sseResponse([
    { event: 'output', data: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } },
    { event: 'output', data: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } },
    { event: 'done', data: { finish_reason: 'tool_calls' } },
  ])
  const chunks = await collect(translateTraeStream(response, {}))
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('sse: tool call deltas accept the function_call spelling too', () => {
  const deltas = toolCallDeltas({ tool_calls: [{ index: 2, function_call: { name: 'n', arguments: '{}' } }] })
  assert.deepEqual(deltas, [{ index: 2, name: 'n', argumentsDelta: '{}' }])
  // 顶层形状（没有 function 包一层）也要认。
  assert.deepEqual(toolCallDeltas({ tool_calls: [{ name: 'top', arguments: 'x' }] }), [{ index: 0, name: 'top', argumentsDelta: 'x' }])
})

test('sse: usage fields are optional and never invented', () => {
  assert.deepEqual(usageFromEvent({ prompt_tokens: 5 }), { inputTokens: 5 })
  assert.deepEqual(usageFromEvent({}), {})
})

test('sse: a tool-call turn with no finish_reason still finishes as tool-calls', () => {
  assert.equal(finishKind(undefined, { hasToolCalls: true }), 'tool-calls')
  assert.equal(finishKind(undefined, { hasToolCalls: false }), 'stop')
})

test('sse: finish kinds are restricted to the three values the host understands', () => {
  const allowed = new Set(['stop', 'tool-calls', 'max-tokens'])
  for (const reason of ['stop', 'tool_calls', 'length', 'max_tokens', 'end_turn', 'eos', 'weird', undefined, 'success', 'tool-use']) {
    const kind = finishKind(reason)
    assert.equal(allowed.has(kind), true, `finish reason ${String(reason)} produced ${kind}`)
  }
  assert.equal(finishKind('length'), 'max-tokens')
  assert.equal(finishKind('tool_use'), 'tool-calls')
})

test('sse: an empty stream throws EMPTY_RESPONSE so the pool may retry elsewhere', async () => {
  const error = await expectRejection(collect(translateTraeStream(sseResponse([]), {})), 'EMPTY_RESPONSE')
  assert.match(error.message, /EMPTY_RESPONSE/u)
})

test('sse: progress notices alone do NOT count as output', async () => {
  // 只有进度提示没有正文，等于什么都没回答——必须抛 EMPTY_RESPONSE，而不是吐一个空 finish。
  const response = sseResponse([
    { event: 'progress_notice', data: { stage: 'thinking' } },
    { event: 'progress_notice', data: { stage: 'still thinking' } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ])
  await expectRejection(collect(translateTraeStream(response, {})), 'EMPTY_RESPONSE')
})

test('sse: an error event after partial output still surfaces the business code', async () => {
  const response = sseResponse([
    { event: 'output', data: { response: 'partial' } },
    { event: 'error', data: { code: 4008, message: 'Your requests have exceeded the quota', extra: '{"plan":1}' } },
  ])
  const error = await expectRejection(collect(translateTraeStream(response, {})), 'ACCOUNT_QUOTA')
  assert.match(error.message, /配额/u)
})

test('sse: a stream that ends without done still closes its blocks', async () => {
  const chunks = await collect(translateTraeStream(sseResponse([{ event: 'output', data: { response: 'half' } }]), {}))
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(end.block.text, 'half')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

/* ------------------------------------------------------------------ *
 * 五、HTTP 200 里藏着的业务错误
 * ------------------------------------------------------------------ */

test('codes: the documented business codes map onto pool action codes', () => {
  assert.equal(streamCodeKind(1005), 'ACCOUNT_QUOTA', '需付费套餐 → 换号 + 长冷却')
  assert.equal(streamCodeKind(4008), 'ACCOUNT_QUOTA', '该账号没这个模型的配额，与积分余额无关')
  assert.equal(streamCodeKind(4011), 'MODEL_UNAVAILABLE', '该 function 不服务此模型')
  assert.equal(streamCodeKind(4001), 'MODEL_UNAVAILABLE')
  assert.equal(streamCodeKind(1001), 'AUTH')
  assert.equal(streamCodeKind(9074), 'CHECKIN_DENIED')
  assert.equal(streamCodeKind(9095), 'CHECKIN_ALREADY')
})

test('codes: 4011 and 4008 must not be classified as generic client errors', () => {
  // 归成 unknown 只冷 30 秒，坏号转头又被选中——这正是 traework 注释里记的那个坑。
  assert.notEqual(streamCodeKind(4011), 'SERVER')
  assert.notEqual(streamCodeKind(4008), 'SERVER')
  assert.equal(streamCodeKind(999999), undefined)
})

test('codes: the user-facing text is generated from the code, never from the lying message', () => {
  // 4011 的 message 谎称是 rate limit；4008 的 message 会被误解成积分不足。
  // 文案一律由 code 生成：把上游 message 原样转述出来，用户会照着「过一会儿再试」去等一个必然失败的东西。
  assert.match(streamCodeMessage(4011), /不服务该模型/u)
  assert.match(streamCodeMessage(4011), /谎称/u)
  assert.match(streamCodeMessage(4008), /积分余额是两回事/u)
  assert.match(streamCodeMessage(1005), /付费套餐/u)
  // 即使上游 message 递进来，已知码的文案也不该被它顶掉。
  // 用**上游原话**当探针（`4011` 的实际 message 就是 "rate limit exceeded"），
  // 而不是拿本族自己的文案里出现过的词去断言——那种断言会把正确实现判成失败。
  assert.equal(streamCodeMessage(4011, '{"message":"rate limit exceeded"}').includes('exceeded'), false)
})

test('codes: an unknown code still produces a readable, non-fatal error', () => {
  const error = streamError(4242, '{"message":"something new"}')
  assert.equal(error.code, 'SERVER')
  assert.match(error.message, /4242/u)
  assert.match(error.message, /something new/u)
})

test('codes: a 200 envelope with a non-zero code is an error, not a success', () => {
  assert.equal(envelopeError({ code: 0 }, 200), undefined)
  assert.equal(envelopeError({ Result: {} }, 200), undefined, '刷新端点的正常响应里没有 code 字段')
  const error = envelopeError({ code: 1005, message: 'need a paid plan' }, 200)
  assert.equal(error.code, 'ACCOUNT_QUOTA')
  assert.equal(error.failure.status, 200)
})

/* ------------------------------------------------------------------ *
 * 六、模型目录：function 归属、取强、正整数元数据
 * ------------------------------------------------------------------ */

test('catalog: the detail parser keeps the owning function, not just the model id', () => {
  const rows = parseDetailParam(
    { config_info_list: [{ config_name: 'glm-5.3', display_config: { display_name: 'GLM-5.3' }, max_context_tokens: 200_000 }] },
    'solo_work_remote',
  )
  const row = rows.get('glm-5.3')
  assert.equal(row.wireFunction, 'solo_work_remote')
  assert.equal(row.wireConfigName, 'glm-5.3')
  assert.equal(row.name, 'GLM-5.3')
})

test('catalog: a model that only exists in solo_work_remote keeps that function', () => {
  // glm-5.3 在 solo_work_lite 下报 4001、在 solo_work_remote 下正常（实测 2026-09-15）。
  const rows = new Map()
  for (const [id, row] of parseDetailParam({ config_info_list: [{ config_name: 'glm-5.2', max_context_tokens: 100_000 }] }, 'solo_work_lite')) rows.set(id, row)
  for (const [id, row] of parseDetailParam({ config_info_list: [{ config_name: 'glm-5.3', max_context_tokens: 200_000 }] }, 'solo_work_remote')) rows.set(id, preferStrongerRow(row, rows.get(id)))
  assert.equal(rows.get('glm-5.2').wireFunction, 'solo_work_lite')
  assert.equal(rows.get('glm-5.3').wireFunction, 'solo_work_remote')
})

test('catalog: solo_agent can never be used as a chat function', () => {
  // 拿 solo_agent 发聊天会让它名下 8 个模型全部 4011（message 谎称 rate limit）。
  assert.equal(chatFunctionFor('cn', 'solo_agent'), 'solo_work_remote')
  assert.equal(chatFunctionFor('ai', 'solo_agent'), 'solo_work_remote')
  assert.equal(chatFunctionFor('cn', 'solo_work_remote'), 'solo_work_remote')
  assert.equal(chatFunctionFor('cn', 'solo_work_lite'), 'solo_work_lite')
  assert.equal(chatFunctionFor('cn', undefined), 'solo_work_remote')
  assert.equal(chatFunctionFor('cn', undefined, 'solo_work_lite'), 'solo_work_lite')
})

test('catalog: the directory function list is wider than the chat function list', () => {
  // 两个名单必须分开维护：远端目录可以问 solo_agent（它是 19 个模型的唯一来源），
  // 聊天名单里绝不能有它。
  assert.equal(detailFunctionsFor('cn').includes('solo_agent'), false)
  assert.equal(detailFunctionsFor('ai').includes('solo_coder'), false, '国际区没有 solo_coder')
  assert.equal(detailFunctionsFor('cn').includes('solo_coder'), true)
})

test('catalog: the same id in several groups is resolved by a deterministic four-level order', () => {
  const devOnlySmall = { id: 'glm-5.2', contextWindow: 116_000, maxContextWindow: 1_000_000 }
  const devOnlyLarge = { id: 'glm-5.2', contextWindow: 200_000, maxContextWindow: 1_000_000 }
  // ③ Max 相等 → 取更宽的常规窗口（实测 chat_v3 报 116000、solo_agent_remote 报 200000）。
  assert.equal(preferStrongerRow(devOnlyLarge, devOnlySmall).contextWindow, 200_000)
  assert.equal(preferStrongerRow(devOnlySmall, devOnlyLarge).contextWindow, 200_000)
  // ① 有 Max 层的胜过没有。
  const withMax = { id: 'm', contextWindow: 50_000, maxContextWindow: 1_000_000 }
  const withoutMax = { id: 'm', contextWindow: 400_000 }
  assert.equal(preferStrongerRow(withMax, withoutMax).contextWindow, 50_000)
  assert.equal(preferStrongerRow(withoutMax, withMax).contextWindow, 50_000)
  // ② 两个都有 Max 层时取更大的 Max。
  assert.equal(preferStrongerRow({ id: 'm', maxContextWindow: 2_000_000 }, { id: 'm', maxContextWindow: 1_000_000 }).maxContextWindow, 2_000_000)
  // ④ 全相等保留先到者（引用不变，便于断言「没有无谓替换」）。
  const first = { id: 'm', contextWindow: 1 }
  assert.equal(preferStrongerRow({ id: 'm', contextWindow: 1 }, first), first)
})

test('catalog: max_mode is the only thing that may raise the window', () => {
  const rows = parseDetailParam(
    { config_info_list: [{ config_name: 'a', max_context_tokens: 100_000, max_mode_context_tokens: 1_000_000, max_mode: false }] },
    'solo_work_lite',
  )
  assert.equal(rows.get('a').contextWindow, 100_000)
  assert.equal(rows.get('a').maxContextWindow, undefined, '组里没报 max_mode 就不能凭空认一个更大的窗口')
})

test('catalog: the remote catalog unions every function group', () => {
  // 只读 solo_agent_remote 会静默少 9 个模型（issue #19）。
  const rows = parseRemoteCatalog({
    data: {
      functions: [
        { function: 'solo_agent', config_info_list: [{ config_name: 'gpt-6-astra', max_context_tokens: 272_000 }] },
        { function: 'solo_agent_remote', config_info_list: [{ config_name: 'glm-5.2', max_context_tokens: 200_000 }] },
      ],
    },
  })
  assert.equal(rows.size, 2)
  assert.equal(rows.get('gpt-6-astra').wireFunction, 'solo_agent')
  assert.equal(rows.get('glm-5.2').wireFunction, 'solo_agent_remote')
})

test('catalog: modelInfo always returns positive integer context metadata', () => {
  // 宿主 dsh-llm 校验 Number.isInteger(contextWindow) && contextWindow > 0；
  // 不满足是 **provider 级**失败（整族加载不出来，INVALID_MODEL_CONTEXT）。
  for (const row of [{}, { contextWindow: 0, maxTokens: 0 }, { contextWindow: -1, maxTokens: -1 }, { contextWindow: 1.5, maxTokens: 'x' }, { id: 'm', name: 'M' }]) {
    const info = modelInfo(row)
    assert.equal(Number.isInteger(info.context.contextWindow), true, JSON.stringify(row))
    assert.equal(info.context.contextWindow > 0, true, JSON.stringify(row))
    assert.equal(Number.isInteger(info.defaultMaxTokens), true, JSON.stringify(row))
    assert.equal(info.defaultMaxTokens > 0, true, JSON.stringify(row))
  }
  // 目录里读到的值要原样保留，不能被兜底覆盖。
  assert.equal(modelInfo({ id: 'x', contextWindow: 272_000, maxTokens: 8_192 }).context.contextWindow, 272_000)
  assert.equal(modelInfo({ id: 'x', contextWindow: 272_000, maxTokens: 8_192 }).defaultMaxTokens, 8_192)
})

test('catalog: every fallback model carries a positive contextWindow', () => {
  // issue #8 的根因就是兜底目录缺这个字段——provider 直接加载失败。
  assert.equal(FALLBACK_MODELS.length > 0, true)
  for (const model of FALLBACK_MODELS) {
    assert.equal(Number.isInteger(model.contextWindow) && model.contextWindow > 0, true, model.id)
    assert.equal(Number.isInteger(model.maxTokens) && model.maxTokens > 0, true, model.id)
  }
})

test('catalog: entries always declare the route as provider and never claim image support', () => {
  const info = modelInfo({ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 })
  assert.equal(info.provider, 'acct-trae')
  assert.equal(info.toolUpdate, 'in-history')
  // 这一族不转发图片（消息体只构造 text 块），所以不能声明 image。
  assert.deepEqual(info.inputModalities, ['text'])
})

test('catalog: resolveModel falls back conservatively for an unknown id', () => {
  const info = resolveModel('acct-trae', 'never-listed-model')
  assert.equal(info.id, 'never-listed-model')
  assert.equal(info.context.contextWindow, DEFAULT_CONTEXT_WINDOW)
  assert.equal(Number.isInteger(info.defaultMaxTokens), true)
})

test('catalog: listModels unions the functions and sends the numeric version code', async () => {
  const { ctx, calls } = recordingCtx((call) => {
    const body = JSON.parse(call.body)
    if (body.function === 'solo_work_lite') {
      return jsonResponse({ code: 0, data: { config_info_list: [{ config_name: 'glm-5.2', display_config: { display_name: 'GLM-5.2' }, max_context_tokens: 116_000 }] } })
    }
    if (body.function === 'solo_work_remote') {
      return jsonResponse({ code: 0, data: { config_info_list: [{ config_name: 'glm-5.3', max_context_tokens: 200_000 }] } })
    }
    return jsonResponse({ code: 0, data: { config_info_list: [] } })
  })
  const models = await listModels(ctx, { auth: authFixture(), proxy: 'http://proxy.invalid:8080' }, undefined)
  const ids = models.map((model) => model.id).sort()
  assert.deepEqual(ids, ['glm-5.2', 'glm-5.3'])
  assert.equal(models.every((model) => Number.isInteger(model.context.contextWindow)), true)
  for (const call of calls) {
    assert.equal(call.url, 'https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param')
    assert.equal(call.headers['X-Ide-Version-Code'], VERSION_CODE)
    assert.equal(call.streaming, undefined, '目录请求不是流式的，第 4 参不该传 true')
    assert.equal(call.proxy, 'http://proxy.invalid:8080')
  }
})

test('catalog: listModels throws instead of inventing a catalog', async () => {
  const { ctx } = recordingCtx(() => jsonResponse({ code: 500, message: 'boom' }))
  await assert.rejects(() => listModels(ctx, { auth: authFixture(), proxy: 'http://proxy.invalid:8080' }, undefined))
})

/* ------------------------------------------------------------------ *
 * 七、刷新（返回 auth 对象、浅合并、不写客户端文件）
 * ------------------------------------------------------------------ */

test('refresh: returns a new auth object with every mutable key present', async () => {
  const { ctx, calls } = recordingCtx(() =>
    jsonResponse({ Result: { Token: 'new-access', RefreshToken: 'new-refresh', TokenExpireAt: 1_900_000_000 } }),
  )
  const auth = await refresh(ctx, { auth: authFixture(), proxy: 'http://proxy.invalid:8080' })
  assert.equal(auth.accessToken, 'new-access')
  assert.equal(auth.refreshToken, 'new-refresh')
  assert.equal(auth.expiresAt, 1_900_000_000_000)
  // 池子是**浅合并**：这些键不带就会保留旧值（甚至更糟：被 undefined 吃掉）。
  assert.equal(auth.machineId, 'a'.repeat(64))
  assert.equal(auth.deviceId, '1711320556112436')
  assert.equal(auth.versionCode, VERSION_CODE)
  assert.equal(auth.region, 'cn')
  // 返回的是 auth 本身，不是整个 payload。
  assert.equal('family' in auth, false)
  assert.equal('auth' in auth, false)

  const call = calls[0]
  assert.equal(call.url, 'https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken')
  const body = JSON.parse(call.body)
  assert.equal(body.ClientID, REFRESH_CLIENT_ID, '默认取证据更完整的那一个 client_id')
  assert.equal(body.ClientSecret, '-')
  assert.equal(body.RefreshToken, 'refresh-token')
  assert.equal(body.UserID, '')
  // 刷新不带令牌本身，所以头里不该出现 Cloud-IDE-JWT。
  assert.equal(call.headers.Authorization, undefined)
})

test('refresh: a rotated refresh token replaces the old one, a missing one does not', async () => {
  const { ctx } = recordingCtx(() => jsonResponse({ Result: { Token: 'a2', TokenExpireAt: 1_900_000_000 } }))
  const auth = await refresh(ctx, { auth: authFixture() })
  assert.equal(auth.refreshToken, 'refresh-token', '上游没给新 refresh token ≠ 旧的作废')
})

test('refresh: TokenExpireDuration is honoured when TokenExpireAt is absent', async () => {
  const { ctx } = recordingCtx(() => jsonResponse({ Result: { Token: 'a3', TokenExpireDuration: 3600 } }))
  const before = Date.now()
  const auth = await refresh(ctx, { auth: authFixture() })
  assert.equal(auth.expiresAt >= before + 3_500_000, true)
  assert.equal(auth.expiresAt <= Date.now() + 3_600_000, true)
})

test('refresh: millisecond and second expiry values are told apart', async () => {
  const { ctx } = recordingCtx(() => jsonResponse({ Result: { Token: 'a4', TokenExpireAt: '1900000000000' } }))
  const auth = await refresh(ctx, { auth: authFixture() })
  assert.equal(auth.expiresAt, 1_900_000_000_000)
  assert.equal(timeToMs(1_900_000_000), 1_900_000_000_000)
  assert.equal(timeToMs(1_900_000_000_000), 1_900_000_000_000)
  assert.equal(timeToMs(0), undefined)
  assert.equal(timeToMs('not-a-date'), undefined)
})

test('refresh: an invalid grant surfaces as AUTH so the pool cools the account for a day', async () => {
  const { ctx } = recordingCtx(() => jsonResponse({ error: 'invalid_grant', message: 'refresh token revoked' }, { status: 400 }))
  await expectRejection(refresh(ctx, { auth: authFixture() }), 'AUTH')
})

test('refresh: a credential without a refresh token is not silently "refreshed"', async () => {
  // CLI 令牌文件里没有 refresh token；假装刷新成功会让它每次请求都白刷一遍。
  const { ctx, calls } = recordingCtx(() => jsonResponse({ Result: { Token: 'nope' } }))
  await expectRejection(refresh(ctx, { auth: { accessToken: 'only-access', region: 'cn' } }), 'AUTH')
  assert.equal(calls.length, 0, '没有 refresh token 就不该发这个请求')
})

test('refresh: an empty Result token is AUTH, not a silent success', async () => {
  const { ctx } = recordingCtx(() => jsonResponse({ Result: { RefreshToken: 'r2' } }))
  await expectRejection(refresh(ctx, { auth: authFixture() }), 'AUTH')
})

test('refresh: solo-sg uses a different path, client id and DeviceInfo block', async () => {
  const { ctx, calls } = recordingCtx(() => jsonResponse({ Result: { Token: 'sg', TokenExpireAt: 1_900_000_000 } }))
  await refresh(ctx, { auth: authFixture({ edition: 'solo-sg' }) })
  assert.equal(calls[0].url, 'https://api.trae.cn/trae/api/v3/oauth/ExchangeToken')
  assert.equal(JSON.parse(calls[0].body).ClientID, 'en1oxy7wnw8j9n')
  assert.equal(JSON.parse(calls[0].body).DeviceInfo.PlatformCode, 'SOLO_PC')
})

test('refresh: the source dispute is overridable per account', () => {
  // 两处跨源分歧都做成账号级常量：真机上发现一条路不通时，不用改代码。
  assert.equal(refreshClientId({}), REFRESH_CLIENT_ID)
  assert.equal(refreshClientId({ refreshClientId: 'en1oxy7wnw8j9n' }), 'en1oxy7wnw8j9n')
  assert.equal(refreshClientId({ refreshClientId: '   ' }), REFRESH_CLIENT_ID)
  assert.deepEqual(exchangeBody({ refreshToken: 'r', uid: 'u' }).ClientID, REFRESH_CLIENT_ID)
  assert.equal(exchangeBody({ refreshToken: 'r', uid: 'u', refreshClientId: 'custom' }).ClientID, 'custom')
})

test('refresh: the CN path and the default client id are the evidenced ones', () => {
  assert.equal(exchangeBody({ refreshToken: 'r', uid: 'u' }, 'x').ClientID, 'x')
  assert.equal(exchangeBody({ refreshToken: 'r' }).UserID, '')
})

test('needsRefresh: only claims a refresh when the expiry is actually known', () => {
  const now = 1_800_000_000_000
  assert.equal(needsRefresh({ auth: { expiresAt: now + 60 * 60_000, refreshToken: 'r' } }, now), false)
  assert.equal(needsRefresh({ auth: { expiresAt: now + 60_000, refreshToken: 'r' } }, now), true)
  // 没有过期时间、或没有 refresh token → 不声称要刷新（否则每次都走进一次注定失败的刷新）。
  assert.equal(needsRefresh({ auth: { refreshToken: 'r' } }, now), false)
  assert.equal(needsRefresh({ auth: { expiresAt: now, refreshToken: '' } }, now), false)
  assert.equal(needsRefresh({}, now), false)
})

/* ------------------------------------------------------------------ *
 * 八、额度（只读）
 * ------------------------------------------------------------------ */

test('quota: expired credit packs are skipped, not summed into the remainder', () => {
  // 签到积分是当日发放、31 天后过期的独立包；不滤掉就是把历史所有包累加进「剩余」。
  const now = 1_800_000_000
  const usage = parseEntitlementUsage(
    {
      user_entitlement_pack_list: [
        { entitlement_base_info: { quota: { credits_limit: 200 }, end_time: now - 10 }, usage: { credits_amount: 0 } },
        { entitlement_base_info: { quota: { credits_limit: 200 }, end_time: now + 10_000 }, usage: { credits_amount: 50 } },
        { entitlement_base_info: { quota: { credits_limit: 0 } }, usage: { credits_amount: 0 } },
      ],
    },
    now,
  )
  assert.deepEqual(usage, { limit: 200, used: 50, remaining: 150 })
})

test('quota: an unreadable payload returns undefined instead of a fake zero', () => {
  assert.equal(parseEntitlementUsage({}, 1), undefined)
  assert.equal(parseEntitlementUsage({ user_entitlement_pack_list: 'nope' }, 1), undefined)
  assert.equal(parseEntitlementUsage({ user_entitlement_pack_list: [] }, 1), undefined)
})

test('quota: reads the IDE endpoint with the plugin identity and swallows failures', async () => {
  const { ctx, calls } = recordingCtx(() =>
    jsonResponse({ code: 0, data: { user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 25 } }] } }),
  )
  const bars = await quota(ctx, { auth: authFixture(), proxy: 'http://proxy.invalid:8080' })
  assert.equal(bars.length, 1)
  assert.equal(bars[0].remainingFraction, 0.75)
  assert.equal(calls[0].url, 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage')
  assert.equal(calls[0].headers['User-Agent'], 'VSCode 1.107.1 (TRAE SOLO CN)')
  assert.deepEqual(JSON.parse(calls[0].body), { require_usage: true, req_source: 2 })
  assert.equal(calls[0].proxy, 'http://proxy.invalid:8080')

  const broken = recordingCtx(() => jsonResponse({ nope: true }))
  assert.equal(await quota(broken.ctx, { auth: authFixture() }), undefined)
  assert.equal(await quota(recordingCtx(() => jsonResponse({}, { status: 500 })).ctx, { auth: authFixture() }), undefined)
  assert.equal(await quota(recordingCtx(() => jsonResponse({})).ctx, { auth: {} }), undefined)
})

test('check-in codes are parsed honestly (the action itself is deliberately not implemented)', () => {
  assert.deepEqual(parseCheckinResult({ code: 9095, checked_in: true, credits: 0 }), { code: 9095, checkedIn: true, enable: false, credits: 0, message: '' })
  assert.equal(parseCheckinResult({ code: 9074, msg: '当前参与用户太多' }).message, '当前参与用户太多')
  // 本族不提供任何会自动改变账号状态的入口。
  assert.equal(typeof traeFamily, 'object')
  assert.equal('checkin' in traeFamily, false)
})

/* ------------------------------------------------------------------ *
 * 九、发现与导入
 * ------------------------------------------------------------------ */

async function withTempHome(run) {
  const root = await mkdtemp(join(tmpdir(), 'trae-test-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeDesktopStorage(root, dirName, document) {
  const path = join(root, 'AppData', 'Roaming', dirName, 'User', 'globalStorage', 'storage.json')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(document, null, 2), 'utf8')
  return path
}

const ENV = (root) => ({ TRAE_HOME: root, TRAE_APPDATA: join(root, 'AppData', 'Roaming') })

test('discover: a plaintext credential file is importable without any decryption', async () => {
  await withTempHome(async (root) => {
    const plain = { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1_900_000_000 }
    await writeDesktopStorage(root, 'TRAE SOLO CN', { [AUTH_STORAGE_KEY]: JSON.stringify(plain), 'iCubeLastVersion': '2.3.76922' })
    const items = await discover({}, { env: ENV(root), platform: 'win32' })
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, true)
    assert.equal(items[0].family, 'trae')
    assert.equal(items[0].auth.accessToken, 'a1')
    assert.equal(items[0].auth.edition, 'solo')
    // 点分构建串不能当 version-code 用。
    assert.equal(items[0].auth.versionCode, '20260716')
  })
})

test('discover: an encrypted credential file is decrypted and imported read-only', async () => {
  await withTempHome(async (root) => {
    const plain = { accessToken: 'enc-access', refreshToken: 'enc-refresh', expiresAt: 1_900_000_000, uid: 'u-1' }
    const path = await writeDesktopStorage(root, 'Trae CN', {
      [AUTH_STORAGE_KEY]: encryptTraeStorageValue(JSON.stringify(plain)),
      'iCubeLastVersion': '20260820',
      'telemetry.machineId': 'b'.repeat(64),
      'iCubeAuthInfo://icube-dc:abc': '1711320556112436',
    })
    const before = await readFile(path, 'utf8')
    const items = await discover({}, { env: ENV(root), platform: 'win32' })
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, true)
    assert.equal(items[0].auth.accessToken, 'enc-access')
    assert.equal(items[0].auth.refreshToken, 'enc-refresh')
    assert.equal(items[0].auth.machineId, 'b'.repeat(64))
    assert.equal(items[0].auth.deviceId, '1711320556112436')
    assert.equal(items[0].auth.versionCode, '20260820')
    assert.equal(items[0].auth.uid, 'u-1')
    // **只读**：发现过程绝不改动用户文件。
    assert.equal(await readFile(path, 'utf8'), before)
  })
})

test('discover: an undecryptable file is reported honestly and never rewritten', async () => {
  await withTempHome(async (root) => {
    const path = await writeDesktopStorage(root, 'Trae CN', { [AUTH_STORAGE_KEY]: Buffer.alloc(400, 3).toString('base64') })
    const before = await readFile(path, 'utf8')
    const items = await discover({}, { env: ENV(root), platform: 'win32' })
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, false)
    assert.match(items[0].reason, /解不开/u)
    assert.equal(await readFile(path, 'utf8'), before, '解不开的文件必须原封不动')
  })
})

test('discover: a client that is installed but not signed in says exactly that', async () => {
  await withTempHome(async (root) => {
    await mkdir(join(root, 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage'), { recursive: true })
    const items = await discover({}, { env: ENV(root), platform: 'win32' })
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, false)
    assert.match(items[0].reason, /没有登录/u)
  })
})

test('discover: nothing installed produces an empty list, not a fake entry', async () => {
  await withTempHome(async (root) => {
    assert.deepEqual(await discover({}, { env: ENV(root), platform: 'win32' }), [])
    assert.deepEqual(await discover({}, { env: ENV(root), platform: 'darwin' }), [])
  })
})

test('discover: the CLI token file is a plain, importable JWT', async () => {
  await withTempHome(async (root) => {
    const payload = { userId: 'cli-user', exp: 1_900_000_000 }
    const token = ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.')
    await mkdir(join(root, '.trae'), { recursive: true })
    await writeFile(join(root, '.trae', 'trae-jwt-token'), `${token}\n`, 'utf8')
    const items = await discover({}, { env: ENV(root), platform: 'win32' })
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, true)
    assert.equal(items[0].auth.accessToken, token)
    assert.equal(items[0].auth.uid, 'cli-user')
    assert.equal(items[0].auth.expiresAt, 1_900_000_000_000)
    assert.equal(items[0].auth.syntheticIdentity, true)
    // 没有 refresh token，就不假装能刷新。
    assert.equal(needsRefresh({ auth: items[0].auth }), false)
  })
})

test('discover: the CLI scan does not shadow a real desktop login', async () => {
  await withTempHome(async (root) => {
    await writeDesktopStorage(root, 'TRAE SOLO CN', { [AUTH_STORAGE_KEY]: JSON.stringify({ accessToken: 'desk', refreshToken: 'r' }) })
    await mkdir(join(root, '.trae'), { recursive: true })
    await writeFile(join(root, '.trae', 'trae-jwt-token'), 'a.b.c', 'utf8')
    const items = await discover({}, { env: ENV(root), platform: 'win32' })
    assert.deepEqual(items.map((item) => item.auth.accessToken).sort(), ['a.b.c', 'desk'])
  })
})

test('discover: a credential file without a token is not importable', async () => {
  await withTempHome(async (root) => {
    await writeDesktopStorage(root, 'Trae', { [AUTH_STORAGE_KEY]: JSON.stringify({ somethingElse: true }) })
    const items = await discover({}, { env: ENV(root), platform: 'win32' })
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, false)
  })
})

test('discover: broken JSON in storage.json is reported, not skipped', async () => {
  await withTempHome(async (root) => {
    const path = join(root, 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'storage.json')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{not json', 'utf8')
    const items = await discover({}, { env: ENV(root), platform: 'win32' })
    assert.equal(items[0].importable, false)
    assert.match(items[0].reason, /不是合法 JSON/u)
  })
})

test('discover: path candidates cover the four editions and the two CLI homes', () => {
  // 用正斜杠写根目录：node:path 在 win32 上会把它归一成反斜杠，而 `C:\AppData`
  // 里的 `\A` 会被 `join` 当成转义吃掉一个反斜杠——那是实现细节，不是被测行为。
  const paths = desktopStoragePaths({ TRAE_APPDATA: 'C:/AppData' }, 'win32')
  const suffix = ['User', 'globalStorage', 'storage.json'].join(sep)
  for (const dir of ['TRAE SOLO CN', 'trae-solo-cn', 'TRAE SOLO', 'trae-solo', 'Trae CN', 'trae-cn', 'Trae', 'trae']) {
    assert.equal(
      paths.some((entry) => entry.path.endsWith(`${dir}${sep}${suffix}`)),
      true,
      dir,
    )
  }
  // 路径断言只比**目录段**，不比分隔符：`join` 在 win32 上把 `/home/me` 变成 `\home\me`，
  // 用开头的斜杠写死会假失败（同一个原因，`C:\AppData` 里的 `\A` 也会被吃掉一个反斜杠）。
  const asPosix = (value) => value.replace(/\\/gu, '/')
  assert.equal(
    desktopStoragePaths({ TRAE_HOME: '/home/me' }, 'darwin').every((entry) =>
      asPosix(entry.path).includes('/home/me/Library/Application Support/'),
    ),
    true,
  )
  assert.equal(
    desktopStoragePaths({ TRAE_HOME: '/home/me' }, 'linux').every((entry) => asPosix(entry.path).startsWith('/home/me/.config/')),
    true,
  )
  const cli = cliTokenPaths({ TRAE_HOME: '/home/me' })
  assert.deepEqual(cli.map((entry) => asPosix(entry.path)).sort(), ['/home/me/.trae-cn/trae-jwt-token', '/home/me/.trae/trae-jwt-token'])
})

test('recordFromDiscovery: builds a credential record and refuses an empty one', async () => {
  const record = recordFromDiscovery({
    family: 'trae',
    sourcePath: 'C:\\x\\storage.json',
    label: 'Trae TRAE SOLO CN',
    auth: { accessToken: 'a', refreshToken: 'r' },
  })
  assert.equal(record.family, 'trae')
  assert.equal(record.source, 'client-import')
  // 凭据确实属于外部客户端；同时这个标记也是「我们不写回客户端文件」的说明位置。
  assert.equal(record.externallyOwned, true)
  assert.equal(record.sourcePath, 'C:\\x\\storage.json')
  await expectRejection(Promise.resolve().then(() => recordFromDiscovery({ auth: {} })), 'MISSING_CREDENTIAL')
})

test('identity: the machine id prefers the client telemetry value, else hex32', () => {
  // 分歧①：64 字符 telemetry.machineId（A 级证据）胜过合成的 hex32。
  assert.equal(deriveMachineId({ 'telemetry.machineId': 'c'.repeat(64) }), 'c'.repeat(64))
  assert.match(deriveMachineId({}, 'seed'), /^[0-9a-f]{32}$/u)
  // 分歧②：真实 Aha 设备号是 15–16 位纯数字，能用就用它。
  assert.equal(isRealDeviceId('1711320556112436'), true)
  assert.equal(isRealDeviceId('not-a-device'), false)
  assert.equal(deriveDeviceId({ 'iCubeAuthInfo://icube-dc:x': '1711320556112436' }, 'm').deviceId, '1711320556112436')
  assert.equal(deriveDeviceId({}, '1711320556112436').source, 'machine')
  assert.equal(deriveDeviceId({}, 'not-a-device').source, 'derived')
  assert.match(newDeviceId(), /^[1-9]\d{15}$/u)
})

test('identity: storage parsing keeps what is there and invents nothing', () => {
  const auth = parseStorageAuth({ accessToken: 'a', refreshToken: 'r' })
  assert.equal(auth.uid, undefined)
  assert.equal(auth.expiresAt, undefined)
  assert.throws(() => parseStorageAuth({ nothing: true }), /既没有 accessToken/u)
  const withIdentity = extractStorage({ 'iCubeLastVersion': '20260820' }, { accessToken: 'a' }, { region: 'cn' })
  assert.equal(withIdentity.versionCode, '20260820')
  assert.equal(withIdentity.region, 'cn')
  assert.equal(typeof withIdentity.machineId, 'string')
  assert.equal(typeof withIdentity.deviceId, 'string')
})

test('identity: jwt payloads are decoded without verifying the signature', () => {
  const token = `x.${Buffer.from(JSON.stringify({ exp: 1_800_000_000, iat: 1_700_000_000 })).toString('base64url')}.y`
  assert.equal(decodeJwtPayload(token).exp, 1_800_000_000)
  assert.equal(expiresAtFromToken(token), 1_800_000_000_000)
  // 不是 JWT 就不编一个过期时间出来。
  assert.equal(expiresAtFromToken('not-a-jwt'), undefined)
  assert.equal(expiresAtFromToken(undefined), undefined)
})

/* ------------------------------------------------------------------ *
 * 十、登录
 * ------------------------------------------------------------------ */

test('login: the authorization url carries the documented fixed parameters', () => {
  const url = new URL(buildLoginUrl({ machineId: 'm', deviceId: '1711320556112436' }))
  assert.equal(url.origin + url.pathname, 'https://www.trae.cn/authorization')
  const params = url.searchParams
  assert.equal(params.get('client_id'), 'en1oxy7wnw8j9n')
  assert.equal(params.get('auth_callback_url'), `http://127.0.0.1:${LOGIN_CALLBACK_PORT}${LOGIN_CALLBACK_PATH}`)
  assert.equal(params.get('auth_from'), 'solo')
  assert.equal(params.get('login_channel'), 'native_ide')
  assert.equal(params.get('auth_type'), 'local')
  assert.equal(params.get('machine_id'), 'm')
  assert.equal(params.get('device_id'), '1711320556112436')
  // 这个流程**没有** PKCE / scope / state，所以它们不该出现。
  assert.equal(params.get('code_challenge'), null)
  assert.equal(params.get('scope'), null)
  assert.equal(params.get('state'), null)
})

test('login: the callback is parsed from a full url or from the bare query', () => {
  const query = `refreshToken=rt-1&userInfo=${encodeURIComponent(JSON.stringify({ user_id: 'u9', email: 'a@b.c' }))}&userJwt=${encodeURIComponent(JSON.stringify({ token: 't' }))}`
  for (const raw of [`http://127.0.0.1:18080/authorize?${query}`, query]) {
    const parsed = parseLoginCallback(raw)
    assert.equal(parsed.refreshToken, 'rt-1')
    assert.equal(parsed.userInfo.user_id, 'u9')
    assert.equal(parsed.userJwt.token, 't')
  }
  // 双重编码的形态也要能解（有的批次就是 percent-encoded 两次）。
  const twice = `refreshToken=rt-2&userInfo=${encodeURIComponent(encodeURIComponent(JSON.stringify({ user_id: 'u2' })))}`
  assert.equal(parseLoginCallback(twice).userInfo.user_id, 'u2')
  assert.throws(() => parseLoginCallback(''), /回调内容为空/u)
  assert.throws(() => parseLoginCallback('http://127.0.0.1:18080/authorize?userInfo=%7B%7D'), /没有 refreshToken/u)
})

test('login: the family advertises its two methods and never exports a default', () => {
  assert.equal(traeFamily.id, 'trae')
  assert.equal(traeFamily.route, 'acct-trae')
  assert.equal(traeFamily.displayName, 'Trae')
  assert.deepEqual(traeFamily.login.methods.map((method) => method.id), ['browser', 'manual'])
  assert.equal(typeof traeFamily.login.run, 'function')
  assert.equal(typeof traeFamily.discover, 'function')
  assert.equal(typeof traeFamily.recordFromDiscovery, 'function')
  assert.equal(typeof traeFamily.refresh, 'function')
  assert.equal(typeof traeFamily.needsRefresh, 'function')
  assert.equal(typeof traeFamily.listModels, 'function')
  assert.equal(typeof traeFamily.resolveModel, 'function')
  assert.equal(typeof traeFamily.quota, 'function')
  assert.equal(typeof traeFamily.stream, 'function')
})

test('login: a failed manual paste fails loudly, and a good one commits before resolving', async () => {
  const committed = []
  const session = {
    method: 'manual',
    async prompt() {
      return 'http://127.0.0.1:18080/authorize?refreshToken=rt-3&userInfo=%7B%22user_id%22%3A%22u3%22%7D'
    },
    async commit(grant) {
      committed.push(grant)
    },
  }
  const { ctx: fetchCtx } = recordingCtx(() => jsonResponse({ Result: { Token: 'access-3', TokenExpireAt: 1_900_000_000 } }))
  await traeFamily.login.run(session, fetchCtx)
  assert.equal(committed.length, 1)
  assert.equal(committed[0].kind, 'grant')
  assert.equal(committed[0].payload.auth.accessToken, 'access-3')
  assert.equal(committed[0].payload.auth.refreshToken, 'rt-3')
  assert.equal(committed[0].payload.family, 'trae')

  const bad = { method: 'manual', async prompt() { return 'nope' }, async commit() { throw new Error('must not commit') } }
  await assert.rejects(() => traeFamily.login.run(bad, fetchCtx), /refreshToken/u)
})

/* ------------------------------------------------------------------ *
 * 十一、推理
 * ------------------------------------------------------------------ */

test('stream: sends one streaming request with the learned function and the full envelope', async () => {
  const { ctx, calls } = recordingCtx(() =>
    sseResponse([{ event: 'output', data: { response: 'ok' } }, { event: 'done', data: { finish_reason: 'stop' } }]),
  )
  // 先用一次目录调用让缓存学到 glm-5.3 属于 solo_work_remote。
  const { ctx: catalogCtx } = recordingCtx(() => jsonResponse({ code: 0, data: { config_info_list: [{ config_name: 'glm-5.3', max_context_tokens: 200_000 }] } }))
  await listModels(catalogCtx, { auth: authFixture() }, undefined)

  const chunks = await collect(
    traeFamily.stream(ctx, {
      payload: { auth: authFixture(), proxy: 'http://proxy.invalid:8080' },
      model: 'glm-5.3',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    }),
  )
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.url, `https://trae-api-cn.mchost.guru${CHAT_PATH}`)
  // **流式请求的第 4 参必须是 true**：否则配了代理的账号会在长推理里被
  // undici 的 30s bodyTimeout 掐断（表现为「说到一半莫名中断」）。
  assert.equal(call.streaming, true)
  assert.equal(call.proxy, 'http://proxy.invalid:8080')
  assert.equal(call.headers.Accept, 'text/event-stream')
  assert.equal(call.headers.Authorization, 'Cloud-IDE-JWT jwt-access-token')
  const body = JSON.parse(call.body)
  // 目录里学到的归属优先：走 solo_work_lite 会让 glm-5.3 报 4001。
  assert.equal(body.function, 'solo_work_remote')
  assert.equal(body.config_name, 'glm-5.3')
  assert.equal(body.model, 'glm-5.3')
  assert.equal(typeof body.tools[0].function.parameters, 'string')
  assert.deepEqual(body.messages[0], { role: 'system', content: [{ type: 'text', text: 'be terse' }] })
})

test('stream: a model with no catalog entry falls back instead of guessing a function', async () => {
  const { ctx, calls } = recordingCtx(() => sseResponse([{ event: 'output', data: { response: 'x' } }, { event: 'done', data: {} }]))
  await collect(traeFamily.stream(ctx, { payload: { auth: authFixture() }, model: 'totally-unknown', messages: [] }))
  const body = JSON.parse(calls[0].body)
  assert.equal(body.function, 'solo_work_remote')
  assert.equal(body.config_name, 'totally-unknown')
  assert.equal(body.stream, true)
})

test('stream: a non-2xx response is classified by the shared mapper', async () => {
  const { ctx } = recordingCtx(() => jsonResponse({ message: 'nope' }, { status: 401 }))
  await expectRejection(collect(traeFamily.stream(ctx, { payload: { auth: authFixture() }, model: 'm', messages: [] })), 'AUTH')
})

test('stream: an HTTP 200 JSON envelope with a business code is NOT treated as success', async () => {
  // 这是这一族最要命的一条：Trae 的业务失败几乎都是 200。
  const { ctx } = recordingCtx(() => jsonResponse({ code: 1005, message: '', extra: '{"plan":1}' }))
  await expectRejection(collect(traeFamily.stream(ctx, { payload: { auth: authFixture() }, model: 'm', messages: [] })), 'ACCOUNT_QUOTA')
})

test('stream: an empty JSON envelope is EMPTY_RESPONSE, not a silent empty answer', async () => {
  const { ctx } = recordingCtx(() => jsonResponse({ Result: {} }))
  await expectRejection(collect(traeFamily.stream(ctx, { payload: { auth: authFixture() }, model: 'm', messages: [] })), 'EMPTY_RESPONSE')
})

test('stream: a missing token is still sent upstream so the failure is a real 401', async () => {
  // 本地先抛会让「最后一次上游调用必须是流式」那条回归断言变成假失败。
  const { ctx, calls } = recordingCtx(() => jsonResponse({ message: 'unauthorized' }, { status: 401 }))
  await expectRejection(collect(traeFamily.stream(ctx, { payload: { auth: { region: 'cn' } }, model: 'm', messages: [] })), 'AUTH')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Authorization, 'Cloud-IDE-JWT ')
})

test('stream: the token never leaks into an error message or a log line', async () => {
  const logs = []
  const ctx = {
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m), error: (m) => logs.push(m) },
    async fetch() {
      return jsonResponse({ code: 1005, message: 'nope' })
    },
  }
  const error = await expectRejection(collect(traeFamily.stream(ctx, { payload: { auth: authFixture({ accessToken: 'SUPER-SECRET-TOKEN' }) }, model: 'm', messages: [] })), 'ACCOUNT_QUOTA')
  assert.equal(error.message.includes('SUPER-SECRET-TOKEN'), false)
  assert.equal(JSON.stringify(logs).includes('SUPER-SECRET-TOKEN'), false)
})

/* ------------------------------------------------------------------ *
 * 十二、真机（本机没有 Trae 登录态，全部跳过）
 * ------------------------------------------------------------------ */

test('live: a real account can list models and stream a reply', { skip: process.env.BRIDGE_LIVE_TRAE !== '1' }, async () => {
  // 这几条**没有被验证过**：本机 %APPDATA% 下没有 Trae 目录、~/.trae 里没有
  // storage.json，没有可用的 Trae 账号。设 BRIDGE_LIVE_TRAE=1 并在真机上跑之前，
  // 不要把它们当成已验证。
  const ctx = globalThis.__traeLiveCtx
  assert.ok(ctx, 'live 用例需要一个真宿主 ctx（由维护者在真机 profile 里注入）')
  const items = await discover(ctx)
  assert.equal(items.some((item) => item.importable), true)
})
