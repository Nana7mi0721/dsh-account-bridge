/**
 * WorkBuddy（腾讯 CodeBuddy / WorkBuddy AI）族的回归测试。
 *
 * 这里钉住的是「错了会悄悄说谎」或「错了会把用户的会话弄死」的几条：
 * - **5.6+ 的凭据是密文**：扫到了必须如实报「导不进来」，静默跳过等于告诉用户
 *   「这台机器上没有 WorkBuddy」；
 * - **凭据文件只读**：本族从不写回 App 的文件，任何一次写入都可能把用户的桌面端踢下线；
 * - **对话请求绝不带 refresh token**（参考实现的安全红线，`src/upstream.ts:396`）；
 * - **额度读不懂就不报**：编一个 0% 会让用户去充值，而问题其实在别处；
 * - **`stream()` 只发一次请求、且必须是流式**（契约 §5：用错 dispatcher 会在长回答
 *   中途把连接掐断，而且只在配了代理的账号上出现）。
 *
 * 真机/联网的用例默认 skip，用 `BRIDGE_LIVE_WORKBUDDY=1` 打开；
 * 本机登录文件是 5.6+ 密文，所以真跑起来还需要 `BRIDGE_LIVE_WORKBUDDY_TOKEN=<accessToken>`
 * （可选 `BRIDGE_LIVE_WORKBUDDY_REFRESH` / `_DOMAIN` / `_REGION=global`）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  FALLBACK_ACCESS_TTL_SEC,
  REFRESH_SKEW_MS,
  VARIANTS,
  workbuddyFamily,
  authCandidates,
  classifyAuthDocument,
  discover,
  expiryToMs,
  modelInfo,
  parseDesktopAuth,
  workbuddyHomeDir,
} from '../src/families/workbuddy.js'
import { normalizeChatBody, prepareInternationalChatBody, readEnvelope } from '../src/wire/workbuddy.js'

const CN_DIR = join('AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
const CN_FILE = join(CN_DIR, 'workbuddy-desktop.info')
const ROAMING_DIR = join('AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth')

/** 明文登录文件（嵌套形，和本机 5.5 的写法一致）。 */
function plaintextDoc({ access = 'wb-access-1', refresh = 'wb-refresh-1', uid = 'aaaaaaaa-1111-2222-3333-444444444444', domain = 'dept-abcdef123456', expiresAt = 1_794_039_425_060 } = {}) {
  return {
    account: { uid, uin: '123456789012', enterpriseId: '', type: 'personal' },
    accounts: [],
    allAccounts: [],
    auth: {
      accessToken: access,
      refreshToken: refresh,
      tokenType: 'Bearer',
      expiresIn: 2_592_000,
      expiresAt,
      refreshExpiresAt: expiresAt + 2_592_000_000,
      domain,
      sessionState: 'session-state-value',
    },
  }
}

/**
 * 5.6+ 的密文包装。
 *
 * 测试里**不碰真机那一份**：只按 `parseWrappedField` 认的形状造一个合成信包。
 */
function encryptedField(overrides = {}) {
  const envelope = {
    suite: 1,
    keyId: '0123456789abcdef',
    nonce: Buffer.alloc(12, 7).toString('base64'),
    authTag: Buffer.alloc(16, 9).toString('base64'),
    ciphertext: Buffer.from('synthetic-ciphertext-not-a-real-token').toString('base64'),
    ...overrides,
  }
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope)).toString('base64') }
}

function encryptedDoc() {
  return {
    ...plaintextDoc(),
    auth: { ...plaintextDoc().auth, accessToken: encryptedField(), refreshToken: encryptedField() },
  }
}

/** 假 ctx：记下 `fetch` 的四个参数，按 `handler` 给响应。 */
function fakeCtx(handler) {
  const calls = []
  return {
    calls,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    async fetch(url, init, proxy, streaming) {
      calls.push({ url, init, proxy, streaming })
      return handler(url, init, proxy, streaming)
    },
  }
}

function jsonResponse(status, body) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    async text() {
      return text
    },
    async json() {
      return body
    },
  }
}

/** 只有 body 的假 SSE Response；`readSse` 只认 async iterable。 */
function sseResponse(events) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    async text() {
      return ''
    },
    body: (async function* generate() {
      for (const event of events) {
        yield typeof event === 'string' ? `data: ${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`
      }
    })(),
  }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 在一个临时 HOME 下跑回调：按 `files` 铺好文件，跑完删干净。 */
async function withHome(files, body, { platform = 'win32', env = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-workbuddy-'))
  try {
    for (const [relative, content] of Object.entries(files)) {
      const full = join(home, relative)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
    }
    return await body({ WORKBUDDY_HOME: home, ...env }, platform, home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * 同上的临时 HOME，但把它写进 `process.env`。
 *
 * 登录流程只拿得到一个 `ctx`（`login.run(session, ctx)`，见契约 §4.1），族里读的是
 * `process.env`，所以这几条用例必须动真环境——跑完立刻复原。
 */
async function withProcessHome(files, body) {
  const keys = ['WORKBUDDY_HOME', 'WORKBUDDY_AUTH_FILE', 'WORKBUDDY_AI_AUTH_FILE']
  const previous = keys.map((key) => [key, process.env[key]])
  return withHome(files, async (_env, _platform, home) => {
    process.env.WORKBUDDY_HOME = home
    delete process.env.WORKBUDDY_AUTH_FILE
    delete process.env.WORKBUDDY_AI_AUTH_FILE
    try {
      return await body()
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

const CN_AUTH = {
  accessToken: 'wb-access-1',
  refreshToken: 'wb-refresh-1',
  domain: 'dept-abcdef123456',
  uid: 'aaaaaaaa-1111-2222-3333-444444444444',
  variant: 'cn',
}

function payloadFor(auth = CN_AUTH) {
  return { auth: { ...auth } }
}

function chatOptions(overrides = {}) {
  return {
    payload: payloadFor(),
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 64,
    signal: undefined,
    ...overrides,
  }
}

// ------------------------------------------------------------------ 凭据解析

test('a nested plaintext login file is classified as plaintext and keeps the document', () => {
  // 分类只做「认不认识」，值必须原样带回来——丢了 document 就解析不出令牌。
  const classified = classifyAuthDocument(JSON.stringify(plaintextDoc()))
  assert.equal(classified.format, 'plaintext')
  assert.equal(classified.document.auth.accessToken, 'wb-access-1')
})

test('a flat login file (no auth wrapper) parses too', () => {
  // 参考实现要同时吃 `{auth:{…},account:{…}}` 与扁平形（src/auth.ts:219-257）。
  const auth = parseDesktopAuth({ accessToken: 'flat-access', refreshToken: 'flat-refresh' }, 'cn')
  assert.equal(auth.accessToken, 'flat-access')
  assert.equal(auth.refreshToken, 'flat-refresh')
  assert.equal(auth.variant, 'cn')
})

test('AES-256-GCM wrapped fields are reported as encrypted, never as plaintext', () => {
  const classified = classifyAuthDocument(JSON.stringify(encryptedDoc()))
  assert.equal(classified.format, 'encrypted')
  assert.deepEqual(Object.keys(classified.wrapped).sort(), ['accessToken', 'refreshToken'])
  assert.equal(classified.wrapped.accessToken.keyId, '0123456789abcdef')
})

test('an empty file is absent, broken JSON is unrecognized', () => {
  assert.equal(classifyAuthDocument('   ').format, 'absent')
  assert.equal(classifyAuthDocument('not json at all').format, 'unrecognized')
  assert.equal(classifyAuthDocument('[]').format, 'unrecognized')
})

test('a wrapper we cannot decode is unrecognized, not encrypted', () => {
  // 「看起来像加密」和「确实是那个加密方案」是两件事：认不出来时不能声称解不开，
  // 那会让用户以为换个版本就能导入。
  const wrongSuite = classifyAuthDocument(JSON.stringify({
    auth: { accessToken: encryptedField({ suite: 2 }) },
  }))
  assert.equal(wrongSuite.format, 'unrecognized')

  const shortNonce = classifyAuthDocument(JSON.stringify({
    auth: { accessToken: encryptedField({ nonce: Buffer.alloc(8, 1).toString('base64') }) },
  }))
  assert.equal(shortNonce.format, 'unrecognized')

  const garbageEnvelope = classifyAuthDocument(JSON.stringify({
    auth: { accessToken: { $wbEncrypted: 1, envelope: 'not-base64!!' } },
  }))
  assert.equal(garbageEnvelope.format, 'unrecognized')
})

test('encrypted nickname/phoneNumber do not make a plaintext token file "encrypted"', () => {
  // 5.6 起这些字段也可能是密文，但我们只用 accessToken / refreshToken 判断。
  const doc = plaintextDoc()
  doc.account.nickname = encryptedField()
  doc.account.phoneNumber = encryptedField()
  assert.equal(classifyAuthDocument(JSON.stringify(doc)).format, 'plaintext')
})

test('expiry timestamps accept seconds and milliseconds, and refuse to guess', () => {
  // 同一个字段在不同版本里可能是秒也可能是毫秒（src/auth.ts:204-208）；
  // 认不出来就返回 undefined，而不是编一个 1970 年。
  assert.equal(expiryToMs(1_794_039_425_060), 1_794_039_425_060)
  assert.equal(expiryToMs(1_794_039_425), 1_794_039_425_000)
  assert.equal(expiryToMs(0), undefined)
  assert.equal(expiryToMs(-5), undefined)
  assert.equal(expiryToMs('1794039425'), undefined)
  assert.equal(expiryToMs(undefined), undefined)
})

test('parseDesktopAuth keeps uid/enterpriseId and normalises expiry', () => {
  const auth = parseDesktopAuth(plaintextDoc({ expiresAt: 1_794_039_425 }), 'cn')
  assert.equal(auth.expiresAt, 1_794_039_425_000)
  assert.equal(auth.uid, 'aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(auth.enterpriseId, '')
  assert.equal(auth.domain, 'dept-abcdef123456')
})

// ------------------------------------------------------------------ 路径

test('Windows probes AppData/Local before AppData/Roaming', () => {
  // 新版写 Local、老版写 Roaming；只探一个会把已登录读成未登录（src/auth.ts:140-141）。
  const candidates = authCandidates('cn', { WORKBUDDY_HOME: 'C:\\Users\\probe' }, 'win32')
  assert.equal(candidates.length, 2)
  assert.ok(candidates[0].includes(join('AppData', 'Local')))
  assert.ok(candidates[1].includes(join('AppData', 'Roaming')))
})

test('Linux probes XDG config home before data home', () => {
  // UOS / deepin 写 data home，别的发行版写 config home。
  const candidates = authCandidates('cn', { WORKBUDDY_HOME: '/home/probe' }, 'linux')
  assert.equal(candidates.length, 2)
  assert.ok(candidates[0].startsWith(join('/home/probe', '.config')))
  assert.ok(candidates[1].startsWith(join('/home/probe', '.local', 'share')))
})

test('an explicit WORKBUDDY_AUTH_FILE wins over every probed path', () => {
  const candidates = authCandidates('cn', { WORKBUDDY_HOME: '/home/probe', WORKBUDDY_AUTH_FILE: '/tmp/pinned.info' }, 'linux')
  assert.ok(candidates[0].endsWith('pinned.info') || candidates[0] === '/tmp/pinned.info')
})

test('the two variants differ only by file name', () => {
  const [cn, global] = VARIANTS
  assert.equal(cn.filename, 'workbuddy-desktop.info')
  assert.equal(global.filename, 'workbuddy-desktop-ai.info')
  assert.notEqual(cn.authFileEnv, global.authFileEnv)
})

test('workbuddyHomeDir prefers WORKBUDDY_HOME and never returns undefined silently', () => {
  assert.equal(workbuddyHomeDir({ WORKBUDDY_HOME: '/x' }), '/x')
  assert.equal(workbuddyHomeDir({ HOME: '/y' }), '/y')
})

// ------------------------------------------------------------------ 发现

test('discover reports nothing when the app was never installed', async () => {
  const items = await withHome({}, (env, platform) => discover(undefined, { env, platform }))
  assert.deepEqual(items, [])
})

test('discover reports an installed-but-never-logged-in app instead of staying silent', async () => {
  const items = await withHome({ [join(CN_DIR, '.keep')]: '' }, (env, platform) => discover(undefined, { env, platform }))
  assert.equal(items.length, 1)
  assert.equal(items[0].importable, false)
  assert.match(items[0].reason, /没登录/)
  assert.equal(items[0].family, 'workbuddy')
})

test('discover reports an encrypted credential file as not importable, with the reason', async () => {
  const items = await withHome({ [CN_FILE]: encryptedDoc() }, (env, platform) => discover(undefined, { env, platform }))
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.importable, false)
  assert.equal(item.externallyOwned, true)
  assert.ok(item.sourcePath.endsWith('workbuddy-desktop.info'))
  assert.match(item.reason, /AES-256-GCM/)
  assert.match(item.reason, /手动粘贴/)
  // 原因里绝不能出现密文本身。
  const envelopeB64 = encryptedDoc().auth.accessToken.envelope
  assert.ok(!item.reason.includes(envelopeB64))
  assert.equal(item.auth, undefined)
})

test('discover imports a plaintext credential file and labels it by uid', async () => {
  const items = await withHome({ [CN_FILE]: plaintextDoc() }, (env, platform) => discover(undefined, { env, platform }))
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.importable, true)
  assert.equal(item.auth.accessToken, 'wb-access-1')
  assert.equal(item.auth.refreshToken, 'wb-refresh-1')
  assert.equal(item.auth.variant, 'cn')
  // nickname 在 5.6+ 是密文，5.6 之前也未必有；uid 才是稳定的身份标签。
  assert.match(item.label, /aaaaaaaa/)
})

test('a plaintext file with no accessToken is blocked, not imported', async () => {
  const doc = plaintextDoc()
  doc.auth.accessToken = ''
  const items = await withHome({ [CN_FILE]: doc }, (env, platform) => discover(undefined, { env, platform }))
  assert.equal(items[0].importable, false)
  assert.match(items[0].reason, /accessToken/)
})

test('an unrecognized file is reported, not skipped', async () => {
  const items = await withHome({ [CN_FILE]: '{"hello":"world"' }, (env, platform) => discover(undefined, { env, platform }))
  assert.equal(items[0].importable, false)
  assert.match(items[0].reason, /JSON/)
})

test('Windows Local wins over Roaming when both exist', async () => {
  // 两份都在时用新版写的那份：老版可能残留着一份早就作废的登录态。
  const items = await withHome({
    [CN_FILE]: plaintextDoc({ access: 'local-token', uid: 'local-uid-0000' }),
    [join(ROAMING_DIR, 'workbuddy-desktop.info')]: plaintextDoc({ access: 'roaming-token', uid: 'roaming-uid-0000' }),
  }, (env, platform) => discover(undefined, { env, platform }))
  assert.equal(items.length, 1)
  assert.equal(items[0].auth.accessToken, 'local-token')
  assert.ok(items[0].sourcePath.includes(join('AppData', 'Local')))
})

test('Windows still finds Roaming-only logins', async () => {
  const items = await withHome({
    [join(ROAMING_DIR, 'workbuddy-desktop.info')]: plaintextDoc({ access: 'roaming-only' }),
  }, (env, platform) => discover(undefined, { env, platform }))
  assert.equal(items.length, 1)
  assert.equal(items[0].auth.accessToken, 'roaming-only')
})

test('both variants are reported independently', async () => {
  const items = await withHome({
    [CN_FILE]: plaintextDoc({ access: 'cn-token' }),
    [join(CN_DIR, 'workbuddy-desktop-ai.info')]: plaintextDoc({ access: 'global-token', domain: 'workbuddy.ai' }),
  }, (env, platform) => discover(undefined, { env, platform }))
  assert.equal(items.length, 2)
  assert.equal(items[0].auth.variant, 'cn')
  assert.equal(items[1].auth.variant, 'global')
})

test('discover never throws when the credential path is unreadable', async () => {
  // 读不了就当没有，不要因为权限问题把整次统一扫描带走。
  const items = await withHome({}, async (env, platform, home) => {
    await mkdir(join(home, CN_FILE), { recursive: true })
    return discover(undefined, { env, platform })
  })
  assert.ok(Array.isArray(items))
})

test('recordFromDiscovery builds a client-import record carrying the source path', async () => {
  const items = await withHome({ [CN_FILE]: plaintextDoc() }, (env, platform) => discover(undefined, { env, platform }))
  const record = workbuddyFamily.recordFromDiscovery(items[0])
  assert.equal(record.family, 'workbuddy')
  assert.equal(record.source, 'client-import')
  assert.equal(record.externallyOwned, true)
  assert.equal(record.auth.accessToken, 'wb-access-1')
  assert.ok(record.sourcePath.endsWith('workbuddy-desktop.info'))
  assert.equal(typeof record.createdAt, 'string')
})

test('recordFromDiscovery refuses entries without a usable token', () => {
  // discover 说 false 的条目不该被导进来；真被调到了也要当场炸，不要落下一条坏记录。
  assert.throws(
    () => workbuddyFamily.recordFromDiscovery({ label: 'x' }),
    (error) => error.code === 'MISSING_CREDENTIAL',
  )
})

test('the family declares the contract surface the pool expects', () => {
  assert.equal(workbuddyFamily.id, 'workbuddy')
  assert.equal(workbuddyFamily.route, 'acct-workbuddy')
  assert.equal(workbuddyFamily.risk, 'high')
  assert.equal(typeof workbuddyFamily.discover, 'function')
  assert.equal(typeof workbuddyFamily.recordFromDiscovery, 'function')
  assert.equal(typeof workbuddyFamily.refresh, 'function')
  assert.equal(typeof workbuddyFamily.needsRefresh, 'function')
  assert.equal(typeof workbuddyFamily.listModels, 'function')
  assert.equal(typeof workbuddyFamily.resolveModel, 'function')
  assert.equal(typeof workbuddyFamily.quota, 'function')
  assert.equal(typeof workbuddyFamily.stream, 'function')
  assert.equal(typeof workbuddyFamily.login.run, 'function')
  assert.ok(workbuddyFamily.login.methods.length >= 2)
})

// ------------------------------------------------------------------ 请求形状

test('a CN chat request pins the URL, every header, and the body rewrites', async () => {
  const ctx = fakeCtx(() => sseResponse([
    { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    '[DONE]',
  ]))
  await collect(workbuddyFamily.stream(ctx, chatOptions()))

  assert.equal(ctx.calls.length, 1, 'stream() must issue exactly one upstream request')
  const call = ctx.calls[0]
  assert.equal(call.url, 'https://copilot.tencent.com/v2/chat/completions')
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(call.init.headers, {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://copilot.tencent.com',
    Referer: 'https://copilot.tencent.com/',
    'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6',
    'Content-Type': 'application/json',
    Authorization: 'Bearer wb-access-1',
    'X-User-Id': 'aaaaaaaa-1111-2222-3333-444444444444',
    'X-No-Enterprise-Id': '1',
    'X-Domain': 'dept-abcdef123456',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.5.6',
    'X-Product': 'SaaS',
  })

  const body = JSON.parse(call.init.body)
  assert.equal(body.model, 'auto')
  assert.equal(body.stream, true, 'the upstream rejects non-streaming chat requests')
  assert.equal(body.max_tokens, 64)
  assert.equal(body.max_completion_tokens, undefined)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
})

test('the chat request never carries the refresh token', async () => {
  // 安全红线（src/upstream.ts:396）：refresh token 只出现在刷新请求里。
  const ctx = fakeCtx(() => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']))
  await collect(workbuddyFamily.stream(ctx, chatOptions()))
  const headers = ctx.calls[0].init.headers
  assert.equal(headers['X-Refresh-Token'], undefined)
  assert.equal(headers['X-Auth-Refresh-Source'], undefined)
  assert.ok(!JSON.stringify(headers).includes('wb-refresh-1'))
  assert.ok(!ctx.calls[0].init.body.includes('wb-refresh-1'))
})

test('missing per-account ids fall back to the X-No-* headers the upstream requires', async () => {
  const ctx = fakeCtx(() => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']))
  await collect(workbuddyFamily.stream(ctx, chatOptions({
    payload: payloadFor({ accessToken: 'wb-access-2' }),
  })))
  const headers = ctx.calls[0].init.headers
  assert.equal(headers['X-No-User-Id'], '1')
  assert.equal(headers['X-No-Enterprise-Id'], '1')
  assert.equal(headers['X-No-Department-Info'], '1')
  assert.equal(headers['X-User-Id'], undefined)
})

test('an explicit system prompt becomes the first message', async () => {
  const ctx = fakeCtx(() => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']))
  await collect(workbuddyFamily.stream(ctx, chatOptions({ system: 'be brief' })))
  assert.deepEqual(JSON.parse(ctx.calls[0].init.body).messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ])
})

test('tools force a string tool_choice — the object form is a 400 upstream', async () => {
  const ctx = fakeCtx(() => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']))
  await collect(workbuddyFamily.stream(ctx, chatOptions({
    tools: [{
      name: 'lookup',
      description: 'look something up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }],
  })))
  const body = JSON.parse(ctx.calls[0].init.body)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(typeof body.tool_choice, 'string')
  assert.equal(body.tools[0].function.name, 'lookup')
})

test('only the five upstream effort levels are sent; anything else is dropped', async () => {
  const events = [{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']
  const withHigh = fakeCtx(() => sseResponse(events))
  await collect(workbuddyFamily.stream(withHigh, chatOptions({ effort: 'high' })))
  assert.equal(JSON.parse(withHigh.calls[0].init.body).reasoning_effort, 'high')

  const withUltra = fakeCtx(() => sseResponse(events))
  await collect(workbuddyFamily.stream(withUltra, chatOptions({ effort: 'ultra' })))
  // 上游的词汇表只有 low/medium/high/xhigh/max（src/upstream.ts:192）。
  assert.equal(JSON.parse(withUltra.calls[0].init.body).reasoning_effort, undefined)
})

test('the developer role is rewritten to system and stream is forced', () => {
  // 不改写就是 400 + 业务码 11-128 "Illegal API invocation from an unapproved channel"。
  const body = JSON.parse(normalizeChatBody(JSON.stringify({
    model: 'auto',
    stream: false,
    messages: [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hi' }],
  })))
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.stream, true)
})

test('the object form of tool_choice is flattened, and none drops the tools too', () => {
  const named = JSON.parse(normalizeChatBody(JSON.stringify({
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    tools: [{ type: 'function', function: { name: 'lookup' } }],
  })))
  assert.equal(named.tool_choice, 'lookup')
  assert.ok(Array.isArray(named.tools))

  const none = JSON.parse(normalizeChatBody(JSON.stringify({
    tool_choice: 'none',
    tools: [{ type: 'function', function: { name: 'lookup' } }],
  })))
  assert.equal(none.tool_choice, undefined)
  assert.equal(none.tools, undefined)
})

test('an international account talks to the global gateway with the App-shaped UA', async () => {
  const ctx = fakeCtx(() => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']))
  await collect(workbuddyFamily.stream(ctx, chatOptions({
    payload: payloadFor({ accessToken: 'wb-global', domain: 'workbuddy.ai', variant: 'global' }),
  })))
  const call = ctx.calls[0]
  assert.equal(call.url, 'https://www.workbuddy.ai/v2/chat/completions')
  assert.equal(call.init.headers.Origin, 'https://www.workbuddy.ai')
  assert.equal(call.init.headers['User-Agent'], 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2')
  assert.equal(call.init.headers['X-IDE-Version'], '5.5.2')
  // 国际版的 GPT 系要求第一条是 system。
  assert.equal(JSON.parse(call.init.body).messages[0].role, 'system')
})

test("international requests delete reasoning_effort 'off' rather than replacing it", () => {
  // 上游对 reasoning.effort 报 400/11133，而 'none' 不是安全替代（有的模型收、有的拒）。
  const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({
    model: 'gpt-6-astra',
    reasoning_effort: 'off',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
  })))
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.messages.length, 2)
})

test('an international request without a system message gets one prepended', () => {
  const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({
    model: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  })))
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].role, 'user')
})

test('the per-account proxy and the streaming flag are forwarded, in one call', async () => {
  const proxy = 'http://127.0.0.1:7890'
  const ctx = fakeCtx(() => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']))
  await collect(workbuddyFamily.stream(ctx, chatOptions({ payload: { ...payloadFor(), proxy } })))
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].proxy, proxy)
  assert.equal(ctx.calls[0].streaming, true)
})

test('a chat with no access token still asks the upstream, and fails as AUTH', async () => {
  // 不在本地提前抛：`test/streaming-flag.test.js` 的断言是「最后一次调用必须是流式」，
  // 提前抛会让那条测试变成假失败（一次调用都没有）。所以让上游给 401。
  const ctx = fakeCtx(() => jsonResponse(401, { msg: 'unauthorized' }))
  await assert.rejects(
    collect(workbuddyFamily.stream(ctx, chatOptions({ payload: { auth: {} } }))),
    (error) => error.code === 'AUTH',
  )
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].streaming, true)
  assert.equal(ctx.calls[0].init.headers.Authorization, 'Bearer ')
})

// ------------------------------------------------------------------ 失败归类

test('HTTP 401 maps to AUTH', async () => {
  const ctx = fakeCtx(() => jsonResponse(401, { error: { message: 'unauthorized' } }))
  await assert.rejects(
    collect(workbuddyFamily.stream(ctx, chatOptions())),
    (error) => error.code === 'AUTH',
  )
})

test('HTTP 429 talking about quota maps to QUOTA, other 429s to RATE_LIMIT', async () => {
  const quota = fakeCtx(() => jsonResponse(429, { msg: 'quota exceeded' }))
  await assert.rejects(
    collect(workbuddyFamily.stream(quota, chatOptions())),
    (error) => error.code === 'QUOTA',
  )
  const busy = fakeCtx(() => jsonResponse(429, { msg: 'too many requests' }))
  await assert.rejects(
    collect(workbuddyFamily.stream(busy, chatOptions())),
    (error) => error.code === 'RATE_LIMIT',
  )
})

test('HTTP 400 about the context window maps to CONTEXT_WINDOW_EXCEEDED', async () => {
  const ctx = fakeCtx(() => jsonResponse(400, { msg: 'context length exceeded' }))
  await assert.rejects(
    collect(workbuddyFamily.stream(ctx, chatOptions())),
    (error) => error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
})

test('a dead session reported inside an HTTP 200 envelope still maps to AUTH', async () => {
  // 上游把「会话已死」塞进 200 的 {code,msg} 里；只看状态码会得到 SERVER，
  // 那样池子会重试一个永远不可能成功的账号。
  const ctx = fakeCtx(() => jsonResponse(200, { code: 12153, msg: 'Offline user session not found' }))
  await assert.rejects(
    workbuddyFamily.listModels(ctx, payloadFor(), undefined),
    (error) => error.code === 'AUTH',
  )
})

test('an exhausted balance reported in the envelope maps to ACCOUNT_QUOTA', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 11, msg: '积分不足，请充值' }))
  await assert.rejects(
    workbuddyFamily.listModels(ctx, payloadFor(), undefined),
    (error) => error.code === 'ACCOUNT_QUOTA',
  )
})

test('the upstream business code survives on the failure object', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 11_033, msg: 'bad param' }))
  await assert.rejects(
    workbuddyFamily.listModels(ctx, payloadFor(), undefined),
    (error) => error.failure?.upstreamCode === 11_033,
  )
})

test('readEnvelope treats a non-JSON body as an empty document', async () => {
  const envelope = await readEnvelope({
    ok: false,
    status: 502,
    async text() {
      return '<html>bad gateway</html>'
    },
  })
  assert.equal(envelope.code, 0)
  assert.equal(envelope.document, undefined)
  assert.match(envelope.text, /bad gateway/)
})

// ------------------------------------------------------------------ 刷新

test('refresh posts the refresh token in its header and returns a new auth object', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, {
    code: 0,
    data: { accessToken: 'wb-access-2', refreshToken: 'wb-refresh-2', expiresIn: 3600, domain: 'dept-abcdef123456' },
  }))
  const before = Date.now()
  const auth = await workbuddyFamily.refresh(ctx, payloadFor(), undefined)

  assert.equal(ctx.calls.length, 1)
  const call = ctx.calls[0]
  assert.equal(call.url, 'https://copilot.tencent.com/v2/plugin/auth/token/refresh')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['X-Refresh-Token'], 'wb-refresh-1')
  assert.equal(call.init.headers['X-Auth-Refresh-Source'], 'workbuddy')
  assert.equal(call.init.headers.Authorization, undefined, 'the refresh call is authorised by the refresh token header alone')
  assert.equal(call.init.body, undefined)
  assert.notEqual(call.streaming, true, 'a refresh is not a stream')

  assert.equal(auth.accessToken, 'wb-access-2')
  assert.equal(auth.refreshToken, 'wb-refresh-2')
  assert.equal(auth.domain, 'dept-abcdef123456')
  assert.ok(auth.expiresAt >= before + 3_600_000)
  // 池子是浅合并，所以不变的键也要在返回值里（契约 §3.2）。
  assert.equal(auth.variant, 'cn')
  assert.equal(auth.uid, CN_AUTH.uid)
})

test('refresh falls back to a short local TTL when the upstream omits expiresIn', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: { accessToken: 'wb-access-3' } }))
  const before = Date.now()
  const auth = await workbuddyFamily.refresh(ctx, payloadFor(), undefined)
  assert.ok(auth.expiresAt >= before + FALLBACK_ACCESS_TTL_SEC * 1000)
  // 没轮换就沿用旧的那只：把它清掉等于把桌面端的续期能力也弄丢了。
  assert.equal(auth.refreshToken, 'wb-refresh-1')
})

test('refresh without a refresh token fails as AUTH instead of calling the network', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, {}))
  await assert.rejects(
    workbuddyFamily.refresh(ctx, payloadFor({ accessToken: 'only-access' }), undefined),
    (error) => error.code === 'AUTH' && /refreshToken/.test(error.message),
  )
  assert.equal(ctx.calls.length, 0)
})

test('a refresh response with no accessToken fails as AUTH', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: { refreshToken: 'wb-refresh-9' } }))
  await assert.rejects(
    workbuddyFamily.refresh(ctx, payloadFor(), undefined),
    (error) => error.code === 'AUTH',
  )
})

test('needsRefresh only speaks up when the expiry is known to be close', () => {
  const now = 1_794_000_000_000
  assert.equal(workbuddyFamily.needsRefresh(payloadFor({ expiresAt: now + REFRESH_SKEW_MS * 2 }), now), false)
  assert.equal(workbuddyFamily.needsRefresh(payloadFor({ expiresAt: now + 1_000 }), now), true)
  // 手动粘贴进来的令牌可能没有过期时间：声称「该刷新了」会把每次请求都送进一次注定失败的刷新。
  assert.equal(workbuddyFamily.needsRefresh(payloadFor({ expiresAt: undefined }), now), false)
  assert.equal(workbuddyFamily.needsRefresh(undefined, now), false)
})

// ------------------------------------------------------------------ 模型目录

function catalogDoc() {
  return {
    models: [
      {
        id: 'auto',
        name: 'Auto',
        maxInputTokens: 200_000,
        maxOutputTokens: 16_384,
        supportsImages: true,
        reasoning: { supportedEfforts: ['low', 'medium', 'high', 'off'], defaultEffort: 'medium' },
      },
      { id: 'kimi-k3-1', name: 'Kimi K3', maxInputTokens: 128_000, maxOutputTokens: 8_192 },
      { id: 'retired-before', name: 'Gone', maxInputTokens: 64_000, maxOutputTokens: 4_096 },
      { id: 'disabled-one', name: 'Off', maxInputTokens: 64_000, maxOutputTokens: 4_096, disabled: true },
      { id: 'no-limits', name: 'No limits' },
      { id: 'roster-only' },
    ],
    agents: [{ name: 'cli', models: ['auto', 'kimi-k3-1', 'disabled-one', 'no-limits'] }],
  }
}

test('the catalog keeps only the cli roster rows that can actually serve', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: catalogDoc() }))
  const models = await workbuddyFamily.listModels(ctx, payloadFor(), undefined)

  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].url, 'https://copilot.tencent.com/v3/config')
  assert.equal(ctx.calls[0].init.method, 'GET')
  assert.equal(ctx.calls[0].init.headers['User-Agent'], 'CLI/2.63.2 CodeBuddy/2.63.2')
  assert.equal(ctx.calls[0].init.headers['X-Requested-With'], undefined, 'CN catalog uses the CLI-shaped identity only')
  assert.notEqual(ctx.calls[0].streaming, true)

  assert.deepEqual(models.map((model) => model.id), ['auto', 'kimi-k3-1'])
  const auto = models[0]
  assert.equal(auto.provider, 'acct-workbuddy')
  assert.equal(auto.context.contextWindow, 200_000)
  assert.equal(auto.defaultMaxTokens, 16_384)
  assert.deepEqual(auto.inputModalities, ['text', 'image'])
  assert.deepEqual(auto.reasoning.efforts, [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ], "'off' is not in the upstream vocabulary and must be filtered out")
  assert.equal(auto.reasoning.defaultEffort, 'medium')
  assert.equal(models[1].inputModalities[0], 'text')
  assert.equal(models[1].inputModalities.length, 1)
  assert.equal(models[1].reasoning, undefined, 'no declared efforts means no reasoning block at all')
})

test('an international catalog prefers contextWindow.defaultLength', async () => {
  const doc = {
    models: [{
      id: 'gpt-x',
      name: 'GPT X',
      maxInputTokens: 400_000,
      maxOutputTokens: 32_000,
      contextWindow: { defaultLength: 128_000, supportedLengths: [128_000, 400_000] },
    }],
    agents: [{ name: 'cli', models: ['gpt-x'] }],
  }
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: doc }))
  const models = await workbuddyFamily.listModels(ctx, payloadFor({ accessToken: 'g', domain: 'workbuddy.ai', variant: 'global' }), undefined)
  assert.equal(ctx.calls[0].url, 'https://www.workbuddy.ai/v3/config')
  assert.equal(ctx.calls[0].init.headers['User-Agent'], 'WorkBuddyAI/5.5.2')
  assert.equal(ctx.calls[0].init.headers['X-Product'], 'SaaS')
  assert.equal(models[0].context.contextWindow, 128_000)
})

test('a catalog without a cli roster is a hard failure, not an empty list', async () => {
  // 静默返回 [] 只会让整个分组消失，用户看不到任何线索。
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: { models: [{ id: 'auto', maxInputTokens: 1, maxOutputTokens: 1 }], agents: [] } }))
  await assert.rejects(
    workbuddyFamily.listModels(ctx, payloadFor(), undefined),
    (error) => /cli/.test(error.message),
  )
})

test('a catalog document served at the top level (no envelope) is still understood', async () => {
  // /v3/config 观察到两种形状，把缺 data 一律当空文档会误报「目录里没有 cli 模型」。
  const ctx = fakeCtx(() => jsonResponse(200, catalogDoc()))
  const models = await workbuddyFamily.listModels(ctx, payloadFor(), undefined)
  assert.deepEqual(models.map((model) => model.id), ['auto', 'kimi-k3-1'])
})

test('resolveModel returns the catalog metadata once it has been seen, and stays conservative before', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: catalogDoc() }))
  await workbuddyFamily.listModels(ctx, payloadFor(), undefined)

  const known = workbuddyFamily.resolveModel('acct-workbuddy', 'auto')
  assert.equal(known.provider, 'acct-workbuddy')
  assert.equal(known.id, 'auto')
  assert.equal(known.context.contextWindow, 200_000)

  // 没见过的模型：给保守的兜底值，而不是编一个 1M 窗口。
  const unknown = workbuddyFamily.resolveModel('acct-workbuddy', 'brand-new-model')
  assert.equal(unknown.id, 'brand-new-model')
  assert.equal(unknown.context.contextWindow, 128_000)
  assert.equal(unknown.defaultMaxTokens, 8_192)
  assert.equal(unknown.reasoning, undefined)
})

test('modelInfo never invents reasoning levels it was not told about', () => {
  const info = modelInfo({ id: 'x', name: 'X' }, 'acct-workbuddy')
  assert.deepEqual(info.inputModalities, ['text'])
  assert.equal(info.reasoning, undefined)
  assert.equal(info.toolUpdate, 'in-history')
})

// ------------------------------------------------------------------ 额度

function creditEnvelope(accounts) {
  return { code: 0, data: { Response: { Data: { Accounts: accounts } } } }
}

test('the personal quota request pins its URL, headers and body', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, creditEnvelope([
    { PackageName: 'Pro', CycleCapacitySize: 1000, CycleCapacityRemain: 250, CycleCapacityUsed: 750 },
  ])))
  const buckets = await workbuddyFamily.quota(ctx, payloadFor(), undefined)

  assert.equal(ctx.calls.length, 1)
  const call = ctx.calls[0]
  assert.equal(call.url, 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.Authorization, 'Bearer wb-access-1')
  assert.equal(call.init.headers['X-User-Id'], CN_AUTH.uid)
  assert.equal(call.init.headers['X-Domain'], 'dept-abcdef123456')
  assert.notEqual(call.streaming, true)

  const body = JSON.parse(call.init.body)
  assert.equal(body.PageNumber, 1)
  assert.equal(body.PageSize, 100)
  assert.equal(body.ProductCode, 'p_tcaca')
  assert.deepEqual(body.Status, [0, 3])
  // 上游要的是本地时间的 `YYYY-MM-DD HH:mm:ss`，不是 ISO。
  assert.match(body.PackageEndTimeRangeBegin, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.match(body.PackageEndTimeRangeEnd, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

  assert.deepEqual(buckets, [{ id: 'credits', name: '积分', remainingFraction: 0.25 }])
})

test('the personal quota sums every package and clamps the fraction', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, creditEnvelope([
    { PackageName: 'A', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
    { PackageName: 'B', CycleCapacitySize: 300, CycleCapacityRemain: -5 },
  ])))
  const buckets = await workbuddyFamily.quota(ctx, payloadFor(), undefined)
  // 负的余量归 0（上游会把超扣写成负数）。
  assert.equal(buckets[0].remainingFraction, 40 / 400)
})

test('an unreadable quota response is reported as unknown, never as zero', async () => {
  // 报一个 0% 会让用户去充值，而问题其实在别处。
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: { Response: { Data: {} } } }))
  assert.equal(await workbuddyFamily.quota(ctx, payloadFor(), undefined), undefined)
})

test('a quota request that fails over HTTP reports nothing at all', async () => {
  const ctx = fakeCtx(() => jsonResponse(500, { msg: 'boom' }))
  assert.equal(await workbuddyFamily.quota(ctx, payloadFor(), undefined), undefined)
})

test('a quota envelope with a non-zero business code reports nothing', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 40, msg: 'no permission' }))
  assert.equal(await workbuddyFamily.quota(ctx, payloadFor(), undefined), undefined)
})

test('a CN enterprise account goes to the enterprise endpoint', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: { limitNum: 1000, credit: 400, cycleResetTime: '2026-11-01' } }))
  const buckets = await workbuddyFamily.quota(ctx, payloadFor({ ...CN_AUTH, enterpriseId: 'ent-1' }), undefined)

  assert.equal(ctx.calls[0].url, 'https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage')
  assert.equal(ctx.calls[0].init.body, '{}')
  // 企业账号两个头都要发，少一个会被计费侧当成个人号。
  assert.equal(ctx.calls[0].init.headers['X-Enterprise-Id'], 'ent-1')
  assert.equal(ctx.calls[0].init.headers['X-Tenant-Id'], 'ent-1')
  assert.deepEqual(buckets, [{ id: 'enterprise', name: '企业额度', remainingFraction: 0.6, resetAt: '2026-11-01' }])
})

test('the enterprise endpoint accepts either field spelling and treats -1 as unlimited', async () => {
  const snake = fakeCtx(() => jsonResponse(200, { code: 0, data: { limit_num: 100, used_num: 25 } }))
  const snakeBuckets = await workbuddyFamily.quota(snake, payloadFor({ ...CN_AUTH, enterpriseId: 'ent-1' }), undefined)
  assert.equal(snakeBuckets[0].remainingFraction, 0.75)

  const unlimited = fakeCtx(() => jsonResponse(200, { code: 0, data: { limitNum: -1, credit: 0 } }))
  const unlimitedBuckets = await workbuddyFamily.quota(unlimited, payloadFor({ ...CN_AUTH, enterpriseId: 'ent-1' }), undefined)
  // -1 是「无上限」，不是负余额：不显示百分比，但也不能说成 0%。
  assert.deepEqual(unlimitedBuckets, [{ id: 'enterprise', name: '企业额度' }])
})

test('an enterprise quota response we cannot read is unknown, not zero', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { code: 0, data: { somethingElse: 1 } }))
  assert.equal(await workbuddyFamily.quota(ctx, payloadFor({ ...CN_AUTH, enterpriseId: 'ent-1' }), undefined), undefined)
})

test('an international account with an enterpriseId stays on the personal path', async () => {
  // 企业端点在 global 区未经验证（src/upstream.ts:809-872 的区域闸）。
  const ctx = fakeCtx(() => jsonResponse(200, creditEnvelope([{ CycleCapacitySize: 10, CycleCapacityRemain: 5 }])))
  await workbuddyFamily.quota(ctx, payloadFor({ accessToken: 'g', domain: 'workbuddy.ai', enterpriseId: 'ent-1' }), undefined)
  assert.equal(ctx.calls[0].url, 'https://www.workbuddy.ai/v2/billing/meter/get-user-resource')
})

test('a quota lookup without an access token stays silent', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, {}))
  assert.equal(await workbuddyFamily.quota(ctx, payloadFor({ accessToken: '' }), undefined), undefined)
  assert.equal(ctx.calls.length, 0)
})

// ------------------------------------------------------------------ chunk 序列

test('a text answer produces the contract chunk sequence', async () => {
  const ctx = fakeCtx(() => sseResponse([
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
    '[DONE]',
  ]))
  const chunks = await collect(workbuddyFamily.stream(ctx, chatOptions()))

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('a tool call produces tool-call-deltas and a tool-calls finish', async () => {
  const ctx = fakeCtx(() => sseResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]))
  const chunks = await collect(workbuddyFamily.stream(ctx, chatOptions()))
  assert.equal(chunks[0].blockType, 'tool-call')
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('finish_reason length maps to max-tokens', async () => {
  const ctx = fakeCtx(() => sseResponse([
    { choices: [{ delta: { content: 'truncated' }, finish_reason: 'length' }] },
    '[DONE]',
  ]))
  const chunks = await collect(workbuddyFamily.stream(ctx, chatOptions()))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('an answer with no content blocks fails as EMPTY_RESPONSE', async () => {
  // 池子靠这个码决定要不要换号；静默返回空流会让用户看到一个空回答。
  const ctx = fakeCtx(() => sseResponse([
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]))
  await assert.rejects(
    collect(workbuddyFamily.stream(ctx, chatOptions())),
    (error) => error.code === 'EMPTY_RESPONSE',
  )
})

test('reasoning deltas are surfaced as their own block', async () => {
  const ctx = fakeCtx(() => sseResponse([
    { choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    '[DONE]',
  ]))
  const chunks = await collect(workbuddyFamily.stream(ctx, chatOptions()))
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual(chunks[1], { type: 'reasoning-delta', index: 0, text: 'think' })
  assert.ok(chunks.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text'))
})

// ------------------------------------------------------------------ 登录

/** 假 session：记下 prompt / commit / notify，prompt 按队列回答。 */
function fakeSession(answers, method = 'import') {
  const events = { prompts: [], commits: [], notices: [] }
  let cursor = 0
  return {
    method,
    events,
    async prompt(question) {
      events.prompts.push(question)
      const answer = answers[cursor]
      cursor += 1
      return answer
    },
    async commit(grant) {
      events.commits.push(grant)
    },
    notify(note) {
      events.notices.push(note)
    },
  }
}

test('the import login commits a client-import record before resolving', async () => {
  await withProcessHome({ [CN_FILE]: plaintextDoc() }, async () => {
    const session = fakeSession([])
    await workbuddyFamily.login.run(session, {})
    assert.equal(session.events.commits.length, 1)
    const { kind, payload } = session.events.commits[0]
    assert.equal(kind, 'grant')
    assert.equal(payload.source, 'client-import')
    assert.equal(payload.externallyOwned, true)
    assert.equal(payload.auth.accessToken, 'wb-access-1')
    assert.equal(typeof payload.createdAt, 'string')
  })
})

test('the import login surfaces the encrypted-credential reason instead of a generic failure', async () => {
  await withProcessHome({ [CN_FILE]: encryptedDoc() }, async () => {
    const session = fakeSession([])
    await assert.rejects(
      workbuddyFamily.login.run(session, {}),
      (error) => /AES-256-GCM/.test(error.message),
    )
    assert.equal(session.events.commits.length, 0)
  })
})

test('the manual login asks for both tokens and a region, then commits', async () => {
  const session = fakeSession(['pasted-access', '', 'global'], 'manual')
  await workbuddyFamily.login.run(session, {})
  assert.equal(session.events.prompts[0].kind, 'secret')
  assert.equal(session.events.prompts[2].kind, 'select')
  assert.equal(session.events.commits.length, 1)
  const { payload } = session.events.commits[0]
  assert.equal(payload.source, 'manual')
  assert.equal(payload.externallyOwned, false)
  assert.equal(payload.auth.accessToken, 'pasted-access')
  assert.equal(payload.auth.refreshToken, undefined, 'an empty answer means "no refresh token", not an empty string')
  assert.equal(payload.auth.variant, 'global')
})

test('the manual login refuses to commit without an access token', async () => {
  const session = fakeSession(['  '], 'manual')
  await assert.rejects(
    workbuddyFamily.login.run(session, {}),
    (error) => error.code === 'MISSING_CREDENTIAL',
  )
  assert.equal(session.events.commits.length, 0)
})

// ------------------------------------------------------------------ 真机

const LIVE = process.env.BRIDGE_LIVE_WORKBUDDY === '1'

/**
 * 真机用例要用的凭据。
 *
 * 优先用 `BRIDGE_LIVE_WORKBUDDY_TOKEN`：本机（以及任何 5.6+ 的机器）登录文件是密文，
 * 本族按设计不解它，所以**环境变量是唯一能真跑起来的路**——和 qoder 的
 * `BRIDGE_LIVE_QODER_PAT` 是同一个道理。没给就退回本机可导入的那份；
 * 两样都没有就跳过，并说清楚缺什么，而不是拿一条 assert 失败当噪音。
 */
async function liveAuth(t) {
  const accessToken = process.env.BRIDGE_LIVE_WORKBUDDY_TOKEN ?? ''
  if (accessToken !== '') {
    const refreshToken = process.env.BRIDGE_LIVE_WORKBUDDY_REFRESH ?? ''
    const domain = process.env.BRIDGE_LIVE_WORKBUDDY_DOMAIN ?? ''
    return {
      accessToken,
      ...(refreshToken === '' ? {} : { refreshToken }),
      ...(domain === '' ? {} : { domain }),
      variant: process.env.BRIDGE_LIVE_WORKBUDDY_REGION === 'global' ? 'global' : 'cn',
    }
  }
  const items = await discover(undefined, {})
  const usable = items.find((item) => item.importable === true)
  if (usable !== undefined) return usable.auth
  t.skip('没有可用的凭据：本机登录文件是 5.6+ 密文，导出 BRIDGE_LIVE_WORKBUDDY_TOKEN=<accessToken> 再跑')
  return undefined
}

const LIVE_CTX = { fetch: globalThis.fetch, log: { info() {}, warn() {}, error() {} } }

test('live: this machine\'s real credential file is classified without touching tokens', { skip: !LIVE }, async () => {
  // 只断言「分类结果是什么」，**不打印任何令牌内容**。本机实测：5.6+ 是密文。
  const items = await discover(undefined, {})
  assert.ok(Array.isArray(items))
  for (const item of items) {
    if (item.importable !== true) {
      assert.equal(item.auth, undefined, 'a blocked item must not carry credentials')
      assert.equal(typeof item.reason, 'string')
    }
  }
  const cn = items.find((item) => item.sourcePath?.endsWith('workbuddy-desktop.info'))
  if (cn) {
    // 两种结果都合法（老版本是明文），但必须说清楚是哪一种。
    assert.ok(cn.importable === true || /密文|没登录|json|JSON/u.test(cn.reason ?? ''))
  }
})

test('live: a real catalog lookup answers with models', { skip: !LIVE }, async (t) => {
  const auth = await liveAuth(t)
  if (auth === undefined) return
  const models = await workbuddyFamily.listModels(LIVE_CTX, { auth }, undefined)
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.ok(model.id !== '')
    assert.ok(model.context.contextWindow > 0)
    assert.ok(model.defaultMaxTokens > 0)
  }
})

test('live: a real chat round-trip streams text', { skip: !LIVE }, async (t) => {
  const auth = await liveAuth(t)
  if (auth === undefined) return
  const models = await workbuddyFamily.listModels(LIVE_CTX, { auth }, undefined)
  assert.ok(models.length > 0)
  const chunks = await collect(workbuddyFamily.stream(LIVE_CTX, {
    payload: { auth },
    model: models[0].id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
    maxTokens: 32,
    signal: undefined,
  }))
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' || chunk.type === 'block-end'))
  assert.deepEqual(chunks.at(-1).type, 'finish')
})
