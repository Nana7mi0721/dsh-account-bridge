/**
 * Grok（xAI）的线协议：请求信封 + Responses SSE 翻译 + 失败归类。
 *
 * 为什么不复用 `wire/responses.js`：那一层是**通用 Responses 翻译**，而 grok 这一族
 * 有三处它刻意不做的事，缺一个就是真机故障：
 * - **块下标关联用 `item_id`**：xAI 的 `response.output_text.delta` 带 `item_id`
 *   （真机实测），`output_index` 反而不保证每个事件都发。通用层只认 `output_index`，
 *   在 xAI 上会退化成「所有增量挤进第 0 块」。
 * - **有工具调用时 `finish.reason.kind` 必须是 `tool-calls`**：通用层永远回 `stop`，
 *   于是 agent 循环收到 `stop` 就收尾，工具调用被静默丢弃。
 * - **`*.done` 事件要防重复计数**：xAI 在 `response.output_text.done` 里带上整段文本，
 *   通用层不处理这个事件也不会重复，但一旦要处理就必须确认这一段没走过 `delta`。
 *
 * 上游有两个口径完全不同的端点（G23），**计费方式不同**：
 * - `https://cli-chat-proxy.grok.com/v1/responses`：订阅 / Grok CLI 口径，
 *   本插件的默认值——复用订阅额度才是这一族存在的理由；
 * - `https://api.x.ai/v1/responses`：按量计费的 API 口径，只在账号显式要求时用。
 * @module dsh-account-bridge/wire/grok
 */

import { readSse } from './sse.js'
import { mergeUsageNonZero } from './usage.js'
import { tryJson } from '../util.js'

/** 订阅口径（默认）。 */
export const GROK_CLI_BASE = 'https://cli-chat-proxy.grok.com/v1'
/** 按量 API 口径（`auth.baseUrl` / `auth.useApiEndpoint` 显式要求时才用）。 */
export const GROK_API_BASE = 'https://api.x.ai/v1'

/**
 * CLI 代理的指纹头。**缺任意一个都可能静默 403**，`x-grok-client-version`
 * 缺了则是 HTTP **426**（见 `httpErrorFor` 里的说明）。
 */
export const GROK_CLI_TOKEN_AUTH = 'xai-grok-cli'

/**
 * 我们自报的身份。
 *
 * 真机证据：带上诚实的 `dsh-grok-provider` 一样拿 HTTP 200，
 * **不需要也不该冒充 `grok-shell`** —— 冒充只是把自己伪装成别人的客户端，
 * 一旦上游按客户端做风控，后果落在用户账号上。
 */
export const GROK_CLIENT_IDENTIFIER = 'dsh-account-bridge'

/** CLI catalog 的候选路径：一家实现用 `/v1/models-v2`，另一家用 `/v1/models`。 */
export const GROK_CLI_MODELS_PATHS = ['/models', '/models-v2']

/** 结论文本里的这些字样说明是「指纹头没带对」，不是套餐问题。 */
const FINGERPRINT_HINT = /client.?(version|identifier|mode)|fingerprint|x-xai-token-auth|upgrade required/i

/** 把 URL 拼干净：base 尾斜杠与 path 首斜杠都不重复。 */
function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}

/**
 * 这个账号该打哪个端点。
 *
 * 默认订阅口径；`auth.baseUrl`（显式给 base，测试与自建中转都要用）与
 * `auth.useApiEndpoint`（布尔开关，给界面用）能切到按量 API。
 * 指向**非缺失值**的 `baseUrl` 永远赢——它是用户手输的，我们不该猜。
 */
export function resolveGrokBase(auth) {
  const explicit = typeof auth?.baseUrl === 'string' ? auth.baseUrl.trim() : ''
  if (explicit.length > 0) return explicit.replace(/\/+$/, '')
  return auth?.useApiEndpoint === true ? GROK_API_BASE : GROK_CLI_BASE
}

/** 推理端点（两个口径共用 `/responses` 路径）。 */
export function grokResponsesUrl(auth) {
  return joinUrl(resolveGrokBase(auth), '/responses')
}

/** 额度端点：**只有** CLI 代理有，按量 API 口径没有这个概念。 */
export function grokBillingUrl() {
  return joinUrl(GROK_CLI_BASE, '/billing?format=credits')
}

/** 目录端点：按量 API 的目录是「有哪些模型」的权威来源。 */
export function grokModelsUrl() {
  return joinUrl(GROK_API_BASE, '/models')
}

/**
 * CLI 目录端点。`variant` 是 `GROK_CLI_MODELS_PATHS` 的下标——
 * 两家实现各用一个路径，两个可能都活着，所以由调用方 404 后再试下一个，
 * 而不是把其中一个写死成错的。
 */
export function grokCliCatalogUrl(variant = 0) {
  return joinUrl(GROK_CLI_BASE, GROK_CLI_MODELS_PATHS[variant] ?? GROK_CLI_MODELS_PATHS[0])
}

/**
 * 端点判定：我们打的是订阅口径还是按量口径。测试与日志都要用，
 * 免得「看起来能用、其实在烧按量余额」这种事靠肉眼。
 */
export function endpointKind(auth) {
  return resolveGrokBase(auth) === GROK_API_BASE ? 'api' : 'cli'
}

/**
 * 渲染请求头。
 *
 * @param {object} options
 * @param {string} options.access  access token
 * @param {string} options.clientVersion `x-grok-client-version` 的值（**必须**是 x.y.z）
 * @param {boolean} [options.cli] 是否 CLI 口径（默认按 base 判）
 * @param {boolean} [options.json] 是否带 `content-type`
 * @param {object} [options.extra] 额外头（额度端点的 `x-userid` 等）
 */
export function grokHeaders({ access, clientVersion, cli, json = false, extra = {} } = {}) {
  const headers = {
    authorization: `Bearer ${access ?? ''}`,
    accept: 'application/json',
    ...extra,
  }
  if (json) headers['content-type'] = 'application/json'
  if (cli !== false) {
    // 这三个头是 Grok Build 中间件的门禁：少一个就 403，少版本号就 426。
    headers['x-xai-token-auth'] = GROK_CLI_TOKEN_AUTH
    headers['x-grok-client-version'] = clientVersion
    headers['x-grok-client-identifier'] = GROK_CLIENT_IDENTIFIER
  }
  return headers
}

// ------------------------------------------------------------------ 请求信封

/**
 * DSH 的 messages → Responses 的 `input` 项。
 *
 * 与通用层的两处刻意的差别：
 * - assistant 的 `reasoning` 块**不回传**：Responses 要求复放思考必须带**原始 id 与
 *   非空 `encrypted_content`**，而 DSH 的历史里只有纯文本，回传纯文本思考会被 400；
 * - 工具结果的 `call_id` 取 `message.toolCallId`，**不是** function_call 的 `item.id`
 *   —— 真机确认 xAI 是「item.id 关联流内事件、call_id 关联工具结果」（两族共通坑里
 *   copilot 恰好相反，两份实现不能共用 id 策略）。
 */
export function toResponsesInput(messages) {
  const input = []
  for (const message of messages ?? []) {
    if (message?.role === 'system') continue
    if (message.role === 'user') {
      input.push({ type: 'message', role: 'user', content: inputContent(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content)
      if (text.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type !== 'tool-call') continue
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
        })
      }
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? message.source?.callId,
        output: toolOutputOf(message),
      })
    }
  }
  return input
}

/** DSH 的工具定义 → Responses 的 function 工具（`strict:false`，xAI 不要求严格模式）。 */
export function toResponsesTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = []
  for (const tool of tools) {
    if (!tool?.name) continue
    out.push({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? tool.inputSchema ?? { type: 'object', properties: {} },
      strict: false,
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 组装 `/v1/responses` 请求体。
 *
 * 几个字段是被上游真机行为钉住的，不是风格问题：
 * - **没有工具就一个 `tools` 字段都不发**（连带 `tool_choice`):xAI 对无工具的调用
 *   带 `tools` 会回 400 invalid-argument（G4）；
 * - `store:false`：不把会话留在上游，也让整轮输入可以合法全量重放；
 * - `include:['reasoning.encrypted_content']`：请求加密思考块，配合 `store:false`
 *   让下一轮可以把思考原样带回去；
 * - `prompt_cache_key`：缓存亲和的**唯一**信号（G7）。我们**不发** `x-grok-conv-id`
 *   —— 那个头在八个参考仓库里零命中，缓存亲和走 body，会话粘性交给账号池。
 */
export function buildGrokBody(options = {}) {
  const { model, messages, system, tools, effort, maxTokens, promptCacheKey } = options
  const toolList = toResponsesTools(tools)
  const body = {
    model,
    input: toResponsesInput(messages),
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  }
  const instructions = typeof system === 'string' && system.length > 0 ? system : undefined
  if (instructions) body.instructions = instructions
  const limit = Number(maxTokens)
  if (Number.isFinite(limit) && limit > 0) body.max_output_tokens = Math.floor(limit)
  if (typeof effort === 'string' && effort.length > 0) body.reasoning = { effort, summary: 'auto' }
  if (typeof promptCacheKey === 'string' && promptCacheKey.length > 0) body.prompt_cache_key = promptCacheKey
  if (toolList) {
    body.tools = toolList
    body.tool_choice = 'auto'
    body.parallel_tool_calls = true
  }
  return body
}

// ------------------------------------------------------------------ 流翻译

/** 块类型 → 三种 DSH 块。`message` 是文本，`reasoning` 是思考，`function_call` 是工具。 */
function blockTypeOf(itemType) {
  if (itemType === 'function_call') return 'tool-call'
  if (itemType === 'reasoning') return 'reasoning'
  return 'text'
}

/**
 * Responses 的 SSE → DSH 的 StreamChunk。
 *
 * 关联策略（真机）：**`item_id` 是流内事件的钥匙**，`output_index` 只是兜底；
 * 工具结果的 `call_id` 单独记，最后放进 `block.id`（DSH 用它把结果配回调用）。
 *
 * @param {Response} response
 * @param {{signal?: AbortSignal, onEvent?: (event: object) => void}} [options]
 * @returns {AsyncGenerator<object>}
 */
export async function* translateGrokStream(response, options = {}) {
  const { signal, onEvent } = options
  /** @type {Map<string, object>} 打开中的块，键是归一化后的 index */
  const slots = new Map()
  /** 已经进入 `slots` 的键（含已结束的），保证 `block-start` 只发一次。 */
  const started = new Set()
  /** 走没走过 delta 的键——`.done` 事件带全文时必须靠它防重复。 */
  const streamed = new Set()
  /** 只有 item.id 的事件（`response.completed` 之后到达的 done）用它回到原槽位。 */
  const byItemId = new Map()
  let nextFallback = 0
  let nextIndex = 0
  let sawToolCall = false
  let usage
  let failureText
  let failureCode
  let maxTokensReason = false
  let streamedText = false

  /**
   * 取（或建）一个槽位。返回 `{slot, fresh}`；`fresh` 为真时调用方要发 `block-start`。
   *
   * 键的优先级：`output_index` → 已知的 `item_id` 映射 → 自增序号。
   * `output_index` 放最前是因为它天然唯一；但 xAI 只在部分事件里发它，
   * 所以每个 `item_id` 第一次出现时就记下它落在哪个槽位，后续只带
   * `item_id` 的事件（`.done` 尤其常见）就能回到同一块，而不是新开一块。
   */
  const slotFor = (payload, hintedType) => {
    // 事件既可能在顶层带 `item_id`（`output_text.delta`），也可能只在 `item.id` 里带
    // 关联键（`output_item.done`）。两个都要认：只认顶层的话，收尾事件会被当成新块，
    // 于是同一段文本重复吐一遍、还多出一个空的 block-end。
    const itemId =
      typeof payload?.item_id === 'string'
        ? payload.item_id
        : typeof payload?.item?.id === 'string'
          ? payload.item.id
          : undefined
    let key
    if (Number.isInteger(payload?.output_index) && payload.output_index >= 0) key = `i${payload.output_index}`
    else if (itemId && byItemId.has(itemId)) key = byItemId.get(itemId)
    else key = `n${nextFallback++}`
    if (itemId && !byItemId.has(itemId)) byItemId.set(itemId, key)

    let slot = slots.get(key)
    let fresh = false
    if (!slot) {
      fresh = !started.has(key)
      started.add(key)
      slot = {
        key,
        index: Number.isInteger(payload?.output_index) ? payload.output_index : nextIndex++,
        blockType: hintedType ?? 'text',
        itemId,
        callId: undefined,
        name: undefined,
        text: '',
        reasoning: '',
        args: '',
        ended: false,
      }
      slots.set(key, slot)
    }
    // 类型只在「还不知道」时才被事件改写：`output_item.added` 先到就不用改了。
    if (hintedType && hintedType !== 'text' && slot.blockType === 'text') slot.blockType = hintedType
    return { slot, fresh }
  }

  for await (const event of readSse(response, { signal })) {
    // 终止标记：`[DONE]` 之后不会再有任何事件。
    if (event.data === '[DONE]') continue
    const payload = tryJson(event.data)
    if (!payload || typeof payload !== 'object') continue
    onEvent?.(payload)
    const type = payload.type ?? event.event

    switch (type) {
      case 'response.output_item.added': {
        const item = payload.item ?? {}
        const { slot, fresh } = slotFor(payload, blockTypeOf(item.type))
        if (item.id) slot.itemId = item.id
        if (item.call_id) slot.callId = item.call_id
        if (typeof item.name === 'string') slot.name = item.name
        if (fresh) yield { type: 'block-start', index: slot.index, blockType: slot.blockType }
        break
      }
      case 'response.output_text.delta': {
        const { slot, fresh } = slotFor(payload, 'text')
        if (fresh) yield { type: 'block-start', index: slot.index, blockType: 'text' }
        const text = typeof payload.delta === 'string' ? payload.delta : ''
        slot.text += text
        streamed.add(slot.key)
        if (text.length > 0) {
          streamedText = true
        }
        yield { type: 'text-delta', index: slot.index, text }
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const { slot, fresh } = slotFor(payload, 'reasoning')
        if (fresh) yield { type: 'block-start', index: slot.index, blockType: 'reasoning' }
        const text = typeof payload.delta === 'string' ? payload.delta : ''
        slot.reasoning += text
        streamed.add(slot.key)
        if (text.length > 0) {
        }
        yield { type: 'reasoning-delta', index: slot.index, text }
        break
      }
      // 思考摘要/正文的 `.done` 也带全文：只有这一段**没走过 delta** 时才补发，
      // 否则同一段思考会在面板里出现两遍。
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_text.done': {
        const { slot, fresh } = slotFor(payload, 'reasoning')
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (fresh) yield { type: 'block-start', index: slot.index, blockType: 'reasoning' }
        if (text.length > 0 && !streamed.has(slot.key)) {
          slot.reasoning += text
          streamed.add(slot.key)
          yield { type: 'reasoning-delta', index: slot.index, text }
        }
        break
      }
      case 'response.output_text.done': {
        const { slot, fresh } = slotFor(payload, 'text')
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (fresh) yield { type: 'block-start', index: slot.index, blockType: 'text' }
        if (text.length > 0 && !streamed.has(slot.key)) {
          slot.text += text
          streamed.add(slot.key)
          streamedText = true
          yield { type: 'text-delta', index: slot.index, text }
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const { slot, fresh } = slotFor(payload, 'tool-call')
        if (fresh) yield { type: 'block-start', index: slot.index, blockType: 'tool-call' }
        const delta = typeof payload.delta === 'string' ? payload.delta : ''
        slot.args += delta
        if (delta.length > 0) {
          sawToolCall = true
        }
        yield {
          type: 'tool-call-delta',
          index: slot.index,
          // DSH 用 id 把后续的工具结果配回这一次调用，所以这里必须是 `call_id`。
          id: slot.callId ?? slot.itemId ?? generatedCallId(slot.index),
          ...(slot.name === undefined ? {} : { name: slot.name }),
          argumentsDelta: delta,
        }
        break
      }
      case 'response.function_call_arguments.done': {
        const { slot, fresh } = slotFor(payload, 'tool-call')
        if (fresh) yield { type: 'block-start', index: slot.index, blockType: 'tool-call' }
        const args = typeof payload.arguments === 'string' ? payload.arguments : ''
        // 完整参数**可能只在 done 才到**：只有没走过 delta 时才补，避免拼出两份 JSON。
        if (args.length > 0 && slot.args.length === 0) {
          slot.args = args
          sawToolCall = true
          yield {
            type: 'tool-call-delta',
            index: slot.index,
            id: slot.callId ?? slot.itemId ?? generatedCallId(slot.index),
            ...(slot.name === undefined ? {} : { name: slot.name }),
            argumentsDelta: args,
          }
        }
        break
      }
      case 'response.output_item.done': {
        const item = payload.item ?? {}
        const { slot, fresh } = slotFor(payload, blockTypeOf(item.type))
        if (item.id) slot.itemId = item.id
        if (item.call_id) slot.callId = item.call_id
        if (typeof item.name === 'string') slot.name = item.name
        if (fresh) yield { type: 'block-start', index: slot.index, blockType: slot.blockType }

        if (slot.blockType === 'tool-call') {
          const args = typeof item.arguments === 'string' ? item.arguments : undefined
          if (slot.args.length === 0 && args !== undefined) {
            slot.args = args
            if (args.length > 0) {
              sawToolCall = true
              yield {
                type: 'tool-call-delta',
                index: slot.index,
                id: slot.callId ?? slot.itemId ?? generatedCallId(slot.index),
                ...(slot.name === undefined ? {} : { name: slot.name }),
                argumentsDelta: args,
              }
            }
          }
          sawToolCall = true
          slot.ended = true
          yield {
            type: 'block-end',
            index: slot.index,
            block: {
              type: 'tool-call',
              id: slot.callId ?? slot.itemId ?? generatedCallId(slot.index),
              name: item.name ?? slot.name ?? '',
              arguments: slot.args.length > 0 ? slot.args : '{}',
            },
          }
          break
        }

        if (slot.blockType === 'reasoning') {
          // 思考正文只在没走过 delta 时补；块本身即使只有加密内容也要收尾，
          // 否则面板上的思考块永远转圈。
          if (!streamed.has(slot.key)) {
            const text = reasoningTextOf(item)
            if (text.length > 0) {
              slot.reasoning += text
              streamed.add(slot.key)
              yield { type: 'reasoning-delta', index: slot.index, text }
            }
          }
          if (slot.reasoning.length > 0)          slot.ended = true
          yield { type: 'block-end', index: slot.index, block: { type: 'reasoning', text: slot.reasoning } }
          break
        }

        if (!streamed.has(slot.key)) {
          const text = textOf(item.content)
          if (text.length > 0) {
            slot.text += text
            streamed.add(slot.key)
            streamedText = true
            yield { type: 'text-delta', index: slot.index, text }
          }
        }
        if (slot.text.length > 0)        slot.ended = true
        yield { type: 'block-end', index: slot.index, block: { type: 'text', text: slot.text } }
        break
      }
      case 'response.completed': {
        usage = mergeUsageNonZero(usage, usageOf(payload.response?.usage))
        if (payload.response?.status === 'incomplete') maxTokensReason = true
        break
      }
      case 'response.incomplete': {
        usage = mergeUsageNonZero(usage, usageOf(payload.response?.usage))
        // 只有「输出被长度截断」才叫 max-tokens；内容过滤也算 incomplete，
        // 那种情况下报 max-tokens 会让上层以为「再加点预算就行」。
        const reason = String(payload.response?.incomplete_details?.reason ?? '')
        maxTokensReason = reason.includes('max_output_tokens') || reason.includes('length')
        break
      }
      case 'response.failed': {
        const error = payload.response?.error
        failureText = error?.message ?? 'grok response failed'
        failureCode = error?.code
        break
      }
      case 'error': {
        failureText = payload.message ?? payload.error?.message ?? 'grok stream error'
        failureCode = payload.code ?? payload.error?.code
        break
      }
      default:
        // `response.created` / `response.in_progress` / `*_part.added|done` 都不带新内容。
        break
    }
  }

  // 有些上游不发 `output_item.done`，流直接断在最后一条 delta 上：
  // 这里把还开着的块补一个 block-end，否则 DSH 那边永远等不到块结束。
  for (const slot of slots.values()) {
    if (slot.ended) continue
    slot.ended = true
    if (slot.blockType === 'tool-call') {
      sawToolCall = true
      yield {
        type: 'block-end',
        index: slot.index,
        block: {
          type: 'tool-call',
          id: slot.callId ?? slot.itemId ?? generatedCallId(slot.index),
          name: slot.name ?? '',
          arguments: slot.args.length > 0 ? slot.args : '{}',
        },
      }
      continue
    }
    if (slot.blockType === 'reasoning') {
      if (slot.reasoning.length === 0) continue
      yield { type: 'block-end', index: slot.index, block: { type: 'reasoning', text: slot.reasoning } }
      continue
    }
    if (slot.text.length === 0) continue
    streamedText = true
    yield { type: 'block-end', index: slot.index, block: { type: 'text', text: slot.text } }
  }

  if (usage) yield { type: 'usage', usage }

  if (failureText) {
    const error = new Error(failureText)
    error.code = mapStreamErrorCode(failureCode, failureText)
    error.failure = { code: error.code }
    throw error
  }
  // 一个内容块都没吐出去却「成功」结束，等于把一次失败当成空回答写进历史 —— 池子
  // 也就失去了换号重试的机会，所以宁可抛错。
  //
  // 判据只认**文本或工具调用**：纯思考（reasoning）不算「已输出」。思考是模型内部
  // 草稿，用户没看到任何东西、历史里也留不下东西，这时候换号重放不会造成重复输出，
  // 而报成功会让上层把一次真实的空回答固化下来。
  if (!streamedText && !sawToolCall) {
    const error = new Error('grok returned an empty response')
    error.code = 'EMPTY_RESPONSE'
    throw error
  }
  yield { type: 'finish', reason: { kind: maxTokensReason ? 'max-tokens' : sawToolCall ? 'tool-calls' : 'stop' } }
}

// ------------------------------------------------------------------ 失败归类

/**
 * 指纹头缺失的两种表现，都要说清**根因**而不是「网关故障」：
 * - HTTP 426：`x-grok-client-version` 缺失/形态不对（G1）；
 * - HTTP 403 + 提示字样：Grok Build 中间件因为缺指纹头直接 403（G2）。
 *
 * 426 尤其危险：Upgrade Required 在监控里长得像网关问题，于是根因
 * （我们把版本头漏了）会被查很久都查不出来。
 */
export function fingerprintError(status, detail) {
  if (status === 426) {
    return {
      message:
        `grok: HTTP 426 from the CLI proxy — the request is missing a usable ` +
        `x-grok-client-version header (this family treats 426 as "our envelope is incomplete", ` +
        `not as a gateway fault): ${String(detail ?? '').slice(0, 200)}`,
      code: 'SERVER',
    }
  }
  if (detail && FINGERPRINT_HINT.test(String(detail))) {
    return {
      message: `grok: HTTP ${status} looks like a fingerprint rejection (missing/incorrect x-grok-client-* headers): ${String(detail).slice(0, 200)}`,
      code: status === 403 ? 'AUTH' : 'SERVER',
    }
  }
  return undefined
}

/** 流内错误码 → DSH 的 provider 中立码。 */
export function mapStreamErrorCode(code, message = '') {
  const text = `${code ?? ''} ${message}`.toLowerCase()
  if (text.includes('rate') && text.includes('limit')) return 'RATE_LIMIT'
  if (text.includes('quota') || text.includes('insufficient') || text.includes('credit')) return 'QUOTA'
  if (text.includes('unauthor') || text.includes('invalid_grant') || text.includes('expired')) return 'AUTH'
  if (text.includes('context') && (text.includes('length') || text.includes('window'))) return 'CONTEXT_WINDOW_EXCEEDED'
  if (text.includes('timeout') || text.includes('timed out')) return 'TIMEOUT'
  return 'SERVER'
}

// ------------------------------------------------------------------ 内部

/** Responses 的 usage 字段名 → DSH 的 usage 字段名。 */
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens
  const outputTokens = usage.output_tokens ?? usage.completion_tokens
  const out = {}
  if (typeof inputTokens === 'number') out.inputTokens = inputTokens
  if (typeof outputTokens === 'number') out.outputTokens = outputTokens
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details
  if (typeof details?.cached_tokens === 'number') out.cachedInputTokens = details.cached_tokens
  return Object.keys(out).length > 0 ? out : undefined
}

/** 取消息里所有 text 块的合并文本。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 思考块的正文可能躺在 `summary[]` 或 `content[]` 里（两个字段名都见过）。 */
function reasoningTextOf(item) {
  const parts = Array.isArray(item?.summary) && item.summary.length > 0 ? item.summary : (item?.content ?? [])
  return (Array.isArray(parts) ? parts : []).map((part) => part?.text ?? '').join('')
}

/** 用户消息的内容数组：文本 + 图片（能识别的转 data URL，否则降级为文字占位）。 */
function inputContent(content) {
  const out = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'input_text', text: block.text })
      continue
    }
    if (block?.type === 'image') {
      const url = imageDataUrl(block)
      out.push(
        url ? { type: 'input_image', image_url: url } : { type: 'input_text', text: '[image omitted: unsupported encoding]' },
      )
      continue
    }
    if (block?.type === 'file') {
      out.push({ type: 'input_text', text: `[file omitted: ${block.name ?? 'attachment'}]` })
    }
  }
  if (out.length === 0) out.push({ type: 'input_text', text: '' })
  return out
}

/** 尽最大努力把 DSH 的图片块变成 data URL。 */
function imageDataUrl(block) {
  if (typeof block?.dataUrl === 'string' && block.dataUrl.startsWith('data:')) return block.dataUrl
  if (typeof block?.url === 'string' && block.url.startsWith('data:')) return block.url
  const mediaType = block?.mediaType ?? block?.mimeType ?? block?.contentType
  const data = block?.data ?? block?.base64 ?? block?.bytes
  if (typeof data === 'string' && typeof mediaType === 'string') return `data:${mediaType};base64,${data}`
  if (data && typeof data.toString === 'function' && typeof mediaType === 'string') {
    try {
      return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 工具结果的文本形态。 */
function toolOutputOf(message) {
  const text = textOf(message?.content)
  if (text.length > 0) return message?.isError === true ? `[error] ${text}` : text
  const json = JSON.stringify(message?.content ?? '')
  return message?.isError === true ? `[error] ${json}` : json
}

/** 上游没给 `call_id` 时的兜底 id：必须仍然能唯一定位一次调用。 */
function generatedCallId(index) {
  return `call_grok_${index}`
}
