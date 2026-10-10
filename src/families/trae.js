/**
 * `trae` 族（字节跳动 Trae / TRAE SOLO）。
 *
 * 这一族的难点**不在**协议翻译，而在三件别处没有的事：
 *
 *   1. **凭据是加密的 Electron 存储**。`storage.json` 里 `iCubeAuthInfo://icube.cloudide`
 *      是一个 AES-128-CBC 密文（盐与派生见 `src/wire/trae.js`）。好消息是四组盐与
 *      算法都有二进制逆向来历（`[已证实]`），所以**读得出来**；坏消息是**没有加密方向
 *      的实证**，所以本族**只读、绝不写回客户端文件**（见下面「凭据写回」）。
 *   2. **Trae 几乎所有业务错误都是 HTTP 200**。成败藏在 body 的 `code` 或 SSE 的
 *      `event:error` 里。只看状态码会把失败当成功，而判错方向的代价是坏号转头又被选中。
 *   3. **可调用性取决于 `function` × `config_name` 的组合**，不是模型 id 说了算。
 *      `glm-5.3` 在 `solo_work_lite` 下报 `4001`、在 `solo_work_remote` 下正常；
 *      拿 `solo_agent` 当聊天 function 会让它名下 8 个模型**全部** `4011`
 *      （message 还谎称是 "rate limit"）。所以目录里必须同时记住「这个 config_name
 *      属于哪个 function」，发聊天时用它。
 *
 * ── 凭据写回（本族最大的一处范围裁剪，必须让维护者看见） ──
 *
 * Trae 的 refresh token **是一次性轮换的** `[已证实]`，所以「不写回」在别的族里
 * 等于把桌面端踢下线。但这里不能照抄 minimax 的写回：
 *   - `storage.json` 是**密文**，写回需要重新加密。考古笔记里**只有解密方向**
 *     （`decrypt.ts`），没有加密方向的任何实现或抓包证据。自己拼一个加密器意味着
 *     拿一个我们无法验证的头部字节去覆盖用户 Trae IDE 的登录态文件——写坏 = 用户
 *     的 IDE 被登出，而且我们连「写坏了」都发现不了。
 *   - 更要命的是**同源并发**：Trae IDE 自己也在用同一个 refresh token 刷新，
 *     两边互相覆盖是必然的，不是偶发。
 *
 * 所以本族的做法是：**导入后只读**。刷新结果（新的 access/refresh token）写进
 * DSH 自己的凭据记录——那本来就是插件自己的落点，不是别人的文件。后果是：用久了
 * 需要重新导入一次。这是一个**已知的、写在明面上的**取舍，不是一个偷偷跳过的步骤。
 *
 * ── 签到（check-in）──
 *
 * **不做**。签到是「白嫖积分」，与「把订阅接进模型选择器」是两件事，而它是这一族里
 * 唯一会改变用户账号状态的动作——一个定位失败或时序不对的自动签到，代价是账号被
 * 风控标记（`9074` 是账号级稳定拒绝，跟着账号走，而不是跟着 deviceId 走）。
 * 本族只保留**纯查询**的额度读取（`quota()`，读 `ide_user_ent_usage`），它不改任何
 * 状态。签到相关的事件码归类仍然写在 wire 层，供维护者将来做「设置页里的显式按钮」。
 *
 * @module dsh-account-bridge/families/trae
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { assertApiReply } from '../wire/assert-reply.js'
import { withSource } from '../util.js'
import {
  AUTH_STORAGE_KEY,
  BUILD_VERSION_KEY,
  CLIENT_ID,
  DEFAULT_FUNCTION,
  DEVICE_KEY_PREFIX,
  ID,
  TELEMETRY_DEVICE_KEY,
  TELEMETRY_MACHINE_KEY,
  VERSION_CODE,
  catalogBody,
  chatFunctionFor,
  chatHeaders,
  chatUrl,
  detailFunctionsFor,
  directoryFunctionsFor,
  entUsageUrl,
  envelopeError,
  exchangeBody,
  exchangeUrl,
  modelsUrl,
  normalizeVersionCode,
  traeHttpError,
  parseDetailParam,
  parseEntitlementUsage,
  parseRemoteCatalog,
  parseTraeAuthValue,
  preferStrongerRow,
  prepareTraeBody,
  refreshClientId,
  refreshHeaders,
  region,
  translateTraeStream,
  ugHeaders,
} from '../wire/trae.js'

export const ROUTE = 'acct-trae'
export const DISPLAY_NAME = 'Trae'

/** 提前 5 分钟刷新：刷新要走一次网络，卡着过期点刷会让正在跑的一轮撞上 401。 */
export const REFRESH_SKEW_MS = 5 * 60_000
/** 签到链路的超时（本族只用于 `quota()` 这类只读查询）。 */
export const QUOTA_TIMEOUT_MS = 15_000
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_MAX_TOKENS = 32_000
/** 登录回调端口。Trae 客户端把它写死在 `auth_callback_url` 里，换端口回调就到不了。 */
export const LOGIN_CALLBACK_PORT = 18080
export const LOGIN_CALLBACK_PATH = '/authorize'

/* ------------------------------------------------------------------ *
 * 路径与客户端身份
 * ------------------------------------------------------------------ */

/**
 * 家目录。`TRAE_HOME` 覆盖是为测试留的门：把路径指到临时目录就能离线跑
 * 「发现/导入」的整条链路，不用在本机装一个 Trae。
 */
export function traeHome(env = process.env) {
  const override = env?.TRAE_HOME
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return env?.USERPROFILE || env?.HOME || homedir() || process.cwd()
}

export function appDataRoot(env = process.env, platform = process.platform) {
  const override = env?.TRAE_APPDATA
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const home = traeHome(env)
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  if (platform === 'win32') return join(home, 'AppData', 'Roaming')
  return env?.XDG_CONFIG_HOME || join(home, '.config')
}

/**
 * Windows 目录名来自客户端 `product.json` 的 `win32DirName`——**不是** macOS 的
 * bundle 拼写。实测（2026-09-26）：`Trae CN -> "Trae CN"`、`TRAE SOLO CN -> "TRAE SOLO CN"`。
 * 每个 edition 给多个候选，因为不同版本/渠道的目录名不一样。
 */
export const DESKTOP_VARIANTS = Object.freeze([
  Object.freeze({ id: 'solo', label: 'TRAE SOLO CN', dirs: Object.freeze(['TRAE SOLO CN', 'trae-solo-cn']) }),
  Object.freeze({ id: 'solo-sg', label: 'TRAE SOLO', dirs: Object.freeze(['TRAE SOLO', 'trae-solo']) }),
  Object.freeze({ id: 'cn', label: 'Trae CN', dirs: Object.freeze(['Trae CN', 'trae-cn']) }),
  Object.freeze({ id: 'sg', label: 'Trae', dirs: Object.freeze(['Trae', 'trae']) }),
])

export const CLI_VARIANTS = Object.freeze([
  Object.freeze({ id: 'cn', label: 'Trae CLI (CN)', home: '.trae-cn' }),
  Object.freeze({ id: 'sg', label: 'Trae CLI', home: '.trae' }),
])

export const CLI_TOKEN_FILENAME = 'trae-jwt-token'

/** `storage.json` 的候选绝对路径（桌面端，密文）。 */
export function desktopStoragePaths(env = process.env, platform = process.platform) {
  const root = appDataRoot(env, platform)
  const out = []
  for (const variant of DESKTOP_VARIANTS) {
    for (const dir of variant.dirs) out.push({ edition: variant.id, label: variant.label, path: join(root, dir, 'User', 'globalStorage', 'storage.json') })
  }
  return out
}

/** CLI 的令牌文件路径（**明文裸 JWT**，不需要解密——这是本族最容易的一条导入路）。 */
export function cliTokenPaths(env = process.env) {
  const home = traeHome(env)
  return CLI_VARIANTS.map((variant) => ({ edition: variant.id, label: variant.label, path: join(home, variant.home, CLI_TOKEN_FILENAME) }))
}

/* ------------------------------------------------------------------ *
 * 设备身份
 * ------------------------------------------------------------------ */

/**
 * 真实 Aha 设备号是 **15–16 位纯数字**（实测如 `1711320556112436`）。
 * 用 GUID/UUID 顶替会触发签到 `9074`（账号级稳定拒绝），所以这里必须能区分
 * 「客户端给的」和「我们合成的」——合成的那个只能用于聊天头，不能用于签到。
 */
export function isRealDeviceId(value) {
  return typeof value === 'string' && /^\d{15,16}$/u.test(value)
}

/**
 * `machine_id` 长度分歧（任务书点名的第二处跨源分歧）：
 *   - traework：hex32（32 字节 hex，注释写「抓包实证」）；
 *   - dsh-connect-trae：**64 字符**，直接取客户端自己的 `telemetry.machineId`（A 级证据）。
 *
 * 默认取**证据更强的那条**：先用客户端存储里的 `telemetry.machineId`（那本来就是
 * 这台机器的既有身份，改它反而更像换机），拿不到才合成一个 hex32。
 * 账号级覆盖入口：`auth.machineId` 一旦存在就不再合成。
 */
export function deriveMachineId(storage = {}, fallbackSeed) {
  const fromStorage = storage[TELEMETRY_MACHINE_KEY] ?? storage.machineId
  if (typeof fromStorage === 'string' && fromStorage.trim() !== '') return fromStorage.trim()
  return createHash('sha256').update(String(fallbackSeed ?? randomUUID())).digest('hex').slice(0, 32)
}

/**
 * 设备 id 同理：优先客户端存储里的真实设备号（15–16 位数字），否则才合成。
 * `iCubeAuthInfo://icube-dc:<id>` 这个前缀在存储里有多个键，取第一个非空的。
 */
export function deriveDeviceId(storage = {}, machineId) {
  for (const [key, value] of Object.entries(storage)) {
    if (key.startsWith(DEVICE_KEY_PREFIX) && typeof value === 'string' && value.trim() !== '') {
      return { deviceId: value.trim(), source: 'storage' }
    }
  }
  const telemetry = storage[TELEMETRY_DEVICE_KEY]
  if (typeof telemetry === 'string' && telemetry.trim() !== '') return { deviceId: telemetry.trim(), source: 'storage' }
  if (isRealDeviceId(machineId)) return { deviceId: machineId, source: 'machine' }
  return { deviceId: createHash('sha256').update(String(machineId ?? randomUUID())).digest('hex').slice(0, 32), source: 'derived' }
}

/** 参考实现里的 Aha 设备号生成：16 位纯数字，首位 1–9（不能是 `10^15 + rand`，那会把高位钉死成 1）。 */
export function newDeviceId() {
  const digits = randomBytes(16)
  let out = String(1 + (digits[0] % 9))
  for (let index = 1; index < 16; index += 1) out += String(digits[index] % 10)
  return out
}

/** 32 字节 hex 的 machine_id（合成用；参考实现的「抓包实证」形态）。 */
export function newMachineId() {
  return randomBytes(16).toString('hex')
}

/**
 * `X-Market-User-Id` 是 uuid-v4，**服务端不提供**（315 条抓包流里都没有），
 * 必须本地生成并**随凭据持久化**——每次请求现生成一个新的等于每次换一个身份。
 */
export function newMarketUserId() {
  return randomUUID()
}

/* ------------------------------------------------------------------ *
 * 凭据解析
 * ------------------------------------------------------------------ */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 秒 / 毫秒都能吃。`> 1e12` 当毫秒，否则当秒——上游 `TokenExpireAt` 两种都发过
 * （traework 自己就写了 `>1e12` 的除法）。
 */
export function timeToMs(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return number > 1e12 ? Math.trunc(number) : Math.trunc(number * 1000)
}

/**
 * `storage.json` 里解出来的 JSON → 我们自己的 auth 形状。
 *
 * 这一层刻意**不猜**：JWT 里的账号 claim 是 `[未找到]`（两实现都从 GetUserInfo
 * 或 storage 文档拿），所以 uid/邮箱一律留空，由 `GetUserInfo` 去补。
 */
export function parseStorageAuth(document, defaults = {}) {
  const record = isObject(document?.auth) ? document.auth : document
  if (!isObject(record)) throw new Error('trae: 凭据不是对象')
  const accessToken = optionalString(record.accessToken) ?? optionalString(record.token)
  const refreshToken = optionalString(record.refreshToken)
  if (accessToken === undefined && refreshToken === undefined) throw new Error('trae: 凭据里既没有 accessToken 也没有 refreshToken')
  const expiresAt = timeToMs(record.expiresAt ?? record.expiredAt ?? record.tokenExpireAt)
  return {
    accessToken: accessToken ?? '',
    refreshToken: refreshToken ?? '',
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(optionalString(record.machineId) === undefined ? {} : { machineId: optionalString(record.machineId) }),
    ...(optionalString(record.deviceId) === undefined ? {} : { deviceId: optionalString(record.deviceId) }),
    ...(optionalString(record.uid) === undefined ? {} : { uid: optionalString(record.uid) }),
    ...(optionalString(record.marketUserId) === undefined ? {} : { marketUserId: optionalString(record.marketUserId) }),
    ...(optionalString(record.edition) === undefined ? {} : { edition: optionalString(record.edition) }),
    ...(defaults.edition === undefined ? {} : { edition: defaults.edition }),
    ...(optionalString(record.appVersion) === undefined ? {} : { appVersion: optionalString(record.appVersion) }),
    ...(defaults.sourcePath === undefined ? {} : { sourcePath: defaults.sourcePath }),
  }
}

/**
 * JWT 的 payload（**不验签**——我们只想知道它什么时候过期，不是要信任它）。
 * `exp` / `iat` 在顶层（`[单源]`），`iat` 用来判「发得太久」：实测 JWT 远未过期
 * 也可能被 401，所以只依据 `exp` 会走进「每次都刷新、每次都失败」的循环。
 */
export function decodeJwtPayload(token) {
  const text = typeof token === 'string' ? token : ''
  const parts = text.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1].replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 从 JWT 里读过期时间。令牌不是 JWT（或没有 exp）就返回 undefined，不编一个。 */
export function expiresAtFromToken(token) {
  const payload = decodeJwtPayload(token)
  const seconds = Number(payload?.exp)
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
}

/* ------------------------------------------------------------------ *
 * 发现（discover）
 * ------------------------------------------------------------------ */

const IGNORED_STORAGE_KEYS = new Set([
  AUTH_STORAGE_KEY,
  BUILD_VERSION_KEY,
  TELEMETRY_MACHINE_KEY,
  TELEMETRY_DEVICE_KEY,
])

/** 从整份 `storage.json` 里取我们要的东西（凭据 + 身份）。 */
export function extractStorage(storage, decoded, defaults = {}) {
  const auth = parseStorageAuth(decoded, defaults)
  const machineId = auth.machineId ?? deriveMachineId(storage, auth.uid)
  const derived = auth.deviceId === undefined ? deriveDeviceId(storage, machineId) : { deviceId: auth.deviceId, source: 'storage' }
  // 兜底**必须是** `VERSION_CODE_FALLBACK`：把 `VERSION_CODE` 当第二参传进来等于
  // 让点分构建串被静默换成 20260820，而那正是上游会拒的那张表（4001）。
  const versionCode = normalizeVersionCode(storage[BUILD_VERSION_KEY])
  return {
    ...auth,
    machineId,
    deviceId: derived.deviceId,
    deviceIdSource: derived.source,
    // 客户端版本是点分串（`2.3.76922`），直接当 version-code 会被上游当类型错误拒掉。
    versionCode,
    buildVersion: optionalString(storage[BUILD_VERSION_KEY]),
    region: defaults.region ?? 'cn',
  }
}

async function readDesktopEntry(entry) {
  let text
  try {
    text = await readFile(entry.path, 'utf8')
  } catch {
    return undefined
  }
  if (text.trim() === '') return { entry, state: 'absent' }
  let storage
  try {
    storage = JSON.parse(text)
  } catch {
    return { entry, state: 'unrecognized', reason: 'storage.json 不是合法 JSON' }
  }
  if (!isObject(storage)) return { entry, state: 'unrecognized', reason: 'storage.json 顶层不是对象' }
  const value = storage[AUTH_STORAGE_KEY]
  if (typeof value !== 'string' || value.trim() === '') {
    return { entry, state: 'unrecognized', reason: `storage.json 里没有 ${AUTH_STORAGE_KEY}（客户端装了但没登录）` }
  }
  let decoded
  try {
    decoded = JSON.parse(parseTraeAuthValue(value))
  } catch (error) {
    // **如实报**：解不开就是解不开，不要静默跳过，也不要猜一个凭据出来。
    return { entry, state: 'undecryptable', reason: `凭据解不开：${error.message}` }
  }
  try {
    return { entry, state: 'ok', storage, auth: extractStorage(storage, decoded, { edition: entry.edition, sourcePath: entry.path }) }
  } catch (error) {
    return { entry, state: 'unrecognized', reason: error.message }
  }
}

async function readCliEntry(entry) {
  let text
  try {
    text = await readFile(entry.path, 'utf8')
  } catch {
    return undefined
  }
  const token = text.trim()
  if (token === '') return { entry, state: 'absent' }
  const payload = decodeJwtPayload(token)
  const expiresAt = expiresAtFromToken(token)
  const machineId = newMachineId()
  const deviceId = newDeviceId()
  return {
    entry,
    state: 'ok',
    auth: {
      accessToken: token,
      // CLI 令牌文件里**没有** refresh token。没有它就不能刷新——这是真实情况，
      // 不假装能刷（`needsRefresh` 会因此返回 false）。
      refreshToken: '',
      ...(expiresAt === undefined ? {} : { expiresAt }),
      machineId,
      deviceId,
      deviceIdSource: 'generated',
      versionCode: VERSION_CODE,
      region: 'cn',
      edition: entry.edition,
      ...(optionalString(payload?.userId) === undefined ? {} : { uid: optionalString(payload?.userId) }),
      sourcePath: entry.path,
      // 合成身份必须标出来：签到链路不能拿它当 Aha 设备号。
      syntheticIdentity: true,
    },
  }
}

function discoveryItem(found, kind) {
  const base = {
    family: ID,
    sourcePath: found.entry.path,
    label: `Trae ${found.entry.label}`,
    externallyOwned: true,
  }
  if (found.state !== 'ok') {
    return {
      ...base,
      importable: false,
      reason:
        found.state === 'undecryptable'
          ? `${found.reason}。本插件不会拿一个解不开的文件去做任何事，也不会覆盖它；请在 Trae 里重新登录后重试。`
          : found.reason,
    }
  }
  const missing = found.auth.accessToken === '' && found.auth.refreshToken === ''
  if (missing) return { ...base, importable: false, reason: '凭据里既没有 access token 也没有 refresh token' }
  return {
    ...base,
    importable: true,
    auth: found.auth,
    reason:
      kind === 'cli'
        ? '从 Trae CLI 的明文令牌文件导入。该文件里没有 refresh token，所以这份凭据无法自动续期，过期后需要重新导入。'
        : '从加密的 Electron storage.json 解出（只读）。刷新后的令牌写进 DSH 自己的凭据记录，不回写客户端文件——重新加密没有实证，写坏用户 IDE 的登录态不可接受。',
  }
}

/**
 * 扫描本机 Trae 登录态。四种结果都要能被区分（契约 §4.4）：
 * 可导入 / 有凭据但导不进来（带 reason）/ 装了没登录 / 没装。
 *
 * **只读**：本函数不写任何文件。
 */
export async function discover(ctx, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const items = []

  const cliFound = []
  for (const entry of cliTokenPaths(env)) {
    const found = await readCliEntry(entry)
    if (found !== undefined) cliFound.push(found)
  }
  for (const found of cliFound) if (found.state === 'ok') items.push(discoveryItem(found, 'cli'))

  const desktopFound = []
  for (const entry of desktopStoragePaths(env, platform)) {
    const found = await readDesktopEntry(entry)
    if (found !== undefined) desktopFound.push(found)
  }
  const importableDesktop = desktopFound.filter((found) => found.state === 'ok')
  if (importableDesktop.length > 0) {
    for (const found of importableDesktop) items.push(discoveryItem(found, 'desktop'))
  } else {
    // 一个都没解出来：把「最接近成功」的那个如实报出来。
    // 报 **一个**（不是四个）：同一台机器上四个 edition 目录通常只有一个是真的。
    const first = desktopFound.find((found) => found.state === 'undecryptable') ?? desktopFound.find((found) => found.state === 'unrecognized')
    if (first !== undefined) items.push(discoveryItem(first, 'desktop'))
  }

  if (items.length === 0) {
    // 「装了但没登录」和「根本没装」是两件事，用户看到的信息完全不同。
    const installed = await installedDesktopDirectory(env, platform)
    if (installed !== undefined) {
      return [
        {
          family: ID,
          sourcePath: installed,
          label: 'Trae（已安装，未登录）',
          importable: false,
          reason: '找到了 Trae 的数据目录，但里面没有登录凭据（globalStorage/storage.json 不存在），也就是装了但还没有登录过。先在 Trae 客户端里登录，再回来导入。',
        },
      ]
    }
  }
  return items
}

async function installedDesktopDirectory(env, platform) {
  const seen = new Set()
  for (const entry of desktopStoragePaths(env, platform)) {
    const dir = join(entry.path, '..', '..', '..')
    if (seen.has(dir)) continue
    seen.add(dir)
    try {
      if ((await stat(dir)).isDirectory()) return dir
    } catch {
      // 目录不存在，继续找。
    }
  }
  return undefined
}

/**
 * 凭据记录。`externallyOwned: true` 是**诚实**的标记：这份凭据确实属于外部客户端。
 *
 * 它与 minimax 的语义差别在于：minimax 用它表示「我会写回你的桌面端」，本族用它
 * 表示「它的源头在你的客户端里」——而 `refresh()` **不**写回客户端文件（见文件头）。
 */
export function recordFromDiscovery(item) {
  const auth = item?.auth
  if (!isObject(auth) || (typeof auth.accessToken !== 'string' && typeof auth.refreshToken !== 'string')) {
    const error = new Error('trae: 这条发现结果里没有可用的凭据')
    error.code = 'MISSING_CREDENTIAL'
    throw error
  }
  return withSource(
    {
      family: ID,
      label: item.label ?? DISPLAY_NAME,
      source: 'client-import',
      externallyOwned: true,
      auth,
      createdAt: new Date().toISOString(),
    },
    item,
  )
}

/* ------------------------------------------------------------------ *
 * 登录
 * ------------------------------------------------------------------ */

/**
 * 登录参数。**没有 PKCE、没有 scope、没有 state**——这是 Trae 客户端自己的登录方式，
 * 照抄它是唯一可行的做法（加一个上游不认识的 `state` 只会让参数校验失败）。
 */
export function buildLoginUrl(auth = {}, { callbackUrl = `http://127.0.0.1:${LOGIN_CALLBACK_PORT}${LOGIN_CALLBACK_PATH}` } = {}) {
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: '2.3.62834',
    auth_type: 'local',
    client_id: CLIENT_ID,
    redirect: '0',
    login_trace_id: randomBytes(8).toString('hex'),
    auth_callback_url: callbackUrl,
    machine_id: auth.machineId ?? '',
    device_id: auth.deviceId ?? '',
    x_device_id: auth.deviceId ?? '',
    x_machine_id: auth.machineId ?? '',
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: '0.1.61',
    x_app_type: 'stable',
  })
  return `https://www.trae.cn/authorization?${params.toString()}`
}

/**
 * 解析回调 URL 或用户手工粘贴的那一整行。
 *
 * `userInfo` / `userJwt` 是**双重编码**的 JSON，且有的批次带 percent-encoding、
 * 有的不带，所以两个形态各试一次 `JSON.parse`。
 */
export function parseLoginCallback(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error('trae: 回调内容为空')
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text
  const params = new URLSearchParams(query)
  const refreshToken = optionalString(params.get('refreshToken'))
  if (refreshToken === undefined) {
    throw new Error('trae: 回调里没有 refreshToken（粘贴的内容不完整，或者贴错了行）')
  }
  return {
    refreshToken,
    userInfo: parseLooseJson(params.get('userInfo')),
    userJwt: parseLooseJson(params.get('userJwt')),
  }
}

function parseLooseJson(raw) {
  if (raw === null || raw === undefined || raw === '') return undefined
  for (const candidate of [raw, safeDecode(raw)]) {
    try {
      const parsed = JSON.parse(candidate)
      if (isObject(parsed)) return parsed
    } catch {
      // 换下一个形态。
    }
  }
  return undefined
}

function safeDecode(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 登录成功那一跳的解析结果 → 交换出的令牌。**不写任何文件**。
 */
export function grantFromLogin(callback, identity = {}) {
  const info = callback.userInfo ?? {}
  const uid = optionalString(info.user_id) ?? optionalString(info.userId) ?? optionalString(info.uid)
  const payload = decodeJwtPayload(typeof callback.userJwt?.token === 'string' ? callback.userJwt.token : undefined)
  return {
    refreshToken: callback.refreshToken,
    ...(uid === undefined ? {} : { uid }),
    ...(optionalString(info.email) === undefined ? {} : { email: optionalString(info.email) }),
    ...(optionalString(payload?.userId) === undefined ? {} : { uid: optionalString(payload.userId) }),
    ...(optionalString(info.enterprise_id ?? info.enterpriseId) === undefined ? {} : { enterpriseId: optionalString(info.enterprise_id ?? info.enterpriseId) }),
    ...(typeof info.plan_type === 'number' ? { planType: info.plan_type } : {}),
    ...identity,
  }
}

/**
 * 交换（也用于刷新）：`RefreshToken` → `Token`。请求体字段是**帕斯卡**。
 *
 * 这个函数被登录与刷新两条路共用是有原因的：Trae 的 OAuth 端点**没有**一个单独的
 * 「用授权码换令牌」的调用，回调里直接给的就是 refresh token。
 */
export async function exchangeToken(ctx, auth, { signal, proxy } = {}) {
  const url = exchangeUrl(auth)
  const clientId = refreshClientId(auth)
  const response = await ctx.fetch(
    url,
    {
      method: 'POST',
      headers: refreshHeaders(auth),
      body: JSON.stringify(exchangeBody(auth, clientId)),
      // 池子调 refresh 时 signal 是 undefined（契约 §3.2），所以这里要能自己活。
      ...(signal === undefined ? { signal: AbortSignal.timeout(30_000) } : { signal }),
    },
    proxy,
  )
  const text = await response.text().catch(() => '')
  if (!response.ok) throw traeHttpError(response, text, ID)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`trae: 刷新响应不是 JSON（HTTP ${response.status}）`)
  }
  const result = isObject(payload?.Result) ? payload.Result : isObject(payload?.data?.Result) ? payload.data.Result : undefined
  if (result === undefined) {
    const error = envelopeError(payload, response.status)
    throw error ?? new Error(`trae: 刷新响应里没有 Result（HTTP ${response.status}）`)
  }
  const token = optionalString(result.Token)
  if (token === undefined) {
    const error = new Error('trae: 刷新没有返回新令牌，需要重新登录')
    error.code = 'AUTH'
    throw error
  }
  // ①**只有非空才覆盖**：上游偶尔不返回新 refresh token，那不代表旧的作废了。
  const refreshToken = optionalString(result.RefreshToken)
  const expiresAt =
    timeToMs(result.TokenExpireAt) ??
    (Number.isFinite(Number(result.TokenExpireDuration)) && Number(result.TokenExpireDuration) > 0
      ? Date.now() + Math.trunc(Number(result.TokenExpireDuration)) * 1000
      : undefined) ??
    expiresAtFromToken(token)
  return { accessToken: token, ...(refreshToken === undefined ? {} : { refreshToken }), ...(expiresAt === undefined ? {} : { expiresAt }) }
}

/**
 * 没登录过的机器上，身份得现造一份并**持久化**（`X-Market-User-Id` 服务端不提供）。
 */
export function newIdentity(edition = 'solo') {
  const machineId = newMachineId()
  return {
    machineId,
    deviceId: newDeviceId(),
    deviceIdSource: 'generated',
    marketUserId: newMarketUserId(),
    versionCode: VERSION_CODE,
    region: 'cn',
    edition,
    syntheticIdentity: true,
  }
}

async function runBrowserLogin(session, ctx) {
  const identity = newIdentity()
  const { startLoopback } = await import('../login/loopback.js')
  let loopback
  try {
    // 先 listen 再提示用户点链接：反过来做的话，端口被占用的错误会发生在
    // 「用户已经登完、浏览器已经在回调」之后，那一轮就白费了。
    loopback = await startLoopback({ ports: [LOGIN_CALLBACK_PORT], path: LOGIN_CALLBACK_PATH, timeoutMs: 10 * 60_000 })
  } catch (error) {
    throw new Error(
      `trae: 本机 ${LOGIN_CALLBACK_PORT} 端口起不来（${error.message}）。Trae 的回调地址是客户端写死的，换端口回调就到不了——请先腾出这个端口，或者改用「手动粘贴回调链接」。`,
    )
  }
  try {
    const url = buildLoginUrl(identity, { callbackUrl: `http://127.0.0.1:${LOGIN_CALLBACK_PORT}${LOGIN_CALLBACK_PATH}` })
    await session.notify?.({ message: `在浏览器里完成 Trae 登录（回调地址固定为本机 ${LOGIN_CALLBACK_PORT} 端口）：${url}`, url })
    const { code } = await loopback.waitForCode()
    const callback = parseLoginCallback(code)
    const tokens = await exchangeToken(ctx, { ...identity, ...grantFromLogin(callback, identity) }, {})
    return { ...identity, ...grantFromLogin(callback, identity), ...tokens }
  } finally {
    await loopback.close()
  }
}

/**
 * 手工粘贴回调链接。
 *
 * 粘贴到手的是 **refresh token**，不是 access token——所以这一步之后**必须**走一次
 * 交换换出可用的 access token。少了这一步，导入进去的凭据第一次请求就会 401，
 * 而用户会以为是「登录没成功」。
 */
async function runManualLogin(session, ctx) {
  const pasted = await session.prompt({
    kind: 'text',
    message:
      '把浏览器地址栏里那一整行回调链接粘贴过来（形如 http://127.0.0.1:18080/authorize?refreshToken=...&userInfo=...&userJwt=...）。' +
      '如果浏览器显示「无法访问此网站」，把地址栏里的完整 URL 复制出来即可。',
  })
  const identity = newIdentity()
  const grant = grantFromLogin(parseLoginCallback(pasted), identity)
  const tokens = await exchangeToken(ctx, grant, {})
  return { ...grant, ...tokens }
}

/* ------------------------------------------------------------------ *
 * 刷新
 * ------------------------------------------------------------------ */

/**
 * 返回**新的 auth 对象**（不是整个 payload）。池子做的是**浅合并**，所以每个会变的
 * 键都必须显式带上：漏掉一个，旧值就会留在记录里。
 *
 * 这里刻意**不写任何客户端文件**——理由见文件头「凭据写回」。
 */
export async function refresh(ctx, payload) {
  const auth = payload?.auth ?? {}
  const refreshToken = optionalString(auth.refreshToken)
  if (refreshToken === undefined && optionalString(auth.accessToken) === undefined) {
    const error = new Error('trae: 这条记录里没有可用于刷新的令牌')
    error.code = 'AUTH'
    throw error
  }
  if (refreshToken === undefined) {
    // CLI 导入的凭据没有 refresh token。**不要**假装刷新成功。
    const error = new Error('trae: 这份 Trae 凭据没有 refresh token（CLI 令牌文件里不含），无法自动续期；请在 Trae 里重新登录后重新导入')
    error.code = 'AUTH'
    throw error
  }
  const tokens = await exchangeToken(ctx, { ...auth, refreshToken }, {})
  return {
    ...auth,
    accessToken: tokens.accessToken,
    // 只有上游真给了新 refresh token 才覆盖。
    refreshToken: tokens.refreshToken ?? refreshToken,
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    // 这些键必须显式带上：池子是浅合并，不带就会被旧值覆盖（虽然这里值没变）。
    machineId: auth.machineId,
    deviceId: auth.deviceId,
    versionCode: auth.versionCode,
    region: auth.region ?? 'cn',
    ...(optionalString(auth.marketUserId) === undefined ? {} : { marketUserId: auth.marketUserId }),
  }
}

/**
 * 过期时间拿不准时**不声称需要刷新**。手动导入的凭据可能根本没有 `expiresAt`，
 * 而刷新又必须有 refresh token——声称「该刷新了」会让每次请求都走进一次注定失败的
 * 刷新；真过期了上游会给 401（然后 `AUTH` 归类会正确地换号 + 长冷却）。
 */
export function needsRefresh(payload, now = Date.now()) {
  const auth = payload?.auth ?? {}
  const expiresAt = auth.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return false
  if (optionalString(auth.refreshToken) === undefined) return false
  return expiresAt - REFRESH_SKEW_MS <= now
}

/* ------------------------------------------------------------------ *
 * 模型目录
 * ------------------------------------------------------------------ */

const catalogCache = new Map()

function remember(rows) {
  for (const row of rows.values()) catalogCache.set(row.id, row)
}

/**
 * 目录 = 多个 function 的并集。
 *
 * 两个容易做错的地方：
 *   - **只问一个 function 会静默漏模型**。`solo_agent` 组是 19 个模型的唯一来源
 *     （`solo_agent ⊇ solo_agent_remote`，只读后者少 9 个），所以远端目录要问全部组。
 *   - **同 id 多行要确定性取强**（`preferStrongerRow`），否则默认上下文窗口是掷硬币。
 */
export async function listModels(ctx, payload, signal) {
  const auth = payload?.auth ?? {}
  const regionId = region(auth)
  const rows = new Map()
  let sawAny = false
  let lastError

  const merge = (parsed) => {
    if (parsed !== undefined && parsed.size > 0) {
      sawAny = true
      for (const [id, row] of parsed) rows.set(id, preferStrongerRow(row, rows.get(id)))
    }
  }

  for (const functionName of detailFunctionsFor(regionId)) {
    try {
      const response = await ctx.fetch(
        modelsUrl(auth),
        { method: 'POST', headers: chatHeaders(auth, { stream: false }), body: JSON.stringify(catalogBody(functionName)), signal },
        payload?.proxy,
      )
      const text = await response.text().catch(() => '')
      if (!response.ok) throw traeHttpError(response, text, ID)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`trae: 目录响应不是 JSON（function=${functionName}）`)
      }
      const envelope = envelopeError(parsed, response.status)
      if (envelope !== undefined) throw envelope
      merge(parseDetailParam(parsed, functionName))
    } catch (error) {
      lastError = error
    }
  }

  if (!sawAny) {
    // 远端目录是**补充**而不是替代：拿不到就只是少模型，不该让整次目录读取失败。
    try {
      const response = await ctx.fetch(
        remoteModelsUrl(auth),
        { method: 'POST', headers: chatHeaders(auth, { stream: false }), body: '{}', signal },
        payload?.proxy,
      )
      const text = await response.text().catch(() => '')
      if (response.ok) {
        const parsed = JSON.parse(text)
        merge(parseRemoteCatalog(parsed))
        merge(parseRemoteCatalog(parsed?.data))
      }
    } catch (error) {
      lastError = error
    }
  }

  if (!sawAny) {
    const error = lastError ?? new Error('trae: 模型目录为空')
    // 目录和额度不一样：调用方会回退到上一次成功的快照，所以**失败就抛**，
    // 不要编一份看起来能用的目录出来。
    if (error.code === undefined) error.code = 'SERVER'
    throw error
  }

  remember(rows)
  return [...rows.values()]
    .map((row) => modelInfo(row, ROUTE))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * `contextWindow` / `maxTokens` **必须是正整数**。
 *
 * 宿主 `dsh-llm` 会校验 `Number.isInteger(contextWindow) && contextWindow > 0`，
 * 不满足是 **provider 级**失败（整族加载不出来，`INVALID_MODEL_CONTEXT`），不是
 * 单模型失败。traework 的 `{contextWindow: 0, maxTokens: 0}` 在 pi-ai adapter 下
 * 必挂（issue #8），所以这里**每一个出口**都要经过这个函数。
 */
export function modelInfo(row, provider = ROUTE) {
  const contextWindow = Number.isInteger(row?.contextWindow) && row.contextWindow > 0 ? row.contextWindow : DEFAULT_CONTEXT_WINDOW
  const maxTokens = Number.isInteger(row?.maxTokens) && row.maxTokens > 0 ? row.maxTokens : Math.min(DEFAULT_MAX_TOKENS, contextWindow)
  return {
    provider,
    id: row?.id ?? 'unknown',
    name: row?.name ?? row?.id ?? 'unknown',
    context: { contextWindow },
    defaultMaxTokens: maxTokens,
    toolUpdate: 'in-history',
    // 只声明我们真的转发了的能力：这一族**不**转发图片（消息体里只构造 text 块）。
    inputModalities: ['text'],
  }
}

/**
 * 元数据来自最近一次成功读到的目录；没读到给保守兜底。
 *
 * 刻意**不内置一份模型清单**：上游的花名册一周内换好几次（版本码一变表就变），
 * 写死一份等于教用户去选已经下架的模型。
 */
export function resolveModel(provider, model) {
  const row = catalogCache.get(model)
  return modelInfo(row ?? { id: model, name: model }, provider)
}

/* ------------------------------------------------------------------ *
 * 额度（只读）
 * ------------------------------------------------------------------ */

/**
 * 只读查询，不做签到。读不懂返回 `undefined`（**绝不编一个 0%**）。
 *
 * 注意这里用的是 `ugHeaders`（VSCode 插件身份）而不是聊天身份：真实客户端这两条
 * 链路的 UA 不同，混用会让风控画像对不上。它只发一个查询，不改变任何状态。
 */
export async function quota(ctx, payload, signal) {
  const auth = payload?.auth ?? {}
  const accessToken = optionalString(auth.accessToken)
  if (accessToken === undefined) return undefined
  try {
    const response = await ctx.fetch(
      entUsageUrl(auth),
      {
        method: 'POST',
        headers: ugHeaders(auth),
        body: JSON.stringify({ require_usage: true, req_source: 2 }),
        ...(signal === undefined ? { signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS) } : { signal }),
      },
      payload?.proxy,
    )
    const text = await response.text().catch(() => '')
    if (!response.ok) return undefined
    const parsed = JSON.parse(text)
    const data = isObject(parsed?.data) ? parsed.data : parsed
    const usage = parseEntitlementUsage(data)
    if (usage === undefined) return undefined
    return [
      {
        id: 'credits',
        name: '积分',
        // 原始值与上限都报出来，免得用户只看到一个百分比去反推。
        remainingFraction: Math.max(0, Math.min(1, usage.remaining / usage.limit)),
        detail: `${usage.remaining} / ${usage.limit}`,
      },
    ]
  } catch (error) {
    // 额度读不懂是常态（字段随时会变），不能连累别的功能。
    try {
      ctx?.log?.warn?.(`trae: 读取积分失败：${error?.message ?? error}`)
    } catch {
      // 日志失败不该连累主流程。
    }
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * 推理
 * ------------------------------------------------------------------ */

/**
 * `stream()` 里**只发一次上游请求**，而且必须是流式的（`ctx.fetch` 第 4 参传 `true`）。
 *
 * 第 4 参漏掉的症状很隐蔽：配了代理的账号在长推理里被 undici 的 30s `bodyTimeout`
 * 掐断，表现为「说到一半莫名中断」（`src/http.js` 文件头有事故记录）。
 */
export async function* stream(ctx, options) {
  const { payload, model, messages = [], tools = [], effort, system, signal } = options ?? {}
  const auth = payload?.auth ?? {}
  const regionId = region(auth)
  const learned = catalogCache.get(model)
  const chatMessages = []
  if (typeof system === 'string' && system !== '') chatMessages.push({ role: 'system', content: system })
  chatMessages.push(...messages)

  const body = prepareTraeBody({
    model,
    messages: chatMessages,
    tools,
    // **用目录里学到的 function**，而不是写死一个：可调用性取决于
    // `function` × `config_name` 的组合，写死 `solo_work_lite` 会让 `glm-5.3` 报 4001。
    function: chatFunctionFor(regionId, learned?.wireFunction, auth.chatFunction ?? 'solo_work_remote'),
    config_name: learned?.wireConfigName ?? model,
    // `reasoning_effort` 是单源证据的字段：把宿主的 `effort` 原样透传，
    // 不猜上游的档位枚举（猜错就是每个请求都 4001）。
    reasoning_effort: typeof effort === 'string' && effort !== '' ? effort : undefined,
  })

  const response = await ctx.fetch(
    chatUrl(auth),
    { method: 'POST', headers: chatHeaders(auth, { stream: true }), body: JSON.stringify(body), signal },
    payload?.proxy,
    true,
  )
  // 200 也可能是网页（Cloudflare 挑战页、登录页、空 body）：先确认它像 API 回复。
  const reply = await assertApiReply(response, { who: ID })
  if (!reply.ok) {
    const text = await reply.text().catch(() => '')
    throw traeHttpError(reply, text, ID)
  }

  // 上游可能回一段**非流式**的 JSON 信封（HTTP 200 + body 里 code 非 0）。
  const contentType = reply.headers?.get?.('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const text = await reply.text().catch(() => '')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`trae: 聊天响应既不是事件流也不是 JSON：${text.slice(0, 200)}`)
    }
    const envelope = envelopeError(parsed, reply.status)
    if (envelope !== undefined) throw envelope
    const error = new Error('trae: 聊天响应是一个空信封，没有内容')
    error.code = 'EMPTY_RESPONSE'
    throw error
  }

  yield* translateTraeStream(reply, { signal })
}

/* ------------------------------------------------------------------ *
 * 族对象
 * ------------------------------------------------------------------ */

export const traeFamily = {
  id: ID,
  displayName: DISPLAY_NAME,
  route: ROUTE,
  // risk 定成 medium 而不是 high：凭据读取是只读且可验证的（解密有摘要校验），
  // 也没有任何会自动改变用户账号状态的动作（签到没做）。
  risk: 'medium',
  discover,
  recordFromDiscovery,
  login: {
    methods: [
      { id: 'browser', label: '浏览器登录（回调固定本机 18080 端口）' },
      { id: 'manual', label: '手动粘贴回调链接' },
    ],
    async run(session, ctx) {
      const method = session?.method === 'manual' ? 'manual' : session?.method === 'browser' ? 'browser' : undefined
      const chosen =
        method ??
        (await session.prompt({
          kind: 'select',
          message: '选择 Trae 登录方式',
          options: [
            { value: 'browser', label: '浏览器登录（回调固定本机 18080 端口）' },
            { value: 'manual', label: '手动粘贴回调链接' },
          ],
        }))
      const auth = chosen === 'manual' ? await runManualLogin(session, ctx) : await runBrowserLogin(session, ctx)
      // **必须在 resolve 之前 commit**，否则 seam 抛 NOT_COMMITTED。
      await session.commit({
        kind: 'grant',
        payload: {
          family: ID,
          label: `Trae${auth.uid === undefined ? '' : ` · ${auth.uid}`}`,
          source: 'oauth',
          externallyOwned: true,
          auth,
          createdAt: new Date().toISOString(),
        },
      })
      try {
        ctx?.log?.info?.('trae: 登录完成')
      } catch {
        // 日志失败不该连累主流程。
      }
      return { family: ID, label: `Trae${auth.uid === undefined ? '' : ` · ${auth.uid}`}` }
    },
  },
  refresh,
  needsRefresh,
  listModels,
  resolveModel,
  quota,
  stream,
}

// 让「兜底目录必须带正整数 contextWindow」这条不变量在模块加载期就能被引用到
// （测试直接断言这个数组；issue #8 的根因就是它缺字段）。
export { modelInfo as buildModelInfo, DEFAULT_FUNCTION }
