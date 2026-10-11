/**
 * CodeArts（华为云）的纯函数协议层——签名、请求构造、目录归一、积分投影、失败归类。
 *
 * 这一家的形状与其它族都不同，三件事决定了「为什么要有这个文件」：
 *
 * - **它是唯一需要我们自己算签名的族**（华为云 `SDK-HMAC-SHA256`）。其余族的认证
 *   都是一个明文头（`Bearer xxx` / `Cloud-IDE-JWT xxx`），而这里请求是否被认，
 *   取决于 canonical request 是否与网关逐字节一致 ⇒ 签名必须是**可单独测的纯函数**，
 *   不能埋在 `stream()` 里。
 * - **它的头分两类，混用就 401**。见 `CODEARTS_SIGNABLE_HEADERS` / `CODEARTS_POST_SIGN_HEADERS`
 *   以及 `signCodeArtsRequest()` 上那段注释：`Agent-Type` / `X-Language` 一旦进入
 *   canonical request 与 SignedHeaders，网关回 `401 APIG.0301`（参考实现 2026-09-18
 *   用真实凭据实测，它早期版本正是这么踩的）；而 `maas_type: benefit` 恰好相反，
 *   **必须**参与签名。
 * - **它有一个「同一请求发两次」的语义**：benefit（免费额度）模型不带 `maas_type: benefit`
 *   会被回 `404 InferHub.002002009.404 "model is not registered"`，而账号**没有 benefit 包**时
 *   带上它又会回 **HTTP 200 + SSE 里 `InferHub.4004.200 benefit not found`** ⇒ 只能去掉该头
 *   重试一次。这条重试**不是账号故障**，所以判定必须落在协议层（`isBenefitNotFound`），
 *   由族那一侧执行，而不是交给池子的换号。
 *
 * **SSE 翻译刻意不在这里**：对话端点是标准 OpenAI 兼容 + 标准 SSE（无信封、无加密、
 * 无格式转换），与 Qoder / Loomy / Raccoon 同形 ⇒ 直接复用 `./chat-completions.js`，
 * 不为「对称」再抄一份翻译器。
 *
 * 本文件里的协议事实**全部借自**另一个中文插件 dsh-codearts-auth 的源码与注释
 * （`temp/codearts/src/*.ts`，MIT，`Copyright (c) 2026 Jet`），逐条标了出处；
 * 哪些是本仓真机捕获的、哪些只是照抄它的记录，登记在 `THIRD_PARTY_NOTICES.md` 的
 * 「借用的证据」一节。签名那一段是**按它的 `src/sign.ts` 重写的等价实现**
 * （TypeScript + `crypto.subtle` → JavaScript + `node:crypto`），登记在本文件头部
 * 指向的 `THIRD_PARTY_NOTICES.md` 里。
 * @module dsh-account-bridge/wire/codearts
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'

// ------------------------------------------------------------------ 端点

/**
 * 对话基址（参考实现 `src/llm-adapter.ts:24` 的 `CHAT_API_BASE`）。
 *
 * ⚠ 参考实现另有一处 `.com → .cn` 的**域名回退**，本仓**刻意不照搬**：那是它的
 * 事故处置，本仓无法复核，照搬一个自己没验过的回退路径只会制造一条「看起来能连上」
 * 的假象。真要加，先按本仓的口径抓一次包。
 */
export const CODEARTS_CHAT_API_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2'

/** 对话端点（`llm-adapter.ts:1257` 拼的 `CHAT_API_BASE + '/chat/completions'`）。 */
export const CODEARTS_CHAT_URL = `${CODEARTS_CHAT_API_BASE}/chat/completions`

/** 网关基址（积分 / 套餐 / 登录票据都在这一台上）。 */
export const CODEARTS_SNAP_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com'

/**
 * 常规模型目录（参考实现 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL`）。
 * 信封 `{count, builtinModels:[{model_id, model_name, …}]}`。
 */
export const CODEARTS_BUILTIN_MODELS_URL = `${CODEARTS_SNAP_BASE}/v1/model/builtin`

/**
 * benefit（免费额度）模型目录（`models.ts` 的 `OPENGW_GATEWAY_CONFIG_URL`）。
 * 信封 `{result:{models:[…]}}`——**注意不是 `builtinModels`**，两条腿的形状不同。
 */
export const CODEARTS_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/**
 * 账号 / 套餐 / 积分端点（`codearts-credits.ts` 的 `CODEARTS_PACKAGE_INFO_PATH`）
 * ——**积分账户检测的唯一真相源**。
 */
export const CODEARTS_PACKAGE_INFO_URL = `${CODEARTS_SNAP_BASE}/snap-manager/v1/statistics/plugin`

/** 排队状态端点（`llm-adapter.ts:331` 的 `QUEUE_STATUS_BASE`）。**只用于诊断**。 */
export const CODEARTS_QUEUE_STATUS_URL = `${CODEARTS_SNAP_BASE}/api/v1/queue/status`

/** 登录票据端点（`login.ts:13` 的 `CREDENTIAL_ENDPOINT`，浏览器登录那条路用）。 */
export const CODEARTS_TICKET_URL = `${CODEARTS_SNAP_BASE}/snap-manager/v1/login/ticket`

/**
 * 网关对「并发会话数」的限制（`llm-adapter.ts:328`）：超了以 `TM.00001041` 失败。
 *
 * ⚠ 这是**按账号**限的，而且**不是账号的错**——本仓把它归成瞬态（见
 * `classifyCodeArtsFailure` 返回 `'queue'` 的那一支），既不换号也不写冷却。
 */
export const CODEARTS_QUEUE_BUSINESS_CODE = 'TM.00001041'

/** 账号没有 benefit 包时，SSE 里报的这个码（`llm-adapter.ts:36`）。**去掉该头重试一次**。 */
export const CODEARTS_BENEFIT_NOT_FOUND_CODE = 'InferHub.4004.200'

/** benefit 模型不带 `maas_type: benefit` 时上游回的业务码（`llm-adapter.ts:1284`）。 */
export const CODEARTS_MODEL_NOT_REGISTERED_CODE = 'InferHub.002002009.404'

/**
 * 额度用尽的业务码（`llm-adapter.ts:520-560`，2026-10-02 真实凭据实测）。
 *
 * ⚠ 它与排队码长得很像，而且**踩过一次真缺陷**：参考实现早期把 SSE 错误码判据写成
 * 裸子串 `/…|429|…/`，于是 `4291` 命中了 `429` 前缀 ⇒ 30 分钟静默重试、界面零输出。
 * 本仓照它修正后的写法：`429` 必须用 `(^|[^0-9])429([^0-9]|$)` 锚成独立数字。
 */
export const CODEARTS_QUOTA_EXHAUSTED_CODE = 'InferHub.4291.200'

/** TPM 超限的排队码（`llm-adapter.ts:392`）——与 `TM.00001041` 同等处置。 */
export const CODEARTS_TPM_QUEUE_CODE = 'InferHub.ModelArts.81111.429'

/** 登录票据的插件标识（`login.ts:22-23`）——上游按它们识别调用方。 */
export const CODEARTS_PLUGIN_NAME = 'snap_jetbrains'
export const CODEARTS_PLUGIN_VERSION = '26.3.3'

/**
 * 输出上限。参考实现实测 **65536 可用、131072 触发空流**（被后端拒绝），
 * 所以这个数不是「保守估计」而是**实测能力上限**。
 *
 * ⚠ 这个常数只用来给 `stream()` 当默认值；真正的**钳制**在族里做（`clamp(maxTokens, …)`），
 * 因为 `options.maxTokens` 可能是 DSH 从别的 provider 注入的大值（`dsh-agent-loop`
 * 只校验「正安全整数」，没有上限），原样透传会被上游回 `The request param is invalid`。
 */
export const CODEARTS_MAX_OUTPUT_TOKENS = 65_536

/** 目录 / 积分端点的请求超时（`codearts-credits.ts` 的 `REQUEST_TIMEOUT_MS`）。 */
export const CODEARTS_REQUEST_TIMEOUT_MS = 30_000

/**
 * 提前多久提醒续期（`needsRefresh` 用）。
 *
 * ⚠ 这一族的临时凭据**没有 refresh_token**：过期只能重新登录，所以这个窗口不是
 * 「准备续期」而是「准备提醒用户」——参考实现记的寿命约 2 小时（`AGENTS.md` 的
 * 「短寿命令牌」那一段），5 分钟余量足够，又不会让每 30 分钟一轮的调度器反复报警。
 */
export const CODEARTS_EXPIRY_LEAD_MS = 5 * 60_000

// ------------------------------------------------------------------ 头

/**
 * **参与签名**的头（canonical request + `SignedHeaders` 里的那四个），
 * 加上按请求追加的 `maas_type`。
 *
 * 其余头**一律在签名之后追加**——这是本家的头号坑，见 `signCodeArtsRequest`。
 */
export const CODEARTS_SIGNABLE_HEADERS = Object.freeze(['host', 'x-sdk-date', 'x-sdk-content-sha256', 'x-security-token'])

/**
 * 签名之后追加的头：`Agent-Type` 与 `X-Language`。
 *
 * ⚠ 参考实现 `codearts-credits.ts:114-140` 的 `SNAP_EXTRA_HEADERS` 与它那段注释：
 * 一旦这两个头进入 canonical request / `SignedHeaders`，服务端回
 * `401 {"error_code":"APIG.0301","error_msg":"… verify ak sk signature fail"}`；
 * 签名后追加则 200。它早期版本把 `Agent-Type` 当签名头用 ⇒ **全部积分请求 401**。
 */
export const CODEARTS_POST_SIGN_HEADERS = Object.freeze({ 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' })

/**
 * 对话请求用的 `Agent-Type`（`llm-adapter.ts` 的 `attributionHeaders()`）。
 * ⚠ 与目录 / 积分端点用的 `PromptCenter` **不是同一个值**——共用会走错服务面。
 */
export const CODEARTS_CHAT_AGENT_TYPE = 'INFERHUB_AGENT'

// ------------------------------------------------------------------ 签名

/** `sha256` 的 hex 形态。参考实现 `sign.ts` 用 `crypto.subtle`，这里用 `node:crypto`（同值）。 */
function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** `HMAC-SHA256` 的 hex 形态。 */
function hmacSha256Hex(key, data) {
  return createHmac('sha256', key).update(data).digest('hex')
}

/** `Date` → `20260918T101530Z`（参考实现 `sign.ts` 的 `dateStamp`，取自 ISO 串去掉 `-` `:` 与毫秒）。 */
export function codeArtsDateStamp(when = new Date()) {
  return when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * 构造 canonical request。**顺序与分隔符都是协议的一部分**，改一个字符签名就错。
 *
 * 形状（参考实现 `sign.ts` 的 `buildCanonicalRequest`）：
 *
 * ```
 * METHOD\n
 * uri\n
 * query\n
 * k1:v1\nk2:v2\n      ← 头名已排序，逐行 k:v
 * \n                  ← 头段与签名头段之间的空行（**不是笔误**）
 * a;b;c\n             ← SignedHeaders
 * payloadHash
 * ```
 */
export function buildCanonicalRequest(method, uri, query, headers, payloadHash) {
  const names = [...headers.keys()].sort()
  const headerLines = names.map((name) => `${name}:${headers.get(name)}`)
  const canonical = [method, uri, query, headerLines.join('\n'), '', names.join(';'), payloadHash].join('\n')
  return { canonical, signedHeaders: names.join(';'), canonicalHash: sha256Hex(canonical) }
}

/**
 * 华为云 `SDK-HMAC-SHA256` 签名。
 *
 * 返回的头是**可以直接摊进 `fetch` 的 init 的那一份**，但它**不含** `Agent-Type` /
 * `X-Language` 这类后置头——那要调用方在展开之后自己加（`codeartsReadHeaders` /
 * 族的 `stream()` 都是这么做的）。
 *
 * 逐条事实（参考实现 `src/sign.ts`，本仓逐行重写）：
 *
 * - `uri` 取自 pathname，**不以 `/` 结尾要补一个**：`/api/v2/chat/completions` 被签成
 *   `/api/v2/chat/completions/`。这看起来是错的，但网关那边就是这么算的——补上才 200。
 * - `query` 是 `search.slice(1)`（不带前导 `?`）。**query 必须按原样排序**：
 *   凭据端点自己拼的 query 顺序就是它签名时的顺序，别在中间重排。
 * - `dateStamp` 形如 `20260918T101530Z`，同时进 `x-sdk-date` 头与 stringToSign。
 * - 签名头集合 = `host` + `x-sdk-date` + `x-sdk-content-sha256` + `x-security-token`
 *   （**临时凭据三件套缺一不可**）+ `extraHeaders`。
 * - `content-type` **只在非 GET 时**加：GET 带它会与网关算的不一致（参考实现同款）。
 * - `Content-Type`（HTTP 头的正式名）**不参与签名**：`host` 之类的小写名才是签名名，
 *   而 HUAWEI 的 canonical request 里 `content-type` 是小写的那个。
 * - 返回的 `host` 头**调用方应丢掉**：`fetch` 自己会设，手写一个反而可能被 undici 拒绝。
 *
 * @returns {{ headers: Record<string,string>, signedHeaders: string[], canonicalHash: string, dateStamp: string }}
 */
export function signCodeArtsRequest({ ak, sk, securityToken, method = 'POST', url, body, extraHeaders } = {}) {
  const target = new URL(String(url))
  let uri = target.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = target.search.slice(1)
  const dateStamp = codeArtsDateStamp()
  const payload = body === undefined || body === null ? '' : body
  const payloadHash = sha256Hex(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload)
  const headers = new Map()
  headers.set('host', target.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', String(securityToken ?? ''))
  if (extraHeaders !== undefined && extraHeaders !== null) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (value === undefined || value === null) continue
      headers.set(String(name).toLowerCase(), String(value))
    }
  }
  if (String(method).toUpperCase() !== 'GET') headers.set('content-type', 'application/json')
  const { canonical, signedHeaders, canonicalHash } = buildCanonicalRequest(
    String(method).toUpperCase(),
    uri,
    query,
    headers,
    payloadHash,
  )
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`
  const signature = hmacSha256Hex(Buffer.from(String(sk ?? ''), 'utf8'), Buffer.from(stringToSign, 'utf8'))
  headers.set('Authorization', `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`)
  return {
    headers: Object.fromEntries(headers),
    signedHeaders: signedHeaders.split(';'),
    canonicalHash,
    dateStamp,
  }
}

/**
 * 把签名结果变成**能直接交给 `fetch` 的头**。
 *
 * 两件事都在这里做，因为漏掉任何一件都是静默失败：
 * ① 丢掉 `host`（`fetch` 自己会设，手写一个在 undici 下会抛）；
 * ② 追加调用方给的后置头（**追加在签名之后**，绝不能混进 canonical request）。
 */
export function codeArtsHeaders(signed, postSign = {}) {
  const out = {}
  for (const [name, value] of Object.entries(signed?.headers ?? {})) {
    if (name.toLowerCase() === 'host') continue
    out[name] = value
  }
  for (const [name, value] of Object.entries(postSign)) {
    if (value === undefined || value === null) continue
    out[name] = String(value)
  }
  return out
}

/**
 * 读取类端点（目录 / 积分）的头。
 *
 * ⚠ 那两个头是 `PromptCenter` 那一套，而对话端点用的是 `INFERHUB_AGENT`——
 * 参考实现把这两处**分开写**，本仓照抄这个分家。
 */
export function codeartsReadHeaders(signed) {
  return codeArtsHeaders(signed, { ...CODEARTS_POST_SIGN_HEADERS, 'Content-Type': 'application/json' })
}

// ------------------------------------------------------------------ 凭据

/** 非空字符串，否则 undefined（上游大量字段是「有键无值」）。 */
function textOf(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function recordOf(value) {
  return value !== null && typeof value === 'object' ? value : {}
}

/**
 * 临时凭据三件套 + 过期时间。
 *
 * 形状（本仓自己的记录格式，也是参考实现 `login.ts` 的 `CodeArtsCredential`）：
 * `{ access_key_id, secret_access_key, security_token, expires_at, domain_id?, user_id?, user_name? }`。
 *
 * ⚠ `security_token` 是华为云**临时**凭据（STS）的一部分，**三个值缺一不可**：
 * 只有 AK/SK 会被网关按「永久凭据」处理而拒（签名头里 `x-security-token` 为空串
 * 也会与网关算的不一致）。所以 `usable` 判的是三样齐全，不是「有 AK 就算有凭据」。
 */
export function codeArtsCredentialShape(source) {
  const auth = recordOf(source?.auth ?? source)
  const ak = textOf(auth.access_key_id ?? auth.accessKeyId ?? auth.access)
  const sk = textOf(auth.secret_access_key ?? auth.secretAccessKey ?? auth.secret)
  const token = textOf(auth.security_token ?? auth.securitytoken ?? auth.securityToken)
  const expiresAt = codeArtsExpiryOf(auth)
  const missing = []
  if (ak === undefined) missing.push('access_key_id')
  if (sk === undefined) missing.push('secret_access_key')
  if (token === undefined) missing.push('security_token')
  return { auth, ak, sk, token, expiresAt, missing, usable: missing.length === 0 }
}

/**
 * 过期时刻（毫秒）。**解不出来返回 `undefined`——绝不猜一个寿命**。
 *
 * 认三种写法：`expires_at` / `expiresAt`（数字或字符串，秒或毫秒都认）、
 * 以及华为那份 `2026-09-18T10:15:30Z` 形态的 ISO 串。
 * ⚠ 参考实现 `login.ts` 的 `expiresFromCredential` 在解析失败时回落 **+24h**——
 * 那是**它的**一个兜底估计，本仓不照搬：编一个寿命会让 `needsRefresh` 在一个
 * 未知寿命上做判断，而「不知道」应当是 `undefined`，由调用方决定怎么对待。
 */
export function codeArtsExpiryOf(source) {
  const auth = recordOf(source?.auth ?? source)
  const stated = auth.expires_at ?? auth.expiresAt ?? auth.expiration
  if (typeof stated === 'number' && Number.isFinite(stated)) return stated > 1e12 ? stated : stated * 1000
  if (typeof stated === 'string' && stated.trim().length > 0) {
    const trimmed = stated.trim()
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed > 1e12 ? parsed : parsed * 1000
    const date = Date.parse(trimmed)
    if (Number.isFinite(date)) return date
  }
  return undefined
}

/**
 * 登录票据的两种信封 → 统一凭据。
 *
 * ⚠ **必须认两种**（参考实现 `login.ts:49` 的 `parseCredentialResponse`）：上游在不同
 * 版本 / 不同入口下回的是 `data.credential.*` 或 `data.result.*`，字段名也会换
 * （`securitytoken` vs `securityToken`、`expires_at` vs `expiration`）。
 * 只认一种的表现是「登录成功了但插件说没凭据」，而重试会一直成功、一直没凭据。
 *
 * 两种都不成形时返回 `undefined`——**不返回一个字段全是空串的假凭据**。
 */
export function credsFromTicketResponse(payload) {
  const root = recordOf(payload)
  const data = recordOf(root.data ?? root)

  const credential = recordOf(data.credential)
  const access = textOf(credential.access)
  const credentialToken = textOf(credential.securitytoken ?? credential.securityToken)
  if (access !== undefined && credentialToken !== undefined) {
    return {
      access_key_id: access,
      secret_access_key: textOf(credential.secret) ?? '',
      security_token: credentialToken,
      expires_at: textOf(credential.expires_at ?? credential.expiresAt) ?? '',
      domain_id: textOf(data.domain_id) ?? '',
      user_id: textOf(data.user_id) ?? '',
      user_name: textOf(data.user_name) ?? '',
    }
  }

  const result = recordOf(data.result)
  const accessKeyId = textOf(result.accessKeyId)
  const resultToken = textOf(result.securityToken)
  if (accessKeyId !== undefined && resultToken !== undefined) {
    return {
      access_key_id: accessKeyId,
      secret_access_key: textOf(result.secretAccessKey) ?? '',
      security_token: resultToken,
      expires_at: textOf(result.expiration ?? result.expiresAt) ?? '',
      domain_id: textOf(result.domain_id ?? data.domain_id) ?? '',
      user_id: textOf(result.user_id ?? data.user_id) ?? '',
      user_name: textOf(result.user_name ?? data.user_name) ?? '',
    }
  }

  return undefined
}

/** 票据轮询用的随机 `secret`：32 字节 → 64 字符小写 hex（`login.ts:27` 的 `generateRandomSecret`）。 */
export function codeArtsRandomSecret() {
  return randomBytes(32).toString('hex')
}

// ------------------------------------------------------------------ 目录

/**
 * 模型 id 归一（参考实现 `models.ts` 的 `normalizeModelId`）。
 *
 * ⚠ 判据是「**末 5 字符形如 `-NNNN`**」而不是「末尾有四位数字」：`deepseek-v4-flash-0731`
 * → `deepseek-v4-flash`，但 `glm-5.2` 这种短 id 与 `deepseek-v4.1-flash` 都不该被动。
 * 用裸正则会把 `openpangu-2.0` 之类切坏。
 */
export function normalizeCodeArtsModelId(id) {
  const text = textOf(id)
  if (text === undefined) return ''
  if (text.length > 5 && /-\d{4}$/.test(text)) return text.slice(0, -5)
  return text
}

/**
 * 视觉模型**不在本族的能力面里**（参考实现 `models.ts` 的 `parseModelInfo` 直接过滤掉）。
 *
 * 为什么是「过滤」而不是「播报 `['text','image']`」：这条线上**有否据**——
 * 上游把 `-VL-` / `-VL` 后缀当成多模态型号标记，而 DSH 的对话面走的是文本通道
 * （参考实现也只做文本）。没有否据时默认「可能支持」是 raccoon 那一族的处置
 * （它吃过「图片被静默换成占位符」的亏），这里情况相反，所以处置也相反。
 */
export function isCodeArtsVisionModel(id) {
  const text = textOf(id) ?? ''
  return text.includes('-VL-') || text.endsWith('-VL')
}

/** 目录条目 → 归一形状。`name` 取不到就用 id（**不编一个展示名**）。 */
function normalizeModelEntry(id, name, extra = {}) {
  const normalizedId = normalizeCodeArtsModelId(id)
  if (normalizedId.length === 0) return undefined
  if (isCodeArtsVisionModel(normalizedId)) return undefined
  return { id: normalizedId, name: normalizeCodeArtsModelId(name) || normalizedId, ...extra }
}

/**
 * 一条目录腿 → 条目数组 + **这条腿本身成没成**。
 *
 * ⚠ 成功判据是「**请求成功且形状可识别**」，**不是**「解析出非空列表」：
 * `result.models: []` 是**合法状态**（账号一个 benefit 模型都没有），把它当成
 * 「这条腿失败」会让兜底表盖住一份真实的空目录。参考实现专门为这件事出了
 * `RemoteCatalogOutcome {gatewayOk, builtinOk}` 这个出参。
 *
 * @returns {{ entries: Array<{id,name}>, ok: boolean }}
 */
export function parseCodeArtsModelSource(kind, payload) {
  const root = recordOf(payload)
  const list =
    kind === 'gateway'
      ? recordOf(root.result).models
      : kind === 'builtin'
        ? root.builtinModels
        : undefined
  if (!Array.isArray(list)) return { entries: [], ok: false }
  const entries = []
  const seen = new Set()
  for (const raw of list) {
    const entry = recordOf(raw)
    const id = entry.model_id ?? entry.id ?? entry.modelId
    if (textOf(id) === undefined) continue
    const normalized = normalizeModelEntry(id, entry.model_name ?? entry.name)
    if (normalized === undefined) continue
    if (seen.has(normalized.id)) continue
    seen.add(normalized.id)
    entries.push(normalized)
  }
  return { entries, ok: true }
}

/**
 * 两处目录合并 → 本族的模型列表。
 *
 * 两处都要（参考实现同时查 `gateway/config` 与 `/v1/model/builtin`）：
 * benefit 模型只在 gateway 那一份里，常规模型只在 builtin 那一份里。
 *
 * `outcome` 是**如实出参**，供调用方决定能不能把结果当成「完整目录」缓存下来
 * ——一次失败被当成「目录就是这样」会让账号在这个进程里永久少一半模型。
 *
 * @returns {{ models: Array<{id,name,benefit}>, outcome: {gatewayOk: boolean, builtinOk: boolean} }}
 */
export function parseCodeArtsModels({ gateway, builtin } = {}) {
  const gatewaySource = parseCodeArtsModelSource('gateway', gateway)
  const builtinSource = parseCodeArtsModelSource('builtin', builtin)
  const models = []
  const seen = new Set()
  for (const entry of gatewaySource.entries) {
    seen.add(entry.id)
    // ⚠ benefit 集合**只由 gateway 那条腿决定**，且只认**未被归一改写过的 id**
    // （`models.ts` 的 `rawId.length>0 && normalizeModelId(rawId)===rawId`）：
    // `deepseek-v4-flash-0731` 与 `deepseek-v4-flash` 在后端是**两个模型**、
    // benefit 属性相反，把改写后的 id 记进集合会让非 benefit 的那个被带上
    // `maas_type: benefit` 而回 404。
    models.push({ id: entry.id, name: entry.name, benefit: true })
  }
  for (const entry of builtinSource.entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    models.push({ id: entry.id, name: entry.name, benefit: false })
  }
  return { models, outcome: { gatewayOk: gatewaySource.ok, builtinOk: builtinSource.ok } }
}

// ------------------------------------------------------------------ benefit

/**
 * benefit（免费额度）模型的静态兜底集合（参考实现 `models.ts` 的
 * `CODEARTS_BENEFIT_FALLBACK`，2026-09-26 实测）。
 *
 * ⚠ **判定不能靠名字**：`glm-5.3-flash` 是 benefit，而 `deepseek-v4-flash`
 * （同样以 `-flash` 结尾、同样无 `-0731` 后缀）**不是**。参考实现早期按「名字带 flash」
 * 判，用户报障「发消息后报 Insufficient Balance / QUOTA」——因为缺该头时后端
 * 按非 benefit 通道处理那个模型。
 *
 * 这个兜底表只在**两条目录腿都读不到**时使用；读到真目录时以目录为准。
 */
export const CODEARTS_BENEFIT_FALLBACK = Object.freeze(['glm-5.3-flash', 'deepseek-v4.1-flash'])

/**
 * 这个模型该不该带 `maas_type: benefit`。
 *
 * 三条来源按优先级：调用方给的**本次目录**（`catalog`，形如 `parseCodeArtsModels()`
 * 的 `models`）→ 静态兜底表。**没有第四档**：不猜、不按名字判。
 */
export function isBenefitModel(model, catalog) {
  const id = textOf(model)
  if (id === undefined) return false
  if (Array.isArray(catalog)) {
    const hit = catalog.find((entry) => entry?.id === id)
    if (hit !== undefined) return hit.benefit === true
  }
  return CODEARTS_BENEFIT_FALLBACK.includes(id)
}

// ------------------------------------------------------------------ 积分

/** 总额口径的 metric 名（`codearts-credits.ts:150`）。**只认它一个**当总额。 */
export const CODEARTS_TOTAL_CREDIT_METRIC = 'usageTotalPackageCredit'

/** 分类口径（总额缺失时才回退求和）。 */
export const CODEARTS_SPLIT_CREDIT_METRICS = Object.freeze([
  'usageBasicPackageCredit',
  'usageOnDemandPackageCredit',
  'usageBonusPackageCredit',
])

const CREDIT_AMOUNT_FIELD = 'package_credit_amount'
const CREDIT_USED_FIELD = 'package_credit_used'
const CREDIT_REMAIN_FIELD = 'package_credit_remain'

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * `metrics[]` → 积分读数。
 *
 * 逐条口径（`codearts-credits.ts:381-420` 的 `parseCreditBalance`，全是它真机实测的）：
 *
 * - 总额取 `usageTotalPackageCredit` 的 `package_credit_remain`，**不累加分类**
 *   （分类是总额的分解，加起来会重复计）；
 * - 总额缺失**才**回退成三个分类的和；
 * - `amount <= 0 && remain <= 0` 的分类**不列入** `packages`（那是「没有这一档」，
 *   不是「这一档剩 0」）；
 * - **一个 credit metric 都没有 ⇒ 返回 `undefined`**（＝这个账号没有积分口径），
 *   与 `total: 0`（有口径、余额恰好为 0）**严格区分**。
 *   ⚠ 这是本文件最重要的一条：**绝不把「读不到」编成 0**，那会让用户在面板上
 *   看到一条「额度 0%」的假读数，而真相是「这个账号是 Token 计费的，压根没有积分」。
 *
 * @returns {{ total: number, remaining: number, packages: Array<{name,amount,used,remain}> } | undefined}
 */
export function parseCodeArtsCredits(payload) {
  const root = recordOf(payload)
  const data = recordOf(root.data ?? root)
  const metrics = data.metrics
  if (!Array.isArray(metrics)) return undefined
  let totalAmount
  let totalRemain
  let splitRemain = 0
  let sawSplit = false
  let sawAnyCredit = false
  const packages = []
  for (const raw of metrics) {
    const metric = recordOf(raw)
    const name = textOf(metric.name)
    if (name === undefined) continue
    const isSplit = CODEARTS_SPLIT_CREDIT_METRICS.includes(name)
    if (name !== CODEARTS_TOTAL_CREDIT_METRIC && !isSplit) continue
    const amount = finiteNumber(metric[CREDIT_AMOUNT_FIELD])
    const used = finiteNumber(metric[CREDIT_USED_FIELD])
    const remain = finiteNumber(metric[CREDIT_REMAIN_FIELD])
    if (amount === undefined && used === undefined && remain === undefined) continue
    sawAnyCredit = true
    if (name === CODEARTS_TOTAL_CREDIT_METRIC) {
      totalAmount = amount
      totalRemain = remain
      continue
    }
    sawSplit = true
    splitRemain += remain ?? 0
    if ((amount ?? 0) > 0 || (remain ?? 0) > 0) {
      packages.push({ name, amount: amount ?? 0, used: used ?? 0, remain: remain ?? 0 })
    }
  }
  if (!sawAnyCredit) return undefined
  const remaining = totalRemain ?? (sawSplit ? splitRemain : undefined)
  if (remaining === undefined) return undefined
  return { total: totalAmount ?? remaining, remaining, packages }
}

/**
 * 账号 / 套餐信息（`codearts-credits.ts` 的 `CodeArtsAccountInfo`）+ 积分读数。
 *
 * `packageName` 优先中文名（`package_name_cn`）——面板上给中文用户看的是它。
 * 读不到 `data.package` 时字段如实回 `false` / `''`，**不编一个套餐名**。
 */
export function parseCodeArtsAccountInfo(payload) {
  const root = recordOf(payload)
  const data = recordOf(root.data ?? root)
  const pkg = recordOf(data.package)
  const cn = textOf(pkg.package_name_cn)
  const en = textOf(pkg.package_name_en)
  return {
    isCreditPackage: pkg.is_credit_package === true,
    isTokenPackage: pkg.is_token_package === true,
    specCode: textOf(pkg.spec_code) ?? '',
    packageName: cn ?? en ?? '',
    packageStatus: textOf(pkg.status) ?? '',
    credit: parseCodeArtsCredits(payload),
  }
}

// ------------------------------------------------------------------ 失败归类

/** 把上游错误体里的可用文案抽出来（`llm-adapter.ts:582` 的 `errorDetail`）。 */
export function codeArtsErrorDetail(payload, text = '') {
  const parts = []
  const push = (value) => {
    const said = textOf(value)
    if (said !== undefined && !parts.includes(said)) parts.push(said)
  }
  if (typeof text === 'string' && text.trim().length > 0) {
    const json = codeArtsParseJson(text)
    if (json === undefined) return text.trim()
    const error = recordOf(json.error)
    push(error.code)
    push(error.type)
    push(error.message)
    push(json.error_code)
    push(json.error_msg)
    push(json.message)
    return parts.length > 0 ? parts.join(' ') : text.trim()
  }
  return ''
}

/**
 * 这一条错误是不是「**等一会儿就通**」的排队 / 限流。
 *
 * 判据（`llm-adapter.ts:488` 的 `isQueueError`，逐字照抄）：
 * `400` **且**报文里是 `TM.00001041` / `peak usage|try again after|peak hours` /
 * `high demand|too many requests`。三条腿都要（码值 + 文案两条腿），
 * 因为上游换过码值表达同一语义。
 *
 * ⚠ 返回 `true` 时的处置是**不换号、不写冷却**：这是**网关按账号限的并发**，
 * 不是账号的错。把它归成 `RATE_LIMIT` 会给一个好号写 5 分钟冷却，
 * 而真正的解法是等（或降并发）。
 */
export function isQueueError(status, body) {
  if (status !== 400) return false
  const text = typeof body === 'string' ? body : ''
  return (
    text.includes(CODEARTS_QUEUE_BUSINESS_CODE) ||
    /peak\s+usage|try\s+again\s+after|peak\s+hours/i.test(text) ||
    /high\s+demand|too\s+many\s+requests/i.test(text)
  )
}

/**
 * SSE 流内那个 `error_code` 是不是排队 / 限流（`llm-adapter.ts:545` 的
 * `isSseQueueErrorCode`）。
 *
 * ⚠ **`429` 必须锚成独立数字**：这一条是参考实现用一次真缺陷换来的
 * ——裸子串 `/…|429|…/` 会让额度耗尽码 `InferHub.4291.200` 里的 `4291` 命中
 * `429` 前缀 ⇒ 被当成「可重试的排队」⇒ 每 10 秒重试、上限 180 次（30 分钟）
 * ⇒ **界面完全零输出**（排队期间刻意不产出内容块），用户只能手动中止。
 */
export function isSseQueueErrorCode(code) {
  const text = textOf(code) ?? ''
  if (text === CODEARTS_QUEUE_BUSINESS_CODE) return true
  return /81111|TPM|(^|[^0-9])429([^0-9]|$)|rate.?limit|too many requests|排队|限流/i.test(text)
}

/**
 * 额度真的用尽（**不可重试**）。
 *
 * ⚠ 与排队必须分开：排队是「等一会儿就通」，额度是「等多久都没用」。判据用**子串**
 * `4291` 而不是全等（上游可能用 `InferHub.4291.xxx` 表达同一语义），文案
 * `insufficient quota` 作为第二条腿——上游换码值时还能命中。
 *
 * 实测报文（参考实现 2026-10-02，真实凭据，**HTTP 200 + SSE**）：
 * `data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota",…}`。
 * 同账号的非 benefit 模型仍正常 ⇒ 这是「该模型 + 该账号的免费额度用尽」，
 * **不是账号欠费**（同期积分余额仍有 8499.84）。
 */
export function isQuotaExhaustedErrorCode(code, message) {
  const said = textOf(code) ?? ''
  const text = textOf(message) ?? ''
  return said.includes('4291') || /insufficient[\s_-]+quota/i.test(text)
}

/**
 * 账号没有 benefit 包（`llm-adapter.ts:30-36`）。
 *
 * ⚠ 它走的是 **HTTP 200 + SSE 内嵌错误**这条路，而正确处置是**去掉
 * `maas_type: benefit` 头重试一次**（同一个账号、同一个模型、同一份凭据）。
 * 所以这个判定不能落到 `health.js` 的分类器上——那会变成「账号失败、换号」，
 * 而换号解决不了「这个账号没有 benefit 包」，只会把整个池子轮一遍。
 */
export function isBenefitNotFound(payload, code, message) {
  const json = codeArtsParseJson(typeof payload === 'string' ? payload : '')
  const candidates = [code, message, json?.error_code, json?.error_msg, json?.message, payload]
  return candidates.some((value) => (textOf(value) ?? '').includes(CODEARTS_BENEFIT_NOT_FOUND_CODE))
}

/** benefit 模型没带 `maas_type: benefit`（`llm-adapter.ts:1284`）。**它恰恰要靠带上该头解决**。 */
export function isModelNotRegistered(status, body) {
  if (status !== 404) return false
  const text = typeof body === 'string' ? body : ''
  return text.includes(CODEARTS_MODEL_NOT_REGISTERED_CODE) || /model is not registered/i.test(text)
}

/**
 * APIG 网关的鉴权失败码。
 *
 * ⚠ `APIG.0301` / `APIG.0602` **必须按码值判、不能只看状态码**——本仓 2026-10-11
 * 真机捕获过（见 `THIRD_PARTY_NOTICES.md` 的捕获段）：`x-security-token` 格式不对时
 * 网关回的是 **HTTP 400**（不是 401），只按状态码会把它归成 `SERVER`
 * ⇒ 换号 + 60 秒冷却，而这个错误要做的是**重新登录**。
 */
const CODEARTS_AUTH_CODES = /APIG\.0301|APIG\.0602/i
const CODEARTS_AUTH_WORDS = /invalid\s+token|token\s+expired|token\s+is\s+invalid|verify\s+ak\s+sk\s+signature\s+fail|x-auth-token\s+not\s+found|failed\s+parse\s+aksk\s+format/i

/**
 * APIG 说「这个 API 不存在 / 方法不对」（本仓真机捕获：`POST …/api/v1/queue/status`
 * → `404 {"error_code":"APIG.0101"}`）。
 *
 * 单独列出来是因为它**不是账号问题**：`health.js` 对 SERVER 换号 + 60 秒冷却，
 * 而这个错误换多少个号都一样。它属于「我们发错了请求」，应当在诊断里说清楚。
 */
const CODEARTS_GATEWAY_ROUTE_CODE = /APIG\.0101/i

/**
 * CodeArts 的失败归类。**仅用于诊断与断言**——真正决定「换不换号、停多久」的
 * 是共享的 `./http-error.js` → `../health.js` 那两张表，本仓不另写一套
 * （理由见 `./raccoon.js` 的 `classifyRaccoonFailure` 上那段注释：两份判据一定会漂移）。
 *
 * 状态码**先判**，因为这一家的 401/403 有两层含义（网关签名失败 vs 账号没额度），
 * 而网关那层必须靠码值区分：
 *
 * | 输入 | 结论 | 处置 |
 * |---|---|---|
 * | `TM.00001041` / `81111.429` / 排队文案 | `'queue'` | **不换号、不写冷却**（网关按账号限并发） |
 * | `InferHub.4291.200` / `insufficient quota` | `'quota'` | 额度用尽：换号 + 冷却（按 UTC+8 当日 24:00） |
 * | 401 / 403 / `APIG.0301` / `APIG.0602` | `'auth'` | 凭据失效：换号，**并提示重新登录**（`refresh` 是 no-op，见族里） |
 * | 404 + `model is not registered` | `'benefit'` | 缺 `maas_type: benefit` 头：**补上头重试**，与账号无关 |
 * | 400 + context 措辞 | `'context'` | 上下文超限：不换号（`health.js` 对它不换也不罚） |
 * | `APIG.0101`（我们发错了路径 / 方法） | `'route'` | **不是账号问题**：换多少号都一样，只加诊断 |
 * | 其余 | `'other'` | 交给状态码那一套 |
 *
 * @returns {'auth'|'quota'|'queue'|'benefit'|'context'|'route'|'other'}
 */
export function classifyCodeArtsFailure(status, payload) {
  const text = typeof payload === 'string' ? payload : ''
  const detail = codeArtsErrorDetail(payload, text)
  if (isQuotaExhaustedErrorCode(detail, detail)) return 'quota'
  // ⚠ 顺序不可颠倒：额度耗尽（`4291`）必须先于排队判据，否则前缀会互相命中
  // （参考实现为此专门加了 `429` 的数字边界，见 `isSseQueueErrorCode`）。
  if (text.includes(CODEARTS_QUEUE_BUSINESS_CODE) || /81111\.429/.test(detail) || isSseQueueErrorCode(detail)) return 'queue'
  if (isQueueError(status, text)) return 'queue'
  if (isModelNotRegistered(status, text)) return 'benefit'
  // ⚠ 鉴权码值排在状态码之前：真机上 `APIG.0602` 走的是 **HTTP 400**，
  // 按状态码会掉进 `other`/`SERVER`（换号 + 60 秒冷却），而这个错要重新登录。
  if (CODEARTS_AUTH_CODES.test(detail) || CODEARTS_AUTH_WORDS.test(detail)) return 'auth'
  if (status === 401 || status === 403) return 'auth'
  if (CODEARTS_GATEWAY_ROUTE_CODE.test(detail)) return 'route'
  if (status === 429) return 'queue'
  if (status === 400 && /context/i.test(detail)) return 'context'
  return 'other'
}

/**
 * 把 HTTP 失败说明成人能看懂的句子。
 *
 * ⚠ 为什么不能只写「HTTP 401」（`codearts-credits.ts` 的 `describeHttpFailure` 的
 * 那条教训）：这一家的 401 至少有三个完全不同的成因——签名头位置不对
 * （`APIG.0301`）、SecurityToken 过期（`APIG.0602`）、AK 没有权限。
 * 三种在界面上长得一模一样，而用户要做的事完全不同（改代码 / 重新登录 / 申请权限）。
 */
export function describeCodeArtsFailure(status, payload) {
  const text = typeof payload === 'string' ? payload : ''
  const json = codeArtsParseJson(text)
  const code = textOf(json?.error_code) ?? textOf(recordOf(json?.error).code)
  const message = textOf(json?.error_msg) ?? textOf(json?.message) ?? textOf(recordOf(json?.error).message)
  const parts = [`HTTP ${status}`]
  if (code !== undefined) parts.push(code)
  if (message !== undefined) parts.push(message)
  else if (text.trim().length > 0) parts.push(text.trim().slice(0, 200))
  return parts.join(' ')
}

function codeArtsParseJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
