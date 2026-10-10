/**
 * 上游的拒绝到底在说什么——**一套词表，两条通道**。
 *
 * 为什么单独一个模块：同一个 429 会经过两条独立的路——
 *
 * 1. `src/wire/http-error.js` 的 `mapStatus()` 拿它定 `error.code`，那是**宿主与用户
 *    看得见的**那个码（它进 `finish.reason.failure.code`，也进面板的错误行）。
 * 2. `src/health.js` 的 `classifyFailure()` 拿它决定**停哪个号、停多久**。
 *
 * 这两条路各写一份词表就会漂移，而漂移的表现是最难查的那一类：屏幕上写着 `RATE_LIMIT`
 * 而账号被按「余额不足」冻了半小时。真机验收里就是这么发现的（Zhipu 的 GLM Coding Plan
 * 用「余额不足或无可用资源包，请充值」回 429）。
 *
 * 所以词表住在这里，两边都从这里取。放在 `wire/` 而不是 `health.js`，是为了不让协议层
 * 反向依赖策略层（`health.js` import 它，而不是反过来）。
 *
 * 词表与判定顺序照抄 magpie（`internal/gateway/routing.go:110-133` 与 `failure()`），
 * 来源、基线提交与四处改写见 `THIRD_PARTY_NOTICES.md` 的「借用的代码 → magpie」。
 * 顺序是硬要求，三个坑都有人踩过：
 * - **限流词先于额度词**，且限流那一支还要求不命中「按天 / 按周」的词。magpie #153：
 *   某家的 429 文本里限流与「达到上限」并存，额度词表先命中，于是每个这种 429 都停了
 *   十五分钟而不是一分钟。
 * - **`credit` 词命中 429 时，还要同时命中更窄的 `broke` 词**才算没钱。Zhipu 的 GLM
 *   Coding Plan 用「余额不足或无可用资源包，请充值」回 429，那是真没钱；而 Anthropic 的
 *   「extra usage required」里也有 credit 字样，它却是额度问题。
 * - 只写 `reached` / `exceeded` **不算证据**——`Rate limit exceeded` 里就有。
 */

/** 「现在别来」的状态码。magpie 只认 429；503/529 也常在说同一件事。 */
export const THROTTLED_STATUS = new Set([429, 503, 529])

/* eslint-disable no-useless-escape */
const CREDIT_WORDS = /insufficient.?(balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(不足|停)/i
/** `credit` 词里更窄的那一半：真的没钱了，不是「有额度但需要额外付费」。 */
const BROKE_WORDS = /insufficient.?(balance|credit|fund)|out of (credits?|funds?|balance)|no (credits?|funds?|balance)|余额不足|欠费|请充值/i
const RATE_WORDS = /rate.?limit|too many requests|per.?(second|sec|minute|min)\b|\b[rt]pm\b|频率|太频繁/i
/** 「按天 / 按周 / 按月」的词：限流那一支只要命中它就退让（magpie #153）。 */
const PLANNED_WORDS = /quota|usage.?limit|hit your .*limit|limit.{0,24}resets|per.?(day|week|month)|daily|weekly|monthly|额度|用量|套餐|限额已用完|extra usage/i
const USED_UP_WORDS = /quota|usage.?limit|out of budget|budget (exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限|extra usage/i
/* eslint-enable no-useless-escape */

/**
 * @param {number|undefined} status HTTP 状态
 * @param {string} text 上游原文（我们的 `error.message` 已经内嵌了它）
 * @returns {'credit'|'quota'|'rate'|undefined} 说不出来就是 undefined
 */
export function failureWords(status, text) {
  const body = String(text ?? '')
  // 429 与 5xx 都是「现在别来」，文本里的限流 / 额度词才算数；别的状态只认硬证据。
  const throttled = status === undefined || THROTTLED_STATUS.has(status)
  if (
    status === 402 ||
    body.includes('insufficient_quota') ||
    (CREDIT_WORDS.test(body) && (!throttled || BROKE_WORDS.test(body)))
  ) {
    return 'credit'
  }
  if (throttled && RATE_WORDS.test(body) && !PLANNED_WORDS.test(body)) return 'rate'
  if (USED_UP_WORDS.test(body) || (throttled && PLANNED_WORDS.test(body))) return 'quota'
  if (throttled) return 'rate'
  return undefined
}
