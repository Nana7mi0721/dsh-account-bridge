/**
 * Qoder（阿里 Qoder / qodercli）族。
 *
 * 形态上和别的族有三处根本不同，都决定了这一份实现长什么样：
 *
 * 1. **凭据是粘贴的 PAT**，不是 OAuth 授权码。PAT 本身长期有效，但**每次使用都要
 *    拿它换一只 24 小时有效的 jobToken**，而且新兑换会让旧 jobToken 立刻退役。
 *    ⇒ 这一族必须有 `refresh`，而且 refresh 必须把「jobToken 过期 / 被上游拒」
 *    当成**常规路径**而不是错误（见 {@link qoderFamily.refresh}）。
 * 2. **上游说的是私有方言**（qodercli 信封 + COSY 签名），不是 OpenAI/Anthropic。
 *    请求构造与流解析全在 `../wire/qoder.js`，这里只负责把 DSH 的形状接上去。
 * 3. **区域是凭据的一部分**：国内与全球是两套端点、两套令牌，永不互串。
 *
 * 逆向依据：`_dsh_research/research/_part-qoder.md` 与
 * `_dsh_research/raw/src_masknull_dsh-qoder-connect/src/qoder/`。
 * COSY 签名**上游没有官方文档**，这一份是照逆向复刻的，**未经真机验证**
 * （本机没装 Qoder，没有 `~/.qoder`）：签名本身有 Python 独立实现的定标测试钉住
 * 确定性，但"上游是否接受"只能真机才知道。
 *
 * @module dsh-account-bridge/families/qoder
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { assertApiReply } from '../wire/assert-reply.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  FALLBACK_MODELS,
  buildCosyHeaders,
  buildQoderBody,
  chatUrl,
  encodeQoderBody,
  exchangeUrl,
  modelListUrl,
  normalizeQoderModels,
  normalizeRegion,
  openApiHeaders,
  parseQoderQuota,
  qoderHttpError,
  quotaUrl,
  translateQoderStream,
  toQoderMessages,
  toQoderSystem,
  toQoderTools,
  userInfoUrl,
} from '../wire/qoder.js'

export const ID = 'qoder'
export const ROUTE = 'acct-qoder'
export const DISPLAY_NAME = 'Qoder (China)'

/**
 * jobToken 的提前刷新余量。
 *
 * 5 分钟与上游客户端一致（`auth.ts:14` `expiryBufferMs`）。之所以不能更短：
 * jobToken 的寿命是 24 小时，而**每次兑换都会让旧令牌退役**——余量太小会在一只
 * 令牌刚过期的瞬间让在途请求撞上 401。
 */
export const REFRESH_SKEW_MS = 5 * 60_000
/** 上游没给有效期时的兜底（`auth.ts:15` `defaultExpiryMs`）。 */
export const DEFAULT_JOB_TOKEN_TTL_MS = 24 * 60 * 60_000
/** `effort` → 上游 `reasoning_effort`。上游没声明档位表，这是保守映射。 */
const EFFORT_VALUES = { low: 'low', medium: 'medium', high: 'high' }

// ---------------------------------------------------------------- 小工具

/** 统一的日志出口：harness 的假 ctx 只有 `logger`，没有 `log`。 */
function warn(ctx, message) {
  try {
    if (typeof ctx?.log?.warn === 'function') ctx.log.warn(message)
    else if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
  } catch {
    /* 日志失败不该连累主流程 */
  }
}

/** 本机 Qoder 客户端状态目录（**只读借用**，本族绝不写这里）。 */
export function qoderHomeDir(env = process.env) {
  const home = env?.QODER_HOME || env?.HOME || env?.USERPROFILE || homedir()
  return home ? join(home, '.qoder') : undefined
}

/**
 * 读官方客户端写下的 `machine_id`（**只读**）。
 *
 * 这是本族唯一的本机凭据借用点。之所以要借：`Cosy-Machineid` 参与签名，
 * 换一个值不会报错，但服务端的风控行为可能不同——用客户端已有的那个最稳。
 * 读不到就返回 `undefined`，由调用方生成一个随机的（**并且不落盘**：
 * 往用户的 `~/.qoder` 里写文件是越界行为，见契约 §3.3）。
 */
export async function readMachineId(env = process.env) {
  const dir = qoderHomeDir(env)
  if (!dir) return undefined
  try {
    const value = (await readFile(join(dir, '.auth', 'machine_id'), 'utf8')).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function payloadOf(options) {
  return options?.payload ?? {}
}

/**
 * 取这只账号当前的 jobToken 与身份，供 COSY 签名用。
 *
 * 缺 jobToken 时**抛 AUTH**（而不是发一个没签名的请求）：池子据此把账号冷却 24h
 * 并换号，比让上游回一句含糊的 403 更准确。
 */
function credentialsOf(payload) {
  const auth = payload?.auth ?? {}
  const jobToken = auth.jobToken
  if (typeof jobToken !== 'string' || jobToken.length === 0) {
    const error = new Error('qoder: this account has no job token; re-import the personal access token')
    error.code = 'AUTH'
    throw error
  }
  if (typeof auth.pat !== 'string' || auth.pat.length === 0) {
    const error = new Error('qoder: this account has no personal access token; re-import it to refresh the job token')
    error.code = 'AUTH'
    throw error
  }
  return {
    region: normalizeRegion(auth.region),
    jobToken,
    pat: auth.pat,
    credentials: {
      userID: typeof auth.userID === 'string' ? auth.userID : '',
      authToken: jobToken,
      name: typeof auth.name === 'string' ? auth.name : '',
      email: typeof auth.email === 'string' ? auth.email : '',
      machineID: typeof auth.machineId === 'string' && auth.machineId.length > 0 ? auth.machineId : randomUUID(),
    },
  }
}

// ---------------------------------------------------------------- 兑换与身份

/**
 * PAT → jobToken。
 *
 * 请求形状是这条端点最容易写错的地方：body 是 `{personal_token: pat}`（下划线，
 * 不是 `personalToken`），走 `openApiUrl` 上的**普通 JSON 请求**——它**不签名**，
 * 只带身份头（`openApiHeaders`），因为此时还没有 userID 可以放进签名信封。
 *
 * 有效期：优先 `expires_at`（ISO 字符串，`Date.parse`），否则 `expires_in`
 * （**上游给的是毫秒**，不是秒），都没有就按 24 小时兜底。
 */
export async function exchangePat(ctx, input) {
  const { pat, region, proxy, signal, machineId } = input
  const response = await ctx.fetch(exchangeUrl(region), {
    method: 'POST',
    headers: { ...openApiHeaders(region), 'content-type': 'application/json' },
    body: JSON.stringify({ personal_token: pat }),
    signal,
  }, proxy)
  const text = await response.text().catch(() => '')
  if (!response.ok) throw qoderHttpError(response, text)

  let data
  try {
    data = JSON.parse(text)
  } catch {
    const error = new Error('qoder: the PAT exchange returned a non-JSON body')
    error.code = 'SERVER'
    throw error
  }
  const token = data?.token
  if (typeof token !== 'string' || token.length === 0) {
    // 上游在这里用 200 回一个没有 token 的体：这是凭据问题，不是服务端抖动。
    const error = new Error('qoder: PAT exchange returned no job token')
    error.code = 'AUTH'
    throw error
  }

  const parsedExpiry = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : Number.NaN
  const expiresIn = Number(data.expires_in)
  const expiresAt = Number.isFinite(parsedExpiry)
    ? parsedExpiry
    : Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + expiresIn
      : Date.now() + DEFAULT_JOB_TOKEN_TTL_MS

  return { jobToken: token, expiresAt, machineId }
}

/** 用 jobToken 问一次身份（`uid` 要进签名信封，所以这不是可选的）。 */
export async function fetchIdentity(ctx, input) {
  const { jobToken, region, proxy, signal } = input
  const response = await ctx.fetch(userInfoUrl(region), {
    method: 'GET',
    headers: { ...openApiHeaders(region), authorization: `Bearer ${jobToken}` },
    signal,
  }, proxy)
  const text = await response.text().catch(() => '')
  if (!response.ok) throw qoderHttpError(response, text)
  let info
  try {
    info = JSON.parse(text)
  } catch {
    const error = new Error('qoder: the identity lookup returned a non-JSON body')
    error.code = 'SERVER'
    throw error
  }
  const body = info?.data ?? info
  const id = body?.id ?? body?.uid
  if (id === undefined || id === null || String(id).length === 0) {
    const error = new Error('qoder: identity lookup returned no user id')
    error.code = 'AUTH'
    throw error
  }
  return {
    userID: String(id),
    email: typeof body.email === 'string' ? body.email : undefined,
    name: typeof body.name === 'string' ? body.name : typeof body.username === 'string' ? body.username : undefined,
  }
}

/** 兑换 + 身份 + 组装凭据记录。登录与 refresh 共用这一条路径。 */
async function acquire(ctx, input) {
  const { pat, region, proxy, signal, machineId, label, source, externallyOwned } = input
  const exchanged = await exchangePat(ctx, { pat, region, proxy, signal, machineId })
  const identity = await fetchIdentity(ctx, { jobToken: exchanged.jobToken, region, proxy, signal })
  const now = new Date().toISOString()
  return {
    auth: {
      pat,
      region: normalizeRegion(region),
      jobToken: exchanged.jobToken,
      jobTokenExpiresAt: exchanged.expiresAt,
      userID: identity.userID,
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.name ? { name: identity.name } : {}),
      machineId,
      obtainedAt: now,
    },
    record: {
      family: ID,
      label: label ?? identity.email ?? identity.name ?? `Qoder ${identity.userID.slice(0, 8)}`,
      source: source ?? 'manual',
      externallyOwned: externallyOwned ?? false,
      auth: {
        pat,
        region: normalizeRegion(region),
        jobToken: exchanged.jobToken,
        jobTokenExpiresAt: exchanged.expiresAt,
        userID: identity.userID,
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.name ? { name: identity.name } : {}),
        machineId,
        obtainedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    },
  }
}

// ---------------------------------------------------------------- discover

/**
 * 只有一处可发现：`~/.qoder/.auth/` 下的客户端状态。
 *
 * **这一族在 discover 上是诚实的悲观**：`~/.qoder` 里存的是**用户级 PAT
 * 的哈希/快照**，不是能直接拿来兑换 jobToken 的明文 PAT——上游客户端自己也要
 * 用户先跑一次 `qoder login` 才把明文写进它自己的 keychain。所以这里
 * **不把任何文件报成可导入**，而是把看到的东西如实列出来并说明为什么导不进来。
 * 报 `importable: true` 会让用户在 UI 里点一个必然失败的导入，那比不发现更糟。
 */
export async function discover(ctx, options = {}) {
  const env = options.env ?? process.env
  const dir = qoderHomeDir(env)
  if (!dir) return []
  const out = []
  const machineId = await readMachineId(env)
  if (machineId) {
    out.push({
      family: ID,
      sourcePath: join(dir, '.auth', 'machine_id'),
      label: 'Qoder machine id',
      importable: false,
      externallyOwned: true,
      reason: '本机只存机器标识；Qoder 的登录令牌是粘贴的个人访问令牌（PAT），不在磁盘上，请手动粘贴导入。',
    })
  }
  return out
}

// ---------------------------------------------------------------- 族对象

/** @type {import('../families/registry.js').Family} */
export const qoderFamily = {
  id: ID,
  displayName: DISPLAY_NAME,
  route: ROUTE,
  risk: 'high',

  discover,

  /**
   * discover 从不报 `importable: true`，所以这个钩子不该被调用。
   * 留着是为了如果将来真发现了可导入的凭据，`src/index.js` 的导入按钮能直接用。
   */
  async recordFromDiscovery(item) {
    if (!item?.auth?.pat) {
      const error = new Error('qoder: discovered entries carry no usable personal access token')
      error.code = 'MISSING_CREDENTIAL'
      throw error
    }
    return { family: ID, label: item.label, source: 'client-import', externallyOwned: true, auth: item.auth, createdAt: new Date().toISOString() }
  },

  login: {
    methods: [{ id: 'pat', label: '粘贴个人访问令牌 (PAT)' }],
    /**
     * 粘贴 PAT → 兑换 jobToken → 落库。
     *
     * 区域必须先问：国内与全球是两套端点，猜错会得到一个 401，
     * 而用户没法从错误里看出是"地区选错了"。两个选项的 select 也正好是
     * agent 侧 broker 唯一能自动回答的 prompt 形状（契约 §4.3）。
     */
    async run(session, ctx) {
      const pat = String(await session.prompt({
        kind: 'secret',
        message: '粘贴 Qoder 个人访问令牌（PAT）。获取方式：Qoder 客户端或 https://qoder.com 的账号设置里创建。',
      }) ?? '').trim()
      if (pat.length === 0) {
        const error = new Error('qoder: a personal access token is required')
        error.code = 'MISSING_CREDENTIAL'
        throw error
      }

      const region = String(await session.prompt({
        kind: 'select',
        message: '这个令牌属于哪个区域？国内与全球的令牌不通用，选错会一直是 401。',
        options: [
          { value: 'china', label: '国内（gateway.qoder.com.cn）' },
          { value: 'global', label: '全球（api3.qoder.sh）' },
        ],
      }) ?? 'china')
      const normalized = normalizeRegion(region)

      const machineId = (await readMachineId()) ?? randomUUID()
      const acquired = await acquire(ctx, { pat, region: normalized, machineId, signal: undefined })

      // 必须在 resolve 之前 commit：seam 会对未提交的登录抛 NOT_COMMITTED。
      session.commit(acquired.record)
      session.notify({
        message: `已接入 Qoder（${normalized === 'global' ? '全球' : '国内'}）：${acquired.auth.email ?? acquired.auth.userID}。`
          + ' jobToken 有效期 24 小时，过期会自动用这个 PAT 续。',
      })
      return acquired.record
    },
  },

  /**
   * PAT → 新的 jobToken。
   *
   * **返回的是新的 `auth` 对象**（不是整个 payload）——池子会把它浅合并进原记录，
   * 所以这里只要带上会变的键即可。`pat` / `region` / `machineId` 原样带回去，
   * 浅合并下它们本来就是旧值，显式带上是为了让这个函数的返回值自洽。
   *
   * jobToken 过期**不是异常路径**：过期、被上游拒（新兑换让旧令牌退役）、或者
   * 压根没有过期时间戳——三种情况都走同一条兑换路径，所以 refresh 天然是自愈的。
   */
  async refresh(ctx, payload, signal) {
    const auth = payload?.auth ?? {}
    const pat = auth.pat
    if (typeof pat !== 'string' || pat.length === 0) {
      const error = new Error('qoder: cannot refresh without the personal access token; re-import it')
      error.code = 'AUTH'
      throw error
    }
    const region = normalizeRegion(auth.region)
    const machineId = typeof auth.machineId === 'string' && auth.machineId.length > 0
      ? auth.machineId
      : (await readMachineId()) ?? randomUUID()

    const exchanged = await exchangePat(ctx, { pat, region, proxy: payload?.proxy, signal, machineId })
    return {
      pat,
      region,
      machineId,
      jobToken: exchanged.jobToken,
      jobTokenExpiresAt: exchanged.expiresAt,
      obtainedAt: new Date().toISOString(),
    }
  },

  /**
   * 该不该刷。
   *
   * 与别的族不同的一点：**没有过期时间戳时也刷**。jobToken 的寿命只有 24 小时，
   * 一只没有时间戳的令牌几乎肯定是过期或即将过期的（老版本记录、导入时上游没给
   * 有效期），刷一次的代价是一次廉价请求，不刷的代价是用户看到一个 401。
   */
  needsRefresh(payload, now = Date.now()) {
    const auth = payload?.auth
    if (typeof auth?.pat !== 'string' || auth.pat.length === 0) return false
    const expiresAt = auth.jobTokenExpiresAt
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return true
    return expiresAt - REFRESH_SKEW_MS <= now
  },

  /**
   * 模型目录。
   *
   * 上游目录接口是**签名请求**（要 userID 进信封），所以这里必须先有身份；
   * 目录挂了就回退到 `FALLBACK_MODELS` 快照——那是"让用户还能发请求"的兜底，
   * 不是发现。回退时打一条 warn，好让"模型少了一个"这件事有迹可循。
   */
  async listModels(ctx, payload, signal) {
    const { region, credentials } = credentialsOf(payload)
    const url = modelListUrl(region)
    try {
      const response = await ctx.fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          ...buildCosyHeaders({ body: null, url, credentials }),
        },
        signal,
      }, payload?.proxy)
      const text = await response.text().catch(() => '')
      if (!response.ok) throw qoderHttpError(response, text)
      const models = normalizeQoderModels(JSON.parse(text))
      if (models.length === 0) throw new Error('qoder: the model list was empty')
      return models.map((model) => modelInfo(model.id, model.name, model, ID))
    } catch (error) {
      warn(ctx, `account-bridge: qoder model discovery failed (${error?.message ?? error}); falling back to the built-in list`)
      return FALLBACK_MODELS.map((model) => modelInfo(model.id, model.name, model, ID))
    }
  },

  resolveModel(provider, model) {
    const known = FALLBACK_MODELS.find((entry) => entry.id === model)
    return known
      ? modelInfo(known.id, known.name, known, provider)
      : modelInfo(model, model, { id: model, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }, provider)
  },

  /**
   * 额度查询（`/api/v2/quota/usage`，普通 JSON 请求，不签名）。
   *
   * **读不到就返回 `undefined`**，契约 §3 里写得很直白：报一个假额度比不报更糟。
   * 所以这里失败**不抛**（抛了会连累账号健康状态），而是静默返回 undefined；
   * 只有确实解析出资源包才给面板数据。
   */
  async quota(ctx, payload, signal) {
    const auth = payload?.auth ?? {}
    if (typeof auth.jobToken !== 'string' || auth.jobToken.length === 0) return undefined
    const region = normalizeRegion(auth.region)
    try {
      const response = await ctx.fetch(quotaUrl(region), {
        method: 'GET',
        headers: { ...openApiHeaders(region), authorization: `Bearer ${auth.jobToken}` },
        signal,
      }, payload?.proxy)
      if (!response.ok) return undefined
      const json = await response.json().catch(() => undefined)
      return parseQoderQuota(json)
    } catch {
      return undefined
    }
  },

  /**
   * 一次对话。
   *
   * 请求要过三道工序，顺序不能换：**构造信封 → WAF 编码 → 签名**。
   * 签名里的 body 哈希与长度取的是**编码后**的字节（`Cosy-Bodyhash` /
   * `Cosy-Bodylength`），先签再编码会得到一个上游永远拒的签名。
   *
   * `x-model-key` / `x-model-source` 不是可选头：网关按它们路由到具体模型。
   */
  async *stream(ctx, options) {
    const { model, messages = [], tools = [], effort, system, maxTokens, signal } = options ?? {}
    const payload = payloadOf(options)
    const { region, credentials } = credentialsOf(payload)

    const modelKey = typeof model === 'string' && model.length > 0 ? model : 'cmodel'
    const known = FALLBACK_MODELS.find((entry) => entry.id === modelKey)
    const body = buildQoderBody({
      model: modelKey,
      messages: toQoderMessages(messages),
      tools: toQoderTools(tools),
      system: toQoderSystem(system, messages),
      maxTokens,
      effort: EFFORT_VALUES[effort] ?? undefined,
      isReasoning: known?.isReasoning === true,
      userID: credentials.userID,
      source: known?.source ?? 'system',
    })

    const url = chatUrl(region)
    const encoded = encodeQoderBody(JSON.stringify(body))
    const headers = {
      ...buildCosyHeaders({ body: encoded, url, credentials }),
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      'user-agent': 'qoder/1.1.47',
      'x-model-key': modelKey,
      'x-model-source': known?.source ?? 'system',
    }

    const response = await ctx.fetch(url, {
      method: 'POST',
      headers,
      body: Buffer.from(encoded, 'latin1'),
      signal,
    }, payload.proxy, true)
    // 200 也可能是网页（Cloudflare 挑战页、登录页、空 body）：先确认它像 API 回复。
    const reply = await assertApiReply(response, { who: 'qoder' })
    if (!reply.ok) throw qoderHttpError(reply, await reply.text().catch(() => ''))

    yield* translateQoderStream(reply, { signal })
  },
}

/** 模型条目 → 契约 §5.3 的形状。不知道的值一律保守，不编。 */
export function modelInfo(id, name, entry = {}, provider = ID) {
  const efforts = Array.isArray(entry.efforts) ? entry.efforts : []
  return {
    provider,
    id,
    name: name ?? id,
    context: { contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    defaultMaxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
    toolUpdate: 'in-history',
    inputModalities: entry.inputModalities ?? ['text'],
    ...(efforts.length > 0
      ? { reasoning: { efforts, defaultEffort: entry.isReasoning ? efforts[0].id : undefined } }
      : {}),
  }
}
