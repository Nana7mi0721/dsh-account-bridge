/**
 * 流量闸门（W10）的测试。
 *
 * 语义借自 magpie 的 `internal/gateway/rpm.go` 与 `concurrency.go`（MIT），
 * 见 `THIRD_PARTY_NOTICES.md`。这里验的不是「能不能跑」，而是四件容易写错的事：
 *
 * 1. **计数口径**：凡是真发出去的就计数，包括给出去的时机是「将来」（`reserve` 记的是
 *    **该发的时刻**，不是现在的时刻）。窗口里满了就等「倒数第 limit 个」满一分钟。
 * 2. **转开不占位**：被转开的请求不能留下任何痕迹，否则它会永久吃掉一个名额。
 * 3. **排队不是失败**：等并发槽的请求不报错、不换号、账号也不休息；有人还槽时**直接
 *    交给队首**（`busy` 不减），先来后到。
 * 4. **放弃就归还**：调用方中途走了，位置立刻还回去，而且那个包**永远不会发出去**。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Gate, LANE_QUEUE_LIMIT, RPM_LONGEST_WAIT_MS, RPM_WINDOW_MS } from '../src/gate.js'
import { classifyFailure } from '../src/health.js'
import { carryFailure } from '../src/failure.js'

const WHO = 'generic/generic-1'

/** 一个不会真的睡觉的 sleep，顺便记下它被要求等多久。 */
function fakeSleep() {
  const asked = []
  const sleep = async (ms) => {
    asked.push(ms)
  }
  sleep.asked = asked
  return sleep
}

/** 每毫秒一个「现在」，方便断言精确时刻。 */
function clockAt(start = 1_000_000) {
  const state = { now: start }
  return {
    get now() {
      return state.now
    },
    advance(ms) {
      state.now += ms
      return state.now
    },
  }
}

// ------------------------------------------------------------------ 每分钟

test('rpm: nobody waits while the minute has room', () => {
  const gate = new Gate()
  const clock = clockAt()
  for (let i = 0; i < 3; i += 1) {
    const got = gate.reserve(WHO, 3, 0, clock.now)
    assert.equal(got.afterMs, 0)
    assert.equal(got.at, clock.now)
    assert.equal(got.turnedAway, undefined)
  }
  assert.equal(gate.rpmUsed(WHO, clock.now), 3)
  assert.equal(gate.rpmFree(WHO, 3, clock.now), false)
})

test('rpm: the one over the limit goes a minute after the limit-th from the end', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  gate.reserve(WHO, 2, 0, clock.now)
  clock.advance(1_000)
  gate.reserve(WHO, 2, 0, clock.now)
  clock.advance(1_000)
  const third = gate.reserve(WHO, 2, 0, clock.now)
  // 窗口里是 [t0, t0+1000]，倒数第 2 个是 t0 ⇒ 它要等到 t0+60000。
  assert.equal(third.at, 1_000_000 + 60_000)
  assert.equal(third.afterMs, 58_000)
})

test('rpm: the times are kept as when each goes, so the list stays in order', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  // 连占三个：第二个与第三个的时刻是**将来**的，但记下来的就是那些时刻。
  gate.reserve(WHO, 1, 0, clock.now)
  const second = gate.reserve(WHO, 1, 0, clock.now)
  const third = gate.reserve(WHO, 1, 0, clock.now)
  assert.equal(second.at, 1_060_000)
  assert.equal(third.at, 1_120_000)
  // 此刻还没到那两个时刻，但它们已经在窗口里了——上游收到的是三个包。
  assert.equal(gate.rpmUsed(WHO, clock.now), 3)
  // 时间往前走，前面的先掉出窗口。
  assert.equal(gate.rpmUsed(WHO, 1_060_000), 2)
  assert.equal(gate.rpmUsed(WHO, 1_180_001), 0)
})

test('rpm: a window that forgot counts nothing, but the panel still knows the account', () => {
  const gate = new Gate({ windowMs: 1_000 })
  const clock = clockAt()
  gate.reserve(WHO, 5, 0, clock.now)
  clock.advance(1_001)
  assert.equal(gate.rpmUsed(WHO, clock.now), 0)
  // 空闲的账号**不是幽灵**：面板要能显示「上限 5/分钟，这一分钟用了 0」。
  assert.deepEqual(
    gate.snapshot(clock.now).map((row) => ({ who: row.who, rpm: row.rpm, rpmLimit: row.rpmLimit })),
    [{ who: WHO, rpm: 0, rpmLimit: 5 }],
  )
  // 幽灵是「账号已经不在池子里了，面板上还留着它一行」——那是 forget 的活。
  gate.forget(WHO)
  assert.deepEqual(gate.snapshot(clock.now), [])
})

test('rpm: a place given back leaves more room', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  const first = gate.reserve(WHO, 1, 0, clock.now)
  assert.equal(gate.rpmFree(WHO, 1, clock.now), false)
  gate.giveBack(WHO, first.at)
  assert.equal(gate.rpmFree(WHO, 1, clock.now), true)
  assert.equal(gate.rpmUsed(WHO, clock.now), 0)
})

test('rpm: giving back a time we never took changes nothing', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  gate.reserve(WHO, 2, 0, clock.now)
  gate.giveBack(WHO, clock.now + 12_345)
  gate.giveBack('nobody/nobody-9', clock.now)
  assert.equal(gate.rpmUsed(WHO, clock.now), 1)
})

test('rpm: waiting longer than we may turns the request away at once', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  gate.reserve(WHO, 1, 0, clock.now)
  const got = gate.reserve(WHO, 1, 30_000, clock.now)
  assert.ok(got.turnedAway instanceof Error)
  const error = got.turnedAway
  assert.equal(error.code, 'LOCAL_RATE_LIMIT')
  assert.equal(error.kind, 'rpm')
  assert.equal(error.who, WHO)
  assert.equal(error.limit, 1)
  assert.equal(error.afterMs, 60_000)
  assert.equal(error.retryAfterSeconds, 60)
  assert.equal(error.waitMs, 30_000)
  assert.match(error.message, /是上限/)
  assert.match(error.message, /60 秒/)
})

test('rpm: a turned-away request takes no place at all', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  gate.reserve(WHO, 1, 0, clock.now)
  assert.ok(gate.reserve(WHO, 1, 1, clock.now).turnedAway)
  assert.ok(gate.reserve(WHO, 1, 1, clock.now).turnedAway)
  // 两次转开之后，窗口里仍然只有那一个包——否则它会永久吃掉名额。
  assert.equal(gate.rpmUsed(WHO, clock.now), 1)
  // 而一个愿意等的请求拿到的是同一个时刻，不是被推得更远。
  clock.advance(1)
  const waiting = gate.reserve(WHO, 1, 0, clock.now)
  assert.equal(waiting.at, 1_060_000)
})

test('rpm: Retry-After is never zero seconds', () => {
  const gate = new Gate({ windowMs: 50 })
  const clock = clockAt()
  gate.reserve(WHO, 1, 0, clock.now)
  const error = gate.reserve(WHO, 1, 1, clock.now).turnedAway
  // 还有 50 毫秒——但「0 秒」会被一些客户端当成「马上重试」。
  assert.equal(error.retryAfterSeconds, 1)
})

test('rpm: the error carries the snapshot the host routes on', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  gate.reserve(WHO, 1, 0, clock.now)
  const carried = carryFailure(gate.reserve(WHO, 1, 1, clock.now).turnedAway)
  // 不挂这一份，失败码到宿主面上就变成 UNKNOWN，「等一会儿再来」就传不到 UI。
  assert.equal(carried.failure.code, 'LOCAL_RATE_LIMIT')
  assert.equal(carried.failure.providerRetryAfterMs, 60_000)
  assert.equal(carried.failure.message, carried.message)
})

test('a limit of zero means no limit at all', () => {
  const gate = new Gate()
  const clock = clockAt()
  assert.equal(gate.rpmFree(WHO, 0, clock.now), true)
  assert.deepEqual(gate.reserve(WHO, 0, 0, clock.now), { at: clock.now, afterMs: 0 })
  assert.equal(gate.rpmFree(WHO, undefined, clock.now), true)
  assert.equal(gate.laneFree(WHO, 0), true)
  assert.equal(gate.laneState(WHO).limit, 0)
})

test('rpm: waiting for room sleeps for exactly the rest and counts itself', async () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  const sleep = fakeSleep()
  gate.reserve(WHO, 1, 0, clock.now)
  clock.advance(20_000)
  const got = await gate.waitForRoom({ who: WHO, limit: 1, signal: undefined, now: clock.now, sleep })
  assert.deepEqual(sleep.asked, [40_000])
  assert.equal(got.waitedMs, 40_000)
  assert.equal(gate.rpmUsed(WHO, clock.now), 2, 'the request it waited for is counted')
})

test('rpm: room to spare means no sleeping at all', async () => {
  const gate = new Gate()
  const sleep = fakeSleep()
  const got = await gate.waitForRoom({ who: WHO, limit: 5, now: 1_000_000, sleep })
  assert.deepEqual(sleep.asked, [])
  assert.equal(got.waitedMs, 0)
})

test('rpm: a caller who walks away gives its place back and is never sent', async () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  const gone = Object.assign(new Error('user pressed stop'), { name: 'AbortError' })
  gate.reserve(WHO, 1, 0, clock.now)
  const sleep = async () => {
    throw gone
  }
  await assert.rejects(
    () => gate.waitForRoom({ who: WHO, limit: 1, now: clock.now, sleep }),
    (error) => error === gone,
  )
  // 位置还回去了：窗口里只剩最先那个，而不是两个。
  assert.equal(gate.rpmUsed(WHO, clock.now), 1)
})

test('rpm: a request that may never wait is turned away instead of sleeping', async () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  const sleep = fakeSleep()
  gate.reserve(WHO, 1, 0, clock.now)
  await assert.rejects(
    () => gate.waitForRoom({ who: WHO, limit: 1, longestMs: 1, now: clock.now, sleep }),
    (error) => error.code === 'LOCAL_RATE_LIMIT',
  )
  assert.deepEqual(sleep.asked, [], 'turned away means we did not even try to wait')
})

// -------------------------------------------------------------------- 并发

test('lanes: a free slot is taken at once', async () => {
  const gate = new Gate()
  assert.equal(gate.laneFree(WHO, 1), true)
  const release = await gate.acquire({ who: WHO, limit: 1 })
  assert.equal(gate.laneFree(WHO, 1), false)
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 0, limit: 1 })
  release()
  assert.equal(gate.laneFree(WHO, 1), true)
  // 车道对象空闲时会被删掉（不然 `#lanes` 会一直长），但**上限是配置不是状态**：
  // 面板问「这个账号最多几个并发」时该拿到 1，而不是 0。所以 `limit` 由 `#laneLimits` 记住。
  assert.deepEqual(gate.laneState(WHO), { busy: 0, waiting: 0, limit: 1 })
})

test('lanes: the ones that wait go in the order they came', async () => {
  const gate = new Gate()
  const order = []
  const first = await gate.acquire({ who: WHO, limit: 1 })
  const second = gate.acquire({ who: WHO, limit: 1 }).then((release) => {
    order.push('second')
    return release
  })
  const third = gate.acquire({ who: WHO, limit: 1 }).then((release) => {
    order.push('third')
    return release
  })
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 2, limit: 1 })
  first()
  const releaseSecond = await second
  // 还槽时**直接交给队首**：busy 不减，所以此刻仍然是「一个在飞、一个在等」。
  assert.deepEqual(order, ['second'])
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 1, limit: 1 })
  releaseSecond()
  const releaseThird = await third
  assert.deepEqual(order, ['second', 'third'])
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 0, limit: 1 })
  releaseThird()
  assert.equal(gate.laneFree(WHO, 1), true)
})

test('lanes: waiting is not failing', async () => {
  const gate = new Gate()
  const first = await gate.acquire({ who: WHO, limit: 1 })
  const waiting = gate.acquire({ who: WHO, limit: 1 })
  // 等着的那个请求不报错、不换号——它只是晚一点发。
  let settled = false
  waiting.then(
    () => {
      settled = true
    },
    () => {
      settled = 'failed'
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(settled, false)
  first()
  const release = await waiting
  release()
})

test('lanes: releasing twice does not free two slots', async () => {
  const gate = new Gate()
  const release = await gate.acquire({ who: WHO, limit: 2 })
  const other = await gate.acquire({ who: WHO, limit: 2 })
  release()
  release()
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 0, limit: 2 })
  // 两个槽里还有一个真的占着。
  assert.equal(gate.laneFree(WHO, 2), true)
  const third = await gate.acquire({ who: WHO, limit: 2 })
  assert.deepEqual(gate.laneState(WHO), { busy: 2, waiting: 0, limit: 2 })
  other()
  third()
})

test('lanes: a queue at its bound turns the next one away right away', async () => {
  const gate = new Gate()
  const held = await gate.acquire({ who: WHO, limit: 1 })
  const first = gate.acquire({ who: WHO, limit: 1, queueLimit: 1 })
  await assert.rejects(
    () => gate.acquire({ who: WHO, limit: 1, queueLimit: 1 }),
    (error) => {
      assert.equal(error.code, 'LOCAL_RATE_LIMIT')
      assert.equal(error.kind, 'lane')
      return true
    },
  )
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 1, limit: 1 })
  held()
  const release = await first
  release()
})

test('lanes: waiting longer than we may turns it away and leaves the queue', async () => {
  const gate = new Gate()
  const held = await gate.acquire({ who: WHO, limit: 1 })
  await assert.rejects(
    () => gate.acquire({ who: WHO, limit: 1, waitMs: 10 }),
    (error) => error.code === 'LOCAL_RATE_LIMIT' && error.kind === 'lane',
  )
  // 走了就要真的离开队列，否则那个槽永远交给一个已经不在的人。
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 0, limit: 1 })
  held()
  assert.equal(gate.laneFree(WHO, 1), true)
})

test('lanes: a caller who walks away leaves the queue and is never sent', async () => {
  const gate = new Gate()
  const held = await gate.acquire({ who: WHO, limit: 1 })
  const controller = new AbortController()
  const waiting = gate.acquire({ who: WHO, limit: 1, signal: controller.signal })
  assert.deepEqual(gate.laneState(WHO).waiting, 1)
  controller.abort(new Error('user pressed stop'))
  await assert.rejects(() => waiting, /user pressed stop/)
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 0, limit: 1 })
  held()
})

test('lanes: an already-aborted caller never joins the queue', async () => {
  const gate = new Gate()
  const held = await gate.acquire({ who: WHO, limit: 1 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => gate.acquire({ who: WHO, limit: 1, signal: controller.signal }))
  assert.equal(gate.laneState(WHO).waiting, 0)
  held()
})

test('lanes: a zombie in the queue never swallows a slot', async () => {
  const gate = new Gate()
  const held = await gate.acquire({ who: WHO, limit: 1 })
  const controller = new AbortController()
  controller.abort()
  const zombie = gate.acquire({ who: WHO, limit: 1, signal: controller.signal })
  const real = gate.acquire({ who: WHO, limit: 1 })
  await assert.rejects(() => zombie)
  held()
  // 归还槽位时**直接交给队首**：如果队首是那个不会有人接收的僵尸，`handoff()` 会被
  // `settled` 挡掉，这个槽就永久丢了——真的等着的那位从此永远挂在队列里。
  // 用一个上限把「挂死」变成「失败」，不然这条用例会静默地卡住整个套件。
  const release = await Promise.race([
    real,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timed out: the slot was swallowed by a zombie')), 200),
    ),
  ])
  assert.deepEqual(gate.laneState(WHO), { busy: 1, waiting: 0, limit: 1 })
  release()
})

test('lanes: the limit follows the account when it changes', async () => {
  const gate = new Gate()
  const held = await gate.acquire({ who: WHO, limit: 1 })
  // 同一个账号，上限被调高了：不再需要排队。
  const second = await gate.acquire({ who: WHO, limit: 2 })
  assert.deepEqual(gate.laneState(WHO), { busy: 2, waiting: 0, limit: 2 })
  held()
  second()
})

test('lanes: forgetting an account refuses whoever is waiting for it', async () => {
  const gate = new Gate()
  const held = await gate.acquire({ who: WHO, limit: 1 })
  const waiting = gate.acquire({ who: WHO, limit: 1 })
  gate.forget(WHO)
  await assert.rejects(() => waiting, /account removed/)
  held()
})

test('snapshot: what is out and what waits, per account', async () => {
  const gate = new Gate()
  const a = await gate.acquire({ who: WHO, limit: 2 })
  const other = 'agy/agy-1'
  const b = await gate.acquire({ who: other, limit: 1 })
  gate.reserve(WHO, 4, 0, 1_000_000)
  const rows = new Map(gate.snapshot(1_000_000).map((row) => [row.who, row]))
  assert.deepEqual(rows.get(WHO), { who: WHO, rpm: 1, rpmLimit: 4, busy: 1, waiting: 0, laneLimit: 2 })
  assert.deepEqual(rows.get(other), { who: other, rpm: 0, rpmLimit: 0, busy: 1, waiting: 0, laneLimit: 1 })
  a()
  b()
})

test('the defaults are the ones the notices describe', () => {
  assert.equal(RPM_WINDOW_MS, 60_000, 'a minute')
  assert.equal(RPM_LONGEST_WAIT_MS, 2 * 60_000, 'two minutes')
  assert.equal(LANE_QUEUE_LIMIT, 64)
  const gate = new Gate()
  assert.equal(gate.windowMs, RPM_WINDOW_MS)
})

// -------------------------------------------------------------- 与冷却表的关系

test('a gate rejection rests nobody', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  gate.reserve(WHO, 1, 0, clock.now)
  const error = gate.reserve(WHO, 1, 1, clock.now).turnedAway
  for (const family of ['generic', 'codex', 'claude']) {
    const verdict = classifyFailure(error, family)
    // 判成 RATE_LIMIT 会把一个完全健康的账号停掉——而它下一秒照样会被同一个闸门挡住。
    assert.equal(verdict.action, 'throw')
    assert.equal(verdict.reason, 'LOCAL_RATE_LIMIT')
    assert.equal(verdict.cooldownMs, undefined)
    assert.equal(verdict.scope, undefined)
  }
})

test('a gate rejection does not sink the account either', () => {
  const gate = new Gate({ windowMs: 60_000 })
  const clock = clockAt()
  gate.reserve(WHO, 1, 0, clock.now)
  const verdict = classifyFailure(gate.reserve(WHO, 1, 1, clock.now).turnedAway, 'generic')
  // sink 是给「还有额度却吃了限流」的账号用的，我们这里压根没碰到上游。
  assert.notEqual(verdict.backoff, 'rate')
})
