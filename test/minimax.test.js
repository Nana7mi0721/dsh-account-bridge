/**
 * MiniMax Code（mcode）族的回归测试。
 *
 * 这里钉住的是「错了会弄坏用户别的软件」或「错了会悄悄说谎」的几条：
 * - **写回桌面端的 generation CAS**：桌面端在中间先刷过就必须放弃写入，
 *   否则我们把一只已经作废的 refresh token 盖回去，用户下次打开 MiniMax Code 就得重新登录；
 * - **记录键里的 NUL 字节**必须原样保留（拼键名的方式永远找不到它）；
 * - **目录是快照**，不是从网上抓的（上游没有目录接口，测试不该假装有）；
 * - **额度读不到就不报**，不能编一个 0%。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { minimaxFamily, authFromGrant, readDesktop, writeBackDesktop, credentialPath, statePath } from '../src/families/minimax.js'

/** 真实记录键的形状：中间那个 NUL 字节是上游自己写进去的。 */
const RECORD_KEY = 'com.minimax.mcode.oauth.prod.en\u0000a1b2c3d4'

function credentialDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    records: {
      [RECORD_KEY]: {
        schemaVersion: 1,
        accessToken: 'mmoat_original',
        refreshToken: 'mmort_original',
        tokenType: 'Bearer',
        clientId: 'mcode-public',
        scopes: ['agent.default'],
        audience: 'agent-backend',
        expiresAtMs: Date.now() + 3_600_000,
        generation: 7,
        loginEpoch: '0f0f0f0f-1111-2222-3333-444444444444',
      },
    },
    ...overrides,
  }
}

function stateDoc() {
  return {
    schemaVersion: 2,
    status: 'authenticated',
    storeKind: 'file',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    buildEnv: 'prod',
    region: 'en',
    generation: 7,
    expiresAtMs: Date.now() + 3_600_000,
  }
}

/** 造一个临时 MINIMAX_HOME（含一个 region 的凭据），在回调里跑，跑完复原环境变量。 */
async function withMinimaxHome(region, doc, body, { state } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-minimax-'))
  const dir = join(home, 'auth', 'prod', region, 'mcode-public')
  await mkdir(dir, { recursive: true })
  if (doc !== undefined) await writeFile(join(dir, 'auth.json'), JSON.stringify(doc), 'utf8')
  if (state !== undefined) await writeFile(join(dir, 'auth-state.json'), JSON.stringify(state), 'utf8')
  const previous = process.env.MINIMAX_HOME
  process.env.MINIMAX_HOME = home
  try {
    return await body(home)
  } finally {
    if (previous === undefined) delete process.env.MINIMAX_HOME
    else process.env.MINIMAX_HOME = previous
  }
}

/** 假 ctx：记录请求，按 `handler` 给响应。 */
function fakeCtx(handler) {
  const calls = []
  return {
    calls,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    async fetch(url, init, proxy) {
      calls.push({ url, init, proxy })
      return handler(url, init, proxy)
    },
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    async text() {
      return JSON.stringify(body)
    },
    async json() {
      return body
    },
  }
}

/** 造一个只有 body 的假 SSE Response；readSse 只认 async iterable。 */
function sseResponse(events) {
  return {
    ok: true,
    status: 200,
    body: (async function* generate() {
      for (const event of events) yield `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
    })(),
  }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

// ------------------------------------------------------------------ 发现

test('discovery reads the desktop login and marks it externally owned', async () => {
  await withMinimaxHome('en', credentialDoc(), async () => {
    const items = await minimaxFamily.discover()
    assert.equal(items.length, 1)
    const [item] = items
    assert.equal(item.family, 'minimax')
    assert.equal(item.importable, true)
    assert.equal(item.externallyOwned, true)
    assert.equal(item.label, 'MiniMax Code（国际）')
    assert.equal(item.auth.access, 'mmoat_original')
    assert.equal(item.auth.refresh, 'mmort_original')
    assert.equal(item.auth.region, 'en')
    assert.match(item.sourcePath, /auth[\\/]prod[\\/]en[\\/]mcode-public[\\/]auth\.json$/)
  })
})

test('discovery reports nothing when MiniMax Code was never signed in', async () => {
  await withMinimaxHome('en', undefined, async () => {
    assert.deepEqual(await minimaxFamily.discover(), [])
  })
})

test('discovery prefers the international install and falls back to the CN one', async () => {
  await withMinimaxHome('cn', credentialDoc(), async () => {
    const items = await minimaxFamily.discover()
    assert.equal(items.length, 1)
    assert.equal(items[0].auth.region, 'cn')
    assert.equal(items[0].label, 'MiniMax Code（国内）')
  })
})

test('the record from discovery round-trips region, which the pool would otherwise drop', async () => {
  await withMinimaxHome('cn', credentialDoc(), async () => {
    const [item] = await minimaxFamily.discover()
    const record = minimaxFamily.recordFromDiscovery(item)
    assert.equal(record.family, 'minimax')
    assert.equal(record.source, 'client-import')
    assert.equal(record.externallyOwned, true)
    assert.equal(record.auth.region, 'cn')
  })
})

// ------------------------------------------------------------ 写回桌面端

test('write-back bumps the generation and mirrors it into auth-state.json', async () => {
  await withMinimaxHome('en', credentialDoc(), async (home) => {
    const result = await writeBackDesktop(
      'en',
      { generation: 7 },
      { access: 'mmoat_new', refresh: 'mmort_new', expiresAt: 1234567890 },
    )
    assert.equal(result.ok, true)
    assert.equal(result.generation, 8)

    const doc = JSON.parse(await readFile(join(home, 'auth', 'prod', 'en', 'mcode-public', 'auth.json'), 'utf8'))
    const record = doc.records[RECORD_KEY]
    assert.equal(record.accessToken, 'mmoat_new')
    assert.equal(record.refreshToken, 'mmort_new')
    assert.equal(record.expiresAtMs, 1234567890)
    assert.equal(record.generation, 8)
    // 别的字段一律保留——这是别人的文件，我们只动自己该动的那几个。
    assert.equal(record.clientId, 'mcode-public')
    assert.equal(record.loginEpoch, '0f0f0f0f-1111-2222-3333-444444444444')
    assert.deepEqual(record.scopes, ['agent.default'])
    // 键里那个 NUL 字节必须原样还在，否则桌面端就找不到自己的记录了。
    assert.equal(Object.keys(doc.records)[0], RECORD_KEY)
  }, { state: stateDoc() })
})

test('the state mirror follows the credential and reports the same generation', async () => {
  await withMinimaxHome('en', credentialDoc(), async (home) => {
    await writeBackDesktop('en', { generation: 7 }, { access: 'mmoat_new', refresh: 'mmort_new', expiresAt: 42 })
    const state = JSON.parse(await readFile(join(home, 'auth', 'prod', 'en', 'mcode-public', 'auth-state.json'), 'utf8'))
    assert.equal(state.status, 'authenticated')
    assert.equal(state.generation, 8)
    assert.equal(state.expiresAtMs, 42)
    // 状态文件里我们不认识的字段同样要留着。
    assert.equal(state.storeKind, 'file')
    assert.equal(state.buildVersion, undefined)
  }, { state: stateDoc() })
})

test('a desktop app that refreshed first wins: we do NOT write back', async () => {
  const doc = credentialDoc()
  // 桌面端在我们读到 generation 7 之后自己刷成了 9。
  doc.records[RECORD_KEY].generation = 9
  doc.records[RECORD_KEY].accessToken = 'mmoat_from_desktop'
  await withMinimaxHome('en', doc, async (home) => {
    const result = await writeBackDesktop(
      'en',
      { generation: 7 },
      { access: 'mmoat_stale', refresh: 'mmort_stale', expiresAt: 1 },
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'stale')
    const after = JSON.parse(await readFile(join(home, 'auth', 'prod', 'en', 'mcode-public', 'auth.json'), 'utf8'))
    // 一只已经作废的 refresh token 盖回去，用户下次打开桌面端就得重新登录。
    assert.equal(after.records[RECORD_KEY].accessToken, 'mmoat_from_desktop')
    assert.equal(after.records[RECORD_KEY].generation, 9)
  })
})

test('write-back gives up instead of throwing when there is nothing to write to', async () => {
  await withMinimaxHome('en', undefined, async () => {
    assert.deepEqual(await writeBackDesktop('en', { generation: 0 }, { access: 'a', refresh: 'r', expiresAt: 1 }), {
      ok: false,
      reason: 'unreadable',
    })
  })
})

// ---------------------------------------------------------------- 刷新

test('refresh posts the mcode form and returns the rotated pair', async () => {
  const ctx = fakeCtx(() =>
    jsonResponse(200, {
      access_token: 'mmoat_rotated',
      refresh_token: 'mmort_rotated',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'agent.default',
    }),
  )
  const auth = await minimaxFamily.refresh(
    ctx,
    { externallyOwned: false, auth: { refresh: 'mmort_old', access: 'mmoat_old', region: 'cn' } },
    undefined,
  )
  assert.equal(auth.access, 'mmoat_rotated')
  assert.equal(auth.refresh, 'mmort_rotated')
  assert.equal(auth.region, 'cn')
  assert.ok(auth.expiresAt > Date.now() + 3_000_000)

  const [call] = ctx.calls
  assert.equal(call.url, 'https://account.minimax.cn/oauth2/token')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['content-type'], 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(call.init.body)
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('refresh_token'), 'mmort_old')
  // 这两个值绝不能换成 portal 那套（client 78257093-…），两边互不认。
  assert.equal(form.get('client_id'), 'mcode-public')
  assert.equal(form.get('scope'), 'agent.default')
  assert.equal(form.get('audience'), 'agent-backend')
})

test('an imported account gets its rotation written back to the desktop files', async () => {
  await withMinimaxHome('en', credentialDoc(), async (home) => {
    const ctx = fakeCtx(() =>
      jsonResponse(200, { access_token: 'mmoat_rotated', refresh_token: 'mmort_rotated', expires_in: 3600 }),
    )
    await minimaxFamily.refresh(
      ctx,
      { externallyOwned: true, auth: { refresh: 'mmort_original', access: 'mmoat_original', region: 'en', generation: 7 } },
      undefined,
    )
    const doc = JSON.parse(await readFile(join(home, 'auth', 'prod', 'en', 'mcode-public', 'auth.json'), 'utf8'))
    assert.equal(doc.records[RECORD_KEY].accessToken, 'mmoat_rotated')
    assert.equal(doc.records[RECORD_KEY].refreshToken, 'mmort_rotated')
    assert.equal(doc.records[RECORD_KEY].generation, 8)
  }, { state: stateDoc() })
})

test('write-back is based on a fresh read, not on the generation captured at import', async () => {
  // 导入时记下的是 7，但桌面端自己启动时又刷了几次，文件已经是 12 了。
  // 拿导入时的 7 去比，CAS 永远不相等 ⇒ 永远不写回 ⇒ 我们在服务端轮换掉的那对令牌
  // 在桌面端就成了死令牌。真机上第一次跑就栽在这：文件 generation=16，
  // 记录里压根没有 generation，于是按 0 去比，一次都没写成功过——而且不报错。
  const stale = credentialDoc()
  stale.records[RECORD_KEY].generation = 12
  stale.records[RECORD_KEY].accessToken = 'mmoat_newer'
  stale.records[RECORD_KEY].refreshToken = 'mmort_newer'
  await withMinimaxHome('en', stale, async (home) => {
    const ctx = fakeCtx(() =>
      jsonResponse(200, { access_token: 'mmoat_rotated', refresh_token: 'mmort_rotated', expires_in: 3600 }),
    )
    const auth = await minimaxFamily.refresh(
      ctx,
      { externallyOwned: true, auth: { refresh: 'mmort_original', access: 'mmoat_original', region: 'en', generation: 7 } },
      undefined,
    )
    // 磁盘上那条更新的血统要被采用，而不是我们手上过时的那条。
    assert.equal(new URLSearchParams(ctx.calls[0].init.body).get('refresh_token'), 'mmort_newer')

    const doc = JSON.parse(await readFile(join(home, 'auth', 'prod', 'en', 'mcode-public', 'auth.json'), 'utf8'))
    assert.equal(doc.records[RECORD_KEY].accessToken, 'mmoat_rotated')
    assert.equal(doc.records[RECORD_KEY].generation, 13)
    // 返回的 auth 必须带上新版本号：池子是浅合并，不带的话记录还停在旧值，下一轮又对不上。
    assert.equal(auth.generation, 13)
  }, { state: stateDoc() })
})

test('authFromGrant carries generation forward so the record does not drift', () => {
  const next = authFromGrant(
    { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
    { region: 'cn', refresh: 'old', generation: 4 },
  )
  assert.equal(next.region, 'cn')
  assert.equal(next.generation, 4)
  // 插件内登录的账号本来就没有 generation，不该凭空多出一个字段。
  assert.equal('generation' in authFromGrant({ access_token: 'a' }, { region: 'en' }), false)
})

test('an account with no desktop file behind it is never written back to', async () => {
  // 插件内登录的账号（没有 externallyOwned）在桌面端没有对应文件，
  // 写回既没意义也可能写到别人的目录里去。
  await withMinimaxHome('en', undefined, async () => {
    const ctx = fakeCtx(() => jsonResponse(200, { access_token: 'mmoat_new', refresh_token: 'mmort_new', expires_in: 3600 }))
    const auth = await minimaxFamily.refresh(
      ctx,
      { auth: { refresh: 'mmort_original', access: 'mmoat_original', region: 'en' } },
      undefined,
    )
    assert.equal(auth.access, 'mmoat_new')
    assert.equal(ctx.calls.length, 1)
  })
})

test('an externally owned account refuses to refresh when the desktop file is gone', async () => {
  // 这是本插件能造成的最大破坏，而且不可逆：MiniMax 的 refresh token 是一次性的，
  // 我们拿它换出新令牌的那一刻，桌面端手里那条就作废了。此时若写不回去，
  // 用户下次打开 MiniMax Code 就被要求重新登录 —— 真机上确实这么发生过一次。
  // 所以读不到桌面端凭据就**根本不发这个请求**。
  await withMinimaxHome('en', undefined, async () => {
    const ctx = fakeCtx(() => jsonResponse(200, { access_token: 'mmoat_new', refresh_token: 'mmort_new' }))
    await assert.rejects(
      () =>
        minimaxFamily.refresh(
          ctx,
          { externallyOwned: true, auth: { refresh: 'mmort_original', access: 'mmoat_original', region: 'en' } },
          undefined,
        ),
      (error) => error.code === 'AUTH' && /readFile|桌面端凭据/.test(String(error.message)),
    )
    assert.equal(ctx.calls.length, 0, '既然写不回去，就不该把桌面端的令牌用掉')
  })
})

test('a write-back that fails mid-flight does not fail the refresh we already completed', async () => {
  // 桌面端在我们这一来一回之间把凭据删了（退出登录 / 卸载）。
  // 我们手上已经拿到可用的新令牌，不能因为写不回去就把这次刷新判死。
  await withMinimaxHome('en', credentialDoc(), async (home) => {
    const ctx = fakeCtx(async () => {
      await rm(join(home, 'auth'), { recursive: true, force: true })
      return jsonResponse(200, { access_token: 'mmoat_new', refresh_token: 'mmort_new', expires_in: 3600 })
    })
    const auth = await minimaxFamily.refresh(
      ctx,
      { externallyOwned: true, auth: { refresh: 'mmort_original', access: 'mmoat_original', region: 'en', generation: 7 } },
      undefined,
    )
    assert.equal(auth.access, 'mmoat_new')
  })
})

test('refresh refuses an account that has no refresh token instead of calling the endpoint', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, {}))
  await assert.rejects(
    () => minimaxFamily.refresh(ctx, { auth: { access: 'mmoat_only', region: 'en' } }, undefined),
    (error) => error.code === 'AUTH',
  )
  assert.equal(ctx.calls.length, 0)
})

test('a rejected refresh maps to AUTH so the pool retires the account', async () => {
  const ctx = fakeCtx(() => jsonResponse(401, { error: 'invalid_grant' }))
  await assert.rejects(
    () => minimaxFamily.refresh(ctx, { auth: { refresh: 'mmort_dead', region: 'en' } }, undefined),
    (error) => error.code === 'AUTH',
  )
})

test('authFromGrant keeps the previous region when the grant omits one', () => {
  const auth = authFromGrant({ access_token: 'a', refresh_token: 'r', expires_in: 60 }, { region: 'cn', refresh: 'old' })
  assert.equal(auth.region, 'cn')
  // 上游偶尔不回 refresh_token：那要沿用旧的，否则这一刷就把账号刷没了。
  assert.equal(authFromGrant({ access_token: 'a', expires_in: 60 }, { refresh: 'keep-me' }).refresh, 'keep-me')
})

test('needsRefresh renews five minutes early, like the desktop client does', () => {
  const now = Date.now()
  assert.equal(minimaxFamily.needsRefresh({ auth: { expiresAt: now + 10 * 60_000 } }, now), false)
  assert.equal(minimaxFamily.needsRefresh({ auth: { expiresAt: now + 4 * 60_000 } }, now), true)
  assert.equal(minimaxFamily.needsRefresh({ auth: {} }, now), false)
})

// ---------------------------------------------------------------- 目录

test('the catalog is a local snapshot: no request is made for it', async () => {
  // 上游 `{llmBase}/models` 是 503 direct_route_not_configured，发那次请求纯属浪费往返。
  const ctx = fakeCtx(() => {
    throw new Error('listModels must not touch the network')
  })
  const models = await minimaxFamily.listModels(ctx, { auth: {} }, undefined)
  assert.deepEqual(
    models.map((model) => model.id).sort(),
    ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3', 'MiniMax-M3.1-Flash-Preview'],
  )
  const m3 = models.find((model) => model.id === 'MiniMax-M3')
  assert.equal(m3.context.contextWindow, 512_000)
  assert.equal(m3.defaultMaxTokens, 128_000)
  assert.deepEqual(m3.inputModalities, ['text', 'image'])
  assert.equal(m3.toolUpdate, 'in-history')
  assert.equal(ctx.calls.length, 0)
})

test('resolveModel answers for an id the snapshot does not know', () => {
  const info = minimaxFamily.resolveModel('acct-minimax', 'MiniMax-M9-unreleased')
  assert.equal(info.provider, 'acct-minimax')
  assert.equal(info.id, 'MiniMax-M9-unreleased')
  assert.equal(info.context.contextWindow, 200_000)
})

// ---------------------------------------------------------------- 额度

test('quota stays silent when the account has no Token Plan', async () => {
  // 本机账号的真实响应：成功，但一个数据字段都没有。
  const ctx = fakeCtx(() => jsonResponse(200, { base_resp: { status_code: 0, status_msg: 'success' } }))
  assert.equal(await minimaxFamily.quota(ctx, { auth: { access: 'mmoat_x', region: 'cn' } }, undefined), undefined)
  assert.equal(ctx.calls[0].url, 'https://api.minimaxi.com/backend/account/token_plan/remains_percent')
})

test('quota reports the weekly window when the endpoint actually has numbers', async () => {
  const ctx = fakeCtx(() => jsonResponse(200, { base_resp: { status_code: 0 }, data: { current_weekly_used_percent: 25 } }))
  assert.deepEqual(await minimaxFamily.quota(ctx, { auth: { access: 'mmoat_x', region: 'en' } }, undefined), [
    { id: 'weekly', name: '周窗口', remainingFraction: 0.75 },
  ])
})

// ---------------------------------------------------------------- 调用

test('stream posts Anthropic Messages with adaptive thinking and translated tools', async () => {
  const ctx = fakeCtx(() =>
    sseResponse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 29 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]),
  )
  const chunks = await collect(
    minimaxFamily.stream(ctx, {
      payload: { auth: { access: 'mmoat_x', region: 'en' } },
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      system: 'be brief',
      tools: [{ name: 'get_time', description: 't', parameters: { type: 'object', properties: {} } }],
      maxTokens: 64,
      signal: undefined,
    }),
  )
  assert.equal(chunks.find((chunk) => chunk.type === 'text-delta')?.text, 'PONG')

  const [call] = ctx.calls
  assert.equal(call.url, 'https://agent.minimax.io/mavis/api/v1/llm/v1/messages')
  assert.equal(call.init.headers.authorization, 'Bearer mmoat_x')
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(call.init.body)
  assert.equal(body.model, 'MiniMax-M3')
  // 1024 是下限：与 claude 族同一套 `Math.max(1_024, …)`，太小的 max_tokens 上游容易直接 400。
  assert.equal(body.max_tokens, 1_024)
  assert.equal(body.stream, true)
  // 与客户端自己的 default_value: 'true' 一致；上游实测接受，且会回 thinking 块。
  assert.deepEqual(body.thinking, { type: 'adaptive' })
  assert.equal(body.tools[0].name, 'get_time')
})

test('stream goes to the CN gateway for a CN account', async () => {
  const ctx = fakeCtx(() =>
    sseResponse([
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]),
  )
  const chunks = await collect(
    minimaxFamily.stream(ctx, {
      payload: { auth: { access: 'mmoat_cn', region: 'cn' } },
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      signal: undefined,
    }),
  )
  assert.equal(chunks.find((chunk) => chunk.type === 'text-delta')?.text, 'OK')
  assert.equal(ctx.calls[0].url, 'https://agent.minimax.cn/mavis/api/v1/llm/v1/messages')
})

test('a 503 from the gateway becomes a retryable SERVER failure, not AUTH', async () => {
  const ctx = fakeCtx(() =>
    jsonResponse(503, { error: 'open platform service unavailable, please retry', errorCode: 50115 }),
  )
  await assert.rejects(
    () =>
      collect(
        minimaxFamily.stream(ctx, {
          payload: { auth: { access: 'mmoat_x', region: 'en' } },
          model: 'MiniMax-M3',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          signal: undefined,
        }),
      ),
    (error) => error.code === 'SERVER' && error.failure.status === 503,
  )
})

// ---------------------------------------------------------------- 接线

test('the family is wired into the registry with its own route and login flow', async () => {
  const { familyIds, assertUniqueRoutes, selectFamilies } = await import('../src/families/registry.js')
  assert.ok(familyIds().includes('minimax'))
  assert.doesNotThrow(() => assertUniqueRoutes(selectFamilies(undefined)))
  assert.deepEqual(minimaxFamily.login.methods.map((method) => method.id), ['import'])
})

test('credentialPath and statePath point at the desktop app own files', () => {
  const previous = process.env.MINIMAX_HOME
  process.env.MINIMAX_HOME = '/tmp/bridge-minimax-paths'
  try {
    assert.equal(credentialPath('en'), join('/tmp/bridge-minimax-paths', 'auth', 'prod', 'en', 'mcode-public', 'auth.json'))
    assert.equal(statePath('cn'), join('/tmp/bridge-minimax-paths', 'auth', 'prod', 'cn', 'mcode-public', 'auth-state.json'))
  } finally {
    if (previous === undefined) delete process.env.MINIMAX_HOME
    else process.env.MINIMAX_HOME = previous
  }
})

// ------------------------------------------------- P7-W9：未知 ≠ 空

/**
 * 「文件不在」与「文件读不懂」必须给出**不同**的结论。
 *
 * 说成「没登录」的代价是用户去重装一遍 MiniMax Code——而文件就在那儿，只是读不懂；
 * 真正该做的是打开一次桌面端让它把文件重写一遍。而且**读不懂绝不能触发出站请求**：
 * MiniMax 的刷新令牌是一次性的，刷了却写不回去，等于把桌面端单方面踢下线。
 */
test('readDesktop：不存在的文件是 missing，不是 unreadable', async () => {
  await withMinimaxHome('en', undefined, async () => {
    const found = await readDesktop('en')
    assert.equal(found.kind, 'missing')
    assert.match(found.path, /auth\.json$/)
  })
})

test('readDesktop：文件在但 JSON 坏了 ⇒ unreadable，且带上路径与原因', async () => {
  await withMinimaxHome('en', undefined, async (_home) => {
    const path = credentialPath('en')
    await writeFile(path, '{ this is not json', 'utf8')
    const found = await readDesktop('en')
    assert.equal(found.kind, 'unreadable')
    assert.equal(found.path, path)
    assert.match(found.detail, /不是合法 JSON/)
    // 关键区别：这里绝不能是 'missing'。
    assert.notEqual(found.kind, 'missing')
  })
})

test('readDesktop：字段不全也算读不出来（说成「没登录」会把人送去重装）', async () => {
  await withMinimaxHome('en', { records: { k: { accessToken: 'a' } } }, async () => {
    const found = await readDesktop('en')
    assert.equal(found.kind, 'unreadable')
    assert.match(found.detail, /refreshToken/)
  })
})

test('discovery：读不懂的文件要**说出来**，不是假装没装', async () => {
  await withMinimaxHome('en', undefined, async () => {
    await writeFile(credentialPath('en'), 'not json at all', 'utf8')
    const items = await minimaxFamily.discover()
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, false, '读不懂的东西不许被导进来')
    assert.match(items[0].reason, /存在但读不出登录态/)
    assert.match(items[0].reason, /auth\.json/)
    // 沉默会让用户以为没装。
    assert.notEqual(items.length, 0)
  })
})

test('login：读不懂的文件给出的提示与「没装」不同', async () => {
  await withMinimaxHome('en', undefined, async () => {
    await writeFile(credentialPath('en'), 'still not json', 'utf8')
    await assert.rejects(
      () => minimaxFamily.login.run({ commit() {} }, {}),
      (error) => {
        assert.match(error.message, /读不出登录态/)
        assert.match(error.message, /打开一次 MiniMax Code/)
        assert.doesNotMatch(error.message, /请先安装 MiniMax Code/)
        return true
      },
    )
  })
})

test('login：真的没装时说的是「请先安装并登录一次」', async () => {
  await withMinimaxHome('en', undefined, async () => {
    await assert.rejects(
      () => minimaxFamily.login.run({ commit() {} }, {}),
      (error) => {
        assert.match(error.message, /请先安装 MiniMax Code/)
        return true
      },
    )
  })
})

test('refresh：桌面端文件读不懂时拒绝刷新，且一个出站请求都不发', async () => {
  await withMinimaxHome('en', undefined, async () => {
    await writeFile(credentialPath('en'), 'corrupt', 'utf8')
    const ctx = fakeCtx(() => {
      throw new Error('不该走到这里：读不懂凭据时不许发请求')
    })
    await assert.rejects(
      () => minimaxFamily.refresh(ctx, { externallyOwned: true, auth: { refresh: 'mmort_x', region: 'en' } }, undefined),
      (error) => {
        assert.equal(error.code, 'AUTH')
        assert.match(error.message, /拒绝刷新/)
        assert.match(error.message, /读不出登录态|corrupt/)
        return true
      },
    )
    assert.equal(ctx.calls.length, 0, '刷新令牌是一次性的：刷了却写不回去等于把桌面端踢下线')
  })
})

test('refresh：文件被删掉也拒绝刷新，但说的是「找不到」', async () => {
  await withMinimaxHome('en', credentialDoc(), async (_home) => {
    await rm(credentialPath('en'))
    const ctx = fakeCtx(() => {
      throw new Error('不该走到这里')
    })
    await assert.rejects(
      () => minimaxFamily.refresh(ctx, { externallyOwned: true, auth: { refresh: 'mmort_x', region: 'en' } }, undefined),
      (error) => {
        assert.equal(error.code, 'AUTH')
        assert.match(error.message, /找不到/)
        return true
      },
    )
    assert.equal(ctx.calls.length, 0)
  })
})
