/**
 * OpenCode Zen 的纯函数协议层——端点常量、两份目录的解析与并集、失败归类。
 *
 * **SSE 翻译刻意不在这里**：`POST /zen/v1/chat/completions` 是标准 OpenAI 兼容
 * `chat.completion.chunk` + `data: [DONE]`，无信封、无加密、无格式转换
 * ⇒ 直接复用 `./chat-completions.js` 的 `translateChatStream`，不为「对称」再抄一份翻译器。
 *
 * ## 一、这一族是**两份目录的交集**，而不是一份
 *
 * 上游 `GET /zen/v1/models` 只回 `id` / `object` / `created` / `owned_by` **四个字段**
 * ——里面**没有任何能力信息**（没有上下文窗口、没有模态、没有是否支持工具调用）。
 * 能力元数据只存在于第三方 `https://models.dev/api.json` 的 `opencode` 条目里。
 *
 * 所以本文件的两个解析器必须**分开**、并集规则必须显式：
 * - `parseZenModels` —— 「这把凭据**有权限用**哪些模型」的唯一判据（上游自己裁的目录）；
 * - `parseModelsDev` —— 「这些模型**有什么能力**」的唯一来源；
 * - `mergeCatalogs` —— **上游目录是集合的边界**：models.dev 里有、上游目录里没有的模型
 *   **不出现**（那是「别人有权用、你没有」）；上游目录里有、models.dev 里没有的**要出现**
 *   （用保守元数据，见 `CONSERVATIVE_CONTEXT_WINDOW`）。
 *
 * ## 二、`/models` 不鉴权，所以它**不能**用来判断凭据有效
 *
 * 本仓真机捕获：`GET /zen/v1/models` **不带** `Authorization` ⇒ 200 / **87 条**；
 * 带**乱写的** key ⇒ 200 / **87 条**；带本机真 key ⇒ 200 / **13 条**。
 * 同一个状态码，只有**条数**不同——上游认不出凭据时把**公共目录**发下来。
 * ⇒ 「HTTP 200」在这里完全不能证明凭据可用；判据只能是**目录被裁剪过**，
 * 而那是一个会随上游目录演化而失效的形状判据，所以本文件**不实现**基于它的凭据校验，
 * 只把事实写在这里（`src/families/opencode.js` 的 `validateCredential` 另走一条硬判据）。
 *
 * ## 三、免费档对第三方客户端**关闭**，而且这道门比请求头更深
 *
 * 本仓真机捕获：免费模型（`-free` 结尾）`POST /chat/completions` ⇒ **403**
 * `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}`。
 * 参考实现记录了匿名通道要用的指纹头（`x-opencode-client: cli` 等），
 * **本仓照实现补齐之后仍然 403** ⇒ 那道门比请求头深。
 * 所以本文件**不构造任何 `x-opencode-*` 指纹**：伪造一个已经被证伪的客户端身份
 * 只是自欺——它换不来通道，却会让我方请求看起来像在冒充一个特定客户端。
 * 免费档因此**默认被滤出选择器**（`excludeFree`），理由见 `isFreeTier` 的注释。
 *
 * ## 四、网关**只校验 `model` 字段**，请求体的其余部分原样透传
 *
 * 这一条是本仓探针**纠正简报假设**的结论，很重要，因为它决定了「探不到就写未验」：
 * 简报假设「402 = 请求被接受、400 = 形状被拒」，于是可以在没钱的 key 上探清请求形状。
 * 实测**不成立**：付费档上连**故意非法**的请求（`messages:"nope"`、`messages:[]`、
 * 完全不发 `messages`、`max_tokens:"eight"`、`tools:"nope"`、`temperature:2.5`、
 * 未知顶层字段 `nonsense:1`、非法 `reasoning_effort:"turbo"`、`stream_options:"yes"`）
 * **全部回 402**；免费档上同样这批形状**全部回 403 FreeTierError**。
 * ⇒ 网关在计费与免费闸之前**不做任何请求体校验**，拒因来自上游 provider，
 * 而 provider 在没钱时被 402 掩盖。
 * ⇒ 「上游接受不接受某个字段」**在本仓的凭据条件下探不出来**，所有相关字段一律标**未验**。
 *
 * ## 五、两个「401」不是鉴权失败，照状态码归类会停账号 24 小时
 *
 * `src/wire/http-error.js` 的 `mapStatus` 把 401/403 判成 `AUTH`，而
 * `src/health.js` 的 `classifyFailure` 对 `AUTH` 的处置是
 * **换号 + 冷却 24 小时 + 罚该账号**。但有两条与凭据毫无关系：
 * - `model` 缺失或空串 ⇒ **401** `{"type":"error","error":{"type":"ModelError","message":"Model  is not supported"}}`
 *   （注意 `Model` 与 `is` 之间是**两个空格**——这是上游拼串的原始形状）；
 * - 非法的 `model`（`no-such-model-xyz`）⇒ **400** `{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}`。
 *
 * 前者若不改归类，用户把模型名写错一次就会让一个**完全健康**的账号被冷 24 小时。
 * 所以 `classifyOpencodeFailure` **先按信封里的 `error.type` 判、再看状态码**
 * （顺序与 `failure-words.js` 那条「401/403 先判状态码」的教训方向相反，因为这里的
 * 证据不是状态码而是**结构字段**——`ModelError` / `FreeTierError` 是上游自己给的名字）。
 *
 * 本文件的协议事实全部来自本仓自己的真机探针（脚本在仓外，逐字报文见
 * `THIRD_PARTY_NOTICES.md` 的「本仓自己真机捕获」一节）。
 * @module dsh-account-bridge/wire/opencode
 */

import { mapStatus } from './http-error.js'

/** Zen 网关基址（`https://opencode.ai/zen/v1`）。 */
export const OPENCODE_ZEN_BASE = 'https://opencode.ai/zen/v1'

/** 模型目录端点。⚠ **不鉴权**：条数才是凭据被判没被认得的信号（见文件头第二节）。 */
export const OPENCODE_MODELS_URL = `${OPENCODE_ZEN_BASE}/models`

/** 对话端点（标准 OpenAI 兼容 + 标准 SSE）。 */
export const OPENCODE_CHAT_URL = `${OPENCODE_ZEN_BASE}/chat/completions`

/** 第三方能力表。它是**别人的服务**，所以拉取一律 best-effort（见 `src/families/opencode.js`）。 */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** models.dev 里本族的 provider 键。 */
export const MODELS_DEV_PROVIDER = 'opencode'

/**
 * 能力表拉取的 TTL（60 分钟）。
 *
 * 依据是 models.dev 自己给每条模型记的 `last_updated`：本仓 2026 年拉下来的那一份里，
 * 120 条模型的 `last_updated` 分布以「天」为粒度 ⇒ 一小时一次足够新，
 * 又不至于在每个请求里打一次第三方（`resolveModelInfo` 是热路径）。
 */
export const MODELS_DEV_TTL_MS = 60 * 60_000

/**
 * 目录与元数据里读不到上下文窗口时的兜底值。
 *
 * **它是保守估计，不是实测值**：本仓真机复核的 13 条授权模型里，12 条在 models.dev
 * 有条目，`limit.context` 最小 **200000**、最大 1050000（缺条目的是 `jev-1.13-free`）。
 * 取**下限**当兜底：报小了只是让宿主提前截断，报大了会发出上游必然拒绝的请求。
 */
export const CONSERVATIVE_CONTEXT_WINDOW = 200_000

/**
 * 输出上限的兜底值。
 *
 * 同样取保守侧：那 12 条的 `limit.output` 实测最小 **32000**。
 * 这里给 8192 而不是 32000，是因为 `max_tokens` 由 DSH 跨 provider 带过来
 * （契约 §5 的 `maxTokens` 没有上限校验），报大了一次就会把别人的参数原样顶到上游。
 */
export const CONSERVATIVE_MAX_TOKENS = 8_192

/**
 * 免费档的**辅助**判据：模型 id 以 `-free` 结尾。
 *
 * ⚠ **它只是辅助证据，主判据是 models.dev 的 `cost`**（见 `isFreeTier`）。
 * 本仓真机复核的 13 条里，`-free` 后缀命中 8 条而 `cost` 判据命中 7 条，
 * 差的那一条正是 `jev-1.13-free`（**没有 models.dev 条目** ⇒ cost 判据拿不到数据）。
 * 换句话说：只认后缀会漏判（`grok-code` / `big-pickle` 在 models.dev 里
 * `cost` 全 0 却不带后缀），只认 cost 也会漏判（没有条目的模型读不到 cost）。
 * 两条一起用，但**报告时要能说出是哪一条命中的**。
 */
export const FREE_ID_SUFFIX = '-free'

/** 空值时也不要产生 NaN/负数：上游的 `created` 是 Unix 秒。 */
function finitePositive(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** 非负有限数（`cost` 的 0 是合法值，不能当「没有」）。 */
function finiteNonNegative(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

/**
 * 构造请求头。
 *
 * **只发真实客户端会发的东西**：`Authorization` 与 `Content-Type`。
 * ⚠ 刻意**不**发 `x-opencode-project` / `x-opencode-session` / `x-opencode-request` /
 * `x-opencode-client: cli` 这四个指纹头——本仓实测把参考实现记录的指纹算法**照实现补齐**
 * 之后免费档**仍然 403**，说明那道门不看请求头；发一个已被证伪的身份只会在日志里
 * 留下「我们在冒充某个客户端」的痕迹，换不来任何通道（文件头第三节）。
 *
 * @param {string} key Zen API key。空值 ⇒ 如实抛错，不构造一个 `Bearer undefined` 发出去。
 * @returns {Record<string,string>}
 */
export function opencodeHeaders(key, extra = {}) {
  const value = typeof key === 'string' ? key.trim() : ''
  if (value.length === 0) throw new Error('account-bridge: opencode 需要一个 Zen API key')
  return {
    authorization: `Bearer ${value}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...extra,
  }
}

/**
 * 解析 `GET /zen/v1/models`。
 *
 * 上游**只给四个字段**（本仓真机逐字：`{"id":"…","object":"model","created":1791724617,"owned_by":"opencode"}`），
 * 所以这里**只读出这四个**，不为「对称」补任何能力字段——补出来的字段会被下游
 * 当成上游说的，而 `docs/family-contract.md` §5.3 的规矩是「不知道的值宁可保守也不要编」。
 *
 * 形状容错：`data` 不是数组、条目没有字符串 `id` ⇒ 那一条丢掉；`id` 去重（保留先出现的）。
 * 返回**凭据被裁剪后**的目录（带真 key 13 条、不认得凭据时 87 条）。
 *
 * @param {unknown} json 已解析的响应体
 * @returns {Array<{id:string, ownedBy?:string, created?:number}>}
 */
export function parseZenModels(json) {
  const rows = Array.isArray(json?.data) ? json.data : []
  const seen = new Set()
  const models = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const model = { id }
    if (typeof row.owned_by === 'string' && row.owned_by.length > 0) model.ownedBy = row.owned_by
    const created = finitePositive(row.created)
    if (created !== undefined) model.created = created
    models.push(model)
  }
  return models
}

/**
 * 解析 `https://models.dev/api.json` 里 `opencode` 条目的能力表。
 *
 * 逐条读出 upstream 真正给的字段（本仓真机逐字见过的形状见
 * `THIRD_PARTY_NOTICES.md` 的 models.dev 那一行）：
 * `limit.context` / `limit.output` / `reasoning` / `reasoning_options` /
 * `modalities.input` / `modalities.output` / `attachment` / `tool_call` /
 * `structured_output` / `cost` / `name` / `family`。
 *
 * ⚠ **缺字段就是缺**，返回的对象里不会出现那个键（不填 `false`、不填 0）：
 * `cost` 缺失与 `cost` 全 0 是完全不同的两件事——后者是「确认免费」，
 * 前者是「不知道」，把它们归一成同一个值会让免费档悄悄进入选择器。
 *
 * @param {unknown} json 已解析的 `api.json`
 * @returns {Map<string, object>} 模型 id → 能力条目
 */
export function parseModelsDev(json) {
  const table = new Map()
  // ⚠ 真机形状：`https://models.dev/api.json` 的顶层**就是**「provider id → 条目」的字典
  // （本仓捕获：226 个 provider，顶层**没有** `providers` 这一层）。本函数只认这一种形状。
  // 早先这里写过一个 `json?.providers?.[id] ?? json?.[id]` 的「两形状兼容」，已删：
  // 那是**没有证据的猜测**，而它会把我自己写错形状的测试喂成绿的 —— 一个兼容分支
  // 不该建立在没上过真机的形状上（「读不出来」不等于「没有」，反过来也一样）。
  const entry = json?.[MODELS_DEV_PROVIDER]
  const rows = entry?.models
  const list = Array.isArray(rows) ? rows : Object.values(rows ?? {})
  for (const row of list) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id.length === 0) continue
    const model = {}
    if (typeof row.name === 'string' && row.name.length > 0) model.name = row.name
    if (typeof row.family === 'string' && row.family.length > 0) model.family = row.family
    const context = finitePositive(row.limit?.context)
    if (context !== undefined) model.contextWindow = context
    const output = finitePositive(row.limit?.output)
    if (output !== undefined) model.maxTokens = output
    if (typeof row.reasoning === 'boolean') model.reasoning = row.reasoning
    if (Array.isArray(row.reasoning_options)) {
      const types = row.reasoning_options
        .map((option) => (typeof option?.type === 'string' ? option.type : undefined))
        .filter((type) => type !== undefined)
      if (types.length > 0) model.reasoningOptions = types
    }
    if (typeof row.attachment === 'boolean') model.attachment = row.attachment
    if (typeof row.tool_call === 'boolean') model.toolCall = row.tool_call
    if (typeof row.structured_output === 'boolean') model.structuredOutput = row.structured_output
    const input = Array.isArray(row.modalities?.input)
      ? row.modalities.input.filter((value) => typeof value === 'string')
      : undefined
    if (input !== undefined && input.length > 0) model.inputModalities = input
    const out = Array.isArray(row.modalities?.output)
      ? row.modalities.output.filter((value) => typeof value === 'string')
      : undefined
    if (out !== undefined && out.length > 0) model.outputModalities = out
    // cost 三个量纲分开读：`cache_read` 读不到不影响 `input`/`output` 的判据。
    const cost = {}
    for (const [key, source] of [
      ['input', row.cost?.input],
      ['output', row.cost?.output],
      ['cacheRead', row.cost?.cache_read],
    ]) {
      const value = finiteNonNegative(source)
      if (value !== undefined) cost[key] = value
    }
    if (Object.keys(cost).length > 0) model.cost = cost
    // `release_date` / `last_updated` / `open_weights` / `temperature` / `canonical_model_id`
    // **刻意不读**：本仓没有任何消费点，读进来只会让「这是上游说的」这句话贬值。
    table.set(id, model)
  }
  return table
}

/**
 * 一份模型是不是**免费档**（对第三方客户端关闭的那一档）。
 *
 * 主判据是 **models.dev 的 `cost` 两个量纲都为 0**，因为那是「上游把它定价为 0」的
 * 结构化陈述；`-free` 后缀只作为**辅助证据**回填到 `via` 里。
 *
 * ⚠ 为什么默认要把免费档**滤出选择器**：本仓真机捕获免费模型一律 **403 FreeTierError**
 * （`OpenCode's free tier can only be used from within OpenCode`，补齐指纹头也一样）。
 * 一个必然失败的模型出现在选择器里，用户选中它得到的是一次失败的推理 ——
 * 而「不在选择器里」是一句能解释的话，见 README 的对应小节。
 *
 * ⚠ `via` 是**证据来源**不是置信度：`'cost'` 表示 models.dev 说它定价为 0；
 * `'id'` 表示只有后缀这一条证据（models.dev 没有条目，读不到 cost）。
 * 两条都命中时记 `'cost'`（结构化证据优先于命名约定）。
 *
 * @param {{id?:string, cost?:{input?:number, output?:number}}} model
 * @returns {{free:boolean, via?:'cost'|'id'}}
 */
export function isFreeTier(model) {
  const input = finiteNonNegative(model?.cost?.input)
  const output = finiteNonNegative(model?.cost?.output)
  // 两个量纲**都读到且都为 0** 才算免费：只读到一半就说「免费」会把
  // 「只有 cache_read 是 0」的付费模型停掉（那正是 `cost` 缺字段不能填 0 的理由）。
  if (input === 0 && output === 0) return { free: true, via: 'cost' }
  const id = typeof model?.id === 'string' ? model.id.trim().toLowerCase() : ''
  if (id.endsWith(FREE_ID_SUFFIX)) return { free: true, via: 'id' }
  return { free: false }
}

/**
 * 把免费档滤出目录。返回**新数组**（调用方常常同时持有未滤的那一份）。
 *
 * @template {{id:string, cost?:object}} T
 * @param {T[]} models
 * @returns {T[]}
 */
export function excludeFree(models) {
  const rows = Array.isArray(models) ? models : []
  return rows.filter((model) => !isFreeTier(model).free)
}

/**
 * 并集：**上游目录是边界**，models.dev 只提供能力。
 *
 * 三条规则（每一条都有理由，别合并）：
 * 1. 上游有、models.dev 有 ⇒ 用 models.dev 的能力字段，保留上游的 `ownedBy`/`created`；
 * 2. 上游有、models.dev **没有** ⇒ **照样出现**，只用上游那四个字段
 *    （本仓真机数据里实际命中 1 条：`jev-1.13-free` ——
 *    把它丢掉等于凭据说「你有权用」而我们说「没这个模型」）；
 * 3. models.dev 有、上游**没有** ⇒ **不出现**。这是「你有权用」的判据，
 *    上游已经按凭据裁过目录了，反向补进去就是在给用户看他用不了的模型。
 *
 * ⚠ 本函数**不**做免费档过滤：过滤是 `excludeFree` 的事，调用点显式写出来
 * （`src/families/opencode.js` 的 `listModels`）——把两个决定揉进一个函数
 * 会让「为什么这个模型没出现」在下一次排查时读不出来。
 *
 * @param {Array<{id:string}>} zen `parseZenModels` 的结果（**边界**）
 * @param {Map<string,object>} dev `parseModelsDev` 的结果（**能力**）
 * @returns {Array<object>} 已按 `id` 去重、顺序与上游目录一致
 */
export function mergeCatalogs(zen, dev) {
  const rows = Array.isArray(zen) ? zen : []
  const table = dev instanceof Map ? dev : new Map()
  const merged = []
  const seen = new Set()
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const known = table.get(id)
    merged.push(known === undefined ? { ...row } : { ...known, ...row, id })
  }
  return merged
}

/**
 * 把一份响应体里的错误信封拆出来。
 *
 * Zen 有**两种**错误信封（本仓真机逐字）：
 * - 带 `type` 的：`{"type":"error","error":{"type":"FreeTierError","message":"…"}}`
 *   ——`AuthError` / `FreeTierError` / `ModelError` 三种都走这个形状；
 * - 不带 `type` 的：`{"error":{"type":"server_error","message":"…"}}`
 *   ——上游 provider 的失败被网关包了一层（402 的 `Insufficient account funds` 是这个形状）。
 *
 * 两种都要认。解析不出来返回 `{}`，绝不编一个 `type`。
 *
 * @param {string} text
 * @returns {{type?:string, message?:string}}
 */
export function parseOpencodeEnvelope(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0) return {}
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    return {}
  }
  const error = json?.error
  const type = typeof error?.type === 'string' ? error.type : undefined
  const message = typeof error?.message === 'string' ? error.message : undefined
  const envelope = {}
  if (type !== undefined) envelope.type = type
  if (message !== undefined) envelope.message = message
  return envelope
}

/**
 * 上游自己给的错误类型（`error.type`），**结构字段**优先于状态码。
 *
 * 这几个名字是上游自己写的，所以当证据用比状态码强：同一个 401 既可能是
 * `AuthError`（凭据废了）也可能是 `ModelError`（模型名写错了），而这两件事的
 * 正确处置完全相反（前者换号 + 冷 24 小时，后者**谁也不罚**）。
 */
export const OPENCODE_ERROR_TYPES = {
  auth: 'AuthError',
  model: 'ModelError',
  freeTier: 'FreeTierError',
}

/** 网关把上游 provider 的失败包成 `server_error` 时，文案里的欠费判据。 */
const INSUFFICIENT_FUNDS_WORDS = /insufficient\s+(?:account\s+)?(?:funds?|balance|credits?)|out\s+of\s+(?:funds?|credits?)|no\s+(?:funds?|credits?|balance)/i
/** 模型不存在/不可用——`400` 那条的文案，与 `ModelError` 是同一件事的两个形状。 */
const MODEL_UNAVAILABLE_WORDS = /model\s+is\s+(?:unavailable|not\s+(?:found|supported))|model\s+.*\s+is\s+not\s+supported/i

/**
 * 把一次上游失败归成本仓健康层认得的 `code`。
 *
 * 返回的是**给 `src/health.js` 的 `classifyFailure` 吃的字符串**——归类决定动作
 * （换不换号、罚不罚账号、冷多久），所以顺序是钉死的：
 *
 * 1. **结构类型先行**（`error.type`）：
 *    - `ModelError` ⇒ `'MODEL_UNAVAILABLE'`：**401 但不换号、不罚账号**。
 *      这是本文件最重要的一条：它偏偏是 401，照状态码会把一个健康账号冷 24 小时。
 *    - `FreeTierError` ⇒ `'INVALID_REQUEST'`：**不是账号的问题**（换一把钥匙也一样 403，
 *      本仓真机验过补齐指纹头仍然 403）⇒ `throw`、不换号、不罚账号、不花一分钱。
 *    - `AuthError` ⇒ `'AUTH'`：这才是真的凭据废了。
 * 2. **文案**：`Insufficient account funds` / 402 ⇒ `'ACCOUNT_QUOTA'`
 *    （健康层会换号 —— 同一订阅下另一个账号也许还有钱）；`Model is unavailable.` ⇒
 *    `'MODEL_UNAVAILABLE'`（400，与 `ModelError` 合并成同一个码，因为对调用方是同一件事）。
 * 3. **其余回落 `mapStatus`**：让 429 / 5xx / 传输失败沿用共享层的既有映射，
 *    不在这一族里另造一套词表。
 *
 * ⚠ `'MODEL_UNAVAILABLE'` **不是** `src/health.js` 显式列出的码，所以它会落到那条
 * 「不认识的失败都别乱罚」的兜底分支（`action:'throw'`）——这正是想要的结果，
 * 而它**不依赖**兜底：`src/wire/http-error.js` 的 `mapStatus` 不变，
 * 分类结果由本函数覆盖。理由写在 `describeOpencodeFailure` 的文案里，用户能看到。
 *
 * @param {number|undefined} status
 * @param {string} text 响应体原文
 * @returns {string} `src/health.js` 认得的 code
 */
export function classifyOpencodeFailure(status, text) {
  const envelope = parseOpencodeEnvelope(text)
  const type = envelope.type ?? ''
  const message = envelope.message ?? ''
  if (type === OPENCODE_ERROR_TYPES.model) return 'MODEL_UNAVAILABLE'
  if (type === OPENCODE_ERROR_TYPES.freeTier) return 'INVALID_REQUEST'
  if (type === OPENCODE_ERROR_TYPES.auth) return 'AUTH'
  if (INSUFFICIENT_FUNDS_WORDS.test(message)) return 'ACCOUNT_QUOTA'
  if (MODEL_UNAVAILABLE_WORDS.test(message)) return 'MODEL_UNAVAILABLE'
  if (status === 402) return 'ACCOUNT_QUOTA'
  return mapStatus(status, `${type} ${message}`.trim())
}

/**
 * 把同一次失败写成一句给人看的话。
 *
 * 它**只描述、不决定动作**（动作看 `classifyOpencodeFailure` 的码）。
 * 补这一层是因为三种失败的默认文案都不够用：
 * - 免费档的 403 从状态码看像「没权限」，必须说清**换号、重试、换 key 都没用**；
 * - `ModelError` 的 401 从状态码看像「密钥无效」，必须说清**凭据没问题、是模型名**；
 * - 402 必须说清**请求形状是好的**，否则用户会去改参数（而本仓已经证明改参数没用）。
 *
 * @param {number|undefined} status
 * @param {string} text
 * @returns {string}
 */
export function describeOpencodeFailure(status, text) {
  const envelope = parseOpencodeEnvelope(text)
  const type = envelope.type ?? ''
  const message = envelope.message ?? ''
  if (type === OPENCODE_ERROR_TYPES.freeTier) {
    return 'Zen 的免费档只允许官方客户端（OpenCode）调用，第三方客户端一律 403 —— 换号、重试、换密钥都不会改变这一点；请改用付费模型'
  }
  if (type === OPENCODE_ERROR_TYPES.model || MODEL_UNAVAILABLE_WORDS.test(message)) {
    return `Zen 不提供这个模型（凭据没有问题，是模型 id 不被接受）：${message || 'Model is unavailable.'}`
  }
  if (type === OPENCODE_ERROR_TYPES.auth) {
    return `Zen 拒绝了这把密钥（凭据需要重新获取）：${message || `HTTP ${status}`}`
  }
  if (INSUFFICIENT_FUNDS_WORDS.test(message) || status === 402) {
    return `Zen 账户余额不足 —— 请求本身是合法的，是这把密钥后面的账户没有钱：${message || `HTTP ${status}`}`
  }
  return message.length > 0 ? message : `HTTP ${status}`
}

/**
 * 把一份能力条目装配成契约 §5.3 的模型元数据。
 *
 * `contextWindow` **必须是正整数**（契约 §5.3），所以读不到时用
 * `CONSERVATIVE_CONTEXT_WINDOW`——它是保守估计，注释里写明了依据。
 *
 * `inputModalities` 的判据是 models.dev 的 `modalities.input` **加** `attachment`：
 * - 读到模态含 `image`，或 `attachment === true` ⇒ `['text','image']`；
 * - 读到 `attachment === false` 且模态里没有 `image` ⇒ `['text']`（**有否据**才敢这么说）；
 * - **`attachment === undefined`**（models.dev 没有这一条条目，或条目里没写这个字段）
 *   ⇒ `['text','image']` —— 与 raccoon 那条「没有否据时默认可能支持」**同一个取舍**：
 *   报 `['text']` 会让宿主把图片静默换成一段占位文字（图根本没发出去，用户看不出原因），
 *   而报 `['text','image']` 最坏换来一次上游明确的 400。本仓真机复核过本族 120 条里
 *   `attachment` 是 `true` 81 / `false` 39、**没有一条缺这个字段**，所以这个兜底实际
 *   只在「models.dev 没有条目的模型」上生效（真机数据里恰好一条：`jev-1.13-free`）。
 *
 * `reasoning` **整个字段都不报**。理由：
 * - 契约 §5.3 的原话是「**只有真能拨档位时才声明**」；
 * - models.dev 的 `reasoning_options` 在本族 120/120 条里只有一种取值
 *   `[{type:'toggle'}]` ——**是一个开关，不是档位**，而 `efforts` 的每个元素是
 *   `{id, name}`（见 `src/families/codearts.js:847-853`）。编一个 `['low','high']` 是假话；
 *   给 `['on','off']` 又是在声明一个本仓**没有验证过**的上游档位参数
 *   （本族 `stream()` 刻意不发 `reasoning_effort`，见那里的注释）。
 * - 它**确实是可选的**：`src/families/qoder.js:541` 与 `src/families/grok.js:1022`
 *   都是条件式展开 `...(defaultEffort ? {...} : {})`，本仓其余地方**没有**任何消费点
 *   （`grep -rn reasoning src/pool.js src/api.js src/tools.js` 只命中 `pool.js` 里
 *   与档位无关的「思考算不算输出」那一段）。
 *
 * @param {string} id
 * @param {string} [name]
 * @param {object} [entry] `mergeCatalogs` 的一条
 * @param {string} [provider]
 * @returns {object} 契约 §5.3 形状
 */
export function resolveOpencodeModel(id, name, entry = {}, provider = 'acct-opencode') {
  const contextWindow =
    finitePositive(entry?.contextWindow) ?? CONSERVATIVE_CONTEXT_WINDOW
  const maxTokens = finitePositive(entry?.maxTokens) ?? CONSERVATIVE_MAX_TOKENS
  const input = Array.isArray(entry?.inputModalities) ? entry.inputModalities : []
  // 三个条件任一成立就敢收图：显式声明了 `image`、models.dev 的 `attachment` 说是、
  // 或者**根本不在 models.dev 表里**（那种情况下 `attachment` 也会是 `undefined`，
  // 第三个条件就是为它准备的——没有否据时保守地「可能支持」，与 raccoon 同一取舍）。
  const modalities =
    input.includes('image') || entry?.attachment === true || entry?.attachment === undefined
      ? ['text', 'image']
      : ['text']
  const info = {
    provider,
    id,
    name: typeof name === 'string' && name.length > 0 ? name : id,
    context: { contextWindow },
    defaultMaxTokens: Math.min(maxTokens, contextWindow),
    toolUpdate: 'in-history',
    inputModalities: modalities,
  }
  // `reasoning` 刻意**不声明**：见函数上方注释（契约 §5.3「只有真能拨档位时才声明」，
  // 而 models.dev 给本族的 `reasoning_options` 只有 `toggle` 一个值）。
  // `entry.reasoning === true` 这个事实由 `listModels` 的 name/描述之外的地方承载——
  // 我们不把它翻译成一个假的档位枚举。
  return info
}
