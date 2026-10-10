/**
 * 失败码要活着走到宿主面前。
 *
 * 宿主把适配器抛出的异常转成 `{type:'finish', reason:{kind:'error', failure}}`，
 * 转换函数 `normalizeLlmFailure()`（`@deepseek-ai/dsh-llm` 的 `lib/index.js:403-410`）
 * 只认两种输入：错误自己是 `HarnessError`，或者错误上有一个
 * **自称与自己 `code` 一致**的 `failure` 快照。我们两样都不占，于是
 * `harnessErrorCode()`（`:472-474`）一路返回 `"UNKNOWN"`——**每一个族的失败码
 * 在宿主面上都变成 `UNKNOWN`**，UI 与日志里再也分不出「令牌废了」和
 * 「中间有个东西挡着」。
 *
 * 这个文件里第一条用例是**宿主算法的复刻**：把 `normalizeLlmFailure()` 的判定顺序
 * 照抄一遍，然后断言我们抛的错真的能过它。抄它的理由和 `harness.js` 里那个假
 * `webServer` 一样——要验的是「协议对上了」，不是「我们自己的函数返回了自己想要的值」。
 * 复刻一旦和宿主脱节就会在这里失败，这正是想要的。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountStore } from '../src/store.js'
import { CooldownTable } from '../src/health.js'
import { AccountBridgeAdapter } from '../src/pool.js'
import { carryFailure, carryingFailures } from '../src/failure.js'
import { httpError } from '../src/wire/http-error.js'
import { createMemoryCredentials } from './harness.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

// ---------------------------------------------------------------- 宿主算法复刻

/**
 * `failureSnapshot()`（`lib/index.js:439-462`）：校验得很死，**任何一个字段不合格
 * 都会把整份快照判成 undefined**（不是忽略那一个字段）。这正是当初那个 bug 的
 * 藏身处：`httpError` 早就挂了 `error.failure`，只是少了 `message`。
 */
function failureSnapshot(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const { message, code, status, providerRetryAfterMs, requestId } = value
  if (typeof message !== 'string' || message.length === 0) return undefined
  if (typeof code !== 'string' || code.length === 0) return undefined
  if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) return undefined
  if (providerRetryAfterMs !== undefined && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0)) {
    return undefined
  }
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0)) return undefined
  return { message, code, ...(status === undefined ? {} : { status }) }
}

/** `normalizeLlmFailure()`（`lib/index.js:403-410`），逐字照搬判定顺序。 */
function normalizeLlmFailure(error) {
  const carried = failureSnapshot(error?.failure)
  // 真实实现还会比一次 `carried.code === error.code`；不复刻这一点就等于放水。
  if (carried !== undefined && carried.code === error.code) return carried
  // `harnessErrorCode()`：`error instanceof HarnessError ? error.code : "UNKNOWN"`。
  // 我们永远走 else 这一支，所以这里直接写死 UNKNOWN。
  return { message: error?.message ?? 'LLM adapter failed', code: 'UNKNOWN' }
}

// ---------------------------------------------------------------- 快照本身

test('a plain Error with a code carries no snapshot until we attach one', () => {
  const error = new Error('gateway said no')
  error.code = 'NOT_AN_API_REPLY'
  assert.equal(normalizeLlmFailure(error).code, 'UNKNOWN')
  assert.equal(carryFailure(error), error)
  assert.equal(normalizeLlmFailure(error).code, 'NOT_AN_API_REPLY')
  assert.deepEqual(error.failure, { message: 'gateway said no', code: 'NOT_AN_API_REPLY' })
})

test('an http error carries its status and retry-after to the host', () => {
  const response = {
    status: 429,
    headers: { get: (name) => (name === 'retry-after' ? '3' : null) },
  }
  const error = httpError(response, '{"error":{"message":"slow down"}}', 'grok')
  // 少了 `message` 的话这一条会是 UNKNOWN——就是那个只差一行、却让全族失去失败码的 bug。
  assert.deepEqual(normalizeLlmFailure(error), {
    message: 'grok: HTTP 429 slow down',
    code: 'RATE_LIMIT',
    status: 429,
  })
  assert.equal(error.failure.providerRetryAfterMs, 3000)
})

test('the carrier is idempotent and never overwrites a good snapshot', () => {
  const error = new Error('first')
  error.code = 'AUTH'
  carryFailure(error)
  error.message = 'second'
  carryFailure(error)
  // 已经是一份合格快照就不动它：`message` 留着第一次的，免得每次经过池子都换一个说法。
  assert.equal(error.failure.message, 'first')
})

test('an error with no usable code is left alone', () => {
  // 没有码就没有可路由的东西；宿主落在 UNKNOWN 是**诚实**的结果，这里不替它编一个。
  assert.equal(normalizeLlmFailure(new Error('boom')).code, 'UNKNOWN')
  assert.equal(carryFailure(undefined), undefined)
  assert.equal(carryFailure(null), null)
  assert.equal(carryFailure('boom'), 'boom')
  const noCode = new Error('boom')
  carryFailure(noCode)
  assert.equal(noCode.failure, undefined)
  const emptyCode = new Error('boom')
  emptyCode.code = ''
  carryFailure(emptyCode)
  assert.equal(emptyCode.failure, undefined)
})

test('a bad field is dropped instead of poisoning the whole snapshot', () => {
  const error = new Error('odd')
  error.code = 'SERVER'
  // `status` 不是整数、`providerRetryAfterMs` 是 0：两个都不合格。
  error.failure = { status: 'five', providerRetryAfterMs: 0, requestId: '' }
  carryFailure(error)
  assert.deepEqual(error.failure, { message: 'odd', code: 'SERVER' })
  assert.equal(normalizeLlmFailure(error).code, 'SERVER')
})

test('a frozen error is returned unchanged rather than throwing', () => {
  const error = Object.freeze(Object.assign(new Error('frozen'), { code: 'TIMEOUT' }))
  assert.equal(carryFailure(error), error)
  assert.equal(normalizeLlmFailure(error).code, 'UNKNOWN')
})

test('a failure raised mid-stream still carries its code', async () => {
  async function* halfway() {
    yield { type: 'text-delta', index: 0, text: 'half' }
    const error = new Error('upstream hung up')
    error.code = 'TRANSPORT'
    throw error
  }
  const seen = []
  let caught
  try {
    for await (const chunk of carryingFailures(halfway())) seen.push(chunk)
  } catch (error) {
    caught = error
  }
  assert.equal(seen.length, 1)
  assert.equal(normalizeLlmFailure(caught).code, 'TRANSPORT')
})

// ---------------------------------------------------------------- 池子的出口

/** 造一个单账号适配器，`stream()` 抛 `error`。 */
async function failingPool(error, { resolveFails = false } = {}) {
  const route = 'acct-claude'
  const family = {
    id: 'claude',
    displayName: 'Fake',
    route,
    async listModels() {
      return [{ provider: route, id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' }]
    },
    resolveModel(provider, id) {
      if (resolveFails) throw error
      return { provider, id, name: id }
    },
    needsRefresh() {
      return false
    },
    stream() {
      return (async function* () {
        throw error
      })()
    },
  }
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  await store.write('claude-1', {
    id: 'claude-1',
    family: 'claude',
    label: 'claude-1',
    auth: { access: 't', refresh: 'r', expiresAt: Date.now() + 3_600_000 },
  })
  return new AccountBridgeAdapter({
    ctx: { fetch: async () => {} },
    store,
    health: new CooldownTable(),
    families: [family],
    log: silent,
  })
}

test('the pool hands the host a routable code, not UNKNOWN', async () => {
  const error = new Error('account-bridge: upstream answered with a web page')
  error.code = 'NOT_AN_API_REPLY'
  const adapter = await failingPool(error)
  let caught
  try {
    for await (const _chunk of adapter.stream({
      provider: 'acct-claude',
      model: 'claude-sonnet-4-5',
      messages: [{ id: 'u1', role: 'user' }],
    })) {
      /* 不该有 chunk：这一族直接抛 */
    }
  } catch (thrown) {
    caught = thrown
  }
  assert.ok(caught, 'the failure must reach the caller')
  const failure = normalizeLlmFailure(caught)
  assert.equal(failure.code, 'NOT_AN_API_REPLY')
  assert.match(failure.message, /web page/)
})

test('a resolveModel failure carries a code too', async () => {
  const error = new Error('claude: HTTP 401 token is required')
  error.code = 'AUTH'
  const adapter = await failingPool(error, { resolveFails: true })
  let caught
  try {
    await adapter.resolveModel('acct-claude', 'claude-sonnet-4-5')
  } catch (thrown) {
    caught = thrown
  }
  assert.ok(caught, 'a resolve failure must reach the caller')
  assert.equal(normalizeLlmFailure(caught).code, 'AUTH')
})

test('a catalog the upstream refuses is an empty picker, not an error', async () => {
  // 这是**有意**的行为：`/models` 拉不到 ≠ 这一族不能推理（声明式目录、只支持 chat 的
  // 网关都会这样）。这里钉住它，免得以后有人「顺手」把目录失败改成抛错。
  const error = new Error('unreachable')
  error.code = 'TRANSPORT'
  const adapter = await failingPool(error, { resolveFails: false })
  assert.deepEqual(await adapter.listModels('acct-claude'), [
    { provider: 'acct-claude', id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' },
  ])
})
