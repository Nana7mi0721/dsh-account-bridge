/**
 * Grok（xAI）族：复用 **Grok 订阅额度**的账号级反代。
 *
 * 这一族存在的前提是「用订阅额度，不走按量计费」，所以默认端点刻意不是
 * `api.x.ai`（那是按量 API 口径），而是 Grok CLI 用的订阅代理
 * `cli-chat-proxy.grok.com`。想走按量口径的账号自己开 `auth.useApiEndpoint`。
 *
 * 上线前踩过 / 差点踩到的坑，逐条写在这里，改代码前先读：
 *
 * 1. **`cli-chat-proxy` 要四个指纹头**，缺一个就失败，而且失败方式很难查：
 *    `x-grok-client-version` 缺了回 **HTTP 426 Upgrade Required**
 *    ——这个码在监控里长得像网关故障，根因（我们的信封不完整）会被查很久；
 *    缺其它头则是**静默 403**，和「套餐没权限」的 403 长得一模一样（见 `failureOf`）。
 * 2. **不冒充 `grok-shell`**：真机证据是带诚实的 `dsh-grok-provider` 一样 200。
 *    冒充只会把风控落到用户账号上，换不来任何能力。
 * 3. **refresh_token 不一定轮换（G9）**：xAI 的 refresh 响应可能带新的
 *    `refresh_token` 也可能不带，**无法预判**。所以：缺了新 token 不是错误
 *    （沿用旧的），并且**每次刷新后无条件原地写回 `~/.grok/auth.json`**
 *    ——不写回的话，一旦上游这次真的轮换了，用户本机的 Grok CLI 就被踢下线了。
 * 4. **写回必须原子 + CAS**：先重读文件比对，发现别的进程（用户自己的
 *    `grok login`）中途改过就**放弃写回**。auth.json 里没有 generation 字段，
 *    所以 CAS 基准用「我们读到的旧内容的指纹」（见 `writeBackAuth`）。
 * 5. **绝不编额度**：`/v1/billing` 读不到就返回 `undefined`。protobuf 投影会
 *    省略零值，所以「有 currentPeriod 但没有 creditUsagePercent」是 **0%**，
 *    而「连窗口都没有」才是「不知道」——两者的区别就是用户会不会被误导。
 * 6. **权限没有合法替代方案**：xAI 的 OIDC discovery **没有
 *    `registration_endpoint`**，官方也没有第三方 public client 注册入口，
 *    所以只能用 Grok CLI 那个公开 client_id。`ctx.config.grokClientId`
 *    是留给上游轮换/吊销时的逃生舱，不是常规配置项。
 *
 * `prompt_cache_key` 按账号 + 会话派生（不是登录时那个账号级常量），见 `src/wire/identity.js`。
 * 身份命名空间那套派生借自 AstrLink `core/internal/accountauth/claude_identity.go`
 * （Apache-2.0），见 THIRD_PARTY_NOTICES.md。
 * @module dsh-account-bridge/families/grok
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { createPkce, createState, startLoopback } from '../login/loopback.js'
import { httpError } from '../wire/http-error.js'
import {
  GROK_API_BASE,
  GROK_CLI_BASE,
  GROK_CLI_MODELS_PATHS,
  buildGrokBody,
  endpointKind,
  grokBillingUrl,
  grokCliCatalogUrl,
  grokHeaders,
  grokModelsUrl,
  grokResponsesUrl,
  translateGrokStream,
  fingerprintError,
} from '../wire/grok.js'
import { accountScopedSession } from '../wire/identity.js'
import { decodeJwtPayload, tryJson, withSource } from '../util.js'

/** 身份命名空间用的族名（与 `family.id` 一致；写死是为了改 id 时会当场露馅）。 */
const IDENTITY_FAMILY = 'grok'

/** 会话级的缓存亲和键；拿不到账号或会话时返回 undefined。 */
function scopeCacheKey(account, session) {
  return accountScopedSession(IDENTITY_FAMILY, account?.id, session)
}

/** 兜底：登录时生成的账号级缓存键（没有会话标识时用它）。 */
function accountCacheKey(auth) {
  return typeof auth?.cacheKey === 'string' && auth.cacheKey.length > 0 ? auth.cacheKey : undefined
}

// ------------------------------------------------------------------ 常量

/** 公开的 Grok CLI public client（6 个独立来源）。没有合法途径自建。 */
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
export const GROK_AUTH_BASE = 'https://auth.x.ai'
export const GROK_DISCOVERY_URL = `${GROK_AUTH_BASE}/.well-known/openid-configuration`
export const GROK_AUTHORIZE_URL = `${GROK_AUTH_BASE}/oauth2/authorize`
export const GROK_TOKEN_URL = `${GROK_AUTH_BASE}/oauth2/token`
export const GROK_DEVICE_CODE_URL = `${GROK_AUTH_BASE}/oauth2/device/code`
export const GROK_CALLBACK_PATH = '/callback'

/**
 * 回环端口从 56121 起扫。
 *
 * 56121 是 Grok CLI 自己在用的端口，而 redirect_uri 大概率是**按客户端登记**的，
 * 所以首选它、失败才退到相邻端口。这里**不保证**换端口一定能过：真实口径未知，
 * 换端口失败时设备码那条路一定可用（headless 场景本来也只能走它）。
 */
export const GROK_CALLBACK_PORTS = [56121, 56122, 56123, 56124, 56125]

/** 兜底版本：npm 查不到时的最后一道。来源是参考实现里出现过的真实版本号。 */
export const GROK_FALLBACK_CLIENT_VERSION = '0.1.220'

/** npm 上的候选包名。查不到就退回兜底常量，绝不猜一个看起来像的号。 */
const GROK_NPM_CANDIDATES = ['@xai-official%2fgrok', 'grok-cli']

/**
 * 兜底模型：目录整条挂掉时不能一个模型都不给（否则这一族会从选择器里消失）。
 *
 * `contextWindow` 取 256k（V1ki 的 `GROK_CONTEXT_WINDOW`）。真机上 4.5/4.6 都报
 * 500k，但**宁可保守**：高估窗口会让一次本该被拦下的请求白烧额度。
 */
export const FALLBACK_MODELS = [
  { id: 'grok-4', name: 'Grok 4' },
  { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning' },
  { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
]
const DEFAULT_CONTEXT_WINDOW = 256_000
const DEFAULT_MAX_TOKENS = 32_000
/**
 * 提前 5 分钟刷新：与三家参考实现同口径（V1ki 用 2 分钟，另外三家 5 分钟）。
 * 取宽的那个——边界上用到刚过期的 token 会白烧一次上游请求。
 */
const REFRESH_SKEW_MS = 5 * 60_000

/** xAI 的 CLI catalog 只认这些档位（`off` 被上游当作「关思考」，不进 DSH 的档位表）。 */
const EFFORT_VALUES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * 模型 id → 目录里那一段思考元数据。
 *
 * 为什么不塞进 `auth`：`stream()` 只拿得到模型 id（拿不到目录项），而「这个模型
 * 支不支持 effort、默认哪一档」必须由**CLI catalog** 决定。目录失败时**沿用上次
 * 已知的值**——否则一次瞬时故障就会把用户选好的 effort 悄悄去掉。
 */
const catalogCache = new Map()

/** auth.json 原始内容的指纹（写回 CAS 的基准）。 */
const fileHashByPath = new Map()

// ------------------------------------------------------------------ 族对象

/** @type {import('../families.js').Family} */
export const grokFamily = {
  id: 'grok',
  displayName: 'Grok (xAI)',
  route: 'acct-grok',
  /**
   * risk 定 `high`：xAI 这条路的授权码流程用的是 **Grok CLI 的公开 client_id**，
   * 拿它做第三方客户端复用订阅额度，**没有被上游明确许可**；ToS 上也没有像
   * Claude Code / Codex 那样的「允许订阅用于本工具」的公开表述。
   * 风险落在用户账号上，所以照实标高，不学「反正没人管」。
   */
  risk: 'high',

  // ---------------------------------------------------------------- 本机发现

  /**
   * 读本机 Grok CLI 的登录态：`~/.grok/auth.json`（`GROK_HOME` 可覆盖目录）。
   *
   * 顶层是「槽位键 → 记录」的字典，键形如
   * `https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828`。
   * 正常只有一条；多条且没有一条明确属于 auth.x.ai 时**报错而不是猜第一条**
   * ——猜错了就是拿别人的账号在跑，而且用户不会发现。
   */
  async discover() {
    const path = authFilePath()
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return []
    }
    const parsed = selectSlot(text)
    if (!parsed) {
      return [
        {
          family: 'grok',
          sourcePath: path,
          label: 'Grok CLI（未能解析）',
          importable: false,
          reason: 'auth.json 里没有任何可识别的凭据记录',
        },
      ]
    }
    if (parsed.error) {
      return [{ family: 'grok', sourcePath: path, label: 'Grok CLI（多份登录态）', importable: false, reason: parsed.error }]
    }
    const { slot, record } = parsed
    const auth = authFromRecord(record)
    // 槽位键要记下来：写回时**必须写回同一条记录**，选错槽位等于把 A 账号的令牌
    // 写进 B 账号的记录里。
    auth.slot = slot
    if (!auth.access) {
      return [
        {
          family: 'grok',
          sourcePath: path,
          label: 'Grok CLI（缺少 access token）',
          importable: false,
          reason: `auth.json 的 "${slot}" 里既没有 key 也没有 access_token`,
        },
      ]
    }
    rememberHash(path, text)
    return [
      {
        family: 'grok',
        sourcePath: path,
        label: accountLabel(auth) ?? 'Grok',
        importable: true,
        externallyOwned: true,
        auth,
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
      { id: 'browser', label: '在浏览器里登录 xAI（授权码 + 回环回调）' },
      { id: 'device', label: '用设备码登录（headless / 远程机器）' },
      { id: 'import', label: '导入本机 Grok CLI 登录态' },
    ],
    async run(session, ctx) {
      if (session.method === 'import') {
        const usable = (await grokFamily.discover()).filter((item) => item.importable)
        if (usable.length === 0) {
          throw new Error('没有在本机找到可导入的 Grok CLI 登录态（~/.grok/auth.json）')
        }
        const chosen = usable[0]
        await session.commit({
          kind: 'grant',
          payload: withSource(recordFromAuth(chosen.auth, chosen.label, 'client-import', true), chosen),
        })
        return
      }
      if (session.method === 'device') {
        await runDeviceFlow(session, ctx)
        return
      }
      await runBrowserFlow(session, ctx)
    },
  },

  // ---------------------------------------------------------------- 凭据

  /**
   * 用 refresh_token 换新 access_token。
   *
   * 返回的是**新的 auth 对象**（池子做浅合并），所以 `useApiEndpoint` / `baseUrl`
   * 这些用户设定必须原样带回去——漏掉就等于把「我要走哪条计费口径」这个决定
   * 悄悄改回默认值。`payload.proxy` 也要透传，否则配了代理的账号会突然直连。
   */
  async refresh(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    if (typeof auth.refresh !== 'string' || auth.refresh.length === 0) {
      const error = new Error('grok: account has no refresh token; sign in again')
      error.code = 'AUTH'
      throw error
    }
    const clientId = grokClientId(ctx)
    const response = await ctx.fetch(
      GROK_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        // 参考实现都**不发 `scope`**：refresh 请求带 scope 会被部分 OIDC 实现判为
        // 越权申请（要求重新走授权码流程）。
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: auth.refresh,
        }).toString(),
        signal,
      },
      payload.proxy,
    )
    const text = await response.text()
    const json = tryJson(text)
    if (!response.ok || !json?.access_token) {
      const oauthCode = String(json?.error ?? `HTTP_${response.status}`)
      const error = new Error(`grok token refresh failed: ${oauthCode} (HTTP ${response.status})`)
      // 只有 `invalid_grant`（以及 401/403）是**永久**失效，该让用户重新登录；
      // 5xx 与限流只是这一次运气不好，归 SERVER 让池子等一会儿再来
      // ——归成 AUTH 会把账号冷 24 小时，等于逼用户重走一遍授权码流程。
      error.code =
        oauthCode === 'invalid_grant' || response.status === 401 || response.status === 403
          ? 'AUTH'
          : response.status >= 500 || response.status === 429
            ? 'SERVER'
            : 'AUTH'
      error.failure = { status: response.status, code: error.code }
      throw error
    }
    const next = authFromTokens(
      { ...json, refresh_token: json.refresh_token ?? auth.refresh },
      { ...auth, slot: auth.slot },
    )
    // G9：轮换与否无法预判 ⇒ 无条件原地写回。写失败只是 warning，
    // 不能连累这次刷新——手上的新令牌是好的。
    if (payload.externallyOwned === true) {
      try {
        const result = await writeBackAuth(next, payload)
        if (!result.ok) {
          ctx.log?.warn?.(
            'account-bridge: grok 写回 %s 失败（%s），本机 CLI 可能仍是旧令牌',
            payload.sourcePath ?? authFilePath(),
            result.reason,
          )
        }
      } catch (error) {
        ctx.log?.warn?.('account-bridge: grok 写回 %s 抛错（%s）', payload.sourcePath ?? authFilePath(), error?.message ?? error)
      }
    }
    return next
  },

  needsRefresh(payload, now = Date.now()) {
    const expiresAt = payload.auth?.expiresAt
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false
    return expiresAt - REFRESH_SKEW_MS <= now
  },

  // ---------------------------------------------------------------- 目录

  /**
   * 模型目录。两个来源分工明确：
   * - `api.x.ai/v1/models` = 「有哪些模型」的权威来源（含按量 API 新上线的）；
   * - `cli-chat-proxy/v1/models` = **唯一的思考档位来源**（哪些 effort 可用、默认哪档）。
   *
   * 两边都可能单独挂掉，而 CLI catalog 只是 enrichment：它失败**不能**让整族
   * 从选择器里消失（G15），所以降级顺序是 目录 → 只信权威来源 → 兜底快照。
   */
  async listModels(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    const clientVersion = grokClientVersion(ctx)
    const ids = new Map()

    try {
      const response = await ctx.fetch(
        grokModelsUrl(),
        { headers: grokHeaders({ access: auth.access, clientVersion, cli: false }), signal },
        payload.proxy,
      )
      if (response.ok) {
        for (const id of parseModelIds(await response.json().catch(() => undefined))) {
          ids.set(id, { id })
        }
      }
    } catch (error) {
      ctx.log?.warn?.('account-bridge: grok 模型目录不可用（%s）', error?.message ?? error)
    }

    // CLI catalog：失败就沿用上次已知的思考元数据，而不是把它清空（G15）。
    const catalog = await fetchCliCatalog(ctx, { auth, proxy: payload.proxy, clientVersion, signal })
    if (catalog) {
      for (const entry of parseCliCatalog(catalog)) {
        ids.set(entry.id, { ...(ids.get(entry.id) ?? { id: entry.id }), ...entry })
        catalogCache.set(entry.id, entry)
      }
    }

    const out = []
    for (const entry of ids.values()) out.push(modelInfo(entry.id, entry))
    if (out.length > 0) return out

    // 两个来源都空：只有「之前是真拿到过模型」时才用兜底列表，
    // 否则连兜底一起给（否则这一族会从选择器里消失）。
    ctx.log?.warn?.('account-bridge: grok 模型目录为空或不可用，使用兜底列表')
    const fallback = FALLBACK_MODELS.map((model) =>
      modelInfo(model.id, { id: model.id, name: model.name, ...(catalogCache.get(model.id) ?? {}) }),
    )
    // 之前 catalog 里见过、但这次目录没给的模型也要显示：一次瞬时故障不该
    // 把用户正在用的模型从选择器里抹掉。
    for (const [id, entry] of catalogCache) {
      if (!fallback.some((model) => model.id === id)) fallback.push(modelInfo(id, entry))
    }
    return fallback
  },

  resolveModel(provider, model) {
    const entry = catalogCache.get(model) ?? { id: model }
    return modelInfo(model, entry, provider)
  },

  // ---------------------------------------------------------------- 额度

  /**
   * 订阅额度：`GET /v1/billing?format=credits`（**只有 CLI 代理有这个端点**）。
   *
   * 读不到就返回 `undefined`（契约 §C3）。绝不在读不到时编 0%——
   * 那会让用户以为额度用完了，或者以为还剩满额。
   */
  async quota(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    const clientVersion = grokClientVersion(ctx)
    const response = await ctx.fetch(
      grokBillingUrl(),
      {
        headers: grokHeaders({
          access: auth.access,
          clientVersion,
          json: false,
          // 上游几乎不给套餐名，`x-userid` 能让它知道是哪条订阅。
          extra: typeof auth.userId === 'string' && auth.userId.length > 0 ? { 'x-userid': auth.userId } : {},
        }),
        signal,
      },
      payload.proxy,
    )
    if (!response.ok) return undefined
    const json = await readCompressedJson(response)
    return parseGrokQuota(json)
  },

  // ---------------------------------------------------------------- 调用

  async *stream(ctx, options) {
    const { payload, model, messages, tools, effort, system, maxTokens, signal, account, session } = options
    const auth = payload.auth ?? {}
    const clientVersion = grokClientVersion(ctx)
    const kind = endpointKind(auth)
    const body = buildGrokBody({
      model,
      messages,
      tools,
      system,
      maxTokens,
      // 缓存亲和键必须稳定：同一账号的同一段会话要一直落回同一个缓存分片（G7）。
      // **按会话派生**，不是「整个账号一个常量」——后者会让该账号上所有对话挤同一个分片。
      // `auth.cacheKey` 只在拿不到会话时兜底（它是登录时生成的账号级随机值）。
      promptCacheKey: scopeCacheKey(account, session) ?? accountCacheKey(auth),
      // effort 只在目录证明这个模型支持它时才发——猜一个档位会 400。
      effort: effortFor(model, effort) ? effort : undefined,
    })
    const response = await ctx.fetch(
      grokResponsesUrl(auth),
      {
        method: 'POST',
        headers: grokHeaders({ access: auth.access, clientVersion, cli: kind === 'cli', json: true }),
        body: JSON.stringify(body),
        signal,
      },
      payload.proxy,
      // 第 4 个参数必须是 true：长推理里两个数据块之间可能静默超过 30 秒，
      // 不带这个标志会被 undici 的 bodyTimeout 掐断（本仓库修过一次的 bug）。
      true,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw failureOf(response, text)
    }
    yield* translateGrokStream(response, { signal })
  },
}

// ------------------------------------------------------------------ 端点与版本

/** client_id：公开的那个，除非用户在配置里显式换掉（上游轮换/吊销时的逃生舱）。 */
export function grokClientId(ctx) {
  const configured = ctx?.config?.grokClientId
  return typeof configured === 'string' && configured.length > 0 ? configured : GROK_CLIENT_ID
}

/**
 * 该报哪个 `x-grok-client-version`。
 *
 * 同步返回 + 后台刷新：请求头是同步拼的，网络查询绝不能挡在对话路径上。
 * 形态必须是 `x.y.z`（上游按这个形态校验），所以任何来路不明的字符串都不采信。
 */
export function grokClientVersion(ctx, now = Date.now()) {
  const configured = ctx?.config?.grokClientVersion
  if (isVersion(configured)) return configured
  const entry = versionCache
  if (entry.version && now - entry.fetchedAt < VERSION_TTL_MS) return entry.version
  if (!entry.pending) refreshClientVersion(ctx, now)
  return entry.version ?? GROK_FALLBACK_CLIENT_VERSION
}

const VERSION_TTL_MS = 6 * 60 * 60_000
const versionCache = { version: undefined, fetchedAt: 0, pending: false }

/** 后台查一次 npm；失败就维持现状（兜底常量照样能能用）。 */
function refreshClientVersion(ctx, now) {
  if (typeof ctx?.fetch !== 'function') return
  versionCache.pending = true
  const attempt = async (index) => {
    if (index >= GROK_NPM_CANDIDATES.length) return undefined
    const url = `https://registry.npmjs.org/${GROK_NPM_CANDIDATES[index]}/latest`
    try {
      const response = await ctx.fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return attempt(index + 1)
      const json = await response.json()
      return isVersion(json?.version) ? json.version : attempt(index + 1)
    } catch {
      return attempt(index + 1)
    }
  }
  // 这是一个**后台**查询，不是这次请求的一部分：绝不能 await 它，否则每个
  // 请求都要先等一次 npm 往返；也绝不能把它的失败变成未处理的拒绝。
  attempt(0)
    .then((version) => {
      if (isVersion(version)) {
        versionCache.version = version
        versionCache.fetchedAt = Date.now()
      }
    })
    .catch(() => {
      /* 离线/被墙都无所谓 */
    })
    .finally(() => {
      versionCache.pending = false
      // 失败也要推一下时间戳，否则每个请求都会重试一次 npm。
      if (versionCache.fetchedAt === 0) versionCache.fetchedAt = now - VERSION_TTL_MS + 10 * 60_000
    })
}

/** 版本号形态校验：绝不把上游回的任何字符串原样拼进请求头（否则就是 426）。 */
function isVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
}

/** 测试用：清掉版本与目录缓存。 */
export function __resetGrokCaches() {
  versionCache.version = undefined
  versionCache.fetchedAt = 0
  versionCache.pending = false
  catalogCache.clear()
  fileHashByPath.clear()
}

// ------------------------------------------------------------------ 凭据文件

/** Grok CLI 的配置目录。`GROK_HOME` 覆盖它（测试与多 profile 部署都要用）。 */
export function grokHome() {
  const configured = process.env.GROK_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) {
    const trimmed = configured.trim()
    // 有人会把变量指到文件本身；两种都认，但不做更多猜测。
    return /auth\.json$/i.test(trimmed) ? trimmed.replace(/[\\/]auth\.json$/i, '') : trimmed
  }
  return join(homedir(), '.grok')
}

/** `~/.grok/auth.json`。 */
export function authFilePath(home = grokHome()) {
  // 归一化：Windows 上 `join` 出的是反斜杠，直接和 `/.grok/auth.json` 比会永远不相等
  // （参考实现里就有这个 bug，`isGrokAuthPath` 必须先 replace 反斜杠）。
  return join(home, 'auth.json')
}

/** 从文件文本里挑出属于 auth.x.ai 的那条记录。 */
export function selectSlot(text) {
  const json = tryJson(text)
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined
  const entries = Object.entries(json).filter(([, value]) => value && typeof value === 'object')
  if (entries.length === 0) return undefined
  const marked = entries.filter(
    ([key, record]) => /auth\.x\.ai/.test(key) || /auth\.x\.ai/.test(String(record.oidc_issuer ?? record.issuer ?? '')),
  )
  if (marked.length === 1) return { slot: marked[0][0], record: marked[0][1] }
  if (entries.length === 1) return { slot: entries[0][0], record: entries[0][1] }
  if (marked.length === 0) {
    return {
      error: `auth.json contains ${entries.length} credential pairs and none of them marks auth.x.ai; refusing to guess which account to use`,
    }
  }
  return { error: `auth.json contains ${marked.length} credential pairs for auth.x.ai; refusing to guess which account to use` }
}

/** 磁盘上的 auth.json 内容 → 内部 auth 结构。 */
function authFromRecord(record) {
  return {
    access: pickString(record, ['key', 'access', 'access_token']),
    refresh: pickString(record, ['refresh_token', 'refresh']),
    expiresAt: parseExpiresAt(record),
    slot: undefined,
    userId: pickString(record, ['user_id', 'accountId', 'principal_id']),
    email: pickString(record, ['email']),
    teamId: pickString(record, ['team_id']),
    issuer: pickString(record, ['oidc_issuer', 'issuer']),
    clientId: pickString(record, ['oidc_client_id']),
    tier: undefined,
    cacheKey: undefined,
  }
}

/** 读一次 auth.json（含 CAS 基准指纹的刷新）。给测试与写回复用。 */
export async function readAuthFile(path = authFilePath()) {
  const text = await readFile(path, 'utf8')
  const parsed = selectSlot(text)
  if (!parsed || parsed.error) return undefined
  rememberHash(path, text)
  const auth = authFromRecord(parsed.record)
  auth.slot = parsed.slot
  return { path, slot: parsed.slot, record: parsed.record, auth, text }
}

/**
 * 把刷新出来的令牌**原地**写回 auth.json。
 *
 * 三条硬要求（契约 §6）：
 * - 同目录临时文件 + `rename`（原子替换，读者永远看到完整文件）；
 * - **CAS**：先重读，指纹和我们读到的旧内容不一致就**放弃写**——
 *   那说明用户自己的 `grok login` 或另一个进程刚写过，我们手上这对已经作废，
 *   写回去只会把他踢下线；
 * - 权限 0600（Windows 上是空操作，失败不中断）。
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function writeBackAuth(next, payload = {}) {
  const path = payload.sourcePath ?? authFilePath()
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const current = selectSlot(text)
  if (!current || current.error) return { ok: false, reason: 'unreadable' }
  const slot = payload.auth?.slot ?? current.slot
  const doc = tryJson(text)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc[slot]) return { ok: false, reason: 'gone' }

  const before = fileHashByPath.get(path)
  const actual = hashDoc(doc)
  if (before !== undefined && before !== actual) return { ok: false, reason: 'stale' }

  doc[slot] = {
    ...doc[slot],
    key: next.access,
    refresh_token: next.refresh,
    // 上游要 RFC3339 字符串，不是 epoch 毫秒（写错了 CLI 会认为令牌已过期）。
    expires_at: new Date(next.expiresAt ?? Date.now() + 3_600_000).toISOString(),
    oidc_issuer: doc[slot].oidc_issuer ?? next.issuer ?? GROK_AUTH_BASE,
    oidc_client_id: doc[slot].oidc_client_id ?? next.clientId ?? GROK_CLIENT_ID,
  }
  if (typeof next.userId === 'string' && next.userId.length > 0) doc[slot].user_id = next.userId

  const out = `${JSON.stringify(doc, null, 2)}\n`
  await atomicWrite(path, out)
  rememberHash(path, out)
  return { ok: true }
}

/** 原子写：同目录私有临时文件 → rename。 */
async function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  try {
    await writeFile(tmp, text, { mode: 0o600 })
  } catch (error) {
    return { ok: false, reason: String(error?.code ?? error?.message ?? error) }
  }
  try {
    await chmod(tmp, 0o600)
  } catch {
    // Windows 上 chmod 基本是空操作，不因为它在意的权限语义失败而中断写回。
  }
  try {
    await rename(tmp, path)
  } catch (error) {
    return { ok: false, reason: String(error?.code ?? error?.message ?? error) }
  }
  return { ok: true }
}

/**
 * 记录/取出 CAS 基准。
 *
 * auth.json **没有 generation 字段**（不像 MiniMax 桌面端），所以 CAS 基准只能
 * 用「我们读到的旧内容」本身：下次写回前重读一遍，指纹变了就说明有人先写过。
 */
function rememberHash(path, text) {
  fileHashByPath.set(path, sha256(text))
}

function hashDoc(doc) {
  return sha256(`${JSON.stringify(doc, null, 2)}\n`)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

// ------------------------------------------------------------------ 登录实现

/** 授权码 + PKCE + 回环回调。 */
async function runBrowserFlow(session, ctx) {
  const pkce = createPkce()
  const state = createState()
  // 参考实现里 nonce 是**小写 hex**（不是 base64url），照抄能少一个未知数。
  const nonce = randomBytes(8).toString('hex')
  const loopback = await startLoopback({
    ports: GROK_CALLBACK_PORTS,
    path: GROK_CALLBACK_PATH,
    host: '127.0.0.1',
    signal: session.signal,
  })
  try {
    // 回环服务自己拼的 redirectUri 用的是 `localhost`，而 Grok CLI 用的是
    // `127.0.0.1`——redirect_uri 很可能是按客户端登记的，所以按 CLI 的形态来。
    const redirectUri = `http://127.0.0.1:${loopback.port}${GROK_CALLBACK_PATH}`
    const url = authorizeUrl({ redirectUri, pkce, state, nonce, clientId: grokClientId(ctx) })
    session.notify({ message: '在浏览器里完成 xAI 登录，回调会自己回来。', url })
    const { code } = await loopback.waitForCode(state)
    const tokens = await exchangeCode(ctx, {
      code,
      verifier: pkce.verifier,
      challenge: pkce.challenge,
      redirectUri,
      clientId: grokClientId(ctx),
      signal: session.signal,
    })
    const auth = authFromTokens(tokens)
    await session.commit({ kind: 'grant', payload: recordFromAuth(auth, accountLabel(auth) ?? 'Grok', 'oauth', false) })
  } finally {
    await loopback.close()
  }
}

/** 设备码流程（headless / 远程机器）。 */
async function runDeviceFlow(session, ctx) {
  const clientId = grokClientId(ctx)
  const response = await ctx.fetch(
    GROK_DEVICE_CODE_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        scope: GROK_SCOPE,
        // 自由文本，不是固定值，也不需要伪装成别家客户端。
        referrer: 'dsh-account-bridge',
      }).toString(),
      signal: session.signal,
    },
  )
  const text = await response.text()
  const json = tryJson(text)
  if (!response.ok || typeof json?.device_code !== 'string') {
    throw new Error(`xAI device authorization failed (HTTP ${response.status}): ${json?.error ?? text.slice(0, 200)}`)
  }
  const verificationUrl = json.verification_uri_complete ?? json.verification_uri
  if (typeof verificationUrl !== 'string' || !verificationUrl.startsWith('https://')) {
    // 明文 http 的验证地址可能是中间人塞进来的，不打开、不转发。
    throw new Error('xAI device authorization returned an untrusted verification URI')
  }
  session.notify({
    message: `在浏览器里打开这个地址完成授权${json.user_code ? `（代码 ${json.user_code}）` : ''}。`,
    url: verificationUrl,
  })
  // broker 的无界面路径只自动回答「只有一个选项的 select」，所以这里刻意用
  // 单选项：非交互入口能跑通，人在界面上也能一眼看出等待已经开始。
  // **不 await**：真实登录要等用户去浏览器点授权（可能几分钟），而轮询本身必须
  // 立刻开始，不能被一个 UI 提示挡住。被拒（DECLINED）也不影响轮询。
  Promise.resolve(
    session.prompt({
      kind: 'select',
      message: '等待你在浏览器里完成授权；完成后会自动继续。',
      options: [{ value: 'wait', label: '好，我去授权' }],
    }),
  ).catch(() => {})

  const deadline = Date.now() + (Number(json.expires_in) > 0 ? Number(json.expires_in) : 600) * 1000
  let intervalMs = (Number(json.interval) > 0 ? Number(json.interval) : 5) * 1000
  let tokens
  while (Date.now() < deadline) {
    if (session.signal?.aborted) throw session.signal.reason ?? new Error('aborted')
    await sleepAbortable(intervalMs, session.signal)
    const polled = await pollDeviceToken(ctx, { deviceCode: json.device_code, clientId, signal: session.signal })
    if (polled.ok) {
      tokens = polled.tokens
      break
    }
    if (polled.slowDown) {
      intervalMs += 5_000
      continue
    }
    if (polled.fatal) {
      throw new Error(`xAI device login rejected: ${polled.detail}`)
    }
  }
  if (!tokens) throw new Error('xAI device code expired before login completed')
  const auth = authFromTokens(tokens)
  await session.commit({ kind: 'grant', payload: recordFromAuth(auth, accountLabel(auth) ?? 'Grok', 'oauth', false) })
}

/** 轮询一次设备码令牌端点。 */
async function pollDeviceToken(ctx, { deviceCode, clientId, signal }) {
  const response = await ctx.fetch(
    GROK_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode,
      }).toString(),
      signal,
    },
  )
  const text = await response.text()
  const json = tryJson(text)
  if (response.ok && typeof json?.access_token === 'string') return { ok: true, tokens: json }
  const code = String(json?.error ?? '')
  if (code === 'authorization_pending') return { ok: false }
  if (code === 'slow_down') return { ok: false, slowDown: true }
  if (code === 'access_denied' || code === 'authorization_denied') {
    return { ok: false, fatal: true, detail: 'the authorization request was denied' }
  }
  if (code === 'expired_token') return { ok: false, fatal: true, detail: 'the device code expired' }
  // 5xx / 网络抖动：不是用户的错，继续轮询到过期为止。
  if (response.status >= 500) return { ok: false }
  return { ok: false, fatal: true, detail: `${code || `HTTP_${response.status}`} ${json?.error_description ?? ''}`.trim() }
}

/** 组装授权 URL。`plan` / `referrer` 是非标准参数，但参考实现都在发。 */
export function authorizeUrl({ redirectUri, pkce, state, nonce, clientId = GROK_CLIENT_ID }) {
  const url = new URL(GROK_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', GROK_SCOPE)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', pkce.method)
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('plan', 'generic')
  url.searchParams.set('referrer', 'dsh-account-bridge')
  return url.toString()
}

/**
 * 授权码换令牌。
 *
 * 发 **7 个** form 字段：参考实现里两家有分歧（一家多带
 * `code_challenge` + `code_challenge_method`）。RFC 6749 允许服务端忽略未知参数，
 * 而漏发导致失败是没有任何补救的——风险不对称，所以选多发。
 *
 * 403 的语义**原样透传**：那是「你的套餐不含 API OAuth 权限」，不是插件 bug，
 * 写成「授权失败」会让用户去查一个不存在的问题。
 */
export async function exchangeCode(ctx, { code, verifier, challenge, redirectUri, clientId, signal }) {
  const params = {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }
  if (challenge) {
    params.code_challenge = challenge
    params.code_challenge_method = 'S256'
  }
  const response = await ctx.fetch(
    GROK_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal,
    },
  )
  const text = await response.text()
  const json = tryJson(text)
  if (response.status === 403) {
    throw new Error(
      'grok token endpoint refused the exchange (HTTP 403): your X plan does not include the API OAuth entitlement; ' +
        'an X Premium or xAI subscription with API access is required',
    )
  }
  if (!response.ok || typeof json?.access_token !== 'string') {
    throw new Error(`grok authorization failed: HTTP ${response.status} ${(json?.error ?? text).slice(0, 200)}`)
  }
  return json
}

/** 令牌响应 → 内部 auth 结构。`refresh_token` 缺失是正常的（G9，沿用旧的）。 */
export function authFromTokens(tokens, previous = {}) {
  const expiresIn = Number(tokens.expires_in)
  const access = tokens.access_token
  const claims = decodeJwtPayload(access) ?? {}
  const idClaims = decodeJwtPayload(tokens.id_token) ?? {}
  return {
    access,
    refresh: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0 ? tokens.refresh_token : previous.refresh,
    // 缺 `expires_in` 时不能留成 undefined：`needsRefresh` 会因此永远返回 false，
    // 于是这个账号再也不会刷新，直到某天拿着过期令牌撞 401。宁可保守地当 1 小时。
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : (typeof previous.expiresAt === 'number' && Number.isFinite(previous.expiresAt) ? previous.expiresAt : Date.now() + 3_600_000),
    // 用户设定必须带回去（池子是浅合并，漏掉就等于把决定改回默认）。
    ...(previous.useApiEndpoint === undefined ? {} : { useApiEndpoint: previous.useApiEndpoint }),
    ...(previous.baseUrl === undefined ? {} : { baseUrl: previous.baseUrl }),
    ...(previous.slot === undefined ? {} : { slot: previous.slot }),
    ...(previous.cacheKey === undefined ? {} : { cacheKey: previous.cacheKey }),
    // `sub` 是**用户标识**，优先从 access token 取：额度端点的 `x-userid` 要它，
    // 而 `id_token` 是给界面展示用的（不一定带 sub）。
    userId: pickString(claims, ['sub']) ?? pickString(idClaims, ['sub']) ?? previous.userId,
    email: pickString(idClaims, ['email', 'preferred_username', 'name']) ?? pickString(claims, ['email']) ?? previous.email,
    // 套餐来源只有 access token 的 `tier` claim（不做签名校验，只用来自我展示）。
    tier: claims.tier ?? previous.tier,
  }
}

/** 账号展示名：邮箱优先，其次套餐名。 */
export function accountLabel(auth) {
  if (typeof auth?.email === 'string' && auth.email.length > 0) return auth.email
  const tier = grokTierName(auth?.tier)
  return tier ? `Grok (${tier})` : undefined
}

/** access token 的 `tier` claim → 套餐名。未知值原样展示，不猜。 */
export function grokTierName(tier) {
  const names = {
    0: 'Free',
    1: 'SuperGrok',
    2: 'X Basic',
    3: 'X Premium',
    4: 'X Premium+',
    5: 'SuperGrok Heavy',
    6: 'SuperGrok Lite',
    7: 'SuperGrok Plus',
  }
  if (typeof tier === 'number' && names[tier]) return names[tier]
  if (typeof tier === 'string' && tier.length > 0 && names[Number(tier)]) return names[Number(tier)]
  return tier === undefined || tier === null ? undefined : String(tier)
}

// ------------------------------------------------------------------ 目录解析

/** `{data:[...]}` / `{models:[...]}` / 顶层数组都要认；行可以是字符串。 */
export function parseModelIds(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  const out = []
  for (const row of rows) {
    const id = typeof row === 'string' ? row : typeof row?.id === 'string' ? row.id : undefined
    // `/v1/models` 还服务 imagine/video/embedding 模型，选择器里不能给。
    if (id && !/imagine|image-|video|embed/i.test(id)) out.push(id)
  }
  return out
}

/** CLI catalog 的一行 → 内部条目。思考档位与上下文窗口只有这里才有。 */
export function parseCliCatalog(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  const out = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : undefined
    if (!id) continue
    const efforts = []
    for (const effort of Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts : []) {
      const value = typeof effort === 'string' ? effort : effort?.value
      if (typeof value === 'string' && EFFORT_VALUES.has(value) && !efforts.includes(value)) efforts.push(value)
    }
    const contextWindow = firstPositive(row.context_window ?? row.contextWindow)
    // `default` 标志不可靠（上游会同时标多个），只信**顶层** `reasoning_effort`，
    // 且要求它确实是这个模型声明过的档位之一。
    const declared = typeof row.reasoning_effort === 'string' ? row.reasoning_effort : undefined
    out.push({
      id,
      name: typeof row.name === 'string' ? row.name : undefined,
      contextWindow,
      maxOutput: firstPositive(row.max_output_tokens ?? row.maxOutputTokens),
      efforts: efforts.length > 0 ? efforts : undefined,
      defaultEffort: declared && efforts.includes(declared) ? declared : undefined,
    })
  }
  return out
}

/**
 * 尺寸/窗口字段一律过一遍这个：**宿主的 `dsh-llm` 会校验 `contextWindow` 是不是
 * 正整数，不是就抛 `adapter returned invalid context metadata`，而且是 provider 级
 * 失败（整族不可用）**。所以宁可回退到保守默认值，也不把上游的 0/`undefined`/
 * 字符串透出去。
 */
function firstPositive(value) {
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return undefined
  return Math.floor(number)
}

/** 内部条目 → 宿主认识的模型元数据。 */
export function modelInfo(id, entry = {}, provider) {
  const fromCatalog = catalogCache.get(id) ?? {}
  const contextWindow = firstPositive(entry.contextWindow ?? fromCatalog.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const defaultMaxTokens = firstPositive(entry.maxOutput ?? fromCatalog.maxOutput) ?? DEFAULT_MAX_TOKENS
  const efforts = entry.efforts ?? fromCatalog.efforts
  const defaultEffort = entry.defaultEffort ?? fromCatalog.defaultEffort
  // 只声明目录里真的出现过的档位：`xhigh` 这类新档位漏报会被上层当成不支持，
  // 而多报一个不存在的档位会直接 400。
  const reasoning =
    Array.isArray(efforts) && efforts.length > 0
      ? {
          efforts: efforts.map((value) => ({ id: value, name: value[0].toUpperCase() + value.slice(1) })),
          ...(defaultEffort ? { defaultEffort } : {}),
        }
      : undefined
  return {
    provider,
    id,
    name: entry.name ?? id,
    context: { contextWindow },
    defaultMaxTokens,
    toolUpdate: 'in-history',
    // `grok-code-*` / embedding 系没有图像输入；其余按 text+image 报（与参考实现同口径）。
    inputModalities: /code|embed/i.test(id) ? ['text'] : ['text', 'image'],
    ...(reasoning ? { reasoning } : {}),
  }
}

/** 拉一次 CLI catalog：两个路径都试，都失败返回 undefined（enrichment 而已）。 */
async function fetchCliCatalog(ctx, { auth, proxy, clientVersion, signal }) {
  for (let variant = 0; variant < GROK_CLI_MODELS_PATHS.length; variant += 1) {
    try {
      const response = await ctx.fetch(
        grokCliCatalogUrl(variant),
        { headers: grokHeaders({ access: auth.access, clientVersion, cli: true }), signal },
        proxy,
      )
      if (!response.ok) continue
      const json = await response.json().catch(() => undefined)
      if (json) return json
    } catch {
      /* 换个路径再试；都不行就降级 */
    }
  }
  return undefined
}

// ------------------------------------------------------------------ 请求与额度

/** 目录证明支持、且用户选的档位在目录里，才把 effort 发出去。 */
function effortFor(model, effort) {
  if (typeof effort !== 'string' || effort.length === 0) return false
  const entry = catalogCache.get(model)
  if (!Array.isArray(entry?.efforts) || entry.efforts.length === 0) return false
  return entry.efforts.includes(effort)
}

/**
 * 额度响应 → DSH 的额度桶。
 *
 * 判定顺序就是「有没有数据」的判定，写错了会给出一个假百分比：
 * 1. 有 `currentPeriod`（protobuf 保留零值删掉标量，但留着带它的窗口）
 *    ⇒ **0% 是真实数据**，不是没数据；
 * 2. 否则旧形态 `monthlyLimit.val > 0` ⇒ 用整数分自己算百分比；
 * 3. 都没有 ⇒ `undefined`（契约 §C3：读不到就不报，绝不编 0%）。
 */
export function parseGrokQuota(json) {
  const config = json?.config
  if (!config || typeof config !== 'object') return undefined
  const percent = finiteNumber(config.creditUsagePercent)
  const period = config.currentPeriod
  const legacyLimit = finiteNumber(config.monthlyLimit?.val)
  const legacyUsed = finiteNumber(config.used?.val)

  let usedPercent
  let resetAt
  let name
  if (period || percent !== undefined) {
    usedPercent = percent ?? 0
    resetAt = parseTime(period?.end) ?? parseTime(config.billingPeriodEnd)
    name = period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? '周窗口' : '月窗口'
  } else if (legacyLimit !== undefined && legacyLimit > 0) {
    usedPercent = ((legacyUsed ?? 0) / legacyLimit) * 100
    resetAt = parseTime(config.billingPeriodEnd)
    name = '月窗口'
  } else {
    return undefined
  }
  const fraction = Math.min(1, Math.max(0, 1 - usedPercent / 100))
  return [
    {
      id: period?.type === 'USAGE_PERIOD_TYPE_MONTHLY' ? 'monthly' : period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? 'weekly' : 'credits',
      name: json?.subscriptionTier ? `${name}（${json.subscriptionTier}）` : name,
      remainingFraction: fraction,
      ...(resetAt === undefined ? {} : { resetAt }),
    },
  ]
}

/** 取「可能是 0」的数字字段——不能用 `firstPositiveNumber`，0 是有效数据。 */
function finiteNumber(value) {
  const number = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined
}

/** ISO 字符串 / 秒 / 毫秒 → 绝对毫秒。 */
function parseTime(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const number = finiteNumber(value)
  if (number === undefined || number <= 0) return undefined
  return number > 1e12 ? number : number * 1000
}

/** `expires_at` 解析：RFC3339 字符串 / 秒 / 毫秒 / `expires_in` 都要认。 */
export function parseExpiresAt(record) {
  const raw = record?.expires_at ?? record?.expiresAt
  if (typeof raw === 'string' && raw.length > 0) {
    // 纳秒精度会让 Date.parse 直接失败；截到毫秒。
    const truncated = raw.replace(/(\.\d{3})\d+/, '$1')
    const parsed = Date.parse(truncated)
    if (Number.isFinite(parsed)) return parsed
  }
  const numeric = finiteNumber(raw)
  if (numeric !== undefined && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  const expiresIn = finiteNumber(record?.expires_in)
  if (expiresIn !== undefined && expiresIn > 0) return Date.now() + expiresIn * 1000
  // 什么都没有时按 1 小时算：这是保守的方向（会更早刷新，而不是拿着过期令牌去撞 401）。
  return Date.now() + 3_600_000
}

/**
 * 读 JSON 响应体，**自己解压**。
 *
 * 上游的 `content-encoding` 不可信（有实现实测到 gzip 正文配错误的编码头），
 * 直接 `.json()` 会炸在解压上。所以按魔数判断：gzip `1f 8b`、brotli 没有魔数
 * 只能靠头、zlib `78 xx`。
 */
export async function readCompressedJson(response) {
  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch {
    try {
      return tryJson(await response.text())
    } catch {
      return undefined
    }
  }
  const body = inflateBody(buffer)
  return tryJson(body.toString('utf8'))
}

/** 按魔数解压；认不出来就原样返回。 */
function inflateBody(buffer) {
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return gunzipSync(buffer)
    } catch {
      return buffer
    }
  }
  // zlib：0x78 开头且 (cmf*256+flg) % 31 === 0。
  if (buffer.length > 2 && buffer[0] === 0x78 && ((buffer[0] << 8) + buffer[1]) % 31 === 0) {
    try {
      return inflateSync(buffer)
    } catch {
      /* 落到 brotli 再试 */
    }
  }
  const encoding = buffer.toString('latin1', 0, 4)
  if (encoding === '{\n  ' || encoding[0] === '{' || encoding[0] === '[') return buffer
  try {
    return brotliDecompressSync(buffer)
  } catch {
    return buffer
  }
}

// ------------------------------------------------------------------ 失败归类

/**
 * 非 2xx 响应 → DSH 的中立失败码。
 *
 * 两个 Grok 特有的前置判断（都必须在通用 `httpError` 之前）：
 * - **426 = 我们的信封不完整**（`x-grok-client-version` 缺失/形态不对），
 *   不是网关故障。这是最容易查错根因的一个；
 * - **403 有两种含义**：缺指纹头 与 「套餐不含 API OAuth 权限」。
 *   带指纹提示字样时归 AUTH（其实是我们的问题，但 403 的冷却语义是「换号」，
 *   在只有单账号时表现为「用户得去看一眼」，比按 SERVER 每 60 秒重试一遍合理）。
 */
export function failureOf(response, text) {
  const detail = jsonDetail(text)
  const fingerprint = fingerprintError(response.status, detail)
  if (fingerprint) {
    const error = new Error(fingerprint.message)
    error.code = fingerprint.code
    error.failure = { status: response.status, code: fingerprint.code }
    return error
  }
  const error = httpError(response, text, 'grok')
  // 锁定的套餐问题：xAI 会在文本里说 "API OAuth entitlement"，归 AUTH 让用户去重登/换号，
  // 而不是每 60 秒重试一次同样的 403。
  if (response.status === 403 && /entitlement|subscription|plan/i.test(detail)) {
    error.code = 'AUTH'
    error.failure = { status: 403, code: 'AUTH' }
  }
  return error
}

/** 从错误正文里摘出人话（优先 `error.message`）。 */
function jsonDetail(text) {
  const json = tryJson(text)
  const detail = json?.error?.message ?? json?.error?.code ?? json?.message ?? json?.error ?? text
  return typeof detail === 'string' ? detail : JSON.stringify(detail ?? '')
}

function pickString(source, keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 把一次登录的结果整理成账号记录。 */
export function recordFromAuth(auth, label, source, externallyOwned) {
  return {
    family: 'grok',
    label: label ?? accountLabel(auth) ?? 'grok',
    source,
    externallyOwned,
    auth: {
      ...auth,
      // 缓存亲和键在**登录时生成一次**并跟着账号走：它必须跨轮稳定（G7），
      // 用会话 id 或随机值都会让 prompt cache 永远不命中。
      cacheKey: auth.cacheKey ?? `grok-${randomBytes(8).toString('hex')}`,
    },
    createdAt: new Date().toISOString(),
  }
}

/** 可被 abort 的 sleep（`session.signal` 可能是 undefined）。 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
