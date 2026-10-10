/**
 * `src/select.js` —— 账号选择。
 *
 * 这些用例钉的是**语义**，不是实现：额度分三档、重置时间只比到小时、pace 必须先离散
 * 成 band 再排序（否则绕圈）、沉过的账号排在没沉过的后面。
 * 每条判据都有一条用例，且每条都能在改坏实现时失败——反向验证见提交信息。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FRESH_PACE,
  LOW_SHARE,
  SPENT_SHARE,
  USAGE_HALF_LIFE_MS,
  decayUsage,
  paceOf,
  rankCandidates,
  shareOf,
  sinkOrder,
  tierOf,
  usageNow,
} from '../src/select.js'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0)

/** 一个候选：只给该用例在乎的字段。 */
function account(id, extra = {}) {
  return { id, ...extra }
}

/** 一个窗口：`used` 百分比、`inHours` 小时后重置。 */
function window_(used, inHours) {
  return { used, resetsAt: inHours === undefined ? undefined : NOW + inHours * HOUR }
}

function ids(result) {
  return (Array.isArray(result) ? result : result.order).map((candidate) => candidate.id)
}

test('用得少的排在前面：5% 赢 95%', () => {
  const low = account('low', { windows: [window_(5, 2)] })
  const high = account('high', { windows: [window_(95, 2)] })
  assert.deepEqual(ids(rankCandidates([high, low], NOW)), ['low', 'high'])
  assert.equal(rankCandidates([high, low], NOW).why, 'bucket')
})

test('三档的边界：89 / 90 / 97 / 98', () => {
  assert.equal(LOW_SHARE, 90)
  assert.equal(SPENT_SHARE, 98)
  assert.equal(tierOf(undefined), 0)
  assert.equal(tierOf(89.9), 0)
  assert.equal(tierOf(90), 1)
  assert.equal(tierOf(97.9), 1)
  assert.equal(tierOf(98), 2)
  assert.equal(tierOf(100), 2)

  const fine = account('fine', { windows: [window_(89, 2)] })
  const low = account('low', { windows: [window_(90, 2)] })
  const spent = account('spent', { windows: [window_(98, 2)] })
  assert.deepEqual(ids(rankCandidates([spent, low, fine], NOW)), ['fine', 'low', 'spent'])
})

test('档位取最满的那个窗口，不是平均值', () => {
  // 一周窗口才用了 10%，但 5 小时窗口已经 99% —— 这个账号现在不能用
  const burst = account('burst', { windows: [window_(10, 168), window_(99, 0.5)] })
  assert.equal(shareOf(burst), 99)
  assert.equal(tierOf(shareOf(burst)), 2)

  const calm = account('calm', { windows: [window_(10, 168), window_(40, 0.5)] })
  assert.deepEqual(ids(rankCandidates([burst, calm], NOW)), ['calm', 'burst'])
})

test('已满的账号沉到最后，但不是被剔除：只剩它时照样选它', () => {
  const spent = account('spent', { windows: [window_(99, 1)] })
  const result = rankCandidates([spent], NOW)
  assert.equal(result.chosen, spent)
  assert.equal(result.why, 'only')
})

test('同一档里用得更少的先上', () => {
  const more = account('more', { windows: [window_(96, 2)] })
  const less = account('less', { windows: [window_(91, 2)] })
  assert.deepEqual(ids(rankCandidates([more, less], NOW)), ['less', 'more'])
  assert.equal(rankCandidates([more, less], NOW).why, 'allowance')
})

// —— 重置时间：只比到小时 ——————————————————————————————————————————

test('同档里重置更早的先上（跨小时）', () => {
  const early = account('early', { windows: [{ used: 95, resetsAt: Date.UTC(2026, 0, 5, 13, 55) }] })
  const late = account('late', { windows: [{ used: 95, resetsAt: Date.UTC(2026, 0, 5, 14, 5) }] })
  assert.deepEqual(ids(rankCandidates([late, early], NOW)), ['early', 'late'])
  assert.equal(rankCandidates([late, early], NOW).why, 'resets')
})

test('相隔 30 分钟但落在同一个小时里，顺序不变（截断到小时的回归）', () => {
  // 14:05 与 14:55 是同一个小时 ⇒ 重置时间分不出来，由近期用量决定
  const first = account('first', { windows: [{ used: 95, resetsAt: Date.UTC(2026, 0, 5, 14, 5) }], usedRecently: 5 })
  const second = account('second', { windows: [{ used: 95, resetsAt: Date.UTC(2026, 0, 5, 14, 55) }], usedRecently: 1 })
  const result = rankCandidates([first, second], NOW)
  // second 重置更晚，但它近期用得少 ⇒ 它先上，说明那 50 分钟的差别没被当成判据
  assert.deepEqual(ids(result), ['second', 'first'])
  assert.equal(result.why, 'recent-use')
})

test('不知道什么时候重置的排在知道的之后', () => {
  const known = account('known', { windows: [window_(95, 3)] })
  const unknown = account('unknown', { windows: [window_(95, undefined)] })
  assert.deepEqual(ids(rankCandidates([unknown, known], NOW)), ['known', 'unknown'])
})

// —— pace 与离散分带 ————————————————————————————————————————————

test('pace 取「最紧的那个窗口」，分母有 1 小时下限', () => {
  // 两个窗口，数值上更紧的那个赢
  const two = account('two', { windows: [window_(10, 2), window_(99, 1)] })
  assert.equal(Math.round(paceOf(two, NOW) * 100) / 100, 1) // (100-99)/1
  const wide = account('wide', { windows: [window_(10, 2)] })
  assert.equal(paceOf(wide, NOW), 45) // (100-10)/2
  // 分母下限：马上就要重置也不给无穷大
  const soon = account('soon', { windows: [{ used: 50, resetsAt: NOW + 60_000 }] })
  assert.equal(paceOf(soon, NOW), 50)
  // 未知额度按「整整一周都还没用」估
  assert.equal(paceOf(account('blank'), NOW), FRESH_PACE)
})

test('未知额度的账号不排最后也不排最前', () => {
  const low = account('low', { windows: [window_(5, 2)] }) // pace 47.5
  const unknown = account('unknown') // pace ≈ 0.595
  const high = account('high', { windows: [window_(96, 2)] }) // 快满档
  const result = rankCandidates([unknown, high, low], NOW)
  assert.deepEqual(ids(result), ['low', 'unknown', 'high'])
  assert.equal(result.why, 'pace')
})

test('三个 pace 各差一档都不到时，结果不随输入顺序变（离散分带，不绕圈）', () => {
  // 10.0 / 9.7 / 9.5 两两相差都不到十分之一：直接拿 0.9× 去比会绕圈
  // （a>b、b>c、c>a 同时成立），先离散成整数 band 就不会。
  const a = account('a', { windows: [{ used: 50, resetsAt: NOW + 5 * HOUR }], usedRecently: 3 })
  const b = account('b', { windows: [{ used: 51.5, resetsAt: NOW + 5 * HOUR }], usedRecently: 2 })
  const c = account('c', { windows: [{ used: 52.5, resetsAt: NOW + 5 * HOUR }], usedRecently: 1 })
  assert.equal(paceOf(a, NOW), 10)
  assert.equal(paceOf(b, NOW), 9.7)
  assert.equal(paceOf(c, NOW), 9.5)

  const want = ['c', 'b', 'a']
  for (const input of [[a, b, c], [c, a, b], [b, c, a], [c, b, a]]) {
    const result = rankCandidates(input, NOW)
    assert.deepEqual(ids(result), want, `输入顺序 ${ids(input)} 给出了不同的结果`)
    // 三者同档 ⇒ pace 这条判据说不出话，由近期用量决定
    assert.equal(result.why, 'recent-use')
  }
})

test('差异足够大时 pace 才分得出档，且撑得久的先上', () => {
  const rich = account('rich', { windows: [window_(10, 8)] }) // 11.25
  const thin = account('thin', { windows: [window_(80, 8)] }) // 2.5
  assert.equal(rankCandidates([thin, rich], NOW).why, 'pace')
  assert.deepEqual(ids(rankCandidates([thin, rich], NOW)), ['rich', 'thin'])
})

// —— learns ————————————————————————————————————————————————————

test('额度未知但会自报的账号先上，而且只靠这一个标记', () => {
  const known = account('known', { windows: [window_(5, 2)] })
  const probing = account('probing', { learns: true })
  const result = rankCandidates([known, probing], NOW)
  assert.deepEqual(ids(result), ['probing', 'known'])
  assert.equal(result.why, 'learns')
  // 不声明 learns 的未知账号没有这条通道
  const silent = account('silent')
  assert.deepEqual(ids(rankCandidates([known, silent], NOW)), ['known', 'silent'])
})

// —— Sink ——————————————————————————————————————————————————————

test('沉过的账号排在没沉过的后面，沉得早的排在沉得晚的前面', () => {
  const sank1 = account('aaa-sank1', { sunk: 1 })
  const sank2 = account('bbb-sank2', { sunk: 2 })
  const sank3 = account('ccc-sank3', { sunk: 3 })
  const first = account('zzz-first') // 没沉过
  // id 与沉的先后一致，所以这一条靠 sinkOrder 之外的东西也能过；下面那条才是判据。
  assert.deepEqual(ids(rankCandidates([sank3, sank2, sank1, first], NOW)), ['zzz-first', 'aaa-sank1', 'bbb-sank2', 'ccc-sank3'])

  // 这条必须由 Sink 决定：只按额度排的话 aaa（用得少、重置还早）会排第一
  const betterButSunk = account('aaa-better-but-sunk', { windows: [window_(5, 2)], sunk: 1 })
  const worseButFresh = account('zzz-worse-but-fresh', { windows: [window_(50, 2)] })
  assert.equal(rankCandidates([worseButFresh], NOW).why, 'only')
  assert.deepEqual(ids(rankCandidates([betterButSunk, worseButFresh], NOW)), ['zzz-worse-but-fresh', 'aaa-better-but-sunk'])
})

test('全都被限流过时，选沉得最早的那个，并说清是为什么', () => {
  // 只按额度排的话 aaa（用 5%）会排第一；沉过之后要按沉的先后，所以 zzz（用 50%）先上
  const later = account('aaa-later', { windows: [window_(5, 2)], sunk: 9 })
  const earlier = account('zzz-earlier', { windows: [window_(50, 2)], sunk: 2 })
  const result = rankCandidates([later, earlier], NOW)
  assert.deepEqual(ids(result), ['zzz-earlier', 'aaa-later'])
  assert.equal(result.why, 'sunk')
})

test('sinkOrder 只搬位置，不改路由给出的相对顺序', () => {
  const a = account('a')
  const b = account('b', { sunk: 2 })
  const c = account('c')
  const d = account('d', { sunk: 1 })
  assert.deepEqual(ids(sinkOrder([a, b, c, d])), ['a', 'c', 'd', 'b'])
})

// —— id 只是最后的 tie-break ——————————————————————————————————————

test('完全并列时按 id 定序，且 why 说明是它', () => {
  const z = account('z', { windows: [window_(50, 2)] })
  const a = account('a', { windows: [window_(50, 2)] })
  const result = rankCandidates([z, a], NOW)
  assert.deepEqual(ids(result), ['a', 'z'])
  assert.equal(result.why, 'tie-break')
})

test('id 不再决定谁先上：额度差的账号即使 id 靠前也排在后面', () => {
  const badId = account('aaa', { windows: [window_(95, 2)] })
  const goodId = account('zzz', { windows: [window_(5, 2)] })
  assert.deepEqual(ids(rankCandidates([badId, goodId], NOW)), ['zzz', 'aaa'])
})

// —— 外壳 ——————————————————————————————————————————————————————

test('空输入与单元素输入', () => {
  assert.deepEqual(rankCandidates([], NOW), { order: [], chosen: undefined, why: 'none' })
  assert.deepEqual(rankCandidates(undefined, NOW), { order: [], chosen: undefined, why: 'none' })
  const only = account('only')
  const result = rankCandidates([only], NOW)
  assert.equal(result.chosen, only)
  assert.equal(result.why, 'only')
})

test('不改入参', () => {
  const a = account('a', { windows: [window_(95, 2)] })
  const b = account('b', { windows: [window_(5, 2)] })
  const input = [a, b]
  rankCandidates(input, NOW)
  assert.deepEqual(input, [a, b])
  assert.notEqual(rankCandidates(input, NOW).order, input)
})

test('额度读数是脏数据时当「不知道」，不当 0 也不当 100', () => {
  assert.equal(shareOf(account('x', { windows: [{ used: NaN }] })), undefined)
  assert.equal(shareOf(account('x', { windows: [{ used: '80' }] })), 80) // 字符串数字认
  assert.equal(shareOf(account('x', { windows: [{ used: -5 }] })), 0)
  assert.equal(shareOf(account('x', { windows: [{ used: 400 }] })), 100)
  assert.equal(shareOf(account('x')), undefined)
})

// —— 近期用量 —————————————————————————————————————————————————————

test('近期用量按半衰期衰减', () => {
  const at = NOW
  const entry = decayUsage(undefined, at, 8)
  assert.equal(entry.weight, 8)
  assert.equal(usageNow(entry, at), 8)
  assert.equal(usageNow(entry, at + USAGE_HALF_LIFE_MS), 4)
  assert.equal(usageNow(entry, at + 2 * USAGE_HALF_LIFE_MS), 2)
  assert.equal(usageNow(entry, at + 3 * USAGE_HALF_LIFE_MS), 1)
})

test('新增用量时先把旧的衰减掉再加', () => {
  const first = decayUsage(undefined, NOW, 8)
  const second = decayUsage(first, NOW + USAGE_HALF_LIFE_MS, 1)
  assert.equal(second.weight, 5) // 8 → 4，再加 1
  assert.equal(decayUsage(undefined, NOW, 0).weight, 0)
  assert.equal(usageNow(undefined, NOW), 0)
})

test('近期用量只把并列的账号摊开，不会压过额度', () => {
  const busy = account('busy', { windows: [window_(5, 2)], usedRecently: 99 })
  const idle = account('idle', { windows: [window_(50, 2)], usedRecently: 0 })
  // 50% 用的比 5% 多，但都还在「可用」档；pace：95/2=47.5 对 50/2=25 ⇒ idle 排后面
  assert.deepEqual(ids(rankCandidates([busy, idle], NOW)), ['busy', 'idle'])

  const tied = account('tied', { windows: [window_(50, 2)], usedRecently: 0 })
  const same = account('same', { windows: [window_(50, 2)], usedRecently: 99 })
  assert.deepEqual(ids(rankCandidates([same, tied], NOW)), ['tied', 'same'])
})
