/**
 * 族级回归：上游回了 2xx，但那不是 API 回复。
 *
 * `test/assert-reply.test.js` 验的是判定函数本身；这一份验的是**每个族真的用上了它**。
 * 两件事缺一不可——`src/families/generic.js` 有两条互不相干的流式分支
 * （anthropic 直连 / openai chat），我接线时就漏掉了 anthropic 那条，
 * 而单测全绿。所以这里按族各给一条，而且末尾还有一条静态扫描兜住「新加的族忘了接」。
 *
 * `agy` 不在表里，而且是**故意**的：它不由 HTTP 驱动，而是 spawn 本机的 `agy` CLI
 * （`src/cli-run.js`）。上游给的是子进程的 stdout，没有响应头、没有状态码，
 * 这一层对它恒等于零。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { NOT_AN_API_REPLY } from '../src/wire/assert-reply.js'

import { claudeFamily } from '../src/families/claude.js'
import { codexFamily } from '../src/families/codex.js'
import { commandcodeFamily } from '../src/families/commandcode.js'
import { copilotFamily } from '../src/families/copilot.js'
import { genericFamily } from '../src/families/generic.js'
import { grokFamily } from '../src/families/grok.js'
import { minimaxFamily } from '../src/families/minimax.js'
import { qoderFamily } from '../src/families/qoder.js'
import { traeFamily } from '../src/families/trae.js'
import { workbuddyFamily } from '../src/families/workbuddy.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Cloudflare 那种「200 + 一个网页」。首字节是 `<`，Content-Type 说了是 HTML。 */
const HTML = '<!DOCTYPE html><html><head><title>Just a moment…</title></head><body>checking your browser</body></html>'

function htmlResponse() {
  return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } })
}

/**
 * 除了真正的上游，各族还会顺手查点别的东西（npm 上的客户端版本、GitHub 的编辑器
 * 版本表……）。那些请求给一个「正经的失败」，免得测试在到达目标之前就死在别处——
 * 死法不同会把一条本该说明问题的用例变成噪音。
 */
const SIDE_CHANNEL = /registry\.npmjs\.org|api\.github\.com|update\.code\.visualstudio\.com|github\.com|releases/i

function htmlCtx() {
  const calls = []
  return {
    calls,
    log: { error() {}, warn() {}, info() {}, debug() {} },
    config: {},
    async fetch(url, init) {
      calls.push({ url: String(url), init })
      if (SIDE_CHANNEL.test(String(url))) {
        return new Response('{"message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
      }
      return htmlResponse()
    },
  }
}

async function drain(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/**
 * 各族到达 fetch 所需的最小 payload——不是随便填的：`qoder` / `copilot` /
 * `commandcode` 在拼请求之前就会为缺失字段抛 `AUTH`，那样测到的就不是这一层了。
 */
const FAMILIES = [
  { id: 'codex', family: codexFamily, model: 'gpt-5-codex', auth: {} },
  { id: 'claude', family: claudeFamily, model: 'claude-sonnet-4-5', auth: {} },
  { id: 'minimax', family: minimaxFamily, model: 'MiniMax-M2.7', auth: {} },
  {
    id: 'qoder',
    family: qoderFamily,
    model: 'qwen3-coder',
    // COSY 签名要 userID，光有 jobToken/pat 会在拼请求之前就抛（那样测到的不是这一层）。
    auth: { jobToken: 'job-token', pat: 'pat-token', userID: 'uid-1' },
  },
  { id: 'workbuddy', family: workbuddyFamily, model: 'claude-sonnet-4-5', auth: {} },
  { id: 'commandcode', family: commandcodeFamily, model: 'mock-model', auth: { apiKey: 'cmd-key' } },
  { id: 'grok', family: grokFamily, model: 'grok-code-fast-1', auth: {} },
  {
    id: 'copilot',
    family: copilotFamily,
    model: 'gpt-4o',
    auth: { access: 'copilot-token', endpoints: { api: 'https://api.mock.invalid' } },
  },
  { id: 'trae', family: traeFamily, model: 'claude-3-5-sonnet', auth: {} },
  { id: 'generic', family: genericFamily, model: 'mock-alpha', auth: { baseUrl: 'https://api.mock.invalid/v1' } },
]

for (const { id, family, model, auth } of FAMILIES) {
  test(`${id}: a 200 that is really a web page fails as NOT_AN_API_REPLY, not as a parse error`, async () => {
    const ctx = htmlCtx()
    const options = {
      payload: { auth, ...(id === 'generic' ? { compat: undefined } : {}) },
      model,
      // 内容块数组是 DSH 给适配器的真实形状（`content: string` 只有部分族顺手兼容）。
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: undefined,
      signal: undefined,
    }

    await assert.rejects(drain(family.stream(ctx, options)), (error) => {
      assert.equal(error.code, NOT_AN_API_REPLY, `${id} threw ${error.code ?? error.message}`)
      // 消息里要能看出是谁在报，否则十一个族共用一个码就成了盲盒。
      assert.match(error.message, /web page|HTML|not an API/i)
      return true
    })
  })
}

test('every HTTP family wires the check in; the CLI family deliberately does not', () => {
  // 静态扫描是这条链上唯一能防「新加的族忘了接」的东西。
  // `assertApiReply` 是个普通函数调用，漏掉它不会有任何报错——只会在某个雨天
  // 让用户看到 "Unexpected token `<`"。
  for (const { id } of FAMILIES) {
    const source = readFileSync(new URL(`../src/families/${id}.js`, import.meta.url), 'utf8')
    assert.match(source, /assertApiReply\(/, `${id}.js never calls assertApiReply`)
    assert.match(source, /from '\.\.\/wire\/assert-reply\.js'/, `${id}.js does not import assertApiReply`)
  }

  const agy = readFileSync(`${HERE}../src/families/agy.js`, 'utf8')
  assert.doesNotMatch(agy, /assertApiReply/, 'agy drives a CLI, it has no HTTP reply to check')
})

test('generic checks both of its streaming branches', () => {
  // 这条 bug 真的发生过：anthropic 分支漏接，而单测全绿。
  const source = readFileSync(`${HERE}../src/families/generic.js`, 'utf8')
  const calls = source.match(/assertApiReply\(/g) ?? []
  assert.ok(calls.length >= 2, `generic has two streaming branches, found ${calls.length} call(s)`)
})
