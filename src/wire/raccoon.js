/**
 * Raccoon（商汤小浣熊）的纯函数协议层——请求构造、响应归一、额度投影。
 *
 * **SSE 翻译刻意不在这里**：上游的对话端点是标准 OpenAI 兼容 + 标准 SSE
 * （`chat.completion.chunk` + `data: [DONE]`，无信封、无加密、无格式转换），
 * 与 Qoder / Loomy 同形 ⇒ 直接复用 `./chat-completions.js` 的 `translateChatStream`，
 * 不为「对称」再抄一份翻译器。
 *
 * 本文件里的协议事实**全部借自**另一个中文插件 dsh-codearts-auth 的源码注释
 * （`temp/codearts/src/raccoon-*.ts`，MIT），逐条标了出处与强度；哪些是本仓真机复验的、
 * 哪些只是照抄，登记在 `THIRD_PARTY_NOTICES.md` 的「借用的证据」一节。
 * @module dsh-account-bridge/wire/raccoon
 */

import { join } from 'node:path'
import { decodeJwtPayload } from '../util.js'

/** 上游基址（参考实现 `src/raccoon.ts:25`，与 `raccoon-product.ts:345-368` 的 `apiBase` 一致）。 */
export const RACCOON_API_BASE = 'https://xiaohuanxiong.com'

/** 认证前缀（`src/raccoon.ts:28`）。 */
export const RACCOON_AUTH_PREFIX = '/api/web/auth/v1'

/** 对话前缀（`src/raccoon.ts:30`）。 */
export const RACCOON_LLM_PREFIX = '/api/web/llm/v2'

/** 积分前缀（`src/raccoon.ts:32`）。 */
export const RACCOON_POINTS_PREFIX = '/api/web/points/v1'

/** 桌面端前缀——登录奖励那条写端点在这里（`src/raccoon.ts:34`），本仓**不实现**它。 */
export const RACCOON_DESKTOP_PREFIX = '/api/web/desktop/v1'

/** 对话端点（`raccoon-adapter.ts:587` 拼的就是这三段）。 */
export const RACCOON_CHAT_URL = `${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}/chat/completions`

/** 模型目录端点（`raccoon-product.ts:23-25` 的兜底表就是 2026-09-26 从它拉的）。 */
export const RACCOON_CATALOG_URL = `${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}/model_catalog`

/** 续期端点（`raccoon-oauth.ts:289-319`）。请求体是扁平的 `{refresh_token}`。 */
export const RACCOON_REFRESH_URL = `${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/refresh`

/** 用户信息端点（`raccoon-oauth.ts:330-359`）——多账号消歧的唯一来源。 */
export const RACCOON_USER_INFO_URL = `${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/user_info`

/** 积分余额端点（`raccoon-credits.ts:129-163`）。**只读**，本仓只碰这一个业务写以外的端点。 */
export const RACCOON_BALANCE_URL = `${RACCOON_API_BASE}${RACCOON_POINTS_PREFIX}/balance`

/**
 * 提前多久续期（参考实现 `src/raccoon.ts:52` 的 `RACCOON_TOKEN_REFRESH_WINDOW_SECONDS = 300`）。
 *
 * access_token 寿命约 3 小时（`raccoon-auth.ts:411-434` 的注释），5 分钟余量足够，
 * 又不会让每 30 分钟一轮的调度器反复白打请求。
 */
export const RACCOON_REFRESH_LEAD_MS = 5 * 60_000

/** 业务端点的请求超时（`src/raccoon.ts:55`，60000ms；本仓只在自己的探测里用）。 */
export const RACCOON_REQUEST_TIMEOUT_MS = 60_000

/**
 * 「钱」义词——`insufficient` 这类词**单独出现时过宽**，必须与它们共现才算额度问题。
 *
 * 参考实现 `raccoon-adapter.ts:274-278` 的原话：`insufficient` 单独出现会误伤至少 5 类
 * 与额度无关的报文（如 `context window is insufficient for this model`）。
 * 本仓的共享层 `./failure-words.js` 已经把这条教训吸收进 `CREDIT_WORDS`
 * （`insufficient` 必须挨着 `balance|credit|fund`），所以这里**只做补充、不做替代**：
 * 这几条是「积分」这条线特有的中文与业务码，共享层不认。
 */
const POINTS_WORDS = /积分|余额|点数|points?\s*(?:is|are)?\s*(?:not\s+enough|insufficient)/
/** 参考实现 `raccoon-adapter.ts:272` 认的那个业务码（`14018 Credits exhausted`）。 */
const CREDIT_CODE = '14018'

/**
 * 上游对话线上那三个「会话身份」字段这里为什么一个都没有。
 *
 * 契约 §5 说的 `x-claude-code-session-id` / `metadata.user_id` / `prompt_cache_key`
 * 是 **Claude 线**的形状（三处必须同值，用 `accountScopedSession()` 派生）。
 * Raccoon 这条线的请求头里没有任何一个：它认的只有 `Authorization` 与 `X-Org-Code`
 * （见本文件 `raccoonHeaders`，以及参考实现 `raccoon-adapter.ts:574-581` 的头清单）。
 * 写在这里是为了让下一个改这里的人知道——**不是漏了**，是这条线本来就没有那个字段，
 * 所以既没有裸会话 id 可泄漏，也不存在「三处同值」的问题。
 */

/**
 * `X-Client-Platform` 的合法取值。
 *
 * ⚠ 参考实现 `raccoon-product.ts:175-182` 明确记着：取值**只能**是这三个，
 * 依据是客户端主进程 `desktopDeviceIdentity.js` 的 `resolveDesktopClientPlatform`
 * （`win32` → `desktop-windows`）。猜错会被 `desktop/v1/login/points/grant` 拒；
 * 对话端点上没有「它必需」的证据，但既然要发就发对的。
 */
const CLIENT_PLATFORMS = new Set(['desktop-windows', 'desktop-macos', 'desktop-linux'])

/**
 * 本机客户端形态 → `X-Client-Platform` 时用的平台值。
 *
 * 未知平台**不编**：`win32` 是绝大多数情况，而且这个头只在「要发」时才发。
 * 传 `source` 是为了让调用方能用同一个函数把凭据里记着的值判一遍。
 */
export function raccoonClientPlatform(source = process.platform) {
  if (typeof source === 'string' && CLIENT_PLATFORMS.has(source)) return source
  if (source === 'win32') return 'desktop-windows'
  if (source === 'darwin') return 'desktop-macos'
  if (source === 'linux') return 'desktop-linux'
  return 'desktop-windows'
}

/**
 * 业务端点通用头（参考实现 `src/raccoon.ts:264-293` 的 `raccoonHeaders`）。
 *
 * 逐字事实：
 * - `X-Org-Code: ${office_identity ?? ''}`——个人账号发**空串**，客户端总是发这个头
 *   （所以这里也总是发，不发空串与不发头在服务端可能不是一回事）；
 * - `X-Raccoon-Language: zh`；
 * - `X-Client-Platform` / `X-Client-Version` / `X-Client-Device-ID` 是**可选的**：
 *   `device_id` 非空才发。本仓**不自己派生** `device_id`（没有「服务端校验它」的证据，
 *   编一个 32 位 hex 发过去只是多一个不可信输入）；凭据记录里有就带，没有就不发。
 *
 * @param {object} auth 凭据记录里的 `auth`
 * @param {{ platform?: string, version?: string }} [options]
 */
export function raccoonHeaders(auth, options = {}) {
  const access = typeof auth?.access_token === 'string' ? auth.access_token : ''
  const headers = {
    // 默认按 JSON 发；只要读取类端点都用它。对话端点由调用方在展开之后覆盖成
    // `text/event-stream`（`{...raccoonHeaders(auth), accept: 'text/event-stream'}`）——
    // 不在这里加一个「传啥就发啥」的开关，那种开关只会让调用点更难读。
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${access}`,
    'x-org-code': typeof auth?.office_identity === 'string' ? auth.office_identity : '',
    'x-raccoon-language': 'zh',
  }
  const platform = options.platform ?? auth?.client_platform
  if (typeof platform === 'string' && platform.length > 0) headers['x-client-platform'] = platform
  const version = options.version ?? auth?.client_version
  if (typeof version === 'string' && version.length > 0) headers['x-client-version'] = version
  if (typeof auth?.device_id === 'string' && auth.device_id.length > 0) headers['x-client-device-id'] = auth.device_id
  return headers
}

// ------------------------------------------------------------------ 回应信封

/**
 * 上游统一信封 `{code, message, details}` → 一个能判定的对象。
 *
 * ⚠ 共享的 `./http-error.js` **不认顶层 `details`**（它读 `error.message` / `message`），
 * 而这一家的 `message` 恰好是「令牌无效」这类可用文案，所以 `httpError()` 的 `detail`
 * 够用；但**业务码 `code` 拿不到**（它是数值，不在 `error.code` 那条路上）。
 * 需要按业务码分支（续期那条 200003）时就得解这一层——这就是它存在的理由。
 *
 * @returns {{ ok: boolean, code: number | undefined, message: string | undefined, data: object | undefined, raw: any }}
 */
export function parseRaccoonEnvelope(payload) {
  const raw = payload
  const record = payload !== null && typeof payload === 'object' ? payload : {}
  const code = typeof record.code === 'number' ? record.code : undefined
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : typeof record.details === 'string' && record.details.length > 0
        ? record.details
        : undefined
  const data = record.data !== null && typeof record.data === 'object' ? record.data : undefined
  return { ok: code === 0, code, message, data, raw }
}

// ------------------------------------------------------------------ 凭据形态

/**
 * JWT 的 `exp`（毫秒）。解不出来返回 `undefined`——**绝不猜一个寿命**。
 *
 * 参考实现 `raccoon-auth.ts:279-295` 就是从 `access_token` 里解 `exp` 的
 * （`decodeJwtExpMs`），并把它写成记录里的 `expires_at`（**毫秒时间戳字符串**）。
 */
export function raccoonTokenExpiry(accessToken) {
  const claims = decodeJwtPayload(accessToken)
  const exp = claims?.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined
  // `exp` 是秒（JWT 规范）；<= 1e12 视为秒，再大就已是毫秒，避免双倍换算。
  return exp > 1e12 ? exp : exp * 1000
}

/**
 * 凭据记录里那个 `expires_at` 字符串（参考实现的形状）或 `expiresAt` 数字 → 毫秒。
 * 两个键都认：本仓自己写的是 `expiresAt`（数字），而从别处导入的记录可能是字符串。
 */
export function raccoonExpiryOf(auth) {
  const stated = auth?.expiresAt ?? auth?.expires_at
  if (typeof stated === 'number' && Number.isFinite(stated)) return stated > 1e12 ? stated : stated * 1000
  if (typeof stated === 'string' && stated.trim().length > 0) {
    const parsed = Number(stated.trim())
    if (Number.isFinite(parsed)) return parsed > 1e12 ? parsed : parsed * 1000
  }
  return raccoonTokenExpiry(auth?.access_token)
}

/**
 * 粘贴进来的东西像什么。`'jwt'` 三段点分（也可能是不透明令牌）、`'empty'` 没粘、
 * `'short'` 太短不像令牌。
 *
 * ⚠ 这里**刻意不判「是不是 access_token」**：两类令牌在上游都是不透明字符串，
 * 形态上分不开（都是同一套 JWT 或不透明串）。粘错了由 `user_info` 那次真请求兜住。
 */
export function raccoonCredentialShape(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return 'empty'
  if (text.length < 16) return 'short'
  return text.split('.').length === 3 ? 'jwt' : 'opaque'
}

// ------------------------------------------------------------------ 用户信息

/** `user_info` 的字段映射（`raccoon-oauth.ts:330-359`）：只带上非空的。 */
export function raccoonUserInfoFrom(payload) {
  const envelope = parseRaccoonEnvelope(payload)
  const data = envelope.data ?? {}
  const info = {}
  if (typeof data.id === 'string' && data.id.length > 0) info.userId = data.id
  if (typeof data.name === 'string' && data.name.length > 0) info.nickname = data.name
  if (typeof data.office_identity === 'string' && data.office_identity.length > 0) info.officeIdentity = data.office_identity
  if (typeof data.phone === 'string' && data.phone.length > 0) info.phone = data.phone
  return info
}

/**
 * 账号显示名。
 *
 * ⚠ 参考实现 `src/raccoon.ts:78-106` 记了两条踩过的坑，本仓照抄结论：
 * - 服务端 `user_info.name` 是**自动生成的默认名**（实测值 `RaccoonAva`），
 *   微信扫码还**不回传微信昵称** ⇒ 拿它当账号名等于每个号都叫同一个名字；
 * - `phone` 才是**多账号消歧的唯一可靠依据**。
 * 所以优先级是 phone → 组织码 → 昵称 → 一句诚实的中性名。**绝不编一个人名**。
 */
export function raccoonLabel(info, fallback = 'Raccoon') {
  if (typeof info?.phone === 'string' && info.phone.length > 0) return `Raccoon ${info.phone}`
  const identity = info?.officeIdentity
  if (typeof identity === 'string' && identity.length > 0 && identity !== 'personal') return `Raccoon ${identity}`
  if (typeof info?.nickname === 'string' && info.nickname.length > 0) return `Raccoon ${info.nickname}`
  return fallback
}

// ------------------------------------------------------------------ 模型目录

/**
 * 目录响应 → 归一后的条目数组。
 *
 * 形状（参考实现 `raccoon-auth.ts:627-657` 的 `parseRaccoonModelCatalog` +
 * `:137-187` 的 `normalizeRemoteModel`）：
 * `{code:0, data:{categories:[{type:'chat', models:[…]}]}}`，取 **`type === 'chat'`**
 * 那一类（实测只有一个），逐条归一。
 *
 * ⚠ 条目里的 `name` **就是**发给 `chat/completions` 的 `model`（远端把它当 id 用），
 * 不是展示名——展示名是 `description`。参考实现整个把这一点压在 `normalizeRemoteModel`
 * 的第一行里，照抄容易看成「id 取自某个叫 id 的字段」，那样会拿到 undefined。
 *
 * @returns {Array<{id, description, contextWindow, maxTokens, effective, base, status, statusNote}>}
 */
export function parseRaccoonCatalog(payload) {
  const envelope = parseRaccoonEnvelope(payload)
  if (!envelope.ok) return []
  const categories = Array.isArray(envelope.data?.categories) ? envelope.data.categories : []
  const chat = categories.find((category) => category !== null && typeof category === 'object' && category.type === 'chat')
  const models = Array.isArray(chat?.models) ? chat.models : []
  const out = []
  const seen = new Set()
  for (const entry of models) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (id.length === 0) continue
    // `visible === false` 直接排除；**缺省视为可见**——`undefined` 不等于「关掉了」，
    // 把它当隐藏会让整个目录在字段改名时空掉。
    if (entry.visible === false) continue
    if (seen.has(id)) continue
    seen.add(id)
    const params = entry.params !== null && typeof entry.params === 'object' ? entry.params : {}
    const normalized = {
      id,
      description:
        typeof entry.description === 'string' && entry.description.length > 0 ? entry.description : id,
      contextWindow: firstPositiveInt([params.context_window, entry.context_window]),
      maxTokens: firstPositiveInt([params.max_tokens, entry.max_tokens]),
      effective: finiteNumber(entry.billing_effective_multiplier),
      base: finiteNumber(entry.billing_multiplier),
      status: entry.billing_status === 'discount' || entry.billing_status === 'limited_free' ? entry.billing_status : 'normal',
      statusNote: typeof entry.billing_status_note === 'string' ? entry.billing_status_note : '',
    }
    out.push({ ...normalized, displayName: raccoonDisplayName(normalized) })
  }
  return out
}

/**
 * 倍率数字 → 展示串。最多 4 位小数（服务端实测最多 2 位），去掉尾随零。
 * 对应参考实现 `src/raccoon.ts:220-223` 的 `formatMultiplier`。
 */
export function formatRaccoonMultiplier(value) {
  return String(Number(Number(value).toFixed(4)))
}

/**
 * 目录条目 → **展示名**。
 *
 * ⚠ 这里照抄参考实现 `src/raccoon.ts:243-262` 的 `raccoonDisplayName`，因为它的三条
 * 规则都是用户报障换来的：① 倍率必须拼进 `name`，**不是** `description`
 * （composer 的模型切换菜单只渲染 `name`，`description` 仅用于 `/model` 弹窗）；
 * ② **1 倍也要显示**（原话：「为什么 Kimi-K3 没有倍率，ide 是 1 倍，1 倍也要显示倍率」）——
 * 省略 1 倍会让用户分不清「就是 1 倍」与「我们没取到」；③ 取不到倍率时**什么都不加**，
 * 「恰好 1 倍」与「没有这个数」是两回事。
 *
 * 拼装权**放在 wire 层**（纯函数），因为「远端目录字段 → 展示名」是协议事实，
 * 与族的编排无关；族那一侧只负责调用。
 */
export function raccoonDisplayName(entry) {
  const name = typeof entry?.description === 'string' && entry.description.length > 0 ? entry.description : entry?.id ?? ''
  const effective = finiteNumber(entry?.effective)
  if (effective === undefined || effective < 0) return name
  // 免费**不是**「x0」：0 倍是「这一档不要钱」，展示成 x0 会被读成「不要用」。
  if (effective === 0) return `${name} · 免费`
  const base = finiteNumber(entry?.base)
  if (base !== undefined && effective < base) return `${name} · x${formatRaccoonMultiplier(base)}→x${formatRaccoonMultiplier(effective)}`
  return `${name} · x${formatRaccoonMultiplier(effective)}`
}

/**
 * 参考实现自评里那个**最贵的坑**：`tags` 不是能力契约。
 *
 * `raccoon-product.ts:267-326` 记着一整条因果链——它曾按「远端 `tags` 含 `vision`」
 * 判定图片能力，而 `sn-deepseek-v4-1-flash` 的 tags 恰好**没有** `vision`，
 * 于是 `inputModalities` 播报 `['text']` ⇒ **DSH 在 `LlmRuntime` 里把图片替换成
 * 文本占位符**（`projectImagesForTextModel`）⇒ 图片根本没发出去，用户看到的是模型说
 * 「我读不到图片」，而端点完全正常。
 *
 * 它用「带随机 6 位数字的图」实测推翻了 tags：`sn-deepseek-v4-1-flash` **5/5** 读对、
 * `sn-glm-5-3-flash` 1/1、`sn-sensenova-6-8-flash` 2/2、`-lite` 1/1、`sn-kimi-k3` 1/1；
 * `sn-glm-5-3` 只有 **1/3**（它自己标注为 provider 侧 3 个 fallback 组不一致，**不归我们**）。
 * 并且它穷举了 9 个条目的键并集：顶层 14 键、`params` 只有 `context_window` / `max_tokens`，
 * 用 `/modal|vision|image|img|multimodal|media|type|capab|support|input|output/i` 扫描
 * **命中 0 个** ⇒ 远端**从未下发**模态字段。
 *
 * ⇒ 本仓的处置：**不按 tags 判能力**，一律如实播报 `['text','image']`。
 * 参考实现用的是「显式白名单 + tags」两段式（`RACCOON_IMAGE_CAPABILITY_OVERRIDES`），
 * 本仓不需要白名单是因为目录**不给**我们模态字段（没有可用的否据），而在没有否据时
 * 默认「可能支持」与它 6/6 的实测一致；真遇到纯文本模型，代价是一条清楚的 400，
 * 好过图片被静默换成占位符、用户完全不知道为什么。
 *
 * ⚠ 本仓**没有**复验这条（无账号）——它属于 README 里要写明的「真机未验」。
 */
export function raccoonSupportsImage() {
  return true
}

// ------------------------------------------------------------------ 失败归类

/**
 * 额度 / 限流的补充判据。**本地只用来加诊断，不用来改动作**。
 *
 * 为什么本仓**不新增一套失败分类器**：参考实现 `raccoon-adapter.ts:226-287` 那三条
 * 硬教训（① 401/403 先判状态码；② `insufficient` 必须与「钱」义词共现；③ 认证类只换号、
 * 绝不写标记）本仓的共享层已经全部吸收：
 * - `./http-error.js` 的 `mapStatus` 里 401 恒 AUTH；403 先过 `failureWords()`，
 *   只有 `credit` / `quota` 才算额度，**其余一律 AUTH**——正是它要的「只换号不写标记」；
 * - `400 + "context …"` 落 `CONTEXT_WINDOW_EXCEEDED`（`health.js` 对它**不换号也不罚号**），
 *   与它把 `400 + context window is insufficient` 归 `other` 逐格同结论。
 *
 * ⚠ **有一处有意的差异**（要写进 README）：`403 + "积分不足"` 在参考实现里归 `quota`
 * （写 24h 冷却），在本仓落 **AUTH**（只换号）。方向是「宁可漏判不可误伤」：
 * 漏判的代价是一个号被 403 后仍留在池里，误判的代价是它被停 24 小时。
 * 参考实现自己那条「全池被封一天」的事故（`raccoon-adapter.ts:233-235`）就是朝误判方向的。
 *
 * @returns {'auth'|'quota'|'rate'|'other'} 仅用于诊断与断言，**不参与动作决策**
 */
export function classifyRaccoonFailure(errorText, status) {
  // 状态码**先判**：403 可能只是权限/授权问题，绝不能落到额度那一格。
  if (status === 401 || status === 403) return 'auth'
  const lower = typeof errorText === 'string' ? errorText.toLowerCase() : ''
  const text = typeof errorText === 'string' ? errorText : ''
  const quotaText =
    lower.includes(CREDIT_CODE) ||
    lower.includes('credits exhausted') ||
    lower.includes('quota exceeded') ||
    (lower.includes('insufficient') && /point|credit|balance|quota|token/.test(lower)) ||
    POINTS_WORDS.test(text)
  if (status === 402 || quotaText) return 'quota'
  if (status === 429 || status === 503 || status === 529) return 'rate'
  return 'other'
}

// ------------------------------------------------------------------ 额度

/**
 * 积分余额 → DSH 的额度窗口（`api.js` 的 `quotaOf` 只认 `id` / `name` /
 * `remainingFraction` / `resetAt` 这四个字段）。
 *
 * ⚠ 单位是**积分**（points），不是 token、不是百分比。而 `quotaOf` 那张契约上的进度条
 * 只吃「比例」，所以这里把 `available_points` 投影成一个**只增不减的累计读数**：
 * 分母是有效期内见过的最大余额。**这样做有一个诚实的代价**：上游不给「总额」字段时，
 * 剩余比例只能相对历史读数表达，用户看到的不是「还剩 30%」而是「相对最多的那次还剩多少」。
 * 因此窗口名写成「积分余额」，把绝对数写进 `name` 里，让面板上至少有一个真数字。
 *
 * 为什么不干脆回 `remainingFraction: 1`：那是在**编一个看起来很好的读数**，
 * 而契约 §C3 对这件事的口径是「没有就别实现——报假额度比不报更糟」。
 *
 * @returns {Array<{id, name, remainingFraction, resetAt?}> | undefined} 读不到就是 undefined
 */
export function parseRaccoonQuota(payload, { seenMax } = {}) {
  const envelope = parseRaccoonEnvelope(payload)
  if (!envelope.ok) return undefined
  const data = envelope.data ?? {}
  const available = finiteNumber(data.available_points)
  // `available_points` 不在就是「没读到」——**绝不编 0**（参考实现 `raccoon-credits.ts:67-69`
  // 的 `readNumber` 与 `:129-163` 的「没有核心字段就返回 null」都是这个口径）。
  if (available === undefined) return undefined
  // ⚠ 分母必须自己兜住「没见过历史读数」这一格：`Math.max(n, undefined)` 是 **NaN**，
  // 而 `NaN` 会让 `remainingFraction` 变成 `NaN`，进度条会画成一条空条——
  // 一个「看起来像 0%」的假读数，比不报更糟。
  const total = Math.max(available, finiteNumber(seenMax) ?? 0, 1)
  const packages = []
  const add = (value, name) => {
    const points = finiteNumber(value)
    if (points === undefined || points <= 0) return
    packages.push({ name, points })
  }
  add(data.reward_points, '奖励积分')
  add(data.daily_points, '每日积分')
  add(data.monthly_points, '会员积分')
  add(data.topup_points, '充值积分')
  const detail = packages.length > 0 ? `（${packages.map((item) => `${item.name} ${item.points}`).join(' / ')}）` : ''
  return [
    {
      id: 'points',
      name: `积分余额 ${available}${detail}`,
      remainingFraction: Math.min(1, Math.max(0, available / total)),
    },
  ]
}

/**
 * `available_points` 的相对上限读数：**只在内存里**记见过的最小值/最大值，
 * 不落盘、不写进账号记录（`src/health.js` 的额度快照本来就只在内存）。
 *
 * 为什么需要它：上游的余额接口只给「现在有多少」，不给「一共有多少」，
 * 没有这个记忆就只能每次都报 100%，那比不报更糟。
 */
export function trackRaccoonBalance(previous, payload) {
  const envelope = parseRaccoonEnvelope(payload)
  const available = envelope.ok ? finiteNumber(envelope.data?.available_points) : undefined
  if (available === undefined) return previous
  return Math.max(previous ?? 0, available)
}

// ------------------------------------------------------------------ 小工具

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function firstPositiveInt(values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * 本机可能放着 Raccoon Work 客户端数据的目录。
 *
 * ⚠ 参考实现 `raccoon-auth.ts` 与 `docs/agent-notes/providers-loomy-raccoon-minimax.md`
 * 都记着同一个结论：**raccoon 的登录态只在客户端进程内存里**，退出即失效，
 * 磁盘上没有可导入的凭据位点。本仓因此**没有**任何读取点——这个函数只用来在
 * `discover()` 里**如实列出查过哪些路径**，让「没找到」与「没查」能被区分开。
 *
 * 纯字符串拼装（不碰文件系统）：`src/wire/*` 是纯翻译层，落盘/读盘的活留给族里。
 */
export function raccoonDataDirs({ env = process.env, platform = process.platform } = {}) {
  const home = env?.HOME || env?.USERPROFILE
  const dirs = []
  if (home) dirs.push(join(home, '.raccoon'))
  // Electron 打包应用的 userData 目录名（`app.getPath('userData')`）默认取产品名。
  if (platform === 'win32') {
    const appData = env?.APPDATA
    if (appData) dirs.push(join(appData, 'office-raccoon'), join(appData, 'Raccoon Work'), join(appData, 'raccoon-work'))
  } else if (platform === 'darwin' && home) {
    dirs.push(join(home, 'Library', 'Application Support', 'office-raccoon'), join(home, 'Library', 'Application Support', 'Raccoon Work'))
  } else if (home) {
    dirs.push(join(home, '.config', 'office-raccoon'), join(home, '.config', 'Raccoon Work'))
  }
  return dirs
}
