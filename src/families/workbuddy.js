/**
 * WorkBuddy / CodeBuddy 族（腾讯）。
 *
 * 这一族服务的上游是腾讯这套桌面端与 IDE 共用的 OpenAI 兼容接口
 * （CN 区 `copilot.tencent.com/v2/chat/completions`，国际版 `www.workbuddy.ai`）。
 * 凭据来自本机客户端写下的登录文件，**只读借用，绝不写回**。
 *
 * **一族一地，一份代码**：WorkBuddy（`src/families/workbuddy.js` 的
 * `workbuddyFamily`）与 CodeBuddy（`src/families/buddy.js` 的 `buddyFamily`）
 * 是同一条线协议的两个产品变体，差异**只有**产品描述符与发现规则。所以这个文件
 * 导出的是工厂 `createBuddyFamily(spec)`，而不是把 700 行复制一份。
 * 先例是 `qoder` / `qodercn`，那是本仓早先按同样理由合并成一份的（见
 * `THIRD_PARTY_NOTICES.md`）。
 *
 * 三件容易走错的事，写在最前面：
 *
 * 1. **5.6+ 的凭据是密文**。桌面端把 token 用 AES-256-GCM 静态加密
 *    （`{$wbEncrypted:1, envelope}`，suite 恒为 1），密钥在 App 自己的 Electron
 *    进程里，要跑它自带的二进制才能取出来。本族**不去解**：与其假装能解、
 *    或者静默跳过让用户以为扫过了，不如如实报一条 `importable:false` 并写清原因，
 *    同时提供「手动粘贴令牌」这条真的能走通的路。
 * 2. **`User-Agent` 决定服务端下发哪一份模型目录**（见 `wire/workbuddy.js`），
 *    所以它不是可以随便改的装饰；而两个产品各有自己的 UA。
 * 3. **上游的额度和目录都可能读不懂**。读不懂时本族返回「未知」——
 *    `quota` 返回 `undefined`（面板上不显示额度条），目录抛错。
 *    报一个假的 0 比不报更糟。
 *
 * 事实来源：corrinehu/dsh-workbuddy-connect 0.7.1 的源码考古，行号随注释给出；
 * 产品变体与凭据域判据来自 dsh-codearts-auth（**证据**，不是代码），见台账。
 * 所有上游调用一律走 `ctx.fetch(url, init, payload.proxy, streaming)`
 * （契约 §5），流式请求第 4 个参数必须是 `true`。
 * @module dsh-account-bridge/families/workbuddy
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { CODEBUDDY_PRODUCT } from '../wire/buddy.js'
import { assertApiReply } from '../wire/assert-reply.js'
import { httpError } from '../wire/http-error.js'
import { toChatMessages, toChatSystem, toChatTools, translateChatStream } from '../wire/chat-completions.js'
import {
  DEFAULT_MAX_TOKENS,
  EFFORT_VALUES,
  ENTERPRISE_BILLING_URL,
  ID,
  WORKBUDDY_PRODUCT,
  billingHeaders,
  catalogDocument,
  catalogHeaders,
  chatHeaders,
  chatUrl,
  configUrl,
  createCatalogMemory,
  creditsUrl,
  envelopeError,
  isObject,
  modelInfo,
  normalizeChatBody,
  parseCreditAccounts,
  parseEnterpriseCredits,
  parseModelCatalog,
  personalCreditBody,
  prepareInternationalChatBody,
  readEnvelope,
  refreshHeaders,
  refreshUrl,
  regionOfProduct,
} from '../wire/workbuddy.js'
import { withSource } from '../util.js'
import { diagnosticReporter } from '../wire/diagnostics.js'

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

/**
 * 用户目录。
 *
 * `homeEnv` 是每个产品自己的逃生口（WorkBuddy: `WORKBUDDY_HOME`，
 * CodeBuddy: `CODEBUDDY_HOME`）：两个产品在同一台机器上共存时，用户可能只用
 * 环境变量指一个非常规安装位置，而**不该**因此把另一个产品也带偏。
 */
export function buddyHomeDir(env = process.env, homeEnv) {
  if (typeof homeEnv === 'string' && homeEnv !== '' && env?.[homeEnv]) return env[homeEnv]
  return env?.USERPROFILE || env?.HOME || homedir() || undefined
}

/** WorkBuddy 的用户目录（保留旧名字，本仓别处与文档都在用）。 */
export function workbuddyHomeDir(env = process.env) {
  return buddyHomeDir(env, 'WORKBUDDY_HOME')
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
export function authCandidates(variant, env = process.env, platform = process.platform, homeEnv) {
  const spec = typeof variant === 'string' ? VARIANTS.find((item) => item.id === variant) : variant
  if (spec === undefined) return []
  const out = []
  const explicit = env?.[spec.authFileEnv]
  if (typeof explicit === 'string' && explicit.trim() !== '') out.push(resolve(explicit.trim()))
  const home = buddyHomeDir(env, homeEnv)
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
  // 密文这一支也要把 `document` 带出去，**不是为了读令牌**（那几个字段在
  // `wrapped` 里，本来就是密文），而是因为 `auth.domain` 是**明文**的，
  // 而它正是判断「这份凭据属于哪个产品」的唯一判据（`documentDomain()`）。
  // 实测踩过：只回 `{format,wrapped}` 时 `documentDomain(undefined)` 得到空串，
  // 于是归属判定一律落空——本机那份属于 CodeBuddy 的凭据被 WorkBuddy 报成
  // 「密文，解不开」，而正确的话是「这是别家的，请到 CodeBuddy 导入」。
  // 带着它只是多挂一个引用，不会把它写进日志、回环响应或错误消息。
  return sawWrapped ? { format: 'encrypted', wrapped, document } : { format: 'plaintext', document }
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
 *
 * **拿不到内容时返回 `unreadable`，而不是「没有文件」**：这是本仓最贵的一条规矩
 * （`AGENTS.md`：「读不出来」不等于「没有」）。`ENOENT` 才是真的没有，
 * 权限、编码、被打断的写入都不是。
 */
async function readVariant(variant, env, platform, homeEnv) {
  let unreadable
  for (const path of authCandidates(variant, env, platform, homeEnv)) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT' && unreadable === undefined) unreadable = { variant, path, code: error?.code ?? 'UNKNOWN' }
      continue
    }
    const classified = classifyAuthDocument(text)
    if (classified.format === 'absent') continue
    return { variant, path, ...classified }
  }
  return unreadable
}

/** 装过 App 但没登录的痕迹：凭据目录存在。 */
async function untouchedDirectory(variant, env, platform, homeEnv) {
  for (const path of authCandidates(variant, env, platform, homeEnv)) {
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

// ---------------------------------------------------------------- 发现

/**
 * 从凭据文档里取出 `auth.domain`。
 *
 * 这个域**就是 token 的 `iss` 主机**（登录站 / 认证 realm），不是「安装目录」也不是
 * 文件名——文件名叫什么完全由客户端决定，本机实测两份都叫 `workbuddy-desktop.info`，
 * 一份属于 CodeBuddy 一份属于 WorkBuddy。所以归属只能看这个字段
 * （证据：`temp/codearts/src/product.ts:345-350` 明确写 `domain` = token 的 `iss` 主机）。
 */
export function documentDomain(document) {
  const auth = isObject(document?.auth) ? document.auth : (isObject(document) ? document : {})
  return typeof auth.domain === 'string' ? auth.domain.trim().toLowerCase() : ''
}

function domainMatches(domain, patterns) {
  if (domain === '') return false
  return patterns.some((pattern) => domain === pattern || domain.endsWith(`.${pattern}`))
}

/**
 * 工厂：一个腾讯系的族。
 *
 * @param {object} spec
 * @param {import('../wire/workbuddy.js').BuddyProduct} spec.product 产品描述符
 * @param {string} spec.displayName 界面上的名字
 * @param {string} spec.route `acct-*` 路由
 * @param {Array<object>} spec.variants 这个产品的凭据文件变体（CN/国际版）
 * @param {string} [spec.homeEnv] 覆盖用户目录的环境变量名
 * @param {string} [spec.noun] 错误消息里的产品名（默认取 `product.noun`）
 * @param {Array<{domains:string[],who:string,where:string}>} [spec.siblingOwnership]
 *   **别家**产品的独占 realm：命中的凭据照样报出来，但 `importable:false` 并说清它
 *   属于谁、该去哪一族导入（见下面 `domainOwner()` 的长注释）
 * @param {Array<object>} [spec.fallbackModels] 内置目录（首次读到远端目录前用）
 * @returns {import('./registry.js').Family}
 */
export function createBuddyFamily(spec) {
  const product = spec.product
  const id = product.id
  const noun = spec.noun ?? product.noun
  const displayName = spec.displayName
  const route = spec.route
  const variants = spec.variants
  const ownership = Array.isArray(spec.siblingOwnership) ? spec.siblingOwnership : []
  const catalog = createCatalogMemory()

  /**
   * 这条凭据是不是明显属于别家产品；是的话返回那一族的说明。
   *
   * 判据只有一条：**域**（= token 的 `iss` 主机 = 登录站 / 认证 realm，
   * `src/product.ts:345-350`）。三种情况：
   *
   * 1. 域在本产品自己的 `knownDomains` 里 ⇒ 本族收。
   * 2. 域是**两家共用**的（`copilot.tencent.com`：两个产品的 `knownDomains` 都含它，
   *    本机实测一份老 WorkBuddy 凭据的 realm 就是它）⇒ **本族也收**。
   *    一个域分不出两个产品时，本族宁可报「可导入」并让上游去 401，
   *    也不肯凭猜把一份真凭据判给别家。
   * 3. 域是别家的**独占**域（`*.workbuddy.ai` vs `*.codebuddy.cn`）⇒ 报出来、
   *    但 `importable:false`，并说清该去哪一族导入。判错了只是少一条可导入项，
   *    比「导入后每次请求都 401、用户以为插件坏了」便宜得多。
   */
  function domainOwner(domain) {
    if (domain === '') return undefined
    if (domainMatches(domain, product.knownDomains) || domainMatches(domain, spec.sharedDomains)) return undefined
    for (const sibling of ownership) {
      if (domainMatches(domain, sibling.domains)) return sibling
    }
    // 认不出来的域**保守保留**（照 codearts `src/product.ts:366-368` 的取舍）：
    // 误留的代价远小于误删，而且「未知」不是「别家」的证据。
    return undefined
  }

  function discoveredItem(variant, found) {
    const base = {
      family: id,
      sourcePath: found.path,
      label: variant.label,
      externallyOwned: true,
    }
    // 顺序有讲究：先判别家再判格式。一份属于别家、又恰好是密文的凭据，
    // 该说的话是「这是别的产品的凭据」，而不是「它的令牌是密文」。
    const domain = documentDomain(found.document)
    const sibling = domainOwner(domain)
    if (sibling !== undefined) {
      return {
        ...base,
        importable: false,
        reason: `${found.path} 里的登录域是 ${domain}，那是「${sibling.who}」的 realm。`
          + `本族收的是 ${product.knownDomains.join(' / ')}。要在本插件里用它，请到「${sibling.where}」导入。`,
      }
    }
    if (found.format === 'encrypted') {
      return {
        ...base,
        importable: false,
        reason: `${found.path} 里的令牌是 AES-256-GCM 密文（${noun} 5.6 起的静态加密，suite ${ENCRYPTED_SUITE}）。`
          + '密钥在客户端自己的进程里，本插件不会去解它，也不会假装解得开。'
          + '请改用这一族的「手动粘贴令牌」登录方式，或者在 5.6 之前的版本上登录后再导入。',
      }
    }
    if (found.format === 'unrecognized') {
      return {
        ...base,
        importable: false,
        reason: `${found.path} 不是认识的 ${noun} 登录文件：JSON 解不开，或者 accessToken/refreshToken 是解不开的包装。`
          + '如果客户端正在运行，登录写入可能只写了一半，稍后再试一次。',
      }
    }
    const auth = parseDesktopAuth(found.document, variant.id)
    if (auth.accessToken === '') {
      return {
        ...base,
        importable: false,
        reason: `${found.path} 里没有 accessToken——客户端跑过但没登录成功。先在 App 里登录一次再回来导入。`,
      }
    }
    return { ...base, label: labelFor(variant, auth), importable: true, auth }
  }

  /**
   * 扫描本机这个产品的登录文件（**只读**）。
   *
   * 五种结果都要报出来（契约 §4.4）：找不到就什么都不报；装过没登录、密文、
   * 格式不认识、别家的域这四种都报 `importable:false` 加一段能照着做的原因。
   * 静默跳过是最坏的一种——用户以为扫过了。
   *
   * `options.env` / `options.platform` 是测试与非常规安装的逃生口：
   * 插件在宿主里跑，而宿主的环境变量不一定是我们以为的那一套。
   */
  async function discover(ctx, options = {}) {
    const env = options.env ?? process.env
    const platform = options.platform ?? process.platform
    const out = []
    for (const variant of variants) {
      const found = await readVariant(variant, env, platform, spec.homeEnv)
      if (found === undefined) continue
      // 读不出来 ≠ 没有。没读到内容（权限、编码、半截写入）时不能沉默：
      // 沉默在这里的含义是「这台机器上没有这个产品的登录态」，而那是另一件事。
      if (found.document === undefined && found.format === undefined) {
        out.push({
          family: id,
          sourcePath: found.path,
          label: variant.label,
          importable: false,
          externallyOwned: true,
          reason: `${found.path} 存在但读不出来（${found.code}）。这不等于「没有登录态」——`
            + '请检查这个文件的权限，或者用这一族的「手动粘贴令牌」先建一条记录。',
        })
        continue
      }
      out.push(discoveredItem(variant, found))
    }
    if (out.length > 0) return out
    // 两个版本**共用同一个目录**，只有文件名不同（`src/variants.ts:106-164`），
    // 所以「目录在、文件不在」这条信号分不出是哪个版本——只报一次。
    // 报两次会让用户以为装了两份，而他能做的动作只有「去登录一次」。
    for (const variant of variants) {
      const dir = await untouchedDirectory(variant, env, platform, spec.homeEnv)
      if (dir === undefined) continue
      return [{
        family: id,
        sourcePath: dir,
        label: displayName,
        importable: false,
        externallyOwned: true,
        reason: `${dir} 在，但里面还没有登录文件——客户端跑过、没登录过。先在 App 里登录一次，再回来导入。`,
      }]
    }
    return []
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
        ?? `没有在本机找到 ${noun} 客户端的登录文件（CodeBuddyExtension/Data/Public/auth/）。`
          + '先安装并登录客户端，或者改用「手动粘贴令牌」。')
    }
    const chosen = usable[0]
    await session.commit({
      kind: 'grant',
      payload: {
        family: id,
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
   *
   * 区域**只在真的有两条产品线时才问**：CodeBuddy 中国版只有 CN 一条线，把
   * 「国内 / 国际」这个问题摆给它的用户，只会让人以为选错了会出问题。
   */
  async function runManualLogin(session) {
    const accessToken = String(await session.prompt({
      kind: 'secret',
      message: `粘贴 ${noun} 的 accessToken（客户端登录文件里的 accessToken 字段）。`,
    }) ?? '').trim()
    if (accessToken === '') {
      const error = new Error(`${id}: 必须要有 accessToken 才能建这条记录`)
      error.code = 'MISSING_CREDENTIAL'
      throw error
    }
    const refreshToken = String(await session.prompt({
      kind: 'secret',
      message: '粘贴 refreshToken（可选，直接留空表示没有；没有它就不能自动续期）。',
    }) ?? '').trim()
    let variant = variants[0]
    if (variants.length > 1) {
      const picked = String(await session.prompt({
        kind: 'select',
        message: '这份令牌属于哪个区域？国内与国际是两套网关，选错会一直 401。',
        options: [
          { value: 'cn', label: '国内（copilot.tencent.com）' },
          { value: 'global', label: '国际（www.workbuddy.ai）' },
        ],
      }) ?? 'cn')
      variant = variants.find((item) => item.id === picked) ?? variants[0]
    }
    await session.commit({
      kind: 'grant',
      payload: {
        family: id,
        label: `${variant.label} · 手动`,
        source: 'manual',
        externallyOwned: false,
        auth: {
          accessToken,
          ...(refreshToken === '' ? {} : { refreshToken }),
          // domain 是上游真正看的字段，手动粘贴时无从得知，所以留空、由 variant 兜底。
          variant: variant.id,
        },
        createdAt: new Date().toISOString(),
      },
    })
    session.notify?.({ message: `已记录这条 ${noun} 凭据。` })
    return undefined
  }

  // ---------------------------------------------------------------- 族对象

  /**
   * 区域：产品配置优先，凭据里的 `domain` 兜底（`src/upstream.ts:355-359`）。
   *
   * 手动粘贴进来的凭据没有 domain，这时退到用户在登录时选的那个版本——
   * 默认按国内走会把国际账号打到一个它不认识的网关上。
   */
  function regionOfAuth(auth) {
    if (auth?.variant === 'global') return 'global'
    // 产品只有一个区域时（CodeBuddy CN）就以它为准：这类产品根本没有国际网关，
    // 一个手滑写进来的域不该把它打到别处。
    if (variants.length === 1) return product.region
    const domain = typeof auth?.domain === 'string' ? auth.domain : ''
    if (domain !== '') return regionOfProduct(undefined, domain)
    return 'cn'
  }

  /**
   * **描述符只描述它自己那一区**，所以按区域取。
   *
   * 这条规则是踩出来的，不是想出来的：WorkBuddy 的描述符装的是 CN 那一套
   * （站点根 `copilot.tencent.com`、CN 的 CLI/App 形 UA、版本号 5.5.6），
   * 而国际版账号的站点根与 UA 是另一套（`www.workbuddy.ai`、`WorkBuddyAI/5.5.2`）。
   * 无脑把描述符传给头部函数，会把**国际版账号用 CN 的身份**发出去 ——
   * 拿改前的实现逐组对比过：CN 的 9 组头逐字相同，**国际版的 8 组全变**。
   *
   * 区域与描述符不一致时回落到老的 `region` 分支（`product` 传 `undefined`），
   * 那正是这条路径在引入产品描述符之前的行为。
   */
  function productFor(region) {
    return region === product.region ? product : undefined
  }

  /**
   * 推理档位。
   *
   * 只发上游词汇表里的五个值（`src/upstream.ts:192`）；`off` / `none` / 认不出来的
   * 值一律**不发这个字段**——上游对 `reasoning_effort` 的接受度按模型而异，
   * 发一个它不认的字面量会直接 400（codearts 用 `banana` 反面验过：确实 400），
   * 而不发只是少一个开关。
   */
  function normaliseEffort(effort) {
    const value = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
    return EFFORT_VALUES.includes(value) ? value : undefined
  }

  return {
    id,
    displayName,
    route,
    risk: 'high',

    discover,

    /** discover 的落盘入口。只有 `importable: true` 的条目会走到这里。 */
    recordFromDiscovery(item) {
      const auth = item?.auth
      if (typeof auth?.accessToken !== 'string' || auth.accessToken === '') {
        const error = new Error(`${id}: discovered entries carry no usable access token`)
        error.code = 'MISSING_CREDENTIAL'
        throw error
      }
      return withSource({
        family: id,
        label: item.label ?? displayName,
        source: 'client-import',
        externallyOwned: true,
        auth: { ...auth },
        createdAt: new Date().toISOString(),
      }, item)
    },

    login: {
      methods: [
        { id: 'import', label: `导入本机 ${noun} 客户端登录态` },
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

    /**
     * 用 refreshToken 换新的 accessToken。
     *
     * 纯 HTTPS，不需要客户端在线。**返回的是新的 `auth` 对象**（契约 §3.2），
     * 池子会浅合并进原记录，所以会变的键（`accessToken` / `refreshToken` /
     * `expiresAt` / `domain`）必须显式带上；不变的键一起带回来是为了让这个函数
     * 的返回值自洽（别指望调用方替你补）。
     *
     * 池子传进来的 `signal` **恒为 `undefined`**，所以不能假设它存在。
     */
    async refresh(ctx, payload, signal) {
      const auth = payload?.auth ?? {}
      const refreshToken = typeof auth.refreshToken === 'string' ? auth.refreshToken : ''
      if (refreshToken === '') {
        const error = new Error(`${id}: 这条记录里没有 refreshToken，无法自动续期——请在客户端重新登录后导入`)
        error.code = 'AUTH'
        throw error
      }
      const region = regionOfAuth(auth)
      // 非流式请求：第 4 个参数（streaming）不传（契约 §5）。
      const response = await ctx.fetch(refreshUrl(region), {
        method: 'POST',
        headers: refreshHeaders(auth, region, productFor(region)),
        signal,
      }, payload?.proxy)
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response, envelope, id)
      const data = isObject(envelope.data) ? envelope.data : {}
      const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
      if (accessToken === '') {
        const error = new Error(`${id}: 刷新响应里没有 accessToken，请到客户端重新登录后再导入`)
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
        variant: auth.variant ?? variants[0].id,
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
        headers: catalogHeaders(auth, region, productFor(region)),
        signal,
      }, payload?.proxy)
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response, envelope, id)
      const models = parseModelCatalog(catalogDocument(envelope), { international: region === 'global' })
      catalog.remember(models)
      return models.map((model) => modelInfo(model, route))
    },

    /**
     * 元数据来自最近一次成功读到的目录；没读到就用内置的那份快照兜底。
     *
     * `fallbackModels` 是**快照**不是权威：上游花名册一周内会换好几次
     * （`auto`、`minimax-m3` 都出现过又消失），所以远端一到就以远端为准，
     * 这份表只在「第一次读目录还没成功」时让设置页里有东西可看。
     * 没有 `fallbackModels` 的族（WorkBuddy）**刻意不内置清单**——
     * 写死一份等于教用户去选已经下架的模型。
     */
    resolveModel(provider, model) {
      const known = catalog.get(model)
      if (known !== undefined) return modelInfo(known, provider)
      const snapshot = Array.isArray(spec.fallbackModels) ? spec.fallbackModels.find((item) => item.id === model) : undefined
      return modelInfo(snapshot ?? { id: model, name: model }, provider)
    },

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
          warn(ctx, `account-bridge: ${id} 额度响应里没有 Accounts 数组，这次不显示额度条（不是 0）`)
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
        warn(ctx, `account-bridge: ${id} 额度查询失败（${error?.message ?? error}），这次不显示额度条`)
        return undefined
      }
    },

    /**
     * 一次对话。
     *
     * 请求体过 `normalizeChatBody`（强制 stream、`developer`→`system`、
     * `tool_choice` 字符串化），国际版再过一层 `prepareInternationalChatBody`
     * （补 system 头、删 `reasoning_effort: 'off'`）。
     *
     * `stream()` 里**只发一次上游请求**：契约 §5 要求这一次是流式的
     * （原先有一条用例断言「最后一次 `ctx.fetch` 必须是流式」，已随单元测试删除），
     * 中间插一个探测请求会把这件事打破。
     */
    async *stream(ctx, options) {
      const { payload, model, messages = [], tools = [], effort, system, maxTokens, signal } = options ?? {}
      const auth = payload?.auth ?? {}
      // 令牌缺失时**照样发这一次请求**，让上游给 401，而不是在这里先抛。
      // 理由有两条：一是别的族都是这么做的（`generic.js` 直接拼 `Bearer ${apiKey}`），
      // 二是「这一次调用是流式的」本身就是要验的东西——提前抛等于一次调用都没有。
      const region = regionOfAuth(auth)

      const systemText = toChatSystem(system, messages)
      const onDiagnostic = diagnosticReporter(ctx, options.onDiagnostic)
      const chatMessages = toChatMessages(messages, { onDiagnostic })
      const declared = catalog.get(model)
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
        headers: chatHeaders(auth, region, productFor(region)),
        body: region === 'global' ? prepareInternationalChatBody(raw) : normalizeChatBody(raw),
        signal,
      }, payload?.proxy, true)
      // 200 也可能是网页（Cloudflare 挑战页、登录页、空 body）：先确认它像 API 回复。
      const reply = await assertApiReply(response, { who: id })
      if (!reply.ok) throw httpError(reply, await reply.text().catch(() => ''), id)

      yield* translateChatStream(reply, { signal, onDiagnostic })
    },
  }
}

function clampFraction(value) {
  if (!Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** WorkBuddy 族：产品是 CN 桌面端 + 国际版 AI 桌面端。 */
export const workbuddyFamily = createBuddyFamily({
  product: WORKBUDDY_PRODUCT,
  noun: 'WorkBuddy',
  displayName: DISPLAY_NAME,
  route: ROUTE,
  variants: VARIANTS,
  homeEnv: 'WORKBUDDY_HOME',
  // 两家的域表要**合并着看**才算得对：CodeBuddy 的 knownDomains 里有
  // `copilot.tencent.com`，而这个文件自己的有两个版本变体、按文件名分，
  // 光看本产品那一份会得出「copilot.tencent.com 是本族的独占域」——错了，
  // 它是两家共用的（本机实测一份老 WorkBuddy 凭据的 realm 就是它）。
  // 这里必须**逐条点名**「两家共用」的域，不能图省事写成
  // `[...WORKBUDDY_PRODUCT.knownDomains, ...CODEBUDDY_PRODUCT.knownDomains]`：
  // 那样写等于把 CodeBuddy 的独占域（`www.codebuddy.cn`）也算成本族该收的，
  // 于是 `domainOwner()` 的第一条判定先命中、`siblingOwnership` 永远轮不到，
  // 本机那份 CodeBuddy 凭据就被本族报成了「密文，解不开」而不是「这是别家的」。
  // 实测踩过一次：错话听着比沉默更像回事，用户会以为 WorkBuddy 能解它。
  sharedDomains: ['copilot.tencent.com'],
  // `codebuddy.cn` 与 `www.codebuddy.cn` 两条都要写：后缀匹配要的是 `.<模式>`，
  // 所以 `www.codebuddy.cn` 不会被 `codebuddy.cn` 命中——只写一条会漏掉本机
  // 实测那一份（它的 realm 正是 `www.codebuddy.cn`）。
  siblingOwnership: [
    { domains: ['codebuddy.cn', 'www.codebuddy.cn'], who: 'CodeBuddy（腾讯）', where: 'CodeBuddy（腾讯）' },
  ],
})
