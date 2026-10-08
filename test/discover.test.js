/**
 * P2.5「本机账号统一发现」的测试。
 *
 * 这一层的价值全在**边界**上：一个族挂住不能拖垮整次扫描、同一份凭据不能被导入两次、
 * 已经导过的要认出来、没实现的族要如实报而不是假装没有。
 * 所以下面的用例基本都是照着这些边界写的，而不是照着「happy path 能不能跑」。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverLocalAccounts, identityOf, importDiscovered } from '../src/discover.js'
import { AccountStore } from '../src/store.js'
import { codexFamily } from '../src/families/codex.js'
import { createMemoryCredentials } from './harness.js'

function makeStore() {
  const credentials = createMemoryCredentials()
  return { credentials, store: new AccountStore(() => credentials) }
}

/** 一个最小的假族：只实现扫描需要的两个方法。 */
function fakeFamily(id, items, extra = {}) {
  return {
    id,
    displayName: `${id} (fake)`,
    route: `acct-${id}`,
    async discover() {
      return typeof items === 'function' ? items() : items
    },
    recordFromDiscovery(item) {
      return { family: id, label: item.label, source: 'client-import', externallyOwned: true, auth: item.auth }
    },
    ...extra,
  }
}

/** 造一个只有签名是假的 JWT（本插件只读 payload，不验签）。 */
function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.not-a-real-signature`
}

// ------------------------------------------------------------------ 身份指纹

test('identity ignores rotating tokens but keeps accounts apart', () => {
  const first = { auth: { accountId: 'acc_1', access: 'at-1', refresh: 'rt' } }
  const second = { auth: { accountId: 'acc_1', access: 'at-2', refresh: 'rt' } }
  const other = { auth: { accountId: 'acc_2', access: 'at-1', refresh: 'rt' } }

  assert.equal(identityOf('codex', first), identityOf('codex', second), 'access token 轮换不该改变身份')
  assert.notEqual(identityOf('codex', first), identityOf('codex', other), '不同账号必须是不同身份')
  assert.notEqual(identityOf('codex', first), identityOf('claude', first), '同一份凭据在不同族下是不同账号')
  assert.ok(!identityOf('codex', first).includes('acc_1'), '指纹里不能出现凭据原文')
})

test('identity prefers the refresh token over the access token', () => {
  const first = { auth: { access: 'at-1', refresh: 'rt-stable' } }
  const second = { auth: { access: 'at-2', refresh: 'rt-stable' } }
  assert.equal(identityOf('claude', first), identityOf('claude', second))

  // 只剩 access 可退时身份当然会跟着令牌变——这正是要避免的情形，所以把它钉下来当反例，
  // 提醒后来者：没有 refresh 的凭据天生不稳定的身份。
  assert.notEqual(
    identityOf('claude', { auth: { access: 'at-1' } }),
    identityOf('claude', { auth: { access: 'at-2' } }),
  )
})

test('identity prefers the file it came from over an access token', () => {
  const first = { sourcePath: '/a/auth.json', auth: { access: 'at-1' } }
  const second = { sourcePath: '/a/auth.json', auth: { access: 'at-999' } }
  const elsewhere = { sourcePath: '/b/auth.json', auth: { access: 'at-1' } }

  assert.equal(identityOf('x', first), identityOf('x', second), '同一个文件里的令牌轮换不该改变身份')
  assert.notEqual(identityOf('x', first), identityOf('x', elsewhere), '两个文件是两份登录态')
})

test('identity survives a marker-only credential such as the agy one', () => {
  const marker = { auth: { kind: 'cli', owner: 'agy' } }
  assert.equal(identityOf('agy', marker), identityOf('agy', { auth: { kind: 'cli', owner: 'agy' } }))
  assert.notEqual(identityOf('agy', marker), identityOf('agy', { auth: { kind: 'cli', owner: 'other' } }))
})

// ------------------------------------------------------------------ 聚合

test('aggregates importable and non-importable entries across families', async () => {
  const { store } = makeStore()
  const families = [
    fakeFamily('alpha', [{ family: 'alpha', label: 'A', importable: true, auth: { accountId: 'a1' } }]),
    fakeFamily('beta', [{ family: 'beta', label: 'B', importable: false, reason: '没有 OAuth tokens' }]),
  ]

  const scan = await discoverLocalAccounts({ families, store })

  assert.equal(scan.importable.length, 1)
  assert.equal(scan.importable[0].family, 'alpha')
  assert.equal(scan.importable[0].alreadyImported, false)
  assert.equal(scan.blocked.length, 1)
  assert.equal(scan.blocked[0].reason, '没有 OAuth tokens')
})

test('a credential already in the store is reported as already imported', async () => {
  const { store } = makeStore()
  const auth = { accountId: 'acc_1', refresh: 'rt' }
  const families = [fakeFamily('alpha', [{ family: 'alpha', label: 'A', importable: true, auth }])]

  await store.write('alpha-1', { family: 'alpha', label: 'A', auth, source: 'client-import' })
  const scan = await discoverLocalAccounts({ families, store })

  assert.equal(scan.importable[0].alreadyImported, true)
})

test('a family without recordFromDiscovery is reported, not silently dropped', async () => {
  const { store } = makeStore()
  const families = [fakeFamily('bare', [{ family: 'bare', label: 'x', importable: true, auth: {} }], {
    recordFromDiscovery: undefined,
  })]

  const scan = await discoverLocalAccounts({ families, store })

  assert.equal(scan.importable.length, 0)
  assert.equal(scan.blocked.length, 1)
  assert.match(scan.blocked[0].reason, /recordFromDiscovery/)
})

// ------------------------------------------------------------------ 故障隔离

test('one exploding family does not take the whole scan down', async () => {
  const { store } = makeStore()
  const families = [
    fakeFamily('boom', () => {
      throw new Error('kaboom')
    }),
    fakeFamily('ok', [{ family: 'ok', label: 'fine', importable: true, auth: { accountId: 'x' } }]),
  ]

  const scan = await discoverLocalAccounts({ families, store })

  assert.equal(scan.errors.length, 1)
  assert.match(scan.errors[0].message, /kaboom/)
  assert.equal(scan.importable.length, 1, '另一个族必须照常被扫到')
})

test('a family that never answers is timed out instead of hanging the scan', async () => {
  const { store } = makeStore()
  const families = [fakeFamily('slow', () => new Promise(() => {}))]

  const scan = await discoverLocalAccounts({ families, store, timeoutMs: 50 })

  assert.equal(scan.errors.length, 1)
  assert.match(scan.errors[0].message, /超时/)
})

test('a family with no discover() at all is simply skipped', async () => {
  const { store } = makeStore()
  const scan = await discoverLocalAccounts({ families: [{ id: 'naked', displayName: 'n' }], store })
  assert.equal(scan.importable.length, 0)
  assert.equal(scan.errors.length, 0)
})

// ------------------------------------------------------------------ 导入

test('importDiscovered adopts an account and is idempotent on a second pass', async () => {
  const { store } = makeStore()
  const auth = { accountId: 'acc_1', refresh: 'rt' }
  const families = [fakeFamily('alpha', [{ family: 'alpha', label: 'A', importable: true, auth }])]

  const scan = await discoverLocalAccounts({ families, store })
  const first = await importDiscovered({ families, store, scan })

  assert.equal(first.imported.length, 1)
  assert.equal(first.imported[0].id, 'alpha-1')
  // 工具面靠这个身份把「刚导入的」从「还可以导入的」里摘出去，所以它必须在返回值里。
  assert.equal(first.imported[0].identity, scan.importable[0].identity)

  const again = await discoverLocalAccounts({ families, store })
  assert.equal(again.importable[0].alreadyImported, true)

  const second = await importDiscovered({ families, store, scan: again })
  assert.equal(second.imported.length, 0)
  assert.equal(second.skipped.length, 1)
  assert.match(second.skipped[0].reason, /已经导入过/)
})

test('the same credential reported twice in one scan is imported only once', async () => {
  const { store } = makeStore()
  const auth = { accountId: 'acc_1' }
  const families = [fakeFamily('alpha', [
    { family: 'alpha', label: 'A', importable: true, auth, sourcePath: '/one' },
    { family: 'alpha', label: 'A', importable: true, auth, sourcePath: '/two' },
  ])]

  const scan = await discoverLocalAccounts({ families, store })
  const result = await importDiscovered({ families, store, scan })

  assert.equal(result.imported.length, 1)
  assert.equal(result.skipped.filter((entry) => /重复/.test(entry.reason)).length, 1)
})

test('importDiscovered honours the family filter', async () => {
  const { store } = makeStore()
  const families = [
    fakeFamily('alpha', [{ family: 'alpha', label: 'A', importable: true, auth: { accountId: 'a' } }]),
    fakeFamily('beta', [{ family: 'beta', label: 'B', importable: true, auth: { accountId: 'b' } }]),
  ]

  const scan = await discoverLocalAccounts({ families, store })
  const result = await importDiscovered({ families, store, scan, family: 'beta' })

  assert.equal(result.imported.length, 1)
  assert.equal(result.imported[0].family, 'beta')
  assert.equal((await store.list('alpha')).length, 0)
  assert.equal((await store.list('beta')).length, 1)
})

// ------------------------------------------------------------------ 未实现族

test('a registered family takes over its credential site from the not-implemented list', async () => {
  const { store } = makeStore()
  const scan = await discoverLocalAccounts({ families: [fakeFamily('workbuddy', [])], store })
  assert.ok(
    !scan.unsupported.some((entry) => entry.family === 'workbuddy'),
    '族一旦注册，它的位点就不该再出现在「还没写」清单里',
  )
})

// ------------------------------------------------------------------ 真族端到端

test('end to end: a Codex CLI login is discovered and adopted with no login flow at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-discover-'))
  const accountId = 'acc_scan_001'
  await writeFile(
    join(dir, 'auth.json'),
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: fakeJwt({
          'https://api.openai.com/profile': { email: 'scan@example.com' },
          'https://api.openai.com/auth': { chatgpt_account_id: accountId },
        }),
        access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'rt_scan',
        account_id: accountId,
      },
    }),
    'utf8',
  )

  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  try {
    const { store } = makeStore()
    const scan = await discoverLocalAccounts({ families: [codexFamily], store })

    // 用 sourcePath 定位，而不是 label：这台机器上真实存在的 ~/.codex/auth.json 也会被扫到。
    const entry = scan.importable.find((item) => item.sourcePath === join(dir, 'auth.json'))
    assert.ok(entry, '临时 CODEX_HOME 里的登录态必须被扫出来')
    assert.equal(entry.label, 'scan@example.com')
    assert.equal(entry.alreadyImported, false)

    const result = await importDiscovered({ families: [codexFamily], store, scan })
    assert.ok(result.imported.some((item) => item.id === 'codex-1'))

    const stored = await store.read('codex-1')
    assert.equal(stored.auth.refresh, 'rt_scan')
    assert.equal(stored.externallyOwned, true)
    assert.equal(stored.source, 'client-import')
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
  }
})
