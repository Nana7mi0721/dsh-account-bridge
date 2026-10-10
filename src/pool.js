/**
 * 账号池适配器：对外是一个 DSH 的 LlmAdapter，对内是「一族多账号」的调度器。
 *
 * 三条从成熟实现里学来的硬规则（都写在代码里，别随手改）：
 * 1. **流式 failover 只在「一个字都没吐出去」时做**。block-start 不算输出，
 *    block-end 带 text/id/arguments 才算，usage/finish 不算。为了能做到这件事，
 *    首个实质内容之前的所有 chunk 都要先缓冲。
 *    **但「思考」也不算输出**，且缓冲不能无限等下去——三个上限见 `HOLD_LONGEST_MS`
 *    那一组的注释。
 * 2. **粘性会话是刚需**：同一个会话尽量钉在同一个账号上，否则上游的 prompt cache
 *    每轮都失效。TTL + 上限，auth 变更时清空。
 * 3. **选择器是各账号目录的并集**：多个账号都有的模型可以互相 failover，
 *    只有一个账号有的模型就钉死在那个账号上。
 * @module dsh-account-bridge/pool
 */

import { accountKey, classifyFailure, memberKey } from './health.js'
import { redact } from './util.js'

/** 池装配的缓存时长：`owns()` 每次选模型都会跑，而装配要碰目录与账号存储。 */
const POOL_CACHE_TTL_MS = 5_000
/** 单账号模型目录的缓存时长。 */
const CATALOG_TTL_MS = 10 * 60_000
/** 粘性会话表的上限与 TTL。 */
const STICKY_LIMIT = 1000
const STICKY_TTL_MS = 30 * 60_000

/*
 * 换号窗口的三个上限（语义照 magpie `internal/gateway/fallback.go` 的
 * `holdLongest` / `holdMost` / `holdThinking`，MIT，见 THIRD_PARTY_NOTICES.md）。
 *
 * 要解决的问题：Claude 会在想了 10–25 秒之后用安全策略**拒绝整轮**（issue #248
 * 的现场）。如果我们一看到 `reasoning-delta` 就认为「已经输出了、不能再换号了」，
 * 用户吃到的就是那条拒绝，而**下一个账号从来没被问过**。所以「思考」不算输出。
 *
 * 但也不能无限憋着：
 * - 一个 chunk 都没有时最多等 `HOLD_LONGEST_MS`；
 * - 手里**只有思考**、且这家会在思考之后拒绝整轮时，给到 `HOLD_THINKING_MS`；
 * - 手里只有思考、而这家不会因为思考就拒绝（GLM / DeepSeek / MiniMax…）时**立刻放行**——
 *   magpie 的注释记着实际后果：憋着会让这些家的思考在正文开始时**一次性吐出来**；
 * - 缓冲超过 `HOLD_MOST_BYTES` 就先放行，免得一个疯狂输出的上游把内存吃光。
 *
 * **到期一律「原样放行」（commit + 把缓冲按原顺序吐出去），不是丢弃。** 一个字都没
 * 吐出去的时候抛 `EMPTY_RESPONSE` 换号（那条路依然完好）；放过之后就不能再换号了。
 *
 * **这里没有「保活」**：不是忘写。magpie 要发保活是因为它自己写 HTTP 响应头，
 * 而 Codex 等客户端会等流上的下一个事件 300 秒。我们是**进程内的 adapter**，
 * 上面没有一层可以写 SSE 注释的地方，宿主自己也**没有流空闲超时**（`dsh-llm` 全文
 * grep `idle|stall|keepalive` 零命中）——没有任何东西在给我们计时。
 */
const HOLD_LONGEST_MS = 15_000
const HOLD_THINKING_MS = 4 * 60_000
const HOLD_MOST_BYTES = 1 << 20

/**
 * 三个上限的默认值，可在构造适配器时覆盖（慢上游可以把窗口调长）。
 * @type {{longestMs: number, thinkingMs: number, mostBytes: number}}
 */
export const HOLD_DEFAULTS = {
  longestMs: HOLD_LONGEST_MS,
  thinkingMs: HOLD_THINKING_MS,
  mostBytes: HOLD_MOST_BYTES,
}

/** 只有一个 `setTimeout` 的「到期」信号；拿到结果后必须 `cancel()`。 */
function deadline(ms) {
  let timer
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), ms)
    // 忘掉 cancel 也不该让进程吊着（测试里最容易踩）。
    if (typeof timer.unref === 'function') timer.unref()
  })
  return { promise, cancel: () => clearTimeout(timer) }
}
const DEADLINE = Symbol('hold deadline')

/**
 * 这家厂商会不会「想完之后拒绝整轮」——决定「手里只有思考」时给不给它时间。
 *
 * 判据照 magpie 的 `refusesAfterThinking`：Claude 系与 GPT 系 true，模型名去掉最后
 * 一段 `/` 之后以 `gemini` 开头 true，**其余 false**。别家不能憋（magpie 的注释：
 * 憋着会让 GLM 这类家的思考在正文开始时一次性吐出来），所以我们宁可按模型名判、
 * 也不按族一刀切——`generic` / `copilot` / `trae` 一个族里什么模型都有。
 *
 * 族可以在自己身上覆盖它（`family.refusesAfterThinking?.(model)`）。
 *
 * @param {{id?: string, refusesAfterThinking?: (model: string) => boolean}} family
 * @param {string} model
 * @returns {boolean}
 */
export function refusesAfterThinking(family, model) {
  if (typeof family?.refusesAfterThinking === 'function') return Boolean(family.refusesAfterThinking(model))
  const name = String(model ?? '').toLowerCase()
  // `provider/model` 两段形态（generic 族常见）只看最后一段，与 magpie 一致。
  const tail = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  if (tail.startsWith('gemini') || tail.startsWith('claude') || tail.startsWith('gpt')) return true
  // `o1` / `o3-mini` / `o4` 这些也是 GPT 系，但它们不以 `gpt` 开头。
  if (/^o[1-9](?:-|$)/.test(tail)) return true
  // 模型名认不出来时退回族：这两族只有一家的模型，不会判错。
  return family?.id === 'codex' || family?.id === 'claude'
}

/** 账号池适配器（鸭子类型满足 DSH 的 LlmAdapter 契约，无需继承）。 */
export class AccountBridgeAdapter {
  #ctx
  #store
  #health
  #families
  #log
  #catalogs = new Map()
  #pools = new Map()
  #sticky = new Map()
  #inflightRefresh = new Map()
  #hold

  constructor({ ctx, store, health, families, log, hold }) {
    this.#ctx = ctx
    this.#store = store
    this.#health = health
    this.#families = families
    this.#log = log
    this.#hold = { ...HOLD_DEFAULTS, ...(hold ?? {}) }
  }

  /** 本适配器占用的 provider route 列表。 */
  providers() {
    return this.#families.map((family) => family.route)
  }

  /** 路由 → 族。 */
  familyOf(provider) {
    const family = this.#families.find((item) => item.route === provider)
    if (!family) throw new Error(`account-bridge: unknown provider route "${provider}"`)
    return family
  }

  providerInfo(provider) {
    const family = this.familyOf(provider)
    return { id: provider, name: family.displayName }
  }

  /**
   * `registerAdapter` 会**无条件**调用它（`?? resolveRetryPolicy(...)` 只兜住返回值，
   * 兜不住「方法不存在」），缺了它注册当场抛 `adapter.providerRetryPolicy is not a function`。
   * 返回 undefined = 用宿主默认策略（5 次重试、500ms 起、上限 10s、抖动 0.1）。
   */
  providerRetryPolicy(_provider) {
    return undefined
  }

  /**
   * 同步、无 I/O 的图片计价钩子；基类同样返回 undefined。
   * 本插件的族目前不提供图片计价，如实返回 undefined 而不是编一个数。
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * 模型选择器 = 所有账号目录的并集。
   * 缓存 5 秒；账号或健康状态一变就作废。
   */
  async listModels(provider, signal) {
    const family = this.familyOf(provider)
    const pool = await this.#pool(family, signal)
    return pool.models
  }

  async resolveModel(provider, model, signal) {
    const family = this.familyOf(provider)
    const resolved = family.resolveModel
      ? await family.resolveModel(provider, model, signal)
      : { provider, id: model, name: model }
    return { ...resolved, provider, id: model }
  }

  /**
   * 适配器入口：dsh-llm ≥0.1.1-rc.2 会**无条件**调用它，
   * 不实现就会当场报 `registration.adapter.prepareCall is not a function`。
   */
  async prepareCall(provider, model, signal) {
    const family = this.familyOf(provider)
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: (options) => this.stream({ ...options, provider, model, family }),
    }
  }

  /** 直接实现 stream，便于 `prepareCall` 之外的调用方（测试）使用。 */
  stream(options) {
    const family = options.family ?? this.familyOf(options.provider)
    return this.#streamWithPool(family, options)
  }

  // -------------------------------------------------------------- 池装配

  /** 装配（或复用）一族的账号池。 */
  async #pool(family, signal) {
    const key = family.id
    const cached = this.#pools.get(key)
    const now = Date.now()
    if (cached && now - cached.at < POOL_CACHE_TTL_MS && cached.generation === this.#health.generation) {
      return cached.value
    }
    const accounts = (await this.#store.list(family.id)).filter((account) => account.disabled !== true)
    const entries = []
    for (const account of accounts) {
      let models = []
      try {
        models = await this.#catalog(family, account, signal)
      } catch (error) {
        this.#log?.warn?.('account-bridge: catalog for %s failed: %s', account.id, redact(String(error?.message ?? error)))
      }
      for (const model of models) {
        entries.push({ account, modelId: model.id, model })
      }
    }
    const models = []
    const seen = new Set()
    for (const entry of entries) {
      if (seen.has(entry.modelId)) continue
      seen.add(entry.modelId)
      models.push({ ...entry.model, provider: family.route, id: entry.modelId })
    }
    const value = { family, accounts, entries, models }
    this.#pools.set(key, { at: now, value, generation: this.#health.generation })
    return value
  }

  /** 单账号的模型目录（带缓存，失败回退到上一次成功的快照）。 */
  async #catalog(family, account, signal) {
    const key = `${family.id}/${account.id}`
    const cached = this.#catalogs.get(key)
    const now = Date.now()
    if (cached && now - cached.at < CATALOG_TTL_MS) return cached.models
    const payload = await this.#freshPayload(family, account)
    try {
      const models = (await family.listModels(this.#ctx, payload, signal)) ?? []
      this.#catalogs.set(key, { at: now, models })
      return models
    } catch (error) {
      // 目录拉不到时用旧快照，绝不把整族模型弄消失
      if (cached) return cached.models
      throw error
    }
  }

  /** 需要时先刷新凭据再返回 payload。 */
  async #freshPayload(family, account) {
    if (!family.needsRefresh?.(account)) return account
    return this.refreshAccount(family, account.id)
  }

  /**
   * 刷新一个账号的凭据。
   * **同一账号的并发刷新必须合并到同一个 in-flight promise 上**：
   * refresh token 是一次性轮换的，两次并发刷新会让后到的那次拿着已作废的 token 失败，
   * 严重时直接把账号踢下线。`modifyRecord` 的文件锁只解决跨进程，解决不了同进程并发。
   */
  async refreshAccount(family, accountId) {
    const key = accountKey(family.id, accountId)
    const existing = this.#inflightRefresh.get(key)
    if (existing) return existing
    const task = (async () => {
      const account = await this.#store.read(accountId)
      if (!account) throw new Error(`account-bridge: account "${accountId}" disappeared during refresh`)

      // 冷却中的账号不再重试刷新。目录没有「失败缓存」，所以没有这道闸的话，
      // 一条已经作废的刷新令牌会被**每一次** listModels 重新拿去打上游。
      // 冷却时长沿用健康表里那套（AUTH 24h / QUOTA 5min / 其余 60s），与请求路径一致。
      const cooling = this.#health.why(family.id, accountId, '*')
      if (cooling && cooling.until > Date.now()) {
        const error = new Error(`account-bridge: ${accountId} is cooling down (${cooling.reason})`)
        error.code = 'COOLING'
        throw error
      }

      let auth
      try {
        auth = await family.refresh(this.#ctx, account, undefined)
      } catch (error) {
        // 刷新失败也要记进冷却表，否则会连着出两个错：
        // ① `account_bridge_accounts` 说这个账号「健康」，而它的模型一个都列不出来
        //    （目录是靠刷新后的 payload 去拉的），用户看到的是自相矛盾的两句话；
        // ② 目录没缓存失败结果，于是每次 listModels 都会再拿那条已经作废的
        //    刷新令牌去打一次上游 —— 一个死账号会变成持续的重试风暴（见上面那道闸）。
        const verdict = classifyFailure(error, family.id)
        const recorded = this.#health.record(family.id, accountId, '*', verdict)
        this.#log?.warn?.(
          'account-bridge: refreshing %s failed (%s)%s',
          accountId,
          redact(String(error?.code ?? error?.message ?? error)),
          recorded > 0 ? `, cooling ${Math.round(recorded / 1000)}s` : '',
        )
        throw error
      }
      const next = await this.#store.update(accountId, (current) =>
        current ? { ...current, auth: { ...current.auth, ...auth } } : undefined,
      )
      this.#catalogs.delete(`${family.id}/${accountId}`)
      this.#pools.delete(family.id)
      this.#log?.info?.('account-bridge: refreshed credentials for %s', accountId)
      return next ?? { ...account, auth: { ...account.auth, ...auth } }
    })()
    this.#inflightRefresh.set(key, task)
    try {
      return await task
    } finally {
      this.#inflightRefresh.delete(key)
    }
  }

  // -------------------------------------------------------------- 调度

  /**
   * 选一个账号来服务这次请求。
   * 顺序：粘性命中 → 健康度 → 目录里真有这个模型的账号。
   */
  async #pick(family, model, options) {
    const pool = await this.#pool(family, options.signal)
    const candidates = pool.entries.filter((entry) => entry.modelId === model)
    if (candidates.length === 0) {
      if (pool.accounts.length === 0) {
        const error = new Error(`account-bridge: no ${family.id} account signed in yet`)
        error.code = 'MISSING_CREDENTIAL'
        throw error
      }
      const error = new Error(`account-bridge: no ${family.id} account offers model "${model}"`)
      error.code = 'NO_ADAPTER'
      throw error
    }

    const stickyKey = this.#stickyKey(family, model, options)
    const pinned = stickyKey ? this.#sticky.get(stickyKey) : undefined
    const now = Date.now()
    const healthy = []
    for (const candidate of candidates) {
      if (!this.#health.available(family.id, candidate.account.id, model, now)) continue
      healthy.push(candidate)
    }
    const usable = healthy.length > 0 ? healthy : candidates

    if (pinned) {
      const hit = usable.find((entry) => entry.account.id === pinned)
      if (hit) return { entry: hit, stickyKey, reason: 'sticky' }
    }
    // 未钉住时：优先挑「该账号的其他模型没在被用」的账号，实现负载摊开
    usable.sort((a, b) => a.account.id.localeCompare(b.account.id))
    const chosen = usable[0]
    if (stickyKey) this.#rememberSticky(stickyKey, chosen.account.id, now)
    return { entry: chosen, stickyKey, reason: pinned ? 'sticky-miss' : 'fresh' }
  }

  /**
   * 会话标识（**与模型无关**）：用会话里第一条 user 消息的 id。
   *
   * 与 `#stickyKey` 的区别只在「带不带模型」：粘性要按模型分（同一个会话问两个模型是两次
   * 独立的选择），而发给上游的会话标识不该带模型，否则换个模型就等于换了个会话。
   */
  #conversationId(options) {
    const messages = options.messages ?? []
    const first = messages.find((message) => message.role === 'user') ?? messages[0]
    const id = first?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }

  /** 会话亲和键：用会话里**第一条 user 消息的 id**（历史被重放，id 跨轮稳定）。 */
  #stickyKey(family, model, options) {
    const id = this.#conversationId(options)
    return id === undefined ? undefined : `${family.id}/${model}/${id}`
  }

  #rememberSticky(key, accountId, now) {
    this.#sticky.set(key, accountId)
    if (this.#sticky.size <= STICKY_LIMIT) return
    for (const [existing, value] of this.#sticky) {
      if (this.#sticky.size <= STICKY_LIMIT) break
      this.#sticky.delete(existing)
    }
    void now
  }

  /**
   * 判定一个 chunk 是不是**正文**（text / tool-call）。
   *
   * 出现正文就**必须立刻提交**：调用方已经看到了内容，换号重放会把它看两遍。
   * `block-start` / `usage` / `finish` 都不算——它们不携带内容。
   */
  static isContent(chunk) {
    if (!chunk || typeof chunk !== 'object') return false
    if (chunk.type === 'block-end') {
      const block = chunk.block
      if (!block) return false
      if (block.type === 'text') return typeof block.text === 'string' && block.text.length > 0
      if (block.type === 'tool-call') return Boolean(block.id || block.name || block.arguments)
      return false
    }
    if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.length > 0
    if (chunk.type === 'tool-call-delta') {
      return typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0
    }
    return false
  }

  /**
   * 判定一个 chunk 是不是**思考**（reasoning）。思考**不算输出**。
   *
   * 理由见 `HOLD_LONGEST_MS` 那一组：Claude 会在想了 10–25 秒之后拒绝整轮，把
   * 「已经开始思考」当成「已经输出了」等于让用户直接吃到那条拒绝。
   */
  static isThinking(chunk) {
    if (!chunk || typeof chunk !== 'object') return false
    if (chunk.type === 'reasoning-delta') return typeof chunk.text === 'string' && chunk.text.length > 0
    if (chunk.type === 'block-end') {
      const block = chunk.block
      return Boolean(block && block.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0)
    }
    return false
  }

  /** 思考或正文：这一轮确实产出了东西。 */
  static isMeaningful(chunk) {
    return AccountBridgeAdapter.isContent(chunk) || AccountBridgeAdapter.isThinking(chunk)
  }

  /**
   * 缓冲里这些 chunk 大概占多少字节（`HOLD_MOST_BYTES` 用）。
   *
   * 只数我们自己持有的**文本**，不算对象开销——目的是「一个疯狂输出的上游别把内存
   * 吃光」，不是精确记账。
   */
  static chunkBytes(chunk) {
    if (!chunk || typeof chunk !== 'object') return 0
    let total = 0
    for (const value of [chunk.text, chunk.argumentsDelta, chunk.block?.text, chunk.block?.arguments]) {
      if (typeof value === 'string') total += value.length
    }
    return total
  }

  /**
   * 真正干活的地方：选号 → 调用 → 失败换号。
   * 缓冲规则见文件头第 1 条。
   */
  async *#streamWithPool(family, options) {
    const model = options.model
    const pool = await this.#pool(family, options.signal)
    const candidates = pool.entries.filter((entry) => entry.modelId === model)
    if (candidates.length === 0) {
      const error = new Error(`account-bridge: no ${family.id} account offers model "${model}"`)
      error.code = pool.accounts.length === 0 ? 'MISSING_CREDENTIAL' : 'NO_ADAPTER'
      throw error
    }

    const stickyKey = this.#stickyKey(family, model, options)
    const conversation = this.#conversationId(options)
    const pinned = stickyKey ? this.#sticky.get(stickyKey) : undefined
    const ordered = []
    const seen = new Set()
    for (const candidate of candidates) {
      if (pinned && candidate.account.id === pinned) {
        ordered.push(candidate)
        seen.add(candidate.account.id)
      }
    }
    for (const candidate of candidates) {
      if (seen.has(candidate.account.id)) continue
      if (this.#health.available(family.id, candidate.account.id, model)) ordered.push(candidate)
    }
    for (const candidate of candidates) {
      if (!ordered.includes(candidate)) ordered.push(candidate)
    }

    let lastError
    for (const [index, candidate] of ordered.entries()) {
      const accountId = candidate.account.id
      const pending = []
      let pendingBytes = 0
      let bufferedSince = 0
      let thinkingSince
      let deadlineAt = 0
      let committed = false
      let produced = false
      // 这一轮会不会「想完之后拒绝整轮」：决定「手里只有思考」时给不给它时间。
      const refusesThinking = refusesAfterThinking(family, model)
      /**
       * 把缓冲里的东西**原样**交出去，并从此不再允许换号。
       *
       * 返回要 yield 的副本（调用方负责 yield），顺序与到达顺序一致——「思考在前、
       * 正文在后」的顺序是上游给的，改了就错。
       */
      const commitHold = () => {
        if (committed) return []
        committed = true
        produced = true
        if (stickyKey) this.#rememberSticky(stickyKey, accountId, Date.now())
        const buffered = pending.slice()
        pending.length = 0
        pendingBytes = 0
        return buffered
      }
      try {
        const payload = await this.#freshPayload(family, candidate.account)
        const iterator = family
          .stream(this.#ctx, {
            payload,
            // 族的身份头需要知道「是哪个账号在发」——按账号分命名空间靠它。
            account: { id: accountId, label: candidate.account.label },
            // 裸的调用方会话 id（**由族负责按账号派生后再发出去**，不许原样透传）。
            session: conversation,
            model,
            messages: options.messages,
            tools: options.tools,
            effort: options.effort ?? options.reasoningEffort,
            system: options.system,
            maxTokens: options.maxTokens,
            signal: options.signal,
          })
          [Symbol.asyncIterator]()

        let next = iterator.next()
        while (true) {
          let result
          if (committed || pending.length === 0) {
            // 没有东西攒着就没有「换号窗口」可等，直接拿下一块。
            result = await next
          } else {
            const wait = deadline(Math.max(0, deadlineAt - Date.now()))
            try {
              result = await Promise.race([next, wait.promise])
            } finally {
              wait.cancel()
            }
            if (result === DEADLINE) {
              // 到期：**原样放行**手里攒着的（不是丢弃）。放过之后就不能再换号了，
              // 因为调用方已经在屏幕上看见了这些块。
              for (const buffered of commitHold()) yield buffered
              continue
            }
          }
          const { value, done } = result
          if (done) break
          // 必须在下面任何 `continue` 之前就把下一次拉起来，否则 `await next` 会
          // 反复拿到同一个已解决的结果，转成死循环。
          next = iterator.next()
          if (!value) continue
          if (committed) {
            yield value
            continue
          }
          // 正文：立刻提交，之后不许换号。
          if (AccountBridgeAdapter.isContent(value)) {
            for (const buffered of commitHold()) yield buffered
            yield value
            continue
          }
          // 只有思考、而这家不会因为思考就拒绝整轮 ⇒ 立刻放行。
          // 憋着会让这些家的思考在正文开始时一次性吐出来（magpie #248 的现场）。
          if (AccountBridgeAdapter.isThinking(value) && !refusesThinking) {
            for (const buffered of commitHold()) yield buffered
            yield value
            continue
          }

          if (pending.length === 0) bufferedSince = Date.now()
          if (thinkingSince === undefined && AccountBridgeAdapter.isThinking(value)) thinkingSince = Date.now()
          pending.push(value)
          pendingBytes += AccountBridgeAdapter.chunkBytes(value)
          // 只有思考时才给 4 分钟；其余情况等的是「第一段内容」，也就是 15 秒。
          deadlineAt = thinkingSince === undefined ? bufferedSince + this.#hold.longestMs : thinkingSince + this.#hold.thinkingMs
          if (pendingBytes >= this.#hold.mostBytes) {
            // 一个疯狂输出的上游别把内存吃光：到量就放行。
            for (const buffered of commitHold()) yield buffered
          }
        }

        if (!produced) {
          // 一个字都没出来：算空响应，可以安全换号
          const error = new Error(`account-bridge: ${accountId} returned an empty response`)
          error.code = 'EMPTY_RESPONSE'
          throw error
        }
        this.#health.clear(family.id, accountId, model)
        return
      } catch (error) {
        lastError = error
        const verdict = classifyFailure(error, family.id)
        const recorded = this.#health.record(family.id, accountId, model, verdict)
        this.#log?.warn?.(
          'account-bridge: %s/%s failed (%s%s), %s',
          family.id,
          accountId,
          redact(String(error?.code ?? error?.message ?? error)),
          recorded > 0 ? `, cooling ${Math.round(recorded / 1000)}s` : '',
          committed
            ? 'already streaming — not switching'
            : index + 1 < ordered.length
              ? 'switching to next account'
              : 'no account left',
        )
        if (committed || verdict.action === 'throw') throw error
        if (index + 1 >= ordered.length) throw error
      }
    }
    throw lastError ?? new Error('account-bridge: no account could serve this request')
  }

  // -------------------------------------------------------------- 其它

  /** 供设置页展示：每族每账号的健康快照。 */
  async status() {
    const out = []
    for (const family of this.#families) {
      const accounts = await this.#store.list(family.id)
      out.push({
        family: family.id,
        displayName: family.displayName,
        route: family.route,
        accounts: accounts.map((account) => ({
          id: account.id,
          label: account.label,
          source: account.source,
          externallyOwned: account.externallyOwned === true,
          disabled: account.disabled === true,
          expiresAt: account.auth?.expiresAt,
          cooldown: this.#health.why(family.id, account.id, '*'),
        })),
      })
    }
    return out
  }

  /** 账号变化后让池缓存立刻作废。 */
  invalidate(familyId) {
    if (familyId) {
      this.#pools.delete(familyId)
      for (const key of [...this.#catalogs.keys()]) {
        if (key.startsWith(`${familyId}/`)) this.#catalogs.delete(key)
      }
      return
    }
    this.#pools.clear()
    this.#catalogs.clear()
  }

  /** 健康状态变化（例如手动解冻）后让模型列表重新算。 */
  invalidateHealth() {
    this.#pools.clear()
  }

  /** 清理粘性表（账号被设成默认时调用）。 */
  clearSticky(familyId) {
    for (const key of [...this.#sticky.keys()]) {
      if (!familyId || key.startsWith(`${familyId}/`)) this.#sticky.delete(key)
    }
  }

  /**
   * 手动解冻一个账号（或整族）。
   *
   * 冷却表是**纯内存派生状态**，重放一次同样的失败只会把它再记回来，代价是多一次
   * 注定失败的请求——所以这个动作是安全的，不需要二次确认。返回被清掉的冷却条数。
   */
  unfreeze(familyId, accountId) {
    const removed = this.#health.clearAccount(familyId, accountId)
    // 冷却一变，池子装配与目录缓存都可能已经过时（被冻住的账号原本被排除在外）。
    if (removed > 0) {
      this.invalidateHealth()
      this.invalidate(familyId)
    }
    return removed
  }

  /** 一个账号当前的健康说明；健康时返回 undefined。 */
  healthOf(familyId, accountId) {
    const why = this.#health.why(familyId, accountId, '*')
    if (!why || !(why.until > Date.now())) return undefined
    const remaining = why.until - Date.now()
    const minutes = Math.round(remaining / 60_000)
    const when = minutes < 1 ? `${Math.round(remaining / 1000)} 秒` : minutes < 90 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`
    return `${why.reason}，${when}后可用`
  }

  /** 内部状态摘要，仅用于诊断。 */
  debugState() {
    return {
      pools: [...this.#pools.keys()],
      catalogs: [...this.#catalogs.keys()],
      sticky: this.#sticky.size,
      health: this.#health.snapshot(),
    }
  }
}

export { memberKey, accountKey, STICKY_TTL_MS }
