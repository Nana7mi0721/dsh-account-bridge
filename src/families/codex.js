/**
 * Codex 族（ChatGPT 订阅 / Codex CLI 的账号级反代）。
 *
 * 协议常量全部来自 V1ki/dsh-plugin-subscriptions 的 `src/providers/codex.ts`
 * 与 1jehuang/dsh-reverse-proxy，已在本机源码中逐条核对。要点：
 * - 账号身份取 id_token 的 `https://api.openai.com/auth`.chatgpt_account_id，
 *   请求时放进 `chatgpt-account-id` 头；
 * - 额度重置**只读 body 字段**，绝不读 `x-codex-*-reset-after-seconds` 响应头
 *   （那是窗口滚动快照，误读会把几秒的 429 停成几小时）；
 * - 模型目录要丢 `visibility` 为 hide/none 的项，并丢掉 effort `ultra`
 *   （Responses API 收到会 400）。
 * @module dsh-account-bridge/families/codex
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createPkce, createState, startLoopback } from '../login/loopback.js'
import { toResponsesInput, toResponsesTools, translateResponsesStream } from '../wire/responses.js'
import { resolveCliVersion } from '../cli-version.js'
import { decodeJwtPayload, firstPositiveNumber, randomId, tryJson } from '../util.js'

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
export const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
export const ORIGINATOR = 'codex_cli_rs'
export const CALLBACK_PATH = '/auth/callback'
/** Codex CLI 固定用这两个回环端口，依次尝试。 */
export const CALLBACK_PORTS = [1455, 1457]

/** 上下文与输出上限（来自 Codex CLI 的模型元数据）。 */
const CONTEXT_WINDOW = 400_000
const MAX_OUTPUT = 128_000
/** 提前 5 分钟刷新，避免边界上用到刚过期的 token。 */
const REFRESH_SKEW_MS = 5 * 60_000

const EFFORTS = [
  { id: 'minimal', name: 'Minimal' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Extra high' },
]
/** Responses API 不认 `ultra`，目录里出现也必须丢掉。 */
const REJECTED_EFFORTS = new Set(['ultra'])

/** 刷新令牌永久失效的错误码——见到就不必再试，直接让用户重新登录。 */
const PERMANENT_REFRESH_ERRORS = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
])

/** 目录兜底：上游目录接口不可用时至少让模型选择器有东西可选。 */
const FALLBACK_MODELS = [
  { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
  { id: 'gpt-5', name: 'GPT-5' },
]

/** @type {import('../families.js').Family} */
export const codexFamily = {
  id: 'codex',
  displayName: 'ChatGPT (Codex)',
  route: 'acct-codex',
  risk: 'medium',

  // ---------------------------------------------------------------- 本机发现

  /**
   * 读本机 Codex CLI 的登录态。
   * `~/.codex/auth.json` = `{OPENAI_API_KEY, auth_mode, last_refresh, tokens}`；
   * OAuth 模式时 `tokens` 里有 `access_token` / `refresh_token` / `id_token` / `account_id`。
   */
  async discover() {
    const candidates = [join(homedir(), '.codex', 'auth.json')]
    if (process.env.CODEX_HOME) candidates.unshift(join(process.env.CODEX_HOME, 'auth.json'))
    const found = []
    for (const path of candidates) {
      let raw
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        continue
      }
      const json = tryJson(raw)
      const tokens = json?.tokens
      if (!tokens || typeof tokens.access_token !== 'string') {
        found.push({
          family: 'codex',
          sourcePath: path,
          label: 'Codex CLI（API key 模式，无订阅令牌）',
          importable: false,
          reason: 'auth.json 里没有 OAuth tokens，只有 API key',
        })
        continue
      }
      const claims = decodeJwtPayload(tokens.id_token) ?? {}
      found.push({
        family: 'codex',
        sourcePath: path,
        label: claimsEmail(claims) ?? tokens.account_id ?? 'Codex CLI',
        importable: true,
        externallyOwned: true,
        auth: authFromTokens(tokens),
      })
    }
    return found
  },

  /**
   * 把一条发现记录变成可落盘的账号记录。
   *
   * 与 `login: { method: 'import' }` 共用同一个构造器——两条入口必须产出**逐字节相同**的
   * 记录，否则「同一份本机登录态经不同路径导入」会变成两条互相不知道对方存在的账号。
   */
  recordFromDiscovery(item) {
    return recordFromAuth(item.auth, item.label, 'client-import', true)
  },

  // ---------------------------------------------------------------- 登录

  login: {
    methods: [
      { id: 'browser', label: '在浏览器里登录 ChatGPT' },
      { id: 'import', label: '导入本机 Codex CLI 登录态' },
    ],
    async run(session, ctx) {
      if (session.method === 'import') {
        const found = await codexFamily.discover()
        const usable = found.filter((item) => item.importable)
        if (usable.length === 0) {
          throw new Error('没有在本机找到可导入的 Codex CLI 登录态（~/.codex/auth.json）')
        }
        const chosen =
          usable.length === 1
            ? usable[0]
            : usable[
                Number(
                  await session.prompt({
                    kind: 'select',
                    message: '要导入哪一个？',
                    options: usable.map((item, index) => ({ value: String(index), label: item.label })),
                  }),
                )
              ]
        await session.commit({ kind: 'grant', payload: recordFromAuth(chosen.auth, chosen.label, 'client-import', true) })
        return
      }

      const pkce = createPkce()
      const state = createState()
      const loopback = await startLoopback({
        ports: CALLBACK_PORTS,
        path: CALLBACK_PATH,
        signal: session.signal,
      })
      try {
        const url = authorizeUrl(loopback.redirectUri, pkce, state)
        session.notify({ message: '在浏览器里完成 ChatGPT 登录，回调会自己回来。', url })
        const { code } = await loopback.waitForCode(state)
        const tokens = await exchangeCode(ctx, code, pkce.verifier, loopback.redirectUri, session.signal)
        await session.commit({
          kind: 'grant',
          payload: recordFromAuth(authFromTokens(tokens), claimsEmail(decodeJwtPayload(tokens.id_token) ?? {}), 'oauth', false),
        })
      } finally {
        await loopback.close()
      }
    },
  },

  // ---------------------------------------------------------------- 凭据

  /** 过期了就换新的；永久失效的错误码直接抛 AUTH。 */
  async refresh(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    if (typeof auth.refresh !== 'string' || auth.refresh.length === 0) {
      const error = new Error('codex: account has no refresh token; sign in again')
      error.code = 'AUTH'
      throw error
    }
    const response = await ctx.fetch(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: auth.refresh,
          scope: SCOPE,
        }),
        signal,
      },
      payload.proxy,
    )
    const text = await response.text()
    const json = tryJson(text)
    if (!response.ok) {
      const code = json?.error?.code ?? json?.error ?? `HTTP_${response.status}`
      const error = new Error(`codex token refresh failed: ${code} (HTTP ${response.status})`)
      error.code = PERMANENT_REFRESH_ERRORS.has(String(code)) ? 'AUTH' : response.status >= 500 ? 'SERVER' : 'AUTH'
      error.failure = { status: response.status, code: error.code }
      throw error
    }
    if (!json?.access_token) {
      const error = new Error('codex token refresh returned no access_token')
      error.code = 'AUTH'
      throw error
    }
    return authFromTokens({ ...json, refresh_token: json.refresh_token ?? auth.refresh }, auth.idToken)
  },

  /** 还需要提前刷新吗。 */
  needsRefresh(payload, now = Date.now()) {
    const expiresAt = payload.auth?.expiresAt
    if (typeof expiresAt !== 'number') return false
    return expiresAt - REFRESH_SKEW_MS <= now
  },

  // ---------------------------------------------------------------- 目录

  async listModels(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    try {
      const url = `${MODELS_URL}?client_version=${encodeURIComponent(resolveCliVersion(ctx, 'codex'))}`
      const response = await ctx.fetch(url, { headers: requestHeaders(auth, ctx, { json: true }), signal }, payload.proxy)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const models = Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : []
      const out = []
      for (const model of models) {
        const id = model?.slug ?? model?.id ?? model?.model
        if (typeof id !== 'string' || id.length === 0) continue
        if (model.visibility === 'hide' || model.visibility === 'none') continue
        out.push(modelInfo(id, model.display_name ?? model.name ?? id, model))
      }
      if (out.length > 0) return out
    } catch {
      /* 目录接口不可用时退回兜底列表，绝不把整族模型弄消失 */
    }
    return FALLBACK_MODELS.map((model) => modelInfo(model.id, model.name, {}))
  },

  /** 单个模型的完整元数据（`resolveModel` 要求严格回显 provider/id）。 */
  resolveModel(provider, model) {
    return modelInfo(model, model, {}, provider)
  },

  // ---------------------------------------------------------------- 额度

  /**
   * 双窗口额度（5 小时滚动 + 周）。
   * 重置时间**只读 body**：`resets_in_seconds` / `reset_after_seconds` / `resets_at` / `reset_at`。
   */
  async quota(ctx, payload, signal) {
    const response = await ctx.fetch(USAGE_URL, { headers: requestHeaders(payload.auth ?? {}, ctx, { json: true }), signal }, payload.proxy)
    if (!response.ok) return undefined
    const json = await response.json().catch(() => undefined)
    return parseUsage(json)
  },

  // ---------------------------------------------------------------- 调用

  async *stream(ctx, options) {
    const { payload, model, messages, tools, effort, signal } = options
    const { instructions, input } = toResponsesInput(messages)
    const body = {
      model,
      instructions,
      input,
      tools: toResponsesTools(tools),
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: [],
      ...(effort ? { reasoning: { effort, summary: 'auto' } } : {}),
    }
    const response = await ctx.fetch(
      RESPONSES_URL,
      {
        method: 'POST',
        headers: requestHeaders(payload.auth ?? {}, ctx, { json: true, stream: true }),
        body: JSON.stringify(body),
        signal,
      },
      payload.proxy,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw httpError(response, text, 'codex')
    }
    yield* translateResponsesStream(response, { signal })
  },
}

// -------------------------------------------------------------------- 内部

/** 组装授权 URL。 */
function authorizeUrl(redirectUri, pkce, state) {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', pkce.method)
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', ORIGINATOR)
  return url.toString()
}

/** 授权码换令牌。 */
async function exchangeCode(ctx, code, verifier, redirectUri, signal, proxy) {
  const response = await ctx.fetch(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      signal,
    },
    proxy,
  )
  const text = await response.text()
  const json = tryJson(text)
  if (!response.ok || !json?.access_token) {
    const error = new Error(`codex authorization failed: HTTP ${response.status} ${text.slice(0, 200)}`)
    error.code = response.status === 400 || response.status === 401 ? 'AUTH' : 'SERVER'
    throw error
  }
  return json
}

/** 把一次登录的结果整理成账号记录。 */
function recordFromAuth(auth, label, source, externallyOwned) {
  return {
    family: 'codex',
    label: label ?? auth.email ?? auth.accountId ?? 'codex',
    source,
    externallyOwned,
    auth,
    createdAt: new Date().toISOString(),
  }
}

/** 令牌 → 我们内部统一的 auth 结构。 */
function authFromTokens(tokens, fallbackIdToken) {
  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : fallbackIdToken
  const claims = decodeJwtPayload(idToken) ?? {}
  const authClaims = claims['https://api.openai.com/auth'] ?? {}
  const expiresIn = Number(tokens.expires_in)
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    idToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    accountId: authClaims.chatgpt_account_id ?? tokens.account_id,
    planType: authClaims.chatgpt_plan_type,
    email: claimsEmail(claims),
  }
}

function claimsEmail(claims) {
  return claims?.['https://api.openai.com/profile']?.email ?? claims?.email
}

/** 上游请求头。 */
function requestHeaders(auth, ctx, { json = false, stream = false } = {}) {
  const headers = {
    accept: stream ? 'text/event-stream' : 'application/json',
    originator: ORIGINATOR,
    version: resolveCliVersion(ctx, 'codex'),
    'session-id': randomId(16).replace(/-/g, '').slice(0, 36),
  }
  if (json) headers['content-type'] = 'application/json'
  if (typeof auth.access === 'string') headers.authorization = `Bearer ${auth.access}`
  if (typeof auth.accountId === 'string') headers['chatgpt-account-id'] = auth.accountId
  return headers
}

/** 一项模型元数据。 */
function modelInfo(id, name, source, provider) {
  const efforts = (Array.isArray(source?.supported_reasoning_efforts) ? source.supported_reasoning_efforts : [])
    .map((item) => (typeof item === 'string' ? item : item?.effort ?? item?.id))
    .filter((item) => typeof item === 'string' && item.length > 0 && !REJECTED_EFFORTS.has(item))
  const list = (efforts.length > 0 ? efforts : EFFORTS.map((item) => item.id)).map((effort) => ({
    id: effort,
    name: EFFORTS.find((item) => item.id === effort)?.name ?? effort,
  }))
  const defaultEffort = list.some((item) => item.id === 'high') ? 'high' : list[0]?.id
  return {
    provider,
    id,
    name: name ?? id,
    context: { contextWindow: source?.context_window ?? CONTEXT_WINDOW },
    defaultMaxTokens: Math.min(source?.max_output_tokens ?? MAX_OUTPUT, MAX_OUTPUT),
    toolUpdate: 'in-history',
    inputModalities: ['text', 'image'],
    reasoning: { efforts: list, ...(defaultEffort ? { defaultEffort } : {}) },
  }
}

/** 上游额度响应 → 我们的 bucket 列表。 */
function parseUsage(json) {
  const buckets = []
  const push = (id, name, source) => {
    if (!source || typeof source !== 'object') return
    const remaining = firstPositiveNumber(source, ['remaining_fraction', 'remainingFraction'])
    const used = firstPositiveNumber(source, ['used_percent', 'usedPercent', 'used_fraction'])
    const resetSeconds =
      firstPositiveNumber(source, ['resets_in_seconds', 'reset_after_seconds', 'resetsInSeconds', 'resetAfterSeconds']) ??
      firstPositiveNumber(source, ['resets_at', 'reset_at', 'resetsAt', 'resetAt'])
    if (remaining === undefined && used === undefined && resetSeconds === undefined) return
    buckets.push({
      id,
      name,
      remainingFraction: remaining ?? (used === undefined ? undefined : Math.max(0, 1 - used / 100)),
      resetAt: resetSeconds === undefined ? undefined : normaliseReset(resetSeconds),
    })
  }
  push('codex-5h', '5 小时窗口', json?.rate_limit ?? json?.rateLimit ?? json?.primary)
  push('codex-weekly', '周窗口', json?.secondary ?? json?.weekly)
  return buckets.length > 0 ? buckets : undefined
}

/** 秒数或绝对时间戳 → 绝对毫秒。 */
function normaliseReset(value) {
  if (value > 1e12) return value
  if (value > 1e9) return value * 1000
  return Date.now() + value * 1000
}

/** 非 2xx 响应 → 带 DSH provider 中立码的错误。 */
export function httpError(response, text, who) {
  const json = tryJson(text)
  const detail = json?.error?.message ?? json?.message ?? text.slice(0, 300)
  const error = new Error(`${who}: HTTP ${response.status} ${detail}`)
  const retryAfter = Number(response.headers.get('retry-after'))
  const providerRetryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : (() => {
          const ms = Number(response.headers.get('retry-after-ms') ?? response.headers.get('x-retry-after-ms'))
          return Number.isFinite(ms) && ms > 0 ? ms : undefined
        })()
  error.code = mapStatus(response.status, detail)
  error.failure = {
    status: response.status,
    code: error.code,
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
  }
  return error
}

function mapStatus(status, detail = '') {
  const text = String(detail).toLowerCase()
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return text.includes('quota') || text.includes('usage limit') ? 'QUOTA' : 'RATE_LIMIT'
  if (status === 402) return 'ACCOUNT_QUOTA'
  if (status === 400 && text.includes('context')) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status >= 500) return 'SERVER'
  if (status === 408 || status === 504) return 'TIMEOUT'
  return 'SERVER'
}
