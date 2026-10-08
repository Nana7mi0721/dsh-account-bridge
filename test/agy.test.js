/**
 * Antigravity 族的测试。
 *
 * 线协议的夹具是**逐字抄下来的真实抓包**（agy 1.2.8，见 m01730 段），不是想象的
 * 形状——这一族的全部风险都在「上游到底发什么」上，夹具失真等于没测。
 *
 * 默认不跑真机推理（每回合固定烧 ~27k input tokens）。要跑就：
 *   BRIDGE_LIVE_AGY=1 node --test "test/*.test.js"
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { agyFamily, probeAgy } from '../src/families/agy.js'
import {
  buildPrompt,
  classifyAgyFailure,
  mapUsage,
  parseModels,
  translateAgyStream,
} from '../src/wire/agy.js'

const CONVERSATION = '33d67f51-90d0-4246-9d8b-3a2609770aa5'

/** 真实抓包：`agy "-p=Reply with exactly the word: PONG" --output-format stream-json`。 */
const PONG_LINES = [
  JSON.stringify({
    event: 'init',
    conversation_id: CONVERSATION,
    init: {
      cwd: 'C:\\Users\\REISEN\\AppData\\Local\\Temp',
      permission_mode: 'request-review',
      tools: ['run_command', 'view_file', 'write_to_file'],
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: CONVERSATION, step_index: 0, state: 'DONE', step_type: 'user_input' },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION,
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'PONG',
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION,
      step_index: 1,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: '\n',
      duration_seconds: 16.7424247,
      usage: {
        input_tokens: 27294,
        output_tokens: 29,
        thinking_tokens: 27,
        cache_read_tokens: 0,
        total_tokens: 27323,
      },
    },
  }),
  JSON.stringify({
    event: 'result',
    result: {
      conversation_id: CONVERSATION,
      status: 'SUCCESS',
      response: 'PONG\n',
      duration_seconds: 16.8016142,
      num_turns: 1,
      usage: {
        input_tokens: 27294,
        output_tokens: 29,
        thinking_tokens: 27,
        cache_read_tokens: 0,
        total_tokens: 27323,
      },
    },
  }),
]

async function collect(lines) {
  const chunks = []
  for await (const chunk of translateAgyStream(lines)) chunks.push(chunk)
  return chunks
}

// ------------------------------------------------------------------ 线协议

test('translates a real agy turn into DSH chunks', async () => {
  const chunks = await collect(PONG_LINES)

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.equal(chunks[0].index, 0)
  assert.equal(chunks[0].blockType, 'text')
  // DONE 那一条的 "\n" **不能丢**：它不是终止符，是最后一段正文。
  assert.equal(chunks[1].text + chunks[2].text, 'PONG\n')
  // block-end 必须携带完整块对象 —— DSH 的契约。
  assert.deepEqual(chunks[3].block, { type: 'text', text: 'PONG\n' })
  assert.deepEqual(chunks[4].usage, { inputTokens: 27294, outputTokens: 29, cachedInputTokens: 0 })
  assert.equal(chunks[5].reason.kind, 'stop')
})

test('ignores noise lines agy mixes into stdout', async () => {
  const chunks = await collect([
    'Fetching available models...',
    '{ this is not json',
    '',
    ...PONG_LINES,
  ])
  assert.equal(chunks.at(-1).type, 'finish')
})

test('backfills from result.response when deltas are short', async () => {
  // 增量事件丢了、但 result 里有完整正文时，绝不能少给用户正文。
  const chunks = await collect([
    JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONVERSATION, step_type: 'agent_response', text_delta: 'PO' },
    }),
    JSON.stringify({
      event: 'result',
      result: { conversation_id: CONVERSATION, status: 'SUCCESS', response: 'PONG\n' },
    }),
  ])
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.equal(text, 'PONG\n')
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'block-end').block, { type: 'text', text: 'PONG\n' })
})

test('never emits a block-end without a block-start', async () => {
  const chunks = await collect([
    JSON.stringify({
      event: 'result',
      result: { conversation_id: CONVERSATION, status: 'SUCCESS', response: 'hello' },
    }),
  ])
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'finish'],
  )
})

test('treats a result ERROR as a failure even though the process exits 0', async () => {
  // 真实失败样本：上游在 POST streamGenerateContent 时 EOF，进程仍然 exit 0。
  const error = await collect([
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: CONVERSATION,
        status: 'ERROR',
        error:
          'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF',
        duration_seconds: 79.3,
      },
    }),
  ]).then(
    () => null,
    (thrown) => thrown,
  )

  assert.ok(error, 'an ERROR result must throw rather than look like an empty answer')
  assert.match(error.message, /streamGenerateContent/)
  assert.match(error.message, new RegExp(CONVERSATION))
  // 掉流是上游偶发，不该惩罚账号 —— TRANSPORT = 换号但不记冷却。
  assert.equal(error.code, 'TRANSPORT')
})

test('throws EMPTY_RESPONSE when the turn produced no text at all', async () => {
  const error = await collect([
    JSON.stringify({
      event: 'result',
      result: { conversation_id: CONVERSATION, status: 'SUCCESS', response: '' },
    }),
  ]).then(
    () => null,
    (thrown) => thrown,
  )
  assert.equal(error?.code, 'EMPTY_RESPONSE')
})

// ------------------------------------------------------------------ 目录解析

test('parses the real `agy models` table', () => {
  // 逐字抄自本机 agy 1.2.8 的实际输出（TAB 分隔、无表头、前面一行进度）。
  const stdout = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
    'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
    'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    '',
  ].join('\n')

  const models = parseModels(stdout)
  assert.equal(models.length, 9)
  assert.deepEqual(models[0], { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' })
  assert.deepEqual(models.at(-1), { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' })
  // 进度行没有 TAB，必须被丢掉。
  assert.ok(!models.some((model) => model.id.includes('Fetching')))
})

test('serves a model catalogue whose ids are exactly what we send back', async () => {
  // 目录里的 id 会被原样塞进 `--model`；`resolveModel` 必须逐字回显，
  // 否则 DSH 的选择器会显示一个发不出去的模型。
  const info = agyFamily.resolveModel('acct-agy', 'gemini-3.8-flash-high')
  assert.equal(info.provider, 'acct-agy')
  assert.equal(info.id, 'gemini-3.8-flash-high')
  assert.equal(info.context.contextWindow, 1_000_000)
  // 刻意不声明 reasoning：档位已经烧进模型 id。
  assert.equal(info.reasoning, undefined)
  assert.deepEqual(info.inputModalities, ['text'])
})

// ------------------------------------------------------------------ 提示词

test('flattens the DSH conversation into one prompt', () => {
  const prompt = buildPrompt({
    system: 'You are terse.',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking…' },
          { type: 'text', text: 'let me look' },
          { type: 'tool-call', name: 'read_file' },
        ],
      },
      { role: 'user', blocks: [{ type: 'tool-result', name: 'read_file' }, { type: 'text', text: 'ok?' }] },
    ],
  })

  assert.match(prompt, /^You are terse\./)
  assert.match(prompt, /User: hi/)
  assert.match(prompt, /Assistant: thinking…\nlet me look\n\[tool call read_file\]/)
  // 工具结果必须留下痕迹，否则模型以为对话是连贯的。
  assert.match(prompt, /User: \[tool result read_file\]\nok\?/)
})

test('maps usage flags onto the DSH field names', () => {
  assert.deepEqual(mapUsage({ input_tokens: 5, output_tokens: 2, thinking_tokens: 1 }), {
    inputTokens: 5,
    outputTokens: 2,
  })
  assert.equal(mapUsage({}), undefined)
  assert.equal(mapUsage(undefined), undefined)
})

test('classifies upstream prose into pool failure codes', () => {
  assert.equal(classifyAgyFailure('You are not logged into Antigravity.', 0), 'AUTH')
  assert.equal(classifyAgyFailure('RESOURCE_EXHAUSTED: quota', 0), 'RATE_LIMIT')
  assert.equal(classifyAgyFailure('request failed: …: EOF', 0), 'TRANSPORT')
  assert.equal(classifyAgyFailure('something odd', 1), 'SERVER')
  assert.equal(classifyAgyFailure('', 0, { empty: true }), 'EMPTY_RESPONSE')
})

// ------------------------------------------------------------------ 本机探测

test('probe reports a missing CLI instead of throwing', async () => {
  const probe = await probeAgy({ config: { agyBin: 'definitely-not-a-real-binary-xyz' } })
  assert.equal(probe.installed, false)
  assert.equal(probe.signedIn, false)
  assert.deepEqual(probe.models, [])
})

test('probe finds this machine agy, and the family agrees', async (t) => {
  const probe = await probeAgy()
  if (!probe.installed) return t.skip('agy is not installed on this machine')
  if (!probe.signedIn) return t.skip(`agy is installed but not signed in (${probe.detail})`)

  assert.ok(probe.models.length > 0, 'a signed-in agy must report at least one model')
  const discovered = await agyFamily.discover()
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].importable, true)
  // 令牌在 agy 自己的钥匙串里 —— 我们既不持有也不复制它。
  assert.deepEqual(discovered[0].auth, { kind: 'cli', owner: 'agy' })
  assert.equal(discovered[0].externallyOwned, true)
})

// ------------------------------------------------------------------ 真机推理

test('runs one real turn through the CLI', { skip: process.env.BRIDGE_LIVE_AGY !== '1' }, async () => {
  const chunks = []
  for await (const chunk of agyFamily.stream(
    { config: {} },
    {
      payload: { auth: { kind: 'cli', owner: 'agy' } },
      model: 'gemini-3.8-flash-low',
      messages: [{ role: 'user', content: 'Reply with exactly: BRIDGEOK' }],
    },
  )) {
    chunks.push(chunk)
  }

  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.match(text, /BRIDGEOK/)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // 这一族每回合的固定开销是 27k 上下，不该悄悄变多。
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.ok(usage.usage.inputTokens > 20_000)
})
