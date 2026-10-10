/**
 * DSH 消息 ↔ OpenAI Chat Completions 的翻译，外加 SSE → DSH chunk 的转换。
 *
 * 这是 `generic` 族说的那句话：**「OpenAI 兼容」是这个行业里最接近通用语的东西，
 * 但它不是一种协议，是一族方言。** 下面每一条都是为了让插件在方言之间不崩：
 *
 * - **`stream_options: {include_usage: true}` 不是所有网关都认**。认的会把最后一块
 *   usage 发过来（没有它就没法显示 token 消耗），不认的会直接 400。所以发不发是
 *   可以关的（`compat.streamUsage: false`），而且关掉之后一切照常，只是没有用量。
 * - **`max_tokens` vs `max_completion_tokens`**：OpenAI 官方新模型只认后者，
 *   而绝大多数兼容网关只认前者。默认发 `max_tokens`，认后者的那些用 `compat` 改。
 * - **推理内容是方言里的方言**：DeepSeek 叫 `reasoning_content`，OpenRouter 叫
 *   `reasoning`，还有的塞在 `reasoning_details[].text`。三个都读，读不到就没有。
 * - **`tool_calls[].index` 是上游自己的编号**，不保证从 0 开始、也不保证连续
 *   （并行工具调用时会跳）。DSH 的块下标是我们自己分配的，所以这里维护一张
 *   上游下标 → 本地下标 的映射，而不是直接拿它当块下标。
 * - **`system` 角色的位置**：只有对话开头的 system 进顶层 system 消息，中间的
 *   包成 `<system-reminder>` 当 user 文本——和 `anthropic.js` 同一套约定，
 *   因为确实有网关只接受「system 必须在第一条」。
 *
 * @module dsh-account-bridge/wire/chat-completions
 */

import { readSse } from './sse.js'
import { mergeUsageNonZero } from './usage.js'
import { diagnosticReporter } from './diagnostics.js'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/** 对话真正开始的位置（= 第一条非 system 消息的下标）。 */
function conversationStart(messages) {
  const index = messages.findIndex((message) => message.role !== 'system')
  return index === -1 ? messages.length : index
}

/** tool 结果块的文本形态。 */
function toolResultText(block) {
  if (typeof block === 'string') return block
  if (Array.isArray(block?.content)) {
    const text = block.content
      .filter((item) => item?.type === 'text')
      .map((item) => item.text)
      .join('\n')
    return text.length > 0 ? text : JSON.stringify(block.content)
  }
  if (typeof block?.text === 'string') return block.text
  if (typeof block?.content === 'string') return block.content
  return block === undefined ? '' : JSON.stringify(block)
}

/**
 * 顶层的 system 消息文本：显式 `system` + 对话开头所有 system 消息的内容。
 * 没有内容时返回空串（调用方据此决定要不要塞这条消息）。
 */
export function toChatSystem(system, messages = []) {
  const parts = []
  if (typeof system === 'string' && system.length > 0) parts.push(system)
  for (const message of messages.slice(0, conversationStart(messages))) {
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/**
 * DSH 消息 → OpenAI `messages`。
 *
 * 两个形态上的讲究：
 * - 纯文本消息发**字符串**而不是 `[{type:'text'}]` 数组。两种都合法，但确实有网关
 *   只实现了字符串那一支；只有在真的带图片时才升级成数组。
 * - `tool` 结果必须自成一类消息（`role:'tool'`），不能并进 user 消息里——
 *   OpenAI 是这么定义的，而且 `tool_call_id` 必须与前面那条 assistant 的
 *   `tool_calls[].id` 对上，对不上就是 400。
 */
export function toChatMessages(messages, { onDiagnostic } = {}) {
  const out = []
  const report = diagnosticReporter(undefined, onDiagnostic)
  const start = conversationStart(messages)

  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' && index < start) continue

    if (message.role === 'tool') {
      const id = message.toolCallId ?? message.tool_call_id ?? message.source?.callId
      if (id === undefined) {
        const error = new Error('chat-completions: a tool result has no call id')
        error.code = 'INVALID_REQUEST'
        throw error
      }
      out.push({ role: 'tool', tool_call_id: String(id), content: toolResultText(message) })
      continue
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const parts = []
    const toolCalls = []
    const plain = []

    for (const [blockIndex, block] of (message.content ?? []).entries()) {
      switch (block.type) {
        case 'text':
          if (message.role === 'system') {
            // 中间的 system 消息降级成 user 文本，保住它前面的前缀。
            plain.push(`${SYSTEM_REMINDER_OPEN}${block.text}${SYSTEM_REMINDER_CLOSE}`)
          } else {
            plain.push(block.text)
          }
          break
        case 'tool-call':
          if (role === 'assistant') {
            toolCalls.push({
              id: String(block.id),
              type: 'function',
              function: { name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) },
            })
          } else {
            // 只有 assistant 能发起工具调用；别的角色里那是「历史叙述」，降级成文本。
            plain.push(`[tool call ${block.name}: ${block.arguments}]`)
          }
          break
        case 'tool-result': {
          const id = block.toolCallId ?? block.tool_call_id
          if (id === undefined) {
            const error = new Error('chat-completions: a tool result has no call id')
            error.code = 'INVALID_REQUEST'
            throw error
          }
          out.push({ role: 'tool', tool_call_id: String(id), content: toolResultText(block) })
          break
        }
        case 'image':
          if (typeof block.data === 'string' && block.data.length > 0) {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${block.mediaType ?? 'image/png'};base64,${block.data}` },
            })
          } else {
            // 模型看不到这张图，而调用方以为它看到了。
            report?.({
              code: 'IMAGE_WITHOUT_DATA',
              severity: 'error',
              phase: 'request',
              path: `messages[${index}].content[${blockIndex}]`,
              message:
                'chat-completions: an image block has no base64 data, so the model will not see it',
              from: block.mediaType,
            })
          }
          break
        default:
          report?.({
            code: 'UNKNOWN_BLOCK_TYPE',
            severity: 'error',
            phase: 'request',
            path: `messages[${index}].content[${blockIndex}]`,
            message: `chat-completions: unknown content block type "${block.type}", dropped from the request`,
            from: block.type,
          })
          break
      }
    }

    const text = plain.join('')
    if (parts.length > 0) {
      if (text.length > 0) parts.unshift({ type: 'text', text })
    }
    const content = parts.length > 0 ? parts : text
    if (typeof content === 'string' && content.length === 0 && toolCalls.length === 0) continue

    out.push({
      role,
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
  }

  return out
}

/** DSH 工具 → OpenAI `tools`（同样按名字排序，理由与 anthropic 那条一致：缓存前缀）。 */
export function toChatTools(tools) {
  return [...(tools ?? [])]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
}

/**
 * OpenAI 的 `finish_reason` → DSH 的 finish kind。
 *
 * DSH 只认 `'stop' | 'tool-calls' | 'max-tokens'`（外加 in-band 的 `'error'`）。
 * `content_filter` 映射成 `stop` 而不是 `error`：它意味着「这一轮没有内容」，
 * 让 EMPTY_RESPONSE 那条闸去报错更准确，而 error 会触发换号重试——
 * 换一个账号照样会被内容策略拦，纯属浪费。
 */
function finishKind(reason, report) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'length':
      return 'max-tokens'
    case 'stop':
    case 'content_filter':
    case undefined:
    case null:
    case '':
      return 'stop'
    default:
      // 上游发明了一个新的 finish_reason。DSH 只认三个词，所以只能落到 `stop`——
      // 但那句「我们把它当成正常结束了」必须说出来，否则「回答看起来是完整的、
      // 其实是截断的」永远不会有人发现。
      report?.({
        code: 'UNKNOWN_STOP_REASON',
        severity: 'warning',
        phase: 'stream',
        message: `chat-completions: unknown finish_reason "${reason}", reported as a normal stop`,
        from: reason,
        to: 'stop',
      })
      return 'stop'
  }
}

/** reasoning 字段的三种方言 → 一段文本（读不到返回空串）。 */
function reasoningText(delta) {
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content
  if (typeof delta.reasoning === 'string') return delta.reasoning
  if (Array.isArray(delta.reasoning_details)) {
    return delta.reasoning_details
      .map((detail) => (typeof detail?.text === 'string' ? detail.text : ''))
      .join('')
  }
  return ''
}

/** `delta.content` 可能是字符串，也可能是分块数组。 */
function contentText(delta) {
  if (typeof delta.content === 'string') return delta.content
  if (Array.isArray(delta.content)) {
    return delta.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  }
  return ''
}

/** OpenAI 的 usage 字段名 → DSH 的 usage 字段名。 */
export function normaliseUsage(usage) {
  const out = {}
  if (typeof usage.prompt_tokens === 'number') out.inputTokens = usage.prompt_tokens
  if (typeof usage.completion_tokens === 'number') out.outputTokens = usage.completion_tokens
  if (typeof usage.prompt_tokens_details?.cached_tokens === 'number') {
    out.cachedInputTokens = usage.prompt_tokens_details.cached_tokens
  }
  if (typeof usage.completion_tokens_details?.reasoning_tokens === 'number') {
    out.reasoningTokens = usage.completion_tokens_details.reasoning_tokens
  }
  return out
}

/**
 * OpenAI Chat Completions SSE → DSH chunk 流。
 *
 * 事件形态就是 `data: {...}` 一行一条，以 `data: [DONE]` 收尾。块下标由我们自己
 * 分配（上游没有块的概念），所以先看到的块下标更小。
 */
export async function* translateChatStream(response, { signal, onDiagnostic } = {}) {
  const report = diagnosticReporter(undefined, onDiagnostic)
  /** 上游 tool_calls[].index → 本地块下标。 */
  const toolSlots = new Map()
  let nextIndex = 0
  let textIndex
  let text = ''
  let reasoningIndex
  let reasoning = ''
  let finishReason
  let usage

  const startBlock = () => {
    const index = nextIndex
    nextIndex += 1
    return index
  }

  for await (const event of readSse(response, { signal })) {
    const data = event.data
    if (!data) continue
    if (data === '[DONE]') break
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }

    if (payload.error) {
      const error = new Error(`chat-completions: ${payload.error.message ?? JSON.stringify(payload.error)}`)
      error.code = 'SERVER'
      throw error
    }
    if (payload.usage) usage = mergeUsageNonZero(usage, normaliseUsage(payload.usage))

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
    if (!choice) continue
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason

    const delta = choice.delta ?? {}

    const reasoningDelta = reasoningText(delta)
    if (reasoningDelta.length > 0) {
      if (reasoningIndex === undefined) {
        reasoningIndex = startBlock()
        yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
      }
      reasoning += reasoningDelta
      yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoningDelta }
    }

    const contentDelta = contentText(delta)
    if (contentDelta.length > 0) {
      if (textIndex === undefined) {
        textIndex = startBlock()
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
      }
      text += contentDelta
      yield { type: 'text-delta', index: textIndex, text: contentDelta }
    }

    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const upstream = call.index ?? 0
      let slot = toolSlots.get(upstream)
      if (!slot) {
        slot = { index: startBlock(), id: call.id, name: call.function?.name, json: '' }
        toolSlots.set(upstream, slot)
        yield { type: 'block-start', index: slot.index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: slot.index, id: slot.id, name: slot.name, argumentsDelta: '' }
      }
      // 首块之后才出现的 id/name 也要收下：有网关把它们拆在后面几块里发。
      if (slot.id === undefined && typeof call.id === 'string') slot.id = call.id
      if (slot.name === undefined && typeof call.function?.name === 'string') slot.name = call.function.name
      const fragment = call.function?.arguments
      if (typeof fragment === 'string' && fragment.length > 0) {
        slot.json += fragment
        yield { type: 'tool-call-delta', index: slot.index, argumentsDelta: fragment }
      }
    }
  }

  // 收尾：上游不会发块结束事件，按块下标升序补上（顺序反了有些消费者会错位）。
  const blocks = []
  if (reasoningIndex !== undefined) blocks.push([reasoningIndex, { type: 'reasoning', text: reasoning }])
  if (textIndex !== undefined) blocks.push([textIndex, { type: 'text', text }])
  for (const slot of toolSlots.values()) {
    // 没有名字的工具调用：宿主拿到之后找不到这个工具，整轮就废在这里。
    // 上游偶尔会先发一个只有 index 的空壳再补名字，所以这里只对**收尾时仍然没有名字**的报。
    if (typeof slot.name !== 'string' || slot.name.length === 0) {
      report?.({
        code: 'TOOL_CALL_WITHOUT_NAME',
        severity: 'error',
        phase: 'stream',
        path: `content[${slot.index}]`,
        message: 'chat-completions: a tool call finished without a function name',
        from: slot.id,
      })
    }
    blocks.push([
      slot.index,
      {
        type: 'tool-call',
        id: slot.id ?? `call_${slot.index}`,
        name: slot.name ?? '',
        arguments: slot.json.length > 0 ? slot.json : '{}',
      },
    ])
  }
  blocks.sort((left, right) => left[0] - right[0])
  for (const [index, block] of blocks) yield { type: 'block-end', index, block }

  // 「有没有交付东西」的判据要跟上面**真的发出去的块**一致，而上面无条件为每个工具槽
  // 发了一个块（零参工具调用的 `arguments` 被补成 `'{}'`）。原来这里只认
  // `slot.json.length > 0`，于是「一个零参工具调用」先老老实实发完合法的 tool-call 块，
  // 紧接着被判成空响应抛 EMPTY_RESPONSE ⇒ 已经交付的工具轮被记成失败、换号、还罚 60 秒。
  // 有名字就算交付（没名字的空壳不算，那种确实是垃圾）。
  const producedContent =
    text.length > 0 ||
    reasoning.length > 0 ||
    [...toolSlots.values()].some(
      (slot) => slot.json.length > 0 || (typeof slot.name === 'string' && slot.name.length > 0),
    )
  if (!producedContent) {
    const error = new Error('chat-completions: the response completed without any content block')
    error.code = 'EMPTY_RESPONSE'
    throw error
  }
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: finishKind(finishReason, report) } }
}
