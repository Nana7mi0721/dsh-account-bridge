/**
 * 回环登录回调的 state 校验。
 *
 * 回调路由不校验任何头部：本机任意实体都能 `GET /callback?code=<自己的授权码>`。
 * 挡住它的**只有** state——所以「回调没带 state」必须算不匹配，而不是放行。
 * 这一条以前没有任何测试，而它的实现恰好是放行的（`result.state !== undefined && …`）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createState, startLoopback } from '../src/login/loopback.js'

test('a callback that carries no state is refused, not waved through', async () => {
  const loopback = await startLoopback({ ports: [0], timeoutMs: 5_000 })
  try {
    const state = createState()
    const answer = loopback.waitForCode(state)
    // 先把断言挂上再去打回调：拒绝发生在 fetch 返回之前，晚挂就成了 unhandled rejection。
    const refused = assert.rejects(answer, /carried no state/)
    // 攻击者的形状：一个不带 state 的裸回调。
    const response = await fetch(`http://127.0.0.1:${loopback.port}/callback?code=attacker-code`)
    assert.equal(response.status, 200)
    await refused
  } finally {
    await loopback.close()
  }
})

test('a callback whose state does not match is refused', async () => {
  const loopback = await startLoopback({ ports: [0], timeoutMs: 5_000 })
  try {
    const answer = loopback.waitForCode(createState())
    assert.ok(answer.catch(() => {}), 'the promise must be awaited below')
    await fetch(`http://127.0.0.1:${loopback.port}/callback?code=c&state=someone-else`)
    await assert.rejects(answer, /state mismatch/)
  } finally {
    await loopback.close()
  }
})

test('a callback with the right state is accepted', async () => {
  const loopback = await startLoopback({ ports: [0], timeoutMs: 5_000 })
  try {
    const state = createState()
    const answer = loopback.waitForCode(state)
    await fetch(`http://127.0.0.1:${loopback.port}/callback?code=good-code&state=${encodeURIComponent(state)}`)
    assert.deepEqual(await answer, { code: 'good-code', state })
  } finally {
    await loopback.close()
  }
})

test('an expected state that was never asked for still resolves', async () => {
  // `waitForCode()` 不带参数（有的流程自己没有 state 可言）时不该凭空拒绝。
  const loopback = await startLoopback({ ports: [0], timeoutMs: 5_000 })
  try {
    const answer = loopback.waitForCode()
    await fetch(`http://127.0.0.1:${loopback.port}/callback?code=anonymous-code`)
    assert.deepEqual(await answer, { code: 'anonymous-code', state: undefined })
  } finally {
    await loopback.close()
  }
})
