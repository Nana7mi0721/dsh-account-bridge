/**
 * `generic` 族（通用兜底）的回归测试。
 *
 * 这一族面对的是**我们没见过的上游**，所以这里钉的不是「对接某个具体服务」，
 * 而是一条条「猜错就会静默失效」的假设：
 *
 * - **不冒充身份**：`anthropic` 方言下不许出现 Claude Code 的身份块，也不许出现
 *   缓存断点——对端认不认 `cache_control` 我们不知道，塞未知字段就是在赌 400。
 * - **密钥可以只在环境里**：`apiKeyEnv` 只记变量名，变量没设时必须点名说清是哪个，
 *   「401」对用户毫无帮助。
 * - **上游没有 `/models` 不算失败**：那正是这一族要兜的底，声明式目录必须能顶上；
 *   两边都没有时才报错，而且错误里必须告诉用户怎么自救。
 * - **目录接口不认识时不当成错误**：抛出去会被账号池记成「这个账号零个模型」。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compatOf,
  declaredModels,
  endpointOf,
  genericFamily,
  headersOf,
  labelFor,
  modelInfo,
  normaliseBaseUrl,
  parseCatalog,
  resolveApiKey,
} from '../src/families/generic.js'
import { FAMILIES, familyById } from '../src/families/registry.js'
import { parseModelList } from '../src/tools.js'

/** 造一个只有 body 的假 Response；readSse 只认 async iterable。 */
function sseResponse(events) {
  const body = (async function* generate() {
    for (const event of events) yield `data: ${JSON.stringify(event)}\n\n`
  })()
  return { ok: true, status: 200, headers: { get: () => null }, body }
}

/** 造一个失败响应。 */
function errorResponse(status, body, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** 收集整个 chunk 流。 */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 一个记录调用参数的假 ctx。 */
function recordingCtx(handler) {
  const calls = []
  return {
    calls,
    async fetch(url, init, proxy) {
      calls.push({ url, init, proxy })
      return handler(url, init)
    },
  }
}

const OPENAI_EVENTS = [
  { choices: [{ delta: { content: 'PO' } }] },
  { choices: [{ delta: { content: 'NG' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2 } },
]

// ------------------------------------------------------------------ 地址

test('a baseUrl without a scheme becomes https, and a local host becomes http', () => {
  assert.equal(normaliseBaseUrl('api.example.com/v1'), 'https://api.example.com/v1')
  assert.equal(normaliseBaseUrl('127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  assert.equal(normaliseBaseUrl('192.168.1.9:8000/v1'), 'http://192.168.1.9:8000/v1')
  assert.equal(normaliseBaseUrl('http://box.local:1234/v1'), 'http://box.local:1234/v1')
})

test('trailing slashes are stripped so paths never double up', () => {
  assert.equal(normaliseBaseUrl('https://api.example.com/v1///'), 'https://api.example.com/v1')
  assert.equal(endpointOf({ baseUrl: 'https://api.example.com/v1/' }, '/chat/completions'), 'https://api.example.com/v1/chat/completions')
})

test('an absolute path in compat overrides the baseUrl', () => {
  assert.equal(
    endpointOf({ baseUrl: 'https://a.example.com/v1', compat: { chatPath: 'https://b.example.com/v2/chat' } }, compatOf({ compat: { chatPath: 'https://b.example.com/v2/chat' } }).chatPath),
    'https://b.example.com/v2/chat',
  )
})

test('no baseUrl is INVALID_REQUEST, not a TypeError from new URL', () => {
  assert.throws(() => endpointOf({}, '/models'), (error) => error.code === 'INVALID_REQUEST')
})

// ------------------------------------------------------------------ 凭据

test('an explicit apiKey wins over the environment variable', () => {
  process.env.BRIDGE_TEST_KEY = 'from-env'
  try {
    assert.equal(resolveApiKey({ apiKey: 'from-record', apiKeyEnv: 'BRIDGE_TEST_KEY' }), 'from-record')
  } finally {
    delete process.env.BRIDGE_TEST_KEY
  }
})

test('apiKeyEnv reads the environment and leaves the secret out of the record', () => {
  process.env.BRIDGE_TEST_KEY = 'from-env'
  try {
    assert.equal(resolveApiKey({ apiKeyEnv: 'BRIDGE_TEST_KEY' }), 'from-env')
  } finally {
    delete process.env.BRIDGE_TEST_KEY
  }
})

test('a missing environment variable names itself in the error', () => {
  assert.throws(
    () => resolveApiKey({ apiKeyEnv: 'BRIDGE_TEST_KEY_ABSENT' }),
    (error) => error.code === 'AUTH' && error.message.includes('BRIDGE_TEST_KEY_ABSENT'),
  )
})

test('an endpoint with no credentials at all is not an error', () => {
  assert.equal(resolveApiKey({ baseUrl: 'http://127.0.0.1:11434/v1' }), undefined)
})

// ------------------------------------------------------------------ 方言

test('the default dialect is OpenAI Chat Completions with a bearer token', () => {
  const compat = compatOf({})
  assert.equal(compat.protocol, 'openai')
  assert.equal(compat.authHeader, 'bearer')
  assert.equal(compat.modelsPath, '/models')
  assert.equal(compat.chatPath, '/chat/completions')
  assert.equal(compat.streamUsage, true)
  assert.equal(compat.maxTokensField, 'max_tokens')
})

test('the anthropic dialect switches the header, the path, and adds anthropic-version', () => {
  const auth = { baseUrl: 'https://api.example.com', apiKey: 'sk-x', compat: { protocol: 'anthropic' } }
  const compat = compatOf(auth)
  assert.equal(compat.authHeader, 'x-api-key')
  assert.equal(compat.messagesPath, '/messages')
  const headers = headersOf(auth, compat, { json: true })
  assert.equal(headers['x-api-key'], 'sk-x')
  assert.equal(headers.authorization, undefined)
  assert.equal(headers['anthropic-version'], '2023-06-01')
})

test('anthropic-version is not sent to an OpenAI endpoint', () => {
  const auth = { baseUrl: 'https://api.example.com', apiKey: 'sk-x' }
  const headers = headersOf(auth, compatOf(auth), { json: true })
  assert.equal(headers.authorization, 'Bearer sk-x')
  assert.equal(headers['anthropic-version'], undefined)
})

test('authHeader can be turned off for an endpoint that wants no credential', () => {
  const auth = { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ignored', compat: { authHeader: 'none' } }
  const headers = headersOf(auth, compatOf(auth))
  assert.equal(headers.authorization, undefined)
  assert.equal(headers['x-api-key'], undefined)
})

test('custom compat headers are sent, lowercased', () => {
  const auth = { baseUrl: 'https://api.example.com', compat: { headers: { 'HTTP-Referer': 'https://dsh.local' } } }
  assert.equal(headersOf(auth, compatOf(auth))['http-referer'], 'https://dsh.local')
})

// ------------------------------------------------------------------ 目录

test('declared models accept both a bare id and an object, and drop junk', () => {
  const models = declaredModels({ models: ['gpt-4o-mini', { id: 'my-model', contextWindow: 200000 }, null, {}, 7] })
  assert.deepEqual(
    models.map((model) => model.id),
    ['gpt-4o-mini', 'my-model'],
  )
  assert.equal(models[1].contextWindow, 200000)
})

test('a catalogue response is read from data, models, or a bare array', () => {
  assert.deepEqual(parseCatalog({ data: [{ id: 'a' }] }).map((m) => m.id), ['a'])
  assert.deepEqual(parseCatalog({ models: [{ id: 'b' }] }).map((m) => m.id), ['b'])
  assert.deepEqual(parseCatalog([{ id: 'c' }]).map((m) => m.id), ['c'])
  assert.deepEqual(parseCatalog({ nope: 1 }), [])
})

test('models that cannot take text are kept out of the picker', () => {
  const json = {
    data: [
      { id: 'text-model', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'image-only', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
      { id: 'embedding', architecture: { input_modalities: ['text'], output_modalities: [] } },
    ],
  }
  assert.deepEqual(parseCatalog(json).map((m) => m.id), ['text-model'])
})

test('model metadata falls back to conservative defaults instead of guessing big', () => {
  const bare = modelInfo('m', 'm', {}, 'acct-generic')
  assert.equal(bare.context.contextWindow, 128000)
  assert.equal(bare.defaultMaxTokens, 8192)
  assert.deepEqual(bare.inputModalities, ['text'])
  assert.equal(bare.reasoning, undefined)

  const rich = modelInfo('m', 'm', { context_length: 1000000, top_provider: { max_completion_tokens: 64000 } }, 'acct-generic')
  assert.equal(rich.context.contextWindow, 1000000)
  assert.equal(rich.defaultMaxTokens, 64000)
})

test('declared efforts surface as a reasoning picker', () => {
  const info = modelInfo('m', 'm', { efforts: ['low', 'high'] }, 'acct-generic')
  assert.deepEqual(info.reasoning, { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] })
})

test('a catalogue the endpoint does not have is not a failure when models are declared', async () => {
  const ctx = recordingCtx(() => errorResponse(404, 'not found'))
  const models = await genericFamily.listModels(ctx, { auth: { baseUrl: 'https://api.example.com/v1', models: ['only-one'] } })
  assert.equal(ctx.calls.length, 1, 'it still tries the live catalogue first')
  assert.deepEqual(models.map((model) => model.id), ['only-one'])
})

test('catalog:declared skips the network entirely', async () => {
  const ctx = recordingCtx(() => {
    throw new Error('must not be called')
  })
  const models = await genericFamily.listModels(ctx, {
    auth: { baseUrl: 'https://api.example.com/v1', models: ['only-one'], compat: { catalog: 'declared' } },
  })
  assert.equal(ctx.calls.length, 0)
  assert.deepEqual(models.map((model) => model.id), ['only-one'])
})

test('live and declared catalogues are unioned, declared first', async () => {
  const ctx = recordingCtx(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ data: [{ id: 'from-live' }, { id: 'both' }] }),
  }))
  const models = await genericFamily.listModels(ctx, { auth: { baseUrl: 'https://api.example.com/v1', models: ['declared', 'both'] } })
  assert.deepEqual(models.map((model) => model.id), ['declared', 'both', 'from-live'])
})

test('a network error on the catalogue also leaves the declared models standing', async () => {
  const ctx = recordingCtx(() => {
    throw new Error('ECONNREFUSED')
  })
  const models = await genericFamily.listModels(ctx, { auth: { baseUrl: 'http://127.0.0.1:9/v1', models: ['x'] } })
  assert.deepEqual(models.map((model) => model.id), ['x'])
})

test('with nothing on either side the error says how to fix it', async () => {
  const ctx = recordingCtx(() => errorResponse(404, 'nope'))
  await assert.rejects(
    () => genericFamily.listModels(ctx, { auth: { baseUrl: 'https://api.example.com/v1' } }),
    (error) => error.code === 'INVALID_REQUEST' && error.message.includes('auth.models'),
  )
})

// ------------------------------------------------------------------ 调用

test('an OpenAI endpoint gets a chat-completions request and DSH chunks back', async () => {
  const ctx = recordingCtx(() => sseResponse(OPENAI_EVENTS))
  const chunks = await collect(
    genericFamily.stream(ctx, {
      payload: { auth: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' } },
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      system: 'be terse',
      maxTokens: 64,
      signal: new AbortController().signal,
    }),
  )

  const [call] = ctx.calls
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(call.init.headers.authorization, 'Bearer sk-x')
  const body = JSON.parse(call.init.body)
  assert.equal(body.model, 'gpt-4o-mini')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 64)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(body.messages[0], { role: 'system', content: 'be terse' })
  assert.equal(body.messages[1].role, 'user')

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.equal(chunks[1].text, 'PO')
  assert.equal(chunks[3].block.text, 'PONG')
  assert.equal(chunks[4].usage.inputTokens, 11)
  assert.equal(chunks[5].reason.kind, 'stop')
})

test('stream_options can be turned off for gateways that 400 on it', async () => {
  const ctx = recordingCtx(() => sseResponse(OPENAI_EVENTS))
  await collect(
    genericFamily.stream(ctx, {
      payload: { auth: { baseUrl: 'https://api.example.com/v1', compat: { streamUsage: false } } },
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    }),
  )
  assert.equal(JSON.parse(ctx.calls[0].init.body).stream_options, undefined)
})

test('maxTokensField lets an endpoint that only knows max_completion_tokens work', async () => {
  const ctx = recordingCtx(() => sseResponse(OPENAI_EVENTS))
  await collect(
    genericFamily.stream(ctx, {
      payload: { auth: { baseUrl: 'https://api.example.com/v1', compat: { maxTokensField: 'max_completion_tokens' } } },
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      maxTokens: 128,
    }),
  )
  const body = JSON.parse(ctx.calls[0].init.body)
  assert.equal(body.max_completion_tokens, 128)
  assert.equal(body.max_tokens, undefined)
})

test('tools and a reasoning effort are forwarded', async () => {
  const ctx = recordingCtx(() => sseResponse(OPENAI_EVENTS))
  await collect(
    genericFamily.stream(ctx, {
      payload: { auth: { baseUrl: 'https://api.example.com/v1' } },
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [{ name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } }],
      effort: 'high',
    }),
  )
  const body = JSON.parse(ctx.calls[0].init.body)
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].function.name, 'read_file')
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.reasoning_effort, 'high')
})

test('an Anthropic endpoint gets Messages, with no identity block and no cache breakpoint', async () => {
  const ctx = recordingCtx(() =>
    sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]),
  )
  const payload = { auth: { baseUrl: 'https://api.example.com', apiKey: 'sk-x', compat: { protocol: 'anthropic' } } }
  await collect(
    genericFamily.stream(ctx, {
      payload,
      model: 'claude-ish',
      system: 'be terse',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      maxTokens: 32,
    }),
  )

  const [call] = ctx.calls
  assert.equal(call.url, 'https://api.example.com/messages')
  assert.equal(call.init.headers['x-api-key'], 'sk-x')
  const body = JSON.parse(call.init.body)
  assert.equal(body.max_tokens, 32)
  assert.equal(body.model, 'claude-ish')
  // 身份块：我们不是 Claude Code，不能自称是。
  const serialised = JSON.stringify(body)
  assert.ok(!serialised.includes('Claude Code'), 'no Claude Code identity may be sent')
  assert.ok(!serialised.includes('cache_control'), 'no cache breakpoint may be sent to an unknown endpoint')
  assert.equal(body.system.length, 1)
  assert.equal(body.system[0].text, 'be terse')
})

test('a non-2xx on the chat path becomes a classified failure, not a raw response', async () => {
  const ctx = recordingCtx(() => errorResponse(429, { error: { message: 'you have exhausted your usage limit' } }))
  await assert.rejects(
    () =>
      collect(
        genericFamily.stream(ctx, {
          payload: { auth: { baseUrl: 'https://api.example.com/v1' } },
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        }),
      ),
    (error) => error.code === 'QUOTA' && error.failure.status === 429,
  )
})

test('a 401 on the chat path is AUTH so the account is parked instead of retried', async () => {
  const ctx = recordingCtx(() => errorResponse(401, { error: { message: 'invalid api key' } }))
  await assert.rejects(
    () =>
      collect(
        genericFamily.stream(ctx, {
          payload: { auth: { baseUrl: 'https://api.example.com/v1', apiKey: 'bad' } },
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        }),
      ),
    (error) => error.code === 'AUTH',
  )
})

test('a per-account proxy is handed to the fetch service', async () => {
  const ctx = recordingCtx(() => sseResponse(OPENAI_EVENTS))
  await collect(
    genericFamily.stream(ctx, {
      payload: { auth: { baseUrl: 'https://api.example.com/v1' }, proxy: 'socks5://127.0.0.1:1080' },
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    }),
  )
  assert.equal(ctx.calls[0].proxy, 'socks5://127.0.0.1:1080')
})

// ------------------------------------------------------------------ 接线

test('the family is registered with its own route and no discover step', () => {
  const family = familyById('generic')
  assert.equal(family, genericFamily)
  assert.equal(family.route, 'acct-generic')
  assert.equal(typeof family.discover, 'undefined', 'generic must not scan the machine: it is for services with no local client')
  assert.equal(typeof family.refresh, 'undefined', 'an API key does not expire')
  assert.equal(typeof family.quota, 'undefined', 'we cannot guess an unknown endpoint quota shape')
  assert.equal(family.login.methods.length, 2)
  assert.equal(new Set(FAMILIES.map((item) => item.route)).size, FAMILIES.length)
})

test('a login grant carries a complete account record', async () => {
  const committed = []
  const session = {
    method: 'manual',
    prompt: async (prompt) => (prompt.kind === 'text' ? 'api.example.com/v1' : 'sk-secret'),
    commit: async (record) => committed.push(record),
  }
  await genericFamily.login.run(session, {})
  assert.equal(committed.length, 1)
  assert.equal(committed[0].kind, 'grant')
  assert.equal(committed[0].payload.family, 'generic')
  assert.equal(committed[0].payload.source, 'manual')
  assert.equal(committed[0].payload.auth.baseUrl, 'https://api.example.com/v1')
  assert.equal(committed[0].payload.auth.apiKey, 'sk-secret')
  assert.equal(committed[0].payload.externallyOwned, false)
})

test('a login that answers with an env-style name stores the name, not the key', async () => {
  const committed = []
  const session = {
    method: 'manual',
    prompt: async (prompt) => (prompt.kind === 'text' ? 'https://relay.example.com/v1' : 'MY_RELAY_KEY'),
    commit: async (record) => committed.push(record),
  }
  await genericFamily.login.run(session, {})
  const { auth, externallyOwned } = committed[0].payload
  assert.deepEqual(auth, { baseUrl: 'https://relay.example.com/v1', apiKeyEnv: 'MY_RELAY_KEY' })
  assert.equal(externallyOwned, true, 'an env-owned key means the record does not own the secret')
})

test('a bad baseUrl is asked again instead of throwing a URL parse error', async () => {
  const answers = ['not a url', 'still not one', 'https://ok.example.com/v1', '']
  const committed = []
  const session = {
    method: 'manual',
    prompt: async () => answers.shift(),
    commit: async (record) => committed.push(record),
  }
  await genericFamily.login.run(session, {})
  assert.equal(committed[0].payload.auth.baseUrl, 'https://ok.example.com/v1')
})

test('an empty baseUrl cancels the flow rather than creating a broken account', async () => {
  const session = { method: 'manual', prompt: async () => '   ', commit: async () => assert.fail('must not commit') }
  await assert.rejects(() => genericFamily.login.run(session, {}), /没有填写 baseURL/)
})

test('the preset path falls through to the manual path on "other"', async () => {
  const prompts = []
  const committed = []
  const session = {
    method: 'preset',
    prompt: async (prompt) => {
      prompts.push(prompt)
      if (prompt.kind === 'select') return 'custom'
      return prompt.kind === 'text' ? 'https://elsewhere.example.com/v1' : ''
    },
    commit: async (record) => committed.push(record),
  }
  await genericFamily.login.run(session, {})
  assert.equal(prompts[0].kind, 'select')
  assert.equal(prompts[0].options.at(-1).value, 'custom')
  assert.equal(committed[0].payload.auth.baseUrl, 'https://elsewhere.example.com/v1')
})

test('a preset with a known key variable records the variable, not a secret', async () => {
  const committed = []
  const session = {
    method: 'preset',
    prompt: async (prompt) => (prompt.kind === 'select' ? '0' : ''),
    commit: async (record) => committed.push(record),
  }
  await genericFamily.login.run(session, {})
  const { auth } = committed[0].payload
  assert.equal(auth.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(auth.apiKeyEnv, 'OPENROUTER_API_KEY')
  assert.equal(auth.apiKey, undefined)
})

test('the display label prefers a preset name, then the host', () => {
  assert.equal(labelFor({ baseUrl: 'https://openrouter.ai/api/v1' }), 'OpenRouter')
  assert.equal(labelFor({ baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' }), 'OpenRouter（OPENROUTER_API_KEY）')
  assert.equal(labelFor({ baseUrl: 'https://relay.example.com/v1' }), 'relay.example.com')
})

test('the models tool argument accepts id and id:contextWindow', () => {
  assert.deepEqual(parseModelList('a, b:200000 ,, c'), ['a', { id: 'b', contextWindow: 200000 }, 'c'])
  assert.deepEqual(parseModelList(''), [])
  assert.deepEqual(parseModelList(undefined), [])
})

test('only a real private IP is treated as local, never a public hostname that starts the same', () => {
  // 这一条是真被抓到过的 bug：只判 `^10\.` 会让 `10.example.com` 走 http——
  // 一个把 API Key 明文发出去的静默降级。
  assert.equal(normaliseBaseUrl('10.example.com/v1'), 'https://10.example.com/v1')
  assert.equal(normaliseBaseUrl('10.0.0.1.example.com/v1'), 'https://10.0.0.1.example.com/v1')
  assert.equal(normaliseBaseUrl('192.168.example.com/v1'), 'https://192.168.example.com/v1')
  assert.equal(normaliseBaseUrl('10.0.0.7:8000/v1'), 'http://10.0.0.7:8000/v1')
  assert.equal(normaliseBaseUrl('172.20.5.5/v1'), 'http://172.20.5.5/v1')
  // 172.32 已经在私有段之外了。
  assert.equal(normaliseBaseUrl('172.32.0.1/v1'), 'https://172.32.0.1/v1')
})
