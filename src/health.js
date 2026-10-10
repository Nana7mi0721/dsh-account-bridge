/**
 * 账号健康与冷却表。
 *
 * 设计来自两份成熟实现的共识：
 * - 失败要区分「罚账号 / 罚账号×模型 / 谁都不罚」，粒度是 `(族, 账号, 模型)`；
 * - 冷却要能解释（`lastWhy`），否则线上只能靠猜；
 * - 额度按模型分线的族（claude / antigravity），配额失败只停那一格。
 * @module dsh-account-bridge/health
 */

/** 这些族的额度是按模型分线的：配额耗尽只影响「该账号 × 该模型」。 */
export const MODEL_SCOPED_QUOTA_FAMILIES = new Set(['claude', 'antigravity'])

/** 默认冷却时长。 */
export const COOLDOWN = {
  /** 配额耗尽（非按模型分线时罚整个账号） */
  quota: 5 * 60_000,
  /** 凭据失效：等一天，多半需要用户重新登录 */
  auth: 24 * 60 * 60_000,
  /** 瞬时故障：一分钟 */
  transient: 60_000,
  /** 请求本身有问题（400） */
  badRequest: 0,
}

/**
 * 把一次失败归类成「换号 + 冷却多久 + 冷却谁」。
 *
 * @param {any} error 适配器抛出的错误（`code` 是 DSH 的 provider 中立码）
 * @param {string} family
 * @param {{status?: number}} [facts]
 * @returns {{action: 'switch'|'throw', reason: string, cooldownMs?: number, scope?: 'member'|'account'}}
 */
export function classifyFailure(error, family, facts = {}) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  const status = facts.status ?? error?.failure?.status ?? error?.status
  const retryAfterMs = error?.failure?.providerRetryAfterMs ?? error?.providerRetryAfterMs

  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || code === 'RATE_LIMIT') {
    return {
      action: 'switch',
      reason: code,
      cooldownMs: retryAfterMs ?? COOLDOWN.quota,
      scope: MODEL_SCOPED_QUOTA_FAMILIES.has(family) ? 'member' : 'account',
    }
  }
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL') {
    return { action: 'switch', reason: code, cooldownMs: COOLDOWN.auth, scope: 'account' }
  }
  // `NOT_AN_API_REPLY` 必须落在这里，而不是靠状态码。挡在中间的东西（Cloudflare 挑战页、
  // 网关登录页）常常回 403，而 403 在下面那条规则里等于 AUTH ⇒ 账号被冷 24 小时。
  // 「中间有个东西挡着」跟「这个账号的令牌废了」是两件事，前者换号就好、一分钟后再试。
  if (code === 'SERVER' || code === 'TIMEOUT' || code === 'EMPTY_RESPONSE' || code === 'NOT_AN_API_REPLY') {
    return { action: 'switch', reason: code, cooldownMs: COOLDOWN.transient, scope: 'member' }
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
    return { action: 'switch', reason: `HTTP_${status}`, cooldownMs: COOLDOWN.transient, scope: 'member' }
  }
  return { action: 'throw', reason: code ?? 'unknown' }
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
    const cooldownMs = verdict.cooldownMs ?? 0
    this.#lastWhy.set(memberKey(family, accountId, model), {
      reason: verdict.reason,
      at: now,
      cooldownMs,
      until: now + cooldownMs,
    })
    this.generation += 1
    if (cooldownMs <= 0) return 0
    const key = verdict.scope === 'member' ? memberKey(family, accountId, model) : accountKey(family, accountId)
    const previous = this.#entries.get(key)
    this.#entries.set(key, {
      until: now + cooldownMs,
      reason: verdict.reason,
      failures: (previous?.failures ?? 0) + 1,
    })
    return cooldownMs
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
      failures: entry.failures,
      blocked: entry.until > now,
      until: entry.until,
      remainingMs: Math.max(0, entry.until - now),
    }))
  }
}
