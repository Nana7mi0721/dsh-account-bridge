/**
 * DSH 会话 ⇄ OpenAI Responses API 的线协议翻译。
 *
 * 只翻译 DSH 真正会产生的形状；不做「什么都能转」的通用层。
 * @module dsh-account-bridge/wire/responses
 */

import { readSse } from './sse.js'
import { mergeUsageNonZero } from './usage.js'
import { RESPONSES_REPLAY_KIND, makeEnvelope, replayItem } from './replay.js'
import { tryJson } from '../util.js'

/**
 * 把 DSH 的 messages 拆成 Responses API 的 `instructions` + `input`。
 *
 * - system 消息（含 `source.kind === 'system-prompt'`）合并进 `instructions`；
 * - assistant 的 `reasoning` 块**默认不回传**（Responses 要求配加密内容，回传纯文本会 400）；
 *   开了 `replay` 且确实存着 `encrypted_content` 时，把它作为一个 `reasoning` 项放回去
 *   （**在正文之前**——原始响应里它就是排在前面），见 `wire/replay.js`；
 * - 工具调用回传成 `function_call`，工具结果回传成 `function_call_output`。
 *
 * @param {Array<object>} messages
 * @param {{replay?: boolean}} [options]
 * @returns {{instructions?: string, input: Array<object>}}
 */
export function toResponsesInput(messages, { replay = false } = {}) {
  const instructions = []
  const input = []

  for (const message of messages ?? []) {
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text.length > 0) instructions.push(text)
      continue
    }
    if (message.role === 'user') {
      input.push({ type: 'message', role: 'user', content: inputContent(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      for (const [index, block] of (message.content ?? []).entries()) {
        if (block?.type !== 'reasoning') continue
        // 默认不回传（这一族以前就是这么做的，见文件头）。开了回放也只有拿得到
        // 加密内容时才回传：Responses 对「只有纯文本的 reasoning 项」是直接拒的。
        if (!replay) continue
        const item = replayItem(message, index, undefined)
        if (!item) continue
        input.push({
          type: 'reasoning',
          ...(item.id === undefined ? {} : { id: item.id }),
          summary: [],
          encrypted_content: item.encryptedContent,
        })
      }
      const text = textOf(message.content)
      if (text.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const block of message.content ?? []) {
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
      continue
    }
  }

  return { instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined, input }
}

/** 把 DSH 的工具定义翻成 Responses 的 function 工具。 */
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

/** 取消息里所有 text 块的合并文本。 */
function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 用户消息的内容数组：文本 + 图片（能识别的图片转 data URL，否则降级为文字占位）。 */
function inputContent(content) {
  const out = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'input_text', text: block.text })
      continue
    }
    if (block?.type === 'image') {
      const url = imageDataUrl(block)
      if (url) {
        out.push({ type: 'input_image', image_url: url })
        continue
      }
      out.push({ type: 'input_text', text: '[image omitted: unsupported encoding]' })
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
  if (typeof block.dataUrl === 'string' && block.dataUrl.startsWith('data:')) return block.dataUrl
  if (typeof block.url === 'string' && block.url.startsWith('data:')) return block.url
  const mediaType = block.mediaType ?? block.mimeType ?? block.contentType
  const data = block.data ?? block.base64 ?? block.bytes
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
  const text = textOf(message.content)
  if (text.length > 0) return message.isError === true ? `[error] ${text}` : text
  const json = JSON.stringify(message.content ?? '')
  return message.isError === true ? `[error] ${json}` : json
}

/**
 * 把 Responses 的 SSE 事件流转成 DSH 的 StreamChunk。
 *
 * 用 `output_index` 当 DSH 的块下标——Responses 给的是稳定的输出项序号，
 * 正好和 DSH 的 `index` 语义对齐。
 *
 * @param {Response} response
 * @param {{effort?: string, signal?: AbortSignal, onEvent?: (event: object) => void, model?: string}} [options]
 * @returns {AsyncGenerator<object>}
 */
export async function* translateResponsesStream(response, options = {}) {
  const { signal, onEvent, model, replay = false } = options
  /** @type {Map<number, {blockType: string, block: object, callId?: string, name?: string}>} */
  const open = new Map()
  /** 已经发过 block-start 的 output_index（有些上游不发 output_item.added）。 */
  const started = new Set()
  /**
   * 块出现过的顺序（不是留下的顺序）。
   *
   * 与 `wire/anthropic.js` 里那个 `order` 同理，**必须与宿主 `BlockAssembler.order`
   * 逐位对齐**：宿主是每收到一个带 index 的 chunk 就 `ensure(index)` 一次，
   * 少了任何一个，`envelope.blocks.length !== all.length`，信封被**静默**丢掉。
   */
  const order = []
  const touch = (index) => {
    if (!order.includes(index)) order.push(index)
  }
  /** index → 要带回去的那一小段（Responses 线是 `encrypted_content`）。 */
  const replaySlots = new Map()
  /**
   * `item.id` → 块下标。
   *
   * 存在的理由是一个真事故：**收尾事件不一定带顶层 `output_index`**。
   * 只认顶层字段时，`response.output_item.done` 会落到 `?? 0` 那个兜底上，
   * 于是它把**第 0 个块**关掉、而不是真正该关的那个 ⇒ 界面上同一段文本出现两遍、
   * 外加一个空的 `block-end`。上游在 `.done` 里总是带 `item.id`，所以按 id 反查。
   */
  const indexByItemId = new Map()
  /** 这一轮有没有产出工具调用块——决定收尾是 `'tool-calls'` 还是 `'stop'`。 */
  let sawToolCall = false
  const begin = function* (index, blockType, seed = {}) {
    if (started.has(index)) return
    started.add(index)
    if (!open.has(index)) open.set(index, { blockType, ...seed })
    touch(index)
    // 每个「出现过的块」都要在信封里占一个位置，否则块数对不上、信封被丢掉。
    if (!replaySlots.has(index)) replaySlots.set(index, { type: blockType })
    yield { type: 'block-start', index, blockType }
  }
  let sawOutput = false
  let usage
  let finishReason
  let failureText
  let failedCode

  for await (const event of readSse(response, { signal })) {
    if (event.data === '[DONE]') continue
    const payload = tryJson(event.data)
    if (!payload || typeof payload !== 'object') continue
    onEvent?.(payload)
    const type = payload.type ?? event.event

    switch (type) {
      case 'response.output_item.added': {
        const index = payload.output_index ?? open.size
        const item = payload.item ?? {}
        const blockType = item.type === 'function_call' ? 'tool-call' : item.type === 'reasoning' ? 'reasoning' : 'text'
        if (typeof item.id === 'string') indexByItemId.set(item.id, index)
        yield* begin(index, blockType, { callId: item.call_id ?? item.id, name: item.name })
        noteReplay(replaySlots, index, blockType, item)
        break
      }
      case 'response.output_text.delta': {
        const index = payload.output_index ?? indexByItemId.get(payload.item_id) ?? 0
        yield* begin(index, 'text')
        sawOutput = true
        yield { type: 'text-delta', index, text: payload.delta ?? '' }
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const index = payload.output_index ?? indexByItemId.get(payload.item_id) ?? 0
        yield* begin(index, 'reasoning')
        sawOutput = true
        yield { type: 'reasoning-delta', index, text: payload.delta ?? '' }
        break
      }
      case 'response.function_call_arguments.delta': {
        const index = payload.output_index ?? indexByItemId.get(payload.item_id) ?? 0
        if (typeof payload.item_id === 'string') indexByItemId.set(payload.item_id, index)
        yield* begin(index, 'tool-call', { callId: payload.item_id })
        const entry = open.get(index)
        sawOutput = true
        sawToolCall = true
        yield {
          type: 'tool-call-delta',
          index,
          id: entry?.callId ?? payload.item_id ?? `call_${index}`,
          argumentsDelta: payload.delta ?? '',
        }
        break
      }
      case 'response.output_item.done': {
        const item = payload.item ?? {}
        // 顺序要紧：顶层 → 按 item.id 反查 → 最后才是 0。
        const index = payload.output_index ?? indexByItemId.get(item.id) ?? 0
        const entry = open.get(index) ?? {}
        const block = blockFromItem(item, entry, replay)
        if (block) {
          sawOutput = true
          if (block.type === 'tool-call') sawToolCall = true
          const blockType = block.type === 'tool-call' ? 'tool-call' : block.type === 'reasoning' ? 'reasoning' : 'text'
          yield* begin(index, blockType)
          noteReplay(replaySlots, index, blockType, item)
          yield { type: 'block-end', index, block }
        }
        open.delete(index)
        if (typeof item.id === 'string') indexByItemId.delete(item.id)
        break
      }
      case 'response.completed': {
        usage = mergeUsageNonZero(usage, usageOf(payload.response?.usage))
        break
      }
      case 'response.incomplete': {
        finishReason = 'max-tokens'
        usage = mergeUsageNonZero(usage, usageOf(payload.response?.usage))
        break
      }
      case 'response.failed': {
        const error = payload.response?.error
        failureText = error?.message ?? 'response failed'
        failedCode = error?.code
        break
      }
      case 'error': {
        failureText = payload.message ?? payload.error?.message ?? 'stream error'
        failedCode = payload.code ?? payload.error?.code
        break
      }
      default:
        break
    }
  }

  if (usage) yield { type: 'usage', usage }

  if (failureText) {
    const error = new Error(failureText)
    error.code = mapStreamErrorCode(failedCode, failureText)
    throw error
  }
  if (!sawOutput) {
    const error = new Error('provider returned an empty response')
    error.code = 'EMPTY_RESPONSE'
    throw error
  }
  // DSH 只认 'stop' | 'tool-calls' | 'max-tokens'（见 wire/anthropic.js 的同名注释）。
  // 这一轮产出过工具调用就必须报 'tool-calls'：报成 'stop' 会让宿主以为模型把话说完了，
  // 而实际上它在等工具结果——这一条以前是错的（永远回 'stop'），有回归用例钉住。
  const kind = finishReason === 'max-tokens' ? 'max-tokens' : sawToolCall ? 'tool-calls' : 'stop'
  const replayState = replayStateOf(order, replaySlots, model, replay)
  yield { type: 'finish', reason: { kind }, ...(replayState === undefined ? {} : { replayState }) }
}

/**
 * 把 `response.output_item.*` 里的加密思考状态记进槽位。
 *
 * 只认 `reasoning` 项；`id` 与 `encrypted_content` 都可能只出现在 `.added` 或只在
 * `.done` 里，所以两处都调一次，谁先来算谁的。
 */
function noteReplay(slots, index, blockType, item) {
  if (blockType !== 'reasoning') return
  const slot = slots.get(index) ?? { type: 'reasoning' }
  slot.type = 'reasoning'
  if (typeof item.id === 'string' && item.id.length > 0) slot.id = item.id
  if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) {
    slot.encryptedContent = item.encrypted_content
  }
  slots.set(index, slot)
}

/**
 * 攒一个信封——**只在回放开着、且真有加密内容的时候**。
 *
 * 没有哪个槽位带加密内容时返回 `undefined`：一个空壳信封会跟着每一条助手消息
 * 存进会话文件，换不来任何东西。`blocks` 必须与 `order` 一一对齐，见文件头。
 */
function replayStateOf(order, slots, model, replay) {
  if (replay !== true) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  const blocks = order.map((index) => {
    const slot = slots.get(index)
    const type = slot?.type ?? 'text'
    return {
      type,
      ...(typeof slot?.id === 'string' && slot.id.length > 0 ? { id: slot.id } : {}),
      ...(typeof slot?.encryptedContent === 'string' && slot.encryptedContent.length > 0
        ? { encryptedContent: slot.encryptedContent }
        : {}),
    }
  })
  if (!blocks.some((block) => typeof block.encryptedContent === 'string')) return undefined
  return makeEnvelope(RESPONSES_REPLAY_KIND, model, blocks)
}

/** 把 Responses 的输出项翻成 DSH 的完整块。 */
function blockFromItem(item, entry, replay = false) {
  if (item.type === 'function_call') {
    return {
      type: 'tool-call',
      id: item.call_id ?? entry.callId ?? item.id,
      name: item.name ?? entry.name ?? '',
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
    }
  }
  if (item.type === 'reasoning') {
    const text = (item.summary ?? item.content ?? [])
      .map((part) => part?.text ?? '')
      .join('')
    if (text.length > 0) return { type: 'reasoning', text }
    // 只剩加密内容、一颗字都没有的思考项：默认仍然丢掉（老行为，界面上不该多出
    // 一个空的思考块）；只有在回放开着时才把它变成一个空块——那时它是这一轮
    // **唯一**能把状态带回去的载体，丢掉它等于把回放这条路也丢掉。
    const encrypted = typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
    return replay && encrypted ? { type: 'reasoning', text: '' } : undefined
  }
  const text = (item.content ?? [])
    .map((part) => part?.text ?? '')
    .join('')
  return text.length > 0 ? { type: 'text', text } : undefined
}

/** 取用量。 */
function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens
  const outputTokens = usage.output_tokens ?? usage.completion_tokens
  const out = {}
  if (typeof inputTokens === 'number') out.inputTokens = inputTokens
  if (typeof outputTokens === 'number') out.outputTokens = outputTokens
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details
  if (typeof details?.cached_tokens === 'number') out.cachedInputTokens = details.cached_tokens
  const outDetails = usage.output_tokens_details ?? usage.completion_tokens_details
  if (typeof outDetails?.reasoning_tokens === 'number') out.reasoningTokens = outDetails.reasoning_tokens
  return Object.keys(out).length > 0 ? out : undefined
}

/** 把上游流内错误码映射成 DSH 的 provider 中立码。 */
export function mapStreamErrorCode(code, message = '') {
  const text = `${code ?? ''} ${message}`.toLowerCase()
  if (text.includes('rate') && text.includes('limit')) return 'RATE_LIMIT'
  if (text.includes('quota') || text.includes('insufficient')) return 'QUOTA'
  if (text.includes('unauthor') || text.includes('invalid_grant') || text.includes('expired')) return 'AUTH'
  if (text.includes('context') && text.includes('length')) return 'CONTEXT_WINDOW_EXCEEDED'
  if (text.includes('overload') || text.includes('server')) return 'SERVER'
  return 'SERVER'
}
