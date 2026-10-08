/**
 * 登录中介：把 `ctx.authorization` 的一次尝试包装成「可被工具/UI 观察的状态机」。
 *
 * 为什么要这层：
 * - `begin()` 是**阻塞到用户完成登录**才 resolve 的，而工具调用不能一直挂着，
 *   所以要把「拿到 URL」和「登录完成」拆成两件事。
 * - 同一个 key 上同时只允许一次尝试，第二次是**拒绝**（`ALREADY_IN_FLIGHT`）而不是加入，
 *   所以谁在跑必须由我们自己记着。
 * - 尝试成功后，凭据落在 `<family>-login` 槽位里，要把它提升成正式账号。
 * @module dsh-account-bridge/login/broker
 */

/** 状态：'running' | 'authorized' | 'cancelled' | 'failed' */
export class LoginBroker {
  #authorization
  #store
  #log
  #attempts = new Map()

  constructor({ authorization, store, log }) {
    this.#authorization = authorization
    this.#store = store
    this.#log = log
  }

  /** 某个族当前的登录尝试快照（没有就返回 undefined）。 */
  snapshot(familyId) {
    const attempt = this.#attempts.get(familyId)
    if (!attempt) return undefined
    return {
      family: familyId,
      status: attempt.status,
      url: attempt.url,
      message: attempt.message,
      method: attempt.method,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      error: attempt.error,
      accountId: attempt.accountId,
    }
  }

  /** 所有族的登录快照。 */
  snapshots() {
    return [...this.#attempts.keys()].map((familyId) => this.snapshot(familyId))
  }

  /**
   * 开始一次登录。
   * @returns {Promise<object>} 拿到第一个通知（通常带 URL）后立即返回的快照。
   */
  async start(family, { method, signal } = {}) {
    const existing = this.#attempts.get(family.id)
    if (existing?.status === 'running') return this.snapshot(family.id)

    const key = this.#store.keyOf(this.#store.loginSlot(family.id))
    const attempt = {
      status: 'running',
      method,
      url: undefined,
      message: undefined,
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      error: undefined,
      accountId: undefined,
      notice: undefined,
    }
    this.#attempts.set(family.id, attempt)

    let wake
    const firstNotice = new Promise((resolve) => {
      wake = resolve
    })

    const methods = family.login?.methods ?? []
    const chosen = method ?? methods[0]?.id

    const interaction = {
      notify: (notice) => {
        if (!notice || typeof notice !== 'object') return
        attempt.message = notice.message
        if (typeof notice.url === 'string') attempt.url = notice.url
        if (notice.code !== undefined) attempt.code = notice.code
        wake?.(notice)
      },
      prompt: async (prompt) => {
        // 非交互路径下只能自动回答「无歧义」的选择题；其余一律明确报错，
        // 让调用方改走有界面的入口，而不是猜一个答案。
        if (prompt?.kind === 'select' && Array.isArray(prompt.options) && prompt.options.length === 1) {
          return String(prompt.options[0]?.value ?? prompt.options[0]?.id ?? '')
        }
        const error = new Error(
          `account-bridge: the "${family.id}" login flow needs an interactive prompt (${prompt?.kind ?? 'unknown'}: ${prompt?.message ?? ''}); start it from the settings UI instead`,
        )
        error.code = 'DECLINED'
        throw error
      },
    }

    const done = this.#authorization
      .begin({ key, method: chosen, interaction, signal })
      .then(async (outcome) => {
        if (outcome?.status !== 'authorized') {
          attempt.status = 'cancelled'
          attempt.finishedAt = new Date().toISOString()
          return
        }
        try {
          const accountId = await this.#store.promoteLoginSlot(family.id)
          attempt.status = 'authorized'
          attempt.accountId = accountId
          attempt.finishedAt = new Date().toISOString()
          this.#log?.info?.('account-bridge: %s login finished → %s', family.id, accountId)
        } catch (error) {
          attempt.status = 'failed'
          attempt.error = String(error?.message ?? error)
          attempt.finishedAt = new Date().toISOString()
          this.#log?.error?.('account-bridge: %s login committed but promotion failed: %s', family.id, attempt.error)
        }
      })
      .catch((error) => {
        attempt.status = error?.code === 'CANCELLED' || error?.code === 'DECLINED' ? 'cancelled' : 'failed'
        attempt.error = String(error?.message ?? error)
        attempt.finishedAt = new Date().toISOString()
        this.#log?.warn?.('account-bridge: %s login failed: %s', family.id, attempt.error)
      })

    attempt.done = done
    // 等第一个通知（多数 flow 在打开回环监听后马上发），但别把调用方吊死
    await Promise.race([firstNotice, new Promise((resolve) => setTimeout(resolve, 5_000))])
    return this.snapshot(family.id)
  }

  /** 取消某个族正在进行的登录。 */
  async cancel(familyId) {
    const attempt = this.#attempts.get(familyId)
    if (!attempt || attempt.status !== 'running') return false
    await this.#authorization.cancel(this.#store.keyOf(this.#store.loginSlot(familyId)))
    return true
  }

  /** 忘掉一次已结束的尝试（下次 start 才会重开）。 */
  reset(familyId) {
    const attempt = this.#attempts.get(familyId)
    if (attempt && attempt.status !== 'running') this.#attempts.delete(familyId)
  }
}
