/**
 * 上游 HTTP 错误 → DSH 中立的失败码。
 *
 * 这块逻辑原先在 codex 族与 claude 族里各有一份，而且**两份不一样**：
 * codex 版会读 `retry-after-ms`，但把 `504` 归成了 `SERVER`；
 * claude 版认得 `extra usage` 这个配额措辞，却只读 `retry-after`。
 * 两边都没有错到不能跑，但「同一个上游错误在两条通道里得到两种冷却决策」
 * 是那种最难查的 bug。这里取并集，并把判断顺序钉死。
 *
 * 顺序是有意义的：
 * - `408 / 504` 必须在 `>= 500` **之前**判，否则 504 永远落不到 `TIMEOUT`；
 * - `400 + context` 要在 `>= 500` 之前，但它本来就不可能是 5xx；
 * - 401/403 先判，因为带 `quota` 字样的 403 仍然是鉴权问题，不是额度问题。
 * @module dsh-account-bridge/wire/http-error
 */

import { tryJson } from '../util.js'

/** 非 2xx 响应 → 带 DSH provider 中立码的错误。 */
export function httpError(response, text, who) {
  const json = tryJson(text)
  const detail = json?.error?.message ?? json?.message ?? text.slice(0, 300)
  const error = new Error(`${who}: HTTP ${response.status} ${detail}`)
  const providerRetryAfterMs = retryAfterMs(response.headers)
  error.code = mapStatus(response.status, detail)
  error.failure = {
    status: response.status,
    code: error.code,
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
  }
  return error
}

/**
 * 上游可能用 `retry-after`（秒）或 `retry-after-ms` / `x-retry-after-ms`（毫秒）说退避时长。
 * 两个都认；都没有就返回 undefined（让冷却表用自己的默认值，而不是编一个数）。
 */
export function retryAfterMs(headers) {
  const seconds = Number(headers?.get?.('retry-after'))
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const ms = Number(headers?.get?.('retry-after-ms') ?? headers?.get?.('x-retry-after-ms'))
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * OAuth 令牌端点用 400 报「这条刷新令牌已经作废」是标准做法：
 * MiniMax Code 回的是 `400 {"error":"invalid_grant","error_description":
 * "this refresh token can no longer be used, start a new authorization"}`（实测）。
 * 按状态码这会被归成 `SERVER` ⇒ 只冷却 60 秒 ⇒ 一条死令牌被永远每 60 秒重试一次。
 * 它实际上是**鉴权**问题（要重新登录，不是等一等就好），所以文本命中就归 AUTH。
 */
const AUTH_DETAIL = /invalid_grant|invalid_token|invalid_client|unauthorized_client|invalid_scope/

/** HTTP 状态 + 错误文本 → 失败码。 */
export function mapStatus(status, detail = '') {
  const text = String(detail).toLowerCase()
  if (status === 401 || status === 403) return 'AUTH'
  if (AUTH_DETAIL.test(text)) return 'AUTH'
  if (status === 402) return 'ACCOUNT_QUOTA'
  if (status === 429) {
    if (text.includes('quota') || text.includes('usage limit') || text.includes('extra usage')) return 'QUOTA'
    return 'RATE_LIMIT'
  }
  if (status === 400 && text.includes('context')) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 408 || status === 504) return 'TIMEOUT'
  return 'SERVER'
}
