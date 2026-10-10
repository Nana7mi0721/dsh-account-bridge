/**
 * 「回了 2xx，但那不是 API 回复」（`src/wire/assert-reply.js`）。
 *
 * 为什么值得一整套用例：这个判定每一条都**只在故障时生效**——正常路径上它必须
 * 完全透明（顺序、字节、延迟都不能变），故障路径上它必须比下游的解析错误更早、
 * 更准确地说出原因。两个方向都只能靠测试钉住：
 *
 * - 放行错一个（把正常响应判成网页）⇒ 全族直接不可用；
 * - 拦截错一个（把网页放过去）⇒ 错误消息变成 "Unexpected token `<`"，
 *   而真正的原因（中间有个 Cloudflare）永远查不出来。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { NOT_AN_API_REPLY, assertApiReply } from '../src/wire/assert-reply.js'
import { classifyFailure } from '../src/health.js'

const HTML = '<!DOCTYPE html><html><head><title>Just a moment…</title></head><body>checking</body></html>'

/** 断言这次调用被拒了，且错误码就是我们那个。 */
async function refuses(response, who = 'test') {
  await assert.rejects(assertApiReply(response, { who }), (error) => {
    assert.equal(error.code, NOT_AN_API_REPLY)
    assert.match(error.message, new RegExp(who))
    return true
  })
}

// ------------------------------------------------------------------ 放行

test('a normal JSON reply passes through, byte for byte', async () => {
  const original = JSON.stringify({ hello: 'world', n: 42 })
  const reply = await assertApiReply(
    new Response(original, { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  assert.equal(await reply.text(), original)
  assert.equal(reply.status, 200)
})

test('a normal SSE reply passes through and keeps its first chunk', async () => {
  // SSE 的 Content-Type 不含 json，也不以 `<` 开头，所以两条嗅探都不该碰它。
  const events = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {}\n\n'
  const reply = await assertApiReply(
    new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  )
  assert.equal(await reply.text(), events)
})

test('every chunk of a multi-chunk body survives the peek', async () => {
  // 重建响应时最容易犯的错就是把「已经读掉的第一块」丢掉。
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: one\n\n'))
      controller.enqueue(encoder.encode('data: two\n\n'))
      controller.enqueue(encoder.encode('data: three\n\n'))
      controller.close()
    },
  })
  const reply = await assertApiReply(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  )
  assert.equal(await reply.text(), 'data: one\n\ndata: two\n\ndata: three\n\n')
})

test('a compressed body is never sniffed (its first bytes say nothing)', async () => {
  // 压缩流的首字节是魔数，不是内容。magpie 在这里原样放行，我们照做——
  // 而且我们自己就有这种上游：grok 的账单端点实测「gzip 正文配错误的编码头」。
  const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])
  const reply = await assertApiReply(
    new Response(bytes, { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
  )
  assert.equal(reply.status, 200)
  assert.deepEqual(new Uint8Array(await reply.arrayBuffer()), bytes)
})

test('an XML body that happens to start with <html is let through', async () => {
  // magpie 的例外：Content-Type 说了是 XML，就不按 HTML 判。
  const xml = '<?xml version="1.0"?><error><html>nested</html></error>'
  const reply = await assertApiReply(new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } }))
  assert.equal(await reply.text(), xml)
})

test('a 204 and a bodyless response are returned untouched', async () => {
  const noContent = await assertApiReply(new Response(null, { status: 204 }))
  assert.equal(noContent.status, 204)
  const bodyless = await assertApiReply({ status: 200, body: null })
  assert.equal(bodyless.status, 200)
})

// ------------------------------------------------------------------ 拦截

test('a web page served with 200 is refused', async () => {
  await refuses(new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } }))
})

test('a web page with no Content-Type at all is still refused by its first bytes', async () => {
  // 有些网关不带 Content-Type。magpie 靠 htmlStart 兜住这一档。
  await refuses(new Response(HTML, { status: 200 }))
})

test('a 200 with an empty body is refused, not treated as an empty answer', async () => {
  // 空 body 放任下去会变成 EMPTY_RESPONSE（"模型什么都没说"），换号重试一轮才发现
  // 真相是网关回了空。这两件事的排查成本差一个数量级。
  await refuses(new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }))
})

test('a reply declared as JSON but carrying HTML is refused', async () => {
  // 声明是 JSON、发的却是网页——两条判据同时命中，先说的那条（HTML）胜出，
  // 而且它的消息里会如实标出上游自己声明的 Content-Type，这正是排查时想看的。
  await assert.rejects(
    assertApiReply(new Response(HTML, { status: 200, headers: { 'content-type': 'application/json' } }), { who: 'test' }),
    (error) => {
      assert.equal(error.code, NOT_AN_API_REPLY)
      assert.match(error.message, /web page/)
      return true
    },
  )
})

test('a non-JSON body on a JSON endpoint is refused, with a clip of what arrived', async () => {
  // 这一档才是「附一段原文」存在的理由：body 既不是 HTML（嗅探不出是什么），
  // 又老实声明了 JSON ⇒ 只有原文能告诉人中间那东西到底回了什么。
  const body = `upstream said: service unavailable${'x'.repeat(5000)}`
  await assert.rejects(
    assertApiReply(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), { who: 'test' }),
    (error) => {
      assert.equal(error.code, NOT_AN_API_REPLY)
      assert.ok(error.message.includes('upstream said: service unavailable'))
      // 只附前面一小段，不能把整个 body 塞进错误消息里（它会进日志、进界面）。
      assert.ok(error.message.length < 600, `message too long: ${error.message.length}`)
      return true
    },
  )
})

test('the refusal is classified as a transient failure that does not punish the account', () => {
  // 这一条是这个模块存在的**真正理由**：挡在中间的东西常常回 403，而 403 在
  // httpError 里等于 AUTH ⇒ 账号被冷 24 小时。我们让错误码先于状态码说话。
  for (const family of ['claude', 'codex', 'qoder', 'workbuddy', 'trae', 'generic']) {
    const verdict = classifyFailure({ code: NOT_AN_API_REPLY, failure: { status: 403 } }, family)
    assert.equal(verdict.action, 'switch', family)
    assert.equal(verdict.cooldownMs, 60_000, family)
    assert.equal(verdict.scope, 'member', family)
    assert.equal(verdict.reason, NOT_AN_API_REPLY, family)
  }
})

// ------------------------------------------------------------------ 非 2xx：我们与 magpie 不同的那一处

test('a non-2xx response carrying a real web page is refused before httpError sees it', async () => {
  // 我们的偏离：magpie 让非 2xx 走它自己的分类器，我们不行——403 会被判成 AUTH。
  await refuses(new Response(HTML, { status: 403, headers: { 'content-type': 'text/html' } }))
})

test('a non-2xx response that merely mentions HTML is left alone', async () => {
  // 窄检查必须真的窄：一个正常说明错误的 JSON 体、或者一个纯文本 body，
  // 都不能被我们抢走——那些是 httpError 的活。
  const json = new Response('{"error":{"message":"invalid api key"}}', {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal((await assertApiReply(json)).status, 401)

  const text = new Response('<html> is a tag', { status: 400, headers: { 'content-type': 'text/plain' } })
  assert.equal((await assertApiReply(text)).status, 400)

  const htmlType = new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/html' } })
  assert.equal((await assertApiReply(htmlType)).status, 500)
})

test('a 401 that returns a login page is still refused', async () => {
  await refuses(new Response(HTML, { status: 401, headers: { 'content-type': 'text/html' } }))
})
