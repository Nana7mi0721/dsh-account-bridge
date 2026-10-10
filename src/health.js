/**
 * 账号健康与冷却表。
 *
 * 设计来自两份成熟实现的共识：
 * - 失败要区分「罚账号 / 罚账号×模型 / 谁都不罚」，粒度是 `(族, 账号, 模型)`；
 * - 冷却要能解释（`lastWhy`），否则线上只能靠猜；
 * - 额度按模型分线的族（claude / antigravity），配额失败只停那一格。
 *
 * 「停多久」这一半照抄 magpie（`internal/gateway/routing.go:88-133` 与 `rateRest`），
 * 来源、基线提交与四处改写见 `THIRD_PARTY_NOTICES.md` 的「借用的代码 → magpie」。
 * 因为它踩过我们还没踩的坑：
 * - **上游自己说的退避只信一小时**（`LONGEST_WAIT_MS`）。教训（magpie #147）：一个
 *   ChatGPT 账号的 `resets_at` 是 21:34，被当成 `Retry-After` 原样照做，于是它被试、
 *   被拒、又被停——三轮都没等到真正恢复的那一刻。
 * - **反复失败要退避**。固定 60 秒等于对着一台正在重启的服务器每秒敲一次；反过来，
 *   「一次请求自己的重试」也不该把退避拉长。
 * - **「余额不足」与「额度用尽」不是一回事**：前者要等有人充钱（半小时），后者等窗口
 *   自己滚回来（一刻钟）。Zhipu 的 GLM Coding Plan 用「余额不足或无可用资源包，请充值」
 *   回 429——只看状态码，那只是一次限流。
 * @module dsh-account-bridge/health
 */

import { failureWords } from './wire/failure-words.js'

// 词表住在 `wire/failure-words.js`：同一个 429 会同时经过这里（决定停哪个号、停多久）
// 与 `wire/http-error.js` 的 `mapStatus()`（决定宿主看得见的 `error.code`），
// 两份词表一定会漂移，而漂移的表现是「屏幕上写 RATE_LIMIT、账号却按余额不足冻了半小时」。
// 在这里再导出一次，是为了让 `../health.js` 的既有 import 与测试都不用改。
export { failureWords }

/** 这些族的额度是按模型分线的：配额耗尽只影响「该账号 × 该模型」。 */
export const MODEL_SCOPED_QUOTA_FAMILIES = new Set(['claude', 'antigravity'])

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** 上游说「过一会儿再来」时，最多信这么久（magpie `longestWait`）。 */
export const LONGEST_WAIT_MS = HOUR
/** 反复失败（非限流）的退避上限（magpie `longestRetry`）。 */
export const LONGEST_RETRY_MS = 10 * MINUTE
/** 限流退避的上限（magpie `longestRateRest`）。 */
export const LONGEST_RATE_REST_MS = 30 * MINUTE
/** 额度类冷却的上限（magpie `longestQuota`：「一周的窗口，再加一天」）。 */
export const LONGEST_QUOTA_MS = 8 * 24 * HOUR
/**
 * 上一次冷却结束之后多久之内又失败，算「同一次」而不是新的一次。
 *
 * 没有这个遗忘期，退避计数只会一路涨到上限：一个每天被限流一次的账号，第二天就从
 * 十分钟起步。magpie 的注释：「这么久之后才来的限流是新的一个，又是一分钟」。
 */
export const REST_FORGET_MS = 30 * MINUTE
/** 退避的基数：第一次失败等这么久（magpie `fallbackCooldown`）。 */
export const BACKOFF_BASE_MS = MINUTE

/** 各类失败**第一次**发生时停多久；反复发生时看 `CooldownTable` 的退避。 */
export const COOLDOWN = {
  /** 配额耗尽（非按模型分线时罚整个账号） */
  quota: 15 * MINUTE,
  /** 余额 / 账单问题：要等的是有人充钱，不是窗口 */
  credit: 30 * MINUTE,
  /** 限流：第一次一分钟，之后退避到 `LONGEST_RATE_REST_MS` */
  rate: MINUTE,
  /** 凭据失效：等一天，多半需要用户重新登录 */
  auth: 24 * 60 * MINUTE,
  /** 瞬时故障：一分钟起，之后退避到 `LONGEST_RETRY_MS` */
  transient: MINUTE,
  /** 请求本身有问题（400） */
  badRequest: 0,
}

/** 有限正数才裁，否则当作「没说」。 */
function clampWait(ms, max) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, max) : undefined
}


/**
 * 把一次失败归类成「换号 + 冷却多久 + 冷却谁」。
 *
 * 返回的 `cooldownMs` 是**第一次**失败的时长。带 `backoff` 的失败会被
 * `CooldownTable.record` 按「上一次停了多久」重新算，所以调用方不要自己乘。
 *
 * @param {any} error 适配器抛出的错误（`code` 是 DSH 的 provider 中立码）
 * @param {string} family
 * @param {{status?: number, body?: string}} [facts] `body` 是上游原文；缺省时读 `error.message`
 * @returns {{action: 'switch'|'throw', reason: string, cooldownMs?: number, scope?: 'member'|'account', backoff?: 'rate'|'transient', retryAfterMs?: number}}
 */
export function classifyFailure(error, family, facts = {}) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  const status = facts.status ?? error?.failure?.status ?? error?.status
  const retryAfterMs = error?.failure?.providerRetryAfterMs ?? error?.providerRetryAfterMs
  // 文本分流只能读 `error.message`：宿主的 `failureSnapshot()` 会校验 `error.failure`
  // 的字段集，往里加一个 `body` 会让**整份快照作废**（然后失败码全变 UNKNOWN）。
  const text = facts.body ?? error?.message ?? ''
  const scope = MODEL_SCOPED_QUOTA_FAMILIES.has(family) ? 'member' : 'account'

  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || code === 'RATE_LIMIT') {
    // 状态码只能说到「配额或限流」这一层；具体是没钱、额度用尽还是限流，得看它说了什么。
    const kind =
      failureWords(status, text) ??
      (code === 'ACCOUNT_QUOTA' ? 'credit' : code === 'QUOTA' ? 'quota' : 'rate')
    return restFor(kind, retryAfterMs, scope)
  }
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL') {
    return { action: 'switch', reason: code, cooldownMs: COOLDOWN.auth, scope: 'account' }
  }
  // `NOT_AN_API_REPLY` 必须落在这里，而不是靠状态码。挡在中间的东西（Cloudflare 挑战页、
  // 网关登录页）常常回 403，而 403 在下面那条规则里等于 AUTH ⇒ 账号被冷 24 小时。
  // 「中间有个东西挡着」跟「这个账号的令牌废了」是两件事，前者换号就好、一分钟后再试。
  if (code === 'SERVER' || code === 'TIMEOUT' || code === 'EMPTY_RESPONSE' || code === 'NOT_AN_API_REPLY') {
    // 一个 503 说「Rate limit exceeded」与一个 503 说「服务器炸了」该等的时间不一样，
    // 而状态码说不出这件事。只有 `SERVER` 允许被文本改写，而且**得有状态码**：
    // 连状态都没有的错误（线协议层的失败）说「慢一点」不算证据。
    // `NOT_AN_API_REPLY` 也不在其中——它是「中间有个东西挡着」，拦截页里恰好有 quota
    // 字样也不该去停账号。
    const said = code === 'SERVER' && status !== undefined ? failureWords(status, text) : undefined
    if (said !== undefined) return restFor(said, retryAfterMs, scope)
    return {
      action: 'switch',
      reason: code,
      cooldownMs: COOLDOWN.transient,
      backoff: 'transient',
      scope: 'member',
    }
  }
  if (code === 'TRANSPORT') {
    // 网络问题不代表账号有问题：换号但不记冷却
    return { action: 'switch', reason: 'TRANSPORT' }
  }
  if (status === 402 || status === 404) {
    // 同一订阅下别的账号可能还能服务这个模型
    return { action: 'switch', reason: `HTTP_${status}` }
  }
  if (code === 'CONTEXT_WINDOW_EXCEEDED' || status === 400 || status === 422) {
    // 请求本身的问题：换号也一样失败，且**不惩罚任何账号**
    return { action: 'throw', reason: code ?? `HTTP_${status}` }
  }
  if (status !== undefined && status >= 500) {
    return {
      action: 'switch',
      reason: `HTTP_${status}`,
      cooldownMs: COOLDOWN.transient,
      backoff: 'transient',
      scope: 'member',
    }
  }
  return { action: 'throw', reason: code ?? 'unknown' }
}

/** 一种「在说什么」→ 一条冷却裁决。 */
function restFor(kind, retryAfterMs, scope) {
  if (kind === 'credit') {
    // 没钱：停整个账号。等窗口没有意义——要等的是有人充钱。
    return { action: 'switch', reason: 'CREDIT', cooldownMs: COOLDOWN.credit, scope: 'account' }
  }
  if (kind === 'quota') {
    // 上游自己说了什么时候回来就听它的，但**只信一小时**，整体再裁到 `LONGEST_QUOTA_MS`。
    // 它没说就等一个窗口（`COOLDOWN.quota`）。
    const said = clampWait(retryAfterMs, LONGEST_WAIT_MS)
    return {
      action: 'switch',
      reason: 'QUOTA',
      cooldownMs: Math.min(said ?? COOLDOWN.quota, LONGEST_QUOTA_MS),
      scope,
    }
  }
  const said = clampWait(retryAfterMs, LONGEST_WAIT_MS)
  return {
    action: 'switch',
    reason: 'RATE_LIMIT',
    cooldownMs: COOLDOWN.rate,
    backoff: 'rate',
    ...(said === undefined ? {} : { retryAfterMs: said }),
    scope,
  }
}

/** 组装成员键与账号键。 */
export function memberKey(family, accountId, model) {
  return `${family}/${accountId}/${model}`
}
export function accountKey(family, accountId) {
  return `${family}/${accountId}/*`
}

/** 一张可解释的冷却表。 */
export class CooldownTable {
  /** @type {Map<string, {until: number, reason: string, failures: number}>} */
  #entries = new Map()
  /** @type {Map<string, {reason: string, at: number, cooldownMs: number, until: number}>} */
  #lastWhy = new Map()
  /** @type {number} 每次变更自增，用于让其它缓存失效 */
  generation = 0

  /** 该成员现在能不能用。 */
  available(family, accountId, model, now = Date.now()) {
    for (const key of [accountKey(family, accountId), memberKey(family, accountId, model)]) {
      const entry = this.#entries.get(key)
      if (entry && entry.until > now) return false
    }
    return true
  }

  /** 记一次失败，返回实际记录的冷却时长（0 表示没记）。 */
  record(family, accountId, model, verdict, now = Date.now()) {
    this.generation += 1
    const key = verdict.scope === 'member' ? memberKey(family, accountId, model) : accountKey(family, accountId)
    const rest = this.#rest(key, verdict, now)
    this.#lastWhy.set(memberKey(family, accountId, model), {
      reason: verdict.reason,
      at: now,
      cooldownMs: rest.ms,
      by: rest.by,
      until: now + rest.ms,
    })
    if (rest.ms <= 0) return 0
    this.#entries.set(key, {
      until: now + rest.ms,
      cooldownMs: rest.ms,
      reason: verdict.reason,
      backoff: verdict.backoff,
      by: rest.by,
      failures: rest.failures,
    })
    return rest.ms
  }

  /**
   * 这一次该停多久。
   *
   * 带 `backoff` 的失败（限流、以及反复发生的瞬时故障）要看**上一次**停到什么时候：
   * - 上一次的冷却还没结束就又失败 ⇒ 计数不动。magpie 的原文：「failing again while
   *   still resting — tried anyway, the last one left — keeps the count where it is,
   *   so one request's own retries don't stretch it」。少了这条，调用方重试三次就能把
   *   一个账号从一分钟停到八分钟。
   * - 冷却结束之后 `REST_FORGET_MS` 之内又失败 ⇒ 计数 +1，等 `base * 2^(n-1)`，各自有上限。
   * - 再久 ⇒ 这是一次新的失败，又从 `base` 开始。
   *
   * 限流还多一条：上游在头里说了时间（`Retry-After`）**且不短于**退避值时才听它的——
   * 比退避短的上游时间没有意义，退避是我们自己算出来的下限。
   */
  #rest(key, verdict, now) {
    const base = verdict.cooldownMs ?? 0
    const kind = verdict.backoff
    const previous = this.#entries.get(key)
    if (kind === undefined) {
      return { ms: base, by: 'policy', failures: (previous?.failures ?? 0) + 1 }
    }
    let n = 1
    if (previous?.backoff === kind) {
      const until = previous.until
      if (now < until) n = Math.max(previous.failures, 1)
      else if (now - until < REST_FORGET_MS) n = Math.max(previous.failures, 1) + 1
    }
    const upper = kind === 'rate' ? LONGEST_RATE_REST_MS : LONGEST_RETRY_MS
    let ms = Math.min(base * 2 ** Math.min(n - 1, 10), upper)
    let by = n > 1 ? 'backoff' : 'cooldown'
    const said = kind === 'rate' ? clampWait(verdict.retryAfterMs, LONGEST_WAIT_MS) : undefined
    if (said !== undefined && said >= ms) {
      ms = said
      by = 'retry-after'
    }
    return { ms, by, failures: n }
  }

  /** 记一次成功：清掉该成员与所属账号的冷却。 */
  clear(family, accountId, model) {
    this.#entries.delete(memberKey(family, accountId, model))
    this.#entries.delete(accountKey(family, accountId))
    this.generation += 1
  }

  /**
   * 手动解冻：清掉一个账号名下**所有**冷却——账号级的、以及每个模型分线的。
   *
   * `clear()` 需要一个确切的模型名，而人是记不住「上次是哪个模型把号烧了」的，
   * 所以 `/pool unfreeze` 需要一个按账号粒度的入口。传 `accountId` 为 undefined
   * 时清整族。
   *
   * 只删前缀匹配的键，不做别的：冷却表是纯内存的派生状态，删掉最坏的结果是
   * 下一次请求再撞一次同样的失败、再记一条冷却，不会让谁多花钱。
   */
  clearAccount(family, accountId) {
    // 键的形状是 `${family}/${accountId}/${model}`，账号级那条是 `${family}/${accountId}/*`。
    // 所以一个账号的前缀就是 `${family}/${accountId}/`——**不是** `${accountKey(...)}/`，
    // 后者会变成 `.../*/`，一个键都匹配不上（这个错法不会报错，只会静默地什么都不删）。
    const prefix = accountId === undefined ? `${family}/` : `${family}/${accountId}/`
    let removed = 0
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    if (removed > 0) this.generation += 1
    return removed
  }

  /** 为什么这个成员现在不可用（供 UI / 日志解释）。 */
  why(family, accountId, model, now = Date.now()) {
    const member = this.#entries.get(memberKey(family, accountId, model))
    if (member && member.until > now) return { scope: 'member', ...member }
    const account = this.#entries.get(accountKey(family, accountId))
    if (account && account.until > now) return { scope: 'account', ...account }
    return this.#lastWhy.get(memberKey(family, accountId, model))
  }

  /** 某个账号是不是被整号停用。 */
  accountBlocked(family, accountId, now = Date.now()) {
    const entry = this.#entries.get(accountKey(family, accountId))
    return Boolean(entry && entry.until > now)
  }

  /** 快照，供设置页展示。 */
  snapshot(now = Date.now()) {
    return [...this.#entries].map(([key, entry]) => ({
      key,
      reason: entry.reason,
      by: entry.by,
      failures: entry.failures,
      blocked: entry.until > now,
      until: entry.until,
      remainingMs: Math.max(0, entry.until - now),
    }))
  }
}
