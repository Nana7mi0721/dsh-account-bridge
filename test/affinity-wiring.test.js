/**
 * W7 的接线：会话亲和真的影响了池子**先派谁上**，而且活得过一次重启。
 *
 * `test/affinity.test.js` 钉的是判据本身（`decide()` 那张表与那本账）；
 * 这一份钉的是**池子有没有把该喂的东西喂进去**：
 * 实测的缓存读取量有没有从流里抓出来、成功之后有没有记账、
 * 冷却中的账号会不会被粘住、以及落盘之后换个适配器还认不认这段会话。
 *
 * 每个用例都构造成「去掉亲和这一层就会给出相反结果」的形状。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { AffinityBook } from '../src/affinity.js'
import { CooldownTable } from '../src/health.js'
import { AccountBridgeAdapter } from '../src/pool.js'
import { AccountStore } from '../src/store.js'
import { createMemoryCredentials } from './harness.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }
const HOUR = 3_600_000

/** 一个固定的「两小时后重置」。写死是为了让两个账号的读数逐字节相同。 */
const SOON = Date.now() + 2 * HOUR

/** 让后台那些 fire-and-forget 的活（额度查询、落盘排期）跑完。 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** 正常的一轮，顺带报一次「上游从缓存里读到了多少」。 */
function okWith(cacheRead) {
  return async function* ok() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: cacheRead } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 造一个两账号的池子。`readings` 返回额度窗口；返回 `undefined` ＝ 上游什么都没说。 */
async function build({
  readings,
  stream,
  accounts = ['codex-1', 'codex-2'],
  affinity,
  affinityMode,
  shared,
} = {}) {
  const credentials = shared?.credentials ?? createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  for (const id of accounts) {
    if (await store.read(id)) continue
    await store.write(id, {
      id,
      family: 'codex',
      label: id,
      auth: { access: 't', refresh: 'r', expiresAt: Date.now() + HOUR, accountId: id },
    })
  }
  const tried = []
  const family = {
    id: 'codex',
    displayName: 'Fake Codex',
    route: 'acct-codex',
    async listModels() {
      return [{ provider: 'acct-codex', id: 'm1', name: 'M1' }]
    },
    resolveModel(provider, model) {
      return { provider, id: model, name: model }
    },
    needsRefresh() {
      return false
    },
    async *stream(ctx, options) {
      tried.push(options.payload.id)
      yield* (stream ?? okWith(5000))(options.payload.id, tried.length)
    },
  }
  if (readings) family.quota = async (ctx, payload) => readings(payload.id)
  const health = shared?.health ?? new CooldownTable()
  const book = affinity ?? new AffinityBook({ log: silent, debounceMs: HOUR })
  const adapter = new AccountBridgeAdapter({
    ctx: { fetch: async () => {}, log: silent, config: {} },
    store,
    health,
    families: [family],
    log: silent,
    affinity: book,
    affinityMode,
  })
  return { adapter, family, health, tried, store, book, credentials }
}

/** 装配池子，并等后台那次额度查询落地。 */
async function warm(adapter) {
  await adapter.listModels('acct-codex')
  await settle()
  await settle()
}

/** 跑一轮，返回这一轮**试过**的账号顺序（存在 `tried` 里）。 */
async function attempt(adapter, conversation, model = 'm1') {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'acct-codex',
    model,
    messages: [{ id: conversation, role: 'user' }],
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks.at(-1).type, 'finish', '这一轮没跑完')
}

/** 一个「还剩这么多」的额度读数（`fraction` 是**剩余**比例）。 */
function left(fraction) {
  return [{ id: 'weekly', name: '周窗口', remainingFraction: fraction, resetAt: SOON }]
}

/** 一个可以中途改答案的额度表；改完要 `invalidate` + `warm`，因为额度快照有 5 分钟 TTL。 */
function mutableReadings(initial) {
  const table = { ...initial }
  return { table, read: (id) => (table[id] === undefined ? undefined : left(table[id])) }
}

/** 一张内存「盘」，接口形状与 `ctx.storageDomain` 的表一致。 */
function memoryTable() {
  const data = new Map()
  return {
    data,
    get: (key) => data.get(key),
    entries: () => data.entries(),
    keys: () => data.keys(),
    get size() {
      return data.size
    },
    async put(key, value) {
      data.set(key, value)
    },
    async delete(key) {
      return data.delete(key)
    },
  }
}

test('同一段会话的第二轮还是同一个账号——哪怕排序已经换成另一个', async () => {
  const reading = mutableReadings({ 'codex-1': 0.5, 'codex-2': 0.5 })
  const { adapter, tried } = await build({ readings: reading.read })

  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1'], '额度一样时按 id 顺序，先派 codex-1')

  // 现在 codex-2 明显更空（它只用了 1%，codex-1 用了 95%）：排序会说该换它了。
  tried.length = 0
  reading.table['codex-1'] = 0.05
  reading.table['codex-2'] = 0.99
  adapter.invalidate('codex')
  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1'], '同一段会话不该被抢走')

  // 而**新的一段**会话按排序走，去 codex-2。
  tried.length = 0
  await attempt(adapter, 'u2')
  assert.deepEqual(tried, ['codex-2'], '新会话要按额度排序选')
})

test('上游说它这次没读到缓存 ⇒ 不值得为它换号，下一轮重新按排序选', async () => {
  const reading = mutableReadings({ 'codex-1': 0.5, 'codex-2': 0.5 })
  const { adapter, tried } = await build({ readings: reading.read, stream: okWith(0) })

  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1'])

  tried.length = 0
  reading.table['codex-1'] = 0.05
  reading.table['codex-2'] = 0.99
  adapter.invalidate('codex')
  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-2'], '缓存没读到时粘性不该拦着换号')
  assert.equal(adapter.lastWhy('codex').at(-1).why, 'cache-weak')
})

test('usage 里报的缓存读取量会原样记进账本（不是拿不到就当有缓存）', async () => {
  const withUsage = await build({ stream: okWith(5000) })
  await attempt(withUsage.adapter, 'u1')
  assert.equal(withUsage.book.size, 1, '答完一轮就该记一条')

  const [key] = withUsage.book.keys()
  assert.match(key, /^codex-[0-9a-f]{24}$/)
  const record = withUsage.book.get(key, Date.now())
  assert.equal(record.accountId, 'codex-1')
  assert.equal(record.cacheRead, 5000, 'usage 里报的缓存量要原样记下来')
  assert.equal(record.model, 'm1')

  const noCache = await build({ stream: okWith(0) })
  await attempt(noCache.adapter, 'u2')
  const [key2] = noCache.book.keys()
  assert.equal(noCache.book.get(key2, Date.now()).cacheRead, 0)
})

test('usage 里的缓存量是「最后一次非零」——后面的显式 0 不能把它擦掉', async () => {
  // 兼容端点常这么回：流中间报一次真实读数，收尾再补一个 0。
  const stream = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 100, cachedInputTokens: 4096 } }
    yield { type: 'usage', usage: { inputTokens: 0, cachedInputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const { adapter, book } = await build({ stream })
  await attempt(adapter, 'u1')
  const [key] = book.keys()
  assert.equal(book.get(key, Date.now()).cacheRead, 4096)
})

test('模式 off 时不粘：同一段会话也会被排序抢走', async () => {
  const reading = mutableReadings({ 'codex-1': 0.5, 'codex-2': 0.5 })
  const { adapter, tried } = await build({ readings: reading.read, affinityMode: 'off' })

  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1'])

  tried.length = 0
  reading.table['codex-1'] = 0.05
  reading.table['codex-2'] = 0.99
  adapter.invalidate('codex')
  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-2'], 'off 就是不粘，按排序走')
  assert.equal(adapter.lastWhy('codex').at(-1).why, 'off')
})

test('上次答它的账号在冷却里 ⇒ 不粘它，换一个', async () => {
  const { adapter, tried, health } = await build({})
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1'])

  // 手动把它冻上（等价于它刚刚失败过一次）。
  health.record('codex', 'codex-1', 'm1', {
    action: 'switch',
    reason: 'SERVER',
    cooldownMs: 60_000,
    scope: 'member',
  })

  tried.length = 0
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-2'], '冻住的账号不该被粘住')
  assert.equal(adapter.lastWhy('codex').at(-1).why, 'resting')
})

test('lastWhy 说得出理由，debugState 报得出模式与账本大小', async () => {
  const { adapter } = await build({})
  await attempt(adapter, 'u1')

  // 第一轮是这段会话的**第一次**，所以理由是「还没有人答过」——记录是本轮结束时才写的。
  const first = adapter.lastWhy('codex')
  assert.equal(first.length, 1)
  assert.equal(first[0].why, 'sticky-new')
  assert.equal(first[0].accountId, undefined, '还没有人能答它')
  assert.equal(first[0].family, 'codex')
  assert.equal(first[0].model, 'm1')

  await attempt(adapter, 'u1')
  // `lastWhy` 按**会话**记（键就是那条粘性键），所以同一段会话只留最新的一条。
  assert.equal(adapter.lastWhy('codex').length, 1)
  const why = adapter.lastWhy('codex')
  assert.equal(why[0].why, 'sticky-hit')
  assert.equal(why[0].accountId, 'codex-1')

  const state = adapter.debugState()
  assert.equal(state.affinity.mode, 'auto')
  assert.equal(state.affinity.size, 1)
  assert.equal(state.affinity.persisted, false, '测试里没接表')
  assert.deepEqual(state.why, [`${why[0].key}=sticky-hit@codex-1`], 'debugState 也报同一件事')

  // 不给族名就是全部；给了别的族就是空。
  assert.equal(adapter.lastWhy().length, 1)
  assert.equal(adapter.lastWhy('claude').length, 0)
})

test('clearSticky 丢掉记录之后，这段会话重新按排序走', async () => {
  const reading = mutableReadings({ 'codex-1': 0.5, 'codex-2': 0.5 })
  const { adapter, tried } = await build({ readings: reading.read })

  await warm(adapter)
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1'])

  reading.table['codex-1'] = 0.05
  reading.table['codex-2'] = 0.99
  adapter.invalidate('codex')
  await warm(adapter)
  tried.length = 0
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-1'], '前提：这时候还粘着')
  assert.equal(adapter.lastWhy('codex').at(-1).why, 'sticky-hit')

  adapter.clearSticky('codex')
  assert.equal(adapter.debugState().affinity.size, 0)
  assert.deepEqual(adapter.lastWhy('codex'), [])

  tried.length = 0
  await attempt(adapter, 'u1')
  assert.deepEqual(tried, ['codex-2'], '忘掉之后就该按排序走')
})

test('forgetAccount 只丢掉指向那个账号的记录，别的账号答过的照旧粘着', async () => {
  // 与 `clearSticky` 的差别就是这一条：删掉 `codex-2` 不该让 `codex-1` 答过的会话一起失忆。
  const { adapter, book } = await build()
  await warm(adapter)
  await attempt(adapter, 'u1')
  await attempt(adapter, 'u2')
  assert.equal(book.size, 2)
  // 两段会话落在两个账号上（第二段是新的，排序按「最近用过的让位」把它给了 codex-2）。
  const owners = book.entries().map(([, value]) => value.accountId).sort()
  assert.deepEqual(owners, ['codex-1', 'codex-2'])

  assert.equal(adapter.forgetAccount('codex-1'), 1)
  assert.equal(book.size, 1, 'codex-2 答过的那段要留着')
  assert.equal(book.entries()[0][1].accountId, 'codex-2')
  // `lastWhy` 是给面板看的环形缓冲（上限 1000），不是账本：第二段的裁决是 `sticky-new`，
  // 那时候还没有「谁答过」，所以那行本来就没有 accountId，不该被这次遗忘带走。
  assert.equal(adapter.lastWhy('codex').length, 2)
  assert.equal(adapter.forgetAccount('codex-1'), 0, '再删一次就是 0')
  assert.equal(adapter.forgetAccount('codex-2'), 1)
})

test('传进来的账本就是适配器用的那本（storageDomain 就绪后接表要接对对象）', async () => {
  const book = new AffinityBook({ log: silent, debounceMs: HOUR })
  const { adapter } = await build({ affinity: book })
  assert.equal(adapter.affinityBook(), book)
  await attempt(adapter, 'u1')
  assert.equal(book.size, 1)
  assert.equal(book.persisted, false)
})

test('两段不同的会话各自粘各自的账号', async () => {
  const { adapter, tried, book } = await build({})
  await attempt(adapter, 'u1') // → codex-1
  await attempt(adapter, 'u2') // → codex-2（codex-1 已经答过一轮，让给没答过的）
  await attempt(adapter, 'u1') // → 还是 codex-1
  assert.deepEqual(tried, ['codex-1', 'codex-2', 'codex-1'])
  assert.equal(book.size, 2)
})

test('同一段会话换模型是两个槽位（键里带模型）', async () => {
  const { adapter, book } = await build({})
  await attempt(adapter, 'u1', 'm1')
  await attempt(adapter, 'u1', 'm1')
  assert.equal(book.size, 1, '同一个模型还是那一条')
})

test('落盘之后换个适配器，这段会话还认原来的账号（重启不失忆）', async () => {
  const table = memoryTable()

  const first = await build({})
  const firstBook = new AffinityBook({ log: silent, debounceMs: HOUR })
  firstBook.attach(table)
  const rebuilt = await build({ affinity: firstBook, shared: { credentials: first.credentials } })
  await attempt(rebuilt.adapter, 'u1')
  assert.deepEqual(rebuilt.tried, ['codex-1'])
  await firstBook.flush()
  assert.equal(table.data.size, 1, '应当已经写到「盘」上')
  assert.equal(firstBook.persisted, true)
  await firstBook.close()

  // 「重启」：新账本、新适配器，同一份存储、同一份凭据。
  const secondBook = new AffinityBook({ log: silent, debounceMs: HOUR })
  secondBook.attach(table)
  assert.equal(secondBook.size, 1, '重启后应当把记录读回来')

  const restarted = await build({
    affinity: secondBook,
    shared: { credentials: rebuilt.credentials, health: new CooldownTable() },
  })
  await attempt(restarted.adapter, 'u1')
  assert.deepEqual(restarted.tried, ['codex-1'], '重启之后还该粘在同一个账号上')
  assert.equal(restarted.adapter.lastWhy('codex').at(-1).why, 'sticky-hit')
  await secondBook.close()
})
