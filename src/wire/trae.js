/**
 * `trae` 族的 wire 层：纯函数与纯解析，不碰网络、不碰文件、不认识池子。
 *
 * 这一层之所以必须单独存在（而不能复用 `chat-completions.js`），是因为 Trae 的
 * `llm_utils_chat` **不是** OpenAI 兼容端点，它有四件别处没有的东西：
 *   1. 私有请求信封（`model` 必须与 `config_name` 同值、`content` 必须数组化、
 *      `tool_calls[i].function` 必须改名 `function_call`、`tools[i].function.parameters`
 *      必须 JSON.stringify、`role:'developer'` 必须降成 `'system'`）；
 *   2. 私有 SSE 事件模型（`output` / `token_usage` / `done` / `error` /
 *      `progress_notice` / `request_wait_in_queue`）；
 *   3. **HTTP 200 里藏业务错误**（成败在 body 的 `code` 或 SSE 的 `event:error` 里，
 *      只看 HTTP 状态码会把失败当成功）；
 *   4. `function` × `config_name` 的可调用性矩阵（见 `chatFunctionFor`）。
 *
 * 这里只写「怎么把字节翻译成契约里的 chunk」，不做重试、不做换号、不做轮询——
 * 那些是池子的事（docs/family-contract.md §7）。
 */

import { createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readSse } from './sse.js'
import { tryJson } from '../util.js'
import { httpError } from './http-error.js'

/** 族 id。凭据记录键是 `<scope>/trae-<n>`，改它等于让已有账号失联。 */
export const ID = 'trae'

/* ------------------------------------------------------------------ *
 * 区域与端点
 * ------------------------------------------------------------------ */

/**
 * 两个区域。CN 与国际区的**聊天主机不同**，而刷新/额度主机也跟着换。
 *
 * 证据分级（`_dsh_research/research/kimi-trae.md` §2.2）：
 *   - CN 的 chat / remote / pay 三个主机是 `[已证实]`：两个独立实现逐字吻合。
 *   - 国际区 chat 主机 `coresg-normal.trae.ai` 是 `[单源]`（只有 dsh-connect-trae），
 *     所以它被写在这个注释里、并且**允许账号级覆盖**，而不是当成铁律。
 */
export const REGIONS = Object.freeze(['cn', 'ai'])

/** CN 抓包实证的版本码：它**决定上游返回哪张模型配置表**（20260820 → 36 个含 glm-5.3；20260716 → 35 个无 glm-5.3）。 */
export const VERSION_CODE = '20260820'
/** dsh-connect-trae 在 `iCubeLastVersion` 不是纯数字时用的兜底版本码。它会让 `glm-5.3` 报 4001，所以只在实在读不到客户端版本时才用。 */
export const VERSION_CODE_FALLBACK = '20260716'
/** 客户端 IDE 版本。上游不靠它选表（靠 version-code），所以它错了后果轻。 */
export const IDE_VERSION = '0.1.61'
export const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
/** 聊天链路伪装的身份：Trae IDE 主进程。 */
export const CHAT_UA = `Trae/${IDE_VERSION}`
/** 签到/积分链路伪装的身份：VSCode 插件进程。**两套身份绝不能混用**，见 §2.8。 */
export const UG_UA = 'VSCode 1.107.1 (TRAE SOLO CN)'
export const MARKET_CLIENT_ID = 'VSCode 1.107.1'
export const DEVICE_BRAND = '83DG'
export const OS_VERSION = 'Windows 11 Pro'

export const CHAT_PATH = '/api/agent/v3/llm_utils_chat'
export const MODELS_PATH = '/api/ide/v1/get_detail_param'
export const EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'
export const EXCHANGE_PATH_SOLO_SG = '/trae/api/v3/oauth/ExchangeToken'
export const USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo'
export const CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
export const CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
export const ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage'

/** 默认聊天 function。`solo_work_lite` 是两实现共同的默认值，也是抓包实证能出流的那个。 */
export const DEFAULT_FUNCTION = 'solo_work_lite'

/**
 * 客户端身份 client_id（就是登录 URL 里的 `client_id`）。
 * 两实现都用它，且它与登录链路同源，所以这里不做分歧处理。
 */
export const CLIENT_ID = 'en1oxy7wnw8j9n'

/**
 * 刷新用 client_id —— **本族唯一一处跨源分歧**（任务书要求我把分歧原样写在注释里）。
 *
 *   - traework：`en1oxy7wnw8j9n`（与登录同一个 client_id），真实账号跑通。
 *   - dsh-connect-trae：`ono9krqynydwx5`（CN/SG/SOLO 三 edition），真实账号跑通；
 *     它把 `en1oxy7wnw8j9n` 留给 `solo-sg`，并且那条路连路径都换成
 *     `/trae/api/v3/oauth/ExchangeToken`、还要额外带 `DeviceInfo`。
 *
 * **默认取 `ono9krqynydwx5`**，理由：dsh-connect-trae 对这条路径的取证更细
 * （`docs/INTL_SG_EVIDENCE.md §2.2` 有抓包），而且它把 edition 维度也分开了——
 * traework 只有一个常量，没法解释为什么单独 solo-sg 要换路径。
 * 两者都在真机上跑通过，所以这**不是**「谁对谁错」，而是「哪条路的证据更完整」。
 *
 * 账号级覆盖入口见 `refreshClientId(auth)`：`auth.refreshClientId` /
 * `auth.edition === 'solo-sg'` 都能改掉它。维护者若在真机上发现 CN 号刷新失败，
 * 第一件事就是把 `auth.refreshClientId` 设成 `en1oxy7wnw8j9n` 再试一次。
 */
export const REFRESH_CLIENT_ID = 'ono9krqynydwx5'

/* ------------------------------------------------------------------ *
 * Electron storage.json 解密
 *
 * 算法来自 dsh-connect-trae `src/decrypt.ts:12-39`（安装包二进制逆向，`[已证实]`）。
 * 四组盐各 64 字节，必须**一字不差**照抄——它们参与 SHA-512 派生，错一个字节
 * 就是「密码学意义上解不开」，症状是 integrity check failed，而不是报错说盐不对。
 * ------------------------------------------------------------------ */

/** 盐 A。 */
const SALT_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37])
/** 盐 B。 */
const SALT_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125])
/** 盐 C（只用于 `aes-private`）。 */
const SALT_C = Uint8Array.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209])
/** 盐 D（只用于 `aes-private`）。 */
const SALT_D = Uint8Array.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170])

/** storage.json 里放凭据的那个键。 */
export const AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide'
/** 设备 id 记录的键前缀，后面跟一段 id。 */
export const DEVICE_KEY_PREFIX = 'iCubeAuthInfo://icube-dc:'
/** 客户端版本键（形如 `2.3.76922`——**点分串，不能直接当 version-code 用**）。 */
export const BUILD_VERSION_KEY = 'iCubeLastVersion'
export const TELEMETRY_MACHINE_KEY = 'telemetry.machineId'
export const TELEMETRY_DEVICE_KEY = 'telemetry.devDeviceId'

const HEADER_AES = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00])
const HEADER_AES_PRIVATE = Buffer.from([0x12, 0x39, 0x20, 0x20, 0x02, 0x03])

function xorBytes(a, b) {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)))
}

/** 6 字节头定算法；不认识的头部**必须抛**，不能猜——猜错就是把别人的密文当自己的解。 */
export function encryptionType(header) {
  const bytes = Buffer.from(header)
  if (bytes.equals(HEADER_AES)) return 'aes'
  if (bytes.equals(HEADER_AES_PRIVATE)) return 'aes-private'
  throw new Error('trae: unsupported auth encryption header')
}

/**
 * 解开 `storage.json` 里那个 string 值。
 *
 * 布局：`[6B 头][32B random][AES-128-CBC 密文]`，密文解出来是
 * `[64B SHA-512 摘要][UTF-8 JSON]`。派生：`derived = SHA512(SHA512(random) || salt)`，
 * `key = derived[0:16]`、`iv = derived[16:32]`。
 *
 * 摘要校验是这里最有价值的一步：它把「解错了盐」「截错了偏移」这类静默错误变成
 * 一个明确的异常，而不是一段乱码 JSON。
 */
export function decryptTraeStorageValue(encoded) {
  const buffer = Buffer.from(String(encoded), 'base64')
  // 6 + 32 + 至少一个 AES 块(16) + padding，再留出 64 字节摘要的余量。
  if (buffer.length <= 102) throw new Error('trae: auth ciphertext is too short')
  const type = encryptionType(buffer.subarray(0, 6))
  const random = buffer.subarray(6, 38)
  const encrypted = buffer.subarray(38)
  const salt = type === 'aes-private' ? xorBytes(SALT_C, SALT_D) : xorBytes(SALT_A, SALT_B)
  const first = createHash('sha512').update(random).digest()
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (decrypted.length < 64) throw new Error('trae: auth plaintext is too short')
  const expected = decrypted.subarray(0, 64)
  const plaintext = decrypted.subarray(64)
  const actual = createHash('sha512').update(plaintext).digest()
  if (!expected.equals(actual)) throw new Error('trae: auth integrity check failed')
  return plaintext.toString('utf8')
}

/**
 * 值可能是密文也可能是明文（`{...}` 开头的直接当 JSON）。
 * 手建凭据文件不需要加密——这条旁路让「用户自己粘一份 JSON」成为可能。
 */
export function parseTraeAuthValue(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') throw new Error('trae: auth value is empty')
  return trimmed.startsWith('{') ? trimmed : decryptTraeStorageValue(trimmed)
}

/** `2.3.76922` → `'20260820'` 之外的情况：上游把 version-code 绑定成数字，点分串会被拒。 */
export function normalizeVersionCode(value, fallback = VERSION_CODE_FALLBACK) {
  const text = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '').trim()
  // 注意 `\d+` 上的锚点必须夹住整个串：`/^\d+$/` 在 `2.3.76922` 上会**通过**，
  // 因为这个模式只要求「以数字开头、以数字结尾」。那正是这个函数要拦的东西。
  return /^\d+$/.test(text) ? text : fallback
}

/* ------------------------------------------------------------------ *
 * 主机与 URL
 * ------------------------------------------------------------------ */

/**
 * 区域主机表。`auth.apiHost` / `auth.payHost` 允许账号级覆盖：国际区的 chat 主机
 * 只有单源证据，而且用户自建代理网关是真实存在的用法（笔记 §2.9 的 `4023`）。
 */
export function region(auth = {}) {
  const declared = typeof auth.region === 'string' ? auth.region.toLowerCase() : ''
  const value = declared === 'ai' || declared === 'intl' || declared === 'international' ? 'ai' : declared === 'cn' ? 'cn' : ''
  if (value !== '') return value
  // 没声明时按主机反推，最后兜底 CN（CN 证据最完整）。
  const host = String(auth.apiHost ?? auth.chatHost ?? '')
  if (host.includes('trae.ai')) return 'ai'
  return 'cn'
}

function hostFor(auth, field, byRegion) {
  const override = auth?.[field]
  if (typeof override === 'string' && override.trim() !== '') return override.trim().replace(/\/+$/u, '')
  return byRegion[region(auth)]
}

const CHAT_HOSTS = { cn: 'https://trae-api-cn.mchost.guru', ai: 'https://coresg-normal.trae.ai' }
const REMOTE_HOSTS = { cn: 'https://solo.trae.cn', ai: 'https://coresg-normal.trae.ai' }
const PAY_HOSTS = { cn: 'https://api.trae.cn', ai: 'https://growsg-normal.trae.ai' }

export const chatUrl = (auth) => hostFor(auth, 'apiHost', CHAT_HOSTS) + CHAT_PATH
export const modelsUrl = (auth) => chatUrl(auth).replace(CHAT_PATH, MODELS_PATH)
export const remoteModelsUrl = (auth) => hostFor(auth, 'remoteHost', REMOTE_HOSTS) + '/api/remote/v1/models'
export const entUsageUrl = (auth) => hostFor(auth, 'payHost', PAY_HOSTS) + ENT_USAGE_PATH
export const checkinStatusUrl = (auth) => hostFor(auth, 'payHost', PAY_HOSTS) + CHECKIN_STATUS_PATH
export const checkinClaimUrl = (auth) => hostFor(auth, 'payHost', PAY_HOSTS) + CHECKIN_CLAIM_PATH

/**
 * 刷新端点。默认路径是 `EXCHANGE_PATH`；只有 `solo-sg` 这个 edition 换路径
 * （见 `REFRESH_CLIENT_ID` 上方的分歧说明）。
 */
export function exchangeUrl(auth = {}) {
  const host = hostFor(auth, 'oauthHost', { cn: 'https://api.trae.cn', ai: 'https://api.trae.cn' })
  const path = auth.edition === 'solo-sg' ? EXCHANGE_PATH_SOLO_SG : EXCHANGE_PATH
  return host + path
}

/**
 * 刷新用 client_id。账号级可覆盖——这正是任务书要求的「两处跨源分歧做成账号级常量」。
 */
export function refreshClientId(auth = {}) {
  const override = auth?.refreshClientId
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return REFRESH_CLIENT_ID
}

/* ------------------------------------------------------------------ *
 * 请求头
 * ------------------------------------------------------------------ */

/** 令牌是所有鉴权头的公共值。空令牌照样发（让上游给 401，而不是我们本地先抛）。 */
function tokenOf(auth = {}) {
  return typeof auth.accessToken === 'string' ? auth.accessToken : ''
}

function traceHeaders() {
  const requestId = randomBytes(16).toString('hex')
  const traceId = randomBytes(16).toString('hex')
  return {
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'x-custom-trace-id': traceId,
    // 两个 trace header 家族语法不同（`04-` vs `00-`），保守做法是两套都发。
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'X-TT-Trace-Id': `00-${randomBytes(16).toString('hex')}-${requestId.slice(0, 16)}-01`,
  }
}

function identityHeaders(auth = {}, platform = process.platform) {
  const headers = {}
  const deviceType = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux'
  headers['X-Device-Type'] = deviceType
  if (typeof auth.machineId === 'string' && auth.machineId !== '') headers['X-Machine-Id'] = auth.machineId
  if (typeof auth.deviceId === 'string' && auth.deviceId !== '') headers['X-Device-Id'] = auth.deviceId
  if (typeof auth.uid === 'string' && auth.uid !== '') headers['X-Uid'] = auth.uid
  headers['X-Device-Brand'] = typeof auth.deviceBrand === 'string' && auth.deviceBrand !== '' ? auth.deviceBrand : DEVICE_BRAND
  headers['X-OS-Version'] = typeof auth.osVersion === 'string' && auth.osVersion !== '' ? auth.osVersion : OS_VERSION
  return headers
}

/**
 * 聊天/目录链路的头（IDE 主进程身份）。
 *
 * `Authorization: Cloud-IDE-JWT <token>` —— **不是 `Bearer`**。写成 Bearer 的症状是
 * 401（或者更糟：HTTP 200 + 流内 `1001`），而 curl 手测时很容易「看起来也对」。
 */
export function chatHeaders(auth = {}, { stream = false, platform } = {}) {
  const accessToken = tokenOf(auth)
  const versionCode = normalizeVersionCode(auth.versionCode)
  return {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': typeof auth.userAgent === 'string' && auth.userAgent !== '' ? auth.userAgent : CHAT_UA,
    Authorization: `Cloud-IDE-JWT ${accessToken}`,
    'X-Cloudide-Token': accessToken,
    'X-Ide-Token': accessToken,
    'X-App-Id': APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': typeof auth.appVersion === 'string' && auth.appVersion !== '' ? auth.appVersion : IDE_VERSION,
    'X-Ide-Version-Code': versionCode,
    'X-App-Version-Code': versionCode,
    'X-Ide-Version-Type': 'stable',
    'x-plugin-channel': 'icube-ai',
    'Request-Traffic-Type': 'prod',
    ...traceHeaders(),
    ...identityHeaders(auth, platform),
  }
}

/**
 * 签到/积分链路的头（VSCode 插件进程身份）。
 *
 * 与 `chatHeaders` **必须分开**：真实客户端这两条链路的 UA 不同，用聊天 UA 发签到
 * 属于「第三套不存在的身份」，风控画像直接对不上（笔记 §2.8 注释）。注意
 * `X-Market-Client-Id` **不带 CN 后缀**，而 UA 带。
 *
 * 本族把签到/积分做成**显式手动动作**，所以这个函数只被 `quota()`（一个查询，
 * 不是「白嫖」动作）和未来的手动签到工具用到，永远不会出现在自动路径上。
 */
export function ugHeaders(auth = {}, { platform } = {}) {
  const accessToken = tokenOf(auth)
  const headers = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': UG_UA,
    Authorization: `Cloud-IDE-JWT ${accessToken}`,
    'X-User-Region': region(auth) === 'ai' ? 'US' : 'CN',
    'Accept-Language': 'zh-CN',
    'Package-Type': 'stable_cn',
    'X-Lgw-Req-Sdk-Type': '3',
    'X-Market-Client-Id': MARKET_CLIENT_ID,
    'X-Device-Brand': typeof auth.deviceBrand === 'string' && auth.deviceBrand !== '' ? auth.deviceBrand : DEVICE_BRAND,
    'X-Device-Type': platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux',
    'X-OS-Version': typeof auth.osVersion === 'string' && auth.osVersion !== '' ? auth.osVersion : OS_VERSION,
    'App-Version': typeof auth.appVersion === 'string' && auth.appVersion !== '' ? auth.appVersion : IDE_VERSION,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none',
    ...traceHeaders(),
  }
  if (typeof auth.deviceId === 'string' && auth.deviceId !== '') headers['X-Device-Id'] = auth.deviceId
  // 只有已经持久化过 marketUserId 才发；它是 uuid-v4，服务端不提供，必须本地生成并随凭据持久化。
  if (typeof auth.marketUserId === 'string' && auth.marketUserId !== '') headers['X-Market-User-Id'] = auth.marketUserId
  return headers
}

/** 刷新端点的头。它既不是聊天身份也不是插件身份，而是 OAuth 端点最常见的那一套。 */
export function refreshHeaders(auth = {}, { platform } = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': typeof auth.userAgent === 'string' && auth.userAgent !== '' ? auth.userAgent : CHAT_UA,
    ...identityHeaders(auth, platform),
    ...traceHeaders(),
  }
}

/* ------------------------------------------------------------------ *
 * 请求体构造
 * ------------------------------------------------------------------ */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把宿主给的 OpenAI 式消息改写成 Trae 私有信封能接受的样子。
 *
 * 四处改写每一处都有明确的失败症状：
 *   - `content` 是字符串 → **必须**数组化成 `[{type:'text',text}]`。上游按数组解析，
 *     给字符串就是 4001「参数无效」。
 *   - `role:'developer'` → `'system'`。上游只接受 system/assistant/user/tool/function。
 *   - assistant 历史里的 `tool_calls[i].function` → `.function_call`（**改名，不是加字段**）。
 *   - `role:'tool'` 必须有非空 `tool_call_id`；没有的话上游会把它当成一条畸形消息，
 *     整个请求 4001——所以我们**丢掉**这条消息而不是发出去（丢一条工具结果比整轮失败好）。
 */
export function normalizeTraeMessages(messages = []) {
  const out = []
  for (const raw of Array.isArray(messages) ? messages : []) {
    if (!isObject(raw)) continue
    const message = { ...raw }
    if (message.role === 'developer') message.role = 'system'
    if (typeof message.content === 'string') {
      message.content = message.content === '' ? [] : [{ type: 'text', text: message.content }]
    } else if (message.content === undefined || message.content === null) {
      message.content = []
    }
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || message.tool_call_id === '')) {
      // 没有 tool_call_id 的工具消息是无主的，上游会因它整条拒绝。
      continue
    }
    if (Array.isArray(message.tool_calls)) {
      const calls = []
      for (const call of message.tool_calls) {
        if (!isObject(call)) continue
        const source = isObject(call.function) ? call.function : isObject(call.function_call) ? call.function_call : undefined
        if (source === undefined) continue
        const name = typeof source.name === 'string' ? source.name : ''
        // 上游要求 FunctionCall.Name 必填，空名字的项直接丢。
        if (name === '') continue
        const next = { ...call }
        delete next.function
        next.function_call = { name, arguments: typeof source.arguments === 'string' ? source.arguments : JSON.stringify(source.arguments ?? {}) }
        calls.push(next)
      }
      if (calls.length === 0) delete message.tool_calls
      else message.tool_calls = calls
    }
    out.push(message)
  }
  return out
}

/**
 * 工具定义：`tools[i].function.parameters` 是对象 → **必须** stringify。
 * 上游把这个字段当字符串读，给对象就是 4001。没有合法 `function` 的项丢掉。
 */
export function normalizeTraeTools(tools = []) {
  const out = []
  for (const raw of Array.isArray(tools) ? tools : []) {
    if (!isObject(raw) || !isObject(raw.function)) continue
    const name = typeof raw.function.name === 'string' ? raw.function.name : ''
    if (name === '') continue
    const parameters = raw.function.parameters
    out.push({
      ...raw,
      function: {
        ...raw.function,
        name,
        parameters: typeof parameters === 'string' ? parameters : JSON.stringify(parameters ?? { type: 'object', properties: {} }),
      },
    })
  }
  return out
}

/**
 * 私有请求信封。
 *
 * `config_name` **必须与 `model` 同值**——上游真读的是 `config_name`，`model` 只是
 * 陪跑。只发 `model` 的症状是 4001，而不是「模型不存在」，所以很容易查错方向。
 *
 * 这里**刻意不转发** temperature / max_tokens / tool_choice / response_format：
 * `llm_utils_chat` 不是 OpenAI 兼容端点，多一个不认识的字段就可能让每个模型都
 * 校验失败（dsh-connect-trae `src/solo.ts:93-95` 的原话）。
 */
export function prepareTraeBody(input = {}) {
  const model = typeof input.model === 'string' ? input.model : ''
  const hasTools = Array.isArray(input.tools) && input.tools.length > 0
  const messages = normalizeTraeMessages(input.messages)
  const body = {
    messages,
    model,
    config_name: typeof input.config_name === 'string' && input.config_name !== '' ? input.config_name : model,
    function: typeof input.function === 'string' && input.function !== '' ? input.function : DEFAULT_FUNCTION,
    stream: true,
  }
  if (hasTools) {
    const tools = normalizeTraeTools(input.tools)
    if (tools.length > 0) body.tools = tools
  }
  // `reasoning_effort` 是 `[单源]` 证据（只有 traework 发）。我们把 attempt 的
  // `effort` 原样透传：换个键名去猜上游的档位枚举，属于「编」。
  if (typeof input.reasoning_effort === 'string' && input.reasoning_effort !== '') body.reasoning_effort = input.reasoning_effort
  return body
}

/** 目录请求体（逐字来自 traework `fetchModels`）。 */
export function catalogBody(functionName) {
  return {
    function: functionName,
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null,
  }
}

/** 刷新请求体：字段名是**帕斯卡**（`ClientID` 而不是 `client_id`）。 */
export function exchangeBody(auth = {}, clientId = refreshClientId(auth)) {
  // `solo-sg` 走的是另一条刷新路径（`/trae/api/v3/oauth/ExchangeToken`），那条路径上的
  // client id 是 traework 抓包实证的 `en1oxy7wnw8j9n`——不是 CN/SG/SOLO 三 edition 共用的
  // `ono9krqynydwx5`。两个 client id 都在真实账号上跑通过，所以这里按 edition 分流而不是二选一。
  const resolved = auth.edition === 'solo-sg' && clientId === REFRESH_CLIENT_ID ? CLIENT_ID : clientId
  const body = {
    ClientID: resolved,
    ClientSecret: '-',
    RefreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    UserID: typeof auth.uid === 'string' ? auth.uid : '',
  }
  // 只有 solo-sg 这条路要 DeviceInfo（见 REFRESH_CLIENT_ID 上方说明）。
  if (auth.edition === 'solo-sg') {
    body.DeviceInfo = {
      DeviceID: auth.deviceId ?? '',
      MachineID: auth.machineId ?? '',
      PlatformCode: 'SOLO_PC',
      DeviceType: 'PC',
      DeviceName: auth.deviceName ?? '',
    }
  }
  return body
}

/* ------------------------------------------------------------------ *
 * 模型目录
 * ------------------------------------------------------------------ */

/**
 * 能拿去发聊天的 function 名单。
 *
 * `get_detail_param` 的名单与**聊天**能用的名单**不是一回事**：`solo_agent` 在目录里
 * 有 43 个模型，但拿它当聊天 function 会让名下 8 个模型**全部** `4011`
 * （message 还谎称 "rate limit"）。所以这个列表里**绝不能**出现 `solo_agent`。
 */
export const CHAT_FUNCTIONS = Object.freeze({
  cn: Object.freeze(['solo_work_remote', DEFAULT_FUNCTION, 'solo_agent_remote', 'chat_v3', 'solo_coder']),
  ai: Object.freeze(['solo_work_remote', DEFAULT_FUNCTION, 'solo_agent_remote', 'chat_v3']),
})

/**
 * 远端目录（`{remote}/models`）的 function 名单。它**可以**含 `solo_agent`：
 * 那个组是 19 个模型的**唯一**来源（`solo_agent ⊇ solo_agent_remote`，只读后者会
 * 静默漏掉 9 个）。目录里学到归属之后，聊天时再按 `solo_agent` 名下的模型
 * 回退到它真正能用的 function。
 */
export const DIRECTORY_FUNCTIONS = Object.freeze(['solo_agent', 'solo_agent_remote', 'solo_work_remote', DEFAULT_FUNCTION, 'chat_v3', 'solo_coder', 'builder_v3'])
export const DETAIL_FUNCTIONS = Object.freeze(['solo_work_remote', DEFAULT_FUNCTION, 'solo_agent_remote', 'chat_v3', 'solo_coder'])

/**
 * 聊天时该用哪个 function。
 *
 * 目录里学到的归属**只有在它真能发聊天时**才用。`solo_agent` 是唯一已知的
 * 「目录里有、聊天不服务」的 function（它名下有 43 个模型，拿它发聊天全部 4011）。
 * 落到它身上就退回调用方给的备选（通常是 `solo_work_remote`——那个组是它名下
 * 大多数模型的真实归属）。
 */
export function chatFunctionFor(regionId, learnedFunction, fallback = 'solo_work_remote') {
  const allowed = regionId === 'ai' ? CHAT_FUNCTIONS.ai : CHAT_FUNCTIONS.cn
  if (typeof learnedFunction === 'string' && allowed.includes(learnedFunction)) return learnedFunction
  return allowed.includes(fallback) ? fallback : DEFAULT_FUNCTION
}

export function directoryFunctionsFor() {
  return DIRECTORY_FUNCTIONS
}

/** 国际区没有 `solo_coder`（该客户端不暴露），其余与 CN 相同。 */
export function detailFunctionsFor(regionId) {
  return regionId === 'ai' ? DETAIL_FUNCTIONS.filter((name) => name !== 'solo_coder') : DETAIL_FUNCTIONS
}

function positiveInteger(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/**
 * `get_detail_param` 的一行 → 目录条目。
 *
 * **`contextWindow` / `maxTokens` 是硬性不变量**：宿主 `dsh-llm` 校验
 * `Number.isInteger(contextWindow) && contextWindow > 0`，不满足是 **provider 级**
 * 失败（整族加载不出来，`INVALID_MODEL_CONTEXT`），不是单模型失败。
 * traework 的 `{contextWindow:0, maxTokens:0}` 在 pi-ai adapter 下必挂
 * （issue #8）。所以这里**读不到就退回调用方的保守默认值**，绝不写 0。
 */
export function parseDetailEntry(entry, functionName, defaults = {}) {
  const configName = typeof entry?.config_name === 'string' ? entry.config_name : ''
  if (configName === '') return undefined
  const display = isObject(entry?.display_config) ? entry.display_config : {}
  const dev = positiveInteger(entry?.max_context_tokens) ?? positiveInteger(entry?.context_window) ?? positiveInteger(display.max_context_tokens)
  const max = positiveInteger(entry?.max_mode_context_tokens) ?? positiveInteger(display.max_mode_context_tokens)
  // **只有 `dev` 才是日常窗口。** `max_mode_context_tokens` 是「开 Max 模式后能到多少」
  // 的上限，不是默认值：实测 `glm-5.2` 在 `chat_v3` 里 `dev=116000 / max=1000000`。
  // 拿 max 当默认是**高估**，而契约 §5.3 对这一项的要求是「宁可保守也不要编」——
  // 高估会把超长请求送上去被拒、白烧一次额度，低估只是提前压缩。没有 dev 时才退到 max。
  const contextWindow = dev ?? max ?? positiveInteger(defaults.maxContextWindow) ?? 200_000
  const tokenLimit = positiveInteger(entry?.max_tokens) ?? positiveInteger(display.max_tokens) ?? positiveInteger(defaults.maxTokens) ?? 32_000
  return {
    id: configName,
    name: typeof display.display_name === 'string' && display.display_name !== '' ? display.display_name : configName,
    // 记归属：发聊天时要用「它所属的那个 function」，而不是列表里第一个能用的。
    wireFunction: functionName,
    wireConfigName: configName,
    contextWindow,
    maxTokens: Math.min(tokenLimit, contextWindow),
    // 组里报 max_mode 才认这个更大的窗口，否则就是编。
    maxContextWindow: entry?.max_mode === true ? max : undefined,
  }
}

/**
 * 同 id 多行取强。这是**四级词典序、必须一路比到底**：
 *   ① 有 Max 层的胜过没有；
 *   ② 两个 Max 行取更大的 Max；
 *   ③ Max 相等（或都没有）取**更宽**的常规窗口；
 *   ④ 全相等保留先到者。
 *
 * 只比前两级就返回的写法会让默认上下文窗口变成掷硬币：实测 `glm-5.2` 在
 * `chat_v3` 赢时 dev=116000、在 `solo_agent_remote` 赢时 dev=200000（30 个 CN
 * 模型里 9 个这样）。
 */
export function preferStrongerRow(candidate, current) {
  if (current === undefined) return candidate
  const candidateMax = positiveInteger(candidate?.maxContextWindow)
  const currentMax = positiveInteger(current?.maxContextWindow)
  if ((candidateMax !== undefined) !== (currentMax !== undefined)) return candidateMax !== undefined ? candidate : current
  if (candidateMax !== undefined && currentMax !== undefined && candidateMax !== currentMax) return candidateMax > currentMax ? candidate : current
  const candidateDev = positiveInteger(candidate?.contextWindow) ?? 0
  const currentDev = positiveInteger(current?.contextWindow) ?? 0
  if (candidateDev !== currentDev) return candidateDev > currentDev ? candidate : current
  return current
}

function pushRow(map, row) {
  if (row === undefined) return
  map.set(row.id, preferStrongerRow(row, map.get(row.id)))
}

/**
 * `get_detail_param` 响应 → 目录。它返回的是**一个 function 的**一张表，所以要对
 * 每个 function 各发一次再并集（只读一个 function 会静默漏模型）。
 */
export function parseDetailParam(payload, functionName, defaults = {}) {
  const rows = new Map()
  const list = payload?.config_info_list ?? payload?.data?.config_info_list
  if (Array.isArray(list)) {
    for (const entry of list) pushRow(rows, parseDetailEntry(entry, functionName, defaults))
  }
  return rows
}

/**
 * 远端目录响应 → 目录。分组语义：`solo_agent` 是超集，它是
 * `gpt-6-astra` / `gpt-5.6-*` / `glm-5.2` / `gpt-5.5` 的**唯一**来源。
 */
export function parseRemoteCatalog(payload, defaults = {}) {
  const rows = new Map()
  const groups = payload?.data?.functions ?? payload?.functions ?? payload?.data ?? payload
  const entries = Array.isArray(groups) ? groups : isObject(groups) ? Object.values(groups) : []
  for (const group of entries) {
    if (!isObject(group)) continue
    const functionName = typeof group.function === 'string' ? group.function : typeof group.function_name === 'string' ? group.function_name : ''
    const configs = Array.isArray(group.config_info_list) ? group.config_info_list : Array.isArray(group.config_list) ? group.config_list : Array.isArray(group.models) ? group.models : []
    for (const entry of configs) pushRow(rows, parseDetailEntry(entry, functionName || DEFAULT_FUNCTION, defaults))
  }
  return rows
}

/**
 * 兜底目录。
 *
 * 这**不是**「没有证据也要装得像有数据」：它的唯一职责是让 provider 在目录请求
 * 失败时仍能加载出来（`contextWindow` 是 provider 级不变量），而池子会有自己的
 * 失败开放合并。每行都带正整数 `contextWindow`——issue #8 就是漏了这一条导致
 * 整个 provider 加载失败。**不要删这里的 `contextWindow`。**
 */
export const FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', contextWindow: 200_000, maxTokens: 32_000 }),
  Object.freeze({ id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', contextWindow: 200_000, maxTokens: 32_000 }),
  Object.freeze({ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000, maxTokens: 32_000 }),
  Object.freeze({ id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200_000, maxTokens: 32_000 }),
  Object.freeze({ id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro-Preview', contextWindow: 200_000, maxTokens: 32_000 }),
  Object.freeze({ id: 'gemini-3-flash-solo', name: 'Gemini-3-Flash-Preview', contextWindow: 200_000, maxTokens: 32_000 }),
  Object.freeze({ id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200_000, maxTokens: 32_000 }),
  Object.freeze({ id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 32_000 }),
])

/* ------------------------------------------------------------------ *
 * 额度与签到
 * ------------------------------------------------------------------ */

/**
 * 积分包 → 剩余额度。
 *
 * 两条容易错的地方：
 *   ① **过期包必须跳过**。签到积分是当日发放、31 天后过期的独立包；不滤掉就是把
 *      历史所有签到包累加进「剩余」，用户会看到一个永远不降的数字。
 *   ② `limit <= 0` 的包跳过（它们是占位包，不是额度）。
 * 读不懂就返回 undefined，**绝不编一个 0%**——报一个假的 0 比不报更糟。
 */
export function parseEntitlementUsage(payload, nowSeconds = Math.floor(Date.now() / 1000)) {
  const packs = payload?.user_entitlement_pack_list ?? payload?.data?.user_entitlement_pack_list
  if (!Array.isArray(packs)) return undefined
  let limit = 0
  let used = 0
  for (const pack of packs) {
    const base = isObject(pack?.entitlement_base_info) ? pack.entitlement_base_info : {}
    const quota = isObject(base.quota) ? base.quota : {}
    const packLimit = Number(quota.credits_limit ?? 0)
    if (!Number.isFinite(packLimit) || packLimit <= 0) continue
    const endTime = Number(base.end_time ?? pack?.expire_time ?? 0)
    if (Number.isFinite(endTime) && endTime > 0 && endTime <= nowSeconds) continue
    limit += packLimit
    const packUsed = Number(pack?.usage?.credits_amount ?? 0)
    used += Number.isFinite(packUsed) && packUsed > 0 ? packUsed : 0
  }
  if (limit <= 0) return undefined
  return { limit, used, remaining: Math.max(0, limit - used) }
}

/**
 * 签到响应。**上游一律 HTTP 200**，成败在 `code` 里：
 *   `0` 成功（重复调用也返回 0，幂等、不加积分）；
 *   `9095` 今日已签到（幂等成功，不是失败）；
 *   `9074` 账号级稳定拒绝（**不是抖动**：换 deviceId/UA/token 全无效）；
 *   `1001` 会话失效（与聊天 401 同义）。
 * `checkedIn` 是当前登录态设备的读数，换 deviceId 会短暂变 false（缓存假象），
 * 所以判重维度是**账号**。
 */
export function parseCheckinResult(payload) {
  const record = isObject(payload) ? payload : {}
  const code = Number(record.code ?? 0)
  return {
    code: Number.isFinite(code) ? code : undefined,
    checkedIn: record.checked_in === true,
    enable: record.enable === true,
    credits: Number(record.credits ?? 0) || 0,
    message: typeof record.message === 'string' ? record.message : typeof record.msg === 'string' ? record.msg : '',
  }
}

/**
 * `httpError` 的 Trae 包装。
 *
 * **为什么不能直接用 `httpError`**：它的 `detail` 只认 `{error:{message}}` 与 `{message}` 两种
 * 形状。Trae 的令牌端点在做废 refresh token 时回的是 `{"error":"invalid_grant", ...}`
 * ——`error` 是**字符串**，于是 detail 取到的是 `message`（`"refresh token revoked"`），
 * `mapStatus` 的 `/invalid_grant/` 规则打不中，400 落到末尾的 `'SERVER'`。
 * 后果不是报错难看，而是**死令牌每 60 秒被重试一次**（`SERVER` 只冷 60 秒，`AUTH` 冷 24 小时）。
 * 所以这里先把字符串形的 `error`/`error_code`/`code`/`msg` 并进 detail，再交给宿主那套判定。
 */
export function traeHttpError(response, text, who = ID) {
  const parsed = tryJson(text)
  const upstream =
    isObject(parsed)
      ? [parsed.error, parsed.error_code, parsed.msg, parsed.message]
          .filter((value) => typeof value === 'string' && value !== '')
          .join(' ')
      : ''
  return httpError(response, upstream === '' ? text : `${upstream} ${text}`, who)
}

/* ------------------------------------------------------------------ *
 * 失败归类：HTTP 200 里藏着业务错误
 * ------------------------------------------------------------------ */

/**
 * 流内/信封里的业务错误码 → 池子认识的动作码。
 *
 * 这张表是「宁可多认，不可少认」的：Trae 几乎所有业务错误都是 HTTP 200，
 * 只看状态码就会把失败判成成功；而判错方向的代价是坏号转头又被选中。
 *
 *   `1005` 该模型需付费套餐     → `ACCOUNT_QUOTA`（换号 + 长冷却）
 *   `4008` 该账号没这个模型的配额 → `ACCOUNT_QUOTA`（**与积分余额无关**：实测 3 个号
 *          里 2 个如此，其中一个面板还有 200 积分。归成「客户端参数错」会被核心
 *          当成 unknown 只冷 30 秒）
 *   `4011` 该 function 不服务此模型 → `MODEL_UNAVAILABLE`。**它的 message 谎称
 *          "rate limit"**，照 message 归类就会 5 分钟后重试同一个必然失败的东西。
 *   `4001` 参数无效（含「版本码不对导致这张表里没有这个模型」）→ `MODEL_UNAVAILABLE`
 *   `1001` / `401` / `403`       → `AUTH`
 *   `4023` 用户自挂的第三方代理模型 → `MODEL_UNAVAILABLE`
 */
export const STREAM_CODE_KINDS = Object.freeze({
  1001: 'AUTH',
  1005: 'ACCOUNT_QUOTA',
  4001: 'MODEL_UNAVAILABLE',
  4008: 'ACCOUNT_QUOTA',
  4011: 'MODEL_UNAVAILABLE',
  4023: 'MODEL_UNAVAILABLE',
  9074: 'CHECKIN_DENIED',
  9095: 'CHECKIN_ALREADY',
})

/** 上游 message 会撒谎，所以给用户的说明由我们按 code 生成，而不是转述 message。 */
export const STREAM_CODE_MESSAGES = Object.freeze({
  1001: 'Trae 会话已失效，需要重新登录',
  1005: '这个模型需要付费套餐，当前账号的套餐不包含它',
  4001: 'Trae 拒绝了这个请求的参数（常见原因：该 function 不服务这个模型，或客户端版本码与服务端的模型表不匹配）',
  4008: '这个账号没有该模型的配额（注意：这与积分余额是两回事）',
  4011: 'Trae 的这个 function 不服务该模型（上游 message 谎称是 rate limit）',
  4023: '这是用户自挂的第三方代理模型，该账号不可用',
})

export function streamCodeKind(code) {
  const number = Number(code)
  return STREAM_CODE_KINDS[number]
}

export function streamCodeMessage(code, extra) {
  const number = Number(code)
  const known = STREAM_CODE_MESSAGES[number]
  if (known !== undefined) return known
  const parsed = tryJson(typeof extra === 'string' && extra !== '' ? extra : '')
  const fallback = typeof parsed?.message === 'string' && parsed.message !== '' ? parsed.message : ''
  return fallback !== '' ? `Trae 返回业务错误 ${number}：${fallback}` : `Trae 返回业务错误 ${number}`
}

/**
 * 把一个业务错误码变成带 `code` 的 Error。
 *
 * `error.code` 是池子唯一认识的字段（`src/health.js`）。这里刻意用固定的几个动作码，
 * 而不是把这些数字原样透出去——核心不认识 `4008`。
 */
export function streamError(code, extra, { message } = {}) {
  const number = Number(code)
  const kind = streamCodeKind(number)
  const text = message ?? streamCodeMessage(number, extra)
  const error = new Error(`trae: ${text}（code=${Number.isFinite(number) ? number : 'unknown'}）`)
  error.code = kind ?? 'SERVER'
  error.failure = { status: 200, code: error.code, upstreamCode: Number.isFinite(number) ? number : undefined }
  return error
}

/**
 * 响应信封（**HTTP 200 但 body 里 `code !== 0`**）的判定。
 * 目录/额度/刷新三个非流式端点都走这一条。
 */
export function envelopeError(payload, status, who = ID) {
  const record = isObject(payload) ? payload : {}
  const code = Number(record.code ?? record.status_code ?? 0)
  const ok = record.code === undefined && record.status_code === undefined ? true : code === 0
  if (ok && status >= 200 && status < 300) return undefined
  const detail = typeof record.message === 'string' ? record.message : typeof record.msg === 'string' ? record.msg : `HTTP ${status}`
  const error = new Error(`${who}: ${code === 0 ? '' : `code=${code} `}${detail}`.trim())
  error.code = code !== 0 ? streamCodeKind(code) ?? 'SERVER' : 'SERVER'
  error.failure = { status, code: error.code, upstreamCode: code !== 0 ? code : undefined }
  return error
}

/* ------------------------------------------------------------------ *
 * 私有 SSE 翻译
 * ------------------------------------------------------------------ */

/**
 * 一条 SSE 事件 → 语义事件。**未知事件返回 `kind:'unknown'` 且原样带上 data**，
 * 由调用方无损透传（计数）。这不是洁癖：5 份历史日志里 `progress_notice` 一个
 * 事件就出现过 **7829** 次，不认识就丢等于丢内容。
 *
 * 判定是**宽松**的（照抄 dsh-connect-trae `src/sse.ts` 的 dispatch）：有些批次不带
 * `event:` 名，只能靠 payload 形状认。所以「名字对」或「形状对」都算。
 */
export function classifyStreamEvent({ event, data } = {}) {
  const name = typeof event === 'string' ? event.trim().toLowerCase() : ''
  const raw = typeof data === 'string' ? data : ''
  if (raw === '' && name === '') return { kind: 'ignore' }
  if (name === 'done' || raw === '[DONE]') return { kind: 'done', finishReason: undefined }
  const payload = tryJson(raw)
  if (payload === undefined) {
    // 不是 JSON：只有 `data:` 没有事件名的空壳才会到这里，当成未知事件留着。
    return { kind: 'unknown', event: name, data: raw }
  }
  const record = isObject(payload) ? payload : {}
  if (name === 'error') return { kind: 'error', payload: record }
  if (name === 'done' || (typeof record.finish_reason === 'string' && record.response === undefined && record.tool_calls === undefined)) {
    return { kind: 'done', finishReason: typeof record.finish_reason === 'string' ? record.finish_reason : undefined, payload: record }
  }
  if (name === 'token_usage') return { kind: 'usage', payload: record }
  if (name === 'output' || record.response !== undefined || record.reasoning_content !== undefined || record.tool_calls !== undefined) {
    return { kind: 'delta', payload: record, event: name }
  }
  if (name === 'request_wait_in_queue') return { kind: 'queued', payload: record }
  if (name === 'progress_notice') return { kind: 'unknown', event: name, data: raw }
  return { kind: 'unknown', event: name, data: raw }
}

function numberOrUndefined(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

/** `token_usage` → 契约的 `usage`。上游字段名是 snake_case，四个缓存字段名各不同。 */
export function usageFromEvent(payload = {}) {
  const usage = {}
  const input = numberOrUndefined(payload.prompt_tokens)
  const output = numberOrUndefined(payload.completion_tokens)
  const cached = numberOrUndefined(payload.cache_read_input_tokens)
  const created = numberOrUndefined(payload.cache_creation_input_tokens)
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (cached !== undefined) usage.cachedInputTokens = cached
  if (created !== undefined) usage.cacheCreationInputTokens = created
  return usage
}

/**
 * `tool_calls` 增量 → `{index, id?, name?, argumentsDelta}`。
 *
 * 数组里每一项都可能只带一半信息（先来 name，再来一串 arguments 片段），所以这里
 * 只做「归一化」，合并与「块何时结束」由 translator 负责。`function` 与
 * `function_call` 两种拼法都要认（同一个上游的不同批次两种都发过）。
 */
export function toolCallDeltas(payload = {}) {
  const list = Array.isArray(payload.tool_calls) ? payload.tool_calls : []
  const out = []
  for (const raw of list) {
    if (!isObject(raw)) continue
    const index = Number.isInteger(raw.index) ? raw.index : Number.isInteger(raw.tool_index) ? raw.tool_index : out.length
    const source = isObject(raw.function) ? raw.function : isObject(raw.function_call) ? raw.function_call : raw
    const delta = { index }
    if (typeof raw.id === 'string' && raw.id !== '') delta.id = raw.id
    const name = source.name ?? source.tool_name
    if (typeof name === 'string' && name !== '') delta.name = name
    const args = source.arguments ?? source.params ?? source.input
    if (typeof args === 'string' && args !== '') delta.argumentsDelta = args
    else if (isObject(args)) delta.argumentsDelta = JSON.stringify(args)
    if (delta.id === undefined && delta.name === undefined && delta.argumentsDelta === undefined) continue
    out.push(delta)
  }
  return out
}

/** `finish_reason` → 契约的三个合法值。**写别的不会报错，只会静默丢失语义。** */
export function finishKind(reason, { hasToolCalls = false } = {}) {
  const text = typeof reason === 'string' ? reason.toLowerCase() : ''
  if (text === 'tool_calls' || text === 'tool_use' || text === 'function_call' || text === 'tool-calls') return 'tool-calls'
  if (text === 'length' || text === 'max_tokens' || text === 'max-tokens') return 'max-tokens'
  if (text === 'stop' || text === 'end_turn' || text === 'eos' || text === '') return hasToolCalls ? 'tool-calls' : 'stop'
  // 不认识的 finish_reason：有工具调用就说是工具调用，否则当正常结束。
  // 唯一不能做的是把上游字符串原样透出去——宿主认不出它，会当成「这轮没结束」。
  return hasToolCalls ? 'tool-calls' : 'stop'
}

/**
 * 把 Trae 的私有 SSE 变成 docs/family-contract.md §5 的 chunk 流。
 *
 * 几条与契约直接相关的决定：
 *   - `block-start` 在**第一个 delta 到达时**才发（契约说 `block-start` 不算「已输出」，
 *     但提前发一个空块没有任何好处，还会让「没内容」的判定变复杂）；
 *   - `block-end` 只在**真的有内容**时发（text 非空 / 有 id / 有 arguments）。池子靠
 *     「block-end 带真实内容」判断还能不能换号重放，判定宽松了会导致重复输出；
 *   - 一个块都没出就抛 `EMPTY_RESPONSE`（池子靠它决定可以换号重试）；
 *   - 未知事件**计数后透传**，不抛、不丢。
 */
export async function* translateTraeStream(response, options = {}) {
  const { signal } = options
  const blocks = new Map() // index → 累积状态
  const toolOrder = []
  const unknownEvents = new Map()
  let emitted = false
  let finished = false
  let usageEmitted = false
  let nextIndex = 0
  let sawToolCalls = false

  const ensureIndex = () => {
    const index = nextIndex
    nextIndex += 1
    return index
  }

  function* start(kind, index) {
    blocks.set(index, { kind, text: '', id: '', name: '', arguments: '' })
    yield { type: 'block-start', index, blockType: kind }
  }

  for await (const raw of readSse(response, { signal })) {
    const event = classifyStreamEvent(raw)
    if (event.kind === 'ignore') continue
    if (event.kind === 'unknown') {
      // 无损透传：只计数，不丢、不抛。
      unknownEvents.set(event.event, (unknownEvents.get(event.event) ?? 0) + 1)
      continue
    }
    if (event.kind === 'queued') continue
    if (event.kind === 'error') {
      // 刻意**不转述**上游 message：`4011` 的 message 谎称是 "rate limit"，
      // `4008` 的 "exceeded the quota" 又会被误解成积分不足。说明文案由 code 生成。
      throw streamError(Number(event.payload.code), event.payload.extra)
    }
    if (event.kind === 'usage') {
      const usage = usageFromEvent(event.payload)
      if (Object.keys(usage).length > 0) {
        usageEmitted = true
        yield { type: 'usage', usage }
      }
      continue
    }
    if (event.kind === 'delta') {
      const payload = event.payload
      if (typeof payload.reasoning_content === 'string' && payload.reasoning_content !== '') {
        let index = [...blocks.entries()].find(([, block]) => block.kind === 'reasoning')?.[0]
        if (index === undefined) {
          index = ensureIndex()
          yield* start('reasoning', index)
        }
        blocks.get(index).text += payload.reasoning_content
        emitted = true
        yield { type: 'reasoning-delta', index, text: payload.reasoning_content }
      }
      if (typeof payload.response === 'string' && payload.response !== '') {
        let index = [...blocks.entries()].find(([, block]) => block.kind === 'text')?.[0]
        if (index === undefined) {
          index = ensureIndex()
          yield* start('text', index)
        }
        blocks.get(index).text += payload.response
        emitted = true
        yield { type: 'text-delta', index, text: payload.response }
      }
      for (const delta of toolCallDeltas(payload)) {
        sawToolCalls = true
        let index = toolOrder.find((entry) => entry.toolIndex === delta.index)?.index
        if (index === undefined) {
          index = ensureIndex()
          toolOrder.push({ toolIndex: delta.index, index })
          yield* start('tool-call', index)
        }
        const block = blocks.get(index)
        if (typeof delta.id === 'string' && delta.id !== '' && block.id === '') block.id = delta.id
        if (typeof delta.name === 'string' && delta.name !== '' && block.name === '') block.name = delta.name
        if (typeof delta.argumentsDelta === 'string') block.arguments += delta.argumentsDelta
        emitted = true
        yield { type: 'tool-call-delta', index, ...(delta.id === undefined ? {} : { id: delta.id }), ...(delta.name === undefined ? {} : { name: delta.name }), argumentsDelta: delta.argumentsDelta ?? '' }
      }
      continue
    }
    if (event.kind === 'done') {
      if (finished) continue
      finished = true
      if (emitted) {
        for (const [index, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
          if (block.kind === 'text') yield { type: 'block-end', index, block: { type: 'text', text: block.text } }
          else if (block.kind === 'reasoning') yield { type: 'block-end', index, block: { type: 'reasoning', text: block.text } }
          else yield { type: 'block-end', index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments === '' ? '{}' : block.arguments } }
        }
      }
      if (!usageEmitted) yield { type: 'usage', usage: {} }
      yield { type: 'finish', reason: { kind: finishKind(event.finishReason, { hasToolCalls: sawToolCalls }) } }
      continue
    }
  }

  if (!emitted) {
    const error = new Error('trae: 上游没有返回任何内容块（EMPTY_RESPONSE）')
    error.code = 'EMPTY_RESPONSE'
    error.failure = { status: 200, code: 'EMPTY_RESPONSE' }
    throw error
  }
  if (!finished) {
    // 流断了但没收到 done：把已累积的块收尾，让宿主拿到一段完整回答而不是半截。
    for (const [index, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.kind === 'text') yield { type: 'block-end', index, block: { type: 'text', text: block.text } }
      else if (block.kind === 'reasoning') yield { type: 'block-end', index, block: { type: 'reasoning', text: block.text } }
      else yield { type: 'block-end', index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments === '' ? '{}' : block.arguments } }
    }
    if (!usageEmitted) yield { type: 'usage', usage: {} }
    yield { type: 'finish', reason: { kind: finishKind(undefined, { hasToolCalls: sawToolCalls }) } }
  }
}
