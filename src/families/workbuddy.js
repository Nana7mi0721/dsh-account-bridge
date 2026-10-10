/**
 * WorkBuddy 族（腾讯 CodeBuddy / WorkBuddy AI）。
 *
 * 这一族服务的上游是腾讯的 WorkBuddy 桌面端所用的一套 OpenAI 兼容接口
 * （`copilot.tencent.com/v2/chat/completions`，国际版 `www.workbuddy.ai`）。
 * 凭据来自本机桌面 App 写下的登录文件，**只读借用，绝不写回**。
 *
 * 三件容易走错的事，写在最前面：
 *
 * 1. **5.6+ 的凭据是密文**。桌面端把 token 用 AES-256-GCM 静态加密
 *    （`{$wbEncrypted:1, envelope}`，suite 恒为 1），密钥在 App 自己的 Electron
 *    进程里，要跑它自带的二进制才能取出来。本族**不去解**：与其假装能解、
 *    或者静默跳过让用户以为扫过了，不如如实报一条 `importable:false` 并写清原因，
 *    同时提供「手动粘贴令牌」这条真的能走通的路。
 * 2. **`User-Agent` 决定服务端下发哪一份模型目录**（见 `wire/workbuddy.js`），
 *    所以它不是可以随便改的装饰。
 * 3. **上游的额度和目录都可能读不懂**。读不懂时本族返回「未知」——
 *    `quota` 返回 `undefined`（面板上不显示额度条），目录抛错。
 *    报一个假的 0 比不报更糟。
 *
 * 事实来源：corrinehu/dsh-workbuddy-connect 0.7.1 的源码考古，行号随注释给出。
 * 所有上游调用一律走 `ctx.fetch(url, init, payload.proxy, streaming)`
 * （契约 §5），流式请求第 4 个参数必须是 `true`。
 * @module dsh-account-bridge/families/workbuddy
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { assertApiReply } from '../wire/assert-reply.js'
import { httpError } from '../wire/http-error.js'
import { toChatMessages, toChatSystem, toChatTools, translateChatStream } from '../wire/chat-completions.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  EFFORT_NAMES,
  EFFORT_VALUES,
  ENTERPRISE_BILLING_URL,
  ID,
  billingHeaders,
  catalogDocument,
  catalogHeaders,
  chatHeaders,
  chatUrl,
  configUrl,
  creditsUrl,
  envelopeError,
  isObject,
  normalizeChatBody,
  parseCreditAccounts,
  parseEnterpriseCredits,
  parseModelCatalog,
  personalCreditBody,
  prepareInternationalChatBody,
  readEnvelope,
  refreshHeaders,
  refreshUrl,
  regionOf,
} from '../wire/workbuddy.js'
import { withSource } from '../util.js'

export { ID }
export const DISPLAY_NAME = 'WorkBuddy（腾讯 CodeBuddy）'
export const ROUTE = 'acct-workbuddy'

/** 提前刷新余量，与参考实现一致（`src/auth.ts:75-76`）。 */
export const REFRESH_SKEW_MS = 5 * 60_000

/**
 * 刷新响应**没给** `expiresIn` 时的租期。
 *
 * 这是本插件自己的策略，不是上游声明：没有它就会变成「每次请求都刷新一次」。
 * 上限很短，所以最坏情况也只是多刷几次，不会拿着一个以为没过期的令牌硬撑。
 */
export const FALLBACK_ACCESS_TTL_SEC = 30 * 60

/**
 * 国内版与国际版**同目录、只差文件名**（`src/variants.ts:106-164`）。
 * 环境变量名也各有一套（`WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE`）。
 */
export const VARIANTS = Object.freeze([
  Object.freeze({
    id: 'cn',
    filename: 'workbuddy-desktop.info',
    label: 'WorkBuddy 桌面端（国内版）',
    authFileEnv: 'WORKBUDDY_AUTH_FILE',
  }),
  Object.freeze({
    id: 'global',
    filename: 'workbuddy-desktop-ai.info',
    label: 'WorkBuddy AI 桌面端（国际版）',
    authFileEnv: 'WORKBUDDY_AI_AUTH_FILE',
  }),
])

/** 相对用户目录的那一段（`src/auth.ts:105`）。 */
const AUTH_RELATIVE_DIR = join('CodeBuddyExtension', 'Data', 'Public', 'auth')

/** 只有这两个字段可能是密文包装（`AUTH_FIELDS`，`desktop-credential-protection.ts:160-190`）。 */
const AUTH_FIELDS = Object.freeze(['accessToken', 'refreshToken'])

/** 5.6.x 唯一的加密方案编号，其它值不算「加密」而算「认不出来」。 */
const ENCRYPTED_SUITE = 1

// ---------------------------------------------------------------- 本机文件

function warn(ctx, message) {
  try {
    if (typeof ctx?.log?.warn === 'function') ctx.log.warn(message)
    else if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
  } catch {
    /* 日志失败不该连累主流程 */
  }
}

/** 用户目录。`WORKBUDDY_HOME` 是给测试与非常规安装位置的逃生口。 */
export function workbuddyHomeDir(env = process.env) {
  return env?.WORKBUDDY_HOME || env?.USERPROFILE || env?.HOME || homedir() || undefined
}

/**
 * 一个版本的凭据文件候选路径（`defaultDesktopAuthCandidates`，`src/auth.ts:148-173`）。
 *
 * 三条平台差异都是**实测踩出来的**，少一条就会把「已登录」误读成「未登录」：
 * - Windows 新版写 `AppData/Local`、老版写 `AppData/Roaming`，所以两个都要探；
 * - Linux 上 UOS / deepin 写 XDG **data** home，其它发行版写 **config** home；
 * - macOS 固定 `~/Library/Application Support`。
 *
 * 环境变量给的路径排在最前，压倒一切（`src/auth.ts:90`）。
 *
 * WSL 下从 `/mnt/<盘符>` 反向找 Windows 侧的用户目录，参考实现会做，**本族没做**：
 * 那要枚举别人的用户目录，越界；我们宁可如实报「没找到」。
 */
export function authCandidates(variant, env = process.env, platform = process.platform) {
  const spec = typeof variant === 'string' ? VARIANTS.find((item) => item.id === variant) : variant
  if (spec === undefined) return []
  const out = []
  const explicit = env?.[spec.authFileEnv]
  if (typeof explicit === 'string' && explicit.trim() !== '') out.push(resolve(explicit.trim()))
  const home = workbuddyHomeDir(env)
  if (home === undefined) return out
  const relative = join(AUTH_RELATIVE_DIR, spec.filename)
  if (platform === 'darwin') {
    out.push(join(home, 'Library', 'Application Support', relative))
  } else if (platform === 'win32') {
    out.push(join(home, 'AppData', 'Local', relative))
    out.push(join(home, 'AppData', 'Roaming', relative))
  } else {
    const configHome = env?.XDG_CONFIG_HOME || join(home, '.config')
    const dataHome = env?.XDG_DATA_HOME || join(home, '.local', 'share')
    out.push(join(configHome, relative))
    out.push(join(dataHome, relative))
  }
  return out
}

/**
 * 文件内容 → 分类结果。
 *
 * 只按 `accessToken` / `refreshToken` 两个字段判断是不是密文——`nickname`、
 * `phoneNumber` 在 5.6+ 上也是密文，但它们不影响我们能不能用这份凭据
 * （`classifyDesktopAuthDocument`，`desktop-credential-protection.ts:160-190`）。
 *
 * 四种结果，一种都不能合并：
 * - `absent`：文件空（视为没登录，继续找下一个候选）；
 * - `unrecognized`：JSON 破了、或者字段是包装却解不开信封——**这是异常，要报出来**；
 * - `encrypted`：确实加密了，本族解不开（如实报，不假装）；
 * - `plaintext`：能直接用。
 */
export function classifyAuthDocument(text) {
  if (typeof text !== 'string' || text.trim() === '') return { format: 'absent' }
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return { format: 'unrecognized' }
  }
  if (!isObject(document)) return { format: 'unrecognized' }
  // 兼容 `{auth:{…}, account:{…}}` 嵌套形与扁平形（`src/auth.ts:219-257`）。
  const auth = isObject(document.auth) ? document.auth : document
  const wrapped = {}
  let sawWrapped = false
  for (const field of AUTH_FIELDS) {
    const value = auth[field]
    if (isObject(value)) {
      const parsed = parseWrappedField(value)
      if (parsed === undefined) return { format: 'unrecognized' }
      wrapped[field] = parsed
      sawWrapped = true
    }
  }
  return sawWrapped ? { format: 'encrypted', wrapped } : { format: 'plaintext', document }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const normalised = value.replace(/=+$/u, '').replace(/-/gu, '+').replace(/_/gu, '/')
  const bytes = Buffer.from(normalised, 'base64')
  // Buffer 对杂字符是宽容的：只有 round-trip 一致才算真的 base64。
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/u, '') !== normalised) return undefined
  return bytes
}

/**
 * 密文包装的信封校验（`parseWrappedField`，`desktop-credential-protection.ts:103-141`）。
 *
 * 这里**只做辨认**，不做解密：nonce 必须正好 12 字节、authTag 16 字节、
 * ciphertext 非空、suite 是 1、keyId 是 16 位小写 hex——任何一条不满足都说明
 * 这不是 5.6.x 的加密形，那属于「认不出来」而不是「加密了」。
 */
function parseWrappedField(value) {
  if (!isObject(value) || value.$wbEncrypted !== 1) return undefined
  const envelopeBytes = decodeBase64(value.envelope)
  if (envelopeBytes === undefined) return undefined
  let envelope
  try {
    envelope = JSON.parse(envelopeBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isObject(envelope) || envelope.suite !== ENCRYPTED_SUITE) return undefined
  if (typeof envelope.keyId !== 'string' || !/^[0-9a-f]{16}$/u.test(envelope.keyId)) return undefined
  if (decodeBase64(envelope.nonce)?.length !== 12) return undefined
  if (decodeBase64(envelope.authTag)?.length !== 16) return undefined
  if (decodeBase64(envelope.ciphertext) === undefined) return undefined
  return { suite: envelope.suite, keyId: envelope.keyId }
}

/**
 * 时间戳归一：**同一个字段可能是秒也可能是毫秒**（`expiryToMs`，`src/auth.ts:204-208`）。
 * 拿不准就返回 `undefined`，让上层按「没有过期时间」处理，而不是编一个 1970 年。
 */
export function expiryToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value > 1e12 ? value : value * 1000
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** 解开后的明文文档 → 本族的 auth 形状。 */
export function parseDesktopAuth(document, variant) {
  const auth = isObject(document?.auth) ? document.auth : (isObject(document) ? document : {})
  const account = isObject(document?.account) ? document.account : {}
  return {
    accessToken: firstString(auth.accessToken),
    refreshToken: firstString(auth.refreshToken),
    ...(expiryToMs(auth.expiresAt) === undefined ? {} : { expiresAt: expiryToMs(auth.expiresAt) }),
    ...(expiryToMs(auth.refreshExpiresAt) === undefined ? {} : { refreshExpiresAt: expiryToMs(auth.refreshExpiresAt) }),
    // domain 是上游分组网关的依据，空字符串要走 X-No-Department-Info 那条路。
    domain: firstString(auth.domain),
    uid: firstString(account.uid),
    enterpriseId: firstString(account.enterpriseId),
    variant,
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 读一个版本的凭据文件。
 *
 * 空文件不算「找到了」——继续往后找候选，因为新版写 Local、老版写 Roaming，
 * 用户升级后很可能同时留下两份，其中一份是空的。
 */
async function readVariant(variant, env, platform) {
  for (const path of authCandidates(variant, env, platform)) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const classified = classifyAuthDocument(text)
    if (classified.format === 'absent') continue
    return { variant, path, ...classified }
  }
  return undefined
}

/** 装过 App 但没登录的痕迹：凭据目录存在。 */
async function untouchedDirectory(variant, env, platform) {
  for (const path of authCandidates(variant, env, platform)) {
    const dir = dirname(path)
    if (await isDirectory(dir)) return dir
  }
  return undefined
}

function labelFor(variant, auth) {
  // uid 是 5.6+ 上**唯一**还明文可读的身份字段（`nickname` 已经是密文），
  // 所以账号区分只能靠它。它不是令牌，显示在用户自己的设置页里。
  const uid = typeof auth?.uid === 'string' ? auth.uid : ''
  return uid === '' ? variant.label : `${variant.label} · ${uid.slice(0, 8)}`
}

function discoveredItem(variant, found) {
  const base = {
    family: ID,
    sourcePath: found.path,
    label: variant.label,
    externallyOwned: true,
  }
  if (found.format === 'encrypted') {
    return {
      ...base,
      importable: false,
      reason: `${found.path} 里的令牌是 AES-256-GCM 密文（WorkBuddy 5.6 起的静态加密，suite ${ENCRYPTED_SUITE}）。`
        + '密钥在桌面端自己的进程里，本插件不会去解它，也不会假装解得开。'
        + '请改用这一族的「手动粘贴令牌」登录方式，或在 5.6 之前的版本上登录后再导入。',
    }
  }
  if (found.format === 'unrecognized') {
    return {
      ...base,
      importable: false,
      reason: `${found.path} 不是认识的 WorkBuddy 登录文件：JSON 解不开，或者 accessToken/refreshToken 是解不开的包装。`
        + '如果桌面端正在运行，登录写入可能只写了一半，稍后再试一次。',
    }
  }
  const auth = parseDesktopAuth(found.document, variant.id)
  if (auth.accessToken === '') {
    return {
      ...base,
      importable: false,
      reason: `${found.path} 里没有 accessToken——桌面端跑过但没登录成功。先在 App 里登录一次再回来导入。`,
    }
  }
  return { ...base, label: labelFor(variant, auth), importable: true, auth }
}

// ---------------------------------------------------------------- 发现

/**
 * 扫描本机两个版本的登录文件（**只读**）。
 *
 * 四种结果都要报出来（契约 §4.4）：找不到就什么都不报；装过没登录、密文、
 * 格式不认识这三种都报 `importable:false` 加一段能照着做的原因。
 * 静默跳过是最坏的一种——用户以为扫过了。
 */
export async function discover(ctx, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const out = []
  for (const variant of VARIANTS) {
    const found = await readVariant(variant, env, platform)
    if (found === undefined) continue
    out.push(discoveredItem(variant, found))
  }
  if (out.length > 0) return out
  // 两个版本**共用同一个目录**，只有文件名不同（`src/variants.ts:106-164`），
  // 所以「目录在、文件不在」这条信号分不出是哪个版本——只报一次。
  // 报两次会让用户以为装了两份，而他能做的动作只有「去登录一次」。
  for (const variant of VARIANTS) {
    const dir = await untouchedDirectory(variant, env, platform)
    if (dir === undefined) continue
    return [{
      family: ID,
      sourcePath: dir,
      label: DISPLAY_NAME,
      importable: false,
      externallyOwned: true,
      reason: `${dir} 在，但里面还没有登录文件——桌面端跑过、没登录过。先在 App 里登录一次，再回来导入。`,
    }]
  }
  return []
}

// ---------------------------------------------------------------- 族对象

/** @type {import('./registry.js').Family} */
export const workbuddyFamily = {
  id: ID,
  displayName: DISPLAY_NAME,
  route: ROUTE,
  risk: 'high',

  discover,

  /** discover 的落盘入口。只有 `importable: true` 的条目会走到这里。 */
  recordFromDiscovery(item) {
    const auth = item?.auth
    if (typeof auth?.accessToken !== 'string' || auth.accessToken === '') {
      const error = new Error('workbuddy: discovered entries carry no usable access token')
      error.code = 'MISSING_CREDENTIAL'
      throw error
    }
    return withSource({
      family: ID,
      label: item.label ?? DISPLAY_NAME,
      source: 'client-import',
      externallyOwned: true,
      auth: { ...auth },
      createdAt: new Date().toISOString(),
    }, item)
  },

  // -------------------------------------------------------------- 登录

  login: {
    methods: [
      { id: 'import', label: '导入本机 WorkBuddy 桌面端登录态' },
      { id: 'manual', label: '手动粘贴令牌（5.6+ 加密凭据走这条）' },
    ],
    /**
     * 两条路都必须**在 resolve 之前 commit**，否则 seam 抛 `NOT_COMMITTED`（契约 §4.2）。
     * agent 侧的非交互 broker 只自动回答「单选项 select」，所以这条路主要是给设置页用的。
     */
    async run(session, ctx) {
      if (session?.method === 'manual') return runManualLogin(session)
      return runImportLogin(session, ctx)
    },
  },

  // -------------------------------------------------------------- 刷新

  /**
   * 用 refreshToken 换新的 accessToken。
   *
   * 纯 HTTPS，不需要桌面端在线。**返回的是新的 `auth` 对象**（契约 §3.2），
   * 池子会浅合并进原记录，所以会变的键（`accessToken` / `refreshToken` /
   * `expiresAt` / `domain`）必须显式带上；不变的键一起带回来是为了让这个函数
   * 的返回值自洽（单测直接断言它）。
   *
   * 池子传进来的 `signal` **恒为 `undefined`**，所以不能假设它存在。
   */
  async refresh(ctx, payload, signal) {
    const auth = payload?.auth ?? {}
    const refreshToken = typeof auth.refreshToken === 'string' ? auth.refreshToken : ''
    if (refreshToken === '') {
      const error = new Error('workbuddy: 这条记录里没有 refreshToken，无法自动续期——请在 WorkBuddy 桌面端重新登录后导入')
      error.code = 'AUTH'
      throw error
    }
    const region = regionOfAuth(auth)
    // 非流式请求：第 4 个参数（streaming）不传（契约 §5）。
    const response = await ctx.fetch(refreshUrl(region), {
      method: 'POST',
      headers: refreshHeaders(auth, region),
      signal,
    }, payload?.proxy)
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response, envelope, ID)
    const data = isObject(envelope.data) ? envelope.data : {}
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
    if (accessToken === '') {
      const error = new Error('workbuddy: 刷新响应里没有 accessToken，请到桌面端重新登录后再导入')
      error.code = 'AUTH'
      throw error
    }
    const expiresInSec = typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : undefined
    const rotated = typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : refreshToken
    const domain = typeof data.domain === 'string' && data.domain !== '' ? data.domain : auth.domain
    return {
      ...auth,
      accessToken,
      refreshToken: rotated,
      expiresAt: Date.now() + (expiresInSec ?? FALLBACK_ACCESS_TTL_SEC) * 1000,
      ...(domain === undefined || domain === '' ? {} : { domain }),
      variant: auth.variant ?? 'cn',
    }
  },

  /**
   * 过期时间拿不准时**不声称需要刷新**。
   *
   * 这一族手动粘贴进来的令牌可能没有过期时间，而刷新又必须有 refreshToken——
   * 声称「该刷新了」会让每一次请求都走进一次注定失败的刷新。
   * 真过期了上游会给 401，那才是确定的信号。
   */
  needsRefresh(payload, now = Date.now()) {
    const expiresAt = payload?.auth?.expiresAt
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false
    return expiresAt - REFRESH_SKEW_MS <= now
  },

  // -------------------------------------------------------------- 模型目录

  /**
   * `GET /v3/config`。
   *
   * 失败就抛：目录和额度不一样，调用方（池子）会回退到上一次成功的快照，
   * 所以这里没有理由编一份出来。回退是池子的事，不是族的事。
   */
  async listModels(ctx, payload, signal) {
    const auth = payload?.auth ?? {}
    const region = regionOfAuth(auth)
    const response = await ctx.fetch(configUrl(region), {
      method: 'GET',
      headers: catalogHeaders(auth, region),
      signal,
    }, payload?.proxy)
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response, envelope, ID)
    const models = parseModelCatalog(catalogDocument(envelope), { international: region === 'global' })
    rememberCatalog(models)
    return models.map((model) => modelInfo(model, ROUTE))
  },

  /**
   * 元数据来自最近一次成功读到的目录；没读到就给保守的兜底值。
   *
   * 这里**刻意不内置一份模型清单**：上游花名册一周内会换好几次
   * （`auto`、`kimi-k3-1`、`minimax-m3` 都出现过又消失），写死一份等于教用户
   * 去选已经下架的模型。
   */
  resolveModel(provider, model) {
    const known = catalogCache.get(model)
    return known === undefined
      ? modelInfo({ id: model, name: model }, provider)
      : modelInfo(known, provider)
  },

  // -------------------------------------------------------------- 额度

  /**
   * 额度查询。
   *
   * **读不懂就返回 `undefined`**（面板不显示额度条）：报一个假的 0 比不报更糟。
   * 所以这里失败既不抛也不编，只把原因写进日志。
   *
   * CN 企业账号必须走企业端点（`src/upstream.ts:809-872` 的区域闸）：企业端点在
   * 国际区未经验证，所以带 enterpriseId 的国际版凭据仍然留在个人路径上。
   */
  async quota(ctx, payload, signal) {
    const auth = payload?.auth ?? {}
    const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
    if (accessToken === '') return undefined
    const region = regionOfAuth(auth)
    const enterprise = region === 'cn' && typeof auth.enterpriseId === 'string' && auth.enterpriseId !== ''
    try {
      if (enterprise) {
        const response = await ctx.fetch(ENTERPRISE_BILLING_URL, {
          method: 'POST',
          headers: billingHeaders(auth),
          body: JSON.stringify({}),
          signal,
        }, payload?.proxy)
        if (!response.ok) return undefined
        const envelope = await readEnvelope(response)
        if (envelope.code !== 0) return undefined
        const credits = parseEnterpriseCredits(envelope)
        if (credits.unlimited) return [{ id: 'enterprise', name: '企业额度' }]
        return [{
          id: 'enterprise',
          name: '企业额度',
          remainingFraction: credits.size > 0 ? clampFraction(credits.remain / credits.size) : undefined,
          ...(credits.cycleResetTime === undefined ? {} : { resetAt: credits.cycleResetTime }),
        }]
      }
      const response = await ctx.fetch(creditsUrl(region), {
        method: 'POST',
        headers: billingHeaders(auth),
        body: JSON.stringify(personalCreditBody()),
        signal,
      }, payload?.proxy)
      if (!response.ok) return undefined
      const envelope = await readEnvelope(response)
      if (envelope.code !== 0) return undefined
      const accounts = parseCreditAccounts(envelope)
      // 形状对不上 = 不知道，不是 0。
      if (accounts === undefined) {
        warn(ctx, 'account-bridge: workbuddy 额度响应里没有 Accounts 数组，这次不显示额度条（不是 0）')
        return undefined
      }
      const remain = accounts.reduce((sum, item) => sum + item.remain, 0)
      const size = accounts.reduce((sum, item) => sum + (item.size > 0 ? item.size : 0), 0)
      return [{
        id: 'credits',
        name: '积分',
        remainingFraction: size > 0 ? clampFraction(remain / size) : undefined,
      }]
    } catch (error) {
      warn(ctx, `account-bridge: workbuddy 额度查询失败（${error?.message ?? error}），这次不显示额度条`)
      return undefined
    }
  },

  // -------------------------------------------------------------- 对话

  /**
   * 一次对话。
   *
   * 请求体过 `normalizeChatBody`（强制 stream、`developer`→`system`、
   * `tool_choice` 字符串化），国际版再过一层 `prepareInternationalChatBody`
   * （补 system 头、删 `reasoning_effort: 'off'`）。
   *
   * `stream()` 里**只发一次上游请求**：契约 §5 与 `test/streaming-flag.test.js`
   * 都要求这一次是流式的，中间插一个探测请求会把「只有最后一次是流式」打破。
   */
  async *stream(ctx, options) {
    const { payload, model, messages = [], tools = [], effort, system, maxTokens, signal } = options ?? {}
    const auth = payload?.auth ?? {}
    // 令牌缺失时**照样发这一次请求**，让上游给 401，而不是在这里先抛。
    // 理由有两条：一是别的族都是这么做的（`generic.js` 直接拼 `Bearer ${apiKey}`），
    // 二是 `test/streaming-flag.test.js` 的断言是「最后一次调用必须是流式」——
    // 在这里提前抛就等于一次调用都没有，那条测试会变成假失败。
    const region = regionOfAuth(auth)

    const systemText = toChatSystem(system, messages)
    const chatMessages = toChatMessages(messages)
    const declared = catalogCache.get(model)
    const limit = Math.max(1, Number(maxTokens) || declared?.maxTokens || DEFAULT_MAX_TOKENS)
    const level = normaliseEffort(effort)
    const body = {
      model,
      messages: systemText.length > 0 ? [{ role: 'system', content: systemText }, ...chatMessages] : chatMessages,
      stream: true,
      // 输出上限的字段名是 `max_tokens`，不是 `max_completion_tokens`。
      max_tokens: limit,
      ...(tools.length > 0 ? { tools: toChatTools(tools), tool_choice: 'auto' } : {}),
      ...(level === undefined ? {} : { reasoning_effort: level }),
    }

    const raw = JSON.stringify(body)
    const response = await ctx.fetch(chatUrl(region), {
      method: 'POST',
      headers: chatHeaders(auth, region),
      body: region === 'global' ? prepareInternationalChatBody(raw) : normalizeChatBody(raw),
      signal,
    }, payload?.proxy, true)
    // 200 也可能是网页（Cloudflare 挑战页、登录页、空 body）：先确认它像 API 回复。
    const reply = await assertApiReply(response, { who: ID })
    if (!reply.ok) throw httpError(reply, await reply.text().catch(() => ''), ID)

    yield* translateChatStream(reply, { signal })
  },
}

/**
 * 记录最近一次成功读到的目录，供 `resolveModel` 用。
 *
 * 按模型 id 存：不同区域对同一个 id 的窗口偶尔不同，这里以最后一次成功读到的
 * 为准，**不装作知道得更多**。表满就整个丢掉——它只是缓存，丢了顶多退到兜底值。
 */
const catalogCache = new Map()

function rememberCatalog(models) {
  if (catalogCache.size > 200) catalogCache.clear()
  for (const model of models) catalogCache.set(model.id, model)
}

function clampFraction(value) {
  if (!Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/**
 * 区域：凭据里的 `domain` 说了算（`src/upstream.ts:355-359`）。
 *
 * 手动粘贴进来的凭据没有 domain，这时退到用户在登录时选的那个版本——
 * 默认按国内走会把国际账号打到一个它不认识的网关上。
 */
function regionOfAuth(auth) {
  const domain = typeof auth?.domain === 'string' ? auth.domain : ''
  if (domain !== '') return regionOf(domain)
  return auth?.variant === 'global' ? 'global' : 'cn'
}

/**
 * 推理档位。
 *
 * 只发上游词汇表里的五个值（`src/upstream.ts:192`）；`off` / `none` / 认不出来的
 * 值一律**不发这个字段**——上游对 `reasoning_effort` 的接受度按模型而异，
 * 发一个它不认的字面量会直接 400，而不发只是少一个开关。
 */
function normaliseEffort(effort) {
  const value = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  return EFFORT_VALUES.includes(value) ? value : undefined
}

/** 目录行（或兜底行）→ 契约 §5.3 的模型元数据。不知道的值保守，不编。 */
export function modelInfo(entry, provider = ROUTE) {
  const id = typeof entry?.id === 'string' && entry.id !== '' ? entry.id : ''
  const efforts = Array.isArray(entry?.efforts)
    ? entry.efforts
      .filter((value) => typeof value === 'string' && value !== '')
      .map((value) => ({ id: value, name: EFFORT_NAMES[value] ?? value }))
    : []
  const defaultEffort = typeof entry?.defaultEffort === 'string' && efforts.some((item) => item.id === entry.defaultEffort)
    ? entry.defaultEffort
    : undefined
  return {
    provider,
    id,
    name: typeof entry?.name === 'string' && entry.name !== '' ? entry.name : id,
    context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    defaultMaxTokens: entry?.maxTokens ?? DEFAULT_MAX_TOKENS,
    toolUpdate: 'in-history',
    inputModalities: entry?.supportsImages === true ? ['text', 'image'] : ['text'],
    ...(efforts.length === 0 ? {} : { reasoning: { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) } }),
  }
}

// ---------------------------------------------------------------- 登录流程

/**
 * 导入本机登录态。
 *
 * 一个能用的都没有时，把**最具体**的那条原因抛出去：密文那条要告诉用户下一步
 * 怎么办（改用手动粘贴），比一句「没找到」有用得多。
 */
async function runImportLogin(session, ctx) {
  const items = await discover(ctx, {})
  const usable = items.filter((item) => item.importable === true && isObject(item.auth))
  if (usable.length === 0) {
    const blocked = items.find((item) => typeof item.reason === 'string' && item.reason !== '')
    throw new Error(blocked?.reason
      ?? '没有在本机找到 WorkBuddy 桌面端的登录文件（CodeBuddyExtension/Data/Public/auth/）。'
        + '先安装并登录桌面端，或者改用「手动粘贴令牌」。')
  }
  const chosen = usable[0]
  await session.commit({
    kind: 'grant',
    payload: {
      family: ID,
      label: chosen.label,
      source: 'client-import',
      externallyOwned: true,
      auth: { ...chosen.auth },
      createdAt: new Date().toISOString(),
    },
  })
  session.notify?.({ message: `已导入 ${chosen.label} 的登录态。` })
  return undefined
}

/**
 * 手动粘贴。
 *
 * 5.6+ 上这是**唯一**能真的走通的路（凭据是密文，本族不解），所以它必须在。
 * 区域要先问：国内与国际是两套网关，选错会一直 401，而用户从错误里看不出是选错了。
 */
async function runManualLogin(session) {
  const accessToken = String(await session.prompt({
    kind: 'secret',
    message: '粘贴 WorkBuddy 的 accessToken（桌面端登录文件里的 accessToken 字段）。',
  }) ?? '').trim()
  if (accessToken === '') {
    const error = new Error('workbuddy: 必须要有 accessToken 才能建这条记录')
    error.code = 'MISSING_CREDENTIAL'
    throw error
  }
  const refreshToken = String(await session.prompt({
    kind: 'secret',
    message: '粘贴 refreshToken（可选，直接留空表示没有；没有它就不能自动续期）。',
  }) ?? '').trim()
  const region = String(await session.prompt({
    kind: 'select',
    message: '这份令牌属于哪个区域？国内与国际是两套网关，选错会一直 401。',
    options: [
      { value: 'cn', label: '国内（copilot.tencent.com）' },
      { value: 'global', label: '国际（www.workbuddy.ai）' },
    ],
  }) ?? 'cn')
  const variant = region === 'global' ? 'global' : 'cn'
  await session.commit({
    kind: 'grant',
    payload: {
      family: ID,
      label: variant === 'global' ? 'WorkBuddy AI（国际版·手动）' : 'WorkBuddy（国内版·手动）',
      source: 'manual',
      externallyOwned: false,
      auth: {
        accessToken,
        ...(refreshToken === '' ? {} : { refreshToken }),
        // domain 是上游真正看的字段，手动粘贴时无从得知，所以留空、由 variant 兜底。
        variant,
      },
      createdAt: new Date().toISOString(),
    },
  })
  session.notify?.({ message: '已记录这条 WorkBuddy 凭据。' })
  return undefined
}
