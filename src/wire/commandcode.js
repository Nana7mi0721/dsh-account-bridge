/**
 * CommandCode 的三套传输的**纯函数**部分。
 *
 * 上游 `api.commandcode.ai` 同时提供三套 API，形状互不兼容，必须按模型选：
 *
 * 1. `/alpha/generate` —— 官方 CLI 的私有信封（协议号 `cli`）。`params.messages`
 *    是命令码自己的 part 数组（`{type:'text'|'reasoning'|'tool-call'}` /
 *    `role:'tool'` 的 `{type:'tool-result'}`），不是 OpenAI 也不是 Anthropic 形状；
 * 2. `/provider/v1/chat/completions` —— OpenAI 兼容；
 * 3. `/provider/v1/messages` —— Anthropic Messages 形状，**Claude 系模型唯一可用的
 *    Provider API 路由**（打错端点上游回 400，而不是自动改道）。
 *
 * 这个模块里只有「把 DSH 的东西翻译成线上形状」与「把线上形状翻译回 chunk」，
 * 没有网络、没有缓存、没有重试——那些在 `families/commandcode.js`。这样协商
 * 规则（`resolveProtocol` / `routingMismatch`）才能被单独测。
 *
 * 三条容易踩的线（都来自上游源码与协议文档，已逐条核对）：
 * - **`max_tokens` 有全局上限**：实测 200 000 与 200 704 分别是 200 与 400，
 *   且这个上限**与模型窗口无关**（1M 窗口的模型一样 400）。所以 CLI 传输按
 *   上游的 131 072 收口，messages 传输未知上限时按 64 000 收口。
 * - **不支持 `stop` 序列**：带上就是报错，所以这里从不发。
 * - **`temperature` 在 messages 传输上从不发**：adaptive thinking 只允许 1，
 *   上游对带 0.3 的请求一律 400——是端点废掉了这个参数，不是我们忘了带。
 * @module dsh-account-bridge/wire/commandcode
 */

import { randomUUID } from 'node:crypto'
import { translateAnthropicStream } from './anthropic.js'
import { readSse } from './sse.js'
import { mergeUsageNonZero } from './usage.js'

export const DEFAULT_API_BASE = 'https://api.commandcode.ai'
export const GENERATE_PATH = '/alpha/generate'
export const CHAT_PATH = '/provider/v1/chat/completions'
export const MESSAGES_PATH = '/provider/v1/messages'
export const MODELS_PATH = '/provider/v1/models'
export const WHOAMI_PATH = '/alpha/whoami'
export const CREDITS_PATH = '/alpha/billing/credits'

/** 三套传输的协议号。字面量与上游 `CommandCodeProtocol` 一致。 */
export const PROTOCOLS = ['cli', 'openai', 'messages']

/**
 * 身份编码：上游每个请求都带，禁用压缩。
 *
 * 这条不是优化而是**行为开关**：上游把客户端标识当作协议协商的一部分，
 * 认不出的客户端会走另一条（更差）的路径。所以三套传输都照抄。
 */
export const IDENTITY_ENCODING_HEADER = { 'accept-encoding': 'identity' }

/** 零数据留存开关。账号级 opt-in；一旦开了，遇到 422 **不许摘掉头重试**。 */
export const ZDR_HEADER = { 'x-cmd-zdr': '1' }

/**
 * 兜底的 CLI 版本号（上游 `COMMAND_CODE_CLI_VERSION`，adapter.ts:75）。
 *
 * 上游每个 CLI 面请求都带它，所以不发反而更不像官方客户端。它是个会过期的
 * **抄来**的常量，因此可覆盖：账号的 `auth.cliVersion` → `ctx.config.commandcodeClientVersion`
 * → 这个值。上游文档里写的 1.68.0 是旧值，源码是 1.79.1，以源码为准。
 */
export const DEFAULT_CLI_VERSION = '1.79.1'

/**
 * 能挂缓存断点的块类型（上游 `CACHEABLE_BLOCK_TYPES`）。
 *
 * assistant 侧刻意排除 `thinking`/`tool_use`：给它们打断点缓存的是一段
 * 下一轮必然失效的前缀，白花钱。
 */
const CACHEABLE_PART_TYPES = new Set(['text', 'image', 'tool_result'])

/** CLI 传输的请求体预算（上游 `DEFAULT_GENERATE_MAX_TOKENS`）。 */
export const DEFAULT_GENERATE_MAX_TOKENS = 131_072
/** `/provider/v1/messages` 未知模型上限时的收口（上游 `DEFAULT_MESSAGES_MAX_TOKENS`）。 */
export const DEFAULT_MESSAGES_MAX_TOKENS = 64_000
/** 目录不公布 `max_output_tokens`，这是兜底窗口（上限未知时宁可小不要大）。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/**
 * 未知上限**且传输不挑**时用的输出预算。
 *
 * 注意这里**不是** 200 000：那个数字是「服务端会接受多少」，不是「模型能生成
 * 多少」。照窗口下发会把每个请求都撑到被拒（上游 issue #71 就是这个）。
 */
export const DEFAULT_MAX_OUTPUT = DEFAULT_GENERATE_MAX_TOKENS

/** CLI 传输的默认采样温度（上游 `options.temperature ?? 0.3`）。 */
const DEFAULT_TEMPERATURE = 0.3

// ------------------------------------------------------------------ 目录

/**
 * 目录项 → 内部形状。
 *
 * `/provider/v1/models` 回 `{object:'list', data:[{id, name, context_length,
 * supported_endpoints}]}`，**不公布 `max_output_tokens`**，所以输出上限只能
 * 靠传输默认值兜底；`supported_endpoints` 是路由的权威依据。
 */
export function parseCatalog(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  const models = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' && row.id.length > 0 ? row.id : undefined
    if (id === undefined) continue
    const name = typeof row?.name === 'string' && row.name.length > 0 ? row.name : id
    const contextWindow = positive(row?.context_length) ?? positive(row?.contextWindow) ?? undefined
    models.push({
      id,
      name,
      contextWindow,
      // 目录目前**不公布** `max_output_tokens`（所以通常落到传输默认值）；
      // 公布了就照用——上游 `normalizeModel` 也是这么读的。
      maxOutput: positive(row?.max_output_tokens) ?? positive(row?.maxOutput) ?? undefined,
      supportedEndpoints: Array.isArray(row?.supported_endpoints)
        ? row.supported_endpoints.filter((item) => typeof item === 'string')
        : [],
    })
  }
  return models
}

/**
 * 目录不公布 effort 档位，所以**不声明 `reasoning.efforts`**：声明了却不能拨，
 * 比不声明更糟（面板会出现一个拨了没反应的开关）。`effort` 仍然透传，
 * 因为 messages 传输的 `output_config.effort` 由上游校验。
 */
export function modelInfo(id, name, entry, provider) {
  return {
    provider,
    id,
    name: name ?? id,
    context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    defaultMaxTokens: outputBudgetFor(id, entry, undefined),
    toolUpdate: 'in-history',
    inputModalities: ['text', 'image'],
  }
}

/**
 * 一次请求的输出预算。
 *
 * 三层取小：host 给的 `maxTokens` → 目录/学习的每模型上限 → 传输默认值。
 * `messages` 传输在**上限未知时**更保守（64 000）：它的拒绝是按模型上限来的，
 * 猜大一次就废掉整个请求。
 */
export function outputBudget(maxTokens, protocol, ceiling) {
  const requested = positive(maxTokens) ?? Number.POSITIVE_INFINITY
  const known = positive(ceiling) ?? (protocol === 'messages' ? DEFAULT_MESSAGES_MAX_TOKENS : DEFAULT_GENERATE_MAX_TOKENS)
  return Math.max(1, Math.min(requested, known, DEFAULT_GENERATE_MAX_TOKENS))
}

/** 目录项 + 传输 → 输出预算（`modelInfo` 与 `stream` 共用同一套规则）。 */
function outputBudgetFor(id, entry, known) {
  return outputBudget(entry?.maxOutput ?? known, requiresMessages(id, entry) ? 'messages' : 'openai')
}

/** 目录里的模型 → 是否只能走 `/provider/v1/messages`。 */
export function requiresMessages(id, entry) {
  const endpoints = Array.isArray(entry?.supportedEndpoints) ? entry.supportedEndpoints : []
  if (endpoints.length > 0) return endpoints.includes('/messages')
  // 目录项没有路由表时用前缀兜底——上游 `requiresMessagesEndpoint()` 的原话。
  return typeof id === 'string' && id.startsWith('claude-')
}

// ------------------------------------------------------------------ 协商

/**
 * 一次请求该用哪套传输。
 *
 * 规则（与上游 `resolveProtocol` 等价，但**每次请求都重新按模型算**）：
 * 1. 显式 `auth.protocol` 优先，除了 Claude 系模型的硬否决（见下）；
 * 2. 目录 `supported_endpoints` 是权威；
 * 3. 目录没有这个模型时，`claude-*` 前缀兜底到 messages，其它一律 openai。
 *
 * **为什么不缓存整个账号的决策**：上游 issue #46 —— 决策依赖模型，而缓存键
 * 只有网关+密钥，记住它会把整个账号钉死在一套传输上。这里只记「模型 → 传输」。
 */
export function resolveProtocol({ model, entry, forced } = {}) {
  const messagesOnly = requiresMessages(model, entry)
  // Claude 系在 chat/completions 上是**硬拒绝**（400），不是偏好问题，
  // 所以显式 `openai` 也压不过它；见上游 `resolveProtocol` 的注释。
  if (messagesOnly) return 'messages'
  if (forced === 'cli' || forced === 'openai' || forced === 'messages') return forced
  return 'openai'
}

/**
 * 这个失败是「打错端点」而不是「请求本身有问题」吗？
 *
 * 只有两种证据算数：
 * - 上游点名了**另一套**端点的路由错误（`Model "<id>" must be called via
 *   /provider/v1/messages` / `... is not supported on this endpoint. Use
 *   /provider/v1/chat/completions ...`）；
 * - Go 套餐的 Provider API 闸门（403 `upgrade_required`）——唯一没有 Provider
 *   API 的套餐，此时才允许降到 CLI 传输。
 *
 * 普通 4xx/5xx **一律不算**：把一次 500 或限流当成「换协议」会掩盖真实故障
 * （上游同一条规则：「other 4xx/5xx must surface as ordinary errors」）。
 */
export function routingMismatch(protocol, status, text) {
  const detail = String(text ?? '').toLowerCase()
  if (protocol === 'openai' && status === 400 && /must be called via .*\/messages/.test(detail)) return 'messages'
  if (protocol === 'messages' && status === 400 && /not supported on this endpoint/.test(detail)) return 'openai'
  if (protocol !== 'cli' && status === 403 && isUpgradeRequired(detail)) return 'cli'
  return undefined
}

export function isUpgradeRequired(detail) {
  const text = String(detail ?? '').toLowerCase()
  return (
    text.includes('upgrade_required') ||
    (text.includes('go plan') && text.includes('api access')) ||
    text.includes('only plan without api access') ||
    text.includes('upgrade to goat or higher')
  )
}

// ------------------------------------------------------------------ 请求头

/** 一套传输的 URL。 */
export function endpointOf(apiBase, protocol) {
  const base = typeof apiBase === 'string' && apiBase.length > 0 ? apiBase.replace(/\/+$/, '') : DEFAULT_API_BASE
  if (protocol === 'cli') return `${base}${GENERATE_PATH}`
  if (protocol === 'messages') return `${base}${MESSAGES_PATH}`
  return `${base}${CHAT_PATH}`
}

/**
 * 上游请求头。
 *
 * 上游对三个**面**（surface）发不同的头，这不是风格问题，是它自己的实测分叉
 * （adapter.ts:2112-2140 的 chat 请求、:2503-2515 的账号端点）：
 *
 * - 共用：`Authorization`、`accept-encoding: identity`、以及**按账号开关的** `x-cmd-zdr`。
 * - `cli` 面（`/alpha/generate`）：`x-command-code-version`（有版本才发）、
 *   `x-cli-environment: production`、`x-taste-learning: false`、`x-co-flag: false`。
 *   上游**不发** `x-project-slug`（那是从 CLI 的 workingDir 推的，本插件没有这个概念，
 *   不编一个假的）。
 * - `account` 面（`/alpha/whoami`、`/alpha/usage/summary`、`/alpha/billing/credits`）：
 *   只有版本号 + `x-cli-environment`，**没有** taste/co-flag。
 * - `provider` 面（两套 Provider API + 目录）：只有共用头，上游注释写得很直白——
 *   `x-command-code-version`/`x-cli-environment`「identify the CLI transport, not a
 *   public API client」，所以**故意不带**。GET 目录时显式 `accept: application/json`。
 *
 * `x-cmd-zdr` 是**账号级 opt-in**（上游 `zdr` 默认 false）：它决定请求被路由到哪台上游，
 * 无 ZDR 容量时会 422 `cmd_zdr_no_providers`。所以默认不发；账号一旦开了它，
 * 遇到 422 也**不许摘掉头重试**——那等于把数据偷偷送去留存上游。
 */
export function requestHeaders(
  apiKey,
  { surface = 'provider', cliVersion, json = false, stream = false, zdr = false } = {},
) {
  const headers = {
    authorization: `Bearer ${apiKey ?? ''}`,
    ...IDENTITY_ENCODING_HEADER,
  }
  if (zdr === true) headers['x-cmd-zdr'] = ZDR_HEADER['x-cmd-zdr']
  if (surface === 'cli' || surface === 'account') {
    if (typeof cliVersion === 'string' && cliVersion.length > 0) headers['x-command-code-version'] = cliVersion
    headers['x-cli-environment'] = 'production'
  }
  if (surface === 'cli') {
    headers['x-taste-learning'] = 'false'
    headers['x-co-flag'] = 'false'
  }
  if (stream) headers.accept = 'text/event-stream'
  else if (surface === 'provider') headers.accept = 'application/json'
  if (json) headers['content-type'] = 'application/json'
  return headers
}

// ------------------------------------------------------------------ 请求体

/** 工具 schema 归一：上游根节点必须是 `type: 'object'`，否则整个请求被拒。 */
export function toolSchema(parameters) {
  if (!isRecord(parameters)) return { type: 'object', properties: {}, additionalProperties: true }
  if (parameters.type === 'object') return parameters
  if (Array.isArray(parameters.type) && parameters.type.includes('object')) {
    return { ...parameters, type: 'object' }
  }
  if (parameters.type === undefined || parameters.type === null) {
    return { ...parameters, type: 'object' }
  }
  // 数组/标量根：上游校验只认对象，退化成自由形状，别让整个请求失败。
  return { type: 'object', properties: {}, additionalProperties: true }
}

/** CLI 信封的 `params.tools`（注意是 `name` + `input_schema`，不是 OpenAI 的嵌套形）。 */
export function toCliTools(tools) {
  return (tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    input_schema: toolSchema(tool.parameters),
  }))
}

/** OpenAI 传输的 `tools`（`function` 嵌套形）。 */
export function toOpenAiTools(tools) {
  return (tools ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: toolSchema(tool.parameters) },
  }))
}

/** 从 UI 的 system 参数里取出纯文本（DSH 传字符串，防御性认块数组）。 */
export function systemTextOf(system) {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .filter((block) => typeof block?.text === 'string')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

/** CLI 信封的 `params.system`：空字符串或一个带缓存断点的块数组。 */
export function toCliSystem(system) {
  const text = systemTextOf(system)
  if (text.length === 0) return ''
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
}

/**
 * 只回放**带配对工具结果**的工具调用。
 *
 * 两种传输都遵守这条（上游原话）：孤立的 tool-call 回放上去会被上游拒绝，
 * 而 DSH 的会话里真会出现中间被截断的轮次。
 */
export function pairedToolCalls(messages) {
  const withResults = new Set()
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') withResults.add(block.toolCallId)
    }
  }
  return withResults
}

const recordOrEmpty = (value) => {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * DSH 会话 → CLI 信封的 `params.messages`。
 *
 * 形状（命令码 CLI 的 `toWireMessages`，v1.54.0 起）：
 * - `{role:'user', content:[{type:'text'}, {type:'image', image:'data:...', mimeType}]}`
 * - `{role:'assistant', content:[{type:'text'}, {type:'reasoning', text},
 *    {type:'tool-call', toolCallId, toolName, input}]}`
 * - `{role:'tool', content:[{type:'tool-result', toolCallId, toolName, output:{type:'text'|'error-text', value}}]}`
 *
 * 历史推理**要**按内容顺序回放（`{type:'reasoning'}` part）：DeepSeek 的 thinking
 * 契约要求所有带工具调用的轮次把上一轮思维链带回去（上游 issue #34），
 * 而 v1.54.0 之前的「丢弃推理」行为已被明确禁止回退。
 */
export function toCliMessages(messages) {
  const paired = pairedToolCalls(messages)
  const out = []
  for (const message of messages ?? []) {
    const blocks = message?.content
    if (message?.role === 'system') continue // 已经折进 params.system
    if (message?.role === 'user') {
      const result = blocks?.find((block) => block?.type === 'tool-result')
      const parts = []
      for (const block of blocks ?? []) {
        if (block?.type === 'text' && block.text !== '') parts.push({ type: 'text', text: block.text })
        else if (block?.type === 'image') {
          const url = dataUrlOf(block)
          if (url !== undefined) parts.push({ type: 'image', image: url, mimeType: mediaTypeOf(block) ?? 'image/png' })
        }
      }
      // 工具结果在 DSH 里也走 user 角色，但线上是独立的 `role:'tool'` 消息。
      if (result !== undefined) {
        out.push(toCliToolResult(result, message))
        continue
      }
      if (parts.length > 0) out.push({ role: 'user', content: parts })
      continue
    }
    if (message?.role === 'assistant') {
      const parts = []
      for (const block of blocks ?? []) {
        if (block?.type === 'text' && block.text !== '') parts.push({ type: 'text', text: block.text })
        else if (block?.type === 'reasoning' && block.text !== '') parts.push({ type: 'reasoning', text: block.text })
        else if (block?.type === 'tool-call' && paired.has(block.id)) {
          parts.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, input: recordOrEmpty(block.arguments) })
        }
      }
      if (parts.length > 0) out.push({ role: 'assistant', content: parts })
      continue
    }
    // 非 user 角色但带 tool-result 的（DSH 也可能这么排）：照样翻译。
    const result = blocks?.find((block) => block?.type === 'tool-result')
    if (result !== undefined) out.push(toCliToolResult(result, message))
  }
  return out
}

function toCliToolResult(block, message) {
  const value = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: block.toolCallId,
        toolName: block.toolName ?? message?.name ?? 'unknown',
        output: block.isError === true ? { type: 'error-text', value } : { type: 'text', value },
      },
    ],
  }
}

/** OpenAI 传输的 `messages`：历史推理用 `reasoning_content` 回放。 */
export function toOpenAiMessages(messages) {
  const paired = pairedToolCalls(messages)
  const out = []
  for (const message of messages ?? []) {
    if (message?.role === 'system') continue
    if (message?.role === 'user') {
      const result = message.content?.find((block) => block?.type === 'tool-result')
      if (result !== undefined) {
        out.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? ''),
        })
        continue
      }
      const parts = []
      for (const block of message.content ?? []) {
        if (block?.type === 'text' && block.text !== '') parts.push({ type: 'text', text: block.text })
        else if (block?.type === 'image') {
          const url = dataUrlOf(block)
          if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
        }
      }
      if (parts.length === 1 && parts[0].type === 'text') out.push({ role: 'user', content: parts[0].text })
      else if (parts.length > 0) out.push({ role: 'user', content: parts })
      continue
    }
    if (message?.role === 'assistant') {
      const text = (message.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
      const reasoning = (message.content ?? []).filter((b) => b?.type === 'reasoning').map((b) => b.text).join('')
      const toolCalls = (message.content ?? [])
        .filter((block) => block?.type === 'tool-call' && paired.has(block.id))
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) },
        }))
      if (text === '' && reasoning === '' && toolCalls.length === 0) continue
      const assistant = { role: 'assistant', content: text === '' ? null : text }
      if (reasoning !== '') assistant.reasoning_content = reasoning
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      out.push(assistant)
      continue
    }
    const result = message?.content?.find((block) => block?.type === 'tool-result')
    if (result !== undefined) {
      out.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? ''),
      })
    }
  }
  return out
}

/**
 * Anthropic 传输的 `messages`。
 *
 * 这里**不**复用 `wire/anthropic.js` 的 `toAnthropicMessages`：那个函数按
 * Claude Code 的会话形状写（system 单独走顶层、工具结果单列），而 DSH 给的是
 * 同一份通用块列表，直接用会把 `reasoning` 块整块丢掉——而 messages 传输恰恰
 * 是唯一必须回放 thinking 的传输。
 */
export function toMessagesMessages(messages) {
  const paired = pairedToolCalls(messages)
  const out = []
  for (const message of messages ?? []) {
    if (message?.role === 'system') continue
    if (message?.role === 'user') {
      const parts = []
      for (const block of message.content ?? []) {
        if (block?.type === 'text' && block.text !== '') parts.push({ type: 'text', text: block.text })
        else if (block?.type === 'image') {
          const data = base64Of(block)
          if (data !== undefined) {
            parts.push({ type: 'image', source: { type: 'base64', media_type: mediaTypeOf(block) ?? 'image/png', data } })
          }
        } else if (block?.type === 'tool-result') {
          parts.push({
            type: 'tool_result',
            tool_use_id: block.toolCallId,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
            ...(block.isError === true ? { is_error: true } : {}),
          })
        }
      }
      if (parts.length > 0) out.push({ role: 'user', content: parts })
      continue
    }
    if (message?.role === 'assistant') {
      const parts = []
      for (const block of message.content ?? []) {
        if (block?.type === 'text' && block.text !== '') parts.push({ type: 'text', text: block.text })
        else if (block?.type === 'reasoning' && block.text !== '') {
          // ★ 实测契约：回放的 `thinking` 块**必须带 `signature`**，否则端点回
          // `thinking.signature: Field required`；而**省略**它是被接受的（实测两条路
          // 都是 200）。DSH 的块形状里没有签名，所以拿不到签名就丢掉——照抄文本
          // 会把整个请求打挂。
          const signature = typeof block.signature === 'string' && block.signature !== '' ? block.signature : undefined
          if (signature !== undefined) parts.push({ type: 'thinking', thinking: block.text, signature })
        } else if (block?.type === 'tool-call' && paired.has(block.id)) {
          parts.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: recordOrEmpty(block.arguments),
          })
        }
      }
      if (parts.length > 0) out.push({ role: 'assistant', content: parts })
      continue
    }
    const parts = []
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool-result') {
        parts.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          ...(block.isError === true ? { is_error: true } : {}),
        })
      }
    }
    if (parts.length > 0) out.push({ role: 'user', content: parts })
  }
  // 第三个 ephemeral 缓存断点：**最后一条消息**的最后一块，且它必须是 user 轮
  // （上游只认收尾那一轮，不往前找；assistant 的 text/image/tool_result 之外的类型
  // 一律不打——`thinking`/`tool_use` 块缓存的是一段下一轮必然失效的前缀）。
  const tail = out[out.length - 1]
  const lastPart = Array.isArray(tail?.content) ? tail.content[tail.content.length - 1] : undefined
  if (tail?.role === 'user' && CACHEABLE_PART_TYPES.has(lastPart?.type)) {
    lastPart.cache_control = { type: 'ephemeral' }
  }
  return out
}

/**
 * 三套传输的请求体。
 *
 * 共同点：`stream: true` 恒开（本插件只做流式），**从不发 `stop`**（上游不支持），
 * 从不发 `temperature` 到 messages（adaptive thinking 只允许 1）。
 */
export function buildBody({ protocol, model, messages, tools, system, maxTokens, effort, temperature, sessionId, ceiling }) {
  const limit = outputBudget(maxTokens, protocol, ceiling)
  if (protocol === 'cli') {
    return {
      config: {
        workingDir: process.cwd(),
        date: new Date().toISOString().slice(0, 10),
        environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
        structure: [],
        isGitRepo: false,
        currentBranch: '',
        mainBranch: '',
        gitStatus: '',
        recentCommits: [],
      },
      memory: null,
      taste: null,
      skills: null,
      // 官方 CLI 的 `toWirePermissionMode()` 把缺省/`default` 归一成 `standard`。
      permissionMode: 'standard',
      params: {
        model,
        messages: toCliMessages(messages),
        tools: toCliTools(tools),
        system: toCliSystem(system),
        max_tokens: limit,
        temperature: typeof temperature === 'number' ? temperature : DEFAULT_TEMPERATURE,
        stream: true,
        ...(effort ? { reasoning_effort: effort } : {}),
      },
      threadId: threadIdOf(sessionId),
    }
  }
  const text = systemTextOf(system)
  if (protocol === 'messages') {
    const body = {
      model,
      max_tokens: limit,
      stream: true,
      messages: toMessagesMessages(messages),
    }
    const toolList = toOpenAiTools(tools).map(({ type: _type, function: fn }) => ({
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters,
    }))
    if (text.length > 0) body.system = [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
    if (toolList.length > 0) {
      // 第三个缓存断点：最后一个工具声明（上游三个断点里的第二个）。
      toolList[toolList.length - 1].cache_control = { type: 'ephemeral' }
      body.tools = toolList
    }
    // `thinking` 只接受 `{type:'adaptive'}`，且只在模型真能拨档时才发；
    // `output_config.effort` 有值就带上（上游校验取值）。
    if (effort) body.output_config = { effort }
    return body
  }
  const chatMessages = toOpenAiMessages(messages)
  return {
    model,
    messages: text.length > 0 ? [{ role: 'system', content: text }, ...chatMessages] : chatMessages,
    ...(Array.isArray(tools) && tools.length > 0 ? { tools: toOpenAiTools(tools), tool_choice: 'auto' } : {}),
    max_tokens: limit,
    temperature: typeof temperature === 'number' ? temperature : DEFAULT_TEMPERATURE,
    stream: true,
    // 刻意**不发** `stream_options: {include_usage:true}`：上游实测的请求体里没有它，
    // 而这是个私有网关——没被验证过的字段就是风险。网关真发了 usage 分片我们照样读
    // （见 handleOpenAiEvent），没发就不报，绝不自己编一份用量。
    ...(effort ? { reasoning_effort: effort } : {}),
  }
}

/**
 * CLI 信封的 `threadId` 必须是 UUID 形状。
 *
 * 上游把会话 id 哈希成 UUIDv5 以便「同一会话同一 thread」；本插件是账号级反代，
 * host 会不会给稳定 id 不由我们决定，给不出就每轮一个（服务端只当它是关联键）。
 */
export function threadIdOf(sessionId) {
  if (typeof sessionId === 'string' && UUID_PATTERN.test(sessionId)) return sessionId
  return randomUUID()
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ------------------------------------------------------------------ 流解析

/**
 * 一行 → 一个事件。
 *
 * 三套传输在线上**是同一种行格式**：每行一个 JSON，可能带 `data:` 前缀
 * （OpenAI/Anthropic 的 SSE），也可能是裸 JSON（CLI 的 JSONL）。所以一个
 * 解析器就够，不需要按协议分家。
 */
export function parseStreamLine(line) {
  let trimmed = String(line ?? '').trim()
  if (trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return { type: 'ignored' }
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim()
  if (trimmed === '' || trimmed === '[DONE]') return { type: 'done' }
  try {
    return { type: 'event', event: JSON.parse(trimmed) }
  } catch {
    // 心跳/半行不该炸掉整条流；上游同样是「跳过无法解析的行」。
    return { type: 'ignored' }
  }
}

/**
 * 线上 usage → DSH 的（**不相交**）计数。
 *
 * OpenAI 形状的 `prompt_tokens` 含缓存读取与缓存写入，DSH 的 `inputTokens`
 * 只算未缓存的输入，所以必须减掉，否则面板显示重复计费。
 */
export function normaliseUsage(usage) {
  if (!isRecord(usage)) return undefined
  const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined
  const total = positive0(usage.inputTokens) ?? positive0(usage.prompt_tokens)
  const cacheRead = positive0(details?.cacheReadTokens) ?? positive0(promptDetails?.cached_tokens) ?? 0
  const cacheWrite =
    positive0(details?.cacheWriteTokens) ??
    positive0(promptDetails?.cache_creation_input_tokens) ??
    positive0(usage.cacheWriteTokens) ??
    0
  const outputTokens = positive0(usage.outputTokens) ?? positive0(usage.completion_tokens)
  if (total === undefined && outputTokens === undefined && cacheRead === 0 && cacheWrite === 0) return undefined
  const out = {
    inputTokens: Math.max(0, (total ?? 0) - cacheRead - cacheWrite),
    outputTokens: outputTokens ?? 0,
  }
  if (cacheRead > 0) out.cachedInputTokens = cacheRead
  if (cacheWrite > 0) out.cacheCreationInputTokens = cacheWrite
  return out
}

/** 结束原因 → 契约里的三个值之一。认不出的按 `stop`（最保守，不谎报工具调用）。 */
export function finishKind(reason) {
  const value = typeof reason === 'string' ? reason.toLowerCase() : ''
  if (value === 'tool-calls' || value === 'tool_calls' || value === 'tool_use') return 'tool-calls'
  if (value === 'length' || value === 'max_tokens' || value === 'max-tokens' || value === 'max_output_tokens') return 'max-tokens'
  return 'stop'
}

/**
 * 空回答判定。
 *
 * 契约（§5.2）与上游一致：只有推理、空文本、纯空白、`tool_calls: []` **都不算
 * 回答**——thinking 模型经常整轮只在思考，那是一次失败的重试，不是空回复。
 * 块允许先发出去（面板要显示思考过程），但不允许发 `finish`。
 */
export class StreamAssembler {
  #nextIndex = 0
  #text
  #reasoning
  #produced = false
  #cacheWrite
  #finishReason
  #usage
  /** OpenAI 传输的工具调用分片槽（`tool_calls[].index` → 缓冲）。 */
  #slots = new Map()

  /** 有没有产出过**算数**的内容（正文或工具调用）。 */
  get produced() {
    return this.#produced
  }

  get finishReason() {
    return this.#finishReason
  }

  /** 独立事件形式的缓存写入计数（CLI 传输的 `cache-write-tokens`）。 */
  set cacheWriteTokens(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) this.#cacheWrite = value
  }

  get cacheWriteTokens() {
    return this.#cacheWrite
  }

  /** `finish` 已经算好的 usage（翻译层要在 finish **之前**补发它）。 */
  get usage() {
    return this.#usage
  }

  #open(type) {
    const index = this.#nextIndex++
    const state = { index, type, text: '', id: '', name: '', args: '' }
    if (type === 'text') this.#text = state
    else if (type === 'reasoning') this.#reasoning = state
    return state
  }

  #closeText() {
    const state = this.#text
    if (state === undefined) return []
    this.#text = undefined
    return [{ type: 'block-end', index: state.index, block: { type: 'text', text: state.text } }]
  }

  #closeReasoning() {
    const state = this.#reasoning
    if (state === undefined) return []
    this.#reasoning = undefined
    return [{ type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } }]
  }

  text(delta) {
    const chunks = this.#closeReasoning()
    if (this.#text === undefined) {
      const state = this.#open('text')
      chunks.push({ type: 'block-start', index: state.index, blockType: 'text' })
    }
    const value = String(delta ?? '')
    this.#text.text += value
    if (value.trim() !== '') this.#produced = true
    chunks.push({ type: 'text-delta', index: this.#text.index, text: value })
    return chunks
  }

  reasoning(delta) {
    const chunks = this.#closeText()
    if (this.#reasoning === undefined) {
      const state = this.#open('reasoning')
      chunks.push({ type: 'block-start', index: state.index, blockType: 'reasoning' })
    }
    this.#reasoning.text += String(delta ?? '')
    chunks.push({ type: 'reasoning-delta', index: this.#reasoning.index, text: String(delta ?? '') })
    return chunks
  }

  /** 一个完整的工具调用（CLI 与 Anthropic 传输都是「一次给全」，没有增量）。 */
  toolCall({ id, name, args }) {
    const chunks = [...this.#closeText(), ...this.#closeReasoning()]
    const state = this.#open('tool-call')
    state.id = typeof id === 'string' && id.length > 0 ? id : randomUUID()
    state.name = typeof name === 'string' && name.length > 0 ? name : 'unknown'
    state.args = typeof args === 'string' && args.length > 0 ? args : JSON.stringify(recordOrEmpty(args))
    this.#produced = true
    chunks.push(
      { type: 'block-start', index: state.index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta: state.args },
      { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args } },
    )
    return chunks
  }

  /** OpenAI 传输的分片槽：同一个 `index` 的 fragment 攒进同一个缓冲。 */
  openAiTool(slot) {
    let buffer = this.#slots.get(slot)
    if (buffer === undefined) {
      buffer = { id: '', name: '', args: '' }
      this.#slots.set(slot, buffer)
    }
    return buffer
  }

  /** 取走攒好的工具调用（按上游 `index` 升序），清空槽。 */
  takeOpenAiTools() {
    const calls = [...this.#slots.entries()].sort((a, b) => a[0] - b[0]).map(([, buffer]) => buffer)
    this.#slots.clear()
    return calls
  }

  /**
   * 结束：收尾所有打开的块，给 usage 与 finish。
   *
   * usage 只有在**确有内容**时才发 `finish`——调用方负责在 `produced` 为假时
   * 改抛 `EMPTY_RESPONSE`（纯思考不算回答）。
   */
  finish(reason, usage) {
    const chunks = [...this.#closeText(), ...this.#closeReasoning()]
    const normalised = normaliseUsage(usage)
    // 缓存写入在 CLI 传输上是独立事件；只有 finish 里没报时才用它兜底。
    const merged =
      normalised !== undefined && (normalised.cacheCreationInputTokens ?? 0) === 0 && this.#cacheWrite !== undefined
        ? { ...normalised, cacheCreationInputTokens: this.#cacheWrite }
        : normalised
    this.#finishReason = finishKind(reason)
    this.#usage = merged
    if (merged !== undefined) chunks.push({ type: 'usage', usage: merged })
    chunks.push({ type: 'finish', reason: { kind: this.#finishReason } })
    return chunks
  }

  /** 只收尾思考块（CLI 的 `reasoning-end`），不发 finish。 */
  closeReasoning() {
    return this.#closeReasoning()
  }
}

// ------------------------------------------------------------------ 传输翻译

/**
 * 把一条响应体翻译成契约 chunk。
 *
 * 三套传输共用一个读循环（都是「一行一个 JSON」），按协议分派到不同的
 * 事件处理器；`messages` 直接复用 `wire/anthropic.js` 的翻译器，因为线上
 * 形状就是 Anthropic 的事件流。
 */
export async function* translateCommandCodeStream(response, protocol, { signal, onDiagnostic, model } = {}) {
  if (protocol === 'messages') {
    // 这条传输线上就是 Anthropic 的事件流，诊断也一并转交。
    yield* translateAnthropicStream(response, { signal, onDiagnostic, model })
    return
  }
  const assembler = new StreamAssembler()
  let finished = false
  // 独立的 usage 包（OpenAI 传输会在 `[DONE]` 前单独发一个）**不能丢**：
  // finish 包里也不一定有 usage。攒起来，与 finish 那份合并后只发一帧——
  // 宿主读 usage 是 `this._usage = chunk.usage`，发两帧等于让后者替换前者。
  let earlyUsage
  for await (const frame of readSse(response, { signal })) {
    signal?.throwIfAborted()
    if (finished) break
    const line = parseStreamLine(frame.data)
    if (line.type === 'ignored') continue
    if (line.type === 'done') {
      // `[DONE]` 只是 OpenAI 的终止哨兵：它前面必须已经有过 finish_reason，
      // 否则这个流是断的（下面按断流报）。
      if (protocol === 'openai') break
      continue
    }
    if (!isRecord(line.event)) continue
    if (event_error(line.event) !== undefined) {
      // 上游把中途失败塞在 SSE 包的 `error` 成员里；忽略它会让整条流
      // 「没有 finish 就结束」，真正的原因（超窗/额度）就丢了。
      throw streamEventError(line.event.error, line.event.message)
    }
    const chunks = protocol === 'cli' ? handleCliEvent(assembler, line.event) : handleOpenAiEvent(assembler, line.event)
    for (const chunk of chunks) {
      // usage 一律由 assembler 统一在 finish 前补发（CLI 传输的缓存写入是独立
      // 事件，要等它到齐才准，所以不能信任早到的那份 usage）。
      if (chunk.type === 'usage') {
        earlyUsage = mergeUsageNonZero(earlyUsage, chunk.usage)
        continue
      }
      if (chunk.type === 'finish') {
        finished = true
        if (!assembler.produced) throw emptyResponse('the model finished without producing any content')
        // finish 那份是后到的，非零值以它为准；它没报的字段由早到的那份补上。
        const usage = mergeUsageNonZero(earlyUsage, assembler.usage)
        if (usage !== undefined) yield { type: 'usage', usage }
      }
      yield chunk
    }
  }
  if (finished) return
  // 没有 finish 事件就结束（断流）——不伪造成功，按空响应报。
  throw emptyResponse('the stream ended without a finish event')
}

/** CLI 传输的一个事件。事件名在 `type` 字段里。 */
export function handleCliEvent(assembler, event) {
  switch (event.type) {
    case 'text-delta':
      return assembler.text(event.text)
    case 'reasoning-delta':
      return assembler.reasoning(event.text)
    case 'reasoning-start':
      // 只有「开始思考」时上游会先发它，此时还没有内容。
      return []
    case 'reasoning-end':
      return assembler.closeReasoning()
    case 'tool-call':
      return assembler.toolCall({
        id: event.toolCallId,
        name: event.toolName,
        args: event.input ?? event.args ?? event.arguments,
      })
    case 'tool-result':
      // 工具结果由客户端回填，服务端这里只是回声。
      return []
    case 'cache-write-tokens':
      assembler.cacheWriteTokens = event.cacheWriteTokens
      return []
    case 'finish':
      return assembler.finish(event.finishReason, event.totalUsage)
    case 'error':
      throw streamEventError(event.error, event.message)
    default:
      return []
  }
}

/**
 * OpenAI 兼容传输的一个 SSE 包。
 *
 * 工具调用是**分片**来的（`tool_calls[].index` 分槽、`function.arguments` 逐段
 * 追加），所以这里先攒后发：只有拿到 `finish_reason` 才把攒好的块整块吐出，
 * 保证 chunk 序列永远是「block-start → delta → block-end」的合法序。
 */
export function handleOpenAiEvent(assembler, event) {
  const choices = Array.isArray(event.choices) ? event.choices : []
  if (choices.length === 0) {
    // 独立的 usage 包（有些兼容服务在 `[DONE]` 前单独发它）。
    if (event.usage !== undefined) {
      const usage = normaliseUsage(event.usage)
      if (usage !== undefined) return [{ type: 'usage', usage }]
    }
    return []
  }
  const choice = isRecord(choices[0]) ? choices[0] : {}
  const delta = isRecord(choice.delta) ? choice.delta : {}
  // 思考字段的拼写**按模型家族不同**，网关不做归一：DeepSeek 用标量
  // `reasoning`，GLM/Qwen/Kimi 用 `reasoning_content`，OpenAI 家族把摘要放在
  // `reasoning_details[].summary`。三种都读，漏一种就整族看不到思考过程。
  const reasoning = firstText(delta.reasoning, delta.reasoning_content, reasoningDetailsText(delta.reasoning_details))
  const text = typeof delta.content === 'string' && delta.content !== '' ? delta.content : undefined
  if (Array.isArray(delta.tool_calls)) {
    for (const raw of delta.tool_calls) {
      if (!isRecord(raw)) continue
      const buffer = assembler.openAiTool(Number.isInteger(raw.index) ? raw.index : 0)
      if (typeof raw.id === 'string' && raw.id !== '') buffer.id = raw.id
      if (typeof raw.function?.name === 'string' && raw.function.name !== '') buffer.name = raw.function.name
      if (typeof raw.function?.arguments === 'string') buffer.args += raw.function.arguments
    }
  }
  const reason = choice.finish_reason
  const terminal = typeof reason === 'string' && reason.length > 0
  if (!terminal) {
    // 还没结束：只把正文/推理的增量按到达顺序发出去。
    const chunks = []
    if (reasoning !== undefined) chunks.push(...assembler.reasoning(reasoning))
    if (text !== undefined) chunks.push(...assembler.text(text))
    return chunks
  }
  // 结束了：正文/推理的尾巴先落地，再补工具块，最后 finish。
  const chunks = []
  if (reasoning !== undefined) chunks.push(...assembler.reasoning(reasoning))
  if (text !== undefined) chunks.push(...assembler.text(text))
  for (const call of assembler.takeOpenAiTools()) {
    chunks.push(...assembler.toolCall({ id: call.id, name: call.name, args: call.args }))
  }
  chunks.push(...assembler.finish(reason, event.usage))
  return chunks
}

/** SSE 包里的 `error` 成员（不是字符串 `'error'` 事件名时的那个 error）。 */
function event_error(event) {
  return isRecord(event) && event.error !== undefined && event.error !== null ? event.error : undefined
}

function reasoningDetailsText(details) {
  if (!Array.isArray(details)) return undefined
  for (const entry of details) {
    if (!isRecord(entry)) continue
    const text = firstText(entry.text, entry.summary)
    if (text !== undefined) return text
  }
  return undefined
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

// ------------------------------------------------------------------ 失败

/**
 * 流内 `error` 事件 → 异常。
 *
 * 归类交给调用方（`httpError` 走的是 HTTP 状态，这里没有响应对象），所以
 * 只把上游给的事实（code / status / message）挂到 error 上，由族里的
 * `classifyError` 决定 `error.code`。
 */
export function streamEventError(detail, message) {
  const record = isRecord(detail) ? detail : {}
  const text = String(record.message ?? message ?? (typeof detail === 'string' ? detail : '') ?? '')
  const error = new Error(`commandcode: ${text || 'the upstream reported a stream error'}`)
  error.status = positive0(record.status) ?? undefined
  error.detail = text
  error.upstreamCode = typeof record.code === 'string' ? record.code : typeof record.type === 'string' ? record.type : undefined
  return error
}

/** 一条没有任何内容块的终止流 → 契约 §5.2 的 `EMPTY_RESPONSE`。 */
export function emptyResponse(reason) {
  const error = new Error(`commandcode: ${reason}`)
  error.code = 'EMPTY_RESPONSE'
  error.failure = { code: 'EMPTY_RESPONSE' }
  return error
}

// ------------------------------------------------------------------ 小工具

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function positive0(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** DSH 的 image 块 → `data:` URL（CLI 与 OpenAI 传输都要这种）。 */
function dataUrlOf(block) {
  const data = base64Of(block)
  if (data === undefined) return undefined
  return `data:${mediaTypeOf(block) ?? 'image/png'};base64,${data}`
}

function base64Of(block) {
  const source = block?.source
  if (isRecord(source) && source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
    return source.data
  }
  if (typeof block?.data === 'string' && block.data.length > 0) return block.data
  if (typeof block?.url === 'string' && block.url.startsWith('data:')) {
    const comma = block.url.indexOf(',')
    if (comma >= 0) return block.url.slice(comma + 1)
  }
  return undefined
}

function mediaTypeOf(block) {
  const source = block?.source
  if (isRecord(source) && typeof source.media_type === 'string' && source.media_type.length > 0) return source.media_type
  if (typeof block?.mediaType === 'string' && block.mediaType.length > 0) return block.mediaType
  if (typeof block?.url === 'string' && block.url.startsWith('data:')) {
    const match = /^data:([^;,]+)[;,]/.exec(block.url)
    if (match) return match[1]
  }
  return undefined
}
