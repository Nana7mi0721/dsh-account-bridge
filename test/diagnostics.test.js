/**
 * W8 的两半：诊断**记录器**（`src/wire/diagnostics.js`）与诊断**发出点**。
 *
 * 为什么要一个专门的测试文件：W8 的承诺是「翻译层不再静默丢东西」，而这句话在
 * 提交时的真实性**完全取决于有没有人验证过它**。加完码、写完文档、单测全绿，
 * 仍然可能是「会报告但生产路径上没有人听」——那比不报告更糟（文档成了假的）。
 * 所以这里同时钉三件事：
 *
 * 1. 记录器本身的语义（有界、去重、两档严重性、永不抛）；
 * 2. **每一个丢点真的会发出诊断**，而且 `path` 指得准；
 * 3. 严重性分档是对的——`error` 只留给「模型/用户真的少了东西」。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_DIAGNOSTIC_LIMIT,
  Diagnostics,
  diagnosticReporter,
  makeDiagnostic,
} from '../src/wire/diagnostics.js'
import { toAnthropicMessages } from '../src/wire/anthropic.js'
import { toChatMessages } from '../src/wire/chat-completions.js'
import { toResponsesInput } from '../src/wire/responses.js'
import { toResponsesInput as toGrokInput, buildGrokBody } from '../src/wire/grok.js'

/** 收集诊断的小助手：`onDiagnostic` 就是它。 */
function collector() {
  const seen = []
  const report = (entry) => seen.push(entry)
  return { seen, report, codes: () => seen.map((entry) => entry.code) }
}

/** 按 code 找一条，找不到就抛（省得断言里到处写 `[0]`）。 */
function find(seen, code) {
  const hit = seen.find((entry) => entry.code === code)
  assert.ok(hit, `expected a ${code} diagnostic, got ${JSON.stringify(seen)}`)
  return hit
}

// ------------------------------------------------------------------ 记录器

test('an unknown code is kept as UNKNOWN rather than dropped', () => {
  // 「上游说了句我们不认识的话」本身就是要记的事。丢掉它等于回到静默。
  const made = makeDiagnostic({})
  assert.equal(made.code, 'UNKNOWN')
  assert.equal(made.severity, 'warning')
  assert.equal(made.phase, 'stream')
  assert.equal(made.message, 'UNKNOWN')
})

test('a bogus severity or phase falls back instead of throwing', () => {
  const made = makeDiagnostic({ code: 'X', severity: 'catastrophic', phase: 'sometime' })
  assert.equal(made.severity, 'warning')
  assert.equal(made.phase, 'stream')
})

test('optional fields only appear when they carry something', () => {
  const bare = makeDiagnostic({ code: 'X' })
  assert.deepEqual(Object.keys(bare), ['code', 'severity', 'phase', 'message'])
  const full = makeDiagnostic({ code: 'X', path: 'messages[0]', from: 'a', to: 'b' })
  assert.equal(full.path, 'messages[0]')
  assert.equal(full.from, 'a')
  assert.equal(full.to, 'b')
  // `0` 与 `''` 是**值**，不是「没有」——`from: 0` 必须留下。
  assert.equal(makeDiagnostic({ code: 'X', from: 0 }).from, 0)
})

test('a diagnostic is frozen: nobody downstream can rewrite the record', () => {
  const made = makeDiagnostic({ code: 'X' })
  assert.throws(() => {
    made.code = 'Y'
  })
})

test('the same code and path collapse into one entry with a count', () => {
  const book = new Diagnostics()
  book.report({ code: 'A', path: 'messages[1]' })
  book.report({ code: 'A', path: 'messages[1]' })
  book.report({ code: 'A', path: 'messages[2]' })
  const entries = book.entries
  assert.equal(entries.length, 2)
  assert.equal(entries[0].count, 2)
  assert.equal(entries[1].count, 1)
})

test('the book is bounded, and it says how many it dropped', () => {
  const book = new Diagnostics({ limit: 3 })
  for (let i = 0; i < 10; i += 1) book.report({ code: `C${i}` })
  assert.equal(book.size, 3)
  assert.equal(book.dropped, 7)
  // 丢的是最旧的：留下的是最后三条。
  assert.deepEqual(
    book.entries.map((entry) => entry.code),
    ['C7', 'C8', 'C9'],
  )
})

test('a bad limit falls back to the default rather than disabling the bound', () => {
  for (const limit of [0, -1, 1.5, Number.NaN, '64']) {
    const book = new Diagnostics({ limit })
    for (let i = 0; i < DEFAULT_DIAGNOSTIC_LIMIT + 5; i += 1) book.report({ code: `C${i}` })
    assert.equal(book.size, DEFAULT_DIAGNOSTIC_LIMIT, `limit=${String(limit)}`)
  }
})

test('hasErrors separates "you saw less" from "the result cannot be trusted"', () => {
  const soft = new Diagnostics()
  soft.report({ code: 'A', severity: 'warning' })
  assert.equal(soft.hasErrors, false)
  soft.report({ code: 'B', severity: 'error' })
  assert.equal(soft.hasErrors, true)
})

test('summary takes the heavier severity when one code reports both ways', () => {
  const book = new Diagnostics()
  book.report({ code: 'A', severity: 'warning', path: 'p1' })
  book.report({ code: 'A', severity: 'error', path: 'p2' })
  assert.deepEqual(book.summary().A, { severity: 'error', count: 2, phase: 'stream' })
})

test('describe is undefined when clean, and names what was lost when not', () => {
  const book = new Diagnostics()
  assert.equal(book.describe(), undefined)
  book.report({ code: 'A', severity: 'error' })
  book.report({ code: 'A', severity: 'error' })
  book.report({ code: 'B', severity: 'warning' })
  assert.equal(book.describe(), 'lost content: A×2 B×1')
})

test('an observer that throws cannot take the request down with it', () => {
  const boom = diagnosticReporter(undefined, () => {
    throw new Error('observer is broken')
  })
  assert.doesNotThrow(() => boom({ code: 'X' }))

  const book = new Diagnostics()
  // `report` 自己也不抛——它是被观察者的旁路。
  const evil = { get code() { throw new Error('nope') } }
  assert.doesNotThrow(() => book.report(evil))

  // ctx 本身就是坏的（没有 log、log.warn 会炸）也不行。
  assert.doesNotThrow(() => diagnosticReporter(undefined, undefined)('just a string'))
  assert.doesNotThrow(() => diagnosticReporter({ log: { warn() { throw new Error('x') } } })('y'))
  assert.doesNotThrow(() => diagnosticReporter({ get log() { throw new Error('z') } })({ code: 'Q' }))
})

test('the override wins over the host log, and a bare string becomes a diagnostic', () => {
  const seen = []
  const ctx = { log: { warn: () => assert.fail('the host log should not be used') } }
  diagnosticReporter(ctx, (entry) => seen.push(entry))('plain words')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].message, 'plain words')
  assert.equal(seen[0].code, 'UNKNOWN')
})

// ------------------------------------------------------------------ 请求方向的丢点

test('anthropic: an image without data is an error, and the path points at it', () => {
  const { seen, report } = collector()
  toAnthropicMessages(
    [{ role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image', mediaType: 'image/png' }] }],
    { onDiagnostic: report },
  )
  const hit = find(seen, 'IMAGE_WITHOUT_DATA')
  assert.equal(hit.severity, 'error')
  assert.equal(hit.phase, 'request')
  assert.equal(hit.path, 'messages[0].content[1]')
})

test('anthropic: an unknown block type is reported, and the rest of the turn still goes', () => {
  const { seen, report, codes } = collector()
  const out = toAnthropicMessages(
    [{ role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'video', url: 'x' }] }],
    { cache: false, onDiagnostic: report },
  )
  find(seen, 'UNKNOWN_BLOCK_TYPE')
  // 只上报不裁决：这一轮照样发得出去，文本还在。
  assert.deepEqual(out, [{ role: 'user', content: [{ type: 'text', text: 'q' }] }])
  assert.equal(codes().includes('UNKNOWN_BLOCK_TYPE'), true)
})

test('anthropic: replay on but no signature is a warning, replay off says nothing', () => {
  const message = {
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }],
    source: { kind: 'model', provider: 'acct-claude', model: 'claude-sonnet-4' },
  }
  const off = collector()
  toAnthropicMessages([message], { replay: false, onDiagnostic: off.report })
  assert.deepEqual(off.codes(), [], 'turning replay off is the user\u2019s choice, not a loss')

  const on = collector()
  toAnthropicMessages([message], { replay: true, onDiagnostic: on.report })
  const hit = find(on.seen, 'REPLAY_STATE_MISSING')
  assert.equal(hit.severity, 'warning')
  assert.equal(hit.path, 'messages[0].content[0]')
})

test('chat-completions: the same two request-side losses are reported', () => {
  const { seen, report } = collector()
  toChatMessages(
    [
      {
        role: 'user',
        content: [{ type: 'image' }, { type: 'audio', data: 'x' }],
      },
    ],
    { onDiagnostic: report },
  )
  assert.equal(find(seen, 'IMAGE_WITHOUT_DATA').severity, 'error')
  assert.equal(find(seen, 'UNKNOWN_BLOCK_TYPE').path, 'messages[0].content[1]')
})

test('responses: an unknown block is reported for both roles', () => {
  const { seen, report } = collector()
  toResponsesInput(
    [
      { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'video', url: 'x' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'file', name: 'n.txt' }] },
    ],
    { onDiagnostic: report },
  )
  const paths = seen.filter((entry) => entry.code === 'UNKNOWN_BLOCK_TYPE').map((entry) => entry.path)
  assert.deepEqual(paths, ['messages[0].content[1]', 'messages[1].content[1]'])
})

test('responses: an image without usable data is an error, not just an omission marker', () => {
  const { seen, report } = collector()
  toResponsesInput([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png' }] }], {
    onDiagnostic: report,
  })
  assert.equal(find(seen, 'IMAGE_WITHOUT_DATA').severity, 'error')
})

test('responses: replay on but no encrypted content is reported', () => {
  const message = {
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }],
    source: { kind: 'model', provider: 'acct-codex', model: 'gpt-5-codex' },
  }
  const off = collector()
  toResponsesInput([message], { replay: false, onDiagnostic: off.report })
  assert.deepEqual(off.codes(), [])

  const on = collector()
  toResponsesInput([message], { replay: true, onDiagnostic: on.report })
  assert.equal(find(on.seen, 'REPLAY_STATE_MISSING').severity, 'warning')
})

test('grok: the request-side losses are reported through buildGrokBody too', () => {
  const { seen, report } = collector()
  buildGrokBody({
    model: 'grok-4',
    messages: [{ role: 'user', content: [{ type: 'image' }, { type: 'video' }] }],
    onDiagnostic: report,
  })
  assert.equal(find(seen, 'IMAGE_WITHOUT_DATA').phase, 'request')
  assert.equal(find(seen, 'UNKNOWN_BLOCK_TYPE').path, 'messages[0].content[1]')
})

test('grok: its own toResponsesInput reports the assistant-side losses', () => {
  const { seen, report } = collector()
  toGrokInput(
    [
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 't' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'video' }] },
    ],
    { onDiagnostic: report },
  )
  const paths = seen.map((entry) => entry.path)
  // `reasoning` 这条线从来不回传，属有意为之，不报。
  assert.deepEqual(paths, ['messages[1].content[1]'])
})

// ------------------------------------------------------------------ 静默不能悄悄回来

test('with no observer the translators produce no output at all', () => {
  // 铁律 3：不传就没有观察者。单测直接调翻译层时不该有副作用。
  // 整轮的块都被丢掉时，连这条消息本身都不会发——但那是**没有观察者**的情况下
  // 按同一套规则得到的结果，不是「静默」：接了观察者时同一轮会报出 UNKNOWN_BLOCK_TYPE。
  assert.deepEqual(toAnthropicMessages([{ role: 'user', content: [{ type: 'video' }] }]), [])
})

test('the observer cannot change what gets sent', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'video' }] }]
  const quiet = toAnthropicMessages(messages)
  const loud = toAnthropicMessages(messages, { onDiagnostic: () => {} })
  assert.deepEqual(loud, quiet)
})
