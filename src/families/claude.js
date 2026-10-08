/**
 * Claude 族（Claude 订阅 / Claude Code 登录态的账号级反代）。
 *
 * 协议常量全部来自 V1ki/dsh-plugin-subscriptions 的 `src/providers/claude.ts`
 * 与 `src/translate/anthropic.ts`，已在本机源码中逐条核对。四个容易踩的点：
 * - **`user-agent` 必须是 CLI 形态**（`claude-cli/<版> (external, cli)`）：额度端点
 *   对认不出的客户端会「激进限流」，而新模型只在够新的版本上下发；
 * - **`thinking` 形状由模型目录的 `capabilities` 决定**，不是我们能猜的：
 *   `enabled` 与 `adaptive` 互不相容，猜错整个请求 400。目录未知时**宁可不发**；
 * - **`display: 'summarized'` 必须显式写**：adaptive 型模型默认 `omitted`，
 *   于是思考块有内容但 `thinking` 字段是空的，面板永远空白；
 * - **`tools` 要按名字排序**，它渲染在缓存前缀最前面，顺序一变整段 prompt cache 失效。
 * @module dsh-account-bridge/families/claude
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createPkce, createState, startLoopback } from '../login/loopback.js'
import { resolveCliVersion } from '../cli-version.js'
import { toAnthropicMessages, toAnthropicSystem, toAnthropicTools, translateAnthropicStream } from '../wire/anthropic.js'
import { httpError } from '../wire/http-error.js'
import { firstPositiveNumber, tryJson, withSource } from '../util.js'

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const TOKEN_URL = 'https://claude.ai/v1/oauth/token'
export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true'
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const MODELS_URL = 'https://api.anthropic.com/v1/models?beta=true'
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
export const CALLBACK_PATH = '/callback'

/** 认不出的 `anthropic-beta` 组合会被拒；这一串与 Claude Code 一致。 */
export const BETA =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24,compact-2026-01-12,files-api-2025-04-14'

/** 目录不可用时的兜底模型，避免整族从选择器里消失。 */
const FALLBACK_MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
]
const DEFAULT_MAX_TOKENS = 32_000
const DEFAULT_CONTEXT_WINDOW = 200_000
/** 提前 5 分钟刷新，避免边界上用到刚过期的 token。 */
const REFRESH_SKEW_MS = 5 * 60_000
/** DSH 的 effort 取值；上游只认这几个。 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/** 永久失效的刷新错误——见到就别再试，让用户重新登录。 */
const PERMANENT_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_token'])

/**
 * 模型 id → 目录里那一段 `capabilities`。
 *
 * `stream()` 只拿得到模型 id（拿不到目录项），而 `thinking`/`effort` 的形状必须由
 * capabilities 决定，所以在 `listModels` 时把这一段记下来。进程重启后目录会重新拉，
 * 记不到时**不发 `thinking`**——少一段思考好过整个请求 400。
 */
const capabilityCache = new Map()

/** @type {import('../families.js').Family} */
export const claudeFamily = {
  id: 'claude',
  displayName: 'Claude (Subscription)',
  route: 'acct-claude',
  risk: 'high',

  // ---------------------------------------------------------------- 本机发现

  /**
   * 读本机 Claude Code 的登录态：`<配置目录>/.credentials.json`
   * 形如 `{claudeAiOauth: {accessToken, refreshToken, expiresAt, scopes, subscriptionType}}`。
   * 配置目录默认 `~/.claude`，`CLAUDE_CONFIG_DIR` 可以改（Claude Code 自己也认这个变量）。
   * 邮箱不在凭据里，另外从 `.claude.json` 的 `oauthAccount` 兜一下（拿不到就算了）。
   */
  async discover() {
    const path = join(claudeConfigDir(), '.credentials.json')
    let json
    try {
      json = tryJson(await readFile(path, 'utf8'))
    } catch {
      return []
    }
    const oauth = json?.claudeAiOauth
    if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
      return [
        {
          family: 'claude',
          sourcePath: path,
          label: 'Claude Code（无订阅令牌）',
          importable: false,
          reason: 'credentials.json 里没有 claudeAiOauth.accessToken',
        },
      ]
    }
    const email = await readClaudeAccountEmail()
    return [
      {
        family: 'claude',
        sourcePath: path,
        label: email ?? oauth.subscriptionType ?? 'Claude Code',
        importable: true,
        externallyOwned: true,
        auth: authFromOauth(oauth),
      },
    ]
  },

  /** 见 codex 族同名方法的说明：统一发现的落盘入口。 */
  recordFromDiscovery(item) {
    return withSource(recordFromAuth(item.auth, item.label, 'client-import', true), item)
  },

  // ---------------------------------------------------------------- 登录

  login: {
    methods: [
      { id: 'browser', label: '在浏览器里登录 Claude' },
      { id: 'import', label: '导入本机 Claude Code 登录态' },
    ],
    async run(session, ctx) {
      if (session.method === 'import') {
        const usable = (await claudeFamily.discover()).filter((item) => item.importable)
        if (usable.length === 0) {
          throw new Error('没有在本机找到可导入的 Claude Code 登录态（~/.claude/.credentials.json）')
        }
        const chosen = usable[0]
        await session.commit({
          kind: 'grant',
          payload: withSource(recordFromAuth(chosen.auth, chosen.label, 'client-import', true), chosen),
        })
        return
      }

      const pkce = createPkce()
      const state = createState()
      // 端口必须临时：redirect_uri 里嵌着端口，写死就对不上了。
      const loopback = await startLoopback({ ports: [0], path: CALLBACK_PATH, signal: session.signal })
      try {
        const url = authorizeUrl(loopback.redirectUri, pkce, state)
        session.notify({ message: '在浏览器里完成 Claude 登录，回调会自己回来。', url })
        const { code } = await loopback.waitForCode(state)
        const tokens = await exchangeCode(ctx, { code, verifier: pkce.verifier, redirectUri: loopback.redirectUri, state }, session.signal)
        const auth = authFromTokens(tokens)
        // profile 是装饰性的：拿不到不能算登录失败。
        const label = (await fetchProfileEmail(ctx, auth, session.signal)) ?? auth.subscriptionType ?? 'Claude'
        await session.commit({ kind: 'grant', payload: recordFromAuth(auth, label, 'oauth', false) })
      } finally {
        await loopback.close()
      }
    },
  },

  // ---------------------------------------------------------------- 凭据

  /** 用 refresh_token 换新的 access_token。 */
  async refresh(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    if (typeof auth.refresh !== 'string' || auth.refresh.length === 0) {
      const error = new Error('claude: account has no refresh token; sign in again')
      error.code = 'AUTH'
      throw error
    }
    const response = await ctx.fetch(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: auth.refresh,
          client_id: CLIENT_ID,
          scope: auth.scopes ?? SCOPE,
        }),
        signal,
      },
      payload.proxy,
    )
    const text = await response.text()
    const json = tryJson(text)
    if (!response.ok) {
      const code = json?.error?.type ?? json?.error ?? `HTTP_${response.status}`
      const error = new Error(`claude token refresh failed: ${code} (HTTP ${response.status})`)
      error.code = PERMANENT_REFRESH_ERRORS.has(String(code)) || response.status < 500 ? 'AUTH' : 'SERVER'
      error.failure = { status: response.status, code: error.code }
      throw error
    }
    if (!json?.access_token) {
      const error = new Error('claude token refresh returned no access_token')
      error.code = 'AUTH'
      throw error
    }
    return authFromTokens({ ...json, refresh_token: json.refresh_token ?? auth.refresh }, auth)
  },

  needsRefresh(payload, now = Date.now()) {
    const expiresAt = payload.auth?.expiresAt
    if (typeof expiresAt !== 'number') return false
    return expiresAt - REFRESH_SKEW_MS <= now
  },

  // ---------------------------------------------------------------- 目录

  async listModels(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    try {
      const response = await ctx.fetch(
        MODELS_URL,
        { headers: requestHeaders(auth, ctx, { json: true }), signal },
        payload.proxy,
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const entries = Array.isArray(json?.data) ? json.data : []
      const out = []
      for (const entry of entries) {
        if (typeof entry?.id !== 'string' || entry.id.length === 0) continue
        capabilityCache.set(entry.id, entry.capabilities)
        out.push(modelInfo(entry.id, entry.display_name ?? entry.id, entry))
      }
      if (out.length > 0) return out
      // 上游回了 200 但一条模型都没有，多半是账号没订阅额度——如实报错，别假装有模型。
      throw new Error('claude: the models endpoint returned an empty catalog')
    } catch (error) {
      if (error?.code === 'AUTH' || /empty catalog/.test(String(error?.message))) {
        ctx.log?.warn?.('account-bridge: claude catalog for %s: %s', payload.label ?? payload.id, error.message)
      }
    }
    return FALLBACK_MODELS.map((model) => modelInfo(model.id, model.name, {}))
  },

  resolveModel(provider, model) {
    return modelInfo(model, model, { id: model, capabilities: capabilityCache.get(model) }, provider)
  },

  // ---------------------------------------------------------------- 额度

  /**
   * 订阅额度：新版回 `limits[]`，旧版回扁平的 `five_hour` / `seven_day*`，数组优先。
   */
  async quota(ctx, payload, signal) {
    const response = await ctx.fetch(
      USAGE_URL,
      { headers: requestHeaders(payload.auth ?? {}, ctx, { json: true, usage: true }), signal },
      payload.proxy,
    )
    if (!response.ok) return undefined
    const json = await response.json().catch(() => undefined)
    return parseUsage(json)
  },

  // ---------------------------------------------------------------- 调用

  async *stream(ctx, options) {
    const { payload, model, messages, tools, effort, system, maxTokens, signal } = options
    const capabilities = capabilityCache.get(model)
    const thinkingType = claudeThinkingType(capabilities)
    const limit = Math.max(1_024, Number(maxTokens) || 0 || DEFAULT_MAX_TOKENS)
    const body = {
      model,
      max_tokens: limit,
      system: toAnthropicSystem(system, messages),
      messages: toAnthropicMessages(messages),
      stream: true,
      ...(tools?.length ? { tools: toAnthropicTools(tools), tool_choice: { type: 'auto' } } : {}),
      ...(thinkingParam(thinkingType, limit) ? { thinking: thinkingParam(thinkingType, limit) } : {}),
      // `output_config.effort` 只在该模型自己声明支持时发，否则上游 400。
      ...(effort && capabilities?.effort?.supported === true ? { output_config: { effort } } : {}),
    }
    const response = await ctx.fetch(
      MESSAGES_URL,
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
      throw httpError(response, text, 'claude')
    }
    yield* translateAnthropicStream(response, { signal })
  },
}

// -------------------------------------------------------------------- 内部

/** 组装授权 URL（注意 `code: 'true'`，Claude 的 authorize 端点要求带它）。 */
function authorizeUrl(redirectUri, pkce, state) {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', pkce.method)
  url.searchParams.set('state', state)
  return url.toString()
}

/** 授权码换令牌。 */
async function exchangeCode(ctx, { code, verifier, redirectUri, state }, signal) {
  const response = await ctx.fetch(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        state,
      }),
      signal,
    },
  )
  const text = await response.text()
  const json = tryJson(text)
  if (!response.ok || !json?.access_token) {
    const error = new Error(`claude authorization failed: HTTP ${response.status} ${text.slice(0, 200)}`)
    error.code = response.status === 400 || response.status === 401 ? 'AUTH' : 'SERVER'
    throw error
  }
  return json
}

/** 令牌响应 → 内部统一的 auth 结构。 */
function authFromTokens(tokens, previous = {}) {
  const expiresIn = Number(tokens.expires_in)
  return {
    access: tokens.access_token,
    refresh: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : previous.refresh,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scopes: typeof tokens.scope === 'string' && tokens.scope.length > 0 ? tokens.scope : (previous.scopes ?? SCOPE),
    subscriptionType: previous.subscriptionType,
  }
}

/** Claude Code 的 credentials.json → 内部 auth 结构（导入用）。 */
function authFromOauth(oauth) {
  return {
    access: oauth.accessToken,
    refresh: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : undefined,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : (oauth.scopes ?? SCOPE),
    subscriptionType: oauth.subscriptionType,
  }
}

/**
 * Claude Code 的配置目录。
 * `CLAUDE_CONFIG_DIR` 是 Claude Code 自己的变量，认它既贴合真实部署，
 * 也让「导入登录态」这条路径可以离线测试。
 */
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** 导入时的展示名：`.claude.json` 里的 `oauthAccount.emailAddress`。 */
async function readClaudeAccountEmail() {
  const candidates = [join(claudeConfigDir(), '.claude.json'), join(homedir(), '.claude.json')]
  for (const path of candidates) {
    try {
      const json = tryJson(await readFile(path, 'utf8'))
      const account = json?.oauthAccount
      const label = account?.emailAddress ?? account?.organizationName
      if (typeof label === 'string' && label.length > 0) return label
    } catch {
      /* 换个候选继续找 */
    }
  }
  return undefined
}

/** 登录后拉一次 profile（**纯装饰**：失败不能影响登录）。 */
async function fetchProfileEmail(ctx, auth, signal) {
  try {
    const response = await ctx.fetch(
      PROFILE_URL,
      { headers: { authorization: `Bearer ${auth.access}`, accept: 'application/json' }, signal },
    )
    if (!response.ok) return undefined
    const json = await response.json()
    auth.subscriptionType = json?.account?.subscription_type ?? auth.subscriptionType
    return json?.account?.email ?? json?.email ?? undefined
  } catch {
    return undefined
  }
}

/** 上游请求头。`user-agent` 的形态决定会不会被限流、能不能拿到新模型。 */
function requestHeaders(auth, ctx, { json = false, stream = false, usage = false } = {}) {
  const headers = {
    authorization: `Bearer ${auth.access ?? ''}`,
    'user-agent': `claude-cli/${resolveCliVersion(ctx, 'claude')} (external, cli)`,
    accept: stream ? 'text/event-stream' : 'application/json',
  }
  if (json) headers['content-type'] = 'application/json'
  if (usage) {
    // 这个端点只认 oauth beta；带上别的组合反而会被激进限流。
    headers['anthropic-beta'] = 'oauth-2025-04-20'
  } else {
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-beta'] = BETA
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  }
  return headers
}

/** 一项模型元数据。`capabilities` 决定 thinking 形状与可用的 effort。 */
function modelInfo(id, name, entry, provider) {
  const capabilities = entry?.capabilities
  const efforts = EFFORT_LEVELS.filter((level) => capabilities?.effort?.[level]?.supported === true).map((level) => ({
    id: level,
    name: level[0].toUpperCase() + level.slice(1),
  }))
  return {
    provider,
    id,
    name: name ?? id,
    context: { contextWindow: entry?.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW },
    defaultMaxTokens: entry?.max_tokens ?? DEFAULT_MAX_TOKENS,
    toolUpdate: 'in-history',
    inputModalities: ['text', 'image'],
    ...(efforts.length > 0 ? { reasoning: { efforts } } : {}),
  }
}

/** `enabled` 与 `adaptive` 互不相容，只能按模型自己声明的来。 */
export function claudeThinkingType(capabilities) {
  const types = capabilities?.thinking?.types
  if (types?.enabled?.supported === true) return 'enabled'
  if (types?.adaptive?.supported === true) return 'adaptive'
  return undefined
}

/**
 * `display: 'summarized'` 两种形状都要显式写：adaptive 型默认 `omitted`，
 * 思考块会带着空的 `thinking` 字段回来，面板永远是白的。
 */
export function thinkingParam(thinkingType, maxTokens) {
  if (thinkingType === 'adaptive') return { type: 'adaptive', display: 'summarized' }
  if (thinkingType !== 'enabled') return undefined
  const budget = Math.min(Math.max(1_024, Math.floor(maxTokens * 0.5)), maxTokens - 100)
  return budget < 1_024 ? undefined : { type: 'enabled', budget_tokens: budget, display: 'summarized' }
}

/** 新版 `limits[]` 与旧版扁平字段两种形状都要认，数组优先。 */
export function parseUsage(json) {
  const buckets = []
  if (Array.isArray(json?.limits)) {
    for (const limit of json.limits) {
      const percent = firstPositiveNumber(limit, ['percent', 'utilization'])
      const id = limit.kind ?? 'limit'
      buckets.push({
        id: limit.scope?.model?.display_name ? `${id}:${limit.scope.model.display_name}` : id,
        name: limitName(limit),
        remainingFraction: percent === undefined ? undefined : Math.max(0, 1 - percent / 100),
        resetAt: resetAt(limit.resets_at),
      })
    }
    if (buckets.length > 0) return buckets
  }
  const push = (id, name, source) => {
    if (!source || typeof source !== 'object') return
    const utilization = firstPositiveNumber(source, ['utilization', 'percent', 'used_percent'])
    const remaining = firstPositiveNumber(source, ['remaining_fraction'])
    buckets.push({
      id,
      name,
      remainingFraction: remaining ?? (utilization === undefined ? undefined : Math.max(0, 1 - utilization / 100)),
      resetAt: resetAt(source.resets_at ?? source.resetsAt),
    })
  }
  push('five_hour', '5 小时窗口', json?.five_hour)
  push('seven_day', '周窗口', json?.seven_day)
  push('seven_day_opus', '周窗口 (Opus)', json?.seven_day_opus)
  push('seven_day_sonnet', '周窗口 (Sonnet)', json?.seven_day_sonnet)
  return buckets.length > 0 ? buckets : undefined
}

function limitName(limit) {
  const model = limit.scope?.model?.display_name
  switch (limit.kind) {
    case 'session':
      return '5 小时窗口'
    case 'weekly_all':
      return '周窗口'
    case 'weekly_scoped':
      return model ? `周窗口 (${model})` : '周窗口 (分模型)'
    default:
      return model ? `${limit.kind} (${model})` : String(limit.kind ?? 'limit')
  }
}

/** ISO 字符串或秒级时间戳 → 绝对毫秒。 */
function resetAt(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value > 1e12 ? value : value * 1000
}

/** 把一次登录的结果整理成账号记录。 */
function recordFromAuth(auth, label, source, externallyOwned) {
  return {
    family: 'claude',
    label: label ?? auth.subscriptionType ?? 'claude',
    source,
    externallyOwned,
    auth,
    createdAt: new Date().toISOString(),
  }
}

/** 测试用：清掉 capabilities 缓存。 */
export function __clearCapabilityCache() {
  capabilityCache.clear()
}
