/**
 * `replayState`：上游要求「原样带回来」的协议状态。
 *
 * 有些上游不是「发完就完了」：Anthropic 开了 extended thinking 之后，**带签名的思考块
 * 必须完整未修改地出现在下一轮的助手轮里**，否则要么 400，要么助手轮以 `tool_use`
 * 开头——一个「不带思考的工具调用」，那正是它拒绝的形状。Responses 线同理，只是它要的
 * 不是签名而是 `encrypted_content`。
 *
 * DSH 为这件事留了一个**对适配器不透明**的口袋：`finish` 块上可以带
 * `replayState`，宿主把它原样存进 `message.source.replayState` 并持久化，下一轮再把
 * 那条消息原样交回来。契约（读宿主源码得到，见 `@deepseek-ai/dsh-llm`）：
 *
 * 1. `BlockAssembler.push` 把 `chunk.replayState` **原样收下**，不做任何 schema 校验；
 * 2. 但 `assembled()` 会拿 `envelope.blocks.length` 和**它自己见过的块数**对一下，
 *    对不上就把整个信封丢掉 ⇒ `blocks` 必须与**流里出现过的块**一一对齐，
 *    而且是「见过的顺序」，不是「留下的顺序」（`max-tokens` 会丢掉工具调用块，
 *    那时宿主**按同样的位置**过滤信封，所以我们照样要为被丢的块留一个占位）；
 * 3. `forAdapter()` 只在「历史那条路由属于**另一个**适配器」时才剥掉它。我们 11 条
 *    route 共用同一个 adapter 对象 ⇒ **宿主不会替我们把 codex 写下的信封挡在 claude 前面**，
 *    `kind` 必须自己查。
 *
 * 所以这一份的校验原则只有一条：**读不懂就是没有**（绝不抛错）。签名对不上、
 * 版本不认识、块数不齐、模型换了——统统一声不响地降级成「不带这个状态」，
 * 宁可让上游重新生成一次思考，也不要拿一个可疑的东西去换一个 400。
 *
 * @module dsh-account-bridge/wire/replay
 */

/** 信封版本。形状变了就 +1；读到别的版本一律当没有。 */
export const REPLAY_VERSION = 1

/** Anthropic Messages 线的信封种类。 */
export const ANTHROPIC_REPLAY_KIND = 'account-bridge/anthropic-messages'

/** OpenAI Responses 线的信封种类。 */
export const RESPONSES_REPLAY_KIND = 'account-bridge/responses'

/**
 * 每种信封里那个「要原样带回去的字符串」叫什么。
 *
 * 两个种类**不共用字段名**是刻意的：名称一样会让「codex 的信封被 claude 读走」
 * 这件事在 `kind` 检查之外还有第二条看不见的路。
 */
const FIELDS = {
  [ANTHROPIC_REPLAY_KIND]: 'signature',
  [RESPONSES_REPLAY_KIND]: 'encryptedContent',
}

/**
 * 拼一个信封。
 *
 * `blocks` 必须与流里**出现过**的块一一对齐（含被 max-tokens 丢掉的工具调用块），
 * 见文件头第 2 条。
 *
 * @param {string} kind
 * @param {string} model 本次请求的模型 id——宿主按「逐字相等」判跨模型，见文件头
 * @param {Array<object>} blocks
 * @returns {{response: {kind: string, version: number, model: string}, blocks: Array<object>}}
 */
export function makeEnvelope(kind, model, blocks) {
  return { response: { kind, version: REPLAY_VERSION, model }, blocks }
}

/** 是不是一个「像信封」的对象（不校验内容）。 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 `message.source.replayState` 校验成一个可用的信封。
 *
 * **永不抛错**：任何一处不对都返回 `undefined`，调用方照「没有这个状态」走。
 *
 * @param {object} message 历史里的助手消息
 * @param {string} kind 期望的种类
 * @param {string} [model] 本次请求的模型；给了就要求信封里的模型与它逐字相等
 * @returns {Array<object> | undefined} 与 `message.content` 对齐的块数组
 */
export function readReplay(message, kind, model) {
  if (!message || message.role !== 'assistant') return undefined
  const source = message.source
  // `kind: 'model'` 是宿主给「模型产出的消息」打的标；别的来源（用户、工具）本来就没有。
  if (!isObject(source) || source.kind !== 'model') return undefined
  const envelope = source.replayState
  if (!isObject(envelope)) return undefined
  const response = envelope.response
  if (!isObject(response)) return undefined
  // 别的族（或别的版本）写下的信封——`forAdapter()` 不会替我们挡，只能自己查。
  if (response.kind !== kind) return undefined
  if (response.version !== REPLAY_VERSION) return undefined
  if (typeof response.model !== 'string' || response.model.length === 0) return undefined
  // 签名与模型绑定：跨模型的签名不可移植（宿主的校验原话是
  // "model does not match assistant source model"）。
  if (response.model !== source.model) return undefined
  if (model !== undefined && response.model !== model) return undefined
  const blocks = envelope.blocks
  const content = message.content
  if (!Array.isArray(blocks) || !Array.isArray(content)) return undefined
  // 块数对不上 ⇒ 这条记录属于另一个版本的这条消息，整条丢弃（不做「尽量对齐」）。
  if (blocks.length !== content.length) return undefined
  return blocks
}

/**
 * 取第 `index` 个块上「要原样带回去的那个字符串」。
 *
 * 只有 `reasoning` 块能带它，而且必须是**非空字符串**：空串在 Anthropic 那边是
 * 「签名缺失」，带回去等于没带，还多占一个块的位置。
 *
 * @param {object} message
 * @param {string} kind
 * @param {number} index
 * @param {string} [model]
 * @returns {string | undefined}
 */
export function replayValue(message, kind, index, model) {
  const blocks = readReplay(message, kind, model)
  if (!blocks) return undefined
  const block = blocks[index]
  const content = message.content?.[index]
  if (!isObject(block) || !isObject(content)) return undefined
  // 块的种类必须与内容一一对上，否则这个下标上的东西已经不是当初那个块了。
  if (block.type !== content.type) return undefined
  if (content.type !== 'reasoning') return undefined
  const value = block[FIELDS[kind]]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 取第 `index` 个块上那个「整份带回去」的对象（Responses 线要 `id` 与加密内容一起）。
 *
 * @param {object} message
 * @param {number} index
 * @param {string} [model]
 * @returns {{id?: string, encryptedContent: string} | undefined}
 */
export function replayItem(message, index, model) {
  const blocks = readReplay(message, RESPONSES_REPLAY_KIND, model)
  if (!blocks) return undefined
  const block = blocks[index]
  const content = message.content?.[index]
  if (!isObject(block) || !isObject(content)) return undefined
  if (block.type !== content.type || content.type !== 'reasoning') return undefined
  const encrypted = block[FIELDS[RESPONSES_REPLAY_KIND]]
  if (typeof encrypted !== 'string' || encrypted.length === 0) return undefined
  return {
    ...(typeof block.id === 'string' && block.id.length > 0 ? { id: block.id } : {}),
    encryptedContent: encrypted,
  }
}
