/**
 * 一个假的 OpenAI / Anthropic 兼容端点，专门用来验收 `generic` 族。
 *
 * 为什么要造一个假的：`generic` 族的全部卖点是「**任意**兼容端点，不写一行族代码就能接」。
 * 拿一个已有的真服务测，证明不了这一点——那只说明代码碰巧对上了那个服务。
 * 用这个服务测才有意义：插件在写代码时根本不知道它存在，地址是 `127.0.0.1` 上一个
 * 临时端口，模型名是这里编的。
 *
 * 它刻意在方言上做了几处刁难，因为真实的兼容网关就是这么不整齐：
 * - **只认 `data:` 行，不发 `event:` 行**（Anthropic 那条路上）；
 * - **不认 `stream_options`**：发了就 400（测 `compat.streamUsage: false`）；
 * - **不认 `cache_control`**：收到就 400（测「不冒充身份、不塞未知字段」）；
 * - **必须带正确的 Bearer / x-api-key**，否则 401（测凭据真的送到了）。
 *
 * **它每一笔请求都留着**（`GET /__requests`、`DELETE /__requests` 清空，只留最近 50 笔）：
 * 「我们到底发了什么」以前只有删掉的 golden 快照能回答，现在由假上游记原文来回答。
 * 记录里有解析好的 body 与几个关键头，探针靠提示词里的唯一标记找回「我这一笔」。
 *
 * 另有几个「行为刁难」模型（P7 的验收用）：
 * - `claude-mock-hold`：**第一次**请求先发 20 个思考块再报错，第二次正常答复。用来验
 *   「思考不算输出」——名字以 `claude` 开头是故意的，只有会「想完就拒」的族才值得憋。
 *   换号窗口如果还开着，第二个账号就会拿到这个请求。
 * - `mock-html-page`：**200 但正文是 HTML**（网关登录页 / 云挡板很常见的样子）。
 * - `mock-cf-403`：**403 且正文是 HTML**。这条最关键：403 在分类器里等于 `AUTH`
 *   （账号冷 24 小时），而「中间有个东西挡着」跟「这个账号的令牌废了」是两件事。
 * - `mock-tool-call`：一次工具调用，`arguments` 拆成三片发 —— 宿主拿到的必须是拼好的
 *   JSON 字符串，且 `finish` 必须说 `tool-calls`（说 `stop` 宿主会以为模型把话说完了）。
 * - `mock-usage-zero`：先报 4242 个输入 token，再用一帧**零**去覆盖它。零不许擦掉读数。
 * - `mock-cut-short`：`length` / `pause_turn` 收尾 —— 可续跑不等于正常结束。
 *
 * 用法：node mock-openai.mjs [port]   → 打印 `LISTENING <port>` 后一直跑
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 0)
const KEY = 'sk-mock-secret'

const MODELS = [
  'mock-alpha',
  'mock-beta',
  'mock-image-only',
  'claude-mock-hold',
  'mock-html-page',
  'mock-cf-403',
  // W3 的两条：一个上游说「一周后再来」，一个上游说「余额不足」。
  'mock-429-week',
  'mock-credit',
  // W6：把上游看见的 key 原样放进回答里。账号各用一把 key 的时候，
  // 「这次是谁答的」就有了上游侧的物证，不用去猜池子的内部状态。
  'mock-whoami',
  // W8：上游说了个我们不认识的话。
  'mock-unknown-stop',
  // 「翻译回显」用的三条：工具调用、零值用量、被截断。两种方言都服务，
  // 因为宿主侧看到的结果**不该随池子挑了哪个账号而变**。
  'mock-tool-call',
  'mock-usage-zero',
  'mock-cut-short',
]

/**
 * 只在一个方言的目录里出现的模型。
 *
 * 为什么要它：请求形状的断言是**分方言**的（`tool_calls` 对 `tool_use`、`system` 在
 * messages 里对在 body 顶层……），而池子会按目录挑账号。把一个模型只放进一条方言的
 * 目录里，`#streamWithPool` 的 `entry.modelId === model` 过滤就替我们把这一笔钉死在
 * 那条路上——不必去猜这次是谁答的，也不必读池子的内部状态。
 */
const OPENAI_ONLY = ['mock-openai-only']
const ANTHROPIC_ONLY = ['mock-anthropic-only', 'mock-signed-thinking']

/** 声明式目录里的模型也要能推理，不只是目录里那个「live」集合。 */
const ADVERTISED = new Set([...MODELS, ...OPENAI_ONLY, ...ANTHROPIC_ONLY, 'declared-only'])

/** 只在一个方言目录里出现的模型（别的方言 404，与 ADVERTISED 配合使用）。 */
function catalogFor(anthropic) {
  const hidden = anthropic ? OPENAI_ONLY : ANTHROPIC_ONLY
  const extra = anthropic ? ANTHROPIC_ONLY : OPENAI_ONLY
  return [...MODELS.filter((id) => !hidden.includes(id)), ...extra]
}

/** 最近若干笔请求的原文。验收要能回答「我们到底发了什么」，而不是只看结果。 */
const REQUEST_LOG = []
const REQUESTS_KEPT = 50

/** 一笔请求的摘要：解析好的 body + 几个关键头（**不存整份头**，里面没什么可看的）。 */
function remember(request, path, body) {
  const anthropic = path.includes('/messages')
  REQUEST_LOG.push({
    at: Date.now(),
    path,
    dialect: anthropic ? 'anthropic' : 'openai',
    auth: seenKey(request),
    headers: {
      'content-type': request.headers['content-type'] ?? null,
      'user-agent': request.headers['user-agent'] ?? null,
      'anthropic-version': request.headers['anthropic-version'] ?? null,
    },
    body,
  })
  while (REQUEST_LOG.length > REQUESTS_KEPT) REQUEST_LOG.shift()
}

/** `claude-mock-hold` 只在第一次请求上失败，好让第二个账号接住。 */
let holdHits = 0

/** 逐块吐出「PONG」，模仿真实网关的分块节奏（每块一到两个字符）。 */
function chatChunks(text, cached = 0) {
  const events = []
  for (const piece of text) events.push({ choices: [{ delta: { content: piece } }] })
  events.push({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 7,
      completion_tokens: text.length,
      prompt_tokens_details: { cached_tokens: cached },
    },
  })
  return events
}

function anthropicEvents(text, cached = 0, stopReason = 'end_turn') {
  return [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: cached } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...[...text].map((piece) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: text.length } },
    { type: 'message_stop' },
  ]
}

/**
 * W7：上游从缓存里读到了多少。
 *
 * 判据是**提示词里有没有 `WARM`**：探针一段会话一段会话地控制它，
 * 假上游就不必去猜会话边界（它本来也不知道）。两个方言各有各的字段名。
 */
function cacheReadFor(body) {
  return JSON.stringify(body.messages ?? []).includes('WARM') ? 2048 : 0
}

/** 两个方言里 usage 各叫什么（照真实上游的字段名，别用我们自己那套内部名）。 */
function cacheFieldOf(anthropic) {
  return anthropic ? 'cache_read_input_tokens' : 'prompt_tokens_details.cached_tokens'
}

/** 「想了半天然后被上游打断」：OpenAI 方言。 */
function holdChunksOpenAI() {
  const events = []
  for (let i = 0; i < 20; i += 1) events.push({ choices: [{ delta: { reasoning_content: `thinking ${i}…` } }] })
  events.push({ error: { code: 'rate_limit_error', message: 'mock: overloaded after thinking, try another account' } })
  return events
}

/** 同上：Anthropic 方言（思考是 `thinking_delta` 内容块）。 */
function holdEventsAnthropic() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ...Array.from({ length: 20 }, (_, i) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: `thinking ${i}…` },
    })),
    { type: 'error', error: { type: 'rate_limit_error', message: 'mock: overloaded after thinking, try another account' } },
  ]
}

/**
 * 一次工具调用。`arguments` 被拆成三片，`id` 与名字只出现在首块——
 * 真实的兼容网关就是这么拆的（也有把 `id` 拆到后面几块的）。
 */
const TOOL_ARGS = JSON.stringify({ path: 'src/index.js' })
const TOOL_CALL_ID = 'call_mock_1'
const TOOL_NAME = 'read_file'

function chatToolCallChunks() {
  const pieces = [TOOL_ARGS.slice(0, 6), TOOL_ARGS.slice(6, 11), TOOL_ARGS.slice(11)]
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: TOOL_CALL_ID, type: 'function', function: { name: TOOL_NAME, arguments: '' } },
            ],
          },
        },
      ],
    },
    ...pieces.map((piece) => ({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }],
    })),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 3 } },
  ]
}

function anthropicToolCallEvents() {
  const pieces = [TOOL_ARGS.slice(0, 6), TOOL_ARGS.slice(6, 11), TOOL_ARGS.slice(11)]
  return [
    { type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 0 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: TOOL_CALL_ID, name: TOOL_NAME, input: {} },
    },
    ...pieces.map((piece) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: piece },
    })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
}

/** 先报 4242 个输入 token，再用一帧**零**去覆盖它（`mergeUsageNonZero` 的靶子）。 */
const USAGE_INPUT = 4242

function chatUsageZeroChunks() {
  return [
    { choices: [{ delta: { content: 'PONG' } }], usage: { prompt_tokens: USAGE_INPUT, completion_tokens: 0 } },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ]
}

function anthropicUsageZeroEvents() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: USAGE_INPUT, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } },
    { type: 'content_block_stop', index: 0 },
    // 这一帧说输入是 0：**零不能擦掉已经读到的 4242**，这是宿主账目的口径。
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 0, output_tokens: 4 } },
    { type: 'message_stop' },
  ]
}

/** 被截断的一轮：两个方言各用各的说法，落进 DSH 只有 `max-tokens` 一个答案。 */
function chatCutShortChunks() {
  return [
    { choices: [{ delta: { content: 'PONG' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 7, completion_tokens: 4 } },
  ]
}

function anthropicPauseEvents() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } },
    { type: 'content_block_stop', index: 0 },
    // `pause_turn` 是「服务端工具把它暂停了，接着跑还能跑」，**不是正常结束**。
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
}

/** 一段带签名的思考：签名**分两片**发，「一个字符都不许丢」正是在验这个。 */
const THINKING_SIGNATURE = 'mock-signature-0123456789abcdef'
const THINKING_TEXT = 'MOCK-THOUGHT'

function anthropicSignedThinkingEvents() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_TEXT } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: THINKING_SIGNATURE.slice(0, 12) },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: THINKING_SIGNATURE.slice(12) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'PONG' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
}

/** 装成「中间有个东西挡着」：HTML 而不是 API 回复。 */
const HTML_PAGE = [
  '<!DOCTYPE html>',
  '<html><head><title>Sign in</title></head>',
  '<body><h1>Please sign in to continue</h1>',
  '<form action="/login" method="post"><input name="user"><input name="pass" type="password"></form>',
  '</body></html>',
].join('\n')

function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

/** 收集请求体。 */
function readBody(request) {
  return new Promise((resolve) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => resolve(raw))
  })
}

/** 上游看见的那把 key（两种方言都认）。 */
function seenKey(request) {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7)
  const direct = request.headers['x-api-key']
  return typeof direct === 'string' ? direct : ''
}

/**
 * 鉴权：认 `sk-mock-` 开头的任意一把。
 *
 * 原来只认死 `sk-mock-secret` 一把 —— 那样每个账号在上游眼里长得一模一样，
 * 「这次是谁答的」就永远问不出来。放开前缀之后，验收可以给不同账号配不同的 key，
 * 用 `mock-whoami` 把答案带回调用方。
 */
function anthropicAuthorised(request) {
  return seenKey(request).startsWith('sk-mock-')
}

/** OpenAI 方言的鉴权：`Authorization: Bearer`。 */
function openaiAuthorised(request) {
  return request.headers.authorization?.startsWith('Bearer sk-mock-') === true
}

/** 同一个模型名在两种方言里都表现一样：先答，答不上就装成「中间有个东西挡着」。 */
function awkwardReply(model, response) {
  if (model === 'mock-html-page') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(HTML_PAGE)
    return true
  }
  if (model === 'mock-cf-403') {
    response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
    response.end(HTML_PAGE)
    return true
  }
  // W3-1：429，但上游自己说「一周后再来」。我们要**只信一小时**（magpie #147：
  // 一个 21:34 才恢复的账号被原样照做，于是被试、被拒、又被停，三轮都没等到）。
  if (model === 'mock-429-week') {
    const text = JSON.stringify({ error: { message: 'Rate limit exceeded, come back next week' } })
    response.writeHead(429, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'retry-after': '604800',
    })
    response.end(text)
    return true
  }
  // W3-2：同样是 429，但说的是「余额不足」。只看状态码那只是一次限流；
  // 该等的是有人充钱，而且没有余额的账号没有哪个模型是好的（罚整个账号）。
  if (model === 'mock-credit') {
    json(response, 429, { error: { message: '余额不足或无可用资源包，请充值' } })
    return true
  }
  return false
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const path = url.pathname.replace(/\/+$/, '')

  // 每一笔请求都留一行：验收出问题时，「谁问了什么」比任何猜测都值钱。
  const stamp = new Date().toISOString().slice(11, 23)
  const note = (extra) =>
    console.log(`[mock ${stamp}] ${request.method} ${path} auth=${seenKey(request) || '-'} ${extra}`)

  if (request.method === 'GET' && path === '/__ready') {
    // 就绪探针：编排器要能在起宿主之前确定这个端口已经在听，而不是靠 sleep 赌。
    return json(response, 200, { ready: true, models: [...MODELS, ...OPENAI_ONLY, ...ANTHROPIC_ONLY] })
  }

  // 「我们到底发了什么」：最近 50 笔的原文。探针按提示词里的标记找回自己那一笔。
  if (path === '/__requests') {
    if (request.method === 'DELETE') {
      const cleared = REQUEST_LOG.length
      REQUEST_LOG.length = 0
      return json(response, 200, { cleared })
    }
    if (request.method === 'GET') return json(response, 200, { count: REQUEST_LOG.length, requests: REQUEST_LOG })
    return json(response, 405, { error: { message: 'use GET or DELETE' } })
  }

  if (request.method === 'GET' && path.endsWith('/models')) {
    const anthropic = path.includes('/anthropic/')
    if (anthropic ? !anthropicAuthorised(request) : !openaiAuthorised(request)) {
      return json(response, 401, { error: { message: 'invalid api key' } })
    }
    // 「image-only」是个只出图的模型：目录里有它，但不该出现在选择器里。
    // 两个单方言模型声明收图：宿主的 `projectImagesForTextModel` 只对「不收图的模型」把
    // 图片换成占位文字，形状检查要看的是**我们自己**怎么翻译图片，所以这两个必须收图。
    const data = catalogFor(anthropic).map((id) => {
      if (id === 'mock-image-only') return { id, architecture: { input_modalities: ['text'], output_modalities: ['image'] } }
      if (OPENAI_ONLY.includes(id) || ANTHROPIC_ONLY.includes(id)) {
        return { id, context_length: 64_000, name: id.toUpperCase(), architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }
      }
      return { id, context_length: 64_000, name: id.toUpperCase() }
    })
    return json(response, 200, { object: 'list', data })
  }

  if (request.method === 'POST' && path.endsWith('/chat/completions')) {
    if (!openaiAuthorised(request)) {
      note('chat 401 (bad key)')
      return json(response, 401, { error: { message: 'invalid api key' } })
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    note(`chat model=${body.model} stream_options=${body.stream_options ? 'yes' : 'no'}`)
    remember(request, path, body)
    // 装成「中间有个东西挡着」的模型要**排在最前面**：它演的是「请求根本没到模型」，
    // 而 stream_options / cache_control 那几条是「我们发错了字段」，两者互斥。
    // 摆错顺序的代价是实测过一次的：HTML 那条路永远走不到，验收看起来像产品坏了。
    if (awkwardReply(body.model, response)) return undefined
    if (body.stream_options) {
      return json(response, 400, { error: { message: 'unknown field stream_options' } })
    }
    if (JSON.stringify(body).includes('cache_control')) {
      return json(response, 400, { error: { message: 'unknown field cache_control' } })
    }
    if (!ADVERTISED.has(body.model)) {
      return json(response, 404, { error: { message: `no such model ${body.model}` } })
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (body.model === 'claude-mock-hold' && holdHits++ === 0) {
      for (const event of holdChunksOpenAI()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      return response.end()
    }
    if (body.model === 'mock-tool-call') {
      for (const event of chatToolCallChunks()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.write('data: [DONE]\n\n')
      return response.end()
    }
    if (body.model === 'mock-usage-zero') {
      for (const event of chatUsageZeroChunks()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.write('data: [DONE]\n\n')
      return response.end()
    }
    if (body.model === 'mock-cut-short') {
      for (const event of chatCutShortChunks()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.write('data: [DONE]\n\n')
      return response.end()
    }
    const chatReply = body.model === 'mock-whoami' ? `PONG ${seenKey(request)}` : 'PONG'
    const cached = cacheReadFor(body)
    note(`chat cached=${cacheFieldOf(false)}=${cached}`)
    for (const event of chatChunks(chatReply, cached)) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.write('data: [DONE]\n\n')
    return response.end()
  }

  if (request.method === 'POST' && path.endsWith('/messages')) {
    if (!anthropicAuthorised(request)) return json(response, 401, { error: { message: 'invalid api key' } })
    const body = JSON.parse((await readBody(request)) || '{}')
    note(`messages model=${body.model}`)
    remember(request, path, body)
    // 与 chat 那条同理：装「被挡住」的模型先答，其余检查才轮到。
    if (awkwardReply(body.model, response)) return undefined
    if (JSON.stringify(body).includes('cache_control')) {
      return json(response, 400, { error: { message: 'unknown field cache_control' } })
    }
    if (JSON.stringify(body).includes('Claude Code')) {
      return json(response, 400, { error: { message: 'unexpected identity block' } })
    }
    if (!ADVERTISED.has(body.model)) {
      return json(response, 404, { error: { message: `no such model ${body.model}` } })
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (body.model === 'claude-mock-hold' && holdHits++ === 0) {
      for (const event of holdEventsAnthropic()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      return response.end()
    }
    if (body.model === 'mock-tool-call') {
      for (const event of anthropicToolCallEvents()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      return response.end()
    }
    if (body.model === 'mock-usage-zero') {
      for (const event of anthropicUsageZeroEvents()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      return response.end()
    }
    if (body.model === 'mock-cut-short') {
      for (const event of anthropicPauseEvents()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      return response.end()
    }
    if (body.model === 'mock-signed-thinking') {
      for (const event of anthropicSignedThinkingEvents()) response.write(`data: ${JSON.stringify(event)}\n\n`)
      return response.end()
    }
    // 刻意**不发 `event:` 行**：这是自建中转很常见的样子。
    const messagesReply = body.model === 'mock-whoami' ? `PONG ${seenKey(request)}` : 'PONG'
    const cached = cacheReadFor(body)
    note(`messages cached=${cacheFieldOf(true)}=${cached}`)
    for (const event of anthropicEvents(messagesReply, cached, body.model === 'mock-unknown-stop' ? 'something_new' : 'end_turn')) response.write(`data: ${JSON.stringify(event)}\n\n`)
    return response.end()
  }

  return json(response, 404, { error: { message: `no route for ${request.method} ${path}` } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LISTENING ${server.address().port}`)
})
