/**
 * GitHub Copilot 的协议层：设备码登录状态机、Copilot token 交换、模型目录映射、失败归类。
 *
 * 这里只放**纯函数 + 可注入副作用**（`ctx.fetch`、`sleep`、`now` 都是参数），
 * 好让每一步（设备码轮询的等待、令牌交换、目录映射）都能在不起真网络、
 * 不等真时间的前提下单独验。
 *
 * ## 开始之前必须知道的三件事
 *
 * 1. **`GET https://api.github.com/copilot_internal/v2/token` 是 GitHub 自述的
 *    non-public / unstable 接口。** youngrock 的 README.md:80-83 原文：
 *    「That endpoint is a non-public, unstable interface; GitHub may change or revoke it
 *    at any time.」它随时可能整体失效，而且**失效的样子不是「你没有订阅」**——
 *    所以本文件的错误信息一律带上 HTTP 状态与上游原文（`httpError` 的 `who: HTTP nnn <body>`），
 *    让用户能自己区分「协议变了」和「我的账号没订阅」。这是本族最大的结构性风险，
 *    族对象的 `risk` 也就照实写成 `'high'`。
 * 2. **`editor-version` 是一颗定时炸弹。** 上游对「太旧的编辑器版本」回
 *    `401 IDE token expired`，而这个错误长得跟「令牌被撤」一模一样（考古 C2/§3.1①），
 *    排查时会被引到完全错误的方向（去重新登录，而真正该改的是一个版本号）。
 *    所以版本号**动态取**（`createVersionResolver`，缓存 24h），并且任何 401 都强制作废
 *    缓存重试一次（`requestWithEditorVersion`）。另外注意：这里要的是 **VS Code 本体**的
 *    版本号（`1.107.0` 那一档），不是 copilot-chat 扩展的版本号（`0.56.0` 那一档）——
 *    本机实测扩展是 0.56.0，把扩展版本填进 `editor-version` 就是 100% 401。
 * 3. **推理 base URL 不能硬编码。** `endpoints.api` 是**按账号**下发的：
 *    Business 账号拿到 `proxy.business.githubcopilot.com`，个人账号是
 *    `api.individual.githubcopilot.com`，硬编码任何一种都有另一半账号打不通（考古 C5）。
 *    lujianjun19 的 `docs/adr/0002-narrow-to-credential-provider.md:7` 还留了一条更狠的
 *    实测反证：**连上游 `/models` 目录里声明的端点都可能是错的**（它给 Business 账号声明了
 *    个人端点）。所以缺 `endpoints.api` 时我们**抛错**，绝不回落到任何写死的域名。
 *
 * @module dsh-account-bridge/wire/copilot
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { httpError } from './http-error.js'
import { toChatMessages, toChatSystem, toChatTools } from './chat-completions.js'
import { tryJson } from '../util.js'

// ------------------------------------------------------------------ 常量

/**
 * VS Code Copilot Chat 那个 GitHub App 的 client id。
 * **不能换成自注册的 OAuth App**：只有这个 app 被预先授权做 Copilot 的内网 token 交换
 * （V1ki `src/providers/copilot.ts:65-70` 注释原文「the app is pre-authorized for the
 * Copilot internal token exchange, a self-registered OAuth App is not」）。
 * 自注册 app 的表现是：设备码那一步一切正常，token 交换必然失败。
 */
export const CLIENT_ID = 'Iv1.b507a08c87ecfe98'

/**
 * 只要 `read:user`。
 * **不要照抄 VS Code Copilot Chat 自己的 scope**（本机实测它申请的是
 * `read:user user:email repo workflow`）：多要 `repo` 会让用户在授权页看到
 * 「访问你的全部私有仓库」，而换 Copilot token 根本用不上它（考古 §2.2/C12）。
 */
export const SCOPE = 'read:user'

export const DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token'
/** `verification_uri` 缺失时的回落（RFC 8628 允许上游不给，GitHub 有时候确实不给）。 */
export const DEVICE_VERIFY_URL = 'https://github.com/login/device'
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
/** 上游没给 `interval` 时按 5 秒轮询（RFC 8628 建议的最小值，V1ki 同款）。 */
export const DEVICE_DEFAULT_INTERVAL_MS = 5_000
/** 上游没给 `expires_in` 时按 15 分钟算（GitHub 的设备码就是这个量级）。 */
export const DEVICE_DEFAULT_EXPIRES_MS = 900_000
/** `slow_down` 每次抬高多少（RFC 8628 §3.5 要求 +5 秒，且是**永久**抬高）。 */
export const DEVICE_SLOW_DOWN_STEP_MS = 5_000

/** ⚠️ 非公开接口，见文件头第 1 条。 */
export const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
/** 尽力而为地读 GitHub 用户名当显示名；失败不影响登录。 */
export const GITHUB_USER_URL = 'https://api.github.com/user'

/**
 * `api.github.com` 的 User-Agent。
 *
 * **必须以 `GitHubCopilot` 开头**：GitHub 的反爬对不认识的 UA 回 403，
 * 而那个 403 长得像「你的账号没有 Copilot 订阅」（考古 C1/§3.1②）。
 * 任何「顺手加一个 attribution 头」的改动都必须**放在它前面被覆盖**，否则整族挂。
 */
export const GITHUB_USER_AGENT = 'GitHubCopilotChat/0.35.0'
/** 编辑器插件身份（和上面那条 UA 是一组，缺了行为未实测，见考古 C15）。 */
export const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.35.0'
export const COPILOT_INTEGRATION_ID = 'vscode-chat'
/**
 * `openai-intent` / `x-github-api-version`：**只有 V1ki 一家发**（考古 §2.4.2，
 * `copilot.ts:159-160`）[单源]，所以别当成硬要求。发它的理由是「冒充 VS Code 扩展」
 * 这件事本来就靠整组头共同成立，缺一个不会更好。
 *
 * ⚠️ `x-github-api-version` 是个**日期**，抓包当天是 `2026-06-01`。它不像 `editor-version`
 * 那样会硬性拒绝旧值（没找到这种证据），但哪天上游抬高了最低版本，这里也得跟着改：
 * 如果看到 400 且文案里带着 api version 字样，先怀疑这一行。
 */
export const OPENAI_INTENT = 'conversation-edits'
export const GITHUB_API_VERSION = '2026-06-01'

/** VS Code 稳定版发布列表（返回一个版本字符串数组，最新在前）。 */
export const VSCODE_RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable'
/** 取不到版本时的最后一道；见 `createVersionResolver` 的回落链。 */
export const FALLBACK_VSCODE_VERSION = '1.107.0'
export const VSCODE_VERSION_TTL_MS = 24 * 3_600_000
/** 版本号形态（**只要 VS Code 本体的三段式**，`1.108.0-insider` 这种不算）。 */
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/

/** Copilot token 的寿命：上游给 `expires_at` 时用它，不给时按 25 分钟算（实测 25~30 分钟）。 */
export const COPILOT_TOKEN_FALLBACK_TTL_MS = 25 * 60_000
/** 提前多久刷新（别等真的过期，那时的请求会先 401 再换号，白烧一次失败）。 */
export const COPILOT_REFRESH_SKEW_MS = 5 * 60_000

/** 上游不告诉我们上下文窗口时的保守值（低估只是提前压缩，高估白烧额度）。 */
export const COPILOT_CONTEXT_WINDOW = 128_000
export const COPILOT_DEFAULT_MAX_TOKENS = 16_000

/** 我们**只**接了 chat 线；`/responses` 没接，见 `servesChatWire` 与 `planReasoningEffort`。 */
export const CHAT_WIRE = '/chat/completions'

// ------------------------------------------------------------------ 小工具

/** 非空字符串。 */
function isText(value) {
  return typeof value === 'string' && value.length > 0
}

/** 正整数（**不是正整数就当没有**：宿主会拿它校验模型元数据，见族文件里那条注释）。 */
export function positiveInteger(value) {
  const number = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 1) return undefined
  return Math.floor(number)
}

/** 秒 → 毫秒；非正数/读不懂返回 undefined（**不编 0**）。 */
function positiveSecondsToMs(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.round(number * 1000)
}

/** 协议层的错误（上游说了我们读不懂的话，或者说了我们没法照做的话）。 */
function protocolError(message, code = 'SERVER') {
  const error = new Error(message)
  error.code = code
  return error
}

// ------------------------------------------------------------------ 设备码登录

/** 发起设备码请求（RFC 8628 §3.1）。表单编码，不是 JSON。 */
export function deviceCodeRequest() {
  return {
    url: DEVICE_CODE_URL,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
    },
  }
}

/**
 * 设备码响应 → 我们内部的结构。
 *
 * `device_code` / `user_code` 必须是**非空字符串**，否则宁可直接报错：
 * 拿一个 undefined 去轮询会得到一串毫无信息量的 400。
 * `verification_uri` 上游有时候不给（RFC 里它是可选的），回落常量。
 */
export function readDeviceCode(json) {
  if (!isText(json?.device_code) || !isText(json?.user_code)) {
    throw protocolError('copilot: 设备码响应里没有 device_code/user_code，没法继续轮询')
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: isText(json.verification_uri)
      ? json.verification_uri
      : isText(json.verification_url)
        ? json.verification_url
        : DEVICE_VERIFY_URL,
    // 上游只在 >0 时才可信；0 或者缺失都按默认值走（V1ki device-flow.ts:13,16 同款）。
    intervalMs: positiveSecondsToMs(json.interval) ?? DEVICE_DEFAULT_INTERVAL_MS,
    expiresInMs: positiveSecondsToMs(json.expires_in) ?? DEVICE_DEFAULT_EXPIRES_MS,
  }
}

/**
 * 发起设备码登录的第一步：跟 GitHub 要一对 `device_code` / `user_code`。
 *
 * **`user_code` 只能通过 `session.notify` 交给用户**（契约：`session.prompt` 没有 `initial`，
 * 也不是给这种「照着念」的信息用的）。返回的 `expiresInMs` 是设备码自己的寿命。
 */
export async function requestDeviceCode({ ctx, proxy, signal }) {
  const request = deviceCodeRequest()
  const response = await ctx.fetch(request.url, { ...request.init, signal }, proxy, false)
  const text = await response.text().catch(() => '')
  if (!response.ok) throw httpError(response, text, 'copilot device flow')
  const json = tryJson(text)
  if (json === undefined) throw protocolError('copilot: 设备码响应不是 JSON')
  return readDeviceCode(json)
}

/** 轮询 token 端点（RFC 8628 §3.4）。 */
export function deviceTokenRequest(deviceCode) {  return {
    url: DEVICE_TOKEN_URL,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }).toString(),
    },
  }
}

/** 四种设备流错误的文案（照抄 V1ki `src/auth/device-flow.ts`，方便以后一起 grep）。 */
export const DEVICE_DENIED_MESSAGE = 'login declined on the GitHub authorization page'
export const DEVICE_EXPIRED_MESSAGE = 'the device code expired before authorization completed'

/**
 * token 端点的一次响应 → 下一步该干什么。**纯函数**。
 *
 * 注意 GitHub 的做法：**设备流的错误是用 HTTP 200 + `{"error": "..."}` 表达的**，
 * 所以这里不能只看状态码。（真正的网络/网关错误走 `httpError` 那条路，见 `pollDeviceToken`。）
 */
export function classifyDeviceTokenResponse(json = {}) {
  const code = typeof json.error === 'string' ? json.error : undefined
  switch (code) {
    case 'authorization_pending':
      return { status: 'pending', slowDown: false }
    case 'slow_down':
      // RFC 8628 §3.5：慢一点，而且是**之后一直**慢一点，不是只等这一轮。
      return { status: 'pending', slowDown: true }
    case 'access_denied':
      return { status: 'denied', message: DEVICE_DENIED_MESSAGE }
    case 'expired_token':
      return { status: 'expired', message: DEVICE_EXPIRED_MESSAGE }
    case undefined:
      if (isText(json.access_token)) return { status: 'authorized', accessToken: json.access_token }
      return { status: 'failed', message: 'the token endpoint returned neither a token nor an error' }
    default:
      return {
        status: 'failed',
        message: `${code}${isText(json.error_description) ? `: ${json.error_description}` : ''}`,
      }
  }
}

/**
 * 轮询的**节奏**状态机：什么时候问下一次、什么时候算超时、`slow_down` 之后间隔变多少。
 * 与「这次响应说了什么」分开，是为了让测试能在毫秒内跑完 900 秒的超时逻辑。
 */
export function createDeviceFlowState(device, startedAt = Date.now()) {
  const expiresInMs = positiveInteger(device?.expiresInMs) ?? DEVICE_DEFAULT_EXPIRES_MS
  let intervalMs = positiveInteger(device?.intervalMs) ?? DEVICE_DEFAULT_INTERVAL_MS
  const deadline = startedAt + expiresInMs
  return {
    get intervalMs() {
      return intervalMs
    },
    get deadline() {
      return deadline
    },
    /** 下一次轮询前先等多久（RFC 8628：先等一个 interval，再问第一次）。 */
    delayMs() {
      return intervalMs
    },
    expired(now = Date.now()) {
      return now >= deadline
    },
    /** 把一次响应喂进来：`slow_down` 会永久抬高一档间隔，超时优先于一切。 */
    accept(json, now = Date.now()) {
      const verdict = classifyDeviceTokenResponse(json)
      if (verdict.status === 'pending') {
        if (verdict.slowDown) intervalMs += DEVICE_SLOW_DOWN_STEP_MS
        if (now >= deadline) return { status: 'expired', message: DEVICE_EXPIRED_MESSAGE }
      }
      return verdict
    },
  }
}

/**
 * 轮询到出结果为止。
 *
 * 两条纪律（都是被别人踩过的坑，别改回去）：
 * - **只有 `authorization_pending` 才继续轮询。** 网络错误、5xx、看不懂的响应一律**当场抛错**：
 *   lujianjun19 的 `src/host/11-device-flow.js:66-69` 把非 2xx 和网络异常也当 retry，
 *   结果一个永久性错误会变成无限重试（考古 C17）。
 * - `sleep` 是**可注入**的，测试传一个立即返回的假 sleep 就能把整条状态机跑完。
 */
export async function pollDeviceToken({ ctx, proxy, device, signal, sleep, now = Date.now }) {
  if (typeof sleep !== 'function') throw new TypeError('copilot: pollDeviceToken needs a sleep function')
  const state = createDeviceFlowState(device, now())
  for (;;) {
    await sleep(state.delayMs(), signal)
    if (state.expired(now())) {
      // 是「用户一直没去授权页」还是「授权了但一直没被受理」，我们分不出来——
      // 只报设备码的有效期，不编一个更细的原因。
      const seconds = Math.round((positiveInteger(device?.expiresInMs) ?? DEVICE_DEFAULT_EXPIRES_MS) / 1000)
      throw protocolError(`copilot: 设备码登录超时（设备码有效期 ${seconds} 秒内没有完成授权）`, 'TIMEOUT')
    }
    const request = deviceTokenRequest(device.deviceCode)
    const response = await ctx.fetch(request.url, { ...request.init, signal }, proxy, false)
    const text = await response.text().catch(() => '')
    const json = tryJson(text)
    if (json === undefined) throw httpError(response, text, 'copilot device flow')
    const verdict = state.accept(json, now())
    switch (verdict.status) {
      case 'authorized':
        return { accessToken: verdict.accessToken }
      case 'pending':
        break
      case 'denied':
        throw protocolError(verdict.message, 'AUTH')
      case 'expired':
        throw protocolError(verdict.message, 'AUTH')
      default:
        throw protocolError(`copilot: 设备码轮询失败：${verdict.message}`, 'SERVER')
    }
  }
}

// ------------------------------------------------------------------ editor-version

/**
 * 从发布列表里取第一个稳定版本号。纯函数，方便钉住「Insider 不算」这条。
 */
export function extractStableVersion(json) {
  if (!Array.isArray(json)) return undefined
  return json.find((entry) => typeof entry === 'string' && STABLE_VERSION_RE.test(entry))
}

/**
 * `editor-version` 的解析器（缓存 24 小时 + 并发合并 + 永久可用的回落链）。
 *
 * 为什么不是「一个常量」：上游会拒绝太旧的版本（`401 IDE token expired`），
 * 而一个写死的常量**迟早**会旧到让整族 100% 不可用（考古 §3.1①）。
 * 为什么不是「每次请求都查」：对话路径上不该多一次网络往返，而且发布列表一天才动一次。
 *
 * 回落链（**任何一环失败都不许把请求路径弄挂**）：活缓存 → 上次成功的缓存 → `FALLBACK_VSCODE_VERSION`。
 * `force` 用于「上游刚回了 401」的场景：作废新鲜度判断，真的去重取一次。
 */
export function createVersionResolver({ ttlMs = VSCODE_VERSION_TTL_MS, fallback = FALLBACK_VSCODE_VERSION, now = Date.now } = {}) {
  let cached
  let inflight
  return {
    /** 同步看一眼当前会用哪个版本（日志/测试用，不发请求）。 */
    peek() {
      return cached?.version ?? fallback
    },
    /**
     * 解析一个可用的版本号。**永不抛**：查不到就用缓存，再不行用常量。
     * 并发调用合并到同一个 in-flight 请求上（不然一次冷启动会打出好几个 feed 请求）。
     */
    async resolve(ctx, proxy, { force = false, signal } = {}) {
      if (!force && cached && now() - cached.at < ttlMs) return cached.version
      inflight ??= (async () => {
        const response = await ctx.fetch(VSCODE_RELEASES_URL, { headers: { accept: 'application/json' }, signal }, proxy, false)
        if (!response.ok) throw httpError(response, await response.text().catch(() => ''), 'copilot editor-version feed')
        const json = await response.json().catch(() => undefined)
        const version = extractStableVersion(json)
        if (!version) throw protocolError('copilot: VS Code 发布列表里没有稳定的三段式版本号')
        return version
      })()
        .then((version) => {
          cached = { version, at: now() }
          return version
        })
        .catch((error) => {
          // 查不到不能弄挂请求：先退上次的缓存，再退常量。
          ctx?.log?.warn?.('account-bridge: copilot editor-version lookup failed (%s), using %s', String(error?.message ?? error), cached?.version ?? fallback)
          return cached?.version ?? fallback
        })
        .finally(() => {
          inflight = undefined
        })
      return inflight
    },
  }
}

/**
 * `401 IDE token expired` 是「编辑器版本过期」唯一可辨认的指纹。
 * 见到它就说明我们的版本号已经不被接受了——这是给维护者定位用的信号，
 * 不是给用户看的（用户看到的还是 401）。
 */
export function looksLikeStaleEditorVersion(status, text) {
  if (status !== 401) return false
  return /ide token expired|editor[-_ ]?version/i.test(String(text ?? ''))
}

/**
 * 上游错误 → 契约的失败码。
 *
 * 归类**只用共享的 `httpError`**（族里不许再抄一份 mapStatus 的顺序，那条顺序是钉死的），
 * 这里额外做的只有一件事：把「IDE token expired」这个指纹标出来，并在文案里说清
 * 「这几乎总是版本号太旧，不是你的令牌坏了」——否则用户会去重新登录，而问题不在那里。
 */
export function copilotError(response, text, who = 'copilot') {
  const error = httpError(response, text, who)
  if (looksLikeStaleEditorVersion(response?.status, text)) {
    error.staleEditorVersion = true
    error.message = `${error.message}（上游给的是 IDE token expired：这几乎总是 copilot 的 editor-version 太旧，而不是你的令牌被撤；见 src/wire/copilot.js 头注释第 2 条）`
  }
  return error
}

// ------------------------------------------------------------------ 请求

/**
 * 带编辑器身份的头。**不带 `editor-version`**——那一项由 `requestWithEditorVersion`
 * 按「本次用的是哪个版本号」填进去，好让 401 重试时换的就是它。
 *
 * 键名全小写（V1ki/youngrock 的抓包一致）。
 */
export function copilotHeaders({ token, json = false, stream = false, hasImages = false } = {}) {
  const headers = {
    accept: stream ? 'text/event-stream' : 'application/json',
    // 顺序无所谓（对象字面量），但**任何** UA 覆盖都必须发生在这个键之前，
    // 否则 GitHub 的反爬 403 会被误读成「你没有订阅」。
    'user-agent': GITHUB_USER_AGENT,
    'editor-plugin-version': EDITOR_PLUGIN_VERSION,
    'copilot-integration-id': COPILOT_INTEGRATION_ID,
    'openai-intent': OPENAI_INTENT,
    'x-github-api-version': GITHUB_API_VERSION,
  }
  if (json) headers['content-type'] = 'application/json'
  if (isText(token)) headers.authorization = `Bearer ${token}`
  // 只有 V1ki 一家发这个头（单源，不是硬要求）：带图请求时告诉网关「这是视觉请求」。
  if (hasImages) headers['copilot-vision-request'] = 'true'
  return headers
}

/**
 * 发一次带编辑器身份的请求，并在 401 时**强制作废版本缓存重试一次**。
 *
 * 401 有两个来源：令牌真的被撤 / 编辑器版本太旧。响应体**不可靠区分**（都是 401，
 * 只有一部分带 `IDE token expired`）。代价是不对称的：多查一次发布列表很便宜，
 * 而「版本太旧」会让整族 100% 不可用。所以统一重试一次，且只重试一次。
 * 重取之后拿到的还是同一个版本号时**不重试**——那说明问题不在版本上。
 */
export async function requestWithEditorVersion({ ctx, proxy, signal, streaming = false, request, resolver }) {
  const send = (version) =>
    ctx.fetch(
      request.url,
      { ...request.init, headers: { ...request.init.headers, 'editor-version': `vscode/${version}` } },
      proxy,
      streaming,
    )
  const version = await resolver.resolve(ctx, proxy, { signal })
  const response = await send(version)
  if (response?.status !== 401) return response
  const refreshed = await resolver.resolve(ctx, proxy, { force: true })
  if (refreshed === version) return response
  ctx?.log?.warn?.('account-bridge: copilot 上游回了 401，用 vscode/%s 重试一次', refreshed)
  return send(refreshed)
}

// ------------------------------------------------------------------ token 交换

/**
 * Copilot token 响应 → 我们要长期存下来的 `auth` 对象。
 *
 * 两个坑：
 * - **`expires_at` 是 epoch 秒，不是毫秒**（三个独立实现一致，考古 §2.3/C9）。
 *   当毫秒用会得到「1970 年就过期了」，于是每个请求都去换一次 token。
 * - **`token` 不是 JWT**，是 `tid=...;exp=...;proxy-ep=proxy.business.githubcopilot.com`
 *   这样的分号串，**不要**去解析它（考古 C13）。
 */
export function authFromTokenResponse(json, now = Date.now()) {
  if (!isText(json?.token)) throw protocolError('copilot: 换 token 的响应里没有 token')
  const expiresAt =
    typeof json.expires_at === 'number' && Number.isFinite(json.expires_at) && json.expires_at > 0
      ? json.expires_at * 1000
      : now + COPILOT_TOKEN_FALLBACK_TTL_MS
  const api = json?.endpoints?.api
  if (!isText(api)) {
    // 缺失就抛错，**不要**回落任何一个写死的域名：端点按账号下发，
    // 个人/Business 账号拿到的 host 不同，连上游目录都可能声明错的那一个（ADR-0002:7）。
    throw protocolError('copilot: the token response has no endpoints.api; refusing to hardcode a base URL')
  }
  const auth = { access: json.token, expiresAt, endpoints: { api: trimTrailingSlash(api) } }
  // `endpoints.proxy` 故意**不**存成 `proxy`：本插件里 `auth`/`payload` 上的 `proxy`
  // 一律指「用户的 HTTP 代理」，两个不同的东西同名会出人命。origin-tracker 留着
  // 只为了排查时能看出这是哪一类账号。
  const originTracker = json?.endpoints?.['origin-tracker']
  if (isText(originTracker)) auth.endpoints.originTracker = trimTrailingSlash(originTracker)
  if (isText(json?.sku)) auth.sku = json.sku
  if (typeof json?.chat_enabled === 'boolean') auth.chatEnabled = json.chat_enabled
  return auth
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

/**
 * 拿 GitHub token 换 Copilot token。
 *
 * **这个调用会被反复执行**：`ghu_*` 是长期 token、**不轮换**（考古 §2.3），
 * 所以「刷新凭据」= 拿同一个 GitHub token 重做一次这个交换，
 * `expires_at` 是 Copilot token 自己的寿命。
 */
export async function exchangeCopilotToken({ ctx, githubToken, proxy, signal, resolver }) {
  if (!isText(githubToken)) throw protocolError('copilot: 这条账号记录里没有 GitHub token，请重新登录', 'AUTH')
  const response = await requestWithEditorVersion({
    ctx,
    proxy,
    signal,
    request: {
      url: COPILOT_TOKEN_URL,
      init: { method: 'GET', headers: copilotHeaders({ token: githubToken }), signal },
    },
    resolver,
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) throw copilotError(response, text, 'copilot token exchange')
  const json = tryJson(text)
  if (json === undefined) throw protocolError('copilot: 换 token 的响应不是 JSON')
  return authFromTokenResponse(json)
}

/**
 * 尽力读一次 GitHub 用户名（只为了给账号起个显示名）。
 * **失败静默**：api.github.com 抽风不该让一次成功的登录白跑。
 */
export async function fetchGitHubLogin({ ctx, githubToken, proxy, signal }) {
  try {
    const response = await ctx.fetch(
      GITHUB_USER_URL,
      {
        headers: {
          accept: 'application/json',
          'user-agent': GITHUB_USER_AGENT,
          ...(isText(githubToken) ? { authorization: `Bearer ${githubToken}` } : {}),
        },
        signal,
      },
      proxy,
      false,
    )
    if (!response.ok) return undefined
    const json = await response.json().catch(() => undefined)
    const login = json?.login ?? json?.name
    return isText(login) ? login : undefined
  } catch {
    return undefined
  }
}

/** 账号记录里存的推理端点。**没有就抛**，绝不回落写死的域名。 */
export function apiBaseUrl(auth) {
  const api = auth?.endpoints?.api
  if (!isText(api)) {
    throw protocolError('copilot: this account has no endpoints.api on record; sign in again', 'AUTH')
  }
  return trimTrailingSlash(api)
}

/** 到点该换 Copilot token 了吗（`expiresAt` 缺失时不猜，直接说不用）。 */
export function needsRefresh(payload, now = Date.now()) {
  const expiresAt = payload?.auth?.expiresAt
  if (typeof expiresAt !== 'number') return false
  return expiresAt - COPILOT_REFRESH_SKEW_MS <= now
}

// ------------------------------------------------------------------ 模型目录

/**
 * 这个模型能不能走 chat 线。
 *
 * V1ki `copilot.ts:357-362` 的三分支，逐字对应：
 * - `supported_endpoints` **不是数组（字段缺失）** → 保留：旧版目录没有这个字段，
 *   那时的模型都是走 `/chat/completions` 的（`copilot.ts:808` 那条注释记录过一次
 *   「静默默认成 /chat/completions，结果请求 404/400」的事故，说的就是这个默认值）。
 * - 是数组且含 `/chat/completions` → 能走。
 * - 是数组、不含 chat（只列 `/responses`，或者一个都不列）→ **不列**。
 *   我们这个族没接 responses 线，把一个只能走 responses 的模型放进选择器，
 *   用户点下去必然 400，不如老实不列（族文件里写了为什么只接了一条线）。
 *
 * （考古 §2.4.4 的伪码把这一段写成「含 chat → chat，否则含 responses → responses，
 * 都不含 → 跳过」，**漏了「字段缺失」这一支**；以源码为准。）
 */
export function servesChatWire(entry) {
  const endpoints = Array.isArray(entry?.supported_endpoints)
    ? entry.supported_endpoints.filter((item) => typeof item === 'string')
    : []
  return endpoints.length === 0 || endpoints.includes(CHAT_WIRE)
}

/**
 * `/models` 的响应 → 条目数组。
 *
 * **「200 但空目录」必须当失败**（V1ki `copilot.ts:376-378`）：空目录说明接口形态变了，
 * 而不是「你的账号没有模型」。当成失败才能让上层回落到静态兜底，而不是把整族弄消失（考古 ⑰）。
 */
export function modelCatalog(json) {
  const data = json?.data
  if (!Array.isArray(data)) throw protocolError('copilot: the /models response had no data array')
  if (data.length === 0) throw protocolError('copilot: the /models response was an empty catalog')
  return data
}

const EFFORT_LABELS = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

/**
 * `capabilities.supports.reasoning_effort`（字符串数组）→ DSH 的档位列表。
 * 非字符串项与重复项**丢弃**：宿主对重复的 effort id 是直接拒绝的。
 * **不声明 `defaultEffort`**：上游没有告诉我们它默认用哪一档，那就别编（V1ki 同款注释）。
 */
export function normaliseEfforts(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!isText(item) || seen.has(item)) continue
    seen.add(item)
    out.push({ id: item, name: EFFORT_LABELS[item] ?? item })
  }
  return out
}

/**
 * 一项模型元数据。
 *
 * `contextWindow` **必须是正整数**：宿主的 `dsh-llm` 会校验它，不是正整数就抛
 * `adapter returned invalid context metadata`，而那是**provider 级失败**——
 * 整个族会从模型选择器里消失。所以这里宁可回落到保守常量，也不把上游给的
 * `0` / `null` / 字符串原样透出去。
 *
 * `defaultMaxTokens` 同理，并且额外夹在 `contextWindow` 以内。
 */
export function modelInfo(id, name, limits = {}, provider) {
  const contextWindow = positiveInteger(limits.contextWindow) ?? COPILOT_CONTEXT_WINDOW
  const maxTokens = Math.min(positiveInteger(limits.maxTokens) ?? COPILOT_DEFAULT_MAX_TOKENS, contextWindow)
  const efforts = normaliseEfforts(limits.efforts)
  return {
    provider,
    id,
    name: isText(name) ? name : id,
    context: { contextWindow },
    defaultMaxTokens: maxTokens,
    toolUpdate: 'in-history',
    inputModalities: limits.images === true ? ['text', 'image'] : ['text'],
    ...(efforts.length > 0 ? { reasoning: { efforts } } : {}),
  }
}

/** 上游条目 → `modelInfo` 的参数（**取不到就留 undefined，由 modelInfo 兜底**）。 */
export function limitsFromCatalogEntry(entry) {
  const limits = entry?.capabilities?.limits ?? {}
  return {
    // 先信上下文窗口，其次信「最多能发多少 prompt」——后者是上游自己给的数，
    // 比编一个更保守也更诚实。
    contextWindow: positiveInteger(limits.max_context_window_tokens) ?? positiveInteger(limits.max_prompt_tokens),
    maxTokens: positiveInteger(limits.max_output_tokens) ?? positiveInteger(limits.max_non_streaming_output_tokens),
    images: entry?.capabilities?.supports?.vision === true,
    efforts: entry?.capabilities?.supports?.reasoning_effort,
  }
}

/**
 * 上游条目 → DSH 模型信息。**返回 `undefined` 表示这个条目我们不该列**：
 * 不可选（`model_picker_enabled !== true`）、被账号策略禁掉（`policy.state === 'disabled'`）、
 * 没有 id，或者只能走我们没接的 wire。
 */
export function modelInfoFromCatalog(entry, provider) {
  if (!isText(entry?.id)) return undefined
  if (entry.model_picker_enabled !== true) return undefined
  if (entry.policy?.state === 'disabled') return undefined
  if (!servesChatWire(entry)) return undefined
  return modelInfo(entry.id, entry.name, limitsFromCatalogEntry(entry), provider)
}

/**
 * `/models` 的响应 → DSH 模型列表。
 *
 * 按 id 去重（V1ki `copilot.ts:350,353` 也去重：上游目录里出现过重复 id）。
 * **过滤完一个都不剩也算失败**：那时候上层应当回落到静态兜底，
 * 而不是让整个族从模型选择器里消失。
 */
export function modelsFromCatalog(json, provider) {
  const seen = new Set()
  const out = []
  for (const entry of modelCatalog(json)) {
    const model = modelInfoFromCatalog(entry, provider)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  if (out.length === 0) throw protocolError('copilot: the /models response had no usable chat model')
  return out
}

// ------------------------------------------------------------------ 请求体

/**
 * Copilot `/chat/completions` 的请求体。**纯函数**，好把字段名钉在测试里。
 *
 * 两件必须照做、写错就静默/400 的事：
 * - **输出上限用 `max_completion_tokens`，不是 `max_tokens`。** V1ki 的注释原文
 *   （`copilot.ts:403-408`）：「the newer OpenAI-family models on Copilot reject the legacy
 *   `max_tokens` parameter outright (HTTP 400 "Unsupported parameter")」，而目录里其余的模型
 *   两种拼写都收。youngrock 用的是 `max_tokens`，它没炸只是因为跑的是旧模型（考古 ⑲）。
 * - **`reasoning_effort` 是顶层扁平字符串**，不是 responses 线那种 `reasoning: { effort }`
 *   （写错不会报错，会被静默忽略，effort 就不生效了；考古 C18）。
 *
 * `stream_options.include_usage` **不是可选项**：上游只会流式返回，用量在最后一块上
 * （`copilot.ts:432`：「The upstream is stream-only; usage arrives on the terminal chunk.」），
 * 不发这个字段就没有 token 计数可显示。
 *
 * 消息/工具的翻译**复用 `wire/chat-completions.js`**，这个族不抄第二份翻译层
 * （system 消息、tool 结果、图片升级成数组那些规矩都在那边）。
 */
export function copilotChatBody({ model, system, messages = [], tools = [], effort, maxTokens } = {}) {
  const chatMessages = toChatMessages(messages)
  const systemText = toChatSystem(system, messages)
  const hasTools = Array.isArray(tools) && tools.length > 0
  const plan = planReasoningEffort({ hasTools, effort })
  const limit = positiveInteger(maxTokens)
  return {
    body: {
      model,
      messages: systemText.length > 0 ? [{ role: 'system', content: systemText }, ...chatMessages] : chatMessages,
      ...(hasTools ? { tools: toChatTools(tools), tool_choice: 'auto' } : {}),
      ...(limit !== undefined ? { max_completion_tokens: limit } : {}),
      ...(plan.effort !== undefined ? { reasoning_effort: plan.effort } : {}),
      stream: true,
      stream_options: { include_usage: true },
    },
    hasTools,
    droppedEffort: plan.dropped,
  }
}

// ------------------------------------------------------------------ 请求体规划

/**
 * 「有 function tools 的时候不能带 reasoning effort」这条上游限制怎么办。
 *
 * V1ki 的实测（`copilot.ts:379-397` 注释）：这个组合在 `/chat/completions` 上会得到
 * HTTP 400 `invalid_request_body`（"Function tools with reasoning_effort are not supported …
 * use /v1/responses or set reasoning_effort to 'none'"，在 gpt-5.4 上观测到），
 * 上游的官方建议是改道 `/responses`。
 *
 * **我们没接 responses 线**（本族只复用 `wire/chat-completions.js`），所以退而求其次：
 * 在有工具调用时把 effort 退掉，让请求能跑，并把「退掉了」这件事交回调用方记日志——
 * 这是**有意的降级**，不是静默丢弃。根治办法是接上 responses 线，见族文件里那条 TODO。
 * `'none'` 是上游自己推荐的取值，它本来就允许和工具一起发，所以原样保留。
 */
export function planReasoningEffort({ hasTools = false, effort } = {}) {
  if (!isText(effort)) return { effort: undefined, dropped: undefined }
  if (effort === 'none') return { effort: 'none', dropped: undefined }
  if (hasTools) return { effort: undefined, dropped: effort }
  return { effort, dropped: undefined }
}

// ------------------------------------------------------------------ 本机凭据位点

/**
 * 我们真的去找过的本机凭据位点（**一个都不是可导入的**）。
 *
 * 列出来是为了让 `discover()` 的 `reason` 有据可依、可核对，而不是让它写一句
 * 「没找到」了事。位点取自考古 §2.1 的本机实测清单 + 各实现的导入优先级链。
 */
export function credentialSites({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const dotConfig = join(home, '.config')
  if (platform === 'win32') {
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      {
        path: join(roaming, 'Microsoft', 'Credentials'),
        note: 'Windows 凭据保险箱：VS Code 的 Copilot token 在这里，但内容是 DPAPI 加密的 blob（本机实测三个，546/594/626 字节），只有同一个 Windows 用户能解开，我们读不出明文',
      },
      {
        path: join(roaming, 'Code', 'User', 'globalStorage', 'github.copilot-chat'),
        note: 'VS Code Copilot Chat 的扩展存储：只有 embeddings 之类的缓存，**没有 token**',
      },
      { path: join(local, 'github-copilot'), note: 'Copilot 桌面端的符号索引（SQLite），没有凭据' },
      { path: join(roaming, 'GitHub Copilot'), note: 'VS Code 不往这里写东西' },
      { path: join(dotConfig, 'github-copilot'), note: 'copilot.vim / gh-copilot 那一代的位点' },
      { path: join(dotConfig, 'gh', 'hosts.yml'), note: 'gh CLI 的登录态（token 拿去换 Copilot token 大概率被拒，考古 C8）' },
      { path: join(home, '.copilot', 'config.json'), note: 'Copilot CLI 的配置：只有 firstLaunchAt 之类的启动信息' },
    ]
  }
  const keychain = platform === 'darwin' ? 'macOS 钥匙串（Keychain）' : 'libsecret / gnome-keyring'
  return [
    {
      path: join(dotConfig, 'github-copilot'),
      note: `copilot.vim / gh-copilot 那一代的位点（如果这台机器装过，里面可能有一份 hosts.json）`,
    },
    {
      path: join(dotConfig, 'Code', 'User', 'globalStorage', 'github.copilot-chat'),
      note: `VS Code Copilot Chat 的扩展存储：只有缓存，**没有 token**；真正的 token 在 ${keychain} 里，那是 VS Code 用 Electron safeStorage 加密后交给系统保管的`,
    },
    { path: join(dotConfig, 'gh', 'hosts.yml'), note: 'gh CLI 的登录态（token 拿去换 Copilot token 大概率被拒，考古 C8）' },
    { path: join(home, '.copilot', 'config.json'), note: 'Copilot CLI 的配置：只有启动信息' },
  ]
}

/**
 * 「为什么本机这份登录态不能导入」的完整说法。
 *
 * 这一族**没有**导入路径：VS Code 从不把 Copilot token 写成可读文件（Windows 是 DPAPI
 * 加密的凭据 blob，macOS/Linux 是系统钥匙串），所以只能重新跑一次设备码登录。
 * 契约要求「有凭据但格式不对」也要 `importable: false` + 诚实的 reason——
 * 这里就是那句话，而且把「我们检查了哪里」写进去，好让用户能自己复核。
 */
export function importBlockerReason(sites, { existing = [], platform = process.platform } = {}) {
  const known = new Set(existing)
  const present = sites.filter((site) => known.has(site.path))
  const absent = sites.filter((site) => !known.has(site.path))
  const lines = []
  lines.push(
    platform === 'win32'
      ? 'Windows 上 VS Code 把 Copilot 的令牌交给 DPAPI 加密保管（%APPDATA%\\Microsoft\\Credentials 下的凭据 blob），只有同一个 Windows 用户能解开，本插件读不出明文；'
      : 'VS Code 把 Copilot 的令牌交给系统钥匙串保管（macOS Keychain / Linux libsecret），本插件读不出明文；',
  )
  lines.push('而且 VS Code 从不把它写成可读的 JSON 文件。')
  if (present.length > 0) {
    lines.push(`我们检查过、确实存在的位点：${present.map((site) => `${site.path}（${site.note}）`).join('；')}。`)
  }
  if (absent.length > 0) {
    lines.push(`不存在：${absent.map((site) => site.path).join('、')}。`)
  }
  // 这条是给「以后有人想加导入」的人看的：不是我们偷懒，是三份独立实现都没有这条路。
  lines.push('参考实现 V1ki 那 1051 行代码里同样没有读 VS Code 登录态的路径（对 `github-copilot`/`hosts.json` 零命中），只有设备码登录。')
  lines.push('结论：这一族只能走设备码登录（「+ 添加账号」→「用设备码登录 GitHub Copilot」）。')
  return lines.join('')
}
