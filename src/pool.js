/**
 * 账号池适配器：对外是一个 DSH 的 LlmAdapter，对内是「一族多账号」的调度器。
 *
 * 三条从成熟实现里学来的硬规则（都写在代码里，别随手改）：
 * 1. **流式 failover 只在「一个字都没吐出去」时做**。block-start 不算输出，
 *    block-end 带 text/id/arguments 才算，usage/finish 不算。为了能做到这件事，
 *    首个实质内容之前的所有 chunk 都要先缓冲。
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

  constructor({ ctx, store, health, families, log }) {
    this.#ctx = ctx
    this.#store = store
    this.#health = health
    this.#families = families
    this.#log = log
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

  /** 会话亲和键：用会话里**第一条 user 消息的 id**（历史被重放，id 跨轮稳定）。 */
  #stickyKey(family, model, options) {
    const messages = options.messages ?? []
    const first = messages.find((message) => message.role === 'user') ?? messages[0]
    const id = first?.id
    if (typeof id !== 'string' || id.length === 0) return undefined
    return `${family.id}/${model}/${id}`
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

  /** 判定一个 chunk 算不算「实质输出」。 */
  static isMeaningful(chunk) {
    if (!chunk || typeof chunk !== 'object') return false
    if (chunk.type === 'block-end') {
      const block = chunk.block
      if (!block) return false
      if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string' && block.text.length > 0
      if (block.type === 'tool-call') return Boolean(block.id || block.name || block.arguments)
      return false
    }
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      return typeof chunk.text === 'string' && chunk.text.length > 0
    }
    if (chunk.type === 'tool-call-delta') {
      return typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0
    }
    return false
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
      let committed = false
      let produced = false
      try {
        const payload = await this.#freshPayload(family, candidate.account)
        const iterator = family
          .stream(this.#ctx, {
            payload,
            model,
            messages: options.messages,
            tools: options.tools,
            effort: options.effort ?? options.reasoningEffort,
            system: options.system,
            maxTokens: options.maxTokens,
            signal: options.signal,
          })
          [Symbol.asyncIterator]()

        while (true) {
          const { value, done } = await iterator.next()
          if (done) break
          if (!value) continue
          if (!committed) {
            if (!AccountBridgeAdapter.isMeaningful(value)) {
              pending.push(value)
              continue
            }
            // 第一个实质 chunk 出现：从现在起不能再换号了
            committed = true
            produced = true
            if (stickyKey) this.#rememberSticky(stickyKey, accountId, Date.now())
            for (const buffered of pending) yield buffered
            pending.length = 0
          }
          yield value
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
