/**
 * 冷却表的时长算术（P7-W3）。
 *
 * 这一份钉的是 magpie `internal/gateway/routing.go` 里那几条用事故换来的规则：
 * 上游自己说的退避只信一小时、反复失败要退避、还在冷却里再失败不拉长退避、
 * 「余额不足」与「额度用尽」不是一回事。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BACKOFF_BASE_MS,
  COOLDOWN,
  CooldownTable,
  LONGEST_QUOTA_MS,
  LONGEST_RATE_REST_MS,
  LONGEST_RETRY_MS,
  LONGEST_WAIT_MS,
  REST_FORGET_MS,
  classifyFailure,
  failureWords,
} from '../src/health.js'
import { httpError, mapStatus } from '../src/wire/http-error.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** 一个最小可用的上游响应，只带 `httpError` 会读的那两个字段。 */
function reply(status, headers = {}) {
  return { status, headers: new Headers(headers) }
}

/** 造一条 `RATE_LIMIT` 裁决（真实路径是 `httpError` → `classifyFailure`）。 */
function rateVerdict(retryAfterMs) {
  return classifyFailure(
    { code: 'RATE_LIMIT', message: 'x: HTTP 429 too many requests', ...(retryAfterMs === undefined ? {} : { failure: { providerRetryAfterMs: retryAfterMs } }) },
    'codex',
  )
}

// --------------------------------------------------------------- 退避

test('repeated rate limits back off, and stop growing at the cap', () => {
  const table = new CooldownTable()
  const verdict = rateVerdict()
  // 每一次都等到上一次冷却结束再失败（这就是「它一恢复就又被限流」的样子）。
  const seen = []
  let now = 0
  for (let i = 0; i < 8; i += 1) {
    seen.push(table.record('codex', 'codex-1', 'gpt-5', verdict, now))
    now += seen.at(-1) + 1_000
  }
  assert.deepEqual(seen.slice(0, 4), [MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE])
  // 单调不减，且**一个都不超过**上限。
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1], `${i}: ${seen}`)
  assert.ok(seen.every((ms) => ms <= LONGEST_RATE_REST_MS), `over cap: ${seen}`)
  assert.equal(seen.at(-1), LONGEST_RATE_REST_MS)
})

test('failing again while still resting does not stretch the backoff', () => {
  // magpie 原文：one request's own retries don't stretch it。少了这条，调用方
  // 重试三次就能把一个账号从一分钟停到八分钟。
  const table = new CooldownTable()
  const verdict = rateVerdict()
  assert.equal(table.record('codex', 'codex-1', 'gpt-5', verdict, 0), MINUTE)
  assert.equal(table.record('codex', 'codex-1', 'gpt-5', verdict, 1_000), MINUTE)
  assert.equal(table.record('codex', 'codex-1', 'gpt-5', verdict, 2_000), MINUTE)
  // 冷却一结束又失败，这才算第二次。
  assert.equal(table.record('codex', 'codex-1', 'gpt-5', verdict, MINUTE + 3_001), 2 * MINUTE)
})

test('a rate limit long after the last rest ended is a new one, a minute again', () => {
  const table = new CooldownTable()
  const verdict = rateVerdict()
  table.record('codex', 'codex-1', 'gpt-5', verdict, 0)
  table.record('codex', 'codex-1', 'gpt-5', verdict, MINUTE + 1) // ⇒ 2 分钟
  const later = MINUTE + 1 + 2 * MINUTE + REST_FORGET_MS + 1
  assert.equal(table.record('codex', 'codex-1', 'gpt-5', verdict, later), MINUTE)
})

test('transient failures back off too, up to their own lower cap', () => {
  const table = new CooldownTable()
  const verdict = classifyFailure({ code: 'SERVER', message: 'x: HTTP 500 boom' }, 'codex')
  assert.equal(verdict.backoff, 'transient')
  const seen = []
  let now = 0
  for (let i = 0; i < 8; i += 1) {
    seen.push(table.record('codex', 'codex-1', 'gpt-5', verdict, now))
    now += seen.at(-1) + 1_000
  }
  assert.equal(seen[0], MINUTE)
  assert.ok(seen.every((ms) => ms <= LONGEST_RETRY_MS), `over cap: ${seen}`)
  assert.equal(seen.at(-1), LONGEST_RETRY_MS)
})

test('the two backoffs are counted separately', () => {
  // 一次 500 不该把限流的退避垫高：它们是两件不同的事。
  const table = new CooldownTable()
  const server = classifyFailure({ code: 'SERVER', message: 'x: HTTP 500 boom' }, 'codex')
  table.record('codex', 'codex-1', 'gpt-5', server, 0)
  table.record('codex', 'codex-1', 'gpt-5', server, MINUTE + 1)
  table.clear('codex', 'codex-1', 'gpt-5')
  assert.equal(table.record('codex', 'codex-1', 'gpt-5', rateVerdict(), 0), MINUTE)
})

// --------------------------------------------------------------- 上游自己说的时间

test('an upstream that says "come back in a week" is only believed for an hour', () => {
  // magpie #147：一个 21:34 才恢复的账号被判成「59 分钟后再来」，于是它被试、被拒、
  // 又被停——三轮都没等到真正恢复的那一刻。
  const error = httpError(reply(429, { 'retry-after': '604800' }), '{"error":{"message":"slow down"}}', 'codex')
  assert.equal(error.failure.providerRetryAfterMs, 7 * 24 * HOUR, 'the raw hint is kept as the upstream gave it')
  const verdict = classifyFailure(error, 'codex')
  assert.equal(verdict.retryAfterMs, LONGEST_WAIT_MS)
  assert.equal(new CooldownTable().record('codex', 'codex-1', 'gpt-5', verdict, 0), HOUR)
})

test('a quota reset a week out is capped, and never exceeds the quota ceiling', () => {
  const error = httpError(reply(429, { 'retry-after': '604800' }), '{"error":{"message":"you are out of quota"}}', 'codex')
  assert.equal(error.code, 'QUOTA')
  const verdict = classifyFailure(error, 'codex')
  assert.equal(verdict.reason, 'QUOTA')
  assert.equal(verdict.cooldownMs, HOUR)
  assert.ok(verdict.cooldownMs <= LONGEST_QUOTA_MS)
})

test('a Retry-After shorter than the backoff is ignored', () => {
  // 退避是我们自己算出来的下限，上游说「一秒后」没有意义。
  const table = new CooldownTable()
  table.record('codex', 'codex-1', 'gpt-5', rateVerdict(1_000), 0)
  const second = table.record('codex', 'codex-1', 'gpt-5', rateVerdict(1_000), MINUTE + 1)
  assert.equal(second, 2 * MINUTE)
  // 反过来，比退避长的就听它的。
  const third = table.record('codex', 'codex-1', 'gpt-5', rateVerdict(20 * MINUTE), 2 * MINUTE + MINUTE + 2)
  assert.equal(third, 20 * MINUTE)
})

test('quota failures with no word from the upstream wait one window', () => {
  const verdict = classifyFailure({ code: 'QUOTA', message: 'q: HTTP 429 out of quota' }, 'codex')
  assert.equal(verdict.cooldownMs, COOLDOWN.quota)
  assert.equal(verdict.cooldownMs, 15 * MINUTE)
})

// --------------------------------------------------------------- 文本分流

test('"Rate limit exceeded" is a rate limit, not an exhausted quota', () => {
  // magpie #153：额度词表先命中，于是每个这种 429 都停了十五分钟而不是一分钟。
  assert.equal(mapStatus(429, 'Rate limit exceeded'), 'RATE_LIMIT')
  const verdict = classifyFailure({ code: 'RATE_LIMIT', message: 'x: HTTP 429 Rate limit exceeded' }, 'claude')
  assert.equal(verdict.reason, 'RATE_LIMIT')
  assert.equal(verdict.cooldownMs, MINUTE)
  assert.equal(new CooldownTable().record('claude', 'claude-1', 'm', verdict, 0), MINUTE)
})

test('a 429 that says the balance is empty is out of credit, not rate limited', () => {
  // Zhipu 的 GLM Coding Plan 用这句话回 429。只看状态码，那只是一次限流。
  const verdict = classifyFailure(
    { code: 'RATE_LIMIT', message: 'z: HTTP 429 余额不足或无可用资源包，请充值' },
    'claude',
  )
  assert.equal(verdict.reason, 'CREDIT')
  assert.equal(verdict.cooldownMs, COOLDOWN.credit)
  // 没钱是**整个账号**的事，不按模型分线——claude 也在 `MODEL_SCOPED_QUOTA_FAMILIES` 里，
  // 但一个没有余额的账号没有哪个模型是好的。
  assert.equal(verdict.scope, 'account')
})

test('"extra usage" and a weekly limit stay quota, not credit', () => {
  for (const text of ['extra usage required', 'You have hit your weekly limit']) {
    const words = failureWords(429, text)
    assert.equal(words, 'quota', text)
    const verdict = classifyFailure({ code: 'QUOTA', message: `c: HTTP 429 ${text}` }, 'codex')
    assert.equal(verdict.reason, 'QUOTA', text)
  }
  // 这条是既有的口径，`mapStatus` 与 qoder 的线协议里各有一份，别改坏。
  assert.equal(mapStatus(429, 'extra usage required'), 'QUOTA')
})

test('a 503 whose body says rate limit is a rate limit', () => {
  // 状态码说不出「现在别来」和「服务器炸了」的区别，但等的时间不一样。
  assert.equal(mapStatus(503, 'Rate limit exceeded'), 'SERVER')
  const error = httpError(reply(503), '{"error":{"message":"Rate limit exceeded"}}', 'codex')
  assert.equal(error.code, 'SERVER')
  const verdict = classifyFailure(error, 'codex')
  assert.equal(verdict.reason, 'RATE_LIMIT')
  assert.equal(verdict.backoff, 'rate')
  // 连状态都没有的 `SERVER`（线协议层的失败）不能被文本改写：没有证据。
  assert.equal(classifyFailure({ code: 'SERVER', message: 'x: boom' }, 'codex').backoff, 'transient')
})

test('an html interstitial is never promoted by the words on the page', () => {
  // `NOT_AN_API_REPLY` 是「中间有个东西挡着」，拦截页里恰好有 quota 字样也不该停账号。
  const verdict = classifyFailure(
    { code: 'NOT_AN_API_REPLY', message: 'account-bridge: generic: upstream answered 403 with a web page, not an API reply' },
    'generic',
  )
  assert.equal(verdict.reason, 'NOT_AN_API_REPLY')
  assert.equal(verdict.backoff, 'transient')
  assert.equal(verdict.scope, 'member')
})

test('words alone are not evidence', () => {
  // 「达到了上限」在限流文案里就有，只写 reached / exceeded 不算数。
  assert.equal(failureWords(400, 'the limit was reached'), undefined)
  assert.equal(failureWords(500, 'internal error'), undefined)
  assert.equal(failureWords(429, 'slow down'), 'rate')
  assert.equal(failureWords(429, 'you are out of credits'), 'credit')
})

// --------------------------------------------------------------- 到期即解冻

test('a cooldown whose time has passed reports the account as available again', () => {
  // magpie 在 `Allowance.Pace` 里对额度窗口做的同一件事：`its reset has passed: empty again`。
  // 冷却表这一侧的等价物就是「到点了就不算停着」。
  const table = new CooldownTable()
  const verdict = classifyFailure({ code: 'QUOTA', message: 'q: HTTP 429 out of quota' }, 'codex')
  table.record('codex', 'codex-1', 'gpt-5', verdict, 0)
  assert.equal(table.available('codex', 'codex-1', 'gpt-5', COOLDOWN.quota - 1), false)
  assert.equal(table.available('codex', 'codex-1', 'gpt-5', COOLDOWN.quota), true)
  assert.equal(table.available('codex', 'codex-1', 'gpt-5', COOLDOWN.quota + 1), true)
  // 一个已经过去的 resetAt 不能反过来当成「还在停着」的依据。
  assert.equal(table.why('codex', 'codex-1', 'gpt-5', COOLDOWN.quota + 1).by, 'policy')
})

// --------------------------------------------------------------- 可解释性

test('every rest says what set its length', () => {
  const table = new CooldownTable()
  const verdict = rateVerdict(10 * MINUTE)
  table.record('codex', 'codex-1', 'gpt-5', verdict, 0)
  const why = table.why('codex', 'codex-1', 'gpt-5', 1)
  assert.equal(why.reason, 'RATE_LIMIT')
  assert.equal(why.by, 'retry-after')
  assert.equal(why.cooldownMs, 10 * MINUTE)
  // 快照也要带上「谁定的」，否则面板上只能显示一个没有来源的数字。
  const [row] = table.snapshot(1)
  assert.equal(row.by, 'retry-after')
  assert.equal(row.failures, 1)
})

test('the first failure of each kind waits the documented time', () => {
  assert.equal(BACKOFF_BASE_MS, MINUTE)
  const table = new CooldownTable()
  const cases = [
    [{ code: 'AUTH', message: 'a: HTTP 401 nope' }, 'codex', COOLDOWN.auth],
    [{ code: 'QUOTA', message: 'q: HTTP 429 out of quota' }, 'codex', COOLDOWN.quota],
    [{ code: 'RATE_LIMIT', message: 'r: HTTP 429 slow down' }, 'codex', COOLDOWN.rate],
    [{ code: 'SERVER', message: 's: HTTP 500 boom' }, 'codex', COOLDOWN.transient],
  ]
  for (const [error, family, expected] of cases) {
    const verdict = classifyFailure(error, family)
    assert.equal(table.record('codex', `codex-${expected}`, 'm', verdict, 0), expected, error.code)
  }
})
