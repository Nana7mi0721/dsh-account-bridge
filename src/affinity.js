/**
 * 会话亲和（W7）：一段会话粘在「上次答它的那个账号」上。
 *
 * 理由不是「同一段会话换账号会记不住」（我们的历史每次都整段重放，换谁都接得上），
 * 而是**钱**：上游会把它已经看过的那一整段对话前缀缓存在自己的机器上，同一条路由回去
 * 就是「读缓存」，换一个账号就是「从头再算一遍并全额计费」。这也是唯一一条**能实测**
 * 的判据——上游每次都会说它这次从缓存里读了多少 token。
 *
 * 语义照 magpie 的 `internal/gateway/affinity.go`（MIT，见 `THIRD_PARTY_NOTICES.md`），
 * 四态与判定顺序一一对应。文件头原文（翻译）：
 *
 * > 亲和：一段会话留在答过它的那个 key/账号上，这样上游为它缓存下来的东西（整段对话，
 * > 每次请求都要）是被**读**回来的，而不是原样发给另一个账号再全额付一次。没人答过时，
 * > 顺序仍由选号决定；答过它的那个在休息或几乎用满时，也一样。
 * >
 * > 粘多久取决于 provider 或 group 的亲和设置：整段会话；只在轮内（agent 在回传工具结果，
 * > 直到用户再开口）；从不；或者默认——从对话本身算出来：轮内总是粘，跨轮则看上一次上游
 * > 说它从缓存里读到的量值不值得留、以及有没有凉掉。
 * >
 * > 谁答的也会写到盘上（`affinity.json`），这样一次重启——包括一次升级——不会在别的账号
 * > 还缓存着它的时候，把这段会话交给选号排在第一个的那个。
 *
 * **与 magpie 的三处刻意偏离**（都写进 `THIRD_PARTY_NOTICES.md`）：
 *
 * 1. **键里带模型**（magpie 是 `scope|conversation`，模型记在记录里、靠三级谓词回退）。
 *    我们的候选集本来就是**按模型过滤过**的，所以 magpie 那三级谓词在我们这里退化成
 *    「账号相同」，带不带模型只影响查的是哪一条记录。带上的理由：一段会话里换个模型问一句
 *    （如实测里很常见的「先问便宜的、再问贵的」），不带模型就会把上一条记录覆盖掉，
 *    于是两个模型轮流把对方挤走、谁都粘不住；带上就只有那一个模型的选择会变。
 * 2. **`role: 'tool'` 也算轮内**。magpie 的消息形状是 Anthropic 风格（工具结果是 user 消息里
 *    的一种 part），DSH 的工具结果是**独立的一条 `role: 'tool'` 消息**（`toAnthropicMessages`
 *    才把它们并回上一条 user）。只认 user 消息的话，`within` 在我们这里永远不会为真，
 *    而「agent 正在回传工具结果」恰好是缓存最值钱的时候。
 * 3. **落盘走 `ctx.storageDomain`**（magpie 自己写 `affinity.json`）。宿主已经把
 *    `@deepseek-ai/dsh-storage` + `storage-json` + `storage-domain` 挂在每个 profile 的
 *    `dsh-base` 里（根目录 `~/.dsh/storages`），我们不该在 `~/.dsh` 下面另开一个文件。
 *    **但不能 import `@deepseek-ai/dsh-storage-domain`**——插件按裸模块名 import 核心包会
 *    `ERR_MODULE_NOT_FOUND`（真机实测，见 `test/contract.test.js`），所以 spec 是手工拼的：
 *    `open()` 只读 `name` / `version` / `tables[].valueSchema` / `global` / `invalidRecords` /
 *    `layout`，`defineDomain` 干的事只是「模块加载时校验一遍」，而我们自己校验。
 * @module dsh-account-bridge/affinity
 */

import { createHash } from 'node:crypto'

/** 四态。`auto` = 按实测缓存价值判定（默认）。 */
export const AFFINITY_MODES = ['auto', 'session', 'turn', 'off']
export const DEFAULT_AFFINITY_MODE = 'auto'

/** 值得跨轮保持的缓存读取量。 */
export const CACHE_WORTH = 1024

/** 缓存算「凉了」的时间：Anthropic 与 OpenAI 在没有读取时保缓存的最短时间。 */
export const CACHE_COLD_MS = 5 * 60_000

/**
 * 记录的**保留**时长——注意不是「24 小时都粘」。
 *
 * 跨轮粘不粘由 `CACHE_COLD_MS` 决定（5 分钟）；这条只决定「这条记录还值不值得留着」，
 * 留着的意义是重启之后还能看出「上一轮是谁答的」，以及第二次打开时不用从零学一遍。
 */
export const STICK_KEEP_MS = 24 * 60 * 60_000

/** 落盘条数上限：超了按「最近答过的」留。 */
export const STICKS_KEPT = 512

/** 攒一小会儿再落盘：一次对话轮里会有好几段会话同时写。 */
export const FLUSH_DEBOUNCE_MS = 2_000

/** domain 名要匹配 `^[a-z][a-z0-9_]*$`（宿主的 `UNIT_NAME_RE`），连字符不行。 */
export const DOMAIN_NAME = 'account_bridge'
export const DOMAIN_VERSION = 1
export const TABLE_NAME = 'affinity'

/** `decide()` 可能给出的全部裁决。 */
export const WHY_VALUES = [
  'off',
  'sticky-new',
  'gone',
  'resting',
  'spent',
  'session',
  'turn',
  'sticky-miss',
  'cache-weak',
  'cache-cold',
  'sticky-hit',
]

/** 配置项 → 四态之一；认不出的回默认值（**永不抛**：一个错字不该让插件起不来）。 */
export function normaliseMode(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return AFFINITY_MODES.includes(text) ? text : DEFAULT_AFFINITY_MODE
}

/**
 * 数一轮里有几次用户开口，以及**这一轮还在不在进行中**。
 *
 * `within` 的判据照 magpie：最后一条提到工具结果的消息说了算——agent 把工具结果回传上来，
 * 说明这一轮还没结束。DSH 里工具结果既可能是独立的一条 `role: 'tool'` 消息，
 * 也可能是 user 消息里的一个 `tool-result` part，两种都认。
 */
export function turnOf(messages) {
  let turn = 0
  let within = false
  for (const message of messages ?? []) {
    if (message?.role === 'tool') {
      within = true
      continue
    }
    if (message?.role !== 'user') continue
    const content = message.content
    let text = false
    let result = false
    if (typeof content === 'string') text = content.length > 0
    else if (content === undefined || content === null) text = false
    else {
      for (const block of content) {
        const kind = block?.type
        if (kind === 'tool-result') result = true
        else if (kind === 'text' || kind === 'image' || kind === 'file') text = true
      }
    }
    if (text && !result) turn += 1
    within = result
  }
  return { turn, within }
}

/**
 * 上游这次从它自己的缓存里读了多少 token。
 *
 * 读不到就是 **0**（不是 `undefined`）：`decide()` 拿它跟 `CACHE_WORTH` 比大小，
 * 而「没说」与「说了 0」在这里是同一个结论——这次不值得粘。
 */
export function cachedRead(usage) {
  const raw = usage?.cachedInputTokens ?? usage?.cacheReadInputTokens ?? usage?.cached_tokens
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 记录键。**必须匹配宿主的 `[a-zA-Z0-9_-]+`**（`storage-json` 在动文件之前就校验它），
 * 而我们的会话 id 与模型名里什么都可能有，所以压缩成摘要。
 */
export function recordKey(familyId, model, conversationId) {
  const digest = createHash('sha256').update(`${model}\n${conversationId}`).digest('hex').slice(0, 24)
  return `${familyId}-${digest}`
}

/** 盘上取回来的一条记录合不合法；不合法返回 `undefined`（不是「一个空记录」）。 */
export function parseRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (typeof raw.accountId !== 'string' || raw.accountId === '') return undefined
  const at = Number(raw.at)
  if (!Number.isFinite(at)) return undefined
  const turn = Number(raw.turn)
  const cacheReadValue = Number(raw.cacheRead)
  return {
    accountId: raw.accountId,
    model: typeof raw.model === 'string' ? raw.model : '',
    ...(typeof raw.effort === 'string' && raw.effort !== '' ? { effort: raw.effort } : {}),
    turn: Number.isFinite(turn) ? turn : 0,
    at,
    cacheRead: Number.isFinite(cacheReadValue) ? cacheReadValue : 0,
  }
}

/** 记录还值不值得留着。 */
export function isFresh(record, now) {
  return record !== undefined && now - record.at <= STICK_KEEP_MS
}

/**
 * 该留下哪些键：过期的全丢，其余按「最近答过的」优先，留 `limit` 条。
 *
 * 用**键的集合**表达而不是返回一个裁剪后的表，是为了让调用方能顺手把被裁掉的从盘上删掉。
 */
export function keepKeys(memory, now, limit = STICKS_KEPT) {
  const fresh = []
  for (const [key, record] of memory) if (isFresh(record, now)) fresh.push([key, record])
  fresh.sort((a, b) => b[1].at - a[1].at)
  return new Set(fresh.slice(0, Math.max(0, limit)).map(([key]) => key))
}

/**
 * 会话该不该粘住。
 *
 * 逐条照 magpie 的 `affine()` 那个 switch，**顺序即优先级**：
 *
 * | 裁决 | 条件 | 粘吗 |
 * |---|---|---|
 * | `off` | 模式是 `off` | 否 |
 * | `sticky-new` | 没有记录（或记录过期了） | 否（顺序照选号） |
 * | `gone` | 记录里的账号**现在不是候选**（改模型了、账号删了/停用了） | 否 |
 * | `resting` | 那个账号在冷却里 | 否 |
 * | `spent` | 它**几乎用满**（≥98%）**且本来就不是第一个** | 否 |
 * | `session` | 模式是 `session` | **是** |
 * | `turn` | 模式是 `auto`，且这一轮还在进行中（在回传工具结果） | **是** |
 * | `sticky-miss` | 模式是 `turn`，但新的一轮开始了 | 否 |
 * | `cache-weak` | 上次上游只从缓存里读了不到 1024 token | 否 |
 * | `cache-cold` | 上次答复到现在超过 5 分钟 | 否 |
 * | `sticky-hit` | 以上都不是 | **是** |
 *
 * `spent` 那条的 `at > 0` 是关键：**「几乎用满」本身不换号**——只有它已经不在第一个
 * 位置上了才不把它拉回来。它要是本来就排第一，那就继续用它，直到上游真的拒绝为止。
 * 90–97% 仍然保持（`SPENT_SHARE` 是 98，与 `select.js` 的排序同源）。
 *
 * @param {object} input
 * @param {string} input.mode 四态之一
 * @param {object|undefined} input.record 上次是谁答的
 * @param {Array<{id: string}>} input.candidates 已经排好的候选（**顺序就是选号的结果**）
 * @param {Set<string>} [input.resting] 正在冷却的账号 id
 * @param {Set<string>} [input.spent] 几乎用满的账号 id
 * @param {boolean} [input.within] 这一轮还在进行中
 * @param {number} [input.now]
 * @returns {{at: number, why: string, kept: boolean, accountId: string|undefined}}
 */
export function decide({ mode, record, candidates, resting, spent, within = false, now = Date.now() }) {
  const list = Array.isArray(candidates) ? candidates : []
  const had = record !== undefined && now - record.at <= STICK_KEEP_MS
  let at = -1
  if (had) {
    at = list.findIndex((candidate) => candidate?.id === record.accountId)
  }

  let why
  // 缓存读取量读不到时按「不值得留」算（`NaN < 1024` 会是 false，那就成了「没读到缓存却当成
  // 缓存很值钱」，正好反了）。
  const worth = Number(record?.cacheRead)
  if (mode === 'off') why = 'off'
  else if (!had) why = 'sticky-new'
  else if (at < 0) why = 'gone'
  else if (resting?.has(list[at].id)) why = 'resting'
  else if (at > 0 && spent?.has(list[at].id)) why = 'spent'
  else if (mode === 'session') why = 'session'
  else if (within) why = 'turn'
  else if (mode === 'turn') why = 'sticky-miss'
  else if (!Number.isFinite(worth) || worth < CACHE_WORTH) why = 'cache-weak'
  else if (now - record.at > CACHE_COLD_MS) why = 'cache-cold'
  else why = 'sticky-hit'

  return {
    at,
    why,
    kept: why === 'session' || why === 'turn' || why === 'sticky-hit',
    accountId: had && at >= 0 ? list[at].id : undefined,
  }
}

/**
 * 手工拼的 domain spec（因为不能 import `defineDomain`，见文件头第 3 条）。
 *
 * `valueSchema` 只要有 `parse` 就够了——`open()` 读盘时逐条调它，抛错就是 `invalid-record`。
 * 这里**故意抛**而不是「修好它」：一条读不懂的记录就是读不懂，当成「没有这条记录」会让我们
 * 在下一次落盘时把它永久抹掉（magpie `LESSONS.md` 第 9 条）。真读到坏记录时，
 * `invalidRecords: 'backup-and-skip'` 会把它挪到一边再跳过。
 */
export function affinitySpec() {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    tables: {
      [TABLE_NAME]: {
        valueSchema: {
          parse(raw) {
            const record = parseRecord(raw)
            if (record === undefined) {
              throw new Error(`affinity: 这条记录读不懂（${JSON.stringify(raw)?.slice(0, 200) ?? String(raw)}）`)
            }
            return record
          },
        },
      },
    },
    invalidRecords: 'backup-and-skip',
  }
}

/**
 * 尽力而为地打开那张表。**打不开不是错误**：亲和是一条优化，读不到就当没有，
 * 顺序回到选号那一套。
 *
 * @returns {Promise<{table: object, close: () => Promise<void>}|undefined>}
 */
export async function openAffinityTable({ facility, log }) {
  if (!facility || typeof facility.open !== 'function') return undefined
  const domain = await facility.open(affinitySpec())
  const table = domain.table(TABLE_NAME)
  return {
    table,
    close: async () => {
      try {
        await domain.close()
      } catch (error) {
        log?.debug?.('account-bridge: 关闭 affinity domain 失败: %s', String(error?.message ?? error))
      }
    },
  }
}

/**
 * 记忆 + 落盘。**没接上表也能用**（纯内存），接上之后读写都过它。
 *
 * 写入攒 `debounceMs` 再落盘：一轮对话里可能同时有十几段会话在写，而这个后端是
 * 「整个 unit 一个 JSON 文件」，每次 `put` 都会重写一遍。
 */
export class AffinityBook {
  #table
  #memory = new Map()
  #dirty = new Set()
  #timer
  #closed = false
  #log
  #clock
  #debounceMs
  #flushing

  constructor({ log, now = Date.now, debounceMs = FLUSH_DEBOUNCE_MS } = {}) {
    this.#log = log
    this.#clock = now
    this.#debounceMs = debounceMs
  }

  get size() {
    return this.#memory.size
  }

  /**
   * 记着的键，按最近用到的排在后面（`Map` 的插入顺序）。
   *
   * 只读出口：给 `/pool sticky` 与测试看「到底记着哪几段会话」，
   * 别为了看一眼键就去动 `attach()`。
   */
  keys() {
    return [...this.#memory.keys()]
  }

  /** 记着的记录（键 → 记录），与 `keys()` 同一个顺序。 */
  entries() {
    return [...this.#memory.entries()]
  }

  get persisted() {
    return this.#table !== undefined
  }

  /** 接上盘上的表：先把存下来的读进内存，**内存里更新的赢**。 */
  attach(table) {
    this.#table = table
    if (table === undefined) return 0
    const now = this.#clock()
    let loaded = 0
    try {
      for (const [key, raw] of table.entries()) {
        const record = parseRecord(raw)
        if (record === undefined) {
          this.#dirty.add(key)
          continue
        }
        if (!isFresh(record, now)) {
          this.#dirty.add(key)
          continue
        }
        const existing = this.#memory.get(key)
        if (existing !== undefined && existing.at >= record.at) continue
        this.#memory.set(key, record)
        loaded += 1
      }
    } catch (error) {
      this.#log?.warn?.('account-bridge: 读取会话亲和记录失败: %s', String(error?.message ?? error))
    }
    return loaded
  }

  /** 上次是谁答的这段会话。过期的当没有。 */
  get(key, now = this.#clock()) {
    const record = this.#memory.get(key)
    return isFresh(record, now) ? record : undefined
  }

  remember(key, record) {
    this.#memory.set(key, record)
    this.#dirty.add(key)
    this.#schedule()
  }

  forget(key) {
    this.#memory.delete(key)
    this.#dirty.add(key)
    this.#schedule()
  }

  clear() {
    for (const key of this.#memory.keys()) this.#dirty.add(key)
    this.#memory.clear()
    this.#schedule()
  }

  /** 丢掉某一个族的所有记录（换代理、停用账号时用）。 */
  forgetPrefix(prefix) {
    let dropped = 0
    for (const key of [...this.#memory.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.#memory.delete(key)
      this.#dirty.add(key)
      dropped += 1
    }
    if (dropped > 0) this.#schedule()
    return dropped
  }

  /**
   * 丢掉指向某一个账号的记录（账号被删掉时用）。
   *
   * 为什么是「按账号」而不是「按族」：账号 id 是**会回收**的（`nextAccountId()` 取最小空号），
   * 所以删掉 `codex-2` 而不清记录，下次登录拿到的 `codex-2` 会继承上一段会话的粘性——
   * 那是个素不相识的账号。但也没必要把整个族的记录一起清掉：别的账号答过的会话
   * 与这次删除毫无关系，清了就是白烧它们的上游缓存。
   */
  forgetAccount(accountId) {
    let dropped = 0
    for (const [key, record] of [...this.#memory.entries()]) {
      if (record.accountId !== accountId) continue
      this.#memory.delete(key)
      this.#dirty.add(key)
      dropped += 1
    }
    if (dropped > 0) this.#schedule()
    return dropped
  }

  /** 立刻落盘（测试与收尾用）。**关掉之后不再写**——那时 `table` 的生命周期已经归别人了。 */
  async flush() {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (this.#closed) {
      await this.#flushing
      return
    }
    // 同时在飞的落盘只跑一次；失败留下的 `#dirty` 交给下一次（**不在这里重试**，
    // 否则一个一直写不进去的盘会让这里变成死循环）。
    this.#flushing ??= this.#runFlush().finally(() => {
      this.#flushing = undefined
    })
    await this.#flushing
    if (this.#dirty.size > 0) this.#schedule()
  }

  async #runFlush() {
    const keep = keepKeys(this.#memory, this.#clock())
    // 内存跟着裁：上限是「留最近答过的 N 段」，不是「无限期记住每一段」。
    // 被裁掉的也进 `#dirty`，于是盘上那条会被删掉——两边始终一致。
    for (const key of [...this.#memory.keys()]) {
      if (keep.has(key)) continue
      this.#memory.delete(key)
      this.#dirty.add(key)
    }
    const table = this.#table
    if (table === undefined) {
      // 没接上表：内存裁完就够了，没有盘要写。
      this.#dirty.clear()
      return
    }
    for (const key of [...this.#dirty]) {
      const record = this.#memory.get(key)
      try {
        if (record === undefined) await table.delete(key)
        else await table.put(key, record)
        this.#dirty.delete(key)
      } catch (error) {
        this.#log?.warn?.('account-bridge: 会话亲和落盘失败（%s）: %s', key, String(error?.message ?? error))
        // 下次再试；内存里的事实不丢（写不进去是盘的问题，不是「没有这段会话」）。
      }
    }
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    try {
      // 先等在飞的那一次（它也在写同一张表），再自己收一次尾。
      await this.#flushing?.catch(() => {})
      await this.#runFlush()
    } catch (error) {
      this.#log?.debug?.('account-bridge: 收尾时落盘失败: %s', String(error?.message ?? error))
    }
  }

  #schedule() {
    // **没接上表也要排**：`#runFlush` 在那种情况下仍然负责裁内存，
    // 否则纯内存模式会无限长下去。
    if (this.#closed || this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.flush().catch(() => {})
    }, this.#debounceMs)
    this.#timer?.unref?.()
  }
}
