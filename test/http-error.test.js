/**
 * 共享的上游错误映射（`src/wire/http-error.js`）。
 *
 * 这块原先在 codex 族和 claude 族里各有一份、而且**两份不一样**：
 * codex 版会读 `retry-after-ms`，却把 `504` 归成了 `SERVER`；claude 版认得
 * `extra usage` 这个配额措辞，却只读 `retry-after`。同一个上游错误在两条通道里
 * 得到两种冷却决策，是那种最难查的 bug。这些用例就是「并集之后两边都对」的凭据。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { httpError, mapStatus, retryAfterMs } from '../src/wire/http-error.js'

function response(status, headers = {}) {
  return {
    status,
    headers: new Headers(headers),
  }
}

test('a 400 that says invalid_grant is AUTH, not SERVER', () => {
  // MiniMax Code 就是这么报「这条刷新令牌已经作废」的：
  //   400 {"error":"invalid_grant","error_description":"this refresh token can no longer be used"}
  // 按状态码归成 SERVER 的话只冷却 60 秒，一条死令牌会被永远每 60 秒重试一次；
  // 而它其实要的是重新登录。
  assert.equal(mapStatus(400, 'invalid_grant'), 'AUTH')
  assert.equal(
    mapStatus(
      400,
      '{"error":"invalid_grant","error_description":"this refresh token can no longer be used, start a new authorization"}',
    ),
    'AUTH',
  )
  assert.equal(mapStatus(400, 'invalid_client'), 'AUTH')
  // 不带鉴权措辞的 400 仍然是请求本身的问题（谁都不该为此受罚）。
  assert.equal(mapStatus(400, 'bad request: unknown field'), 'SERVER')
})

test('504 is a timeout, not a server error', () => {
  // codex 版原来先判 `status >= 500`，于是 504 永远落不到 TIMEOUT，
  // 网关超时被当成上游故障，冷却时长按错的那一类算。
  assert.equal(mapStatus(504), 'TIMEOUT')
  assert.equal(mapStatus(408), 'TIMEOUT')
  assert.equal(mapStatus(500), 'SERVER')
  assert.equal(mapStatus(503), 'SERVER')
})

test('auth wins over quota wording', () => {
  // 带 `quota` 字样的 403 仍然是鉴权问题：把它当成额度耗尽会去换账号，
  // 而真正该做的是让用户重新登录。
  assert.equal(mapStatus(403, 'quota exceeded'), 'AUTH')
  assert.equal(mapStatus(401, 'usage limit reached'), 'AUTH')
})

test('a 429 is a quota failure only when the text says so', () => {
  assert.equal(mapStatus(429), 'RATE_LIMIT')
  assert.equal(mapStatus(429, 'usage limit reached'), 'QUOTA')
  assert.equal(mapStatus(429, 'you have hit your quota'), 'QUOTA')
  // claude 版认得这个措辞，codex 版原先不认。
  assert.equal(mapStatus(429, 'extra usage required'), 'QUOTA')
})

test('a 402 is an account-level quota failure and a context 400 is its own code', () => {
  assert.equal(mapStatus(402), 'ACCOUNT_QUOTA')
  assert.equal(mapStatus(400, 'context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(mapStatus(400, 'bad request'), 'SERVER')
})

test('retry-after is read in both units the upstreams actually use', () => {
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '30' })), 30_000)
  // codex 版会读这两个；claude 版原先不读。
  assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '1500' })), 1_500)
  assert.equal(retryAfterMs(new Headers({ 'x-retry-after-ms': '2500' })), 2_500)
  // 秒优先于毫秒；两个都没有就返回 undefined，让冷却表用自己的默认值而不是编一个数。
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '2', 'retry-after-ms': '9999' })), 2_000)
  assert.equal(retryAfterMs(new Headers()), undefined)
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '0' })), undefined)
})

test('httpError carries the status and the retry hint the pool needs', () => {
  const error = httpError(response(429, { 'retry-after': '12' }), JSON.stringify({ error: { message: 'slow down' } }), 'minimax')
  assert.match(error.message, /^minimax: HTTP 429 slow down$/)
  // 「slow down」里没有配额措辞 ⇒ 限流，不是额度耗尽：换账号没用，该等。
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.status, 429)
  assert.equal(error.failure.providerRetryAfterMs, 12_000)
})

test('httpError falls back to raw text when the body is not JSON', () => {
  const error = httpError(response(500), '<html>gateway blew up</html>', 'codex')
  assert.match(error.message, /codex: HTTP 500 <html>gateway blew up<\/html>/)
  assert.equal(error.code, 'SERVER')
  assert.equal(error.failure.providerRetryAfterMs, undefined)
})
