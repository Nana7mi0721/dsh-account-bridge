// W7：会话亲和（粘谁、为什么粘、以及记录怎么活过一次重启）。
//
// 这一份测的是**判据**，不是「代码跑得动」：`decide()` 那张表里的每一条都对应一个真实
// 场景（换个模型问一句、agent 在回传工具结果、上游说它这次没读到缓存…），
// 而 `AffinityBook` 那半份测的是**不许把真记录弄丢**——读不懂的记录删掉，
// 而不是当成「没有这段会话」然后在下一次落盘时把好的那条也抹掉。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AFFINITY_MODES,
  AffinityBook,
  CACHE_COLD_MS,
  CACHE_WORTH,
  DEFAULT_AFFINITY_MODE,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  STICK_KEEP_MS,
  STICKS_KEPT,
  TABLE_NAME,
  affinitySpec,
  cachedRead,
  decide,
  isFresh,
  keepKeys,
  normaliseMode,
  openAffinityTable,
  parseRecord,
  recordKey,
  turnOf,
} from '../src/affinity.js'

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** 候选按「选号给出的顺序」排；`decide()` 只挑其中一个，不重排。 */
const candidates = (...ids) => ids.map((id) => ({ id }))

/** 一条来自上一轮的记录：答过、读到过 5000 缓存、1 秒前。 */
const record = (extra = {}) => ({
  accountId: 'codex-1',
  model: 'gpt-5-codex',
  turn: 2,
  at: NOW - 1000,
  cacheRead: 5000,
  ...extra,
})

/** 一张内存里的假表，形状照宿主的 `KvTableImpl`（`entries()` 用得上，`get()` 同步）。 */
function fakeTable(initial = {}, { failPut = false, failDelete = false } = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    failPut,
    failDelete,
    get: (key) => data.get(key),
    entries: () => data.entries(),
    keys: () => data.keys(),
    get size() {
      return data.size
    },
    async put(key, value) {
      if (this.failPut) throw new Error('disk is on fire')
      data.set(key, value)
    },
    async delete(key) {
      if (this.failDelete) throw new Error('disk is on fire')
      return data.delete(key)
    },
  }
}

/** 时钟固定的账本；`debounceMs` 给大值，于是只有显式 `flush()` 才落盘。 */
function book(table, { now = () => NOW, log } = {}) {
  const instance = new AffinityBook({ log, now, debounceMs: HOUR })
  if (table !== undefined) instance.attach(table)
  return instance
}

// ---------------------------------------------------------------- 四态

test('四态：认不出的配置回默认值，永不抛', () => {
  for (const mode of AFFINITY_MODES) assert.equal(normaliseMode(mode), mode)
  assert.equal(normaliseMode(' AUTO '), 'auto')
  assert.equal(normaliseMode('Session'), 'session')
  for (const bad of [undefined, null, '', '   ', 'yes', 'autoo', 42, {}, []]) {
    assert.equal(normaliseMode(bad), DEFAULT_AFFINITY_MODE, `${JSON.stringify(bad)} 应回默认`)
  }
  assert.equal(DEFAULT_AFFINITY_MODE, 'auto')
})

// ---------------------------------------------------------------- 轮与工具结果

test('turnOf：用户每开一次口算一轮，工具结果说明这一轮还没完', () => {
  assert.deepEqual(turnOf([]), { turn: 0, within: false })
  assert.deepEqual(turnOf(undefined), { turn: 0, within: false })
  assert.deepEqual(turnOf([{ role: 'user', content: 'hi' }]), { turn: 1, within: false })
  assert.deepEqual(
    turnOf([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]),
    { turn: 2, within: false },
  )
})

test('turnOf：DSH 的工具结果是独立的一条 role:"tool" 消息，也算轮内', () => {
  // magpie 的消息是 Anthropic 形状（工具结果在 user 消息里当 part），DSH 是独立消息。
  // 只认 user 的话 within 永远为假，而「agent 正在回传工具结果」恰好是缓存最值钱的时候。
  const messages = [
    { role: 'user', content: '读一下这个文件' },
    { role: 'assistant', content: '好' },
    { role: 'tool', content: '文件内容' },
  ]
  assert.deepEqual(turnOf(messages), { turn: 1, within: true })
})

test('turnOf：Anthropic 形状的 tool-result part 也认，且这一条不算新的一轮', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '跑一下' }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'run' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: 'ok' }] },
  ]
  assert.deepEqual(turnOf(messages), { turn: 1, within: true })
})

test('turnOf：最后一条 user 说了算——它之后用户又问了别的就算新一轮', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '跑一下' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: '那再跑一次' }] },
  ]
  assert.deepEqual(turnOf(messages), { turn: 2, within: false })
})

test('turnOf：图片也算「用户开口了」', () => {
  assert.deepEqual(turnOf([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png' }] }]), {
    turn: 1,
    within: false,
  })
  // 纯空 content 不算开口。
  assert.deepEqual(turnOf([{ role: 'user', content: '' }]), { turn: 0, within: false })
  assert.deepEqual(turnOf([{ role: 'user' }]), { turn: 0, within: false })
})

// ---------------------------------------------------------------- 实测的缓存读取量

test('cachedRead：三个方言的字段名都认，读不到就是 0（不是 undefined）', () => {
  assert.equal(cachedRead({ cachedInputTokens: 5000 }), 5000)
  assert.equal(cachedRead({ cacheReadInputTokens: 7 }), 7)
  assert.equal(cachedRead({ cached_tokens: 9 }), 9)
  // DSH 自己的 chunk 形状。
  assert.equal(cachedRead({ cachedInputTokens: 12, outputTokens: 3 }), 12)
  assert.equal(cachedRead({ cachedInputTokens: 1, cacheReadInputTokens: 999 }), 1, '第一个是权威值')
  for (const bad of [undefined, null, {}, { cachedInputTokens: 0 }, { cachedInputTokens: -3 }, { cachedInputTokens: 'abc' }, { cachedInputTokens: NaN }]) {
    assert.equal(cachedRead(bad), 0, `${JSON.stringify(bad)} 应当是 0`)
  }
})

// ---------------------------------------------------------------- 记录键

test('recordKey：键必须能过宿主 storage-json 的 [a-zA-Z0-9_-]+，所以压成摘要', () => {
  const key = recordKey('codex', 'gpt-5-codex', 'sess/../../etc/passwd\u0000💥')
  assert.match(key, /^[a-zA-Z0-9_-]+$/, `键里有宿主不接受的字符：${key}`)
  assert.ok(key.startsWith('codex-'))
  assert.equal(key, recordKey('codex', 'gpt-5-codex', 'sess/../../etc/passwd\u0000💥'), '同样的输入要得到同样的键')
})

test('recordKey：换模型或换会话都换键（键里带模型是刻意偏离 magpie）', () => {
  const base = recordKey('codex', 'gpt-5-codex', 's1')
  assert.notEqual(base, recordKey('codex', 'gpt-5', 's1'), '换模型要换键')
  assert.notEqual(base, recordKey('codex', 'gpt-5-codex', 's2'), '换会话要换键')
  assert.notEqual(base, recordKey('claude', 'gpt-5-codex', 's1'), '换族要换键')
  // 模型名与会话 id 的拼接必须无歧义（否则 ('ab','c') 与 ('a','bc') 会撞）。
  assert.notEqual(recordKey('x', 'ab', 'c'), recordKey('x', 'a', 'bc'))
})

// ---------------------------------------------------------------- 从盘上读回来的记录

test('parseRecord：读不懂就返回 undefined，绝不返回「一个空记录」', () => {
  assert.equal(parseRecord(undefined), undefined)
  assert.equal(parseRecord(null), undefined)
  assert.equal(parseRecord('codex-1'), undefined)
  assert.equal(parseRecord([]), undefined)
  assert.equal(parseRecord({}), undefined, '没有 accountId')
  assert.equal(parseRecord({ accountId: '' }), undefined)
  assert.equal(parseRecord({ accountId: 'codex-1' }), undefined, '没有 at')
  assert.equal(parseRecord({ accountId: 'codex-1', at: 'abc' }), undefined)
  assert.equal(parseRecord({ accountId: 'codex-1', at: NaN }), undefined)
})

test('parseRecord：能读的那条会被归一化（缺字段补默认，脏字段丢掉）', () => {
  assert.deepEqual(parseRecord({ accountId: 'codex-1', at: 5 }), {
    accountId: 'codex-1',
    model: '',
    turn: 0,
    at: 5,
    cacheRead: 0,
  })
  assert.deepEqual(
    parseRecord({ accountId: 'codex-1', model: 'm', effort: 'high', turn: 3, at: 5, cacheRead: 900, junk: 1 }),
    { accountId: 'codex-1', model: 'm', effort: 'high', turn: 3, at: 5, cacheRead: 900 },
  )
  // effort 不是非空字符串就不带这个键（而不是带一个 undefined）。
  assert.equal('effort' in parseRecord({ accountId: 'a', at: 1, effort: 42 }), false)
  assert.equal('effort' in parseRecord({ accountId: 'a', at: 1, effort: '' }), false)
})

test('isFresh：24 小时是「这条记录还留着」，不是「这 24 小时都粘」', () => {
  assert.equal(isFresh(record({ at: NOW }), NOW), true)
  assert.equal(isFresh(record({ at: NOW - STICK_KEEP_MS }), NOW), true, '正好在边界上还算新')
  assert.equal(isFresh(record({ at: NOW - STICK_KEEP_MS - 1 }), NOW), false)
  assert.equal(isFresh(undefined, NOW), false)
  assert.equal(isFresh(record({ at: NaN }), NOW), false, 'at 是 NaN 的记录不该粘住谁')
})

test('keepKeys：过期的全丢，其余留「最近答过的」那 N 条', () => {
  const memory = new Map([
    ['old', record({ at: NOW - STICK_KEEP_MS - 1 })],
    ['a', record({ at: NOW - 3000 })],
    ['b', record({ at: NOW - 1000 })],
    ['c', record({ at: NOW - 2000 })],
  ])
  assert.deepEqual([...keepKeys(memory, NOW, 2)].sort(), ['b', 'c'])
  assert.deepEqual([...keepKeys(memory, NOW, 10)].sort(), ['a', 'b', 'c'])
  assert.deepEqual([...keepKeys(memory, NOW, 0)], [])
})

// ---------------------------------------------------------------- 判据表

test('decide：模式是 off 时不粘，哪怕上一轮缓存刚刚读过', () => {
  const verdict = decide({ mode: 'off', record: record(), candidates: candidates('codex-1'), now: NOW })
  assert.equal(verdict.why, 'off')
  assert.equal(verdict.kept, false)
  // at 仍然指出来（面板要能显示「上次是它答的」），只是不把它挪到最前。
  assert.equal(verdict.at, 0)
  assert.equal(verdict.accountId, 'codex-1')
})

test('decide：没有记录、或记录已经过了保留期 ⇒ sticky-new', () => {
  assert.equal(decide({ mode: 'auto', candidates: candidates('a'), now: NOW }).why, 'sticky-new')
  assert.equal(
    decide({ mode: 'auto', record: record({ at: NOW - STICK_KEEP_MS - 1 }), candidates: candidates('codex-1'), now: NOW }).why,
    'sticky-new',
  )
  // 一段**过期**的记录不该被当成 gone（那是两件不同的事）。
  assert.equal(decide({ mode: 'auto', record: record({ at: NOW - STICK_KEEP_MS - 1 }), candidates: [], now: NOW }).why, 'sticky-new')
})

test('decide：上次答它的账号不在候选里 ⇒ gone', () => {
  const verdict = decide({ mode: 'auto', record: record(), candidates: candidates('codex-2'), now: NOW })
  assert.equal(verdict.why, 'gone')
  assert.equal(verdict.kept, false)
  assert.equal(verdict.at, -1)
  assert.equal(verdict.accountId, undefined)
})

test('decide：它在冷却里 ⇒ resting（压过 spent）', () => {
  const verdict = decide({
    mode: 'auto',
    record: record(),
    candidates: candidates('codex-2', 'codex-1'),
    resting: new Set(['codex-1']),
    spent: new Set(['codex-1']),
    now: NOW,
  })
  assert.equal(verdict.why, 'resting')
  assert.equal(verdict.kept, false)
})

test('decide：「几乎用满」只有它本来就不在第一个位置上才换号', () => {
  const spentNow = new Set(['codex-1'])
  // 它排在第二个 ⇒ 不拉回来。
  const shifted = decide({
    mode: 'auto',
    record: record(),
    candidates: candidates('codex-2', 'codex-1'),
    spent: spentNow,
    now: NOW,
  })
  assert.equal(shifted.why, 'spent')
  assert.equal(shifted.kept, false)
  // 它本来就排第一 ⇒ 继续用它，直到上游真的拒绝。
  const first = decide({
    mode: 'auto',
    record: record(),
    candidates: candidates('codex-1', 'codex-2'),
    spent: spentNow,
    now: NOW,
  })
  assert.equal(first.why, 'sticky-hit')
  assert.equal(first.kept, true)
})

test('decide：session 模式整段会话都粘，turn 模式只在轮内粘', () => {
  const base = { record: record(), candidates: candidates('codex-1'), now: NOW }
  assert.equal(decide({ ...base, mode: 'session' }).why, 'session')
  assert.equal(decide({ ...base, mode: 'session' }).kept, true)
  // session 之下缓存为 0 也照样粘（人明确要求的）。
  assert.equal(decide({ ...base, mode: 'session', record: record({ cacheRead: 0 }) }).why, 'session')
  assert.equal(decide({ ...base, mode: 'turn', within: true }).why, 'turn')
  assert.equal(decide({ ...base, mode: 'turn', within: true }).kept, true)
  assert.equal(decide({ ...base, mode: 'turn', within: false }).why, 'sticky-miss')
  assert.equal(decide({ ...base, mode: 'turn', within: false }).kept, false)
})

test('decide：auto 之下轮内总是粘（缓存那两条排在它后面）', () => {
  const verdict = decide({
    mode: 'auto',
    record: record({ cacheRead: 0, at: NOW - 10 * MINUTE }),
    candidates: candidates('codex-1'),
    within: true,
    now: NOW,
  })
  assert.equal(verdict.why, 'turn', 'agent 在回传工具结果时不该被缓存判据踢开')
  assert.equal(verdict.kept, true)
})

test('decide：跨轮粘不粘看实测——上次读到不到 1024 token 就不值得留', () => {
  const weak = decide({ mode: 'auto', record: record({ cacheRead: CACHE_WORTH - 1 }), candidates: candidates('codex-1'), now: NOW })
  assert.equal(weak.why, 'cache-weak')
  assert.equal(weak.kept, false)
  const enough = decide({ mode: 'auto', record: record({ cacheRead: CACHE_WORTH }), candidates: candidates('codex-1'), now: NOW })
  assert.equal(enough.why, 'sticky-hit', '正好 1024 就值得留')
})

test('decide：缓存读取量读不到时按「不值得留」算，不能反过来', () => {
  // NaN < 1024 是 false，一不小心就变成「没读到缓存却当成缓存很值钱」。
  for (const cacheRead of [undefined, null, NaN, 'abc']) {
    assert.equal(
      decide({ mode: 'auto', record: record({ cacheRead }), candidates: candidates('codex-1'), now: NOW }).why,
      'cache-weak',
      `cacheRead=${String(cacheRead)} 应当按不值得留算`,
    )
  }
})

test('decide：缓存凉了就不粘了（5 分钟）', () => {
  const cold = decide({ mode: 'auto', record: record({ at: NOW - CACHE_COLD_MS - 1 }), candidates: candidates('codex-1'), now: NOW })
  assert.equal(cold.why, 'cache-cold')
  const warm = decide({ mode: 'auto', record: record({ at: NOW - CACHE_COLD_MS }), candidates: candidates('codex-1'), now: NOW })
  assert.equal(warm.why, 'sticky-hit', '正好 5 分钟还算热')
})

test('decide：一切正常 ⇒ sticky-hit，并且说出是哪个账号', () => {
  const verdict = decide({
    mode: 'auto',
    record: record(),
    candidates: candidates('codex-2', 'codex-1', 'codex-3'),
    now: NOW,
  })
  assert.equal(verdict.why, 'sticky-hit')
  assert.equal(verdict.kept, true)
  assert.equal(verdict.at, 1, 'at 是它在**选号给出的顺序**里的位置，不是 0')
  assert.equal(verdict.accountId, 'codex-1')
})

test('decide：每一个裁决都在 WHY_VALUES 里，且 kept 只对三种为真', () => {
  const seen = new Set()
  const cases = [
    { mode: 'off', record: record() },
    { mode: 'auto' },
    { mode: 'auto', record: record(), candidates: candidates('other') },
    { mode: 'auto', record: record(), candidates: candidates('codex-1'), resting: new Set(['codex-1']) },
    { mode: 'auto', record: record(), candidates: candidates('x', 'codex-1'), spent: new Set(['codex-1']) },
    { mode: 'session', record: record(), candidates: candidates('codex-1') },
    { mode: 'auto', record: record(), candidates: candidates('codex-1'), within: true },
    { mode: 'turn', record: record(), candidates: candidates('codex-1') },
    { mode: 'auto', record: record({ cacheRead: 0 }), candidates: candidates('codex-1') },
    { mode: 'auto', record: record({ at: NOW - HOUR }), candidates: candidates('codex-1') },
    { mode: 'auto', record: record(), candidates: candidates('codex-1') },
  ]
  for (const item of cases) {
    const verdict = decide({ ...item, now: NOW })
    seen.add(verdict.why)
    assert.equal(
      verdict.kept,
      ['session', 'turn', 'sticky-hit'].includes(verdict.why),
      `${verdict.why} 的 kept 不对`,
    )
  }
  assert.deepEqual(
    [...seen].sort(),
    ['cache-cold', 'cache-weak', 'gone', 'off', 'resting', 'session', 'spent', 'sticky-hit', 'sticky-miss', 'sticky-new', 'turn'],
    '判据表应当覆盖全部 11 种裁决',
  )
})

// ---------------------------------------------------------------- domain spec

test('affinitySpec：名字要能过宿主的 UNIT_NAME_RE（连字符不行），读不懂的记录故意抛', () => {
  const spec = affinitySpec()
  assert.equal(spec.name, DOMAIN_NAME)
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/, 'domain 名不能有连字符')
  assert.equal(spec.version, DOMAIN_VERSION)
  assert.equal(spec.invalidRecords, 'backup-and-skip', '读不懂的记录要挪走，不是当成没有')
  assert.deepEqual(Object.keys(spec.tables), [TABLE_NAME])
  const schema = spec.tables[TABLE_NAME].valueSchema
  assert.deepEqual(schema.parse({ accountId: 'codex-1', at: 7 }), {
    accountId: 'codex-1',
    model: '',
    turn: 0,
    at: 7,
    cacheRead: 0,
  })
  assert.throws(() => schema.parse({ nope: true }), /读不懂/, '读不懂就要抛，不能返回 undefined')
})

test('openAffinityTable：打不开不是错误，返回 undefined 让上层回落到纯内存', async () => {
  assert.equal(await openAffinityTable({ facility: undefined, log: silent() }), undefined)
  assert.equal(await openAffinityTable({ facility: {}, log: silent() }), undefined)
})

test('openAffinityTable：把 spec 原样交给 facility.open，并交出表与关闭钩子', async () => {
  let seen
  let closed = 0
  const table = fakeTable()
  const facility = {
    async open(spec) {
      seen = spec
      return { table: () => table, close: async () => { closed += 1 } }
    },
  }
  const opened = await openAffinityTable({ facility, log: silent() })
  assert.equal(seen.name, DOMAIN_NAME)
  assert.equal(opened.table, table)
  await opened.close()
  assert.equal(closed, 1)
})

test('openAffinityTable：关闭失败只记日志，不往外抛（收尾路径里抛出去没人接）', async () => {
  const facility = {
    async open() {
      return { table: () => fakeTable(), close: async () => { throw new Error('nope') } }
    },
  }
  const opened = await openAffinityTable({ facility, log: silent() })
  await opened.close()
})

// ---------------------------------------------------------------- 账本：纯内存

test('AffinityBook：没接上表也能用，只是标记成「不落盘」', async () => {
  const instance = book(undefined)
  assert.equal(instance.persisted, false)
  assert.equal(instance.size, 0)
  instance.remember('codex-abc', record())
  assert.equal(instance.size, 1)
  assert.equal(instance.get('codex-abc', NOW).accountId, 'codex-1')
  await instance.flush()
  assert.equal(instance.size, 1, '没接表时 flush 不该把记忆清掉')
  await instance.close()
})

test('AffinityBook：过期的记录读出来当没有（但还占着内存，等下次裁）', () => {
  const instance = book(undefined)
  instance.remember('k', record({ at: NOW - STICK_KEEP_MS - 1 }))
  assert.equal(instance.get('k', NOW), undefined)
})

test('AffinityBook：没接表时也要裁内存，否则它会无限长下去', async () => {
  const instance = book(undefined)
  for (let i = 0; i < STICKS_KEPT + 20; i += 1) {
    instance.remember(`k${String(i).padStart(4, '0')}`, record({ at: NOW - i }))
  }
  assert.equal(instance.size, STICKS_KEPT + 20)
  await instance.flush()
  assert.equal(instance.size, STICKS_KEPT, 'flush 之后应当只剩最近那 STICKS_KEPT 条')
  assert.equal(instance.get('k0000', NOW).accountId, 'codex-1', '最新的那条要留着')
  assert.equal(instance.get('k0512', NOW), undefined, '被裁掉的那条读不到了')
})

// ---------------------------------------------------------------- 账本：落盘

test('AffinityBook：记住 → 落盘 → 换一个新账本接上同一张表，重启不失忆', async () => {
  const store = new Map()
  const first = fakeTable()
  first.data.clear()
  // 用同一份底层 Map 模拟「同一个文件被两个进程/两次启动先后打开」。
  const shared = {
    get: (k) => store.get(k),
    entries: () => store.entries(),
    keys: () => store.keys(),
    get size() { return store.size },
    async put(k, v) { store.set(k, v) },
    async delete(k) { return store.delete(k) },
  }

  const before = book(shared)
  before.remember('codex-abc', record())
  assert.equal(store.size, 0, '还没 flush 时盘上应当是空的')
  await before.flush()
  assert.equal(store.size, 1, 'flush 之后盘上要有这条')
  assert.equal(store.get('codex-abc').accountId, 'codex-1')

  // 「重启」：新账本接上同一个存储。
  const after = book(shared)
  assert.equal(after.persisted, true)
  assert.equal(after.size, 1)
  const verdict = decide({
    mode: 'auto',
    record: after.get('codex-abc', NOW),
    candidates: candidates('codex-1', 'codex-2'),
    now: NOW,
  })
  assert.equal(verdict.why, 'sticky-hit', '重启之后这段会话还该粘在同一个账号上')
  await after.close()
})

test('AffinityBook：接表时内存里更新那条赢（新建的记录不该被盘上的旧值盖掉）', async () => {
  const stale = record({ accountId: 'codex-1', at: NOW - HOUR })
  const fresh = record({ accountId: 'codex-2', at: NOW - 1000 })
  const table = fakeTable({ k: stale })
  const instance = book(undefined)
  instance.remember('k', fresh)
  instance.attach(table)
  assert.equal(instance.get('k', NOW).accountId, 'codex-2')

  // 反方向：盘上那条更新，就该用盘上的。
  const other = book(undefined)
  other.remember('k', stale)
  other.attach(fakeTable({ k: fresh }))
  assert.equal(other.get('k', NOW).accountId, 'codex-2')
})

test('AffinityBook：盘上读不懂的记录会被删掉，不是当成「没有这段会话」', async () => {
  // 这一条正是 magpie LESSONS.md 第 9 条：把「读不出来」当成「空」，
  // 下一次写盘就会把好的那条也一起抹掉。
  const expired = record({ at: NOW - STICK_KEEP_MS - 1 })
  const table = fakeTable({ broken: { nope: true }, expired, good: record() })
  const instance = book(table)
  assert.equal(instance.size, 1, '读不懂的与过期的都不进内存')
  await instance.flush()
  assert.equal(table.data.has('broken'), false, '读不懂的记录要删掉，不能留在盘上')
  assert.equal(table.data.has('expired'), false, '过期记录要删掉')
  assert.equal(table.data.has('good'), true, '好记录不能被顺手抹掉')
})

test('AffinityBook：forget 之后盘上那条也没了', async () => {
  const table = fakeTable()
  const instance = book(table)
  instance.remember('k', record())
  await instance.flush()
  assert.equal(table.data.size, 1)
  instance.forget('k')
  await instance.flush()
  assert.equal(table.data.size, 0)
})

test('AffinityBook：clear 清掉全部；forgetPrefix 只清一个族', async () => {
  const table = fakeTable()
  const instance = book(table)
  instance.remember('codex-a', record())
  instance.remember('codex-b', record())
  instance.remember('claude-a', record())
  assert.equal(instance.forgetPrefix('codex-'), 2)
  assert.equal(instance.size, 1)
  assert.equal(instance.get('claude-a', NOW).accountId, 'codex-1')
  assert.equal(instance.forgetPrefix('nothing-'), 0)
  await instance.flush()
  assert.deepEqual([...table.data.keys()], ['claude-a'])
  instance.clear()
  await instance.flush()
  assert.equal(table.data.size, 0)
})

test('AffinityBook：forgetAccount 只清指向那一个账号的记录（别的账号答过的不动）', async () => {
  // 账号 id 会回收（`nextAccountId()` 取最小空号），所以删号必须忘掉指向它的记录；
  // 但别的账号答过的会话与这次删除无关，一起清就是白烧它们的上游缓存。
  const table = fakeTable()
  const instance = book(table)
  instance.remember('codex-a', record({ accountId: 'codex-1' }))
  instance.remember('codex-b', record({ accountId: 'codex-2' }))
  instance.remember('codex-c', record({ accountId: 'codex-1' }))
  assert.equal(instance.forgetAccount('codex-1'), 2)
  assert.equal(instance.size, 1, 'codex-2 答过的那段要留着')
  assert.equal(instance.forgetAccount('codex-9'), 0, '没这个账号就是 0，不报错')
  await instance.flush()
  assert.deepEqual([...table.data.keys()], ['codex-b'], '盘上也要只剩它')
})

test('AffinityBook：落盘失败时记录留在脏表里等下次，绝不假装写成功了', async () => {
  const table = fakeTable({}, { failPut: true })
  const instance = book(table, { log: silent() })
  instance.remember('k', record())
  await instance.flush()
  assert.equal(table.data.size, 0, '这次确实没写进去')
  assert.equal(instance.size, 1, '但记忆还在（写不进去是盘的问题，不是「没有这段会话」）')
  assert.equal(instance.get('k', NOW).accountId, 'codex-1')

  // 盘好了，下一次 flush 补上。
  table.failPut = false
  await instance.flush()
  assert.equal(table.data.size, 1, '补写要成功')
})

test('AffinityBook：删除失败同样不算数（下次还会再删一次）', async () => {
  const table = fakeTable({ k: record() }, { failDelete: true })
  const instance = book(table, { log: silent() })
  instance.forget('k')
  await instance.flush()
  assert.equal(table.data.has('k'), true, '删失败时盘上还在')
  assert.equal(instance.get('k', NOW), undefined, '内存里已经忘掉了')
})

test('AffinityBook：close 会落盘并停表，之后不再写', async () => {
  const table = fakeTable()
  const instance = book(table)
  instance.remember('k', record())
  await instance.close()
  assert.equal(table.data.size, 1, 'close 要先把攒着的写下去')
  instance.remember('k2', record())
  await instance.flush()
  assert.equal(table.data.has('k2'), false, 'close 之后不再写盘')
  await instance.close(), '重复 close 不该抛'
})

test('AffinityBook：flush 不递归重试（一个一直写不进去的盘不能变成死循环）', async () => {
  const table = fakeTable({}, { failPut: true })
  const instance = book(table, { log: silent() })
  instance.remember('k', record())
  await instance.flush() // 这里要是递归，就永远不会返回
  assert.equal(instance.get('k', NOW).accountId, 'codex-1')
  await instance.close()
})

/** 一个把话说出去的 logger 太吵；这里只要不抛。 */
function silent() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}
