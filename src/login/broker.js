/**
 * 登录中介：把 `ctx.authorization` 的一次尝试包装成「可被工具/UI 观察的状态机」。
 *
 * 为什么要这层：
 * - `begin()` 是**阻塞到用户完成登录**才 resolve 的，而工具调用不能一直挂着，
 *   所以要把「拿到 URL」和「登录完成」拆成两件事。
 * - 同一个 key 上同时只允许一次尝试，第二次是**拒绝**（`ALREADY_IN_FLIGHT`）而不是加入，
 *   所以谁在跑必须由我们自己记着。
 * - 尝试成功后，凭据落在 `<family>-login` 槽位里，要把它提升成正式账号。
 *
 * 「交互式」是**入口**的属性，不是族的属性：面板打开的那次登录有人可以问，
 * 工具与命令行打开的那次没有。所以 `prompt` 的行为取决于 `start({interactive})`：
 * 无界面时只能自动回答无歧义的单选项，其余明确报 `DECLINED`（让调用方看见
 * 「这条登录需要人回答，去设置界面做」），有界面时把问题挂起、等 `answer()`。
 * @module dsh-account-bridge/login/broker
 */

/**
 * 一个问题最多等多久。等到超时也只是把这一次尝试收干净（回一个 DECLINED），
 * 不会牵连别的族：面板关掉了、人走开了，都不该留一个永远挂着的 promise。
 */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 选项归一：族的 `options` 有两种形状——`{value,label}`（全部族都用这种，
 * 值是下标字符串或语义值）与裸字符串。取错形状会得到一个**字面量 `"undefined"`**
 * 当作答案交给族，那比报错难查得多。
 */
function optionValue(option) {
  if (option !== null && typeof option === 'object') return String(option.value ?? option.id ?? '')
  return String(option ?? '')
}

/** 选项给人看的文字（没有就退回它的值）。 */
function optionLabel(option, value) {
  if (option !== null && typeof option === 'object') return String(option.label ?? option.title ?? value)
  return value
}

/**
 * 把一个问题挂到这次尝试上，等 `answer()`。族是顺序提问的，所以同时只会有一个。
 * 超时与「尝试提前结束」都只收掉这**一个问题**，不会假装有了一个答案。
 * @returns {Promise<string>} 人的回答。
 */
function ask(attempt, family, prompt) {
  const options = Array.isArray(prompt?.options)
    ? prompt.options.map((option) => {
        const value = optionValue(option)
        return { value, label: optionLabel(option, value) }
      })
    : undefined
  return new Promise((resolve, reject) => {
    const kind = prompt?.kind === 'select' ? 'select' : prompt?.kind === 'secret' ? 'secret' : 'text'
    const pending = {
      kind,
      message: String(prompt?.message ?? ''),
      options,
      secret: kind === 'secret',
      settle: undefined,
    }
    const timer = setTimeout(() => {
      const error = new Error(
        `account-bridge: the "${family.id}" login question wasn't answered within ${Math.round(PROMPT_TIMEOUT_MS / 60_000)} minutes (${kind}: ${pending.message})`,
      )
      error.code = 'CANCELLED'
      pending.settle?.reject(error)
    }, PROMPT_TIMEOUT_MS)
    // 别让一个没人回答的问题把（无头跑测试的）进程吊住。
    if (typeof timer.unref === 'function') timer.unref()
    pending.settle = {
      resolve: (value) => {
        clearTimeout(timer)
        if (attempt.prompt === pending) attempt.prompt = undefined
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        if (attempt.prompt === pending) attempt.prompt = undefined
        reject(error)
      },
    }
    attempt.prompt = pending
  })
}

/** 这次尝试结束了：把还挂着的问题收掉，别让族等一个不会来的回答。 */
function abandonPrompt(attempt) {
  const settle = attempt?.prompt?.settle
  if (!settle) return
  const error = new Error('account-bridge: the login attempt ended while a question was pending')
  error.code = 'CANCELLED'
  settle.reject(error)
}

/** 状态：'running' | 'authorized' | 'cancelled' | 'failed' */
export class LoginBroker {  #authorization
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
      // 有界面时：族正等着人回答的问题。放的是**问题**，不是已经答过的内容。
      prompt: attempt.prompt,
    }
  }

  /** 所有族的登录快照。 */
  snapshots() {
    return [...this.#attempts.keys()].map((familyId) => this.snapshot(familyId))
  }

  /**
   * 开始一次登录。
   * @param {object} family 族定义。
   * @param {object} [options]
   * @param {string} [options.method] 指定的登录方式 id。
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.interactive] 这个入口能不能替人回答问题（面板能，工具不能）。
   * @returns {Promise<object>} 拿到第一个通知（通常带 URL）后立即返回的快照。
   */
  async start(family, { method, signal, interactive = false } = {}) {
    const existing = this.#attempts.get(family.id)
    if (existing?.status === 'running') return this.snapshot(family.id)

    const key = this.#store.keyOf(this.#store.loginSlot(family.id))
    const attempt = {
      status: 'running',
      method,
      url: undefined,
      message: undefined,
      prompt: undefined,
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
        // 无歧义的选择题在哪个入口都能自动回答：只有一个选项，问等于没问。
        // （`options` 的元素有两种形状——`{value,label}` 与裸字符串，都要认。）
        if (prompt?.kind === 'select' && Array.isArray(prompt.options) && prompt.options.length === 1) {
          return optionValue(prompt.options[0])
        }
        if (!interactive) {
          // 工具与命令行没有地方回答。明确报错让调用方看见「这条登录需要人回答」，
          // 而不是猜一个答案——猜错会以一个假账号的形式留在池子里。
          const error = new Error(
            `account-bridge: the "${family.id}" login flow needs an interactive prompt (${prompt?.kind ?? 'unknown'}: ${prompt?.message ?? ''}); start it from the settings UI instead`,
          )
          error.code = 'DECLINED'
          throw error
        }
        return await ask(attempt, family, prompt)
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
      // 无论走哪条路结束，都不留一个没人回答的问题；顺便唤醒还在等第一个通知的调用方
      // ——否则「一开始就失败」的登录（例如工具入口撞上要人回答的问题）会让它干等到
      // 5 秒的超时才拿到一个早就该知道的结论。
      .finally(() => {
        abandonPrompt(attempt)
        wake?.()
      })

    attempt.done = done
    // 等第一个通知（多数 flow 在打开回环监听后马上发），但别把调用方吊死
    await Promise.race([firstNotice, new Promise((resolve) => setTimeout(resolve, 5_000))])
    return this.snapshot(family.id)
  }

  /**
   * 回答当前挂着的问题。
   * @param {string} familyId 族 id。
   * @param {string} value 人的回答（选择题给的是选项的 `value`）。
   * @returns {boolean} 真有一个问题在等才返回 true——面板据此区分「答上了」与「问题已经没了」。
   */
  answer(familyId, value) {
    const settle = this.#attempts.get(familyId)?.prompt?.settle
    if (!settle) return false
    settle.resolve(typeof value === 'string' ? value : String(value ?? ''))
    return true
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
    if (attempt && attempt.status !== 'running') {
      abandonPrompt(attempt)
      this.#attempts.delete(familyId)
    }
  }
}
