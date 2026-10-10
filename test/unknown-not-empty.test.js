/**
 * P7-W9「未知 ≠ 空」的回归测试。
 *
 * 立论来自 magpie `LESSONS.md` 第 9 条：**读不出来被当成「没有」，下一次写盘就把真数据抹掉**
 * （它的 `readLogins` 解析出错返回空表，于是下一次 add / sign-out 把「没有账号」写了回去）。
 *
 * 这里钉住的是两处**会流向一次写盘**的空值，族侧的写回 CAS 在 minimax / grok 各自的套件里：
 *
 * 1. `AccountStore.nextAccountId()` 过去只问 `list()`——payload 读不出来的记录不在 `list()` 里，
 *    于是它的号被判成「空闲」，新账号 `write()` 上去把它**整条覆盖**；
 * 2. `api.toggle` / `api.proxy` 的 `(current) => ({ ...current, … })`——从 `locate()` 到 `update()`
 *    之间记录要是被删掉了，`current` 是 `undefined`，展开它会凭空造出一条**只剩一个字段**的
 *    半截账号（我们不但没改成，还多了一条垃圾记录）。
 *
 * 两处的验收口径是同一条：**「读不出来」与「不存在」必须给出不同结果，前者什么都不写。**
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMemoryCredentials, createMockHost } from './harness.js'
import { AccountStore, SCOPE } from '../src/store.js'
import { PREFIX } from '../src/api.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一个够用的假 `IncomingMessage`（与 api.test.js 同形）。 */
function fakeRequest({ method = 'POST', url = '/', body = {}, remoteAddress = '127.0.0.1' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = text.length > 0 ? [Buffer.from(text, 'utf8')] : []
  return {
    method,
    url,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

/** 造一个假 `ServerResponse`。 */
function fakeResponse() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text === undefined ? undefined : JSON.parse(text)
    },
  }
}

/** 打一次 API。 */
async function callApi(host, action, body = {}) {
  const route = host.services.webServer.routes.get(PREFIX)
  assert.ok(route, `expected a route mounted at ${PREFIX}`)
  const res = fakeResponse()
  await route.handler(fakeRequest({ url: `${PREFIX}/${action}`, body }), res)
  return res.captured
}

/** 塞一个能读的账号进去。 */
async function seedAccount(host, id) {
  await host.services.credentials.modifyRecord(`${SCOPE}/${id}`, () => ({
    kind: 'grant',
    payload: {
      id,
      family: id.split('-')[0],
      label: `${id}@example.com`,
      source: 'manual',
      auth: { baseUrl: 'https://upstream.example/v1', apiKey: 'sk-secret' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }))
}

// ------------------------------------------------------------------ 占号

test('nextAccountId 不发放「记录在、payload 读不出来」的号', async () => {
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  await store.write('generic-1', { family: 'generic', auth: { baseUrl: 'https://a.example/v1' } })
  // 一条读不出 payload 的记录：别人往同一个 scope 写过东西、或旧版本留下的空壳。
  // memory 实现里 `readRecord` 回 `{kind}` 没有 payload ⇒ `read()` 返回 undefined。
  const foreign = { kind: 'grant' }
  credentials.records.set(`${SCOPE}/generic-2`, foreign)

  // `list()` 只回能读的那些（对外少显示一个账号，这是可接受的）。
  assert.deepEqual((await store.list('generic')).map((account) => account.id), ['generic-1'])

  // 但**号要占住**：否则下一条新账号会写在 generic-2 上，把那条记录整条覆盖。
  assert.equal(await store.nextAccountId('generic'), 'generic-3')
  assert.deepEqual(credentials.records.get(`${SCOPE}/generic-2`), foreign, '那条记录必须一个字节都没动')
})

test('nextAccountId 只跳过本族的号，别的族占着的不算', async () => {
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  credentials.records.set(`${SCOPE}/grok-1`, { kind: 'grant' }) // 读不出来的 grok 号
  assert.equal(await store.nextAccountId('generic'), 'generic-1')
  assert.equal(await store.nextAccountId('grok'), 'grok-2')
})

test('nextAccountId 跳过登录临时槽位，别把它当成占用的正式号', async () => {
  const credentials = createMemoryCredentials()
  const store = new AccountStore(credentials, silent)
  await store.write('generic-login', { family: 'generic', auth: {} })
  assert.equal(await store.nextAccountId('generic'), 'generic-1')
})

// ------------------------------------------------------------------ 改号

/** 把 `modifyRecord` 包一层：在真正的改写发生前删掉记录（模拟并发删除）。 */
function vanishBeforeWrite(credentials, key) {
  const real = credentials.modifyRecord.bind(credentials)
  const seen = { wrote: undefined, called: 0 }
  credentials.modifyRecord = async (target, mutate) => {
    seen.called += 1
    if (target === key) credentials.records.delete(target)
    seen.wrote = await mutate(credentials.records.get(target))
    return seen.wrote
  }
  return { real, seen }
}

test('toggle：记录在 locate 之后被删掉就抛 NOT_FOUND，不写半截账号', async () => {
  const host = createMockHost({ discoverOnStartup: false })
  await seedAccount(host, 'generic-1')
  const { seen } = vanishBeforeWrite(host.services.credentials, `${SCOPE}/generic-1`)

  const captured = await callApi(host, 'toggle', { account: 'generic-1', disabled: true })

  assert.equal(captured.status, 404)
  assert.equal(captured.body.ok, false)
  assert.equal(captured.body.error.code, 'NOT_FOUND')
  assert.equal(seen.wrote, undefined, 'mutate 必须返回 undefined：返回对象就等于凭空造一条半截记录')
  assert.equal(host.services.credentials.records.has(`${SCOPE}/generic-1`), false)
})

test('proxy：同样不写半截账号', async () => {
  const host = createMockHost({ discoverOnStartup: false })
  await seedAccount(host, 'generic-1')
  const { seen } = vanishBeforeWrite(host.services.credentials, `${SCOPE}/generic-1`)

  const captured = await callApi(host, 'proxy', { account: 'generic-1', proxy: 'http://127.0.0.1:7890' })

  assert.equal(captured.status, 404)
  assert.equal(captured.body.error.code, 'NOT_FOUND')
  assert.equal(seen.wrote, undefined)
})

test('记录还在时 toggle / proxy 照常写，且不会掉字段', async () => {
  const host = createMockHost({ discoverOnStartup: false })
  await seedAccount(host, 'generic-1')

  assert.equal((await callApi(host, 'toggle', { account: 'generic-1', disabled: true })).status, 200)
  assert.equal((await callApi(host, 'proxy', { account: 'generic-1', proxy: ' http://127.0.0.1:7890 ' })).status, 200)

  const record = host.services.credentials.records.get(`${SCOPE}/generic-1`)
  assert.equal(record.payload.family, 'generic')
  assert.equal(record.payload.disabled, true)
  assert.equal(record.payload.proxy, 'http://127.0.0.1:7890')
  // 凭据必须原样还在（改账号配置不该碰 auth）。
  assert.equal(record.payload.auth.apiKey, 'sk-secret')
})

test('清空代理是删键而不是留空串', async () => {
  const host = createMockHost({ discoverOnStartup: false })
  await seedAccount(host, 'generic-1')
  await callApi(host, 'proxy', { account: 'generic-1', proxy: 'http://127.0.0.1:7890' })
  await callApi(host, 'proxy', { account: 'generic-1', proxy: '' })
  const record = host.services.credentials.records.get(`${SCOPE}/generic-1`)
  assert.equal('proxy' in record.payload, false, '留空串会让 createFetcher 以为「配了代理」再去解析空 URL')
})
