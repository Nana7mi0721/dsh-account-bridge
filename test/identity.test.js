// W5 身份成套 + 按账号分命名空间（纯函数部分）。
//
// 这一组函数的价值全在「同账号幂等、跨账号不同」这一对性质上：前者决定上游缓存是否还有效，
// 后者决定一次对话的换号会不会把两个账号连起来。两条都要有断言，缺一条这个模块就等于没测。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAUDE_CODE_SESSION_HEADER,
  accountNamespace,
  applyIdentityHeaders,
  claudeMetadataUserId,
  deviceId,
  isUuid,
  scopedSessionId,
  UUID_RE,
} from '../src/wire/identity.js'

const SESSION = 'msg_01H8XYZ_conversation_root'

test('同一个账号 + 同一个会话，无论算多少次都是同一个值', () => {
  const ns = accountNamespace('claude', 'claude-1')
  const first = scopedSessionId(ns, SESSION)
  for (let i = 0; i < 5; i += 1) assert.equal(scopedSessionId(ns, SESSION), first)
})

test('换账号就换命名空间 —— 一次对话换号后两个账号看到不同的会话标识', () => {
  const a = scopedSessionId(accountNamespace('claude', 'claude-1'), SESSION)
  const b = scopedSessionId(accountNamespace('claude', 'claude-2'), SESSION)
  assert.notEqual(a, b)
})

test('换族也换命名空间（不同上游之间不该互相认出同一个会话）', () => {
  const a = scopedSessionId(accountNamespace('claude', 'account-1'), SESSION)
  const b = scopedSessionId(accountNamespace('grok', 'account-1'), SESSION)
  assert.notEqual(a, b)
})

test('不同会话得到不同值', () => {
  const ns = accountNamespace('claude', 'claude-1')
  assert.notEqual(scopedSessionId(ns, 'session-a'), scopedSessionId(ns, 'session-b'))
})

test('形状必须是 UUIDv4：版本位 4、变体位 8/9/a/b', () => {
  for (const session of [SESSION, 'x', '一个中文会话 id', '0'.repeat(200)]) {
    const id = scopedSessionId(accountNamespace('claude', 'claude-1'), session)
    assert.match(id, UUID_RE, `${session} 派生出的 ${id} 不是 UUID 形状`)
    assert.equal(id[14], '4', `版本位应当是 4：${id}`)
    assert.ok('89ab'.includes(id[19]), `变体位应当是 8/9/a/b：${id}`)
  }
})

test('派生的标识里不含原始会话（防止调用方的 id 直接漏给上游）', () => {
  const id = scopedSessionId(accountNamespace('claude', 'claude-1'), SESSION)
  assert.ok(!id.includes(SESSION))
  // 反过来也成立：会话里出现过的任何 8 字符以上片段都不该出现在派生值里
  assert.ok(!id.includes('msg_01H8'))
})

test('设备标识：稳定、只有十六进制、与族和账号都相关', () => {
  const mine = deviceId('claude', 'claude-1')
  assert.equal(deviceId('claude', 'claude-1'), mine)
  assert.match(mine, /^[0-9a-f]{64}$/)
  assert.notEqual(deviceId('claude', 'claude-2'), mine)
  assert.notEqual(deviceId('codex', 'claude-1'), mine)
})

test('metadata.user_id 的新形态是三键 JSON，account_uuid 归一化成小写', () => {
  const uuid = '0F0E0D0C-0B0A-0908-0706-050403020100'
  const raw = claudeMetadataUserId({ device: 'd'.repeat(64), accountUuid: uuid, session: 'sess' })
  assert.deepEqual(JSON.parse(raw), {
    device_id: 'd'.repeat(64),
    account_uuid: uuid.toLowerCase(),
    session_id: 'sess',
  })
})

test('account_uuid 不是 UUID 时发空串，而不是省略这个键', () => {
  // 我们的账号 id 是本地别名（claude-1），不是上游账号 UUID。
  // Claude Code 的这个字段不是可选的，少一个键比给一个空值更像伪造。
  const raw = claudeMetadataUserId({ device: 'd', accountUuid: 'claude-1', session: 'sess' })
  const parsed = JSON.parse(raw)
  assert.equal(parsed.account_uuid, '')
  assert.ok('account_uuid' in parsed)
  assert.equal(claudeMetadataUserId({ device: 'd', accountUuid: undefined, session: 'sess' }), raw)
})

test('legacy 形态是 user_{device}_account_{uuid}_session_{id}', () => {
  const raw = claudeMetadataUserId({
    device: 'dev',
    accountUuid: undefined,
    session: 'sess',
    legacy: true,
  })
  assert.equal(raw, 'user_dev_account__session_sess')
})

test('isUuid 只认形状，不认大小写以外的任何宽容', () => {
  assert.ok(isUuid('0f0e0d0c-0b0a-0908-0706-050403020100'))
  assert.ok(isUuid('0F0E0D0C-0B0A-0908-0706-050403020100'))
  assert.ok(!isUuid('claude-1'))
  assert.ok(!isUuid('0f0e0d0c0b0a09080706050403020100'))
  assert.ok(!isUuid(''))
  assert.ok(!isUuid(undefined))
})

test('成套纪律：外来的 x-stainless-* 指纹被删掉，不是叠加', () => {
  const headers = {
    authorization: 'Bearer x',
    'x-stainless-package-version': '4.2.0',
    'X-Stainless-Retry-Count': '2',
    'x-stainless-lang': 'js',
  }
  applyIdentityHeaders(headers, { 'user-agent': 'claude-cli/2.1.87 (external, cli)', 'x-app': 'cli' })
  assert.deepEqual(Object.keys(headers).sort(), ['authorization', 'user-agent', 'x-app'])
})

test('成套纪律：身份没声明 x-app 时，调用方留下的 x-app 被删掉（不许上下半身混搭）', () => {
  const headers = { authorization: 'Bearer x', 'x-app': 'some-other-cli' }
  applyIdentityHeaders(headers, { 'user-agent': 'claude-cli/2.1.87 (external, cli)' })
  assert.ok(!('x-app' in headers))
})

test('成套纪律：身份声明的头覆盖同名旧值，且大小写不敏感', () => {
  const headers = { 'User-Agent': 'node', 'X-App': 'other-cli' }
  applyIdentityHeaders(headers, { 'user-agent': 'claude-cli/2.1.87 (external, cli)', 'x-app': 'cli' })
  assert.deepEqual(headers, { 'user-agent': 'claude-cli/2.1.87 (external, cli)', 'x-app': 'cli' })
})

test('会话头常量是 Claude Code 真正发的那个名字', () => {
  assert.equal(CLAUDE_CODE_SESSION_HEADER, 'x-claude-code-session-id')
})

// ---------------------------------------------------------------- 族级接线
//
// 上面测的是纯函数；这一节测「族真的把它们发出去了」。
// 最要紧的一条是**裸会话 id 绝不出现在请求里**——那是这一整个工作包的目的。

import { claudeFamily } from '../src/families/claude.js'
import { codexFamily } from '../src/families/codex.js'
import { grokFamily } from '../src/families/grok.js'

const RAW_SESSION = 'conv_01H8XYZ_the_callers_own_id'

/** 记下每次 `ctx.fetch`，然后让上游失败（我们只关心「怎么发的」）。 */
function spyCtx() {
  const calls = []
  return {
    calls,
    log: { warn() {}, info() {}, debug() {} },
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

async function capture(family, payload, options = {}) {
  const ctx = spyCtx()
  try {
    for await (const _chunk of family.stream(ctx, {
      payload,
      model: 'probe-model',
      messages: [{ id: RAW_SESSION, role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: 'You are a helpful assistant.',
      maxTokens: 16,
      ...options,
    })) {
      /* 上游被 stub 成失败，正常情况下一块都拿不到 */
    }
  } catch {
    /* 预期之内 */
  }
  return ctx.calls
}

/** 最后一次推理请求（前面的目录/版本查询不算）。 */
function lastPost(calls) {
  const posts = calls.filter((call) => call.init?.method === 'POST')
  assert.ok(posts.length > 0, 'the family must have POSTed the inference request')
  return posts.at(-1)
}

function headerOf(call, name) {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(call.init.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

test('claude 发成套身份：x-app、会话头、metadata.user_id 三处同一个值', async () => {
  const account = { id: 'claude-1', label: 'me@example.com' }
  const calls = await capture(
    claudeFamily,
    { auth: { access: 'token', refresh: 'r', expiresAt: Date.now() + 3_600_000 } },
    { account, session: RAW_SESSION },
  )
  const call = lastPost(calls)
  const headers = call.init.headers
  assert.equal(headerOf(call, 'x-app'), 'cli')
  assert.match(headerOf(call, 'user-agent'), /^claude-cli\/.+ \(external, cli\)$/)
  const sessionHeader = headerOf(call, 'x-claude-code-session-id')
  assert.match(sessionHeader, UUID_RE, '会话头必须是 UUIDv4 形状')

  const body = JSON.parse(call.init.body)
  const parsed = JSON.parse(body.metadata.user_id)
  assert.equal(parsed.session_id, sessionHeader, '会话头与 metadata.user_id 必须是同一个值')
  assert.equal(parsed.account_uuid, '', '本地账号 id 不是 UUID，必须发空串')
  assert.match(parsed.device_id, /^[0-9a-f]{64}$/)
  assert.ok(!('x-stainless-lang' in headers))
})

test('claude 的请求里不出现裸会话 id（这是整个 W5 的目的）', async () => {
  const calls = await capture(
    claudeFamily,
    { auth: { access: 'token', refresh: 'r', expiresAt: Date.now() + 3_600_000 } },
    { account: { id: 'claude-1' }, session: RAW_SESSION },
  )
  const call = lastPost(calls)
  const serialized = `${JSON.stringify(call.init.headers)}${call.init.body}`
  assert.ok(!serialized.includes(RAW_SESSION), `裸会话 id 漏给了上游：${RAW_SESSION}`)
})

test('claude 拿不到账号或会话时一个身份字段都不发（而不是退回去发裸 id）', async () => {
  for (const options of [{}, { account: { id: 'claude-1' } }, { session: RAW_SESSION }]) {
    const calls = await capture(
      claudeFamily,
      { auth: { access: 'token', refresh: 'r', expiresAt: Date.now() + 3_600_000 } },
      options,
    )
    const call = lastPost(calls)
    assert.equal(headerOf(call, 'x-claude-code-session-id'), undefined)
    assert.equal(JSON.parse(call.init.body).metadata, undefined)
    assert.equal(headerOf(call, 'x-app'), 'cli', 'x-app 与账号无关，任何时候都发')
  }
})

test('claude 的 system 身份块不自曝第三方桥', async () => {
  const calls = await capture(
    claudeFamily,
    { auth: { access: 'token', refresh: 'r', expiresAt: Date.now() + 3_600_000 } },
    { account: { id: 'claude-1' }, session: RAW_SESSION },
  )
  const body = JSON.parse(lastPost(calls).init.body)
  const first = body.system?.[0]?.text ?? ''
  assert.match(first, /^You are Claude Code, Anthropic's official CLI for Claude\.$/)
  assert.ok(!/bridge|harness/i.test(JSON.stringify(body.system)), `system 里出现了自我说明：${first}`)
})

test('codex 的 prompt_cache_key 按账号派生，且不含裸会话 id', async () => {
  const payload = { auth: { access: 'token', refresh: 'r', expiresAt: Date.now() + 3_600_000, accountId: 'acc-1' } }
  const one = JSON.parse(lastPost(await capture(codexFamily, payload, { account: { id: 'codex-1' }, session: RAW_SESSION })).init.body)
  const two = JSON.parse(lastPost(await capture(codexFamily, payload, { account: { id: 'codex-2' }, session: RAW_SESSION })).init.body)
  assert.match(one.prompt_cache_key, UUID_RE)
  assert.notEqual(one.prompt_cache_key, two.prompt_cache_key, '换账号必须换缓存键')
  assert.ok(!JSON.stringify(one).includes(RAW_SESSION))
})

test('codex 拿不到会话时不发 prompt_cache_key', async () => {
  const payload = { auth: { access: 'token', refresh: 'r', expiresAt: Date.now() + 3_600_000, accountId: 'acc-1' } }
  const body = JSON.parse(lastPost(await capture(codexFamily, payload, {})).init.body)
  assert.ok(!('prompt_cache_key' in body))
})

test('grok 的 prompt_cache_key 按账号 + 会话派生，覆盖登录时那个账号级常量', async () => {
  const payload = { auth: { access: 'token', refresh: 'r', expiresAt: Date.now() + 3_600_000, cacheKey: 'grok-account-level' } }
  const scoped = JSON.parse(lastPost(await capture(grokFamily, payload, { account: { id: 'grok-1' }, session: RAW_SESSION })).init.body)
  assert.match(scoped.prompt_cache_key, UUID_RE)
  assert.notEqual(scoped.prompt_cache_key, 'grok-account-level')
  assert.ok(!JSON.stringify(scoped).includes(RAW_SESSION))

  // 拿不到会话时才退回账号级常量（它的作用只是「别让该账号所有对话挤一个分片」的反面兜底）
  const fallback = JSON.parse(lastPost(await capture(grokFamily, payload, {})).init.body)
  assert.equal(fallback.prompt_cache_key, 'grok-account-level')
})

test('账号池把账号与会话交给族（没有这一步，上面全都不成立）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8')
  assert.match(source, /account: \{ id: accountId, label: candidate\.account\.label \}/)
  assert.match(source, /session: conversation/)
})
