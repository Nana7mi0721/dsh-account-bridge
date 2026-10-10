/**
 * 让宿主认得我们抛出的失败码。
 *
 * 宿主把适配器抛出的异常转成一个 `{type:'finish', reason:{kind:'error', failure}}` 块，
 * 转换函数是 `@deepseek-ai/dsh-llm` 的 `normalizeLlmFailure()`（`lib/index.js:403-410`）：
 *
 * ```js
 * const carried = ownFailureSnapshot(error)          // 读 error.failure 这个自有数据属性
 * if (carried !== undefined && carried.code === ownErrorCode(error)) return carried
 * return { message: errorMessage(error), code: harnessErrorCode(error) }
 * ```
 *
 * 而 `harnessErrorCode()`（`:472-474`）是 `error instanceof HarnessError ? error.code : "UNKNOWN"`。
 * 我们抛的是普通 `Error` 加一个 `.code`——两样都不占，于是**每个族的失败码在宿主面上
 * 都变成 `UNKNOWN`**，UI 与日志里再也分不出「令牌废了」和「中间有个东西挡着」。
 * 宿主自己的注释写得很直白：*"Stable machine-routable failure class (e.g. `RATE_LIMIT`);
 * route on this, never by parsing `message`."*（`:128`）——不占这条，就等于让下游去猜字符串。
 *
 * 我们**不能** import `@deepseek-ai/dsh-llm`（插件里裸模块名解析不到，这是本项目的一条硬契约，
 * 由 `test/contract.test.js` 静态扫描守着）。但也不需要：只要在错误上挂一个
 * `error.failure = {message, code, …}`，并且 `failure.code === error.code`，宿主的第一个分支就成立。
 *
 * `failureSnapshot()`（`:439-462`）校验得很死，任何一个字段不合格都会**把整份快照判成
 * undefined**（不是忽略那个字段），所以这里逐个字段验，宁可少带也不要带坏的：
 * `message` / `code` 必须是非空字符串，`status` 必须是 100..599 的整数，
 * `providerRetryAfterMs` 必须是有限正数，`requestId` 必须是非空字符串。
 * @module dsh-account-bridge/failure
 */

/** 只在字段确实合格时才带上——一个坏字段会连带整份快照一起被丢掉。 */
function optionalFields(source) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  const status = source.status
  if (Number.isInteger(status) && status >= 100 && status <= 599) out.status = status
  const retry = source.providerRetryAfterMs
  if (Number.isFinite(retry) && retry > 0) out.providerRetryAfterMs = retry
  const requestId = source.requestId
  if (typeof requestId === 'string' && requestId.length > 0) out.requestId = requestId
  return out
}

/** 这份快照能不能被宿主原样接受？用来判断「还要不要动它」。 */
function alreadyCarried(error, code) {
  const carried = error.failure
  return (
    typeof carried === 'object' &&
    carried !== null &&
    carried.code === code &&
    typeof carried.message === 'string' &&
    carried.message.length > 0
  )
}

/**
 * 给错误挂上宿主认得的 `failure` 快照，然后原样返回它（方便 `throw carryFailure(e)`）。
 *
 * 只动得了带非空字符串 `code` 的错误——没有码就没有可路由的东西，宿主落在 `UNKNOWN`
 * 是**诚实**的结果，这里不替它编一个。冻结的错误、原始值、`null` 一律原样返回。
 */
export function carryFailure(error) {
  if (typeof error !== 'object' || error === null) return error
  let code
  try {
    code = error.code
  } catch {
    return error
  }
  if (typeof code !== 'string' || code.length === 0) return error
  if (alreadyCarried(error, code)) return error
  const message =
    typeof error.message === 'string' && error.message.length > 0 ? error.message : code
  try {
    error.failure = { message, code, ...optionalFields(error.failure) }
  } catch {
    /* 冻结的错误改不动；让宿主退回 UNKNOWN 也比在这里抛出去强 */
  }
  return error
}

/**
 * 把一个异步生成器的失败也挂上快照——`pool.stream()` 就是这么往外走的。
 *
 * 单独一个函数，是因为 `stream` 是异步生成器：`try { ... } catch` 包不住
 * 「消费到一半才抛」的那种失败，必须把 `yield*` 整个包住。
 */
export async function* carryingFailures(iterable) {
  try {
    yield* iterable
  } catch (error) {
    throw carryFailure(error)
  }
}
