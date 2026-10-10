/**
 * 流量闸门：每分钟请求数（MaxRPM）与并发数（MaxConcurrency）。
 *
 * 语义照 `yetone/magpie` 的 `internal/gateway/rpm.go` 与 `concurrency.go`（MIT，见
 * `THIRD_PARTY_NOTICES.md`）。要解决的问题有两类，都很具体：
 *
 * - **每账号每分钟的请求数**。OpenRouter 的免费模型是 20 rpm（magpie 里 coeo91 的原话），
 *   一个「一次只放一个并发」的限制根本管不住它——请求是排队发的，但一分钟里发了 40 个。
 * - **每账号同时挂着的请求数**。一个 Codex 账号并发五六个以上就会被风控（Lemon 的原话）。
 *   而我们这里并发是真实存在的：几个会话、几个子代理、加上面板点「检查」时的一串额度查询。
 *
 * **什么算一次请求**：凡是**真的发出去**的都算——重试、换到下一个账号、fallback、
 * 一次尝试途中的第二次请求，以及我们自己向 provider 发的那些（额度查询、目录刷新、
 * count_tokens）。这是 magpie 的原话，也是唯一说得通的口径：上游数的是它收到的包。
 *
 * **顺序**：先拿并发槽，**临发送前**才等分钟余量（`acquire()` 然后 `waitForRoom()`）。
 * 反过来先等分钟再抢并发槽，统计的就是「打算发」而不是「真的发」，一个卡在并发队列里
 * 的请求会白占掉一分钟里的一个位置。
 *
 * **等不了就不等**：要等的时间超过上限（默认 2 分钟）时**立刻**转开，错误里带上
 * 「什么时候能发」——调用方可以据此告诉用户，而不是把它挂在一个永远不会来的时刻上。
 * 转开**不惩罚任何账号**：这不是上游拒绝了我们，是我们自己排队排不下
 *（magpie 原文：*"a failure that rests nobody"*）。
 *
 * **放弃就归还**：调用方中途走了（用户按了停止），排队的位置立刻还回去，
 * 而且那个请求**永远不会被发出去**。
 */

/** 一个滚动窗口的长度。 */
export const RPM_WINDOW_MS = 60_000
/** 等分钟余量的上限：超过它就直接转开（不是继续等）。 */
export const RPM_LONGEST_WAIT_MS = 2 * 60_000
/** 等并发槽的上限。 */
export const LANE_WAIT_MS = 2 * 60_000
/** 每个账号最多排多少个等并发槽的请求，再多就直接转开。 */
export const LANE_QUEUE_LIMIT = 64
/** `Retry-After` 至少是 1 秒（0 会被一些客户端当成「马上重试」）。 */
export const RETRY_AFTER_MIN_S = 1

/**
 * 「现在别发，过一会儿再来」。
 *
 * `code` 是 `LOCAL_RATE_LIMIT` 而不是 `RATE_LIMIT`：后者在我们的冷却表里意味着
 * 「上游限流了这个账号」，会把账号停掉——而这个错误恰恰说明**包根本没出去**，
 * 惩罚账号是在冤枉它。
 */
export function turnedAway(who, limit, afterMs, waitMs, kind = 'rpm') {
  const seconds = Math.max(Math.ceil(afterMs / 1000), RETRY_AFTER_MIN_S)
  const what = kind === 'lane' ? '个请求同时挂着' : '个请求一分钟'
  const error = new Error(
    `${who}: ${limit} ${what}是上限，下一次最快还要 ${seconds} 秒，` +
      `比一个请求愿意等的时间（${Math.round(waitMs / 1000)} 秒）更久`,
  )
  error.code = 'LOCAL_RATE_LIMIT'
  error.who = who
  error.limit = limit
  error.kind = kind
  /** 还要多久才发得出去（毫秒）。 */
  error.afterMs = afterMs
  /** 调用方该等多久——`Retry-After` 的那个数，向上取整到秒。 */
  error.retryAfterSeconds = seconds
  /** 我们愿意等多久（就是它超了这个才被转开的）。 */
  error.waitMs = waitMs
  // 宿主只认 `error.failure` 里那个自带快照（见 `src/failure.js`）：不挂这一份，
  // 失败码到宿主面上就变成 `UNKNOWN`，「等一会儿再来」这句话就传不到 UI。
  error.failure = { message: error.message, code: error.code, providerRetryAfterMs: Math.max(afterMs, 1000) }
  return error
}

/** 归还槽位用的空函数（没有限制时）。 */
const NOOP = () => {}

/**
 * 闸门本体。
 *
 * 时间是可注入的：`windowMs` / `longestWaitMs` / `laneWaitMs` 都能在构造时缩短，
 * 测试因此不用真的等一分钟。这不是为了测试方便——`magpie` 自己也是这么做的
 * （`rpmWindow` 与 `rpmLongest` 是包级变量，注释写明「tests shorten them」）。
 */
export class Gate {
  /** @type {Map<string, number[]>} who → 已经（或即将）发出的时刻，升序 */
  #rpm = new Map()
  /** @type {Map<string, {limit: number, busy: number, waiting: object[]}>} */
  #lanes = new Map()
  /** @type {Map<string, number>} who → 最后一次见到的 rpm 上限（只给面板看） */
  #rpmLimits = new Map()
  /**
   * @type {Map<string, number>} who → 最后一次见到的并发上限。
   *
   * 与 `#rpmLimits` 同一个理由：车道对象在空闲时会被删掉（不然 `#lanes` 会一直长），
   * 而面板问「这个账号最多几个并发」时应该拿到 `2` 而不是 `0`。**上限是配置，不是状态**，
   * 所以它要活得比车道久。
   */
  #laneLimits = new Map()
  #windowMs
  #longestWaitMs
  #laneWaitMs
  #queueLimit

  constructor(options = {}) {
    this.#windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : RPM_WINDOW_MS
    this.#longestWaitMs =
      Number(options.longestWaitMs) > 0 ? Number(options.longestWaitMs) : RPM_LONGEST_WAIT_MS
    this.#laneWaitMs = Number(options.laneWaitMs) > 0 ? Number(options.laneWaitMs) : LANE_WAIT_MS
    this.#queueLimit = Number(options.queueLimit) > 0 ? Number(options.queueLimit) : LANE_QUEUE_LIMIT
  }

  get windowMs() {
    return this.#windowMs
  }

  // ---------------------------------------------------------------- 每分钟

  /** 窗口里还剩下几次（`who` 此刻被计数的请求数）。 */
  rpmUsed(who, now = Date.now()) {
    return this.#prune(who, now).length
  }

  /** 这个账号此刻发了会不会立刻走（不排队）。 */
  rpmFree(who, limit, now = Date.now()) {
    if (!(limit > 0)) return true
    return this.rpmUsed(who, now) < limit
  }

  /**
   * 占一个位置（**不是**等待）。
   *
   * 返回 `{at, afterMs}`：`at` 是它该发的时刻，`afterMs` 是还要等多久（0 = 立刻）。
   * 要等的时间超过上限时返回 `{turnedAway: Error}` 并且**什么都不占**。
   */
  reserve(who, limit, longestMs, now = Date.now()) {
    if (!(limit > 0)) return { at: now, afterMs: 0 }
    this.#rpmLimits.set(who, limit)
    const times = this.#prune(who, now)
    // 窗口里满了：下一个要等到「窗口里倒数第 limit 个」满一分钟。因为时刻只增不减，
    // 这个列表天然是升序的，不用排序。
    let at = now
    if (times.length >= limit) at = times[times.length - limit] + this.#windowMs
    const afterMs = at - now
    const bound = Number(longestMs) > 0 ? Number(longestMs) : this.#longestWaitMs
    if (afterMs > bound) {
      return { turnedAway: turnedAway(who, limit, afterMs, bound, 'rpm') }
    }
    times.push(at)
    this.#rpm.set(who, times)
    return { at, afterMs }
  }

  /** 把没用到的那次占位还回去（调用方走了）。 */
  giveBack(who, at) {
    const times = this.#rpm.get(who)
    if (!times) return
    for (let i = times.length - 1; i >= 0; i -= 1) {
      if (times[i] === at) {
        times.splice(i, 1)
        break
      }
    }
    if (times.length === 0) {
      this.#rpm.delete(who)
      this.#rpmLimits.delete(who)
    }
  }

  /**
   * 等到这个账号的分钟里有位置，并把自己计进去。
   *
   * 中途被放弃（`signal` 结束）时**把位置还回去**——一个没发出去的请求不该占着配额。
   * `sleep` 由调用方注入是刻意的：测试里用假时钟就不必真的等一分钟。
   */
  async waitForRoom({ who, limit, longestMs, signal, now = Date.now(), sleep = defaultSleep } = {}) {
    if (!(limit > 0)) return { waitedMs: 0, at: now }
    const reserved = this.reserve(who, limit, longestMs, now)
    if (reserved.turnedAway) throw reserved.turnedAway
    const waitMs = reserved.at - now
    if (waitMs <= 0) return { waitedMs: 0, at: reserved.at }
    try {
      await sleep(waitMs, signal)
    } catch (error) {
      this.giveBack(who, reserved.at)
      throw error
    }
    return { waitedMs: waitMs, at: reserved.at }
  }

  // ------------------------------------------------------------------ 并发

  /** 这个账号此刻有没有空着的并发槽。 */
  laneFree(who, limit) {
    if (!(limit > 0)) return true
    const lane = this.#lanes.get(who)
    return !lane || lane.busy < limit
  }

  /**
   * 拿一个并发槽。拿不到就**按先来后到排队**（这正是这个限制的意义：上游看到的
   * 永远不超过这么多），队满或等太久才转开。
   *
   * 返回 `release()`；调用方**必须**在请求结束时调一次（流读完、或者调用方走了）。
   */
  async acquire({ who, limit, signal, waitMs, queueLimit } = {}) {
    if (!(limit > 0)) return NOOP
    const lane = this.#lane(who, limit)
    if (lane.busy < lane.limit) {
      lane.busy += 1
      return this.#releaseFor(who, lane)
    }
    const bound = Number(waitMs) > 0 ? Number(waitMs) : this.#laneWaitMs
    const cap = Number(queueLimit) > 0 ? Number(queueLimit) : this.#queueLimit
    if (lane.waiting.length >= cap) {
      throw turnedAway(who, lane.limit, bound, bound, 'lane')
    }
    // 已经放弃的调用方**不进队列**。放在 push 之前是必须的：`AbortSignal` 的 abort 事件
    // 只会叫醒「已经挂上监听」的人，而我们是在新建 promise 时才挂监听——一个在进到这里
    // 之前就 abort 的信号永远不会再触发回调。先 push 再检查的话，队里会留下一个**已经
    // settle 的僵尸条目**：归还槽位时 `handoff()` 被 `settled` 挡掉，那个槽就**永久丢了**。
    // （就绪的 `signal.aborted` 只可能在别的任务里变，所以这里的检查与下面的 push 之间
    // 不会被 abort 插进来。）
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined, onAbort: undefined, settled: false }
      const settle = (fn, value) => {
        if (entry.settled) return
        entry.settled = true
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        entry.onAbort && signal?.removeEventListener?.('abort', entry.onAbort)
        fn(value)
      }
      entry.handoff = () => settle(resolve, this.#releaseFor(who, lane))
      entry.refuse = (error) => settle(reject, error)
      entry.timer = setTimeout(() => {
        this.#unqueue(lane, entry)
        entry.refuse(turnedAway(who, lane.limit, bound, bound, 'lane'))
      }, bound)
      if (signal) {
        entry.onAbort = () => {
          this.#unqueue(lane, entry)
          entry.refuse(signal.reason ?? new Error('aborted'))
        }
        signal.addEventListener?.('abort', entry.onAbort, { once: true })
      }
      lane.waiting.push(entry)
    })
  }

  /** 这个账号现在的并发占用与排队人数（面板用）。 */
  laneState(who) {
    const lane = this.#lanes.get(who)
    // 车道没了（空闲）也要报出上限——见 `#laneLimits`。
    if (!lane) return { busy: 0, waiting: 0, limit: this.#laneLimits.get(who) ?? 0 }
    return { busy: lane.busy, waiting: lane.waiting.length, limit: lane.limit }
  }

  /** 给面板/`/pool status` 的一眼快照。 */
  snapshot(now = Date.now()) {
    const who = new Set([...this.#rpm.keys(), ...this.#lanes.keys(), ...this.#rpmLimits.keys(), ...this.#laneLimits.keys()])
    const rows = []
    for (const key of who) {
      const lane = this.laneState(key)
      rows.push({
        who: key,
        rpm: this.rpmUsed(key, now),
        rpmLimit: this.#rpmLimits.get(key) ?? 0,
        busy: lane.busy,
        waiting: lane.waiting,
        laneLimit: lane.limit,
      })
    }
    return rows
  }

  /** 账号被删掉时把它的记录一并清掉（不然面板上会留一行幽灵）。 */
  forget(who) {
    this.#rpm.delete(who)
    this.#rpmLimits.delete(who)
    this.#laneLimits.delete(who)
    const lane = this.#lanes.get(who)
    if (lane) {
      for (const entry of lane.waiting.splice(0)) entry.refuse?.(new Error('account removed'))
      if (lane.busy <= 0) this.#lanes.delete(who)
    }
  }

  // ---------------------------------------------------------------- 内部

  #prune(who, now) {
    const times = this.#rpm.get(who)
    if (!times) return []
    let i = 0
    // 丢掉「窗口之前」的：`<= now - window` 都不算了（与 magpie 的 `!After` 同义）。
    while (i < times.length && times[i] <= now - this.#windowMs) i += 1
    if (i === 0) return times
    const kept = times.slice(i)
    if (kept.length === 0) {
      this.#rpm.delete(who)
      return []
    }
    this.#rpm.set(who, kept)
    return kept
  }

  #lane(who, limit) {
    let lane = this.#lanes.get(who)
    this.#laneLimits.set(who, limit)
    if (!lane) {
      lane = { limit, busy: 0, waiting: [] }
      this.#lanes.set(who, lane)
    } else {
      lane.limit = limit
    }
    return lane
  }

  /**
   * 归还一个槽位。
   *
   * 有人排队时把槽位**直接交给队首**（`busy` 不变）——这正是「排队而不是失败」的写法：
   * 等着的那位不会被判成失败，也不会去换账号，它只是晚一点发。
   */
  #releaseFor(who, lane) {
    let released = false
    return () => {
      if (released) return
      released = true
      // 队首可能是**已经 settle 的**（它放弃了，但还没来得及离开队，或者我们在别处
      // 补了一刀）。把槽交给一个不会再有人接收的条目，等于**永久丢掉一个槽**——
      // 所以跳过它们，找第一个还活着的。
      let next = lane.waiting.shift()
      while (next?.settled) next = lane.waiting.shift()
      if (next) {
        next.handoff()
        return
      }
      lane.busy -= 1
      if (lane.busy <= 0 && lane.waiting.length === 0) this.#lanes.delete(who)
    }
  }

  #unqueue(lane, entry) {
    const at = lane.waiting.indexOf(entry)
    if (at >= 0) lane.waiting.splice(at, 1)
  }
}

/** 默认的等待实现（测试可以换掉）。 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
