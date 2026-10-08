/**
 * 「从本机 Claude Code 导入登录态」与额度解析的测试。
 *
 * 和 Codex 那条路径一样：不需要网络、不需要账号，却决定了本机已经登过
 * Claude Code 的用户能不能一键导入。`CLAUDE_CONFIG_DIR` 是 Claude Code 自己的
 * 环境变量，插件认它，所以这里可以造一份假的配置目录。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  claudeFamily,
  claudeThinkingType,
  parseUsage,
  thinkingParam,
} from '../src/families/claude.js'

const EMAIL = 'claude-bridge-test@example.com'

/** 在一个临时 CLAUDE_CONFIG_DIR 里跑回调，跑完复原环境变量。 */
async function withClaudeConfig(files, body) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-claude-'))
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(value), 'utf8')
  }
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    return await body(dir)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
}

function credentialsJson() {
  return {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-bridge-test',
      refreshToken: 'sk-ant-ort-bridge-test',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  }
}

test('discovers a Claude Code login and marks it externally owned', async () => {
  await withClaudeConfig(
    { '.credentials.json': credentialsJson(), '.claude.json': { oauthAccount: { emailAddress: EMAIL } } },
    async (dir) => {
      const found = await claudeFamily.discover()
      const mine = found.find((item) => item.sourcePath === join(dir, '.credentials.json'))
      assert.ok(mine, 'the temporary config dir credentials file must be discovered')
      assert.equal(mine.importable, true)
      // 导入来的凭据不是我们自己的：刷新后**不回写**对方的文件。
      assert.equal(mine.externallyOwned, true)
      assert.equal(mine.label, EMAIL)
      assert.equal(mine.auth.access, 'sk-ant-oat-bridge-test')
      assert.equal(mine.auth.refresh, 'sk-ant-ort-bridge-test')
      assert.equal(mine.auth.scopes, 'user:inference user:profile')
      assert.equal(mine.auth.subscriptionType, 'max')
    },
  )
})

test('reports a credentials file with no subscription token as not importable', async () => {
  await withClaudeConfig({ '.credentials.json': { claudeAiOauth: { accessToken: '' } } }, async (dir) => {
    const found = await claudeFamily.discover()
    const mine = found.find((item) => item.sourcePath === join(dir, '.credentials.json'))
    assert.ok(mine, 'the file itself must still be reported')
    assert.equal(mine.importable, false)
    assert.match(mine.reason, /accessToken/)
  })
})

test('parses the new limits[] usage shape', () => {
  const buckets = parseUsage({
    limits: [
      { kind: 'session', percent: 25, resets_at: '2030-01-01T00:00:00.000Z' },
      { kind: 'weekly_all', percent: 80, resets_at: '2030-01-05T00:00:00.000Z' },
      { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: 'Opus' } } },
    ],
  })
  assert.equal(buckets.length, 3)
  assert.equal(buckets[0].name, '5 小时窗口')
  assert.equal(buckets[0].remainingFraction, 0.75)
  assert.equal(buckets[0].resetAt, Date.parse('2030-01-01T00:00:00.000Z'))
  assert.equal(buckets[2].name, '周窗口 (Opus)')
})

test('parses the legacy flat usage shape', () => {
  const buckets = parseUsage({
    five_hour: { utilization: 40, resets_at: '2030-01-01T00:00:00.000Z' },
    seven_day: { utilization: 90 },
  })
  assert.equal(buckets.length, 2)
  assert.equal(buckets[0].id, 'five_hour')
  // 这是画进度条用的比例，浮点尾差不值得修，但断言也别写死等号。
  assert.ok(Math.abs(buckets[0].remainingFraction - 0.6) < 1e-9)
  assert.ok(Math.abs(buckets[1].remainingFraction - 0.1) < 1e-9)
  // 两个形状都没有 ⇒ 没有可展示的额度，而不是一堆空桶。
  assert.equal(parseUsage({}), undefined)
})

test('thinking params always ask for a summary, in both shapes', () => {
  // adaptive 型模型默认 display:'omitted'：思考块回来了，但 thinking 字段是空的，
  // 面板永远是白的，而且思考 token 照样计费。
  assert.deepEqual(thinkingParam('adaptive', 32_000), { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(thinkingParam('enabled', 32_000), {
    type: 'enabled',
    budget_tokens: 16_000,
    display: 'summarized',
  })
  // 未知形状宁可不发：猜错 enabled/adaptive 是整个请求 400。
  assert.equal(thinkingParam(undefined, 32_000), undefined)
  // 预算塞不下时也不发（Anthropic 要求 budget < max_tokens）。
  assert.equal(thinkingParam('enabled', 512), undefined)
})

test('thinking type comes from the model capabilities, never from a guess', () => {
  assert.equal(claudeThinkingType({ thinking: { types: { enabled: { supported: true } } } }), 'enabled')
  assert.equal(claudeThinkingType({ thinking: { types: { adaptive: { supported: true } } } }), 'adaptive')
  // 两个都声明时优先 enabled（与 Claude Code 一致）。
  assert.equal(
    claudeThinkingType({ thinking: { types: { enabled: { supported: true }, adaptive: { supported: true } } } }),
    'enabled',
  )
  assert.equal(claudeThinkingType({}), undefined)
  assert.equal(claudeThinkingType(undefined), undefined)
})
