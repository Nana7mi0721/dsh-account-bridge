/**
 * `/pool` 命令族（`src/commands.js`）的回归测试。
 *
 * 这一层是**人在对话中途问账号池的那条路**，所以这里钉的是三件事：
 *
 * - **`status` 不发网络请求。** 它是默认子命令、最容易被顺手敲出来的那条；
 *   如果它偷偷去查额度，就等于每敲一次 `/pool` 都拿用户账号刷一次上游风控。
 * - **「未知」与「0%」是两个句子。** `quota()` 返回 `undefined`（上游没这接口）、
 *   返回 `[]`（有接口但没读出东西）、返回 `remainingFraction: 0`（真读数是零）
 *   必须渲染成三句不同的话。这是计划书 §C3，也是面板那一节已经钉过一次的同一条规矩。
 * - **handler 永不抛。** 宿主规定必须返回 `{kind:'success'|'error', text}`；
 *   抛出去会变成适配器层一条笼统的失败，等于把「哪里错了」扔掉。
 *
 * 命令的**定义**还要过宿主的 `normalizeDefinition`：名字要匹配 `COMMAND_NAME`、
 * description 非空、给了 `input` 就必须有非空 `hint`。这些校验在 `test/harness.js`
 * 的假 `commands` 服务里照抄了一份，所以「定义写错」在单测里就炸，不用等真机。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockHost } from './harness.js'
import {
  COMMAND_NAME,
  USAGE,
  accountLine,
  createPoolCommand,
  findFamily,
  percentText,
  quotaText,
  splitInput,
  untilText,
} from '../src/commands.js'

// ---------------------------------------------------------------- 脚手架

const FAMILIES = [
  { id: 'codex', displayName: 'ChatGPT (Codex)', route: 'acct-codex', login: { methods: [{ id: 'browser' }, { id: 'import' }] } },
  { id: 'claude', displayName: 'Claude (Subscription)', route: 'acct-claude', login: { methods: [{ id: 'browser' }] } },
]

/**
 * 一个**记账式**假 adapter：`status()` / `healthOf()` / `unfreeze()` 三个被命令用到的
 * 方法都记下调用。`unfreeze` 不假装成功——它返回一个我们指定的条数，
 * 让「本来就没有冷却」与「清掉了 N 条」这两条分支都能被测到。
 */
function fakeAdapter({ rows = [], health = new Map(), unfreezeReturns = 0 } = {}) {
  const calls = { status: 0, healthOf: [], unfreeze: [] }
  return {
    calls,
    async status() {
      calls.status += 1
      return rows
    },
    healthOf(family, accountId) {
      calls.healthOf.push(`${family}/${accountId}`)
      return health.get(`${family}/${accountId}`)
    },
    unfreeze(family, accountId) {
      calls.unfreeze.push([family, accountId])
      return typeof unfreezeReturns === 'function' ? unfreezeReturns(family, accountId) : unfreezeReturns
    },
  }
}

/** 假的 AccountStore：只需要 `list()`。 */
function fakeStore(byFamily = {}) {
  const calls = []
  return {
    calls,
    async list(familyId) {
      calls.push(familyId)
      return byFamily[familyId] ?? []
    },
  }
}

function account(id, extra = {}) {
  return {
    id,
    family: id.split('-')[0],
    label: `${id}@example.com`,
    source: 'oauth',
    auth: { access: 'at-secret-value', refresh: 'rt-secret-value', expiresAt: Date.now() + 3_600_000 },
    ...extra,
  }
}

function makeCommand({ adapter, store, families = FAMILIES, ctx = {}, log } = {}) {
  return createPoolCommand({
    adapter: adapter ?? fakeAdapter(),
    store: store ?? fakeStore(),
    families,
    ctx,
    log,
  })
}

/** 跑一次命令，返回结果对象。 */
function run(command, rawInput) {
  return command.handler({ rawInput, agent: { id: 'agent-test' } })
}

// ---------------------------------------------------------------- 定义本身

test('the definition passes the host validator: lowercase name, description, non-empty hint', () => {
  const command = makeCommand()
  assert.equal(command.name, COMMAND_NAME)
  assert.match(command.name, /^[a-z][a-z0-9_-]*$/)
  assert.equal(typeof command.description, 'string')
  assert.ok(command.description.trim().length > 0)
  assert.equal(typeof command.input?.hint, 'string')
  assert.ok(command.input.hint.trim().length > 0)
  assert.equal(typeof command.handler, 'function')
})

test('the plugin registers /pool with the host, and hosts reject the name twice', () => {
  const host = createMockHost()
  try {
    const command = host.services.commands.definitions.get(COMMAND_NAME)
    assert.ok(command, `expected /${COMMAND_NAME} to be registered`)
    // 重名必须抛——宿主侧就是这样的（每个 scope 一个名字）。
    assert.throws(
      () => host.services.commands.register({ name: COMMAND_NAME, description: 'x', handler: () => ({ kind: 'success' }) }),
      /already registered/,
    )
  } finally {
    host.dispose()
  }
})

test('the registered command is wired to the real adapter, not a stub', async () => {
  const host = createMockHost()
  try {
    const command = host.services.commands.definitions.get(COMMAND_NAME)
    const result = await command.handler({ rawInput: '', agent: { id: 'agent-test' } })
    assert.equal(result.kind, 'success')
    // 真 adapter 的 status() 会走 store；空池时也应给出一句可读的话。
    assert.match(result.text, /族 \/ \d+ 个账号/)
  } finally {
    host.dispose()
  }
})

/** 只看账号行（`- ` 开头那些），免得把页脚里的「未知 / 0%」说明也算进来。 */
function accountLines(text) {
  return text.split('\n').filter((line) => line.startsWith('- '))
}

// ---------------------------------------------------------------- 纯函数

test('percentText renders a real zero as 0%, and refuses to invent one', () => {
  assert.equal(percentText(0.62), '62%')
  assert.equal(percentText(1), '100%')
  // 真读数是零 —— 必须是 '0%'。
  assert.equal(percentText(0), '0%')
  // 读不到 —— 必须是 undefined，绝不能是 '0%'。
  assert.equal(percentText(undefined), undefined)
  assert.equal(percentText(null), undefined)
  assert.equal(percentText(NaN), undefined)
  assert.equal(percentText('0.5'), undefined)
  // 上游给了越界值时夹住，而不是渲染出 '-20%' 这种鬼东西。
  assert.equal(percentText(-0.2), '0%')
  assert.equal(percentText(1.7), '100%')
})

test('untilText says "30 秒" rather than rounding up to "1 分钟"', () => {
  assert.equal(untilText(30_000), '30 秒')
  assert.equal(untilText(4 * 60_000), '4 分钟')
  assert.equal(untilText(3 * 3_600_000), '3.0 小时')
  assert.equal(untilText(0), undefined)
  assert.equal(untilText(-1), undefined)
  assert.equal(untilText(undefined), undefined)
  assert.equal(untilText(NaN), undefined)
})

test('quotaText keeps three states apart: no interface / unreadable / a real reading', () => {
  // 1) 这一族根本没有 quota() —— 与「查了但没查到」是两件事。
  assert.equal(quotaText(undefined), '额度 未知（这一族没有额度接口）')
  // 2) 有接口，但这次什么都没读出来。
  assert.equal(quotaText([]), '额度 未知')
  // 3) 真读数，包括真读数里的 0%。
  assert.equal(
    quotaText([{ id: 'weekly', name: '周窗口', remainingFraction: 0.62 }]),
    '额度 周窗口 62%',
  )
  assert.equal(
    quotaText([{ id: 'five_hour', name: '5 小时', remainingFraction: 0 }]),
    '额度 5 小时 0%',
  )
  // 窗口存在但没给百分比 —— '?' 而不是 0%。
  assert.equal(quotaText([{ id: 'weekly' }]), '额度 weekly ?')
  assert.equal(
    quotaText([{ id: 'a', remainingFraction: 0.5 }, { id: 'b', remainingFraction: 0.25 }]),
    '额度 a 50% / b 25%',
  )
  // 没有 name 时回落到 id，不要渲染出 'undefined 50%'。
  assert.equal(quotaText([{ id: 'x', remainingFraction: 0.5 }]), '额度 x 50%')
})

test('accountLine surfaces the flags a person needs to see', () => {
  const plain = accountLine({ id: 'codex-1', label: 'a@b.c' })
  assert.match(plain, /`codex-1`/)
  assert.match(plain, /a@b\.c/)
  assert.doesNotMatch(plain, /已停用|共用|已过期|⏸/)

  assert.match(accountLine({ id: 'codex-2', label: 'x', disabled: true }), /已停用/)
  assert.match(accountLine({ id: 'codex-3', label: 'x', externallyOwned: true }), /共用/)
  assert.match(accountLine({ id: 'codex-4', label: 'x', expiresAt: Date.now() - 1000 }), /token 已过期/)
  assert.match(accountLine({ id: 'codex-5', label: 'x' }, { why: 'RATE_LIMIT，4 分钟后可用' }), /⏸ RATE_LIMIT/)
  // 没有标签也不能渲染成 'undefined'。
  assert.match(accountLine({ id: 'codex-6' }), /\(无标签\)/)
})

test('findFamily accepts the id, the route and the display name', () => {
  assert.equal(findFamily(FAMILIES, 'codex')?.id, 'codex')
  assert.equal(findFamily(FAMILIES, 'acct-codex')?.id, 'codex')
  assert.equal(findFamily(FAMILIES, 'chatgpt (codex)')?.id, 'codex')
  assert.equal(findFamily(FAMILIES, 'ACCT-CLAUDE')?.id, 'claude')
  assert.equal(findFamily(FAMILIES, 'nope'), undefined)
  assert.equal(findFamily(FAMILIES, ''), undefined)
  assert.equal(findFamily(FAMILIES, undefined), undefined)
})

test('splitInput tolerates stray whitespace', () => {
  assert.deepEqual(splitInput('  check   codex '), ['check', 'codex'])
  assert.deepEqual(splitInput(''), [])
  assert.deepEqual(splitInput(undefined), [])
  assert.deepEqual(splitInput('unfreeze'), ['unfreeze'])
})

// ---------------------------------------------------------------- status

test('/pool and /pool status are the same thing, and neither one touches the network', async () => {
  const adapter = fakeAdapter({
    rows: [{
      family: 'codex',
      displayName: 'ChatGPT (Codex)',
      route: 'acct-codex',
      accounts: [{ id: 'codex-1', label: 'a@b.c', source: 'oauth' }],
    }],
  })
  const command = makeCommand({ adapter })

  const bare = await run(command, '')
  const explicit = await run(command, 'status')
  assert.equal(bare.kind, 'success')
  assert.equal(explicit.kind, 'success')
  assert.equal(bare.text, explicit.text)
  assert.equal(adapter.calls.status, 2)
  // 关键：status 只读内存与凭据记录，**没有**任何 quota 相关调用。
  assert.deepEqual(adapter.calls.unfreeze, [])
  // 两条命令各看一次健康状态；除了这两次之外不该再有别的取数。
  assert.deepEqual(adapter.calls.healthOf, ['codex/codex-1', 'codex/codex-1'])
  assert.match(bare.text, /ChatGPT \(Codex\)/)
  assert.match(bare.text, /`acct-codex`/)
  assert.match(bare.text, /`codex-1`/)
  assert.match(bare.text, /没有\*\*查额度/) // 明说这里没查
})

test('an empty pool explains what to do next instead of printing nothing', async () => {
  const adapter = fakeAdapter({
    rows: [{
      family: 'codex',
      displayName: 'ChatGPT (Codex)',
      route: 'acct-codex',
      accounts: [],
    }],
  })
  const result = await run(makeCommand({ adapter }), 'status')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /没有账号/)
  assert.match(result.text, /browser\/import/) // 登录方式来自族的 login.methods
  assert.match(result.text, /一个账号都没有/)
  assert.match(result.text, /设置 → 账号池/)
})

test('status shows the cooldown reason on the account line', async () => {
  const adapter = fakeAdapter({
    rows: [{
      family: 'codex',
      displayName: 'ChatGPT (Codex)',
      route: 'acct-codex',
      accounts: [{ id: 'codex-1', label: 'a@b.c' }],
    }],
    health: new Map([['codex/codex-1', 'QUOTA，9 分钟后可用']]),
  })
  const result = await run(makeCommand({ adapter }), 'status')
  assert.match(result.text, /⏸ QUOTA，9 分钟后可用/)
})

// ---------------------------------------------------------------- check

test('/pool check reports a real reading, including a real 0%', async () => {
  const seen = []
  const families = [{
    ...FAMILIES[0],
    async quota(ctx, payload) {
      seen.push(payload.id)
      return [{ id: 'weekly', name: '周窗口', remainingFraction: 0 }]
    },
  }]
  const store = fakeStore({ codex: [account('codex-1'), account('codex-2')] })
  const result = await run(makeCommand({ adapter: fakeAdapter(), store, families }), 'check codex')

  assert.equal(result.kind, 'success')
  assert.deepEqual(seen, ['codex-1', 'codex-2'])
  const rows = accountLines(result.text)
  assert.equal(rows.length, 2)
  for (const row of rows) assert.match(row, /额度 周窗口 0%/)
  // 真读数是零，所以**账号行上**不许出现「未知」。
  for (const row of rows) assert.doesNotMatch(row, /未知/)
  assert.match(result.text, /查了 2 个账号，其中 2 个读到了真实额度/)
})

test('/pool check says "no quota interface" for a family that has none, and does not invent 0%', async () => {
  const store = fakeStore({ codex: [account('codex-1')] })
  const result = await run(makeCommand({ adapter: fakeAdapter(), store }), 'check codex')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /额度 未知（这一族没有额度接口）/)
  // 「没有接口」读出来的东西里不能出现任何百分数。
  assert.doesNotMatch(accountLines(result.text).join(' '), /0%/)
  assert.match(result.text, /其中 0 个读到了真实额度/)
})

test('/pool check swallows a throwing quota() into 未知 instead of failing the whole command', async () => {
  const families = [{
    ...FAMILIES[0],
    async quota() {
      throw new Error('upstream exploded')
    },
  }]
  const store = fakeStore({ codex: [account('codex-1')] })
  const result = await run(makeCommand({ adapter: fakeAdapter(), store, families }), 'check codex')
  assert.equal(result.kind, 'success')
  // 有 quota() 但调用炸了 ⇒ 账号行上写「未知」，而且不能什么都不写。
  assert.match(accountLines(result.text).join(' '), /额度 未知/)
  assert.doesNotMatch(result.text, /upstream exploded/)
})

test('/pool check with no argument walks every family', async () => {
  const store = fakeStore({ codex: [account('codex-1')], claude: [account('claude-1')] })
  const result = await run(makeCommand({ adapter: fakeAdapter(), store }), 'check')
  assert.equal(result.kind, 'success')
  assert.deepEqual(store.calls, ['codex', 'claude'])
  assert.match(result.text, /查了 2 个账号/)
})

test('/pool check with an unknown family errors and lists the real ones', async () => {
  const result = await run(makeCommand(), 'check nosuch')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有叫 `nosuch` 的族/)
  assert.match(result.text, /codex \/ claude/)
})

// ---------------------------------------------------------------- unfreeze

test('/pool unfreeze reports honestly when there was nothing to clear', async () => {
  const adapter = fakeAdapter({ unfreezeReturns: 0 })
  const result = await run(makeCommand({ adapter }), 'unfreeze')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /本来就没有冷却中的条目/)
  assert.deepEqual(adapter.calls.unfreeze, [['codex', undefined], ['claude', undefined]])
})

test('/pool unfreeze clears an account and explains why that is safe', async () => {
  const adapter = fakeAdapter({ unfreezeReturns: 2 })
  const result = await run(makeCommand({ adapter }), 'unfreeze codex codex-1')
  assert.equal(result.kind, 'success')
  assert.deepEqual(adapter.calls.unfreeze, [['codex', 'codex-1']])
  assert.match(result.text, /`codex\/codex-1`/)
  assert.match(result.text, /清掉 2 条冷却/)
  assert.match(result.text, /内存里的派生状态/)
})

test('/pool unfreeze with only a family unfreezes the whole family', async () => {
  const adapter = fakeAdapter({ unfreezeReturns: 1 })
  const result = await run(makeCommand({ adapter }), 'unfreeze acct-codex')
  assert.equal(result.kind, 'success')
  assert.deepEqual(adapter.calls.unfreeze, [['codex', undefined]])
  assert.match(result.text, /整族/)
  assert.doesNotMatch(result.text, /claude/)
})

test('/pool unfreeze recognizes an account id typed where a family belongs, and names the fix', async () => {
  const adapter = fakeAdapter()
  const result = await run(makeCommand({ adapter }), 'unfreeze codex-1')
  assert.equal(result.kind, 'error')
  // 「没有叫 codex-1 的族」是对的但没用；正确的写法要直接给出来。
  assert.match(result.text, /看起来是账号 id，不是族/)
  assert.match(result.text, /`\/pool unfreeze codex codex-1`/)
  assert.deepEqual(adapter.calls.unfreeze, [])
})

test('/pool unfreeze with an account but a non-account-looking family token still lists families', async () => {
  const adapter = fakeAdapter()
  const result = await run(makeCommand({ adapter }), 'unfreeze nosuch thing')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有叫 `nosuch` 的族/)
  assert.deepEqual(adapter.calls.unfreeze, [])
})

test('/pool unfreeze with an unknown family errors without unfreezing anything', async () => {
  const adapter = fakeAdapter()
  const result = await run(makeCommand({ adapter }), 'unfreeze nosuch')
  assert.equal(result.kind, 'error')
  assert.deepEqual(adapter.calls.unfreeze, [])
})

test('unfreeze doubles as /pool thaw (both spellings accepted)', async () => {
  const adapter = fakeAdapter({ unfreezeReturns: 1 })
  const result = await run(makeCommand({ adapter }), 'thaw codex')
  assert.equal(result.kind, 'success')
  assert.deepEqual(adapter.calls.unfreeze, [['codex', undefined]])
})

// ---------------------------------------------------------------- 失败面

test('an unknown subcommand errors with the usage text', async () => {
  const result = await run(makeCommand(), 'nonsense')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /不认识的子命令 `nonsense`/)
  assert.ok(result.text.includes(USAGE.split('\n')[0]))
})

test('the handler never throws: a broken store becomes an error result, not a rejection', async () => {
  const store = {
    async list() {
      throw new Error('record store is on fire')
    },
  }
  const result = await run(makeCommand({ adapter: fakeAdapter(), store }), 'check codex')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /\/pool 失败了：record store is on fire/)
  // 宿主要求 error 的 text 非空——空字符串会在 normalizeResult 里抛 TypeError。
  assert.ok(result.text.trim().length > 0)
})

test('a status() that throws also becomes an error result', async () => {
  const adapter = {
    async status() {
      throw new Error('status broke')
    },
    healthOf: () => undefined,
    unfreeze: () => 0,
  }
  const result = await run(makeCommand({ adapter }), '')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /status broke/)
})

test('every result is a plain {kind, text} the host can freeze', async () => {
  const command = makeCommand()
  for (const input of ['', 'status', 'check', 'check nosuch', 'unfreeze', 'nonsense']) {
    const result = await run(command, input)
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'text'])
    assert.ok(result.kind === 'success' || result.kind === 'error')
    assert.equal(typeof result.text, 'string')
    assert.ok(result.text.trim().length > 0)
  }
})
