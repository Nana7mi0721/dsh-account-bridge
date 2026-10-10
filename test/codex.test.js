/**
 * 「从本机 Codex CLI 导入登录态」的解析测试。
 *
 * 这条路径不需要任何网络或账号，却决定了「本机已经登过 Codex 的用户能不能一键导入」，
 * 所以用一份**构造的** `~/.codex/auth.json`（OAuth 模式）把它钉住。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { codexFamily } from '../src/families/codex.js'

/** 造一个只有签名是假的 JWT（本插件只读 payload，不验签）。 */
function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.not-a-real-signature`
}

const EMAIL = 'bridge-test@example.com'
const ACCOUNT_ID = 'acc_bridge_test_001'

function oauthAuthJson() {
  const idToken = fakeJwt({
    'https://api.openai.com/profile': { email: EMAIL },
    'https://api.openai.com/auth': {
      chatgpt_account_id: ACCOUNT_ID,
      chatgpt_plan_type: 'plus',
    },
  })
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'rt_bridge_test',
      account_id: ACCOUNT_ID,
    },
    last_refresh: '2026-01-01T00:00:00.000Z',
  }
}

/** 把一份 auth.json 放进一个临时 CODEX_HOME，并在回调里跑，跑完复原环境变量。 */
async function withCodexHome(authJson, body) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-codex-'))
  await writeFile(join(dir, 'auth.json'), JSON.stringify(authJson), 'utf8')
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  try {
    return await body(dir)
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
  }
}

test('discovers an OAuth-mode Codex CLI login and marks it externally owned', async () => {
  await withCodexHome(oauthAuthJson(), async (dir) => {
    const found = await codexFamily.discover()
    const mine = found.find((item) => item.sourcePath === join(dir, 'auth.json'))
    assert.ok(mine, 'the temporary CODEX_HOME/auth.json must be discovered')
    assert.equal(mine.importable, true)
    // 导入来的凭据不是我们自己的：刷新后**不回写**对方的文件。
    assert.equal(mine.externallyOwned, true)
    assert.equal(mine.label, EMAIL)
    assert.equal(mine.auth.accountId, ACCOUNT_ID)
    assert.equal(mine.auth.refresh, 'rt_bridge_test')
    assert.equal(typeof mine.auth.access, 'string')
  })
})

test('reports an API-key-only Codex CLI login as not importable instead of pretending', async () => {
  const apiKeyOnly = { OPENAI_API_KEY: 'sk-not-a-subscription', auth_mode: 'apikey', last_refresh: null, tokens: null }
  await withCodexHome(apiKeyOnly, async (dir) => {
    const found = await codexFamily.discover()
    const mine = found.find((item) => item.sourcePath === join(dir, 'auth.json'))
    assert.ok(mine, 'the file itself must still be reported')
    assert.equal(mine.importable, false)
    assert.match(mine.reason, /OAuth tokens/)
  })
})

test('a catalog entry that reports a context window of 0 falls back instead of failing the whole family', async () => {
  // 与 claude 同一条教训（review 抓到）：`??` 不挡 0，而宿主见到非正整数会抛
  // `INVALID_MODEL_CONTEXT`，那条错误在 `resolveModelInfoFor` 里 ⇒ provider 级连坐，
  // 整族从模型选择器里消失。非正数一律当作「没说」。
  const ctx = {
    config: {},
    log: { warn() {} },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { slug: 'gpt-5-codex', display_name: 'Codex', context_window: 0, max_output_tokens: 0 },
          { slug: 'gpt-5.1-codex', context_window: '0' },
        ],
      }),
    }),
  }
  const models = await codexFamily.listModels(ctx, { auth: { access: 'a', refresh: 'r' }, id: 'codex-1' })
  assert.ok(models.length > 0, 'the catalog must still answer')
  for (const model of models) {
    assert.ok(Number.isInteger(model.context.contextWindow), `${model.id} contextWindow must be an integer`)
    assert.ok(model.context.contextWindow > 0, `${model.id} contextWindow must be positive`)
    assert.ok(Number.isInteger(model.defaultMaxTokens) && model.defaultMaxTokens > 0, `${model.id} maxTokens`)
  }
})
