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
 * - 开了 extended thinking 之后，**带签名的思考块必须完整带回去**（见 `wire/replay.js`）。
 *   这一半默认只**记录**不回放：跨账号能不能用签名我们没验过，本机也没有订阅能验。
 * @module dsh-account-bridge/wire/anthropic
 */

import { readSse } from './sse.js'
import { mergeUsageNonZero } from './usage.js'
import { ANTHROPIC_REPLAY_KIND, makeEnvelope, replayValue } from './replay.js'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * Claude Code 的身份块。订阅端点的请求会带 `x-app: cli` 与 CLI 的 UA，
 * 这一段让 system 的第一块与其一致。
 *
 * **不许在这句话里添加任何自我说明。** 原文曾经以
 * "…, running within the DeepSeek Harness account bridge." 结尾，那等于在第一段 system 里
 * 主动告诉上游「这不是 Claude Code，是一个第三方桥」。magpie 的记录里，
 * Anthropic 正是把「另一个 agent 的系统提示」判成第三方流量的；AstrLink 的 AGENTS 铁律
 * 也要求不许把自家品牌注入上游。身份要么整套装成客户端，要么一个字段都别装。
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

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

/**
 * 顶层 `system` 数组：身份块 + 显式 system 提示 + 对话开头的 system 消息。
 *
 * `identity` 可覆盖身份块。`claude` / `minimax` 族走的是**官方**端点，声明身份是必须的；
 * 而 `generic` 族连的是任意兼容端点，往那儿塞一句「我是 Claude Code」就是撒谎，
 * 所以它传空串把这一块去掉。
 */
export function toAnthropicSystem(system, messages = [], { identity = CLAUDE_CODE_IDENTITY } = {}) {
  const blocks = []
  if (typeof identity === 'string' && identity.length > 0) blocks.push({ type: 'text', text: identity })
  if (typeof system === 'string' && system.length > 0) blocks.push({ type: 'text', text: system })
  for (const message of messages.slice(0, conversationStart(messages))) {
    for (const block of message.content ?? []) {
      if (block?.type === 'text') blocks.push({ type: 'text', text: block.text })
    }
  }
  if (blocks.length === 0) return blocks
  // tools 渲染在 system 之前，所以这一个标记同时缓存两者。
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }
  return blocks
}

/**
 * DSH 消息 → Anthropic `messages`。
 *
 * `cache` 控制要不要打 prompt-cache 断点。官方端点认 `cache_control`，但任意兼容端点
 * 未必认（有的会对未知字段直接 400），所以 `generic` 族传 false。
 *
 * `replay` 控制要不要把**带签名的思考块**放回助手轮（默认 false，见文件头）。
 * 只有签名在手上时才放：Anthropic 对「没有签名的 thinking 块」是直接拒的，
 * 而放一个空签名的块等于把「这里本来有思考」这件事说给上游听却拿不出证据。
 * 没有签名时这个块**整个跳过**——那是这一族从第一天起的既有行为。
 */
export function toAnthropicMessages(messages, { cache = true, replay = false } = {}) {
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

    for (const [blockIndex, block] of (message.content ?? []).entries()) {
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
        case 'reasoning': {
          // 默认整块跳过（这一族以前就是这么做的）。开了回放也只有签名在手上才放。
          if (!replay || role !== 'assistant') break
          const signature = replayValue(message, ANTHROPIC_REPLAY_KIND, blockIndex, undefined)
          if (signature === undefined) break
          blocks.push({ type: 'thinking', thinking: block.text ?? '', signature })
          break
        }
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
  if (cache) markMessageCache(out)
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
 *
 * `pause_turn` 归 `'max-tokens'` 而不是 `'stop'`：它的意思是「这一轮被**服务端工具**
 * 暂停了，把响应原样发回来就能接着跑」——也就是**模型没说完**。归成 `'stop'` 的话宿主
 * 认为这是一次正常收尾，用户拿到一段被截断的答案而界面上看不出任何异常。
 * RelayKit 的 `reasonmap` 也是把它映射成 `length`，理由写得很直白：**可续跑 ≠ 正常结束**。
 *
 * 不认识的 stop_reason **照样回 `'stop'`**（不许因为不认识就抛：那会把一次可用的回答
 * 变成一次失败），但会通过 `report` 上报一条诊断——上游加了新值而我们没跟上，
 * 这种事只有留痕才有机会被发现。
 */
function finishKind(stopReason, report) {
  switch (stopReason) {
    case 'tool_use':
      return 'tool-calls'
    case 'max_tokens':
      return 'max-tokens'
    case 'pause_turn':
      return 'max-tokens'
    case 'refusal':
      return 'error'
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    default:
      if (stopReason !== undefined && stopReason !== null && stopReason !== '') {
        report?.({
          code: 'UNKNOWN_STOP_REASON',
          severity: 'warning',
          message: `anthropic: unknown stop_reason "${stopReason}", reported as a normal stop`,
          detail: { raw: stopReason },
        })
      }
      return 'stop'
  }
}

/**
 * Anthropic SSE 流 → DSH chunk 流。
 *
 * 事件名与载荷是公开且稳定的 Anthropic 流式协议：
 * `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` /
 * `message_delta` / `message_stop` / `ping` / `error`。
 *
 * `onDiagnostic` 是**只上报、不改变行为**的旁路：翻译层发现「上游说了我们看不懂的话」
 * 时把它记下来，但绝不因此改变 chunk 序列。不传就是没有观察者，什么都不发生。
 *
 * `model` 是本次请求的模型 id。给了它，收尾就会带一个 `replayState`（见 `wire/replay.js`）；
 * 不给就不带——`response.model` 必须是逐字对得上的字符串，瞎填一个只会让宿主最后一刻把
 * 整个信封丢掉，还不如一开始就不写。
 */
export async function* translateAnthropicStream(response, { signal, onDiagnostic, model } = {}) {
  // 每个 block index 一份累积器：`block-end` 必须携带**完整**块对象。
  const accumulators = new Map()
  /**
   * 块出现过的顺序（不是留下的顺序）。
   *
   * `content_block_stop` 会把累积器删掉，所以「还有哪些块」不能从 Map 里看；
   * 而 `finish.replayState.blocks` 必须与宿主见过的那串块**位置一一对齐**，
   * 包括它后来因为 `max-tokens` 丢掉的工具调用块（宿主按同样的位置过滤信封，
   * 我们少留一个占位，整个信封就会被它判成「对不上」丢掉）。见 `wire/replay.js` 文件头。
   *
   * **必须在「每一次带 index 的 chunk 出口」上都碰一下**，而不只是在 `content_block_start`：
   * 宿主那边是每收到一个带 index 的 chunk 就 `ensure(index)` 一次，我们漏记一个，
   * 信封的块数就和它对不上，整个信封被丢掉——而且是**静默**丢掉。
   */
  const order = []
  /** index → 要带回去的那一小段（只有 reasoning 块有签名）。 */
  const replaySlots = new Map()
  const touch = (index) => {
    if (order.includes(index)) return
    order.push(index)
    // 每个「出现过的块」都要在信封里占一个位置；类型按累积器认，宿主那边
    // 是按第一个带 index 的 chunk 的 blockType 记的，两边必须一致。
    if (!replaySlots.has(index)) {
      replaySlots.set(index, { type: replayBlockType(accumulators.get(index)?.type) })
    }
  }
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
    // `readSse` 在没有 `event:` 行时会填 SSE 的默认事件名 `message`，而 Anthropic 的
    // 事件名里没有叫 `message` 的——所以那是「上游没发事件名」，不是真有个事件叫它。
    // 少了这一步，`?? payload.type` 是永远走不到的死代码：自建中转常常只发 `data:`，
    // 而它们照样在 payload 里写 `type`。
    const kind = event.event === 'message' || event.event === undefined ? payload.type : event.event
    if (kind === 'ping') continue
    if (kind === 'error' || payload.type === 'error') {
      const error = new Error(`anthropic: ${payload.error?.message ?? payload.message ?? 'stream error'}`)
      error.code = 'SERVER'
      throw error
    }

    switch (kind) {
      case 'message_start': {
        if (payload.message?.usage) usage = mergeUsageNonZero(usage, normaliseUsage(payload.message.usage))
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
        touch(index)
        // 有的上游把签名放在起始块上（而不是后面跟一串 signature_delta）。
        replaySlots.set(index, {
          type: replayBlockType(block.type),
          ...(typeof block.signature === 'string' && block.signature.length > 0
            ? { signature: block.signature }
            : {}),
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
        // 上游没发 content_block_start 就来了 delta（畸形流，但会真的发生）：
        // 类型必须从 delta 自己推，不能一律当 text——宿主的块类型是从
        // **第一个带 index 的 chunk** 上取的，猜错会让块与信封都对不上。
        const fallback =
          delta.type === 'thinking_delta' || delta.type === 'signature_delta'
            ? 'thinking'
            : delta.type === 'input_json_delta'
              ? 'tool_use'
              : 'text'
        const slot = accumulators.get(index) ?? { type: fallback, text: '', thinking: '', json: '' }
        accumulators.set(index, slot)
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          slot.text += delta.text
          sawContent = true
          touch(index)
          yield { type: 'text-delta', index, text: delta.text }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          slot.thinking += delta.thinking
          sawContent = true
          touch(index)
          yield { type: 'reasoning-delta', index, text: delta.thinking }
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          slot.json += delta.partial_json
          touch(index)
          yield { type: 'tool-call-delta', index, argumentsDelta: delta.partial_json }
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          // 只对回放有意义：DSH 侧不需要它，但要照原样存下来给下一轮带回去。
          touch(index)
          const entry = replaySlots.get(index)
          if (entry) entry.signature = (entry.signature ?? '') + delta.signature
        }
        break
      }
      case 'content_block_stop': {
        const index = payload.index ?? 0
        const slot = accumulators.get(index)
        accumulators.delete(index)
        touch(index)
        yield { type: 'block-end', index, block: blockFromSlot(slot) }
        break
      }
      case 'message_delta': {
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
        if (payload.usage) usage = mergeUsageNonZero(usage, normaliseUsage(payload.usage))
        break
      }
      default:
        break
    }
  }

  // 上游没发 content_block_stop 就把剩下的收尾，别把内容丢掉。
  for (const [index, slot] of accumulators) {
    touch(index)
    yield { type: 'block-end', index, block: blockFromSlot(slot) }
  }

  if (!sawContent && stopReason !== 'tool_use') {
    const error = new Error('anthropic: the response completed without any content block')
    error.code = 'EMPTY_RESPONSE'
    throw error
  }
  if (usage) yield { type: 'usage', usage }
  const reason = { kind: finishKind(stopReason, onDiagnostic) }
  const replayState = replayEnvelope(order, replaySlots, model)
  yield { type: 'finish', reason, ...(replayState === undefined ? {} : { replayState }) }
}

/** 上游块类型 → DSH 块类型（信封里的 `type` 必须和内容块的 `type` 逐字相同）。 */
function replayBlockType(type) {
  if (type === 'thinking') return 'reasoning'
  if (type === 'tool_use') return 'tool-call'
  return 'text'
}

/**
 * 攒一个信封——**只在真有东西要带回去的时候**。
 *
 * 没有签名（没开 thinking、或上游压根没发思考块）时返回 `undefined`：一个空壳信封
 * 会跟着每一条助手消息存进会话文件，换不来任何东西。有签名时 `blocks` 必须与
 * `order` 一一对齐，见 `wire/replay.js` 文件头。
 */
function replayEnvelope(order, slots, model) {
  if (typeof model !== 'string' || model.length === 0) return undefined
  const blocks = order.map((index) => {
    const entry = slots.get(index)
    const type = entry?.type ?? 'text'
    const signature = entry?.signature
    return {
      type,
      ...(typeof signature === 'string' && signature.length > 0 ? { signature } : {}),
    }
  })
  if (!blocks.some((block) => typeof block.signature === 'string')) return undefined
  return makeEnvelope(ANTHROPIC_REPLAY_KIND, model, blocks)
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
