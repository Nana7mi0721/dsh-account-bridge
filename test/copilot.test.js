/**
 * `copilot` 族的回归测试。
 *
 * Copilot 这一族有三类「猜错就静默失效、而且失效的样子和别的原因长得一样」的假设，
 * 所以这里钉的不是「对接某个具体服务」，而是一条条可以被证伪的行为：
 *
 * - **设备码登录必须只在 `authorization_pending` 上继续轮询。** 四种设备流错误
 *   （`authorization_pending` / `slow_down` / `expired_token` / `access_denied`）
 *   是**用 HTTP 200 + `{"error":...}` 表达的**，只看状态码会把「用户点了拒绝」
 *   当成「还没授权」而永远轮询下去；反过来把网络错误也当 retry，一个永久性错误
 *   就变成无限重试（lujianjun19 踩过这个，考古 C17）。
 * - **`editor-version` 太旧会让整族 100% 401，而响应体长得和「令牌被撤」一样。**
 *   所以它必须动态取、缓存 24 小时、并在 401 上强制作废缓存重试一次；
 *   同时「重取回来还是同一个版本就不重试」——那说明问题不在版本上。
 * - **Copilot 的模型目录字段名和 DSH 的不一样，而且不是每个模型都能走我们这条线。**
 *   `contextWindow` 缺失时必须兜底成**正整数**（宿主的 `dsh-llm` 拿不到正整数会抛
 *   `adapter returned invalid context metadata`，那是 provider 级失败——整族从选择器里消失）；
 *   只声明 `/responses` 的模型一个都不许列（列了用户点下去必然 400）。
 *
 * 另外钉住三件「不许做」的事：**不编额度**（`quota()` → `undefined`，绝不出现 0）、
 * **不硬编码推理 base URL**（端点按账号下发，缺失就报错）、
 * **不加 `X-Initiator`**（它在源码/测试/抓包/README 里一次都没出现过，考古 §2.4.2）。
 *
 * 真机联网的用例挂在 `BRIDGE_LIVE_COPILOT === '1'` 后面，**默认跳过**：
 * 本机（开发这一族的那台 Windows）**没有 Copilot 订阅**，所以那些用例
 * 在这台机器上一次都没跑过——这一点写在每个 live 用例的 skip 原因里，不假装验过。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { copilotFamily } from '../src/families/copilot.js'
import {
  CHAT_WIRE,
  CLIENT_ID,
  COPILOT_CONTEXT_WINDOW,
  COPILOT_DEFAULT_MAX_TOKENS,
  COPILOT_REFRESH_SKEW_MS,
  COPILOT_TOKEN_FALLBACK_TTL_MS,
  COPILOT_TOKEN_URL,
  DEVICE_CODE_URL,
  DEVICE_DEFAULT_EXPIRES_MS,
  DEVICE_DEFAULT_INTERVAL_MS,
  DEVICE_DENIED_MESSAGE,
  DEVICE_EXPIRED_MESSAGE,
  DEVICE_GRANT_TYPE,
  DEVICE_SLOW_DOWN_STEP_MS,
  DEVICE_TOKEN_URL,
  DEVICE_VERIFY_URL,
  EDITOR_PLUGIN_VERSION,
  FALLBACK_VSCODE_VERSION,
  GITHUB_USER_AGENT,
  GITHUB_USER_URL,
  SCOPE,
  VSCODE_RELEASES_URL,
  apiBaseUrl,
  authFromTokenResponse,
  classifyDeviceTokenResponse,
  copilotChatBody,
  copilotError,
  copilotHeaders,
  createDeviceFlowState,
  createVersionResolver,
  credentialSites,
  deviceCodeRequest,
  deviceTokenRequest,
  exchangeCopilotToken,
  extractStableVersion,
  importBlockerReason,
  limitsFromCatalogEntry,
  looksLikeStaleEditorVersion,
  modelInfo,
  modelInfoFromCatalog,
  modelsFromCatalog,
  needsRefresh,
  normaliseEfforts,
  planReasoningEffort,
  pollDeviceToken,
  positiveInteger,
  readDeviceCode,
  requestWithEditorVersion,
  servesChatWire,
} from '../src/wire/copilot.js'

// ------------------------------------------------------------------ 测试工具

/**
 * 发出去的 `editor-version` 默认钉死。测试要**故意**走动态解析时必须传 `config: {}`，
 * 这样「哪些用例真的碰了发布列表接口」是一眼可见的，而不是碰运气。
 */
const PINNED = Object.freeze({ copilotEditorVersion: FALLBACK_VSCODE_VERSION })

const INDIVIDUAL_API = 'https://api.individual.githubcopilot.com'
const BUSINESS_API = 'https://api.business.githubcopilot.com'

/** 造一个只有 body 的假 Response；`readSse` 只认 async iterable。 */
function sseResponse(frames) {
  const body = (async function* generate() {
    for (const frame of frames) {
      if (typeof frame === 'string') yield frame
      else yield `data: ${JSON.stringify(frame)}\n\n`
    }
  })()
  return { ok: true, status: 200, headers: { get: () => null }, body, text: async () => '' }
}

/** 造一个失败响应。 */
function errorResponse(status, body, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  }
}

/** 造一个成功响应（目录 / 换 token / 设备码这类要 json() 的接口）。 */
function jsonResponse(json, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(json),
    json: async () => json,
  }
}

/** 收集整个 chunk 流。 */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 一个记录调用参数的假 ctx。默认把 editor-version 钉死，见 `PINNED`。 */
function recordingCtx(handler, { config = PINNED, services = {} } = {}) {
  const calls = []
  const warnings = []
  return {
    calls,
    warnings,
    config,
    log: {
      warn: (...args) => warnings.push(args),
      info: () => {},
      debug: () => {},
    },
    get: (name) => services[name],
    async fetch(url, init, proxy, streaming) {
      calls.push({ url, init, proxy, streaming })
      const response = handler(url, init, proxy, streaming)
      if (response === undefined) throw new Error(`unexpected fetch: ${url}`)
      return response
    },
  }
}

/** 一次换 token 的响应。 */
function tokenJson(overrides = {}) {
  return {
    token: 'tid=abc;exp=2000000000;proxy-ep=proxy.individual.githubcopilot.com',
    expires_at: Math.floor((Date.now() + 30 * 60_000) / 1000),
    endpoints: { api: INDIVIDUAL_API },
    ...overrides,
  }
}

/** 一条账号记录（`payload`）。 */
function account({ auth = {}, ...rest } = {}) {
  return {
    family: 'copilot',
    label: 'octocat',
    source: 'oauth',
    externallyOwned: false,
    ...rest,
    auth: {
      access: 'copilot-token',
      refresh: 'ghu_github-token',
      expiresAt: Date.now() + 30 * 60_000,
      endpoints: { api: INDIVIDUAL_API },
      ...auth,
    },
  }
}

/** `/models` 的一个条目。 */
function catalogEntry(overrides = {}) {
  return {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    model_picker_enabled: true,
    capabilities: {
      limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_384 },
      supports: { vision: true, reasoning_effort: ['low', 'medium', 'high'] },
    },
    ...overrides,
  }
}

/** 一条文本消息。 */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * 宿主 `dsh-llm` 会拿这些字段做校验/展示，所以每个模型元数据都要过一遍：
 * `contextWindow` / `maxTokens` 必须是正整数（不是的话整族不可用）。
 */
function assertModelShape(model, provider = copilotFamily.route) {
  assert.equal(model.provider, provider, 'provider 必须是族的 route（池子还会覆盖一次）')
  assert.ok(typeof model.id === 'string' && model.id.length > 0, 'id 必须是非空字符串')
  assert.ok(typeof model.name === 'string' && model.name.length > 0, 'name 必须是非空字符串')
  assert.ok(
    Number.isInteger(model.context?.contextWindow) && model.context.contextWindow > 0,
    `contextWindow 必须是正整数，实际是 ${String(model.context?.contextWindow)}`,
  )
  assert.ok(
    Number.isInteger(model.defaultMaxTokens) && model.defaultMaxTokens > 0,
    `defaultMaxTokens 必须是正整数，实际是 ${String(model.defaultMaxTokens)}`,
  )
  assert.ok(model.defaultMaxTokens <= model.context.contextWindow, 'defaultMaxTokens 不该超过上下文窗口')
  assert.equal(model.toolUpdate, 'in-history')
  assert.ok(Array.isArray(model.inputModalities) && model.inputModalities.includes('text'))
  if (model.reasoning !== undefined) {
    assert.ok(Array.isArray(model.reasoning.efforts) && model.reasoning.efforts.length > 0)
    for (const effort of model.reasoning.efforts) {
      assert.ok(typeof effort.id === 'string' && effort.id.length > 0)
      assert.ok(typeof effort.name === 'string' && effort.name.length > 0)
    }
  }
}

const live = (name, fn) =>
  test(name, { skip: process.env.BRIDGE_LIVE_COPILOT !== '1' ? '需要 BRIDGE_LIVE_COPILOT=1；开发机没有 Copilot 订阅，未验证' : false }, fn)

// ------------------------------------------------------------------ 设备码：状态机

test('a pending poll keeps going, and only a pending poll keeps going', () => {
  assert.deepEqual(classifyDeviceTokenResponse({ error: 'authorization_pending' }), { status: 'pending', slowDown: false })
  // 四类设备流错误都是 HTTP 200 + error 字段：只看状态码会把「拒绝」当「还没授权」永远转下去。
  assert.deepEqual(classifyDeviceTokenResponse({ error: 'slow_down' }), { status: 'pending', slowDown: true })
  assert.deepEqual(classifyDeviceTokenResponse({ error: 'access_denied' }), { status: 'denied', message: DEVICE_DENIED_MESSAGE })
  assert.deepEqual(classifyDeviceTokenResponse({ error: 'expired_token' }), { status: 'expired', message: DEVICE_EXPIRED_MESSAGE })
})

test('an authorized poll returns the token, an unknown error is a failure we can read', () => {
  assert.deepEqual(classifyDeviceTokenResponse({ access_token: 'ghu_abc' }), { status: 'authorized', accessToken: 'ghu_abc' })

  const unknown = classifyDeviceTokenResponse({ error: 'incorrect_device_code', error_description: 'bad code' })
  assert.equal(unknown.status, 'failed')
  assert.match(unknown.message, /incorrect_device_code: bad code/)

  // 既没有 token 也没有 error：这是上游说了我们读不懂的话，不能当成「继续等」。
  const empty = classifyDeviceTokenResponse({})
  assert.equal(empty.status, 'failed')
})

test('slow_down raises the interval for every following poll, not just one', () => {
  const state = createDeviceFlowState({ intervalMs: 5_000, expiresInMs: 900_000 }, 0)
  assert.equal(state.delayMs(), 5_000)
  assert.equal(state.accept({ error: 'authorization_pending' }, 1_000).status, 'pending')
  assert.equal(state.delayMs(), 5_000, '普通 pending 不改间隔')
  assert.equal(state.accept({ error: 'slow_down' }, 2_000).status, 'pending')
  assert.equal(state.delayMs(), 5_000 + DEVICE_SLOW_DOWN_STEP_MS)
  // RFC 8628 §3.5：慢下来之后就一直慢，下一次普通 pending 不该把间隔降回去。
  assert.equal(state.accept({ error: 'authorization_pending' }, 3_000).status, 'pending')
  assert.equal(state.delayMs(), 5_000 + DEVICE_SLOW_DOWN_STEP_MS)
})

test('the device code expiry only overrides a pending verdict, never a token that already arrived', () => {
  const state = createDeviceFlowState({ intervalMs: 5_000, expiresInMs: 1_000 }, 0)
  assert.equal(state.expired(999), false)
  const verdict = state.accept({ error: 'authorization_pending' }, 2_000)
  assert.equal(verdict.status, 'expired')
  assert.equal(verdict.message, DEVICE_EXPIRED_MESSAGE)
  // 授权页上已经点了同意、令牌也拿到了：这时候过没过期都该收下。
  assert.equal(state.accept({ access_token: 'ghu_late' }, 9_999).status, 'authorized')
})

test('device flow defaults are the RFC-ish ones, not zero', () => {
  const state = createDeviceFlowState({}, 0)
  assert.equal(state.delayMs(), DEVICE_DEFAULT_INTERVAL_MS)
  assert.equal(state.deadline, DEVICE_DEFAULT_EXPIRES_MS)
})

// ------------------------------------------------------------------ 设备码：请求与解析

test('the device code request is a form-encoded POST with our client id and scope', () => {
  const request = deviceCodeRequest()
  assert.equal(request.url, DEVICE_CODE_URL)
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers['content-type'], 'application/x-www-form-urlencoded')
  const body = new URLSearchParams(request.init.body)
  assert.equal(body.get('client_id'), CLIENT_ID)
  assert.equal(body.get('scope'), SCOPE)
})

test('the poll body carries the grant type the token endpoint expects', () => {
  const body = new URLSearchParams(deviceTokenRequest('dev-1').init.body)
  assert.equal(deviceTokenRequest('dev-1').url, DEVICE_TOKEN_URL)
  assert.equal(body.get('client_id'), CLIENT_ID)
  assert.equal(body.get('device_code'), 'dev-1')
  assert.equal(body.get('grant_type'), DEVICE_GRANT_TYPE)
})

test('readDeviceCode turns the seconds in the response into milliseconds', () => {
  const device = readDeviceCode({
    device_code: 'dev-1',
    user_code: 'ABCD-1234',
    verification_uri: DEVICE_VERIFY_URL,
    interval: 5,
    expires_in: 900,
  })
  assert.deepEqual(device, {
    deviceCode: 'dev-1',
    userCode: 'ABCD-1234',
    verificationUri: DEVICE_VERIFY_URL,
    intervalMs: 5_000,
    expiresInMs: 900_000,
  })
})

test('readDeviceCode falls back instead of inventing values', () => {
  // verification_uri 在 RFC 里是可选的，上游有时候只给 verification_url。
  const legacy = readDeviceCode({ device_code: 'd', user_code: 'u', verification_url: 'https://example.test/device' })
  assert.equal(legacy.verificationUri, 'https://example.test/device')
  const bare = readDeviceCode({ device_code: 'd', user_code: 'u' })
  assert.equal(bare.verificationUri, DEVICE_VERIFY_URL)
  // 0 / 负数 / 读不懂，一律按默认值——绝不能变成「0 毫秒轮询」。
  const zero = readDeviceCode({ device_code: 'd', user_code: 'u', interval: 0, expires_in: -5 })
  assert.equal(zero.intervalMs, DEVICE_DEFAULT_INTERVAL_MS)
  assert.equal(zero.expiresInMs, DEVICE_DEFAULT_EXPIRES_MS)
})

test('a device code response without a device_code/user_code is an error, not an undefined poll', () => {
  for (const json of [{}, { device_code: 'd' }, { user_code: 'u' }, { device_code: '', user_code: 'u' }]) {
    assert.throws(() => readDeviceCode(json), /device_code\/user_code/)
  }
})

// ------------------------------------------------------------------ 设备码：轮询

test('polling waits one interval before every request and returns the token it is given', async () => {
  const responses = [
    jsonResponse({ error: 'authorization_pending' }),
    jsonResponse({ error: 'authorization_pending' }),
    jsonResponse({ access_token: 'ghu_after_three' }),
  ]
  const sleeps = []
  const ctx = recordingCtx((url) => {
    assert.equal(url, DEVICE_TOKEN_URL)
    return responses.shift()
  })
  const result = await pollDeviceToken({
    ctx,
    proxy: 'http://proxy.test:8080',
    device: { deviceCode: 'dev-1', intervalMs: 5_000, expiresInMs: 900_000 },
    sleep: async (ms) => sleeps.push(ms),
  })
  assert.equal(result.accessToken, 'ghu_after_three')
  assert.deepEqual(sleeps, [5_000, 5_000, 5_000])
  assert.equal(ctx.calls.length, 3)
  // 轮询不是推理请求：第 4 个参数必须是 false（流式 agent 只为对话路径准备）。
  assert.deepEqual(ctx.calls.map((call) => call.streaming), [false, false, false])
  assert.equal(ctx.calls[0].proxy, 'http://proxy.test:8080')
})

test('a slow_down poll makes the next wait longer', async () => {
  const responses = [jsonResponse({ error: 'slow_down' }), jsonResponse({ access_token: 'ghu_ok' })]
  const sleeps = []
  const ctx = recordingCtx(() => responses.shift())
  await pollDeviceToken({
    ctx,
    device: { deviceCode: 'dev-1', intervalMs: 5_000, expiresInMs: 900_000 },
    sleep: async (ms) => sleeps.push(ms),
  })
  assert.deepEqual(sleeps, [5_000, 5_000 + DEVICE_SLOW_DOWN_STEP_MS])
})

test('access_denied and expired_token stop the loop as auth failures', async () => {
  const denied = recordingCtx(() => jsonResponse({ error: 'access_denied' }))
  await assert.rejects(
    pollDeviceToken({ ctx: denied, device: { deviceCode: 'd' }, sleep: async () => {} }),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.match(error.message, new RegExp(DEVICE_DENIED_MESSAGE))
      return true
    },
  )
  assert.equal(denied.calls.length, 1, '被拒之后不许再轮询')

  const expired = recordingCtx(() => jsonResponse({ error: 'expired_token' }))
  await assert.rejects(
    pollDeviceToken({ ctx: expired, device: { deviceCode: 'd' }, sleep: async () => {} }),
    (error) => {
      assert.equal(error.code, 'AUTH')
      return true
    },
  )
})

test('a broken poll is thrown immediately instead of becoming an endless retry', async () => {
  // 这条是 lujianjun19 的事故（考古 C17）：把 5xx/网络异常也当 retry，
  // 于是一个永久性错误会以设备码的间隔被重试到天荒地老。
  const ctx = recordingCtx(() => errorResponse(500, 'boom'))
  await assert.rejects(
    pollDeviceToken({ ctx, device: { deviceCode: 'd' }, sleep: async () => {} }),
    (error) => {
      assert.equal(error.code, 'SERVER')
      return true
    },
  )
  assert.equal(ctx.calls.length, 1, '一次 5xx 之后就该放弃')

  const garbage = recordingCtx(() => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'not json' }))
  await assert.rejects(pollDeviceToken({ ctx: garbage, device: { deviceCode: 'd' }, sleep: async () => {} }))
})

test('polling gives up when the device code outlives its own expiry', async () => {
  let now = 0
  const ctx = recordingCtx(() => jsonResponse({ error: 'authorization_pending' }))
  await assert.rejects(
    pollDeviceToken({
      ctx,
      device: { deviceCode: 'd', intervalMs: 1_000, expiresInMs: 2_000 },
      sleep: async () => {
        now += 10_000
      },
      now: () => now,
    }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.match(error.message, /超时/)
      return true
    },
  )
})

test('polling without a sleep function is a programming error, not a busy loop', async () => {
  const ctx = recordingCtx(() => jsonResponse({ access_token: 'x' }))
  await assert.rejects(pollDeviceToken({ ctx, device: { deviceCode: 'd' } }), TypeError)
})

// ------------------------------------------------------------------ editor-version

test('the release feed gives the first stable three-part version', () => {
  assert.equal(extractStableVersion(['1.108.0-insider', 'junk', '1.107.0', '1.106.2']), '1.107.0')
  assert.equal(extractStableVersion(['1.108.0']), '1.108.0')
  // 读不懂就当没查到（回调落常量），不是抛错。
  assert.equal(extractStableVersion('not an array'), undefined)
  assert.equal(extractStableVersion(['1.108', 'latest']), undefined)
})

test('the version resolver fetches once and then serves from its 24h cache', async () => {
  let feedCalls = 0
  const ctx = recordingCtx((url) => {
    assert.equal(url, VSCODE_RELEASES_URL)
    feedCalls += 1
    return jsonResponse(['1.109.0', '1.108.0'])
  })
  const resolver = createVersionResolver()
  assert.equal(resolver.peek(), FALLBACK_VSCODE_VERSION, '第一次解析之前只有常量可用')
  assert.equal(await resolver.resolve(ctx), '1.109.0')
  assert.equal(await resolver.resolve(ctx), '1.109.0')
  assert.equal(feedCalls, 1, '一天之内只该查一次发布列表')
  assert.equal(resolver.peek(), '1.109.0')
  assert.equal(ctx.calls[0].streaming, false, '这不是流式请求')
})

test('the version cache expires after the ttl', async () => {
  let now = 0
  let feedCalls = 0
  const ctx = recordingCtx(() => {
    feedCalls += 1
    return jsonResponse([`1.${110 + feedCalls}.0`])
  })
  const resolver = createVersionResolver({ ttlMs: 1_000, now: () => now })
  assert.equal(await resolver.resolve(ctx), '1.111.0')
  now = 999
  assert.equal(await resolver.resolve(ctx), '1.111.0')
  now = 1_000
  assert.equal(await resolver.resolve(ctx), '1.112.0')
  assert.equal(feedCalls, 2)
})

test('concurrent resolves share one in-flight feed request', async () => {
  let feedCalls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ctx = {
    log: { warn: () => {} },
    async fetch() {
      feedCalls += 1
      await gate
      return jsonResponse(['1.109.0'])
    },
  }
  const resolver = createVersionResolver()
  const pending = [resolver.resolve(ctx), resolver.resolve(ctx), resolver.resolve(ctx)]
  release()
  assert.deepEqual(await Promise.all(pending), ['1.109.0', '1.109.0', '1.109.0'])
  assert.equal(feedCalls, 1, '冷启动不该打出三个 feed 请求')
})

test('a failed lookup falls back and never takes the request path down with it', async () => {
  const broken = recordingCtx(() => errorResponse(503, 'feed down'))
  const resolver = createVersionResolver()
  assert.equal(await resolver.resolve(broken), FALLBACK_VSCODE_VERSION)
  assert.equal(broken.warnings.length, 1, '回落必须留下一条日志，否则没人知道版本号已经不可信')
  assert.equal(resolver.peek(), FALLBACK_VSCODE_VERSION, '失败不该写进缓存')

  const garbage = recordingCtx(() => jsonResponse({ not: 'an array' }))
  assert.equal(await createVersionResolver().resolve(garbage), FALLBACK_VSCODE_VERSION)
})

test('a failed re-lookup prefers the last good version over the constant', async () => {
  let calls = 0
  const ctx = recordingCtx(() => {
    calls += 1
    return calls === 1 ? jsonResponse(['1.109.0']) : errorResponse(500, 'down')
  })
  const resolver = createVersionResolver({ ttlMs: 0 })
  assert.equal(await resolver.resolve(ctx), '1.109.0')
  // ttl 0 ⇒ 每次都要重查；第二次挂了应该退回上次成功的版本，而不是直接跳回常量。
  assert.equal(await resolver.resolve(ctx), '1.109.0')
})

test('a 401 is retried once with a freshly resolved editor version', async () => {
  let feedCalls = 0
  const inference = []
  const ctx = recordingCtx((url, init) => {
    if (url === VSCODE_RELEASES_URL) {
      feedCalls += 1
      return jsonResponse([`1.${120 + feedCalls}.0`])
    }
    inference.push(init.headers['editor-version'])
    return inference.length === 1 ? errorResponse(401, 'IDE token expired') : jsonResponse({ ok: true })
  })
  const resolver = createVersionResolver()
  const response = await requestWithEditorVersion({
    ctx,
    request: { url: 'https://api.test/chat/completions', init: { method: 'POST', headers: { accept: 'text/event-stream' } } },
    resolver,
  })
  assert.equal(response.status, 200)
  assert.equal(feedCalls, 2, '401 ⇒ 强制作废缓存重取一次')
  assert.equal(inference.length, 2)
  assert.notEqual(inference[0], inference[1], '重试必须换一个版本号，否则重试毫无意义')
  assert.match(inference[1], /^vscode\/\d+\.\d+\.\d+$/)
})

test('a 401 whose re-lookup returns the same version is not retried again', async () => {
  // 重取回来还是同一个版本 ⇒ 问题不在版本上，再打一次只是浪费一次请求。
  let feedCalls = 0
  let inferenceCalls = 0
  const ctx = recordingCtx((url) => {
    if (url === VSCODE_RELEASES_URL) {
      feedCalls += 1
      return jsonResponse(['1.107.0'])
    }
    inferenceCalls += 1
    return errorResponse(401, 'nope')
  })
  const resolver = createVersionResolver({ ttlMs: 0 })
  const response = await requestWithEditorVersion({
    ctx,
    request: { url: 'https://api.test/chat/completions', init: { headers: {} } },
    resolver,
  })
  assert.equal(response.status, 401, '还是把上游的 401 原样交给调用方去归类')
  assert.equal(inferenceCalls, 1)
  assert.equal(feedCalls, 2)
})

test('only a 401 triggers the version re-lookup', async () => {
  let feedCalls = 0
  let inferenceCalls = 0
  const ctx = recordingCtx((url) => {
    if (url === VSCODE_RELEASES_URL) {
      feedCalls += 1
      return jsonResponse(['1.107.0'])
    }
    inferenceCalls += 1
    return errorResponse(429, 'slow down')
  })
  await requestWithEditorVersion({
    ctx,
    request: { url: 'https://api.test/chat/completions', init: { headers: {} } },
    resolver: createVersionResolver(),
  })
  assert.equal(inferenceCalls, 1)
  assert.equal(feedCalls, 1, '限流和版本号无关，不该顺手再查一次发布列表')
})

test('looksLikeStaleEditorVersion only fires on the one fingerprint we can actually read', () => {
  assert.equal(looksLikeStaleEditorVersion(401, '{"message":"IDE token expired"}'), true)
  assert.equal(looksLikeStaleEditorVersion(401, 'Editor-Version header is too old'), true)
  // 同一个 401 也可能是令牌真被撤了——那就老实交给 AUTH 归类，不要瞎猜。
  assert.equal(looksLikeStaleEditorVersion(401, 'Bad credentials'), false)
  assert.equal(looksLikeStaleEditorVersion(403, 'IDE token expired'), false)
})

// ------------------------------------------------------------------ 头与请求形态

test('the identity headers are the ones we have evidence for, and no X-Initiator', () => {
  const headers = copilotHeaders({ token: 'ghu_x', json: true, stream: true })
  assert.equal(headers.authorization, 'Bearer ghu_x')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['user-agent'], GITHUB_USER_AGENT)
  assert.ok(headers['user-agent'].startsWith('GitHubCopilot'), 'UA 不是 GitHubCopilot* 会被反爬 403，且长得像鉴权失败')
  assert.equal(headers['editor-plugin-version'], EDITOR_PLUGIN_VERSION)
  assert.equal(headers['copilot-integration-id'], 'vscode-chat')
  assert.equal(headers['openai-intent'], 'conversation-edits')
  assert.equal(headers['x-github-api-version'], '2026-06-01')
  // editor-version 由 requestWithEditorVersion 填，不在这一层。
  assert.equal(headers['editor-version'], undefined)
  // `X-Initiator` 在源码/测试/抓包/README 里一次都没出现过（考古 §2.4.2）：不许凭印象加。
  assert.deepEqual(Object.keys(headers).filter((key) => /initiator/i.test(key)), [])
})

test('a text-only request does not claim to be a vision request', () => {
  assert.equal(copilotHeaders({ token: 't' })['copilot-vision-request'], undefined)
  assert.equal(copilotHeaders({ token: 't', hasImages: true })['copilot-vision-request'], 'true')
  // 没有令牌时不发一个 `Bearer undefined`。
  assert.equal(copilotHeaders({}).authorization, undefined)
  assert.equal(copilotHeaders({}).accept, 'application/json')
})

// ------------------------------------------------------------------ token 交换

test('the token response keeps the account specific api endpoint', () => {
  const now = 1_700_000_000_000
  const auth = authFromTokenResponse(
    {
      token: 'tid=abc;exp=2000000000;proxy-ep=proxy.business.githubcopilot.com',
      expires_at: 1_700_001_800,
      endpoints: { api: `${BUSINESS_API}/`, 'origin-tracker': `${BUSINESS_API}/` },
      sku: 'copilot_for_business_seat',
      chat_enabled: true,
    },
    now,
  )
  // expires_at 是 epoch 秒：当毫秒用会得到「1970 年就过期了」，于是每个请求都换一次 token。
  assert.equal(auth.expiresAt, 1_700_001_800_000)
  assert.equal(auth.endpoints.api, BUSINESS_API, '尾斜杠要削掉，否则拼出 //chat/completions')
  assert.equal(auth.endpoints.originTracker, BUSINESS_API)
  assert.equal(auth.sku, 'copilot_for_business_seat')
  assert.equal(auth.chatEnabled, true)
  // `endpoints.proxy` 是上游给的网关地址，**不是**用户的 HTTP 代理：
  // 把它存成 `proxy` 会让整个插件拿它当代理用。
  assert.equal(auth.proxy, undefined)
})

test('a token response without an api endpoint is refused rather than defaulted', () => {
  assert.throws(
    () => authFromTokenResponse({ token: 'x', expires_at: 1, endpoints: {} }),
    (error) => {
      assert.match(error.message, /endpoints\.api/)
      // 这条错误信息里绝不能出现任何一个写死的 copilot 域名。
      assert.doesNotMatch(error.message, /githubcopilot\.com/)
      return true
    },
  )
  assert.throws(() => authFromTokenResponse({ endpoints: { api: INDIVIDUAL_API } }), /没有 token/)
})

test('a missing expiry gets a conservative fallback, and the skew decides the refresh', () => {
  const now = 1_700_000_000_000
  const auth = authFromTokenResponse({ token: 'x', endpoints: { api: INDIVIDUAL_API } }, now)
  assert.equal(auth.expiresAt, now + COPILOT_TOKEN_FALLBACK_TTL_MS)

  const fresh = account({ auth: { expiresAt: now + 30 * 60_000 } })
  assert.equal(needsRefresh(fresh, now), false)
  const soon = account({ auth: { expiresAt: now + COPILOT_REFRESH_SKEW_MS - 1 } })
  assert.equal(needsRefresh(soon, now), true, '到期前 5 分钟就该换')
  // 读不到到期时间就别猜「该换了」（否则会变成每个请求都换一次 token）。
  assert.equal(needsRefresh({ auth: {} }, now), false)
  assert.equal(needsRefresh(payloadWithoutAuth(), now), false)
})

function payloadWithoutAuth() {
  return { family: 'copilot' }
}

test('exchanging a github token asks the one endpoint and sends the editor identity', async () => {
  // 这里用一个固定版本的解析器：这条测的是**换 token 的请求形状**，
  // 发布列表的解析有自己的用例（拿真解析器会让第一个请求变成 feed，把这条测歪）。
  const fixed = { resolve: async () => FALLBACK_VSCODE_VERSION }
  const ctx = recordingCtx((url) => {
    assert.equal(url, COPILOT_TOKEN_URL)
    return jsonResponse(tokenJson())
  })
  const auth = await exchangeCopilotToken({
    ctx,
    githubToken: 'ghu_github-token',
    proxy: 'http://proxy.test:8080',
    resolver: fixed,
  })
  assert.equal(auth.access, tokenJson().token)
  assert.equal(auth.endpoints.api, INDIVIDUAL_API)
  const call = ctx.calls[0]
  assert.equal(call.init.method, 'GET')
  assert.equal(call.init.headers.authorization, 'Bearer ghu_github-token')
  assert.equal(call.init.headers['editor-version'], `vscode/${FALLBACK_VSCODE_VERSION}`)
  assert.equal(call.init.headers['user-agent'], GITHUB_USER_AGENT)
  assert.equal(call.proxy, 'http://proxy.test:8080')
  assert.equal(call.streaming, false)
})

test('exchanging without a github token is an auth failure, not a request', async () => {
  const ctx = recordingCtx(() => jsonResponse(tokenJson()))
  for (const githubToken of [undefined, '', 42]) {
    await assert.rejects(exchangeCopilotToken({ ctx, githubToken, resolver: createVersionResolver() }), (error) => {
      assert.equal(error.code, 'AUTH')
      return true
    })
  }
  assert.equal(ctx.calls.length, 0)
})

test('a rejected exchange keeps the upstream text so a human can tell why', async () => {
  const ctx = recordingCtx(() => errorResponse(403, '{"message":"Copilot is not enabled for this account"}'))
  await assert.rejects(exchangeCopilotToken({ ctx, githubToken: 'ghu_x', resolver: createVersionResolver() }), (error) => {
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /Copilot is not enabled for this account/)
    assert.equal(error.failure.status, 403)
    return true
  })
})

test('a stale editor version is called out by name in the error', () => {
  const error = copilotError(errorResponse(401, '{"message":"IDE token expired"}'), '{"message":"IDE token expired"}', 'copilot')
  assert.equal(error.code, 'AUTH')
  assert.equal(error.staleEditorVersion, true)
  assert.match(error.message, /editor-version/)
  const plain = copilotError(errorResponse(401, 'Bad credentials'), 'Bad credentials', 'copilot')
  assert.equal(plain.staleEditorVersion, undefined)
})

// ------------------------------------------------------------------ 失败归类

test('upstream failures map onto the codes the pool acts on', () => {
  const cases = [
    [401, 'unauthorized', 'AUTH'],
    [403, 'forbidden', 'AUTH'],
    [402, 'payment required', 'ACCOUNT_QUOTA'],
    [429, '{"message":"You have exceeded your usage limit"}', 'QUOTA'],
    [429, '{"message":"too many requests"}', 'RATE_LIMIT'],
    [400, '{"message":"prompt is too long for the context window"}', 'CONTEXT_WINDOW_EXCEEDED'],
    [408, 'timeout', 'TIMEOUT'],
    [504, 'gateway timeout', 'TIMEOUT'],
    [500, 'boom', 'SERVER'],
  ]
  for (const [status, body, code] of cases) {
    const error = copilotError(errorResponse(status, body), body, 'copilot')
    assert.equal(error.code, code, `${status} 应该归成 ${code}`)
    assert.equal(error.failure.status, status)
  }
})

test('a retry-after header survives into the failure detail', () => {
  const error = copilotError(
    errorResponse(429, 'slow down', { 'retry-after': '30' }),
    'slow down',
    'copilot',
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.providerRetryAfterMs, 30_000)
})

// ------------------------------------------------------------------ 模型目录

test('a catalog entry becomes model metadata the host will accept', () => {
  const model = modelInfoFromCatalog(catalogEntry(), copilotFamily.route)
  assertModelShape(model)
  assert.equal(model.id, 'gpt-4.1')
  assert.equal(model.name, 'GPT-4.1')
  assert.equal(model.context.contextWindow, 128_000)
  assert.equal(model.defaultMaxTokens, 16_384)
  assert.deepEqual(model.inputModalities, ['text', 'image'])
  assert.deepEqual(model.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high'])
  // 上游没说默认档位，那就别编（V1ki 同款决定）。
  assert.equal(model.reasoning.defaultEffort, undefined)
})

test('a missing context window still yields a positive integer', () => {
  // 宿主拿 contextWindow 做校验，不是正整数就抛 `adapter returned invalid context metadata`，
  // 而那是 provider 级失败——整族从模型选择器里消失。所以兜底必须是正整数。
  const bare = modelInfoFromCatalog(catalogEntry({ capabilities: {} }), copilotFamily.route)
  assertModelShape(bare)
  assert.equal(bare.context.contextWindow, COPILOT_CONTEXT_WINDOW)
  assert.equal(bare.defaultMaxTokens, COPILOT_DEFAULT_MAX_TOKENS)

  const nonsense = [
    { max_context_window_tokens: 0 },
    { max_context_window_tokens: -1 },
    { max_context_window_tokens: null },
    { max_context_window_tokens: 'not a number' },
  ]
  for (const limits of nonsense) {
    const model = modelInfoFromCatalog(catalogEntry({ capabilities: { limits } }), copilotFamily.route)
    assertModelShape(model)
    assert.equal(model.context.contextWindow, COPILOT_CONTEXT_WINDOW)
  }
  // 数值形态的字符串是上游真会给的东西，认它。
  const stringy = modelInfoFromCatalog(
    catalogEntry({ capabilities: { limits: { max_context_window_tokens: '64000' } } }),
    copilotFamily.route,
  )
  assert.equal(stringy.context.contextWindow, 64_000)
})

test('a window smaller than the default output budget clamps the budget', () => {
  const model = modelInfoFromCatalog(
    catalogEntry({ capabilities: { limits: { max_context_window_tokens: 4_096 } } }),
    copilotFamily.route,
  )
  assertModelShape(model)
  assert.equal(model.defaultMaxTokens, 4_096)
})

test('the prompt limit is used when the context window is absent, and both are conservative', () => {
  const limits = limitsFromCatalogEntry({ capabilities: { limits: { max_prompt_tokens: 32_000 } } })
  assert.equal(limits.contextWindow, 32_000)
  assert.equal(limitsFromCatalogEntry({ capabilities: {} }).contextWindow, undefined)
})

test('effort levels are de-duplicated, and a level we have no label for keeps its own id as name', () => {
  const efforts = normaliseEfforts(['low', 'low', 7, '', null, 'medium', 'xhigh', 'ultra'])
  assert.deepEqual(efforts, [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'xhigh', name: 'Extra High' },
    { id: 'ultra', name: 'ultra' },
  ])
  assert.deepEqual(normaliseEfforts(undefined), [])
  assert.deepEqual(normaliseEfforts('high'), [])
})

test('models the picker hides, the account disabled, or that need another wire are not listed', () => {
  const provider = copilotFamily.route
  assert.equal(modelInfoFromCatalog({ id: 'x', model_picker_enabled: true }, provider)?.id, 'x')
  assert.equal(modelInfoFromCatalog({ name: 'no id', model_picker_enabled: true }, provider), undefined)
  assert.equal(modelInfoFromCatalog({ id: 'x', model_picker_enabled: false }, provider), undefined)
  assert.equal(modelInfoFromCatalog({ id: 'x', model_picker_enabled: true, policy: { state: 'disabled' } }, provider), undefined)
  // 我们只接了 chat 线：只声明 /responses 的模型列出来，用户点下去必然 400。
  assert.equal(
    modelInfoFromCatalog(catalogEntry({ supported_endpoints: ['/responses'] }), provider),
    undefined,
  )
})

test('the endpoint list decides the wire, and a missing list means the old chat behaviour', () => {
  assert.equal(servesChatWire({}), true, '旧版目录没有这个字段，那时的模型都走 chat')
  assert.equal(servesChatWire({ supported_endpoints: [] }), true)
  assert.equal(servesChatWire({ supported_endpoints: [CHAT_WIRE] }), true)
  assert.equal(servesChatWire({ supported_endpoints: ['/responses', CHAT_WIRE] }), true)
  assert.equal(servesChatWire({ supported_endpoints: ['/responses'] }), false)
  assert.equal(servesChatWire({ supported_endpoints: 'nonsense' }), true)
})

test('the catalog is de-duplicated and an empty one is a failure, not a settled account', () => {
  const json = {
    data: [
      catalogEntry({ id: 'gpt-4.1' }),
      catalogEntry({ id: 'gpt-4.1', name: 'duplicate' }),
      catalogEntry({ id: 'gpt-5.6', supported_endpoints: ['/responses'] }),
      catalogEntry({ id: 'gpt-4o' }),
    ],
  }
  const models = modelsFromCatalog(json, copilotFamily.route)
  assert.deepEqual(models.map((model) => model.id), ['gpt-4.1', 'gpt-4o'])
  assert.equal(models[0].name, 'GPT-4.1', '重复 id 保留先出现的那个')

  // 200 但空目录 = 接口形态变了，必须当失败，好让上层回落到静态兜底。
  assert.throws(() => modelsFromCatalog({ data: [] }, copilotFamily.route), /empty catalog/)
  assert.throws(() => modelsFromCatalog({}, copilotFamily.route), /no data array/)
  assert.throws(
    () => modelsFromCatalog({ data: [catalogEntry({ supported_endpoints: ['/responses'] })] }, copilotFamily.route),
    /no usable chat model/,
  )
})

// ------------------------------------------------------------------ 族：目录

test('listModels reads the catalog from the account own api endpoint', async () => {
  const seen = []
  const ctx = recordingCtx((url, init) => {
    seen.push({ url, init })
    return jsonResponse({ data: [catalogEntry()] })
  })
  const models = await copilotFamily.listModels(ctx, account({ auth: { endpoints: { api: BUSINESS_API } } }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `${BUSINESS_API}/models`)
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.headers.authorization, 'Bearer copilot-token')
  assert.equal(seen[0].init.headers['editor-version'], `vscode/${FALLBACK_VSCODE_VERSION}`)
  assertModelShape(models[0])
})

test('two accounts with different endpoints never share a base url', async () => {
  const urls = []
  const ctx = recordingCtx((url) => {
    urls.push(url)
    return jsonResponse({ data: [catalogEntry()] })
  })
  await copilotFamily.listModels(ctx, account({ auth: { endpoints: { api: INDIVIDUAL_API } } }))
  await copilotFamily.listModels(ctx, account({ auth: { endpoints: { api: BUSINESS_API } } }))
  assert.deepEqual(urls, [`${INDIVIDUAL_API}/models`, `${BUSINESS_API}/models`])
})

test('a broken catalog falls back to a static list instead of emptying the provider', async () => {
  const ctx = recordingCtx(() => errorResponse(403, '{"message":"forbidden"}'))
  const models = await copilotFamily.listModels(ctx, account())
  assert.deepEqual(models.map((model) => model.id), ['gpt-4.1', 'gpt-4o', 'claude-sonnet-4.5', 'gemini-2.5-pro'])
  for (const model of models) assertModelShape(model)
  assert.equal(ctx.warnings.length, 1, '回落要说一声')

  // 200 但空目录同样是失败。
  const empty = recordingCtx(() => jsonResponse({ data: [] }))
  assert.equal((await copilotFamily.listModels(empty, account())).length, 4)
})

test('a catalog entry we already saw wins over the conservative fallback', async () => {
  const ctx = recordingCtx(() =>
    jsonResponse({ data: [catalogEntry({ id: 'gpt-4o-mini', capabilities: { limits: { max_context_window_tokens: 64_000 } } })] }),
  )
  const [model] = await copilotFamily.listModels(ctx, account())
  assert.equal(model.context.contextWindow, 64_000)
  // resolveModel 拿不到 payload（契约给的签名就没有），所以只能靠进程内记住的目录。
  const resolved = copilotFamily.resolveModel(copilotFamily.route, 'gpt-4o-mini')
  assert.equal(resolved.context.contextWindow, 64_000)
  assert.equal(resolved.provider, copilotFamily.route)
  assert.equal(resolved.id, 'gpt-4o-mini')
})

test('resolving a model we never saw still describes it safely', () => {
  const model = copilotFamily.resolveModel(copilotFamily.route, 'gpt-5.6')
  assertModelShape(model)
  assert.equal(model.id, 'gpt-5.6')
  assert.equal(model.name, 'gpt-5.6')
  assert.equal(model.context.contextWindow, COPILOT_CONTEXT_WINDOW)
})

test('a static fallback entry must never overwrite what the real catalog said', async () => {
  // 目录先成功（拿到真实窗口），随后上游抽风：兜底条目不许把 128000 覆盖成兜底值。
  const good = recordingCtx(() =>
    jsonResponse({ data: [catalogEntry({ id: 'claude-sonnet-4.5', capabilities: { limits: { max_context_window_tokens: 200_000 } } })] }),
  )
  await copilotFamily.listModels(good, account())
  const bad = recordingCtx(() => errorResponse(500, 'down'))
  const models = await copilotFamily.listModels(bad, account())
  const model = models.find((item) => item.id === 'claude-sonnet-4.5')
  assert.equal(model.context.contextWindow, 200_000)
  assert.equal(copilotFamily.resolveModel(copilotFamily.route, 'claude-sonnet-4.5').context.contextWindow, 200_000)
})

// ------------------------------------------------------------------ 族：请求体与工具

test('the request body uses the parameter names Copilot actually accepts', () => {
  const { body, hasTools, droppedEffort } = copilotChatBody({
    model: 'gpt-4.1',
    system: 'be brief',
    messages: [userMessage('hi')],
    maxTokens: 1_024,
  })
  assert.equal(body.model, 'gpt-4.1')
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'be brief')
  assert.equal(body.messages[1].content, 'hi', '纯文本消息发字符串，不发数组')
  // 新版模型只认 max_completion_tokens，旧拼写会 400。
  assert.equal(body.max_completion_tokens, 1_024)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.stream, true)
  // 上游只会流式返回：不发 include_usage 就没有用量可显示。
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(hasTools, false)
  assert.equal(droppedEffort, undefined)
  assert.deepEqual(Object.keys(body).filter((key) => /initiator/i.test(key)), [])
})

test('tools and a reasoning effort cannot travel together on the chat wire', () => {
  const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }]
  const withTools = copilotChatBody({ model: 'm', messages: [userMessage('hi')], tools, effort: 'high' })
  assert.equal(withTools.hasTools, true)
  assert.equal(withTools.body.tool_choice, 'auto')
  assert.equal(withTools.body.tools.length, 1)
  // 上游在 chat 线上拒这个组合（400 invalid_request_body）⇒ 我们退掉 effort 并报告退掉了什么。
  assert.equal(withTools.body.reasoning_effort, undefined)
  assert.equal(withTools.droppedEffort, 'high')

  // `none` 是上游自己推荐的取值，和工具一起发是合法的。
  assert.deepEqual(planReasoningEffort({ hasTools: true, effort: 'none' }), { effort: 'none', dropped: undefined })
  // 没有工具时 effort 不该被动。
  assert.deepEqual(planReasoningEffort({ hasTools: false, effort: 'high' }), { effort: 'high', dropped: undefined })
  assert.deepEqual(planReasoningEffort({ hasTools: false }), { effort: undefined, dropped: undefined })
  // 扁平字符串，不是 responses 线的 `reasoning: {effort}`（写错会被静默忽略）。
  const noTools = copilotChatBody({ model: 'm', messages: [userMessage('hi')], effort: 'low' })
  assert.equal(noTools.body.reasoning_effort, 'low')
  assert.equal(noTools.body.reasoning, undefined)
})

// ------------------------------------------------------------------ 族：推理

test('a streamed answer goes out as the chunk sequence the host expects', async () => {
  const ctx = recordingCtx((url) => {
    assert.equal(url, `${INDIVIDUAL_API}${CHAT_WIRE}`)
    return sseResponse([
      { choices: [{ delta: { content: '你' } }] },
      { choices: [{ delta: { content: '好' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } },
      '[DONE]',
    ])
  })
  const chunks = await collect(
    copilotFamily.stream(ctx, {
      payload: account(),
      model: 'gpt-4.1',
      messages: [userMessage('hi')],
      system: 'be brief',
      maxTokens: 100,
    }),
  )
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你' },
    { type: 'text-delta', index: 0, text: '好' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 2, cachedInputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('the upstream call is streaming and keeps the account proxy', async () => {
  // 不传第 4 个参数：配了代理的账号会在长推理里被 undici 默认 30s 的 bodyTimeout 掐断
  // （src/http.js 文件头记的那次事故，test/streaming-flag.test.js 是它的哨兵）。
  const ctx = recordingCtx(() => sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, '[DONE]']))
  await collect(
    copilotFamily.stream(ctx, {
      payload: account({ proxy: 'http://proxy.test:8080' }),
      model: 'gpt-4.1',
      messages: [userMessage('hi')],
    }),
  )
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].streaming, true)
  assert.equal(ctx.calls[0].proxy, 'http://proxy.test:8080')
  const headers = ctx.calls[0].init.headers
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers.authorization, 'Bearer copilot-token')
  assert.equal(headers['editor-version'], `vscode/${FALLBACK_VSCODE_VERSION}`)
  const body = JSON.parse(ctx.calls[0].init.body)
  assert.equal(body.model, 'gpt-4.1')
  assert.equal(body.stream, true)
})

test('inference goes to the endpoint this account was given', async () => {
  const urls = []
  const ctx = recordingCtx((url) => {
    urls.push(url)
    return sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, '[DONE]'])
  })
  for (const api of [INDIVIDUAL_API, BUSINESS_API]) {
    await collect(copilotFamily.stream(ctx, { payload: account({ auth: { endpoints: { api } } }), model: 'm', messages: [userMessage('hi')] }))
  }
  assert.deepEqual(urls, [`${INDIVIDUAL_API}${CHAT_WIRE}`, `${BUSINESS_API}${CHAT_WIRE}`])
})

test('an account without an endpoint is refused instead of being sent to a hardcoded host', async () => {
  const ctx = recordingCtx(() => sseResponse([]))
  await assert.rejects(
    collect(copilotFamily.stream(ctx, { payload: account({ auth: { endpoints: {} } }), model: 'm', messages: [userMessage('hi')] })),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.doesNotMatch(error.message, /githubcopilot\.com/)
      return true
    },
  )
  assert.equal(ctx.calls.length, 0, '连请求都不该发出去')
})

test('an account without a copilot token is refused before any request', async () => {
  const ctx = recordingCtx(() => sseResponse([]))
  for (const access of [undefined, '']) {
    await assert.rejects(
      collect(copilotFamily.stream(ctx, { payload: account({ auth: { access } }), model: 'm', messages: [userMessage('hi')] })),
      (error) => {
        assert.equal(error.code, 'AUTH')
        return true
      },
    )
  }
  assert.equal(ctx.calls.length, 0)
})

test('a thinking model still reports its thinking as a reasoning block', async () => {
  const ctx = recordingCtx(() =>
    sseResponse([
      { choices: [{ delta: { reasoning_content: '想' } }] },
      { choices: [{ delta: { content: '答' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]),
  )
  const chunks = await collect(copilotFamily.stream(ctx, { payload: account(), model: 'm', messages: [userMessage('hi')] }))
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '想' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '答' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: '答' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('a tool call comes back as a tool-call block with its arguments as a string', async () => {
  const ctx = recordingCtx(() =>
    sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]),
  )
  const chunks = await collect(copilotFamily.stream(ctx, { payload: account(), model: 'm', messages: [userMessage('hi')] }))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(end.block.id, 'call_1')
  assert.equal(end.block.name, 'read_file')
  assert.equal(end.block.arguments, '{"path":"a"}')
})

test('a truncated answer reports max-tokens, not stop', async () => {
  const ctx = recordingCtx(() => sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }, '[DONE]']))
  const chunks = await collect(copilotFamily.stream(ctx, { payload: account(), model: 'm', messages: [userMessage('hi')] }))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('an answer with no content at all is an error the pool can retry elsewhere', async () => {
  const ctx = recordingCtx(() => sseResponse(['[DONE]']))
  await assert.rejects(
    collect(copilotFamily.stream(ctx, { payload: account(), model: 'm', messages: [userMessage('hi')] })),
    (error) => {
      assert.equal(error.code, 'EMPTY_RESPONSE')
      return true
    },
  )
})

test('an upstream failure keeps the status code the pool classifies on', async () => {
  const ctx = recordingCtx(() => errorResponse(429, '{"message":"You have exceeded your usage limit"}'))
  await assert.rejects(
    collect(copilotFamily.stream(ctx, { payload: account(), model: 'm', messages: [userMessage('hi')] })),
    (error) => {
      assert.equal(error.code, 'QUOTA')
      assert.equal(error.failure.status, 429)
      return true
    },
  )
})

test('a 401 on the inference path re-resolves the editor version and retries once', async () => {
  // 上游的 401 有两个来源：令牌被撤 / editor-version 太旧。响应体不可靠区分，
  // 而代价不对称：多查一次发布列表很便宜，整族 100% 401 很贵。
  let feedCalls = 0
  let inferenceCalls = 0
  const versions = []
  const ctx = recordingCtx(
    (url, init) => {
      if (url === VSCODE_RELEASES_URL) {
        feedCalls += 1
        return jsonResponse([`1.${130 + feedCalls}.0`])
      }
      inferenceCalls += 1
      versions.push(init.headers['editor-version'])
      if (inferenceCalls === 1) return errorResponse(401, '{"message":"IDE token expired"}')
      return sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'])
    },
    // 钉死版本号就没有「重取」可言：这条必须走动态解析。
    { config: {} },
  )
  const chunks = await collect(
    copilotFamily.stream(ctx, { payload: account(), model: 'm', messages: [userMessage('hi')] }),
  )
  assert.equal(inferenceCalls, 2)
  assert.notEqual(versions[0], versions[1])
  assert.equal(chunks.at(-1).type, 'finish')
  void feedCalls
})

test('a 401 that survives the version refresh is reported as auth', async () => {
  const ctx = recordingCtx(
    (url) => {
      if (url === VSCODE_RELEASES_URL) return jsonResponse(['1.150.0'])
      return errorResponse(401, '{"message":"Bad credentials"}')
    },
    { config: {} },
  )
  await assert.rejects(
    collect(copilotFamily.stream(ctx, { payload: account(), model: 'm', messages: [userMessage('hi')] })),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.match(error.message, /Bad credentials/)
      return true
    },
  )
})

test('the editor version can be pinned for the day our lookup is the thing that breaks', async () => {
  const ctx = recordingCtx(
    (url) => {
      if (url === VSCODE_RELEASES_URL) throw new Error('the feed must not be consulted when it is pinned')
      return sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, '[DONE]'])
    },
    { config: { copilotEditorVersion: '1.222.0' } },
  )
  await collect(copilotFamily.stream(ctx, { payload: account(), model: 'm', messages: [userMessage('hi')] }))
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].init.headers['editor-version'], 'vscode/1.222.0')

  // 形态不对的覆盖值直接忽略（一个 `latest` 会让我们收到一串 401）。
  const bad = recordingCtx(
    (url) => (url === VSCODE_RELEASES_URL ? jsonResponse(['1.107.0']) : sseResponse(['[DONE]'])),
    { config: { copilotEditorVersion: 'latest' } },
  )
  await assert.rejects(collect(copilotFamily.stream(bad, { payload: account(), model: 'm', messages: [userMessage('hi')] })))
  const sent = bad.calls.find((call) => call.url.includes(CHAT_WIRE))
  assert.match(sent.init.headers['editor-version'], /^vscode\/\d+\.\d+\.\d+$/, '非法覆盖值必须被忽略，回落到真实的版本号')
})

test('dropping the effort for a tool call is reported once, not silently and not repeatedly', async () => {
  const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }]
  const ctx = recordingCtx(() => sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, '[DONE]']))
  const options = {
    payload: account(),
    model: 'drop-effort-once',
    messages: [userMessage('hi')],
    tools,
    effort: 'high',
  }
  await collect(copilotFamily.stream(ctx, options))
  await collect(copilotFamily.stream(ctx, options))
  const body = JSON.parse(ctx.calls[0].init.body)
  assert.equal(body.reasoning_effort, undefined, '有工具时 effort 必须退掉，否则上游 400')
  assert.equal(body.tools.length, 1)
  assert.equal(
    ctx.warnings.filter((args) => String(args[0]).includes('reasoning effort')).length,
    1,
    '同一个模型只提醒一次，日志不能被每个请求刷一遍',
  )
})

test('a vision request announces itself, a text one does not', async () => {
  const ctx = recordingCtx(() => sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, '[DONE]']))
  await collect(
    copilotFamily.stream(ctx, {
      payload: account(),
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }] }],
    }),
  )
  assert.equal(ctx.calls[0].init.headers['copilot-vision-request'], 'true')
  const body = JSON.parse(ctx.calls[0].init.body)
  const parts = body.messages.at(-1).content
  assert.ok(Array.isArray(parts), '带图片的消息要升级成内容块数组')
  assert.equal(parts[1].image_url.url, 'data:image/png;base64,AAAA')
})

// ------------------------------------------------------------------ 族：登录

/** 一个最小的假登录会话（它的形状由宿主的 authorization seam + broker 决定）。 */
function fakeSession({ proxy } = {}) {
  const notifications = []
  const commits = []
  const prompts = []
  return {
    proxy,
    signal: undefined,
    notifications,
    commits,
    prompts,
    notify(notice) {
      notifications.push(notice)
    },
    async prompt(prompt) {
      prompts.push(prompt)
      throw new Error('copilot 的登录流程不该问用户任何问题')
    },
    async commit(grant) {
      commits.push(grant)
    },
  }
}

test('the device flow login notifies the user, polls, and commits before it resolves', async () => {
  const polls = []
  const ctx = recordingCtx((url, init) => {
    if (url === DEVICE_CODE_URL) {
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('client_id'), CLIENT_ID)
      // 设备码只是「照着念」的信息，只能用 notify 交给用户（session.prompt 没有 initial）。
      return jsonResponse({
        device_code: 'dev-1',
        user_code: 'ABCD-1234',
        verification_uri: DEVICE_VERIFY_URL,
        interval: 0.001,
        expires_in: 900,
      })
    }
    if (url === DEVICE_TOKEN_URL) {
      polls.push(new URLSearchParams(init.body).get('device_code'))
      return polls.length === 1 ? jsonResponse({ error: 'authorization_pending' }) : jsonResponse({ access_token: 'ghu_from_device_flow' })
    }
    if (url === COPILOT_TOKEN_URL) return jsonResponse(tokenJson())
    if (url === GITHUB_USER_URL) return jsonResponse({ login: 'octocat' })
    return undefined
  })
  const session = fakeSession()
  await copilotFamily.login.run(session, ctx)

  assert.equal(session.notifications.length, 1)
  const notice = session.notifications[0]
  assert.match(notice.message, /ABCD-1234/, '用户代码必须在通知里')
  assert.equal(notice.url, DEVICE_VERIFY_URL)
  assert.equal(notice.code, 'ABCD-1234')
  assert.deepEqual(polls, ['dev-1', 'dev-1'])

  assert.equal(session.commits.length, 1, '必须在 resolve 之前 commit，否则 seam 抛 NOT_COMMITTED')
  const grant = session.commits[0]
  assert.equal(grant.kind, 'grant')
  assert.equal(grant.payload.family, 'copilot')
  assert.equal(grant.payload.label, 'octocat')
  assert.equal(grant.payload.source, 'oauth')
  assert.equal(grant.payload.externallyOwned, false, '这份登录态是我们自己换来的，不借别人的')
  assert.equal(grant.payload.auth.access, tokenJson().token)
  // GitHub 的长期 token 必须留下：刷新就是拿它重做一次交换。
  assert.equal(grant.payload.auth.refresh, 'ghu_from_device_flow')
  assert.equal(grant.payload.auth.endpoints.api, INDIVIDUAL_API)
  // id 由 store 分配（promoteLoginSlot），族里塞一个会让每次登录都撞同一个键。
  assert.equal('id' in grant.payload, false)
  assert.deepEqual(session.prompts, [], '这条流程全程只用 notify（非交互路径也能跑完）')
})

test('a declined device flow fails as auth and commits nothing', async () => {
  const ctx = recordingCtx((url) => {
    if (url === DEVICE_CODE_URL) {
      return jsonResponse({ device_code: 'dev-1', user_code: 'X', verification_uri: DEVICE_VERIFY_URL, interval: 0.001, expires_in: 900 })
    }
    if (url === DEVICE_TOKEN_URL) return jsonResponse({ error: 'access_denied' })
    return undefined
  })
  const session = fakeSession()
  await assert.rejects(copilotFamily.login.run(session, ctx), (error) => {
    assert.equal(error.code, 'AUTH')
    return true
  })
  assert.equal(session.commits.length, 0)
})

test('the account label falls back instead of inventing a name, and a failed user lookup is not fatal', async () => {
  const ctx = recordingCtx((url) => {
    if (url === DEVICE_CODE_URL) {
      return jsonResponse({ device_code: 'dev-1', user_code: 'X', verification_uri: DEVICE_VERIFY_URL, interval: 0.001, expires_in: 900 })
    }
    if (url === DEVICE_TOKEN_URL) return jsonResponse({ access_token: 'ghu_x' })
    if (url === COPILOT_TOKEN_URL) return jsonResponse(tokenJson())
    if (url === GITHUB_USER_URL) return errorResponse(500, 'down')
    return undefined
  })
  const session = fakeSession()
  await copilotFamily.login.run(session, ctx)
  assert.equal(session.commits[0].payload.label, 'GitHub Copilot')
  assert.equal(session.commits[0].payload.auth.access, tokenJson().token, '读不到用户名不该让一次成功的登录白跑')
})

test('the login flow offers exactly one method, and it is the device flow', () => {
  assert.deepEqual(copilotFamily.login.methods, [{ id: 'device', label: '用设备码登录 GitHub Copilot' }])
})

test('an account with no copilot subscription fails the login instead of pretending to succeed', async () => {
  // 没有订阅 / 没被授权的账号在换 token 这一步被拒——这是「这个账号到底有没有 Copilot」
  // 唯一的判据，所以必须让登录失败，而不是存一条用不了的凭据。
  const ctx = recordingCtx((url) => {
    if (url === DEVICE_CODE_URL) {
      return jsonResponse({ device_code: 'dev-1', user_code: 'X', verification_uri: DEVICE_VERIFY_URL, interval: 0.001, expires_in: 900 })
    }
    if (url === DEVICE_TOKEN_URL) return jsonResponse({ access_token: 'ghu_no_subscription' })
    if (url === COPILOT_TOKEN_URL) return errorResponse(403, '{"message":"Copilot is not enabled for this account"}')
    return undefined
  })
  const session = fakeSession()
  await assert.rejects(copilotFamily.login.run(session, ctx), (error) => {
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /not enabled/)
    return true
  })
  assert.equal(session.commits.length, 0)
})

// ------------------------------------------------------------------ 族：刷新

test('refresh returns just the auth object, because the pool shallow merges it', async () => {
  const ctx = recordingCtx(() => jsonResponse(tokenJson({ token: 'fresh-copilot-token', endpoints: { api: BUSINESS_API } })))
  const auth = await copilotFamily.refresh(ctx, account(), undefined)
  // 池子是 `{...current.auth, ...auth}`：返回整个 payload 会把 auth 之外的东西也摊进 auth 里。
  assert.equal(auth.family, undefined)
  assert.equal(auth.label, undefined)
  assert.equal(auth.access, 'fresh-copilot-token')
  assert.equal(auth.endpoints.api, BUSINESS_API, '刷新可能换到另一个端点，必须带上')
  // `ghu_*` 不轮换：刷新是拿同一个 GitHub token 重做交换，所以这个键必须原样留着。
  assert.equal(auth.refresh, 'ghu_github-token')
  assert.equal(ctx.calls[0].init.headers.authorization, 'Bearer ghu_github-token')
})

test('refresh works when the pool calls it without a signal', async () => {
  const ctx = recordingCtx(() => jsonResponse(tokenJson()))
  const auth = await copilotFamily.refresh(ctx, account(), undefined)
  assert.equal(ctx.calls[0].init.signal, undefined)
  assert.equal(typeof auth.expiresAt, 'number')
})

test('refresh without a github token is an auth failure', async () => {
  const ctx = recordingCtx(() => jsonResponse(tokenJson()))
  await assert.rejects(copilotFamily.refresh(ctx, account({ auth: { refresh: undefined } }), undefined), (error) => {
    assert.equal(error.code, 'AUTH')
    return true
  })
  assert.equal(ctx.calls.length, 0)
})

test('needsRefresh is exposed and agrees with the wire helper', () => {
  const now = Date.now()
  assert.equal(copilotFamily.needsRefresh(account({ auth: { expiresAt: now + 60 * 60_000 } }), now), false)
  assert.equal(copilotFamily.needsRefresh(account({ auth: { expiresAt: now } }), now), true)
})

// ------------------------------------------------------------------ 族：额度与形状

test('quota reports unknown instead of inventing a zero', async () => {
  const result = await copilotFamily.quota({}, account(), undefined)
  assert.equal(result, undefined)
  assert.notEqual(result, 0, '0% 和「查不到」是两件事：面板要显示「未知」，不是「用完了」')
  // 面板的判定形状（client.js 对空数组/undefined 都渲染「额度 未知」）。
  assert.equal(Array.isArray(result), false)
})

test('the family surface is the shape the registry and the host expect', () => {
  assert.equal(copilotFamily.id, 'copilot')
  assert.equal(copilotFamily.route, 'acct-copilot')
  assert.equal(copilotFamily.displayName, 'GitHub Copilot')
  // 非公开的 token 交换接口 + editor-version 定时炸弹：两个风险都不归我们管，照实写 high。
  assert.equal(copilotFamily.risk, 'high')
  for (const method of ['discover', 'refresh', 'needsRefresh', 'listModels', 'resolveModel', 'quota', 'stream']) {
    assert.equal(typeof copilotFamily[method], 'function', `${method} 应该是可调用的`)
  }
  // 没有任何 importable 的发现结果 ⇒ 不实现 recordFromDiscovery（写了就是契约 §2 说的空壳），
  // 但登录方式必须有。
  assert.equal(copilotFamily.recordFromDiscovery, undefined)
  assert.ok(Array.isArray(copilotFamily.login.methods) && copilotFamily.login.methods.length > 0)
  assert.equal(typeof copilotFamily.login.run, 'function')
})

test('a model id we cannot describe is still a positive window', () => {
  assert.equal(modelInfo('m', 'm', {}, copilotFamily.route).context.contextWindow, COPILOT_CONTEXT_WINDOW)
  assert.equal(positiveInteger(0), undefined)
  assert.equal(positiveInteger(-3), undefined)
  assert.equal(positiveInteger(1.9), 1)
  assert.equal(positiveInteger(' 2048 '), 2_048)
})

test('apiBaseUrl trims the slash and refuses an empty endpoint', () => {
  assert.equal(apiBaseUrl({ endpoints: { api: `${INDIVIDUAL_API}/` } }), INDIVIDUAL_API)
  assert.throws(() => apiBaseUrl({}), (error) => {
    assert.equal(error.code, 'AUTH')
    return true
  })
})

// ------------------------------------------------------------------ 族：发现

test('discover says out loud that this machine has nothing importable', async () => {
  const items = await copilotFamily.discover({ log: { warn: () => {} } })
  assert.ok(Array.isArray(items), '永远返回数组，哪怕里面只有一条「不可导入」')
  assert.equal(items.length, 1)
  const [item] = items
  assert.equal(item.family, 'copilot')
  assert.equal(item.importable, false)
  assert.equal(typeof item.sourcePath, 'string')
  assert.ok(item.sourcePath.length > 0)
  assert.match(item.reason, /(DPAPI|钥匙串)/)
  assert.match(item.reason, /结论：这一族只能走设备码登录/)
})

test('the reason names both what we looked at and why it cannot be read', () => {
  const sites = credentialSites({ platform: 'win32', env: { APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' }, home: 'C:\\Users\\me' })
  assert.equal(sites.length, 7)
  const paths = sites.map((site) => site.path)
  assert.equal(new Set(paths).size, paths.length, '位点不该重复')
  assert.ok(paths.includes('C:\\Roaming\\Microsoft\\Credentials'), 'Windows 凭据保险箱是第一个该去看的地方')

  const reason = importBlockerReason(sites, { existing: [paths[0]], platform: 'win32' })
  assert.match(reason, /DPAPI/)
  assert.match(reason, /确实存在的位点/)
  assert.match(reason, /不存在：/)
  assert.match(reason, /只能走设备码登录/)

  // 别的平台不许说 DPAPI（那是错的）。
  const linux = credentialSites({ platform: 'linux', home: '/home/me', env: {} })
  assert.equal(linux.length, 4)
  const linuxReason = importBlockerReason(linux, { platform: 'linux' })
  assert.doesNotMatch(linuxReason, /DPAPI/)
  assert.match(linuxReason, /libsecret|gnome-keyring/)
})

// ------------------------------------------------------------------ 真机（默认跳过）

live('live: the vs code release feed is reachable and the version parses', async () => {
  const ctx = {
    log: { warn: () => {} },
    fetch: (url, init, proxy, streaming) => globalThis.fetch(url, init),
  }
  const version = await createVersionResolver().resolve(ctx)
  assert.notEqual(version, undefined)
  assert.match(version, /^\d+\.\d+\.\d+$/)
})

live('live: github hands out a device code for our client id', async () => {
  const ctx = {
    log: { warn: () => {} },
    fetch: (url, init, proxy, streaming) => globalThis.fetch(url, init),
  }
  const request = deviceCodeRequest()
  const response = await ctx.fetch(request.url, request.init)
  assert.equal(response.ok, true)
  const device = readDeviceCode(await response.json())
  assert.match(device.userCode, /\S/)
  assert.equal(device.verificationUri, DEVICE_VERIFY_URL)
})

live('live: a real copilot token exchange works for the signed-in account', async (t) => {
  // 本机没有 Copilot 订阅，所以这条从来没跑过：它需要 COPILOT_LIVE_GITHUB_TOKEN
  // （一个真实登录过的 `ghu_*`）才谈得上「验证」。
  const githubToken = process.env.COPILOT_LIVE_GITHUB_TOKEN
  if (!githubToken) {
    t.skip('没有 COPILOT_LIVE_GITHUB_TOKEN：这台机器上没法验证真实的换 token')
    return
  }
  const ctx = {
    log: { warn: () => {} },
    fetch: (url, init, proxy, streaming) => globalThis.fetch(url, init),
  }
  const auth = await exchangeCopilotToken({ ctx, githubToken, resolver: createVersionResolver() })
  assert.match(auth.endpoints.api, /^https:\/\//)
  assert.ok(Number.isInteger(auth.expiresAt) && auth.expiresAt > Date.now())
})
