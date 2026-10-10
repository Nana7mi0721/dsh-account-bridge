/**
 * 账号选择：把候选排成一个确定的顺序，并说清**为什么**是它。
 *
 * 这个文件是**纯函数**：不读时钟以外的状态、不发请求、不 import 本仓任何模块。
 * 池子负责把额度读数、沉底序号、近期用量喂进来，也负责在失败时更新它们。
 *
 * 语义全部来自 magpie（MIT）的 `internal/gateway/routing.go` 与 `internal/gateway/sink.go`，
 * 来源、基线提交与四处改写见 `THIRD_PARTY_NOTICES.md` 的「借用的代码 → magpie」。
 *
 * ## 为什么不能只按 id 排
 *
 * 之前是 `usable.sort((a, b) => a.account.id.localeCompare(b.account.id))`：所有请求都压
 * 在字典序第一个账号上，直到它吃 429 才换下一个。上游看到的是一个账号被打满、然后
 * 突然安静——这正是风控最容易注意到的那种形状。
 *
 * ## 判定顺序（先比第一条，分不出来才看下一条）
 *
 * 1. `learns` —— 额度未知、而且这一族有办法把额度说出来：先让它答一次，只一次。
 *    否则它永远排在已知账号后面，也就永远不会被知道。
 * 2. `bucket` —— 按**最满的那个窗口**分三档：<90% 可用 / 90–97% 快满 / ≥98% 已满。
 *    已满的沉到最后（不剔除：只剩它时照样试）。
 * 3. `allowance` —— 同一档（且都不是「可用」档）里，用得更少的先上。
 * 4. `pace` —— 「可用」档里按**剩余额度能撑多久**分档，撑得久的先上；相差不到十分之一
 *    算同一档（见下）。
 * 5. `resets` —— 同档里重置更早的先上。**只比到小时**：差几分钟就重排会让账号来回抖。
 * 6. `recent-use` —— 近期用得少的先上。
 * 7. `tie-break` —— 完全并列时按 id，只为让顺序确定，不再决定谁先上。
 *
 * 最后再叠一层 Sink：被限流过（还有额度却吃 429）的账号整体沉到末尾，沉得早的排在
 * 沉得晚的前面。
 *
 * ## 两个「必须这么写」的地方
 *
 * - **重置时间截断到小时**（`Math.trunc(t / HOUR)`）：13:55 与 14:05 是不同小时，
 *   14:05 与 14:55 是同一小时。不截断的话上游把重置时间往前挪几分钟，整排名就变了。
 * - **「相差不到十分之一算一档」必须先离散成整数 band 再排序**。「相差不到十分之一」
 *   是非传递关系：三个 pace 各差十二分之一就会绕圈（a>b>c>a），直接塞进比较器会让
 *   排序结果依赖于比较顺序。magpie 的注释专门记了这条。
 */

const HOUR = 3_600_000

/** 「可用」档的上界：到这个百分比就不算宽裕了。 */
export const LOW_SHARE = 90
/** 「已满」档的下界：到这个百分比就当它用完了。 */
export const SPENT_SHARE = 98
/** pace 相差不到这个比例，算同一档。 */
export const PACE_ALIKE = 0.9
/** 额度未知的账号，按「整整一周都还没用」来估。 */
export const FRESH_PACE = 100 / (7 * 24)
/** 近期用量的半衰期：一小时前的用量算一半，两小时前算四分之一。 */
export const USAGE_HALF_LIFE_MS = HOUR

/**
 * @typedef {object} AllowanceWindow
 * @property {number} used        已用百分比 0..100
 * @property {number} [resetsAt]  重置时刻（epoch ms）；缺省 = 不知道什么时候重置
 */

/**
 * @typedef {object} Candidate
 * @property {string} id              账号 id（稳定、唯一）
 * @property {AllowanceWindow[]} [windows]  额度窗口；缺省或空 = 额度未知
 * @property {boolean} [learns]       额度未知、但这一族会把额度说出来，且我们还没问过
 * @property {number} [usedRecently]  近期用量（已按半衰期衰减过的数）
 * @property {number} [sunk]          沉的序号，>0 表示沉过；0/缺省 = 没沉过
 */

/** 一个窗口的已用比例，缺省或非有限数都当「不知道」。 */
function usedOf(window) {
  const used = Number(window?.used)
  return Number.isFinite(used) ? Math.min(100, Math.max(0, used)) : undefined
}

/**
 * 一个账号**最满**的那个窗口的已用比例（0..100）；没有任何窗口 = 额度未知。
 *
 * 取最满的那个：一周窗口用了 10% 而 5 小时窗口用了 99%，这个账号现在就是不能用了。
 */
export function shareOf(candidate) {
  let share
  for (const window of candidate?.windows ?? []) {
    const used = usedOf(window)
    if (used === undefined) continue
    if (share === undefined || used > share) share = used
  }
  return share
}

/** 分档：0 = 可用，1 = 快满，2 = 已满。额度未知按「可用」档。 */
export function tierOf(share) {
  if (share === undefined) return 0
  if (share >= SPENT_SHARE) return 2
  if (share >= LOW_SHARE) return 1
  return 0
}

/**
 * 剩余额度还能撑多久（百分点/小时）。**越小越宽裕**。
 *
 * 每个窗口各算一个 `(100 - used) / max(距离重置, 1 小时)`，取**最小**的那个：
 * 最紧的那个窗口决定这个账号还能不能撑。分母有个 1 小时的下限，否则「马上就重置」
 * 会让 pace 冲到无穷大，把一个刚重置完的账号排到最后。
 *
 * 拿到多个窗口时按「重置时刻最远的先比」来近似「最大的窗口先比」——我们拿不到窗口
 * 跨度，而周窗口的重置时刻几乎总是比 5 小时窗口远。
 *
 * 额度未知 ⇒ `FRESH_PACE`（按「整整一周都还没用」估）。magpie 的选择：
 * 一个我们不了解的账号，宁可给它一次机会，也不要让它永远排在已知账号后面。
 */
export function paceOf(candidate, now = Date.now()) {
  const windows = candidate?.windows ?? []
  let pace
  for (const window of windows) {
    const used = usedOf(window)
    if (used === undefined) continue
    const until = Number.isFinite(window?.resetsAt) ? Math.max(window.resetsAt - now, HOUR) : HOUR
    const hours = until / HOUR
    const value = (100 - used) / hours
    if (pace === undefined || value < pace) pace = value
  }
  return pace ?? FRESH_PACE
}

/** 各窗口的重置时刻，**远的在前**（近似「窗口大的在前」）。 */
function soonOf(candidate) {
  const soon = []
  for (const window of candidate?.windows ?? []) {
    if (Number.isFinite(window?.resetsAt)) soon.push(window.resetsAt)
  }
  return soon.sort((a, b) => b - a)
}

function compareIds(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 一次性算出每个候选的派生成分，避免比较器里反复重算。
 *
 * `band` 的构造照抄 magpie：先把「可用」档里**不是** learns 的候选按 pace 从大到小
 * 排一遍，再从头扫，只有 pace 低于当前 band 最高值九成时才算新的一档。**先离散成整数、
 * 再拿整数去排序**，这是不绕圈的唯一办法。
 */
function analyse(candidates, now) {
  const facts = new Map()
  for (const candidate of candidates) {
    const share = shareOf(candidate)
    facts.set(candidate, {
      tier: tierOf(share),
      share,
      learns: candidate?.learns === true,
      pace: paceOf(candidate, now),
      soon: soonOf(candidate),
      band: 0,
    })
  }

  const byPace = candidates.filter((candidate) => {
    const fact = facts.get(candidate)
    return fact.tier === 0 && !fact.learns
  })
  byPace.sort((a, b) => facts.get(b).pace - facts.get(a).pace)

  let top = 0
  let band = 0
  byPace.forEach((candidate, index) => {
    const fact = facts.get(candidate)
    if (index === 0 || fact.pace < PACE_ALIKE * top) {
      top = fact.pace
      if (index > 0) band += 1
    }
    fact.band = band
  })

  return facts
}

/** 逐条判据，返回 `[名字, 比较函数]`。比较函数返回负数表示 a 先上。 */
function criteria(facts) {
  const fact = (candidate) => facts.get(candidate)
  return [
    // 1. 额度未知但会自报：先答一次
    ['learns', (a, b) => Number(fact(b).learns) - Number(fact(a).learns)],
    // 2. 三档
    ['bucket', (a, b) => fact(a).tier - fact(b).tier],
    // 3. 同一档（快满/已满）里用得更少的先上
    [
      'allowance',
      (a, b) => {
        if (fact(a).tier === 0 || fact(b).tier === 0) return 0
        return fact(a).share - fact(b).share
      },
    ],
    // 4. 「可用」档里按剩余额度撑多久分档
    [
      'pace',
      (a, b) => {
        if (fact(a).tier !== 0 || fact(b).tier !== 0) return 0
        return fact(a).band - fact(b).band
      },
    ],
    // 5. 重置更早的先上，只比到小时
    [
      'resets',
      (a, b) => {
        const left = fact(a).soon
        const right = fact(b).soon
        const rounds = Math.max(left.length, right.length)
        for (let k = 0; k < rounds; k += 1) {
          // 只比到小时：差几分钟不重排
          const x = left[k] === undefined ? undefined : Math.trunc(left[k] / HOUR)
          const y = right[k] === undefined ? undefined : Math.trunc(right[k] / HOUR)
          if (x === y) continue
          // 不知道的排在知道的之后
          if (x === undefined) return 1
          if (y === undefined) return -1
          return x < y ? -1 : 1
        }
        return 0
      },
    ],
    // 6. 近期用得少的先上
    ['recent-use', (a, b) => Number(a?.usedRecently ?? 0) - Number(b?.usedRecently ?? 0)],
    // 7. 完全并列时按 id，只为确定性
    ['tie-break', (a, b) => compareIds(String(a?.id ?? ''), String(b?.id ?? ''))],
  ]
}

/** 返回让 a 排在 b 前面的第一条判据名；完全并列返回 `'tie-break'`。 */
function firstWord(facts, a, b) {
  for (const [name, compare] of criteria(facts)) {
    if (compare(a, b) !== 0) return name
  }
  return 'tie-break'
}

/**
 * 把沉过的候选整体移到末尾：**没沉的都在最前，沉的按沉的先后**，其余保持给定顺序。
 * 沉的账号只有在它前面的也都被限流过之后，才会回到最前——负载就这样转起来，
 * 而不是「冷却一结束就又灌满同一个账号」。
 */
export function sinkOrder(order) {
  const ready = []
  const resting = []
  for (const candidate of order) {
    if (Number(candidate?.sunk ?? 0) > 0) resting.push(candidate)
    else ready.push(candidate)
  }
  // Array.prototype.sort 是稳定的，序号相同时保持 routing 给出的相对顺序
  resting.sort((a, b) => a.sunk - b.sunk)
  return [...ready, ...resting]
}

/**
 * 排序全部候选。不改入参，返回一份新数组。
 *
 * @param {Candidate[]} candidates
 * @param {number} [now]
 * @returns {{order: Candidate[], chosen: Candidate|undefined, why: string}}
 *   `why` 是让 `chosen` 排第一的那条判据名（见文件头），
 *   加两个特殊值：只有一个候选是 `'only'`，全是沉的所以只能挑最早的沉号是 `'sunk'`。
 */
export function rankCandidates(candidates, now = Date.now()) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { order: [], chosen: undefined, why: 'none' }
  }
  const facts = analyse(candidates, now)
  const ranked = sinkOrder([...candidates].sort((a, b) => {
    for (const [, compare] of criteria(facts)) {
      const verdict = compare(a, b)
      if (verdict !== 0) return verdict
    }
    return 0
  }))

  let why
  if (ranked.length === 1) why = 'only'
  else if (Number(ranked[0]?.sunk ?? 0) > 0) why = 'sunk'
  else why = firstWord(facts, ranked[0], ranked[1])

  return { order: ranked, chosen: ranked[0], why }
}

/**
 * 把一次新的用量并进「近期用量」：旧值先按半衰期衰减，再加上这一次的。
 *
 * 权重是 `2^(-Δt/半衰期)`（一小时前的算一半，两小时前的算四分之一），O(1) 内存、
 * 没有窗口边界——比滑动窗口好实现，也不会在窗口滑过时突然跳变。
 */
export function decayUsage(previous, now, added = 1) {
  const weight = Number(previous?.weight ?? 0)
  const at = Number(previous?.at ?? now)
  const elapsed = Math.max(now - at, 0)
  const carried = Number.isFinite(weight) && weight > 0 ? weight * 2 ** (-elapsed / USAGE_HALF_LIFE_MS) : 0
  return { at: now, weight: carried + Math.max(0, Number(added) || 0) }
}

/** 读出一个（已衰减的）近期用量现值。 */
export function usageNow(entry, now) {
  const weight = Number(entry?.weight ?? 0)
  if (!Number.isFinite(weight) || weight <= 0) return 0
  const elapsed = Math.max(now - Number(entry?.at ?? now), 0)
  return weight * 2 ** (-elapsed / USAGE_HALF_LIFE_MS)
}
