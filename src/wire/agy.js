/**
 * `agy --output-format stream-json` 的线协议翻译层。
 *
 * 这里是**纯函数**，不碰子进程，所以能用录下来的真实 NDJSON 直接测。
 * 协议是从 agy 1.2.8 实测抄下来的（见 m01730 段的抓包），三种事件：
 *
 * ```jsonc
 * {"event":"init","conversation_id":"…","init":{"cwd":"…","permission_mode":"request-review","tools":[…57 个…]}}
 * {"event":"step_update","step_update":{"conversation_id":"…","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"PONG"}}
 * {"event":"step_update","step_update":{"conversation_id":"…","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","usage":{…}}}
 * {"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"PONG\n","num_turns":1,"usage":{…}}}
 * ```
 *
 * 三个咬过人的细节（都在下面各函数里有对应处理）：
 * 1. **`state:"DONE"` 那一条也带 `text_delta`**（实测尾片段是 `"\n"`），
 *    当成纯终止符会把最后一段文字吞掉；
 * 2. **`conversation_id` 是 snake_case**，社区实现读的是 camelCase `conversationId`，
 *    两种都要认；
 * 3. **上游把失败写在 `result.status` 里**，进程退出码仍是 0 ⇒ 不能只看退出码。
 *
 * @module dsh-account-bridge/wire/agy
 */

/** 把 `agy models` 的表格输出解析成 `[{id, name}]`。 */
export function parseModels(stdout) {
  const models = []
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || !line.includes('\t')) continue
    const [idPart, ...rest] = line.split('\t')
    const id = idPart.trim()
    const name = rest.join(' ').trim()
    // 模型 id 的形态：小写字母数字与 `.` `-`，实测 14 个全都含 `-`。
    // 只认这个形态，进度条与警告行自然被滤掉。
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || !id.includes('-')) continue
    models.push({ id, name: name || id })
  }
  return models
}

/** 把 DSH 的 system + messages 摊平成一段给 agy 的提示词。 */
export function buildPrompt({ system, messages }) {
  const parts = []
  if (typeof system === 'string' && system.trim()) parts.push(system.trim())
  const turns = []
  for (const message of messages ?? []) {
    const text = messageText(message)
    if (!text) continue
    const role = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User'
    turns.push(`${role}: ${text}`)
  }
  if (turns.length > 0) parts.push(turns.join('\n\n'))
  return parts.join('\n\n---\n\n')
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  const blocks = Array.isArray(content) ? content : Array.isArray(message?.blocks) ? message.blocks : null
  return blocks ? blocksText(blocks) : ''
}

/**
 * DSH 的块数组 → 纯文本。工具调用与图片转成占位行：agy 看不见它们，
 * 但**必须让模型知道那里发生过事**，否则它会以为对话是连贯的。
 */
function blocksText(blocks) {
  const out = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'tool-call') out.push(`[tool call ${block.name ?? '?'}]`)
    else if (block.type === 'tool-result') out.push(`[tool result ${block.name ?? '?'}]`)
    else if (block.type === 'image') out.push('[image omitted]')
  }
  return out.join('\n')
}

/** agy 的 usage（snake_case）→ DSH 的 usage 字段名。 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const out = {}
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens
  if (typeof usage.cache_read_tokens === 'number') out.cachedInputTokens = usage.cache_read_tokens
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * agy 的错误文本 → 账号池的失败分类（`src/health.js` 的 `classifyFailure` 认这些码）。
 * 上游只给一段人话，所以按关键词分；分不出来的按 `SERVER`（换号 + 短暂冷却）。
 */
export function classifyAgyFailure(message, exitCode, { empty = false } = {}) {
  const text = String(message ?? '')
  if (empty) return 'EMPTY_RESPONSE'
  if (/not logged into|please sign in|unauthor|permission denied|invalid_grant/i.test(text)) return 'AUTH'
  if (/quota|rate limit|resource_exhausted|\b429\b/i.test(text)) return 'RATE_LIMIT'
  if (/EOF|ECONNRESET|socket hang up|ETIMEDOUT|network|fetch failed|streamGenerateContent/i.test(text)) {
    return 'TRANSPORT'
  }
  if (/timeout|timed out/i.test(text)) return 'TIMEOUT'
  if (exitCode !== 0 && exitCode !== null) return 'SERVER'
  return 'SERVER'
}

/**
 * 把 agy 的 NDJSON 行流翻译成 DSH 的 stream chunk。
 *
 * @param {AsyncIterable<string>|Iterable<string>} lines
 * @returns {AsyncGenerator<object>} DSH chunk：`block-start` / `text-delta` / `block-end` / `usage` / `finish`
 */
export async function* translateAgyStream(lines) {
  let text = ''
  let opened = false
  let usage
  let failure
  let conversationId
  let sawResult = false

  const open = function* () {
    if (opened) return
    opened = true
    yield { type: 'block-start', index: 0, blockType: 'text' }
  }

  for await (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // agy 会把进度噪音、认证横幅混进 stdout；不认识的行跳过，不当致命错误。
      continue
    }

    if (event.event === 'init') {
      conversationId ??= firstString(event.conversation_id, event.init?.conversation_id)
      continue
    }

    if (event.event === 'step_update') {
      const step = event.step_update ?? {}
      conversationId ??= firstString(step.conversation_id)
      if (step.usage && typeof step.usage === 'object') usage = step.usage
      // 只认 agent_response：user_input / tool / error_message 都不是给用户看的正文。
      if (step.step_type !== 'agent_response') continue
      const delta = typeof step.text_delta === 'string' ? step.text_delta : ''
      if (!delta) continue
      yield* open()
      text += delta
      yield { type: 'text-delta', index: 0, text: delta }
      continue
    }

    if (event.event === 'result') {
      const result = event.result ?? {}
      sawResult = true
      conversationId ??= firstString(result.conversation_id)
      if (result.usage && typeof result.usage === 'object') usage = result.usage
      if (result.status === 'ERROR') failure = firstString(result.error) ?? 'agy reported an error'
      // `result.response` 是最终完整文本。若它比我们流出来的长（中间步骤被静默、
      // 或者增量事件丢了），补上缺的那一截 —— 绝不静默少给正文。
      const final = firstString(result.response)
      if (final && final.length > text.length) {
        const missing = final.slice(text.length)
        yield* open()
        text = final
        yield { type: 'text-delta', index: 0, text: missing }
      }
    }
  }

  if (opened) yield { type: 'block-end', index: 0, block: { type: 'text', text } }

  const mapped = mapUsage(usage)
  if (mapped) yield { type: 'usage', usage: mapped }

  if (failure) {
    const error = new Error(`agy: ${failure}${conversationId ? ` (conversation ${conversationId})` : ''}`)
    error.code = classifyAgyFailure(failure, 0)
    throw error
  }
  if (!text.trim()) {
    const error = new Error('agy returned no text')
    error.code = 'EMPTY_RESPONSE'
    error.sawResult = sawResult
    throw error
  }

  yield { type: 'finish', reason: { kind: 'stop' } }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}
