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

/**
 * 产品身份。
 *
 * 一个产品 = 一家厂商里的一套「我们像谁」的配置：端点、产品码、UA、请求头里的
 * 归属名。CodeBuddy（中国版）与 WorkBuddy 是同一条线协议的两个产品变体，
 * 差异**全部**收在这个对象里，而不是把整份 wire 复制一遍。
 *
 * 这也是 `src/families/qoder.js` 与 `src/families/qodercn.js` 在本仓的先例
 * （见 `THIRD_PARTY_NOTICES.md` 的「借用的证据」一节）。
 *
 * @typedef {object} BuddyProduct
 * @property {string} id 本仓内部标识，同时是凭据记录键的一部分
 * @property {string} noun 写进日志与提示的产品名（面向人的那种写法）
 * @property {'cn'|'global'} region 没有 domain 的凭据按哪个区域走
 * @property {string} productCode `X-Product-Code` 的值
 * @property {string} chatUserAgent 对话请求的 `User-Agent`
 * @property {string} clientVersion `X-IDE-Version`
 * @property {string} attributionName `X-IDE-Type` / `X-IDE-Name` / `X-Product`
 * @property {boolean} sendProductCode 是否按产品码报身份（见 `productIdentity()`）：
 *   `true` 发 `X-Product: <归属名>` + `X-Product-Code`；`false` 只发 `X-Product: SaaS`（历史形状）
 * @property {string} catalogUserAgent 目录请求的 `User-Agent`（决定上游下发哪份花名册）
 * @property {string} refreshSource `X-Auth-Refresh-Source` 的值
 * @property {string} origin `Origin` / `Referer` 的站点根
 * @property {string[]} knownDomains 这个产品的凭据里会出现的 domain
 */

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

/**
 * WorkBuddy 的产品身份（CN 区）。
 *
 * 这里的每个值都与本文件原有硬编码逐字相同——参数化是**搬家**，不是改行为。
 * 国际版（`www.workbuddy.ai`）暂时仍由 `region` 分支承担，没有独立的 product 对象：
 * 它的 UA 是 App 形而 CN 是 CLI 形，差异比一个产品对象能表达的更大。
 */
export const WORKBUDDY_PRODUCT = Object.freeze({
  id: 'workbuddy',
  noun: 'WorkBuddy',
  region: 'cn',
  productCode: 'workbuddy',
  chatUserAgent: 'WorkBuddy/5.5.6 WorkBuddy/5.5.6',
  clientVersion: FALLBACK_CN_APP_VERSION,
  attributionName: 'WorkBuddy',
  catalogUserAgent: CLIENT_UA,
  refreshSource: 'workbuddy',
  origin: 'https://copilot.tencent.com',
  knownDomains: ['copilot.tencent.com'],
  /**
   * **`false`：保持历史形状。** 本族在 `copilot.tencent.com` 上跑通的参考实现发的是
   * `X-Product: SaaS`（不带 `X-Product-Code`）；codearts 说那样后台「归因不到产品」，
   * 但它的 WorkBuddy 产品指向 `www.workbuddy.ai`，不是我们这条路径 ⇒ 不能直接搬。
   * 两边都没有我们的抓包证据，所以**不拿老路径去赌**，只让新产品用新形状。
   */
  sendProductCode: false,
})

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

/**
 * 这个产品的区域：产品配置说了算，凭据里的 `domain` 只在没有产品时兜底。
 *
 * 顺序不是随手写的（codearts `src/buddy-adapter.ts:2048-2052` 的注释）：凭据里的
 * domain 是**登录那一刻的快照**，会过期；产品配置是这次请求真正想打的网关。
 * 反过来读会让一个换了域的账号一直打旧网关。
 *
 * @param {import('./workbuddy.js').BuddyProduct|undefined} product
 * @param {string} [domain]
 */
export function regionOfProduct(product, domain) {
  if (product !== undefined && product !== null) return product.region
  return regionOf(domain)
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

/**
 * 所有请求共用的打底头（`src/upstream.ts:374-382`）。
 *
 * `product` 是**可选的尾参**，不传就是 WorkBuddy 原样：这样 workbuddy 那个族的
 * 调用点一个都不用改，而 CodeBuddy 能在这里换掉自己的站点根与身份串。
 *
 * @param {'cn'|'global'} region
 * @param {import('./workbuddy.js').BuddyProduct} [product]
 */
export function commonHeaders(region, product) {
  const origin = product?.origin ?? originReferer(region)
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': product?.catalogUserAgent ?? CLIENT_UA,
  }
}

/**
 * 产品标识头。**两种形状，由产品描述符的 `sendProductCode` 选一种**：
 *
 * - `false`（**历史形状**）：只发 `X-Product: SaaS`。本仓的 WorkBuddy CN 参考实现
 *   就是这样在 `copilot.tencent.com` 上跑通的，本文件原先也是硬编码这一个值。
 * - `true`：发归属名 + 产品码（`X-Product: CodeBuddy` / `X-Product-Code: codebuddy`）。
 *   依据是 codearts 的 `src/buddy-adapter.ts:2056-2063`：那里写着 `X-Product` 是
 *   **归属名**，历史实现发 `SaaS` 会让后台把请求归因不到产品。
 *
 * ⚠️ **两边都没有本仓自己的抓包证据**，而且它们指的未必是同一条路径：codearts 的
 * WorkBuddy 产品指向 `www.workbuddy.ai`，不是我们这条 `copilot.tencent.com`，
 * 所以它那条证据不能直接搬到 WorkBuddy 上。因此：**新产品用新形状**（CodeBuddy
 * 没有历史负担，而且 codearts 的产品码已经报给同一台后端），**WorkBuddy 保持原样**。
 * 这是一个可以随时翻的决定，要改就改描述符里那一个布尔，别在这里猜第三个字面量。
 */
function productIdentity(product, attribution) {
  if (product?.sendProductCode === true) {
    return { 'X-Product': attribution, 'X-Product-Code': product.productCode }
  }
  return { 'X-Product': 'SaaS' }
}

/**
 * 对话请求头（`src/upstream.ts:384-408`）。
 *
 * 三个 `X-No-*` 头是**必填**：上游靠它们区分「这个账号没有 uid」与「调用方忘了带」，
 * 缺了会得到一个跟鉴权无关的 400。
 *
 * **安全红线：对话请求绝不携带 refresh token**（`src/upstream.ts:396`）。
 */
export function chatHeaders(auth, region, product) {
  const uid = typeof auth?.uid === 'string' ? auth.uid : ''
  const enterpriseId = typeof auth?.enterpriseId === 'string' ? auth.enterpriseId : ''
  const domain = typeof auth?.domain === 'string' ? auth.domain : ''
  const version = product?.clientVersion ?? clientVersion(region)
  const attribution = product?.attributionName ?? 'WorkBuddy'
  return {
    ...commonHeaders(region, product),
    'User-Agent': product?.chatUserAgent ?? chatUserAgent(region),
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth?.accessToken ?? ''}`,
    ...(uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': uid }),
    ...(enterpriseId === '' ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': enterpriseId }),
    ...(domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': domain }),
    'X-IDE-Type': attribution,
    'X-IDE-Name': attribution,
    'X-IDE-Version': version,
    ...productIdentity(product, attribution),
  }
}

/** 刷新请求头（`src/upstream.ts:411-421`）：**不带 Authorization**，令牌在 `X-Refresh-Token` 里。 */
export function refreshHeaders(auth, region, product) {
  const enterpriseId = typeof auth?.enterpriseId === 'string' ? auth.enterpriseId : ''
  return {
    ...commonHeaders(region, product),
    'X-Refresh-Token': auth?.refreshToken ?? '',
    'X-Auth-Refresh-Source': product?.refreshSource ?? 'workbuddy',
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

/**
 * 目录请求头（`src/upstream.ts:702-712`）：国际版才带 `X-Requested-With` / `X-Product`。
 *
 * **判据是「国际版」或「这个产品自己报产品码」**，不是「传了 product 对象」：
 * 产品标识头见 `productIdentity()`——WorkBuddy 传了 product 也仍是历史形状，
 * 它的 CN 目录不该因为代码重构而多出三个头。
 */
export function catalogHeaders(auth, region, product) {
  const attribution = product?.attributionName ?? 'SaaS'
  const international = region === 'global' || product?.sendProductCode === true
  return {
    Authorization: `Bearer ${auth?.accessToken ?? ''}`,
    Accept: 'application/json',
    Origin: product?.origin ?? originReferer(region),
    Referer: `${product?.origin ?? originReferer(region)}/`,
    'User-Agent': product?.catalogUserAgent ?? catalogUserAgent(region),
    ...(international ? { 'X-Requested-With': 'XMLHttpRequest', ...productIdentity(product, attribution) } : {}),
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

// ---------------------------------------------------------------- 模型元数据

/**
 * 记录最近一次成功读到的目录，供 `resolveModel` 用。
 *
 * 按模型 id 存：不同区域对同一个 id 的窗口偶尔不同，这里以最后一次成功读到的
 * 为准，**不装作知道得更多**。表满就整个丢掉——它只是缓存，丢了顶多退到兜底值。
 *
 * 这个 Map 原来住在 `families/workbuddy.js` 里；产品变体化之后两个族各要一份，
 * 所以搬到这里，由工厂每次调用 `rememberCatalog` 时传自己的那一份进去。
 */
export function createCatalogMemory() {
  const cache = new Map()
  return {
    remember(models) {
      if (cache.size > 200) cache.clear()
      for (const model of models) cache.set(model.id, model)
    },
    get(id) {
      return cache.get(id)
    },
  }
}

/**
 * 目录行（或兜底行）→ 契约 §5.3 的模型元数据。不知道的值保守，不编。
 *
 * `fallback` 只在目录行缺失时生效，而且**逐字段**兜底：一份目录行里
 * `contextWindow` 可能有、`maxTokens` 可能没有，取整行兜底会把已有的真值也盖掉。
 */
export function modelInfo(entry, provider, fallback = {}) {
  const id = typeof entry?.id === 'string' && entry.id !== '' ? entry.id : ''
  const efforts = Array.isArray(entry?.efforts)
    ? entry.efforts
      .filter((value) => typeof value === 'string' && value !== '')
      .map((value) => ({ id: value, name: EFFORT_NAMES[value] ?? value }))
    : (Array.isArray(fallback.efforts) ? fallback.efforts : [])
      .filter((value) => typeof value === 'string' && value !== '')
      .map((value) => ({ id: value, name: EFFORT_NAMES[value] ?? value }))
  const defaultEffort = typeof entry?.defaultEffort === 'string' && efforts.some((item) => item.id === entry.defaultEffort)
    ? entry.defaultEffort
    : undefined
  const contextWindow = entry?.contextWindow ?? fallback.contextWindow
  const maxTokens = entry?.maxTokens ?? fallback.maxTokens
  const supportsImages = entry?.supportsImages ?? fallback.supportsImages
  return {
    provider,
    id,
    name: typeof entry?.name === 'string' && entry.name !== '' ? entry.name : (fallback.name ?? id),
    context: { contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    defaultMaxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    toolUpdate: 'in-history',
    inputModalities: supportsImages === true ? ['text', 'image'] : ['text'],
    ...(efforts.length === 0 ? {} : { reasoning: { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) } }),
  }
}
