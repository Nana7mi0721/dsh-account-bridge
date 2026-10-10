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
 *    每轮都失效、每轮都从头全额计费。判据是**实测**的（上游说它从缓存里读了多少），
 *    四态与判定顺序见 `src/affinity.js`；记录会落到 `ctx.storageDomain`，重启不失忆。
 * 3. **选择器是各账号目录的并集**：多个账号都有的模型可以互相 failover，
 *    只有一个账号有的模型就钉死在那个账号上。
 * @module dsh-account-bridge/pool
 */

import { accountKey, classifyFailure, memberKey } from './health.js'
import { carryFailure, carryingFailures } from './failure.js'
import {
  AffinityBook,
  cachedRead,
  decide,
  normaliseMode,
  recordKey,
  turnOf,
} from './affinity.js'
import { SPENT_SHARE, decayUsage, rankCandidates, shareOf, usageNow } from './select.js'
import { redact } from './util.js'

/** 池装配的缓存时长：`owns()` 每次选模型都会跑，而装配要碰目录与账号存储。 */
const POOL_CACHE_TTL_MS = 5_000
/** 单账号模型目录的缓存时长。 */
const CATALOG_TTL_MS = 10 * 60_000
/**
 * 额度快照的缓存时长。额度变得慢，问太勤反而会撞上游的额度端点——有的族为了读额度
 * 要跑一次本机 CLI，那是有成本的。
 */
const ALLOWANCE_TTL_MS = 5 * 60_000
/** 额度查询失败后的重试间隔。比成功长，免得把一个坏掉的额度端点打成重试风暴。 */
const ALLOWANCE_RETRY_MS = 60_000
/** `#lastWhy` 的上限（只是给人看的诊断，不是状态）。 */
const WHY_LIMIT = 1000

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
  /**
   * 会话亲和（粘谁、为什么）。**没接上 `ctx.storageDomain` 也能用**，只是重启失忆。
   * 记录本身带上游实测的缓存读取量，见 `src/affinity.js`。
   */
  #affinity
  #affinityMode
  /**
   * 协议状态回放（W4）。
   *
   * 开了也只是**第一个候选**能用：签名是某个账号签的，把它发给另一个账号是
   * 没验过的事，而换号本来就是「上一个账号刚出事」的时刻——那时候最不该赌。
   */
  #replay
  /** 最近一次选择给出的理由（`/pool` 与调试用）。`<族>/<模型>/<会话>` → 裁决。 */
  #lastWhy = new Map()
  #inflightRefresh = new Map()
  /**
   * 额度快照：`<族>/<账号>` → `{ at, windows }`。
   * **读不到就是「未知」，与「用完了」严格区分**：`remainingFraction: 0` 是真实读数，
   * 必须原样保留；一条读数都没有的账号只是我们没问到。
   */
  #allowances = new Map()
  /** 额度查询的去重表：同一账号同时在飞的查询只发一次。 */
  #allowanceInflight = new Map()
  /** 额度查询失败后的下次可试时刻。 */
  #allowanceRetryAt = new Map()
  /** 近期用量（已按半衰期衰减）：`<族>/<账号>` → `{ at, weight }`。 */
  #usage = new Map()
  /** 沉的序号：`<族>/<账号>` → 序号。>0 表示「还有额度却吃过限流」。 */
  #sunk = new Map()
  #sunkSeq = 0
  #hold

  constructor({ ctx, store, health, families, log, hold, affinity, affinityMode, replay }) {
    this.#ctx = ctx
    this.#store = store
    this.#health = health
    this.#families = families
    this.#log = log
    this.#hold = { ...HOLD_DEFAULTS, ...(hold ?? {}) }
    this.#affinity = affinity ?? new AffinityBook({ log })
    this.#affinityMode = normaliseMode(affinityMode)
    this.#replay = replay === true
  }

  /** 会话亲和那本账（`index.js` 在 `storageDomain` 就绪后把表接上去）。 */
  affinityBook() {
    return this.#affinity
  }

  /** 当前的粘性模式（四态之一）。 */
  get affinityMode() {
    return this.#affinityMode
  }

  set affinityMode(value) {
    this.#affinityMode = normaliseMode(value)
  }

  /**
   * 最近一次选择给出的理由；`familyId` 省略时给全部。
   *
   * 键就是 `recordKey()` 造出来的 `${familyId}-<摘要>`，所以前缀分隔符是**连字符**。
   */
  lastWhy(familyId) {
    return [...this.#lastWhy.entries()]
      .filter(([key]) => familyId === undefined || key.startsWith(`${familyId}-`))
      .map(([key, value]) => ({ key, ...value }))
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
    try {
      const pool = await this.#pool(family, signal)
      return pool.models
    } catch (error) {
      throw carryFailure(error)
    }
  }

  async resolveModel(provider, model, signal) {
    const family = this.familyOf(provider)
    try {
      const resolved = family.resolveModel
        ? await family.resolveModel(provider, model, signal)
        : { provider, id: model, name: model }
      return { ...resolved, provider, id: model }
    } catch (error) {
      throw carryFailure(error)
    }
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
    // 包一层 `carryingFailures`：失败可能在消费到一半才发生，只有把 `yield*` 整个包住
    // 才接得到，接不到就等于让宿主的失败码停在 `UNKNOWN`（见 `src/failure.js`）。
    return carryingFailures(this.#streamWithPool(family, options))
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
    // 额度是后台尽力而为读来的：**装配与选择都不为它等待**。
    this.#refreshAllowances(family, accounts)
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
      // 冷却时长由 `src/health.js` 算出来（见那里的常量表），与请求路径同一套。
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
   * 把一个候选账号变成 `select.js` 要的形状。
   *
   * 额度是**后台尽力而为**读来的快照（见 `#refreshAllowances`）：选择本身**永不**为它
   * 等待，读不到就是「未知」，与「用完了」严格区分。
   */
  #candidateOf(family, entry, now) {
    const key = accountKey(family.id, entry.account.id)
    const snapshot = this.#allowances.get(key)
    const windows = []
    for (const window of snapshot?.windows ?? []) {
      const remaining = Number(window?.remainingFraction)
      if (!Number.isFinite(remaining)) continue
      windows.push({
        used: (1 - Math.min(1, Math.max(0, remaining))) * 100,
        ...(Number.isFinite(window?.resetAt) ? { resetsAt: window.resetAt } : {}),
      })
    }
    return {
      id: entry.account.id,
      entry,
      windows,
      /**
       * **额度未知、但这一族读得出额度** ⇒ 先让它答一次，只到我们读到为止。
       * 否则它永远排在已知账号后面，也就永远不会被知道。
       * 已经问过但上游什么都没说的（快照存在、窗口为空）不再走这条通道。
       */
      learns: snapshot === undefined && typeof family.quota === 'function',
      usedRecently: usageNow(this.#usage.get(key), now),
      sunk: this.#sunk.get(key) ?? 0,
    }
  }

  /**
   * 后台把每个账号的额度读一遍。**不 await、不抛错**。
   *
   * 额度是加分项：读不到就只是「未知」，不能让一次额度查询拖慢或弄坏一次真实请求，
   * 也不能让它变成对额度端点的重试风暴（失败后隔 `ALLOWANCE_RETRY_MS` 再试）。
   */
  #refreshAllowances(family, accounts) {
    if (typeof family.quota !== 'function') return
    const now = Date.now()
    for (const account of accounts) {
      const key = accountKey(family.id, account.id)
      const snapshot = this.#allowances.get(key)
      if (snapshot && now - snapshot.at < ALLOWANCE_TTL_MS) continue
      if ((this.#allowanceRetryAt.get(key) ?? 0) > now) continue
      if (this.#allowanceInflight.has(key)) continue
      const task = (async () => {
        const payload = await this.#freshPayload(family, account)
        const windows = await family.quota(this.#ctx, payload, undefined)
        if (Array.isArray(windows)) this.#allowances.set(key, { at: Date.now(), windows })
        this.#allowanceRetryAt.delete(key)
      })()
        .catch((error) => {
          this.#allowanceRetryAt.set(key, Date.now() + ALLOWANCE_RETRY_MS)
          this.#log?.debug?.(
            'account-bridge: reading the allowance of %s failed (%s)',
            key,
            redact(String(error?.code ?? error?.message ?? error)),
          )
        })
        .finally(() => {
          this.#allowanceInflight.delete(key)
        })
      this.#allowanceInflight.set(key, task)
    }
  }

  /** 记一次成功的请求，用于「并列时先挑近期用得少的」。 */
  #noteUsage(family, accountId, now = Date.now()) {
    const key = accountKey(family.id, accountId)
    this.#usage.set(key, decayUsage(this.#usage.get(key), now, 1))
  }

  /**
   * 把一个「还有额度却吃了限流」的账号沉到末尾。
   *
   * 要解决的问题（magpie 的 Sink，来自一个 WorkBuddy 用户的实际投诉）：一个账号被
   * 打到限流、冷却一结束又立刻被灌满请求——**这正是风控最容易注意到的形状**。
   * 沉过之后它排到所有没沉过的账号后面，只有等前面的也都被限流过才回到最前。
   *
   * **额度用尽与欠费不沉**：那两种是「它现在确实不能用」，不是「我们在某个账号上
   * 打得太急」。只增不减，重启即忘。
   */
  #sinkAccount(family, accountId) {
    const key = accountKey(family.id, accountId)
    this.#sunkSeq += 1
    this.#sunk.set(key, this.#sunkSeq)
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

  /** `#lastWhy` 只留最近 `WHY_LIMIT` 条（Map 保持插入顺序，先来的先丢）。 */
  #trimWhy() {
    if (this.#lastWhy.size <= WHY_LIMIT) return
    for (const key of this.#lastWhy.keys()) {
      if (this.#lastWhy.size <= WHY_LIMIT) break
      this.#lastWhy.delete(key)
    }
  }

  /**
   * 会话亲和键：用会话里**第一条 user 消息的 id**（历史被重放，id 跨轮稳定）**加模型**。
   *
   * 加模型是**刻意偏离 magpie**（它是 `scope|conversation`，模型记在记录里）：
   * 我们的候选集本来就按模型过滤过，magpie 那三级谓词在我们这里退化成「账号相同」，
   * 带不带模型只影响查的是哪一条记录。带上的理由是一段会话里换个模型问一句时，
   * 不带模型就会把上一条覆盖掉，于是两个模型轮流把对方挤走、谁都粘不住。
   */
  #stickyKey(family, model, options) {
    const id = this.#conversationId(options)
    return id === undefined ? undefined : recordKey(family.id, model, id)
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
    const now = Date.now()
    // 顺序由 `select.js` 决定：额度分档 → 剩余额度撑多久 → 重置时间 → 近期用量 → id。
    // 额度未知、而这一族又读得出额度的账号，只在还没读到过时排到最前（`learns`）。
    const ready = candidates.filter((candidate) =>
      this.#health.available(family.id, candidate.account.id, model, now),
    )
    const resting = new Set(
      candidates
        .filter((candidate) => !ready.includes(candidate))
        .map((candidate) => candidate.account.id),
    )
    const ranked = rankCandidates(
      ready.map((entry) => this.#candidateOf(family, entry, now)),
      now,
    )
    const ordered = ranked.order.map((candidate) => candidate.entry)
    // 冷却中的排最后，但**永不剔除**：前面的全都试完了，照样试它一次。
    for (const candidate of candidates) {
      if (!ordered.includes(candidate)) ordered.push(candidate)
    }
    // 「几乎用满」的判据与 `select.js` 同源（98%），且**只对一个本来就不在第一个位置上的
    // 账号生效**——它要是本来就排第一，那就继续用它，直到上游真的拒绝为止。
    const spent = new Set(
      ranked.order
        .filter((candidate) => Number(shareOf(candidate)) >= SPENT_SHARE)
        .map((candidate) => candidate.account.id),
    )
    const { turn, within } = turnOf(options.messages)
    const record = stickyKey === undefined ? undefined : this.#affinity.get(stickyKey, now)
    const verdict = decide({
      mode: this.#affinityMode,
      record,
      candidates: ordered.map((candidate) => ({ id: candidate.account.id })),
      resting,
      spent,
      within,
      now,
    })
    if (stickyKey !== undefined) {
      // 先删再塞，让 Map 的顺序是「最近用到」而不是「第一次见到」。
      this.#lastWhy.delete(stickyKey)
      this.#lastWhy.set(stickyKey, {
        family: family.id,
        model,
        why: verdict.why,
        accountId: verdict.accountId,
        at: now,
      })
      this.#trimWhy()
    }
    if (verdict.kept && verdict.at > 0) {
      // 粘住：把它挪到最前，其余保持选号给的相对顺序。
      const [kept] = ordered.splice(verdict.at, 1)
      ordered.unshift(kept)
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
      /**
       * 这一轮上游自报「从缓存里读到了多少」——**唯一的实测判据**，决定这段会话下一轮还粘不粘。
       *
       * 只认最后一次非零值：usage 可能在流中间就来，收尾再报一次总量；
       * 而显式的 0 是「这次没读到缓存」，不该把前面那次真实读数擦掉。
       */
      let cacheRead = 0
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
            // 回放只给第一个候选：签名是某个账号签的，换号之后再把它发出去是没验过的事。
            replay: this.#replay && index === 0,
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
          if (value.type === 'usage') {
            const read = cachedRead(value.usage)
            if (read > 0) cacheRead = read
          }
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
        this.#noteUsage(family, accountId)
        if (stickyKey !== undefined) {
          // 记在**答完**之后：失败的那一轮没资格粘住谁（换号是为了换个能答的）。
          this.#affinity.remember(stickyKey, {
            accountId,
            model,
            effort: options.effort ?? options.reasoningEffort,
            turn,
            at: Date.now(),
            cacheRead,
          })
        }
        return
      } catch (error) {
        lastError = error
        const verdict = classifyFailure(error, family.id)
        const recorded = this.#health.record(family.id, accountId, model, verdict)
        // 「还有额度却吃了限流」⇒ 这个账号沉到末尾。额度用尽与欠费不沉（不是我们的问题）。
        if (verdict.backoff === 'rate') this.#sinkAccount(family, accountId)
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
    const drop = (map) => {
      if (!familyId) {
        map.clear()
        return
      }
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${familyId}/`)) map.delete(key)
      }
    }
    if (familyId) this.#pools.delete(familyId)
    else this.#pools.clear()
    drop(this.#catalogs)
    // 账号换过（加/删/停用/改代理）之后，之前读到的额度可能已经不是同一个出口的读数。
    // `#sunk` 与 `#usage` **不在这里清**：它们记的是「这个账号被限流过」「它最近被用得多」，
    // 换代理不会让这两件事没发生过（magpie 的 Sink 也是「记住到重启为止」）。
    drop(this.#allowances)
    drop(this.#allowanceRetryAt)
  }

  /** 健康状态变化（例如手动解冻）后让模型列表重新算。 */
  invalidateHealth() {
    this.#pools.clear()
  }

  /**
   * 手动清掉粘性记录（`/pool sticky forget` 与面板上的「忘掉」）。
   *
   * 这是**唯一**一条会把记录整族丢掉的路径：别的地方都不需要它。账号被停用、被删掉、
   * 被换掉时，`decide()` 自己会给出 `gone` / `resting`，记着的那条无害；而顺手清一整族
   * 会把**别的账号答过的会话**也一起忘掉——那等于白烧它们的上游缓存。
   *
   * 清掉不等于换号：下一轮由 `select.js` 重新排序，缓存该丢就丢，理由落在 `#lastWhy` 里。
   */
  clearSticky(familyId) {
    if (!familyId) {
      this.#affinity.clear()
      this.#lastWhy.clear()
      return
    }
    this.#affinity.forgetPrefix(`${familyId}-`)
    this.#dropWhy((key) => key.startsWith(`${familyId}-`))
  }

  /**
   * 一个账号被删掉时调用：只忘掉**指向它**的记录。
   *
   * 不整族清的理由见 `src/affinity.js` 的 `forgetAccount()`：账号 id 会回收，所以这条
   * 记录留着有害；但其它账号答过的会话与这次删除无关，没必要陪着一起失忆。
   */
  forgetAccount(accountId) {
    const dropped = this.#affinity.forgetAccount(accountId)
    this.#dropWhy((key, row) => row.accountId === accountId)
    return dropped
  }

  #dropWhy(match) {
    for (const [key, row] of [...this.#lastWhy.entries()]) {
      if (match(key, row)) this.#lastWhy.delete(key)
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
      affinity: { mode: this.#affinityMode, size: this.#affinity.size, persisted: this.#affinity.persisted },
      why: [...this.#lastWhy.entries()].map(([key, value]) => `${key}=${value.why}@${value.accountId}`),
      allowances: [...this.#allowances.keys()],
      sunk: [...this.#sunk.entries()].map(([key, seq]) => `${key}#${seq}`),
      health: this.#health.snapshot(),
    }
  }
}

export { memberKey, accountKey }
