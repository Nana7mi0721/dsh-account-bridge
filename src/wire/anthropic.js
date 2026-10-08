/**
 * DSH 消息 ↔ Anthropic Messages API 的翻译，外加 SSE → DSH chunk 的转换。
 *
 * 语义从 V1ki/dsh-plugin-subscriptions 的 `src/translate/anthropic.ts` 核对而来，
 * 关键几条：
 * - **`tools` 按名字排序**：它渲染在缓存前缀的第 0 位，顺序一变，后面的
 *   `system` 与整段对话的 prompt cache 全部失效；而插件加载顺序在不同进程里可以不同。
 * - 对话**开头**的 system 消息进顶层 `system`，**中间**的 system 消息包成
 *   `<system-reminder>` 当 user 文本，这样它前面的缓存前缀保持逐字节不变。
 * - `tool_use` 只出现在 assistant 消息里；其它角色里的 tool-call 是「历史叙述」，
 *   降级成文本，否则 Anthropic 会因为「没有配对的 tool_result」直接 400。
 * @module dsh-account-bridge/wire/anthropic
 */

import { readSse } from './sse.js'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * Claude Code 的身份块。订阅端点的请求会带 `x-app: cli` 与 CLI 的 UA，
 * 这一段让 system 的第一块与其一致。
 */
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the DeepSeek Harness account bridge."

/** 把工具参数解析成对象；解不开就当空对象（Anthropic 只接受对象）。 */
function parseToolInput(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

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

/** 顶层 `system` 数组：身份块 + 显式 system 提示 + 对话开头的 system 消息。 */
export function toAnthropicSystem(system, messages = []) {
  const blocks = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }]
  if (typeof system === 'string' && system.length > 0) blocks.push({ type: 'text', text: system })
  for (const message of messages.slice(0, conversationStart(messages))) {
    for (const block of message.content ?? []) {
      if (block?.type === 'text') blocks.push({ type: 'text', text: block.text })
    }
  }
  // tools 渲染在 system 之前，所以这一个标记同时缓存两者。
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }
  return blocks
}

/** DSH 消息 → Anthropic `messages`。 */
export function toAnthropicMessages(messages) {
  const out = []
  const start = conversationStart(messages)
  for (const [index, message] of messages.entries()) {
    // 开头的 system 消息归 toAnthropicSystem；后面的在这里当 user 文本。
    if (message.role === 'system' && index < start) continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks = []

    if (message.role === 'tool') {
      const id = message.toolCallId ?? message.tool_call_id ?? message.source?.callId
      if (id === undefined) {
        const error = new Error('anthropic: a tool result has no call id')
        error.code = 'INVALID_REQUEST'
        throw error
      }
      blocks.push({
        type: 'tool_result',
        tool_use_id: String(id),
        content: toolResultText(message),
        ...(message.isError === true ? { is_error: true } : {}),
      })
      // 连续的 tool 结果并进同一条 user 消息。
      const last = out[out.length - 1]
      if (last?.role === 'user') last.content.push(...blocks)
      else out.push({ role: 'user', content: blocks })
      continue
    }

    for (const block of message.content ?? []) {
      switch (block.type) {
        case 'text':
          blocks.push({
            type: 'text',
            text:
              message.role === 'system'
                ? `${SYSTEM_REMINDER_OPEN}${block.text}${SYSTEM_REMINDER_CLOSE}`
                : block.text,
          })
          break
        case 'tool-call':
          blocks.push(
            role === 'assistant'
              ? {
                  type: 'tool_use',
                  id: String(block.id),
                  name: block.name,
                  input: parseToolInput(block.arguments),
                }
              : { type: 'text', text: `[tool call ${block.name}: ${block.arguments}]` },
          )
          break
        case 'tool-result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: String(block.toolCallId),
            content: toolResultText(block),
            ...(block.isError === true ? { is_error: true } : {}),
          })
          break
        case 'image':
          if (typeof block.data === 'string' && block.data.length > 0) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: block.mediaType ?? 'image/png', data: block.data },
            })
          }
          break
        default:
          break
      }
    }
    if (blocks.length === 0) continue
    // 同角色的相邻消息可以合并；Anthropic 也接受不合并，这里保守地合并。
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  markMessageCache(out)
  return out
}

/**
 * 在对话尾部打 prompt-cache 断点。
 * Anthropic 允许至多 4 个；这里从尾部往前每 16 块打一个，命中率与成本的折中。
 */
function markMessageCache(messages) {
  const STRIDE = 16
  const BREAKPOINTS = 3
  const blocks = messages.flatMap((message) => message.content)
  for (let mark = 0; mark < BREAKPOINTS; mark += 1) {
    const at = blocks.length - 1 - mark * STRIDE
    if (at < 0) return
    blocks[at].cache_control = { type: 'ephemeral' }
  }
}

/** DSH 工具 → Anthropic `tools`（**按名字排序**，理由见文件头）。 */
export function toAnthropicTools(tools) {
  return [...(tools ?? [])]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }))
}

/**
 * Anthropic 的停止原因 → DSH 的 finish kind。
 *
 * DSH 只认三个值：`'stop' | 'tool-calls' | 'max-tokens'`（外加 in-band 的 `'error'`）。
 * 写成 `'success'` / `'tool-use'` 这类看起来更自然的词会被宿主当成未知值——
 * 而 `max-tokens` 是有实际语义的（宿主会据此丢掉工具调用块，见 `_llm.js:1054`），
 * 所以这三个值必须逐字对上。
 */
function finishKind(stopReason) {
  switch (stopReason) {
    case 'tool_use':
      return 'tool-calls'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'error'
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    default:
      return 'stop'
  }
}

/**
 * Anthropic SSE 流 → DSH chunk 流。
 *
 * 事件名与载荷是公开且稳定的 Anthropic 流式协议：
 * `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` /
 * `message_delta` / `message_stop` / `ping` / `error`。
 */
export async function* translateAnthropicStream(response, { signal } = {}) {
  // 每个 block index 一份累积器：`block-end` 必须携带**完整**块对象。
  const accumulators = new Map()
  let sawContent = false
  let stopReason
  let usage

  for await (const event of readSse(response, { signal })) {
    const data = event.data
    if (!data || data === '[DONE]') continue
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    const kind = event.event ?? payload.type
    if (kind === 'ping') continue
    if (kind === 'error' || payload.type === 'error') {
      const error = new Error(`anthropic: ${payload.error?.message ?? payload.message ?? 'stream error'}`)
      error.code = 'SERVER'
      throw error
    }

    switch (kind) {
      case 'message_start': {
        if (payload.message?.usage) usage = { ...(usage ?? {}), ...normaliseUsage(payload.message.usage) }
        break
      }
      case 'content_block_start': {
        const index = payload.index ?? 0
        const block = payload.content_block ?? {}
        accumulators.set(index, {
          type: block.type,
          text: typeof block.text === 'string' ? block.text : '',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          id: block.id,
          name: block.name,
          json: '',
        })
        sawContent = true
        yield {
          type: 'block-start',
          index,
          blockType: block.type === 'tool_use' ? 'tool-call' : block.type === 'thinking' ? 'reasoning' : 'text',
        }
        if (block.type === 'tool_use') {
          yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: '' }
        }
        break
      }
      case 'content_block_delta': {
        const index = payload.index ?? 0
        const delta = payload.delta ?? {}
        const slot = accumulators.get(index) ?? { type: 'text', text: '', thinking: '', json: '' }
        accumulators.set(index, slot)
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          slot.text += delta.text
          sawContent = true
          yield { type: 'text-delta', index, text: delta.text }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          slot.thinking += delta.thinking
          sawContent = true
          yield { type: 'reasoning-delta', index, text: delta.thinking }
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          slot.json += delta.partial_json
          yield { type: 'tool-call-delta', index, argumentsDelta: delta.partial_json }
        }
        // signature_delta 只对回放有意义，DSH 侧不需要。
        break
      }
      case 'content_block_stop': {
        const index = payload.index ?? 0
        const slot = accumulators.get(index)
        accumulators.delete(index)
        yield { type: 'block-end', index, block: blockFromSlot(slot) }
        break
      }
      case 'message_delta': {
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
        if (payload.usage) usage = { ...(usage ?? {}), ...normaliseUsage(payload.usage) }
        break
      }
      default:
        break
    }
  }

  // 上游没发 content_block_stop 就把剩下的收尾，别把内容丢掉。
  for (const [index, slot] of accumulators) {
    yield { type: 'block-end', index, block: blockFromSlot(slot) }
  }

  if (!sawContent && stopReason !== 'tool_use') {
    const error = new Error('anthropic: the response completed without any content block')
    error.code = 'EMPTY_RESPONSE'
    throw error
  }
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: finishKind(stopReason) } }
}

/** 累积器 → DSH 的完整块对象。 */
function blockFromSlot(slot) {
  if (!slot) return { type: 'text', text: '' }
  if (slot.type === 'tool_use') {
    return { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.json.length > 0 ? slot.json : '{}' }
  }
  if (slot.type === 'thinking') return { type: 'reasoning', text: slot.thinking }
  return { type: 'text', text: slot.text }
}

/** Anthropic 的 usage 字段名 → DSH 的 usage 字段名。 */
function normaliseUsage(usage) {
  const out = {}
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens
  if (typeof usage.cache_read_input_tokens === 'number') out.cachedInputTokens = usage.cache_read_input_tokens
  if (typeof usage.cache_creation_input_tokens === 'number') {
    out.cacheCreationInputTokens = usage.cache_creation_input_tokens
  }
  return out
}

export { CLAUDE_CODE_IDENTITY }
