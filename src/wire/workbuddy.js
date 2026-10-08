/**
 * WorkBuddy（腾讯 CodeBuddy / WorkBuddy AI）线协议。
 *
 * 上游**基本**是 OpenAI Chat Completions——参考实现把它拿到的 SSE 原样 pipe 给宿主
 * （`src/shim.ts:200-257`），所以消息、工具、chunk 的翻译全部复用
 * `wire/chat-completions.js`，这里只放它没有的东西：
 *
 * 1. **身份串**。`User-Agent` 决定网关下发哪一份模型目录（CLI 形 → CLI 花名册，
 *    App 形 → App 内部花名册，`src/upstream.ts:679-685`），所以它是功能而不是装饰。
 * 2. **请求体归一**。上游要求 `stream` 恒为 true，`tool_choice` 只能是字符串，
 *    `role:"developer"` 必须改写成 `"system"`（否则 400，业务码 11-128）。
 * 3. **`{code,msg,data}` 信封**。`code !== 0` 就是失败，哪怕 HTTP 是 200。
 * 4. **目录与额度文档**。`/v3/config` 有「cli 花名册 ∩ 可服务行」的白名单语义，
 *    额度有两套端点、两套字段拼写。
 *
 * 事实来源是 corrinehu/dsh-workbuddy-connect 0.7.1 的源码考古（行号随注释给出）。
 * **没有把握的字段一律不解析**：宁可让调用方如实报「未知」，也不要编一个看起来
 * 合理的数字——额度和模型元数据尤其如此。
 * @module dsh-account-bridge/wire/workbuddy
 */

import { httpError } from './http-error.js'

export const ID = 'workbuddy'

// ---------------------------------------------------------------- 常量

/**
 * 刷新令牌与 CN 目录接口用的 CLI 形身份（`src/upstream.ts:179`）。
 * 版本号本身不重要——网关按**形状**而不是版本号分流（`src/app-version.ts:32`）。
 */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** 会话身份解析全失败时的降级版本号（`src/client-identity.ts:42`）。 */
export const FALLBACK_CN_APP_VERSION = '5.5.6'

/** 国际版没有 CLI 身份，只剩 App 形（`src/app-version.ts:32`）。 */
export const FALLBACK_APP_VERSION = '5.5.2'

/** 目录里读不到上下文窗口时的保守值（不是上游声明，见族层 modelInfo 的注释）。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 8_192

/** 对话与计费是两套域名，按区域选（`src/upstream.ts:143-145`）。 */
export const CHAT_BASE = Object.freeze({
  cn: 'https://copilot.tencent.com',
  global: 'https://www.workbuddy.ai',
})
export const BILLING_BASE = Object.freeze({
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
})

/**
 * CN 企业额度端点是**写死**的（`src/upstream.ts:891`），不跟着 billingBase 走：
 * 企业计费只存在于国内站。
 */
export const ENTERPRISE_BILLING_URL = 'https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage'

/** 上游认识的推理档位（`src/upstream.ts:192`）。`minimal` 不在其中。 */
export const EFFORT_VALUES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/** 档位显示名，照 codex 族的写法（`src/families/codex.js:42-48`）。 */
export const EFFORT_NAMES = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
})

/**
 * 上游用**措辞**而不是状态码说「额度没了」（`src/upstream.ts:184-189`）。
 * 中英都要认：CN 区回中文。
 */
const HARD_CREDIT_MARKERS = Object.freeze([
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough', 'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
])

/** 会话已死的标记（`src/upstream.ts:299`）：HTTP 可能是 200。 */
const SESSION_DEAD_MARKERS = Object.freeze(['Offline user session not found', '12153'])

// ---------------------------------------------------------------- 小工具

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 只描述形状、**绝不带值**（`describeShape`，`src/upstream.ts:328-352` 同旨）。
 * 额度解析失败的提示会进浏览器，往里塞原始响应就是泄凭据。
 */
export function shapeOf(value) {
  if (Array.isArray(value)) return `array(${value.length})`
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  const keys = Object.keys(value).map((key) => `${key}:${Array.isArray(value[key]) ? 'array' : typeof value[key]}`)
  return keys.length === 0 ? '{}' : `{ ${keys.join(', ')} }`
}

function markerHit(text, markers) {
  const haystack = String(text).toLowerCase()
  return markers.some((marker) => haystack.includes(marker.toLowerCase()))
}

/** 上游措辞是否在说「额度耗尽」。 */
export function isHardCreditFailure(text) {
  return markerHit(text, HARD_CREDIT_MARKERS)
}

/** 上游措辞是否在说「这个会话已经失效，去重新登录」。 */
export function isSessionDeadFailure(text) {
  return markerHit(text, SESSION_DEAD_MARKERS)
}

// ---------------------------------------------------------------- 区域与端点

/**
 * 区域**由凭据里的 `domain` 决定，不是用户可选项**（`src/upstream.ts:355-359`）：
 * 只有 `workbuddy.ai` 及其子域算国际版，空 domain 与其它一切算国内版。
 */
export function regionOf(domain) {
  const value = typeof domain === 'string' ? domain : ''
  return value === 'workbuddy.ai' || value.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

export function chatBase(region) {
  return region === 'global' ? CHAT_BASE.global : CHAT_BASE.cn
}

export function billingBase(region) {
  return region === 'global' ? BILLING_BASE.global : BILLING_BASE.cn
}

/** `Origin` / `Referer` 用的站点根（`src/upstream.ts:361-371`）。 */
export function originReferer(region) {
  return region === 'global' ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com'
}

export function chatUrl(region) {
  return `${chatBase(region)}/v2/chat/completions`
}

export function refreshUrl(region) {
  return `${chatBase(region)}/v2/plugin/auth/token/refresh`
}

export function configUrl(region) {
  return `${chatBase(region)}/v3/config`
}

/** 个人额度。CN 企业账号走 {@link ENTERPRISE_BILLING_URL}，不走这里。 */
export function creditsUrl(region) {
  return `${billingBase(region)}/v2/billing/meter/get-user-resource`
}

// ---------------------------------------------------------------- 身份串

function validVersion(version) {
  return typeof version === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(version)
}

/**
 * App 形身份（`src/app-version.ts:161-164`）。
 *
 * **带空格的 `WorkBuddy AI/<v>` 会被上游用 400 / 12403 拒掉**，所以这里用的是
 * 代码里验证过的紧凑形。
 */
export function appUserAgent(version = FALLBACK_APP_VERSION) {
  const value = validVersion(version) ? version : FALLBACK_APP_VERSION
  return `WorkBuddyAI/${value}`
}

/** 这个区域里「我们像谁」。CN 有 CLI 身份，国际版只有 App 身份。 */
export function clientVersion(region) {
  return region === 'global' ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION
}

/**
 * 对话请求的身份串（`src/client-identity.ts:122-133`）。
 *
 * 参考实现会再拼一段 `CLI/<自己的版本>`；本插件不是 CLI，**不编那一段**：
 * 少一段不属于自己的身份，比伪造一个更诚实。
 */
export function chatUserAgent(region) {
  const version = clientVersion(region)
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  return `WorkBuddy/${version} ${product}/${version}`
}

/**
 * 目录请求的身份串（`src/upstream.ts:702-712`）。
 *
 * **这是目录语义的一部分**：CLI 形 UA 拿到 CLI 花名册（正是本插件要服务的对话模型），
 * App 形 UA 拿到 App 内部花名册（`src/upstream.ts:679-685`）。所以 CN 用 CLI 形、
 * 国际版用 App 形——两边都不是随便挑的。
 */
export function catalogUserAgent(region) {
  return region === 'global' ? appUserAgent(FALLBACK_APP_VERSION) : CLIENT_UA
}

// ---------------------------------------------------------------- 请求头

/** 所有请求共用的打底头（`src/upstream.ts:374-382`）。 */
export function commonHeaders(region) {
  const origin = originReferer(region)
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': CLIENT_UA,
  }
}

/**
 * 对话请求头（`src/upstream.ts:384-408`）。
 *
 * 三个 `X-No-*` 头是**必填**：上游靠它们区分「这个账号没有 uid」与「调用方忘了带」，
 * 缺了会得到一个跟鉴权无关的 400。
 *
 * **安全红线：对话请求绝不携带 refresh token**（`src/upstream.ts:396`）。
 */
export function chatHeaders(auth, region) {
  const uid = typeof auth?.uid === 'string' ? auth.uid : ''
  const enterpriseId = typeof auth?.enterpriseId === 'string' ? auth.enterpriseId : ''
  const domain = typeof auth?.domain === 'string' ? auth.domain : ''
  const version = clientVersion(region)
  return {
    ...commonHeaders(region),
    'User-Agent': chatUserAgent(region),
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth?.accessToken ?? ''}`,
    ...(uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': uid }),
    ...(enterpriseId === '' ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': enterpriseId }),
    ...(domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': domain }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
    'X-Product': 'SaaS',
  }
}

/** 刷新请求头（`src/upstream.ts:411-421`）：**不带 Authorization**，令牌在 `X-Refresh-Token` 里。 */
export function refreshHeaders(auth, region) {
  const enterpriseId = typeof auth?.enterpriseId === 'string' ? auth.enterpriseId : ''
  return {
    ...commonHeaders(region),
    'X-Refresh-Token': auth?.refreshToken ?? '',
    'X-Auth-Refresh-Source': 'workbuddy',
    ...(enterpriseId === '' ? {} : { 'X-Enterprise-Id': enterpriseId }),
  }
}

/**
 * 计费请求头（`src/upstream.ts:424-437`）。
 *
 * 企业账号要**同时**带 `X-Enterprise-Id` 与 `X-Tenant-Id`（值都是 enterpriseId），
 * 少一个会被计费侧当成个人号。
 */
export function billingHeaders(auth) {
  const uid = typeof auth?.uid === 'string' ? auth.uid : ''
  const enterpriseId = typeof auth?.enterpriseId === 'string' ? auth.enterpriseId : ''
  const domain = typeof auth?.domain === 'string' ? auth.domain : ''
  return {
    Authorization: `Bearer ${auth?.accessToken ?? ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(uid === '' ? {} : { 'X-User-Id': uid }),
    ...(enterpriseId === '' ? {} : { 'X-Enterprise-Id': enterpriseId, 'X-Tenant-Id': enterpriseId }),
    ...(domain === '' ? {} : { 'X-Domain': domain }),
  }
}

/** 目录请求头（`src/upstream.ts:702-712`）：国际版才带 `X-Requested-With` / `X-Product`。 */
export function catalogHeaders(auth, region) {
  const international = region === 'global'
  return {
    Authorization: `Bearer ${auth?.accessToken ?? ''}`,
    Accept: 'application/json',
    Origin: originReferer(region),
    Referer: `${originReferer(region)}/`,
    'User-Agent': catalogUserAgent(region),
    ...(international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {}),
  }
}

// ---------------------------------------------------------------- 请求体归一

/**
 * `tool_choice` 归一（`src/upstream.ts:478-515`）。
 *
 * 上游**只接受字符串**：对象形一律 400。OpenAI 风格的
 * `{type:'function', function:{name}}` 在这里要摊平成裸名字。
 * `none` 语义上等于「这次没有工具」，所以连 `tools` 一起删掉——留着一个空工具表
 * 会让某些模型开始胡说工具名。
 */
function normalizeToolChoice(body) {
  if (!('tool_choice' in body)) return body
  const choice = body.tool_choice
  const dropTools = () => {
    delete body.tool_choice
    delete body.tools
    delete body.functions
  }
  if (typeof choice === 'string') {
    if (choice === 'none') dropTools()
    return body
  }
  if (isObject(choice)) {
    const type = choice.type
    if (type === 'none') return dropTools(), body
    if (type === 'auto' || type === 'required') {
      body.tool_choice = type
      return body
    }
    if (type === 'function') {
      const named = isObject(choice.function) && typeof choice.function.name === 'string'
        ? choice.function.name
        : typeof choice.name === 'string' ? choice.name : ''
      body.tool_choice = named === '' ? 'auto' : named
      return body
    }
  }
  // 认不出来的形状：删掉比冒险发出去好。
  delete body.tool_choice
  return body
}

/**
 * 对话请求体归一（`src/upstream.ts:451-464`，`:467-475`）。
 *
 * 三件事，缺一不可：
 * - `stream: true`——上游拒收非流式对话请求；
 * - `role:"developer"` → `"system"`——否则 400，业务码 11-128
 *   `Illegal API invocation from an unapproved channel`；
 * - `tool_choice` 字符串化。
 *
 * 解析不了就原样返回：这不是我们的文档，改不动就别动。
 */
export function normalizeChatBody(rawJson) {
  if (typeof rawJson !== 'string') return rawJson
  let body
  try {
    body = JSON.parse(rawJson)
  } catch {
    return rawJson
  }
  if (!isObject(body)) return rawJson
  body.stream = true
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isObject(message) && message.role === 'developer') message.role = 'system'
    }
  }
  return JSON.stringify(normalizeToolChoice(body))
}

/** 国际版对话请求体的第二条 system 提示（`src/upstream.ts:1340`）。 */
export const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * 国际版专属改写（`src/upstream.ts:1282-1304`）。
 *
 * 两处都不能少：
 * - 上游的 GPT 系要求**第一条消息必须是 system**，否则 400；
 * - `reasoning_effort: 'off'` 必须**删掉**而不是换一个值——上游报
 *   `extError.param === 'reasoning.effort'`（400 / 11133），而字面量 `'none'`
 *   不是安全替代（GPT-5.6 与 GLM 收、gpt-6-astra 拒）。
 *
 * **CN 区刻意不走这里**：国内行对 `reasoning_effort` 的接受度不同，原样透传才是对的。
 */
export function prepareInternationalChatBody(rawJson) {
  const normalized = normalizeChatBody(rawJson)
  if (typeof normalized !== 'string') return normalized
  let body
  try {
    body = JSON.parse(normalized)
  } catch {
    return normalized
  }
  if (!isObject(body)) return normalized
  if (body.reasoning_effort === 'off') delete body.reasoning_effort
  const messages = Array.isArray(body.messages) ? body.messages : []
  const first = messages[0]
  if (!isObject(first) || first.role !== 'system') {
    body.messages = [{ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT }, ...messages]
  }
  return JSON.stringify(body)
}

// ---------------------------------------------------------------- 信封

/**
 * 读一封信封（`src/upstream.ts:534-553`）。
 *
 * `{code,msg,data}` 是**多数**接口的形状，但 `/v3/config` 也观察到产品文档直接裸在
 * 顶层（`src/upstream.ts:717-726`），所以这里把整份文档一起交回给调用方，
 * 由它按接口决定取 `data` 还是取顶层。
 *
 * 返回 `{ text, json, code, msg, data, document }`：
 * - `text` 原样保留，好让 `httpError` 用同一份文本做归类，不必再读一次 body；
 * - `json` 解析失败时是 `undefined`，此时 `document`/`code` 都是保守的默认值。
 */
export async function readEnvelope(response) {
  const text = await response.text().catch(() => '')
  let document
  try {
    document = JSON.parse(text)
  } catch {
    document = undefined
  }
  const wrapped = isObject(document) ? document : undefined
  return {
    text,
    json: document,
    document: wrapped,
    code: typeof wrapped?.code === 'number' ? wrapped.code : 0,
    msg: typeof wrapped?.msg === 'string' ? wrapped.msg : '',
    data: wrapped === undefined ? undefined : wrapped.data,
  }
}

/**
 * 信封/HTTP 失败 → DSH 中立失败码。
 *
 * 走 `httpError` 建立基线（状态码、`retry-after`、消息格式都在那里统一），
 * 再用上游自己的措辞细化：WorkBuddy 会把「会话已死」「额度耗尽」塞进
 * **HTTP 200** 的 `{code,msg}` 里（`classifyUpstreamError`，`src/upstream.ts:302-322`），
 * 光看状态码只会得到 `SERVER`——那样一条死会话会被当成可重试的服务端错误。
 */
export function envelopeError(response, envelope, who = ID) {
  const error = httpError(response, envelope?.msg || envelope?.text || '', who)
  const detail = envelope?.msg || ''
  if (error.code === 'SERVER' || error.code === 'RATE_LIMIT') {
    if (isSessionDeadFailure(detail)) error.code = 'AUTH'
    else if (isHardCreditFailure(detail)) error.code = 'ACCOUNT_QUOTA'
  }
  if (typeof envelope?.code === 'number' && envelope.code !== 0) {
    error.failure = { ...error.failure, upstreamCode: envelope.code }
  }
  return error
}

// ---------------------------------------------------------------- 模型目录

/**
 * `/v3/config` 的文档体。
 *
 * 两种形状都要认：多数是 `{code,msg,data}` 信封（取 `data`），也观察到产品文档
 * 直接裸在顶层（`src/upstream.ts:717-726`）。把「缺 data」一律当空文档会误报
 * 「目录里没有 cli 模型」。
 */
export function catalogDocument(envelope) {
  if (isObject(envelope?.data)) return envelope.data
  const document = envelope?.document
  if (isObject(document) && (Array.isArray(document.models) || Array.isArray(document.agents))) return document
  return {}
}

function upEfforts(row) {
  const reasoning = isObject(row.reasoning) ? row.reasoning : undefined
  const raw = Array.isArray(reasoning?.supportedEfforts) ? reasoning.supportedEfforts : []
  const efforts = raw.filter((value) => typeof value === 'string' && EFFORT_VALUES.includes(value))
  if (efforts.length === 0) return {}
  let defaultEffort
  for (const candidate of [reasoning?.defaultEffort, reasoning?.effort]) {
    if (typeof candidate === 'string' && efforts.includes(candidate)) {
      defaultEffort = candidate
      break
    }
  }
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
}

/**
 * 目录文档 → 可用模型行（`parseModelCatalog`，`src/upstream.ts:1100-1153`）。
 *
 * 成员资格是**「`cli` agent 的花名册」∩「真的能服务的行」**：
 * 花名册是「当前客户端身份被允许对话的模型」，而行本身还要有正的
 * `maxInputTokens` / `maxOutputTokens` 且没被 `disabled: true`。
 * 只信花名册会把「已下架但还没从名单里删掉」的 id 放进选择器，
 * 只信行列表又会把不属于这个身份的模型露出来。
 *
 * 两种情况是**硬错误**而不是空数组：没有 cli 段、交集为空。返回 `[]` 会让上层
 * 静默地把整个分组藏起来，用户只会看到「模型都不见了」而没有任何线索。
 *
 * @param document 已经解开的目录文档（不是信封）。
 * @param options.international 国际版文档的行带 `contextWindow` 对象。
 */
export function parseModelCatalog(document, options = {}) {
  const international = options.international === true
  const doc = isObject(document) ? document : {}
  const agents = Array.isArray(doc.agents) ? doc.agents : []
  let roster
  for (const agent of agents) {
    if (isObject(agent) && agent.name === 'cli' && Array.isArray(agent.models)) {
      roster = agent.models.filter((id) => typeof id === 'string' && id.length > 0)
      break
    }
  }
  if (roster === undefined || roster.length === 0) {
    const error = new Error('workbuddy: 模型目录里没有 cli agent 的模型清单（/v3/config 的形状变了？）')
    error.code = 'SERVER'
    throw error
  }
  const rows = Array.isArray(doc.models) ? doc.models : []
  const byId = new Map()
  for (const raw of rows) {
    if (!isObject(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (id === '' || raw.disabled === true) continue
    const maxInput = typeof raw.maxInputTokens === 'number' ? raw.maxInputTokens : 0
    const maxOutput = typeof raw.maxOutputTokens === 'number' ? raw.maxOutputTokens : 0
    if (!isPositiveNumber(maxInput) || !isPositiveNumber(maxOutput)) continue
    const wrapped = isObject(raw.contextWindow) ? raw.contextWindow : undefined
    const preferred = international && isPositiveNumber(wrapped?.defaultLength) ? wrapped.defaultLength : maxInput
    byId.set(id, {
      id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
      contextWindow: preferred,
      maxTokens: maxOutput,
      supportsImages: raw.supportsImages === true && raw.disabledMultimodal !== true,
      ...upEfforts(raw),
    })
  }
  const models = roster.map((id) => byId.get(id)).filter((model) => model !== undefined)
  if (models.length === 0) {
    const error = new Error('workbuddy: 模型目录解出来是空的（cli 花名册里的 id 没有一个出现在 models 里）')
    error.code = 'SERVER'
    throw error
  }
  return models
}

// ---------------------------------------------------------------- 额度

function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 个人额度请求体（`src/upstream.ts:809-872`）。
 *
 * 时间戳是**本地时间的 `YYYY-MM-DD HH:mm:ss`**，不是 ISO——照抄上游的格式，
 * 结束时间放在 101 年后，等于「把能查到的套餐都列出来」。
 */
export function personalCreditBody(now = Date.now()) {
  const start = new Date(now)
  const end = new Date(now + 365 * 101 * 24 * 3600 * 1000)
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatStamp(start),
    PackageEndTimeRangeEnd: formatStamp(end),
  }
}

/**
 * 个人额度文档 → 每个资源包一行。
 *
 * **形状对不上就返回 `undefined`**（读不懂 ≠ 额度为 0）。调用方据此如实报「未知」，
 * 而不是渲染一根 0% 的进度条——那是在替上游撒谎。
 *
 * 取值优先级照抄上游（`src/upstream.ts:809-872`）：有 `CycleCapacitySize` 就用
 * `CycleCapacityRemain`；否则只要周期字段有正数也用它；再不行才退到旧的
 * `CapacityRemain`。`size` 是分母，`0` 表示上游没说容量。
 */
export function parseCreditAccounts(envelope) {
  const data = isObject(envelope?.data) ? envelope.data : undefined
  const response = isObject(data?.Response) ? data.Response : undefined
  const wrapper = isObject(response?.Data) ? response.Data : undefined
  const accounts = wrapper?.Accounts
  if (!Array.isArray(accounts)) return undefined
  return accounts.filter(isObject).map((account) => {
    const size = typeof account.CycleCapacitySize === 'number' ? account.CycleCapacitySize : 0
    const cycleRemain = typeof account.CycleCapacityRemain === 'number' ? account.CycleCapacityRemain : 0
    const cycleUsed = typeof account.CycleCapacityUsed === 'number' ? account.CycleCapacityUsed : 0
    const legacyRemain = typeof account.CapacityRemain === 'number' ? account.CapacityRemain : 0
    let remain
    if (size > 0) remain = cycleRemain
    else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain
    else remain = legacyRemain
    if (remain < 0) remain = 0
    const legacySize = typeof account.CapacitySize === 'number' ? account.CapacitySize : 0
    return {
      packageName: typeof account.PackageName === 'string' && account.PackageName !== '' ? account.PackageName : '',
      remain,
      size: size > 0 ? size : legacySize,
    }
  })
}

/**
 * CN 企业额度文档（`src/upstream.ts:890-953`）。
 *
 * 官方两个调用点的字段拼写不一致，所以 `limitNum`/`limit_num` 与
 * `credit`/`used_num` **两种都收**。`limit === -1` 是上游的「无上限」标记，
 * 不是余额。
 *
 * **读不懂必须是硬错误**（上游 issue #31）：企业用户看到一根 0% 的条会去充值，
 * 而他其实只是用了另一个接口。所以这里抛错，由调用方决定怎么呈现。
 */
export function parseEnterpriseCredits(envelope) {
  const documents = [envelope?.data, envelope?.document]
  let source
  for (const candidate of documents) {
    if (!isObject(candidate)) continue
    const nested = candidate.data
    if (isObject(nested) && !Array.isArray(nested)) source = nested
    else source = candidate
    if (source.limitNum !== undefined || source.limit_num !== undefined) break
  }
  const limit = typeof source?.limitNum === 'number' ? source.limitNum : source?.limit_num
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    const error = new Error(
      'workbuddy: 企业额度响应里没有认识的配额字段（expected limitNum/limit_num + credit/used_num；'
        + `received ${shapeOf(envelope?.document ?? envelope?.data)}）`,
    )
    error.code = 'SERVER'
    throw error
  }
  if (limit === -1) return { unlimited: true, remain: 0, size: 0 }
  const used = typeof source.credit === 'number' ? source.credit : source.used_num
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    const error = new Error(
      'workbuddy: 企业额度响应里有配额但没有认识的用量字段（expected credit/used_num；'
        + `received ${shapeOf(source)}）`,
    )
    error.code = 'SERVER'
    throw error
  }
  const cycleResetTime = typeof source.cycleResetTime === 'string' && source.cycleResetTime !== ''
    ? source.cycleResetTime
    : undefined
  return {
    unlimited: false,
    remain: Math.max(0, limit - used),
    size: limit,
    ...(cycleResetTime === undefined ? {} : { cycleResetTime }),
  }
}
