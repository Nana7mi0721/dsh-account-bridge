/**
 * 上游身份：**成套的**身份头，以及**按账号分的**会话命名空间。
 *
 * ## 为什么需要「按账号分命名空间」
 *
 * 一个账号池里，同一段对话随时可能在账号 A 和账号 B 之间换号。如果发给上游的会话标识
 * 是**裸的对话 id**，那么上游看到的是「同一个会话标识，从两个不同的安装/账号打过来」——
 * 这正是风控最想找的形状。反过来，如果每换一次号就换一个全新的标识，上游的 prompt cache
 * 又会整段失效（我们付全量输入的钱）。
 *
 * 解法是把调用方的会话映射进**这个账号自己的命名空间**：
 *
 * - 对同一个账号，同一个会话永远得到同一个值 ⇒ 上游的缓存与分组照常工作；
 * - 对不同账号，同一个会话得到不同的值 ⇒ 一次对话的换号不会把两个账号连在一起。
 *
 * ## 为什么需要「成套」
 *
 * 身份不是一个头，是一组头加上请求体里的字段。混搭（例如身份用了 Claude Code 的 UA，
 * 却留着别的 SDK 的 `x-stainless-*` 指纹）比不伪装更显眼——上游看到的是一台
 * 「Claude Code 与某个 TypeScript SDK 同时装在一个进程里」的机器。所以身份要么整套铺上，
 * 要么一个都别铺，中间态由 `applyIdentityHeaders` 负责消灭。
 *
 * 借鉴 AstrLink `core/internal/accountauth/claude_identity.go`
 * （Apache-2.0, Copyright Calcium-Ion）。改动：命名空间由「服务 id」改为「族 + 本插件的账号 id」，
 * 因为我们的账号 id 才是稳定的、且是唯一能区分同一族内两个账号的东西。
 * 见 THIRD_PARTY_NOTICES.md。
 *
 * @module dsh-account-bridge/wire/identity
 */

import { createHash } from 'node:crypto'

/**
 * Claude Code 自 2.1.87 起发的会话头，值就是 `metadata.user_id` 里携带的那个会话。
 * 两个地方必须是**同一个值**，否则「成套」就破了。
 */
export const CLAUDE_CODE_SESSION_HEADER = 'x-claude-code-session-id'

/** 上游只看 UUID 形状；不是 UUID 的本地账号 id 不能当作 `account_uuid` 发出去。 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 一个账号的命名空间：族 + 账号 id。 */
export function accountNamespace(family, accountId) {
  return `${family}:${accountId}`
}

/**
 * 把一个调用方的会话映射进某个命名空间，得到一个 **UUIDv4 形状**的稳定别名。
 *
 * 为什么要摆成 UUIDv4：上游对这个字段有形状校验，随便一串 hex 会被当成畸形值。
 * 版本位（第 7 字节高 4 位 = 0100）与变体位（第 9 字节高 2 位 = 10）按 RFC 4122 置位，
 * 哈希本身仍然是 sha256 的前 16 字节。
 *
 * **同一个命名空间 + 同一个会话幂等**：这是它保住上游缓存的前提，也是测试里第一条断言。
 */
export function scopedSessionId(namespace, session) {
  const digest = createHash('sha256').update(`${namespace}::${session}`).digest()
  digest[6] = (digest[6] & 0x0f) | 0x40
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * 一个账号的**设备标识**：同一账号的多次调用看起来来自同一台安装，
 * 哪怕这台机器上其实有五个不同的调用方。
 *
 * 与账号绑定而不是与调用方绑定，是为了让上游的「一次安装」统计对得上——
 * 一个账号在多个客户端之间共享时，它仍然只呈现一个安装。
 */
export function deviceId(family, accountId) {
  return createHash('sha256').update(`device:dsh-account-bridge:${family}:${accountId}`).digest('hex')
}

/**
 * 「族 + 账号 + 会话」→ 上游可见的稳定标识。**各族要用同一个函数**，
 * 因为身份头、`metadata.user_id`、`prompt_cache_key` 三处必须是同一个值，
 * 否则「成套」就破了。
 *
 * 拿不到账号或会话时返回 `undefined`：这时**一个标识字段都别发**，
 * 也别退回去发裸会话 id —— 那比不发更糟。
 */
export function accountScopedSession(family, accountId, session) {
  if (typeof accountId !== 'string' || accountId.length === 0) return undefined
  if (typeof session !== 'string' || session.length === 0) return undefined
  return scopedSessionId(accountNamespace(family, accountId), session)
}

/**
 * `metadata.user_id` 的内容。
 *
 * Claude Code 2.1.78 起把旧的 `user_{device}_account_{uuid}_session_{id}` 换成了 JSON。
 * 两种形态都认，因为不同版本的客户端（以及不同版本的上游快照）会认不同的形状；
 * `legacy` 由调用方决定，我们默认发新的。
 *
 * `account_uuid` 必须是真 UUID，否则**发空串而不是省略这个键**：Claude Code 的这个字段
 * 不是可选的，少一个键比给一个空值更像伪造。（这一条是照 AstrLink 的实现来的，
 * 我们手上没有 Claude Code 的抓包来独立复核。）
 */
export function claudeMetadataUserId({ device, accountUuid, session, legacy = false }) {
  const uuid = isUuid(accountUuid) ? accountUuid.toLowerCase() : ''
  if (legacy) return `user_${device}_account_${uuid}_session_${session}`
  return JSON.stringify({ device_id: device, account_uuid: uuid, session_id: session })
}

/** 是不是 UUID 形状（`account_uuid` 的守门人）。 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

function findHeader(headers, name) {
  const wanted = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return key
  }
  return undefined
}

/**
 * 把身份**成套**地铺到请求头上（就地修改 `target` 并返回它）。
 *
 * 三步，顺序不能换：
 * 1. 删掉一切外来 SDK 的指纹（`x-stainless-*`）——身份要替换指纹，不是叠加指纹；
 * 2. 身份**没有**声明的、但同样构成指纹的头（`x-app`）一律删掉——避免「上半身 Claude Code、
 *    下半身别的 CLI」；
 * 3. 最后铺上身份自己的头。
 *
 * 我们自己手写请求头，理论上不会出现第 1 步要删的东西；这一步仍然是可执行、可测试的纪律，
 * 因为「将来有人引入一个 SDK 客户端」是迟早的事，而那时这个函数会让它**当场失效**而不是静默混搭。
 */
export function applyIdentityHeaders(target, identity = {}) {
  for (const key of Object.keys(target)) {
    if (/^x-stainless-/i.test(key)) delete target[key]
  }
  const claimed = new Set(Object.keys(identity).map((key) => key.toLowerCase()))
  for (const key of Object.keys(target)) {
    const lower = key.toLowerCase()
    if (lower === 'x-app' && !claimed.has('x-app')) delete target[key]
  }
  for (const [key, value] of Object.entries(identity)) {
    const existing = findHeader(target, key)
    if (existing !== undefined && existing !== key) delete target[existing]
    target[key] = value
  }
  return target
}
