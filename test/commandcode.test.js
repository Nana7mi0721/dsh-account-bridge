/**
 * `commandcode` 族的回归测试。
 *
 * 这一族面对的上游**同时提供三套形状不同的 API**，所以这里钉的不是
 * 「对接某个具体服务」，而是一条条「猜错就会静默失效」的假设：
 *
 * - **凭据必须四处都找，且要说清找到了哪一处**：只找 `~/.commandcode/auth.json`
 *   会让「在环境变量里配了 key」的用户看到「未发现任何账号」；找到了却不报
 *   来源，用户就没法判断该改哪个文件。四处都没有时**不能返回空数组**——
 *   那在 UI 上等于什么都没发生。
 * - **降级要有证据**：只有上游点名「这个模型必须走另一个端点」或 Go 套餐的
 *   403 才换传输。把一次 500 或限流当成「换协议」会把真实故障伪装成协议问题，
 *   而**已经吐过字之后再换协议**等于把半句话重说一遍。
 * - **不编额度**：双窗口的「窗口缺失」和「cap 为 0」是两种不同的未知，
 *   两者都不能折算成 0%/100%；两个窗口都读不到就整个不报。
 * - **不冒充没有人设的传输参数**：messages 传输从不发 `temperature`
 *   （adaptive thinking 只允许 1，带 0.3 一律 400），三套传输都不发 `stop`
 *   （上游不支持），`max_tokens` 有与模型窗口无关的全局上限。
 * - **空回答不算回答**：整轮只有思考、或只有空白，都要抛 `EMPTY_RESPONSE`，
 *   让池子去换号重试，而不是伪造一个成功的 `finish`。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  commandcodeFamily,
  apiKeyFromCredentialRecord,
  buildStudioAuthUrl,
  commandCodeHome,
  credentialFromRecord,
  discoverWith,
  parseAuthFile,
  parseCallbackRequest,
  parseWindowLimits,
  studioBaseForApiBase,
} from '../src/families/commandcode.js'
import {
  DEFAULT_GENERATE_MAX_TOKENS,
  DEFAULT_MESSAGES_MAX_TOKENS,
  StreamAssembler,
  DEFAULT_CLI_VERSION,
  buildBody,
  endpointOf,
  finishKind,
  handleCliEvent,
  handleOpenAiEvent,
  isUpgradeRequired,
  modelInfo,
  normaliseUsage,
  outputBudget,
  parseCatalog,
  parseStreamLine,
  requestHeaders,
  requiresMessages,
  resolveProtocol,
  routingMismatch,
  toCliMessages,
  toOpenAiMessages,
  toMessagesMessages,
  translateCommandCodeStream,
} from '../src/wire/commandcode.js'

// ------------------------------------------------------------------ 测试工具

/** 造一个只有 body 的假 Response；readSse 只认 async iterable。 */
function sseResponse(frames) {
  const body = (async function* generate() {
    for (const frame of frames) {
      if (typeof frame === 'string') yield frame
      else if (frame.raw !== undefined) yield frame.raw
      else yield `data: ${JSON.stringify(frame)}\n\n`
    }
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
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  }
}

/** 造一个成功响应（额度/目录这类要 json() 的接口）。 */
function jsonResponse(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
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

/** 一个记录调用参数的假 ctx（既给 stream 用，也给 discover 用）。 */
function recordingCtx(handler, { services = {} } = {}) {
  const calls = []
  const warnings = []
  return {
    calls,
    warnings,
    log: { warn: (...args) => warnings.push(args), info: () => {}, debug: () => {} },
    get: (name) => services[name],
    async fetch(url, init, proxy, streaming) {
      calls.push({ url, init, proxy, streaming })
      return handler(url, init, calls.length)
    },
  }
}

const USER_MESSAGE = [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]

/** 一条最普通的 assistant 回复（CLI 传输的形状）。 */
const CLI_OK_FRAMES = [
  { type: 'text-delta', text: 'PO' },
  { type: 'text-delta', text: 'NG' },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 7, outputTokens: 2 } },
]

const OPENAI_OK_FRAMES = [
  { choices: [{ delta: { content: 'PO' } }] },
  { choices: [{ delta: { content: 'NG' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
]

/** Anthropic 形状的一条回复（messages 传输；自建中转常只发 `data:`）。 */
const MESSAGES_OK_FRAMES = [
  { type: 'message_start', message: { usage: { input_tokens: 7 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]

function streamOptions(ctx, overrides = {}) {
  return {
    payload: { auth: { apiKey: 'user_test_key_1234' } },
    model: 'smart-model',
    messages: USER_MESSAGE,
    maxTokens: 4096,
    signal: undefined,
    ...overrides,
  }
}

/** 取 chunk 的类型序列，断言顺序时比逐个 deepEqual 好读。 */
const kinds = (chunks) => chunks.map((chunk) => chunk.type)

// ================================================================== 目录
// 目录是路由决策的权威来源，所以先把它钉住：解析错一个字段，
// 后面所有「按目录选传输」的判断都是错的。

test('catalog parsing keeps the routing table and refuses to invent ids', () => {
  const models = parseCatalog({
    object: 'list',
    data: [
      { id: 'smart-model', name: 'Smart', context_length: 200_000, supported_endpoints: ['/chat/completions'] },
      { id: 'claude-sonnet-5-5', context_length: 1_000_000, supported_endpoints: ['/messages'] },
      { name: 'no id at all' },
    ],
  })
  assert.equal(models.length, 2)
  assert.deepEqual(models[0], {
    id: 'smart-model',
    name: 'Smart',
    contextWindow: 200_000,
    maxOutput: undefined,
    supportedEndpoints: ['/chat/completions'],
  })
  // 没有 name 时 id 就是 name；没有路由表时留空数组，由前缀规则兜底。
  assert.equal(models[1].name, 'claude-sonnet-5-5')
  assert.deepEqual(models[1].supportedEndpoints, ['/messages'])
  // 目录公布了输出上限就照用（目前官方目录不公布，但字段存在时不该被丢掉）。
  assert.equal(parseCatalog({ data: [{ id: 'x', max_output_tokens: 32_000 }] })[0].maxOutput, 32_000)
})

test('catalog parsing tolerates junk instead of throwing at the host', () => {
  assert.deepEqual(parseCatalog(undefined), [])
  assert.deepEqual(parseCatalog({}), [])
  assert.deepEqual(parseCatalog({ data: 'nope' }), [])
  assert.deepEqual(parseCatalog([{ id: 'bare-array' }]).map((m) => m.id), ['bare-array'])
})

test('model metadata never claims a reasoning knob the catalog cannot back', () => {
  const info = modelInfo('smart-model', 'Smart', { contextWindow: 128_000 }, 'acct-commandcode')
  assert.equal(info.provider, 'acct-commandcode')
  assert.equal(info.context.contextWindow, 128_000)
  assert.equal(info.toolUpdate, 'in-history')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  // 目录不公布 effort 档位 ⇒ 不声明 reasoning，面板上就不会出现假开关。
  assert.equal(info.reasoning, undefined)
  // 未知窗口时保守取值，不拿 200k 去赌。
  assert.equal(modelInfo('x', 'x', undefined, 'acct-commandcode').context.contextWindow, 200_000)
})

test('a missing context window stays unknown instead of being guessed', () => {
  const info = modelInfo('x', 'x', { contextWindow: undefined }, 'acct-commandcode')
  assert.equal(info.context.contextWindow > 0, true)
})

// ================================================================== 预算
// `max_tokens` 的全局上限与模型窗口无关（实测 200 704 → 400），
// 而 messages 传输在未知上限时更保守。

test('the output budget is clamped by the global cap, not by the model window', () => {
  assert.equal(outputBudget(1_000_000, 'cli'), DEFAULT_GENERATE_MAX_TOKENS)
  assert.equal(outputBudget(undefined, 'cli'), DEFAULT_GENERATE_MAX_TOKENS)
  assert.equal(outputBudget(200_000, 'openai', 500_000), DEFAULT_GENERATE_MAX_TOKENS)
  assert.equal(outputBudget(4096, 'openai', 500_000), 4096)
  assert.equal(outputBudget(4096, 'messages', 32_000), 4096)
  assert.equal(outputBudget(1_000_000, 'messages', 32_000), 32_000)
  assert.equal(outputBudget(1_000_000, 'messages', undefined), DEFAULT_MESSAGES_MAX_TOKENS)
  // 0/负数当成「host 没提要求」，不是「上限为 0」；每模型上限照样生效。
  assert.equal(outputBudget(0, 'openai', 100), 100)
  assert.equal(outputBudget(-5, 'openai', undefined), DEFAULT_GENERATE_MAX_TOKENS)
})

// ================================================================== 协商
// 三套传输里选哪一套：目录是权威，前缀只是目录缺席时的兜底。

test('the catalog routing table outranks the model-name prefix', () => {
  const entry = { supportedEndpoints: ['/messages'] }
  assert.equal(requiresMessages('anything', entry), true)
  assert.equal(requiresMessages('claude-sonnet-5-5', { supportedEndpoints: ['/chat/completions'] }), false)
  assert.equal(requiresMessages('claude-sonnet-5-5', undefined), true)
  assert.equal(requiresMessages('deepseek-v3', undefined), false)
})

test('unrouted models default to the OpenAI transport, never to the private one', () => {
  assert.equal(resolveProtocol({ model: 'smart-model' }), 'openai')
  assert.equal(resolveProtocol({ model: 'smart-model', entry: { supportedEndpoints: [] } }), 'openai')
  assert.equal(resolveProtocol({ model: 'claude-opus-4-6' }), 'messages')
  assert.equal(resolveProtocol({ model: 'claude-opus-4-6', forced: 'openai' }), 'messages')
  assert.equal(resolveProtocol({ model: 'smart-model', forced: 'cli' }), 'cli')
  // 认不出的强制值忽略，不许把请求发到一条不存在的路径上。
  assert.equal(resolveProtocol({ model: 'smart-model', forced: 'v2-quantum' }), 'openai')
})

test('a routing rejection points at the other provider endpoint', () => {
  const text = 'Model "claude-sonnet-5-5" must be called via /provider/v1/messages (Anthropic Messages shape)'
  assert.equal(routingMismatch('openai', 400, text), 'messages')
  const other = 'Model "deepseek-v3" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models.'
  assert.equal(routingMismatch('messages', 400, other), 'openai')
})

test('the Go plan is the only reason to fall back to the private transport', () => {
  assert.equal(routingMismatch('openai', 403, '{"code":"upgrade_required"}'), 'cli')
  assert.equal(routingMismatch('messages', 403, 'This is a Go plan without API access; upgrade to Goat or higher'), 'cli')
  assert.equal(isUpgradeRequired('{"code":"upgrade_required"}'), true)
  assert.equal(isUpgradeRequired('insufficient credits'), false)
})

test('an ordinary failure is never disguised as a transport problem', () => {
  // 服务器炸了：换协议只会掩盖真实故障，池子需要看到 SERVER。
  assert.equal(routingMismatch('openai', 500, 'internal error'), undefined)
  // 限流：换协议会把同一份额度再烧一次。
  assert.equal(routingMismatch('openai', 429, 'rate limit exceeded'), undefined)
  // 上下文超窗：这在三套传输上都是同一个问题，换协议解决不了。
  assert.equal(routingMismatch('openai', 400, 'context length exceeded'), undefined)
  assert.equal(routingMismatch('openai', 401, 'invalid API key'), undefined)
  // 已经点名的路由错误之外，400 不许乱指路。
  assert.equal(routingMismatch('openai', 400, 'bad tool schema'), undefined)
  // CLI 是终点：没有比它更低的传输可降。
  assert.equal(routingMismatch('cli', 403, '{"code":"upgrade_required"}'), undefined)
})

test('each transport has its own path and every path keeps the identity switches', () => {
  assert.equal(endpointOf(undefined, 'cli'), 'https://api.commandcode.ai/alpha/generate')
  assert.equal(endpointOf(undefined, 'openai'), 'https://api.commandcode.ai/provider/v1/chat/completions')
  assert.equal(endpointOf(undefined, 'messages'), 'https://api.commandcode.ai/provider/v1/messages')
  assert.equal(endpointOf('https://box.example.com/', 'openai'), 'https://box.example.com/provider/v1/chat/completions')

  // ★ 头按「面」分叉（上游实测）：CLI 面 / 账号面 / Provider 面各不相同。
  const cli = requestHeaders('user_abc', { surface: 'cli', cliVersion: '1.79.1', json: true, stream: true })
  assert.equal(cli.authorization, 'Bearer user_abc')
  assert.equal(cli['content-type'], 'application/json')
  assert.equal(cli.accept, 'text/event-stream')
  // `accept-encoding: identity` 是**行为开关**而不是优化：少了它就是静默走差路径。
  assert.equal(cli['accept-encoding'], 'identity')
  assert.equal(cli['x-command-code-version'], '1.79.1')
  assert.equal(cli['x-cli-environment'], 'production')
  assert.equal(cli['x-taste-learning'], 'false')
  assert.equal(cli['x-co-flag'], 'false')
  // `x-cmd-zdr` 是**账号级 opt-in**（上游 `zdr` 默认 false）：不发就是没开。
  assert.equal(cli['x-cmd-zdr'], undefined)
  assert.equal(requestHeaders('k', { surface: 'cli', zdr: true })['x-cmd-zdr'], '1')
  // 没有版本号就干脆不发，绝不自造一个版本。
  assert.equal(requestHeaders('k', { surface: 'cli' })['x-command-code-version'], undefined)
  // 也不发 `x-project-slug`：那是上游从 CLI 的 workingDir 推的，本插件没有这个概念。
  assert.equal(cli['x-project-slug'], undefined)

  // Provider 面（两套 Provider API + 目录）**故意不带** CLI 身份头——上游注释：
  // 那些头「identify the CLI transport, not a public API client」。
  const provider = requestHeaders('user_abc', { surface: 'provider', json: true, stream: true })
  assert.equal(provider.accept, 'text/event-stream')
  assert.equal(provider['x-command-code-version'], undefined)
  assert.equal(provider['x-cli-environment'], undefined)
  assert.equal(provider['x-taste-learning'], undefined)
  assert.equal(provider['x-co-flag'], undefined)
  // GET 目录是非流式：显式 application/json。
  assert.equal(requestHeaders('k', {})['accept'], 'application/json')

  // 账号面（whoami / usage / billing）：版本号 + x-cli-environment，没有 taste/co-flag。
  const account = requestHeaders('user_abc', { surface: 'account', cliVersion: '1.79.1' })
  assert.equal(account['x-command-code-version'], '1.79.1')
  assert.equal(account['x-cli-environment'], 'production')
  assert.equal(account['x-taste-learning'], undefined)
  assert.equal(account['accept'], undefined)
})

// ================================================================== 信封
// 私有传输的信封少一个字段就是 400，所以逐字段钉住。

test('the private envelope carries the CLI config block and the standard permission mode', () => {
  const body = buildBody({
    protocol: 'cli',
    model: 'smart-model',
    messages: USER_MESSAGE,
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
    system: 'be brief',
    maxTokens: 4096,
    temperature: 0.3,
    sessionId: 'not-a-uuid',
  })
  assert.equal(body.permissionMode, 'standard')
  assert.equal(body.memory, null)
  assert.equal(body.taste, null)
  assert.equal(body.skills, null)
  assert.equal(typeof body.config.workingDir, 'string')
  assert.equal(body.config.isGitRepo, false)
  assert.match(body.config.environment, /Node\.js v/)
  assert.equal(body.params.model, 'smart-model')
  assert.equal(body.params.stream, true)
  assert.equal(body.params.max_tokens, 4096)
  assert.equal(body.params.temperature, 0.3)
  // 上游**不支持** stop 序列，带上就是报错。
  assert.equal(body.params.stop, undefined)
  assert.equal(body.stop, undefined)
  // threadId 必须是 UUID 形状（给不出真会话 id 就每轮一个）。
  assert.match(body.threadId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // system 是有缓存断点的块数组，不是裸字符串。
  assert.deepEqual(body.params.system, [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }])
  assert.deepEqual(body.params.tools, [
    {
      type: 'function',
      name: 'read',
      description: 'read a file',
      input_schema: { type: 'object', properties: {} },
    },
  ])
  assert.equal(body.params.reasoning_effort, undefined)
})

test('an explicit session id is reused as the thread id', () => {
  const thread = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const body = buildBody({ protocol: 'cli', model: 'm', messages: [], sessionId: thread })
  assert.equal(body.threadId, thread)
})

test('an empty system prompt stays empty instead of becoming an empty block', () => {
  assert.equal(buildBody({ protocol: 'cli', model: 'm', messages: [], system: '' }).params.system, '')
  assert.equal(buildBody({ protocol: 'cli', model: 'm', messages: [] }).params.system, '')
})

test('the private transport replays reasoning in content order and pairs tool calls', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'checking' },
        { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"SH"}' },
        { type: 'tool-call', id: 'orphan', name: 'never_answered', arguments: '{}' },
      ],
    },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'get_weather', content: '{"t":20}' }] },
  ]
  const wire = toCliMessages(messages)
  assert.deepEqual(wire[0], { role: 'user', content: [{ type: 'text', text: 'weather?' }] })
  // 历史推理必须回放（thinking 模型带工具调用时上游要求带上上一轮思维链）。
  assert.deepEqual(wire[1].content[0], { type: 'reasoning', text: 'think' })
  assert.deepEqual(wire[1].content[1], { type: 'text', text: 'checking' })
  assert.deepEqual(wire[1].content[2], {
    type: 'tool-call',
    toolCallId: 'call_1',
    toolName: 'get_weather',
    input: { city: 'SH' },
  })
  // 没有配对结果的工具调用不能回放。
  assert.equal(wire[1].content.length, 3)
  assert.deepEqual(wire[2], {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'get_weather', output: { type: 'text', value: '{"t":20}' } }],
  })
})

test('the OpenAI transport replays reasoning as reasoning_content and pairs tool calls', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"SH"}' },
      ],
    },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: '20C' }] },
  ]
  const wire = toOpenAiMessages(messages)
  assert.equal(wire[1].reasoning_content, 'think')
  assert.equal(wire[1].content, null)
  assert.deepEqual(wire[1].tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SH"}' } },
  ])
  assert.deepEqual(wire[2], { role: 'tool', tool_call_id: 'call_1', content: '20C' })
})

test('the Anthropic transport only replays signed thinking blocks and drops temperature', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'ok' }] },
  ]
  // ★ 回放 `thinking` 块**必须带 `signature`**，否则端点回 `thinking.signature: Field
  // required`；省略它才是被接受的（上游实测两条路都是 200）。DSH 的块形状没有签名，
  // 所以这条历史推理**被丢掉**，而不是照抄文本把请求打挂。
  const wire = toMessagesMessages(messages)
  assert.equal(wire[1].content.length, 1)
  assert.deepEqual(wire[1].content[0], { type: 'text', text: 'ok' })
  // 真有签名（自建网关/以后 DSH 加了这个字段）就照发。
  const signed = toMessagesMessages([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'think', signature: 'sig-1' }, { type: 'text', text: 'ok' }],
    },
  ])
  assert.deepEqual(signed[1].content[0], { type: 'thinking', thinking: 'think', signature: 'sig-1' })

  const body = buildBody({
    protocol: 'messages',
    model: 'claude-opus-4-6',
    messages,
    tools: [{ name: 'read', parameters: { type: 'object' } }],
    system: 'be brief',
    maxTokens: 8_000,
    temperature: 0.3,
  })
  // adaptive thinking 只允许 1：带 temperature 一律 400，所以干脆从不发。
  assert.equal(body.temperature, undefined)
  // system 是一元素数组（第一个缓存断点）。
  assert.deepEqual(body.system, [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }])
  // 第二个缓存断点落在最后一个工具声明上。
  assert.equal(body.tools[0].cache_control.type, 'ephemeral')
  assert.equal(body.tools[0].input_schema.type, 'object')
  assert.equal(body.max_tokens, 8_000)
  // 这个对话**以 assistant 轮收尾**（不真实：DSH 总是以 user 轮收尾），按上游规则
  // 第三个断点不打——它只认收尾那一轮，不往前找。
  assert.equal(body.messages[1].content.at(-1).cache_control, undefined)

  // 真实形状：收尾是 user 轮 → 滚动缓存断点落在它的最后一块上。
  const rolling = buildBody({
    protocol: 'messages',
    model: 'claude-opus-4-6',
    messages: [...messages, { role: 'user', content: [{ type: 'text', text: 'again' }] }],
    maxTokens: 8_000,
  })
  assert.equal(rolling.messages.at(-1).content.at(-1).cache_control.type, 'ephemeral')
  assert.equal(rolling.messages[0].content.at(-1).cache_control, undefined)
})

test('the OpenAI envelope puts the system text in the messages array', () => {
  const body = buildBody({
    protocol: 'openai',
    model: 'smart-model',
    messages: USER_MESSAGE,
    system: 'be brief',
    maxTokens: 4096,
  })
  assert.deepEqual(body.messages[0], { role: 'system', content: 'be brief' })
  assert.equal(body.messages[1].role, 'user')
  assert.equal(body.messages[1].content, 'ping')
  assert.equal(body.stream, true)
  // 上游实测的请求体里没有 stream_options，这是个私有网关——没验证过的字段不发。
  assert.equal(body.stream_options, undefined)
  assert.equal(body.temperature, 0.3)
})

test('a non-object tool schema is repaired rather than sent as a 400', () => {
  const body = buildBody({
    protocol: 'cli',
    model: 'm',
    messages: [],
    tools: [{ name: 'weird', parameters: { type: 'string' } }],
  })
  assert.deepEqual(body.params.tools[0].input_schema, { type: 'object', properties: {}, additionalProperties: true })
})

// ================================================================== 行解析
// 三套传输在线上都是「一行一个 JSON」，容错规则必须一致。

test('a stream line is decoded across all three transport shapes', () => {
  assert.deepEqual(parseStreamLine('data: {"a":1}'), { type: 'event', event: { a: 1 } })
  assert.deepEqual(parseStreamLine('{"type":"text-delta","text":"x"}'), { type: 'event', event: { type: 'text-delta', text: 'x' } })
  assert.deepEqual(parseStreamLine('data: [DONE]'), { type: 'done' })
  assert.deepEqual(parseStreamLine(''), { type: 'ignored' })
  assert.deepEqual(parseStreamLine(': keep-alive'), { type: 'ignored' })
  assert.deepEqual(parseStreamLine('event: message'), { type: 'ignored' })
  // 半行/心跳不该炸掉整条流。
  assert.deepEqual(parseStreamLine('data: {"half":'), { type: 'ignored' })
})

test('usage counts are made non-overlapping because DSH counts them separately', () => {
  assert.deepEqual(
    normaliseUsage({ inputTokens: 100, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 10 } }),
    { inputTokens: 60, outputTokens: 5, cachedInputTokens: 30, cacheCreationInputTokens: 10 },
  )
  assert.deepEqual(normaliseUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4 } }), {
    inputTokens: 6,
    outputTokens: 1,
    cachedInputTokens: 4,
  })
  assert.equal(normaliseUsage(undefined), undefined)
  assert.equal(normaliseUsage({}), undefined)
})

test('the finish reason is collapsed into the three values the host understands', () => {
  assert.equal(finishKind('tool_calls'), 'tool-calls')
  assert.equal(finishKind('tool_use'), 'tool-calls')
  assert.equal(finishKind('length'), 'max-tokens')
  assert.equal(finishKind('max_output_tokens'), 'max-tokens')
  assert.equal(finishKind('end_turn'), 'stop')
  assert.equal(finishKind(undefined), 'stop')
  // 认不出的原因按最保守的 stop 处理：不谎报工具调用。
  assert.equal(finishKind('pause_turn'), 'stop')
})

test('only non-blank text or a tool call counts as an answer', () => {
  const reasoning = new StreamAssembler()
  handleCliEvent(reasoning, { type: 'reasoning-delta', text: 'hmm' })
  assert.equal(reasoning.produced, false)

  const blank = new StreamAssembler()
  handleCliEvent(blank, { type: 'text-delta', text: '   ' })
  assert.equal(blank.produced, false)

  const real = new StreamAssembler()
  handleCliEvent(real, { type: 'text-delta', text: 'ok' })
  assert.equal(real.produced, true)

  const tool = new StreamAssembler()
  handleCliEvent(tool, { type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} })
  assert.equal(tool.produced, true)
})

test('the private stream emits the block sequence the contract asks for', async () => {
  const chunks = await collect(translateCommandCodeStream(sseResponse(CLI_OK_FRAMES), 'cli', {}))
  assert.deepEqual(kinds(chunks), [
    'block-start',
    'text-delta',
    'text-delta',
    'block-end',
    'usage',
    'finish',
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'PO' })
  assert.deepEqual(chunks[3], { type: 'block-end', index: 0, block: { type: 'text', text: 'PONG' } })
  assert.deepEqual(chunks[5], { type: 'finish', reason: { kind: 'stop' } })
  // usage 必须在 finish **之前**：host 收到 finish 就收尾了。
  assert.deepEqual(chunks[4].usage, { inputTokens: 7, outputTokens: 2 })
})

test('a reasoning block is closed before the answer starts', async () => {
  const chunks = await collect(
    translateCommandCodeStream(
      sseResponse([
        { type: 'reasoning-start' },
        { type: 'reasoning-delta', text: 'thinking' },
        { type: 'text-delta', text: 'answer' },
        { type: 'finish', finishReason: 'stop' },
      ]),
      'cli',
      {},
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
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } })
  assert.deepEqual(chunks[3], { type: 'block-start', index: 1, blockType: 'text' })
  assert.deepEqual(chunks[5], { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } })
})

test('reasoning-end closes the thinking block without ending the turn', async () => {
  const chunks = await collect(
    translateCommandCodeStream(
      sseResponse([
        { type: 'reasoning-delta', text: 'thinking' },
        { type: 'reasoning-end' },
        { type: 'text-delta', text: 'answer' },
        { type: 'finish', finishReason: 'stop' },
      ]),
      'cli',
      {},
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
})

test('a private tool call arrives whole and carries a JSON string of arguments', async () => {
  const chunks = await collect(
    translateCommandCodeStream(
      sseResponse([
        { type: 'tool-call', toolCallId: 'call_9', toolName: 'get_weather', input: { city: 'SH' } },
        { type: 'finish', finishReason: 'tool-calls' },
      ]),
      'cli',
      {},
    ),
  )
  assert.deepEqual(kinds(chunks), ['block-start', 'tool-call-delta', 'block-end', 'finish'])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'tool-call' })
  assert.equal(chunks[1].id, 'call_9')
  assert.equal(chunks[1].name, 'get_weather')
  assert.equal(chunks[1].argumentsDelta, '{"city":"SH"}')
  assert.deepEqual(chunks[2].block, {
    type: 'tool-call',
    id: 'call_9',
    name: 'get_weather',
    arguments: '{"city":"SH"}',
  })
  assert.deepEqual(chunks[3], { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('the private cache-write event only fills in when finish did not report it', async () => {
  const fallback = await collect(
    translateCommandCodeStream(
      sseResponse([
        { type: 'text-delta', text: 'x' },
        { type: 'cache-write-tokens', cacheWriteTokens: 42 },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 1 } },
      ]),
      'cli',
      {},
    ),
  )
  const usage = fallback.find((chunk) => chunk.type === 'usage')
  assert.equal(usage.usage.cacheCreationInputTokens, 42)

  const explicit = await collect(
    translateCommandCodeStream(
      sseResponse([
        { type: 'text-delta', text: 'x' },
        { type: 'cache-write-tokens', cacheWriteTokens: 42 },
        {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 10, outputTokens: 1, inputTokenDetails: { cacheWriteTokens: 7 } },
        },
      ]),
      'cli',
      {},
    ),
  )
  const explicitUsage = explicit.find((chunk) => chunk.type === 'usage')
  assert.equal(explicitUsage.usage.cacheCreationInputTokens, 7)
})

test('the OpenAI stream reads every spelling of the reasoning field', async () => {
  const chunks = await collect(
    translateCommandCodeStream(
      sseResponse([
        { choices: [{ delta: { reasoning: 'a' } }] },
        { choices: [{ delta: { reasoning_content: 'b' } }] },
        { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'c' }] } }] },
        { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
      ]),
      'openai',
      {},
    ),
  )
  const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('')
  assert.equal(reasoning, 'abc')
})

test('fragmented OpenAI tool calls are reassembled in order before they are emitted', async () => {
  const chunks = await collect(
    translateCommandCodeStream(
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{"x"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':1}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]),
      'openai',
      {},
    ),
  )
  assert.deepEqual(kinds(chunks), ['block-start', 'tool-call-delta', 'block-end', 'block-start', 'tool-call-delta', 'block-end', 'finish'])
  const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
  assert.equal(blocks[0].name, 'first')
  assert.equal(blocks[1].name, 'second')
  assert.equal(blocks[1].arguments, '{"x":1}')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('an in-band stream error is raised instead of being swallowed as a short answer', async () => {
  await assert.rejects(
    () =>
      collect(
        translateCommandCodeStream(sseResponse([{ error: { message: 'context length exceeded', status: 400 } }]), 'openai', {}),
      ),
    (error) => {
      assert.match(error.message, /context length exceeded/)
      assert.equal(error.status, 400)
      return true
    },
  )
})

test('the messages transport is delegated to the Anthropic translator', async () => {
  const chunks = await collect(translateCommandCodeStream(sseResponse(MESSAGES_OK_FRAMES), 'messages', {}))
  // usage 在 finish 之前只发一次（Anthropic 的 message_start/message_delta 两处 usage
  // 由它自己合并）。
  assert.deepEqual(kinds(chunks), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 7, outputTokens: 2 })
})

// ================================================================== 空回答
// 契约 §5.2：一个内容块都没出必须抛 EMPTY_RESPONSE，池子靠它决定换号重试。

test('an answer made only of thinking is EMPTY_RESPONSE, not a successful finish', async () => {
  await assert.rejects(
    () =>
      collect(
        translateCommandCodeStream(sseResponse([{ type: 'reasoning-delta', text: 'hmm' }, { type: 'finish', finishReason: 'stop' }]), 'cli', {}),
      ),
    (error) => error.code === 'EMPTY_RESPONSE',
  )
  await assert.rejects(
    () => collect(translateCommandCodeStream(sseResponse([{ choices: [{ delta: { content: '  ' }, finish_reason: 'stop' }] }]), 'openai', {})),
    (error) => error.code === 'EMPTY_RESPONSE',
  )
})

test('a stream that ends without a finish is not reported as success', async () => {
  await assert.rejects(
    () => collect(translateCommandCodeStream(sseResponse([{ type: 'text-delta', text: 'half' }]), 'cli', {})),
    (error) => error.code === 'EMPTY_RESPONSE',
  )
  await assert.rejects(
    () => collect(translateCommandCodeStream(sseResponse([{ choices: [{ delta: { content: 'half' } }] }]), 'openai', {})),
    (error) => error.code === 'EMPTY_RESPONSE',
  )
})

// ================================================================== 凭据
// 四源发现：找得到要说清「找到了哪一处」，找不到要给能照着做的提示。

/**
 * 造一个假 credentials 服务：`resolve` 只认一个 ref，记录可按键列出。
 *
 * `listRecords()` 只给**键**（DSH 就是这么设计的），值要再 `readRecord(key)` 拿——
 * 所以这里的列表和读取必须共用同一个键形状，否则测出来的只是假服务的自相矛盾。
 */
function fakeCredentials({ ref, value, source = 'file', records = [] } = {}) {
  const entries = records.map((record) => ({ key: normaliseKey(record.key), value: record.value }))
  return {
    calls: [],
    async resolve(requested) {
      this.calls.push(requested)
      if (requested !== ref || value === undefined) return undefined
      return { value, source }
    },
    async listRecords() {
      return entries.map((entry) => ({ key: entry.key, kind: 'api-key' }))
    },
    async readRecord(key) {
      const wanted = keyText(key)
      return entries.find((entry) => keyText(entry.key) === wanted)?.value
    },
  }
}

/** 记录键既可能是字符串（本仓 store 的 `<scope>/<family>-<n>`），也可能是 `{scope,id}`。 */
function normaliseKey(key) {
  if (typeof key !== 'string') return key
  const slash = key.indexOf('/')
  return slash < 0 ? { scope: 'account-bridge', id: key } : { scope: key.slice(0, slash), id: key.slice(slash + 1) }
}

function keyText(key) {
  return typeof key === 'string' ? key : `${key.scope}/${key.id}`
}

async function withTempHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'cc-test-'))
  try {
    return await run(home, { env: { COMMANDCODE_HOME: home } })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('the credentials service is the first place we look', async () => {
  const credentials = fakeCredentials({ ref: 'COMMANDCODE_API_KEY', value: 'user_from_service_1', source: 'env' })
  await withTempHome(async (home, { env }) => {
    const items = await discoverWith(recordingCtx(() => {}, { services: { credentials } }), { env, home })
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, true)
    assert.equal(items[0].externallyOwned, true)
    assert.equal(items[0].family, 'commandcode')
    assert.equal(items[0].auth.apiKey, 'user_from_service_1')
    // 找到了哪一处必须如实报出来（用户要据此判断改哪个文件）。
    assert.match(items[0].sourcePath, /env: COMMANDCODE_API_KEY/)
    assert.deepEqual(credentials.calls, ['COMMANDCODE_API_KEY'])
  })
})

test('the environment variable is the second source', async () => {
  await withTempHome(async (home) => {
    const env = { COMMANDCODE_HOME: home, COMMANDCODE_API_KEY: 'user_from_env_1' }
    const items = await discoverWith(recordingCtx(() => {}, { services: {} }), { env, home })
    assert.equal(items[0].auth.apiKey, 'user_from_env_1')
    assert.equal(items[0].sourcePath, 'env: COMMANDCODE_API_KEY')
  })
})

test('the official CLI auth file is read the way the CLI writes it', async () => {
  await withTempHome(async (home) => {
    const env = { COMMANDCODE_HOME: home }
    // 形状 ①：顶层字符串。
    await writeFile(join(home, 'auth.json'), JSON.stringify({ apiKey: 'user_plain_1' }))
    let items = await discoverWith(recordingCtx(() => {}, { services: {} }), { env, home })
    assert.equal(items[0].auth.apiKey, 'user_plain_1')
    assert.equal(items[0].sourcePath, join(home, 'auth.json'))

    // 形状 ②：`commandcode` 是凭据记录，`type: 'api'` 取 `key`。
    await writeFile(join(home, 'auth.json'), JSON.stringify({ commandcode: { type: 'api', key: 'user_record_1', userName: 'ada' } }))
    items = await discoverWith(recordingCtx(() => {}, { services: {} }), { env, home })
    assert.equal(items[0].auth.apiKey, 'user_record_1')
    assert.equal(items[0].label, 'ada')

    // 形状 ③：`command-code` 是 oauth 记录，取 `access`。
    await writeFile(join(home, 'auth.json'), JSON.stringify({ 'command-code': { type: 'oauth', access: 'user_oauth_1' } }))
    items = await discoverWith(recordingCtx(() => {}, { services: {} }), { env, home })
    assert.equal(items[0].auth.apiKey, 'user_oauth_1')
  })
})

test('a stored credential record is the fourth source', async () => {
  const credentials = fakeCredentials({
    // 本仓 store 的记录键就是 `<scope>/<family>-<n>`（契约 §2）。
    records: [{ key: { scope: 'dsh-account-bridge', id: 'commandcode-1' }, value: { apiKey: 'user_stored_1' } }],
  })
  await withTempHome(async (home) => {
    const items = await discoverWith(recordingCtx(() => {}, { services: { credentials } }), { env: { COMMANDCODE_HOME: home }, home })
    assert.equal(items[0].auth.apiKey, 'user_stored_1')
    assert.match(items[0].sourcePath, /^credentials: /)
    assert.match(items[0].sourcePath, /commandcode-1/)
  })
})

test('the credentials service outranks the environment and the auth file', async () => {
  const credentials = fakeCredentials({ ref: 'COMMANDCODE_API_KEY', value: 'user_from_service_1', source: 'file' })
  await withTempHome(async (home) => {
    const env = { COMMANDCODE_HOME: home, COMMANDCODE_API_KEY: 'user_from_env_1' }
    await writeFile(join(home, 'auth.json'), JSON.stringify({ apiKey: 'user_from_file_1' }))
    const items = await discoverWith(recordingCtx(() => {}, { services: { credentials } }), { env, home })
    assert.equal(items[0].auth.apiKey, 'user_from_service_1')
    assert.match(items[0].sourcePath, /credentials/)
    // 同一个 key 出现在多个源里时不该被导入两次（否则池子里有两个同账号）。
    const keys = items.map((item) => item.auth.apiKey)
    assert.equal(new Set(keys).size, keys.length)
  })
})

test('nothing found is not an empty array: it is a note the user can act on', async () => {
  await withTempHome(async (home) => {
    const items = await discoverWith(recordingCtx(() => {}, { services: {} }), { env: { COMMANDCODE_HOME: home }, home })
    assert.equal(items.length, 1)
    assert.equal(items[0].importable, false)
    assert.equal(items[0].family, 'commandcode')
    assert.equal(items[0].sourcePath, `${home} (auth.json)`)
    // 三条自救路径都要写清楚，且点出四处都查过了。
    assert.match(items[0].reason, /command-code login/)
    assert.match(items[0].reason, /COMMANDCODE_API_KEY/)
    assert.match(items[0].reason, /④/)
  })
})

test('an unreadable auth file is reported instead of silently ignored', async () => {
  await withTempHome(async (home) => {
    await writeFile(join(home, 'auth.json'), '{ not json')
    const items = await discoverWith(recordingCtx(() => {}, { services: {} }), { env: { COMMANDCODE_HOME: home }, home })
    assert.equal(items[0].importable, false)
    assert.match(items[0].reason, /不是合法 JSON/)

    await writeFile(join(home, 'auth.json'), JSON.stringify({ unrelated: true }))
    const empty = await discoverWith(recordingCtx(() => {}, { services: {} }), { env: { COMMANDCODE_HOME: home }, home })
    assert.match(empty[0].reason, /没有 apiKey/)
  })
})

test('discovery output becomes an account record that remembers where it came from', () => {
  const record = commandcodeFamily.recordFromDiscovery({
    family: 'commandcode',
    sourcePath: '/home/ada/.commandcode/auth.json',
    label: 'ada',
    importable: true,
    auth: { apiKey: 'user_abc' },
  })
  assert.equal(record.family, 'commandcode')
  assert.equal(record.source, 'client-import')
  assert.equal(record.externallyOwned, true)
  assert.equal(record.label, 'ada')
  assert.deepEqual(record.auth, { apiKey: 'user_abc' })
  assert.equal(record.sourcePath, '/home/ada/.commandcode/auth.json')
})

test('the auth file parser covers every credential record shape', () => {
  assert.equal(apiKeyFromCredentialRecord({ type: 'api', key: 'k' }), 'k')
  assert.equal(apiKeyFromCredentialRecord({ type: 'oauth', access: 'a' }), 'a')
  assert.equal(apiKeyFromCredentialRecord({ key: 'k', access: 'a' }), 'k')
  assert.equal(apiKeyFromCredentialRecord({ access: 'a' }), 'a')
  assert.equal(apiKeyFromCredentialRecord('nope'), undefined)
  assert.equal(parseAuthFile({ commandcode: 'user_direct' }).apiKey, 'user_direct')
  assert.equal(parseAuthFile({ apiKey: 'user_a', commandcode: { type: 'api', key: 'user_b' } }).apiKey, 'user_a')
  assert.equal(parseAuthFile({}), undefined)
  assert.equal(parseAuthFile(null), undefined)
})

test('a credentials value is unwrapped whether it is a string or a wrapper object', () => {
  assert.deepEqual(credentialFromRecord('user_x'), { apiKey: 'user_x' })
  assert.deepEqual(credentialFromRecord({ apiKey: 'user_x' }), { apiKey: 'user_x' })
  assert.deepEqual(credentialFromRecord({ api_key: 'user_x' }), { apiKey: 'user_x' })
  assert.deepEqual(credentialFromRecord({ key: 'user_x', email: 'ada@example.com' }), { apiKey: 'user_x', userName: 'ada@example.com' })
  assert.equal(credentialFromRecord({ nope: true }), undefined)
  assert.equal(credentialFromRecord(''), undefined)
})

test('the state directory follows COMMANDCODE_HOME so a profile stays portable', () => {
  assert.equal(commandCodeHome({ COMMANDCODE_HOME: 'D:\\cc' }), 'D:\\cc')
  assert.match(commandCodeHome({}), /\.commandcode$/)
})

// ================================================================== 登录

test('the studio URL points back at our loopback callback with the state token', () => {
  const url = buildStudioAuthUrl({ studioBase: 'https://commandcode.ai', port: 5959, state: 'st-1' })
  assert.equal(
    url,
    'https://commandcode.ai/studio/auth/cli?callback=http%3A%2F%2Flocalhost%3A5959%2Fcallback&state=st-1',
  )
  assert.equal(studioBaseForApiBase('https://api.commandcode.ai'), 'https://commandcode.ai')
  assert.equal(studioBaseForApiBase('https://staging-api.commandcode.ai'), 'https://staging.commandcode.ai')
  assert.equal(studioBaseForApiBase('http://localhost:8787'), 'http://localhost:3000')
})

test('the studio callback only accepts a well-formed POST with the right state', () => {
  const credentials = { apiKey: 'user_1', state: 'st-1', userId: 'u1', userName: 'ada', keyName: 'cli' }
  const post = (body, extra = {}) =>
    parseCallbackRequest({ method: 'POST', path: '/callback', body: JSON.stringify(body), expectedState: 'st-1', ...extra })

  const accepted = post(credentials)
  assert.equal(accepted.status, 200)
  assert.deepEqual(accepted.body, { success: true })
  assert.deepEqual(accepted.credentials, credentials)

  assert.equal(post(credentials, { path: '/elsewhere' }).status, 404)
  assert.equal(parseCallbackRequest({ method: 'GET', path: '/callback', body: '', expectedState: 'st-1' }).status, 405)
  assert.equal(parseCallbackRequest({ method: 'OPTIONS', path: '/callback', body: '', expectedState: 'st-1' }).status, 204)
  assert.equal(post({ ...credentials, state: 'forged' }).status, 403)
  assert.equal(parseCallbackRequest({ method: 'POST', path: '/callback', body: '{oops', expectedState: 'st-1' }).status, 400)
  assert.equal(post({ apiKey: 'user_1', state: 'st-1' }).status, 400)
  // state 不对的请求**不能**终止等待（否则伪造请求能把真登录踢下线）。
  assert.equal(post({ state: 'forged', error: 'denied' }).status, 403)
  // 用户点了拒绝：只拒绝那一次匹配的等待。
  const denied = post({ ...credentials, error: 'user_denied' })
  assert.equal(denied.status, 200)
  assert.equal(denied.rejected, 'user_denied')
  assert.equal(denied.credentials, undefined)
})

test('the callback only echoes CORS for the studio origins it trusts', () => {
  const trusted = parseCallbackRequest({
    method: 'POST',
    path: '/callback',
    origin: 'https://commandcode.ai',
    body: '{}',
    expectedState: 'st-1',
  })
  assert.equal(trusted.headers['access-control-allow-origin'], 'https://commandcode.ai')
  const stranger = parseCallbackRequest({
    method: 'POST',
    path: '/callback',
    origin: 'https://evil.example.com',
    body: '{}',
    expectedState: 'st-1',
  })
  assert.equal(stranger.headers['access-control-allow-origin'], undefined)
})

test('the login flow offers a way in that needs no interactive prompt at all', () => {
  const ids = commandcodeFamily.login.methods.map((method) => method.id)
  // agent 会话里 broker 只会自动回答「只有一个选项的 select」，
  // 所以「导入本机登录态」这条路必须存在，否则工具面加不了账号。
  assert.deepEqual(ids, ['browser', 'paste', 'import'])
})

test('import reports why it cannot import instead of failing silently', async () => {
  await withTempHome(async (home) => {
    const ctx = recordingCtx(() => {}, { services: {} })
    ctx.env = { COMMANDCODE_HOME: home }
    // discover 走的是真环境：临时 home 里没有 auth.json，也没有 services ⇒ 没有可导入项。
    const previous = process.env.COMMANDCODE_HOME
    const previousKey = process.env.COMMANDCODE_API_KEY
    process.env.COMMANDCODE_HOME = home
    delete process.env.COMMANDCODE_API_KEY
    try {
      await assert.rejects(
        () => commandcodeFamily.login.run({ method: 'import', commit: async () => {} }, ctx),
        (error) => {
          assert.match(error.message, /没有可导入的本机登录态/)
          return true
        },
      )
    } finally {
      if (previous === undefined) delete process.env.COMMANDCODE_HOME
      else process.env.COMMANDCODE_HOME = previous
      if (previousKey !== undefined) process.env.COMMANDCODE_API_KEY = previousKey
    }
  })
})

test('pasting a key validates it upstream before it is committed', async () => {
  const seen = []
  const ctx = recordingCtx((url) => {
    seen.push(url)
    return jsonResponse({ ok: true })
  })
  const committed = []
  const session = {
    method: 'paste',
    async prompt() {
      return 'user_pasted_1'
    },
    async commit(event) {
      committed.push(event)
    },
  }
  await commandcodeFamily.login.run(session, ctx)
  assert.equal(seen[0], 'https://api.commandcode.ai/alpha/whoami')
  assert.equal(committed.length, 1)
  assert.equal(committed[0].kind, 'grant')
  assert.equal(committed[0].payload.auth.apiKey, 'user_pasted_1')
  assert.equal(committed[0].payload.source, 'manual')
})

test('a key that does not validate is not committed', async () => {
  const ctx = recordingCtx(() => errorResponse(401, { error: { message: 'invalid API key' } }))
  let committed = 0
  const session = {
    method: 'paste',
    async prompt() {
      return 'user_bad_1'
    },
    async commit() {
      committed += 1
    },
  }
  await assert.rejects(() => commandcodeFamily.login.run(session, ctx), /没通过校验/)
  assert.equal(committed, 0)
})

// ================================================================== 刷新
// 这一族的 key 不会过期也不会轮换：needsRefresh 恒 false 是**结论**不是漏写。

test('refresh returns the auth object unchanged and never claims to be needed', async () => {
  const auth = { apiKey: 'user_abc', apiBase: 'https://api.commandcode.ai', userName: 'ada' }
  const refreshed = await commandcodeFamily.refresh({}, { auth }, undefined)
  assert.deepEqual(refreshed, auth)
  assert.equal(commandcodeFamily.needsRefresh({ auth }, Date.now()), false)
  assert.equal(commandcodeFamily.needsRefresh({ auth }, Date.now() + 10 * 365 * 24 * 3600 * 1000), false)
})

test('a record with no key fails as AUTH so the pool cools the account down', async () => {
  await assert.rejects(
    () => commandcodeFamily.refresh({}, { auth: {} }, undefined),
    (error) => {
      assert.equal(error.code, 'AUTH')
      return true
    },
  )
})

// ================================================================== 目录与额度

test('the model catalog comes from the provider endpoint and feeds routing', async () => {
  const ctx = recordingCtx(() =>
    jsonResponse({
      object: 'list',
      data: [
        { id: 'smart-model', name: 'Smart', context_length: 200_000, supported_endpoints: ['/chat/completions'] },
      ],
    }),
  )
  const models = await commandcodeFamily.listModels(ctx, { auth: { apiKey: 'user_abc' } }, undefined)
  assert.equal(ctx.calls[0].url, 'https://api.commandcode.ai/provider/v1/models')
  assert.equal(models[0].provider, 'acct-commandcode')
  assert.equal(models[0].id, 'smart-model')
  assert.equal(models[0].context.contextWindow, 200_000)
})

test('a broken catalog falls back to a minimal list instead of making the route vanish', async () => {
  const ctx = recordingCtx(() => errorResponse(500, 'boom'))
  const models = await commandcodeFamily.listModels(ctx, { auth: { apiKey: 'user_abc' } }, undefined)
  assert.equal(models.length > 0, true)
  assert.equal(ctx.warnings.length, 1)
  // 兜底项也必须带完整元数据，否则宿主面板读不到窗口。
  assert.equal(typeof models[0].context.contextWindow, 'number')
})

test('the quota reader returns the two windows the CLI bar draws', async () => {
  const now = Date.now()
  const ctx = recordingCtx(() =>
    jsonResponse({
      windowLimits: {
        fiveHour: { used: 25, cap: 100, exceeded: false, resetAt: now + 3600_000 },
        weekly: { used: 900, cap: 1000, exceeded: false, resetAt: now + 86400_000 },
      },
    }),
  )
  const windows = await commandcodeFamily.quota(ctx, { auth: { apiKey: 'user_abc' } }, undefined)
  assert.equal(ctx.calls[0].url, 'https://api.commandcode.ai/alpha/billing/credits')
  assert.deepEqual(windows.map((window) => window.id), ['five-hour', 'weekly'])
  assert.equal(windows[0].name, '5 小时窗口')
  assert.equal(windows[0].remainingFraction, 0.75)
  // 浮点：0.1 不该因为二进制表示而被判成「不是 0.1」。
  assert.equal(Math.abs(windows[1].remainingFraction - 0.1) < 1e-9, true)
  assert.equal(windows[0].resetAt, now + 3600_000)
})

test('a missing window and an unlimited window are both reported as unknown, not as 0%', () => {
  const now = Date.now()
  const windows = parseWindowLimits({ windowLimits: { weekly: { used: 5, cap: 0 } } }, now)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].id, 'weekly')
  // cap 为 0 是上游真实上报的「无限花费」：比例算不出来就说算不出来。
  assert.equal(windows[0].remainingFraction, undefined)
  // 窗口缺失是另一种「没报」，同样不许折算成 0%。
  assert.equal(parseWindowLimits({ windowLimits: { fiveHour: { used: 5, cap: 10 } } }, now).some((w) => w.id === 'weekly'), false)
})

test('a quota read that cannot be trusted yields undefined rather than a fake bar', async () => {
  // 每个用例换一个 key：额度快照是按账号缓存的，复用 key 会测到上一份快照。
  const ctx = recordingCtx(() => jsonResponse({}))
  assert.equal(await commandcodeFamily.quota(ctx, { auth: { apiKey: 'user_empty_1' } }, undefined), undefined)

  const failing = recordingCtx(() => errorResponse(500, 'boom'))
  assert.equal(await commandcodeFamily.quota(failing, { auth: { apiKey: 'user_xyz' } }, undefined), undefined)

  const throwing = recordingCtx(() => {
    throw new Error('socket hang up')
  })
  assert.equal(await commandcodeFamily.quota(throwing, { auth: { apiKey: 'user_throw' } }, undefined), undefined)
})

test('an untrustworthy reset time is dropped instead of pinning the account', () => {
  const now = Date.now()
  const seconds = Math.floor((now + 3600_000) / 1000)
  const windows = parseWindowLimits(
    {
      windowLimits: {
        // 上游把 resetAt 钉在一年后：这种值不可信，丢掉而不是照抄。
        fiveHour: { used: 1, cap: 10, resetAt: now + 365 * 24 * 3600 * 1000 },
        // 秒级时间戳要按量级识别（这些端点毫秒/秒混用）。
        weekly: { used: 1, cap: 10, resetAt: seconds },
      },
    },
    now,
  )
  assert.equal(windows[0].resetAt, undefined)
  assert.equal(windows[1].resetAt, seconds * 1000)
})

// ================================================================== 失败归类

test('HTTP failures are classified the way the pool expects', async () => {
  const cases = [
    [401, { error: { message: 'invalid API key' } }, 'AUTH'],
    [402, { error: { message: 'insufficient credits' } }, 'ACCOUNT_QUOTA'],
    [429, { error: { message: 'usage limit reached' } }, 'QUOTA'],
    [429, { error: { message: 'too many requests' } }, 'RATE_LIMIT'],
    [400, { error: { message: 'context length exceeded' } }, 'CONTEXT_WINDOW_EXCEEDED'],
    [504, { error: { message: 'gateway timeout' } }, 'TIMEOUT'],
    [500, { error: { message: 'internal error' } }, 'SERVER'],
  ]
  for (const [status, body, code] of cases) {
    const ctx = recordingCtx(() => errorResponse(status, body))
    await assert.rejects(
      () => collect(commandcodeFamily.stream(ctx, streamOptions(ctx))),
      (error) => {
        assert.equal(error.code, code, `HTTP ${status} should map to ${code}`)
        assert.equal(error.failure.status, status)
        return true
      },
    )
  }
})

// ================================================================== 流式协商

test('a normal turn goes over the OpenAI transport with the streaming flag set', async () => {
  const ctx = recordingCtx(() => sseResponse(OPENAI_OK_FRAMES))
  const chunks = await collect(
    commandcodeFamily.stream(ctx, {
      ...streamOptions(ctx),
      // 代理挂在**记录**上（池子就是这么传的），不是挂在 options 上。
      payload: { auth: { apiKey: 'user_test_key_1234' }, proxy: 'http://127.0.0.1:7890' },
    }),
  )

  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].url, 'https://api.commandcode.ai/provider/v1/chat/completions')
  assert.equal(ctx.calls[0].init.method, 'POST')
  assert.deepEqual(kinds(chunks), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  // 流式请求的第 4 个参数必须是 true：代理下 bodyTimeout 为 0，
  // 否则长回答会在中途被掐断。
  assert.equal(ctx.calls[0].streaming, true)
  assert.equal(ctx.calls[0].proxy, 'http://127.0.0.1:7890')

  const body = JSON.parse(ctx.calls[0].init.body)
  assert.equal(body.model, 'smart-model')
  assert.equal(body.max_tokens, 4096)
  assert.equal(body.stream, true)
  // Provider 面：identity 开关在，CLI 身份头**一个都不该有**。
  assert.equal(ctx.calls[0].init.headers['accept-encoding'], 'identity')
  assert.equal(ctx.calls[0].init.headers['accept'], 'text/event-stream')
  assert.equal(ctx.calls[0].init.headers['x-command-code-version'], undefined)
  assert.equal(ctx.calls[0].init.headers['x-cli-environment'], undefined)
  assert.equal(ctx.calls[0].init.headers['x-taste-learning'], undefined)
  // `x-cmd-zdr` 默认不发（账号级 opt-in）；账号开了才发。
  assert.equal(ctx.calls[0].init.headers['x-cmd-zdr'], undefined)

  const zdrCtx = recordingCtx(() => sseResponse(OPENAI_OK_FRAMES))
  await collect(
    commandcodeFamily.stream(zdrCtx, {
      ...streamOptions(zdrCtx),
      payload: { auth: { apiKey: 'user_test_key_1234', zdr: true } },
    }),
  )
  assert.equal(zdrCtx.calls[0].init.headers['x-cmd-zdr'], '1')
})

test('a Claude model is routed to the messages transport without any probing', async () => {
  const ctx = recordingCtx(() => sseResponse(MESSAGES_OK_FRAMES))
  await collect(commandcodeFamily.stream(ctx, streamOptions(ctx, { model: 'claude-sonnet-5-5' })))
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].url, 'https://api.commandcode.ai/provider/v1/messages')
  assert.equal(JSON.parse(ctx.calls[0].init.body).temperature, undefined)
})

test('a routing rejection is retried over the endpoint the upstream named, once', async () => {
  const ctx = recordingCtx((url) => {
    if (url.endsWith('/provider/v1/chat/completions')) {
      return errorResponse(400, {
        error: { message: 'Model "smart-model" must be called via /provider/v1/messages (Anthropic Messages shape)' },
      })
    }
    return sseResponse(MESSAGES_OK_FRAMES)
  })
  const chunks = await collect(commandcodeFamily.stream(ctx, streamOptions(ctx)))
  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[1].url, 'https://api.commandcode.ai/provider/v1/messages')
  assert.equal(ctx.calls[1].streaming, true)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a Go plan account falls back to the private transport and no further', async () => {
  const ctx = recordingCtx((url) => {
    if (url.endsWith('/provider/v1/chat/completions')) {
      return errorResponse(403, { error: { code: 'upgrade_required', message: 'This plan has no API access' } })
    }
    return sseResponse(CLI_OK_FRAMES)
  })
  const chunks = await collect(commandcodeFamily.stream(ctx, streamOptions(ctx)))
  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[1].url, 'https://api.commandcode.ai/alpha/generate')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // CLI 面拿的是 CLI 身份头（版本号走兜底常量，本仓的 resolveCliVersion 不认识这族）。
  assert.equal(ctx.calls[1].init.headers['x-taste-learning'], 'false')
  assert.equal(ctx.calls[1].init.headers['x-co-flag'], 'false')
  assert.equal(ctx.calls[1].init.headers['x-cli-environment'], 'production')
  assert.equal(ctx.calls[1].init.headers['x-command-code-version'], DEFAULT_CLI_VERSION)
})

test('a repeated rejection stops instead of bouncing between transports', async () => {
  // 两套 Provider 传输都回「你走错端点了」：不许来回弹，直接抛出第二套的错。
  const ctx = recordingCtx((url) => {
    if (url.endsWith('/provider/v1/chat/completions')) {
      return errorResponse(400, {
        error: { message: 'Model "smart-model" must be called via /provider/v1/messages (Anthropic Messages shape)' },
      })
    }
    return errorResponse(400, {
      error: { message: 'Model "smart-model" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models.' },
    })
  })
  await assert.rejects(
    () => collect(commandcodeFamily.stream(ctx, streamOptions(ctx))),
    (error) => error.code === 'CONTEXT_WINDOW_EXCEEDED' || error.failure?.status === 400,
  )
  assert.equal(ctx.calls.length, 2)
})

test('an ordinary server error is surfaced as SERVER, not disguised as a protocol problem', async () => {
  const ctx = recordingCtx(() => errorResponse(500, { error: { message: 'internal error' } }))
  await assert.rejects(
    () => collect(commandcodeFamily.stream(ctx, streamOptions(ctx))),
    (error) => {
      assert.equal(error.code, 'SERVER')
      assert.equal(error.failure.status, 500)
      return true
    },
  )
  // 只试了一套传输：故障是上游的，不该靠换协议掩盖。
  assert.equal(ctx.calls.length, 1)
})

test('a failure after the first chunk is never retried over another transport', async () => {
  const ctx = recordingCtx((url, init, count) =>
    count === 1
      ? sseResponse([{ type: 'text-delta', text: 'half' }, { type: 'error', error: { message: 'boom' } }])
      : sseResponse(CLI_OK_FRAMES),
  )
  await assert.rejects(() => collect(commandcodeFamily.stream(ctx, streamOptions(ctx))), /boom/)
  // 已经把「half」交给宿主了，重放等于把半句话再说一遍。
  assert.equal(ctx.calls.length, 1)
})

test('an empty answer over HTTP 200 is EMPTY_RESPONSE so the pool can rotate', async () => {
  const ctx = recordingCtx(() => sseResponse([{ type: 'reasoning-delta', text: 'thinking only' }, { type: 'finish', finishReason: 'stop' }]))
  await assert.rejects(
    () => collect(commandcodeFamily.stream(ctx, streamOptions(ctx))),
    (error) => {
      assert.equal(error.code, 'EMPTY_RESPONSE')
      assert.equal(error.failure.code, 'EMPTY_RESPONSE')
      return true
    },
  )
})

test('a record without a key fails as AUTH before any request is sent', async () => {
  const ctx = recordingCtx(() => sseResponse(CLI_OK_FRAMES))
  await assert.rejects(
    () => collect(commandcodeFamily.stream(ctx, streamOptions(ctx, { payload: { auth: {} } }))),
    (error) => error.code === 'AUTH',
  )
  assert.equal(ctx.calls.length, 0)
})

test('a record can pin a transport, and the catalog still outranks it for Claude', async () => {
  const ctx = recordingCtx(() => sseResponse(CLI_OK_FRAMES))
  await collect(commandcodeFamily.stream(ctx, streamOptions(ctx, { payload: { auth: { apiKey: 'user_x', protocol: 'cli' } } })))
  assert.equal(ctx.calls[0].url, 'https://api.commandcode.ai/alpha/generate')

  const claude = recordingCtx(() => sseResponse(MESSAGES_OK_FRAMES))
  await collect(
    commandcodeFamily.stream(
      claude,
      streamOptions(claude, { payload: { auth: { apiKey: 'user_x', protocol: 'openai' } }, model: 'claude-opus-4-6' }),
    ),
  )
  assert.equal(claude.calls[0].url, 'https://api.commandcode.ai/provider/v1/messages')
})

// ================================================================== 族形状

test('the family object is shaped the way the registry expects', () => {
  assert.equal(commandcodeFamily.id, 'commandcode')
  assert.match(commandcodeFamily.id, /^[a-z][a-z0-9-]*$/)
  assert.equal(commandcodeFamily.route, 'acct-commandcode')
  assert.equal(commandcodeFamily.displayName, 'CommandCode')
  for (const key of ['discover', 'recordFromDiscovery', 'login', 'refresh', 'needsRefresh', 'listModels', 'resolveModel', 'quota', 'stream']) {
    assert.equal(typeof commandcodeFamily[key] === 'function' || typeof commandcodeFamily[key] === 'object', true, key)
  }
  const info = commandcodeFamily.resolveModel('acct-commandcode', 'smart-model')
  assert.equal(info.provider, 'acct-commandcode')
  assert.equal(info.id, 'smart-model')
})

// ================================================================== 真机
// 真的打上游：默认跳过（会烧真实额度，而且要求本机装好并登录了 CommandCode）。

test('live: the real catalog answers and lists models', { skip: process.env.BRIDGE_LIVE_COMMANDCODE !== '1' }, async () => {
  const ctx = recordingCtx((url, init) => fetch(url, init))
  const models = await commandcodeFamily.listModels(ctx, { auth: {} }, undefined)
  assert.equal(Array.isArray(models), true)
  assert.equal(models.length > 0, true)
})
