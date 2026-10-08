/**
 * 流式请求必须把 `ctx.fetch` 的第 4 个参数传成 `true`。
 *
 * 为什么值得一条专门的测试：`src/http.js` 里 per-账号出口代理有两个 dispatcher 缓存槽，
 * 流式那个用 `bodyTimeout: 0`，普通那个用 undici 默认值。而 undici 的 `bodyTimeout`
 * 是**两个数据块之间的空闲计时器**——默认 30 秒。对长推理来说，「上游想了 40 秒才吐
 * 下一个 token」是完全正常的事，用错槽位就会在回答说到一半时把连接掐断，
 * 表现为「莫名中断」，而且**只在配了代理的账号上出现**，极难排查。
 *
 * 这个参数默认是 `false`，所以「忘了传」不会有任何报错——只能靠测试钉住。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { claudeFamily } from '../src/families/claude.js'
import { codexFamily } from '../src/families/codex.js'
import { genericFamily } from '../src/families/generic.js'
import { minimaxFamily } from '../src/families/minimax.js'

/** 记下每次 `ctx.fetch` 的四个参数，然后让上游失败（我们只关心「怎么发的」）。 */
function spyCtx() {
  const calls = []
  return {
    calls,
    async fetch(url, init, proxy, streaming) {
      calls.push({ url, init, proxy, streaming })
      return {
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => '{"error":{"message":"spy"}}',
        json: async () => ({ error: { message: 'spy' } }),
      }
    },
  }
}

/** 跑一次 `stream()` 并吞掉上游失败——我们要的是调用记录，不是结果。 */
async function captureStream(family, payload, options = {}) {
  const ctx = spyCtx()
  try {
    for await (const _chunk of family.stream(ctx, {
      payload,
      model: options.model ?? 'probe-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 16,
      signal: undefined,
    })) {
      // 上游被 stub 成失败，正常情况下一块都拿不到。
    }
  } catch {
    // 预期之内。
  }
  return ctx.calls
}

/**
 * 断言「最后一次调用是流式、且用了长寿命 dispatcher」。
 *
 * 用 `at(-1)` 而不是 `[0]`：claude / codex 在发推理请求之前会先查一次 npm registry
 * 拿客户端版本号，那次是普通请求，不该被算进来——顺带也钉住了它**不该**是流式。
 */
function assertLastCallIsStream(calls, proxy) {
  assert.ok(calls.length > 0, 'stream() must have called ctx.fetch at least once')
  const last = calls.at(-1)
  assert.equal(last.proxy, proxy, 'the per-account proxy must be forwarded')
  assert.equal(last.streaming, true, 'the streaming dispatcher must be requested')
  for (const call of calls.slice(0, -1)) {
    assert.notEqual(call.streaming, true, `only the last call may be a stream, but ${call.url} was`)
  }
}

test('claude streams with the long-lived dispatcher', async () => {
  const proxy = 'http://127.0.0.1:7890'
  const calls = await captureStream(claudeFamily, {
    auth: { access: 'token', refresh: 'refresh', expiresAt: Date.now() + 3_600_000 },
    proxy,
  })
  assertLastCallIsStream(calls, proxy)
})

test('codex streams with the long-lived dispatcher', async () => {
  const proxy = 'http://127.0.0.1:7890'
  const calls = await captureStream(codexFamily, {
    auth: { access: 'token', refresh: 'refresh', expiresAt: Date.now() + 3_600_000, accountId: 'acc-1' },
    proxy,
  })
  assertLastCallIsStream(calls, proxy)
})

test('minimax streams with the long-lived dispatcher', async () => {
  const proxy = 'http://127.0.0.1:7890'
  const calls = await captureStream(minimaxFamily, {
    auth: { access: 'token', refresh: 'refresh', expiresAt: Date.now() + 3_600_000, region: 'en' },
    proxy,
  })
  assertLastCallIsStream(calls, proxy)
})

test('generic streams with the long-lived dispatcher', async () => {
  const proxy = 'http://127.0.0.1:7890'
  const calls = await captureStream(genericFamily, {
    auth: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' },
    proxy,
  })
  assertLastCallIsStream(calls, proxy)
})

test('catalog and quota lookups keep the normal dispatcher', async () => {
  // 反过来的那一半：非流式请求**不该**用 `bodyTimeout: 0` 的 agent，
  // 那个 agent 一旦上游真挂了就永远不超时，会把请求挂死。
  const ctx = spyCtx()
  await genericFamily.listModels(
    ctx,
    {
      auth: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', models: ['probe-model'] },
      proxy: 'http://127.0.0.1:7890',
    },
    undefined,
  )
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].proxy, 'http://127.0.0.1:7890')
  assert.notEqual(ctx.calls[0].streaming, true, 'a catalog lookup is not a stream')
  // `auth.models` 是**归一化后**的数组（工具面会把用户填的 `id:context` 字符串转成它）；
  // 直接塞字符串在这里会被当成「没声明任何模型」。
  assert.ok(await genericFamily.listModels(
    spyCtx(),
    { auth: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', models: ['probe-model'] } },
    undefined,
  ).then((list) => list.length > 0))
})
