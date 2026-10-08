/**
 * DSH 会话 ⇄ OpenAI Responses API 的线协议翻译。
 *
 * 只翻译 DSH 真正会产生的形状；不做「什么都能转」的通用层。
 * @module dsh-account-bridge/wire/responses
 */

import { readSse } from './sse.js'
import { tryJson } from '../util.js'

/**
 * 把 DSH 的 messages 拆成 Responses API 的 `instructions` + `input`。
 *
 * - system 消息（含 `source.kind === 'system-prompt'`）合并进 `instructions`；
 * - assistant 的 `reasoning` 块**不回传**（Responses 要求配加密内容，回传纯文本会 400）；
 * - 工具调用回传成 `function_call`，工具结果回传成 `function_call_output`。
 *
 * @param {Array<object>} messages
 * @returns {{instructions?: string, input: Array<object>}}
 */
export function toResponsesInput(messages) {
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
 * @param {{effort?: string, signal?: AbortSignal, onEvent?: (event: object) => void}} [options]
 * @returns {AsyncGenerator<object>}
 */
export async function* translateResponsesStream(response, options = {}) {
  const { signal, onEvent } = options
  /** @type {Map<number, {blockType: string, block: object, callId?: string, name?: string}>} */
  const open = new Map()
  /** 已经发过 block-start 的 output_index（有些上游不发 output_item.added）。 */
  const started = new Set()
  const begin = function* (index, blockType, seed = {}) {
    if (started.has(index)) return
    started.add(index)
    if (!open.has(index)) open.set(index, { blockType, ...seed })
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
        yield* begin(index, blockType, { callId: item.call_id ?? item.id, name: item.name })
        break
      }
      case 'response.output_text.delta': {
        const index = payload.output_index ?? 0
        yield* begin(index, 'text')
        sawOutput = true
        yield { type: 'text-delta', index, text: payload.delta ?? '' }
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const index = payload.output_index ?? 0
        yield* begin(index, 'reasoning')
        sawOutput = true
        yield { type: 'reasoning-delta', index, text: payload.delta ?? '' }
        break
      }
      case 'response.function_call_arguments.delta': {
        const index = payload.output_index ?? 0
        yield* begin(index, 'tool-call', { callId: payload.item_id })
        const entry = open.get(index)
        sawOutput = true
        yield {
          type: 'tool-call-delta',
          index,
          id: entry?.callId ?? payload.item_id ?? `call_${index}`,
          argumentsDelta: payload.delta ?? '',
        }
        break
      }
      case 'response.output_item.done': {
        const index = payload.output_index ?? 0
        const item = payload.item ?? {}
        const entry = open.get(index) ?? {}
        const block = blockFromItem(item, entry)
        if (block) {
          sawOutput = true
          yield* begin(index, block.type === 'tool-call' ? 'tool-call' : block.type === 'reasoning' ? 'reasoning' : 'text')
          yield { type: 'block-end', index, block }
        }
        open.delete(index)
        break
      }
      case 'response.completed': {
        usage = usageOf(payload.response?.usage)
        break
      }
      case 'response.incomplete': {
        finishReason = 'max-tokens'
        usage = usageOf(payload.response?.usage)
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
  yield { type: 'finish', reason: { kind: finishReason === 'max-tokens' ? 'max-tokens' : 'stop' } }
}

/** 把 Responses 的输出项翻成 DSH 的完整块。 */
function blockFromItem(item, entry) {
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
    return text.length > 0 ? { type: 'reasoning', text } : undefined
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
