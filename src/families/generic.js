/**
 * `generic` 族 —— 通用兜底：**任意** OpenAI / Anthropic 兼容端点，不写一行族代码就能接。
 *
 * 为什么要有它：前面几族都是「某个具体客户端 / 某个具体订阅」的桥。可长尾是无限的——
 * 自建 vLLM、局域网里的 one-api、公司内网网关、某个只活在群里的中转站。给每一个都写一族
 * 是不可能的，而它们**说同一个方言**：OpenAI 的 Chat Completions。
 *
 * 它和别族的三点不同，都是刻意的：
 *
 * 1. **没有 `refresh`**。API Key 不会过期，也就没有刷新、没有写回、没有并发刷新那一堆事。
 *    这一族对上游是纯只读的（计划书「默认只读」那条在这里天然成立）。
 * 2. **一个端点可以有多个 Key**。host 内置的配置式 provider 只吃一个 Key；这一族把
 *    「同一个末端的 N 个 Key」变成 N 个账号，于是自动轮换、失败换号、粘性会话全部生效。
 *    这才是「兜底」真正补的那块：不是多接一个服务，而是**让没被专门支持的服务也能被池化**。
 * 3. **它不自称任何身份**。不给 Anthropic 端点塞「我是 Claude Code」，也不伪造客户端
 *    UA——我们不认识对端，冒充它对端的官方客户端是撒谎（见 §3.11「默认诚实」）。
 *
 * `auth` 的字段就是这个族全部的配置面：
 *
 * ```js
 * {
 *   baseUrl: 'https://api.example.com/v1',   // 必填；结尾斜杠会被去掉
 *   apiKey: 'sk-...',                        // 二选一
 *   apiKeyEnv: 'EXAMPLE_API_KEY',            // 二选一：只记变量名，密钥不进凭据库
 *   models: ['gpt-4o-mini', { id: 'x', contextWindow: 200000 }],  // 可选，声明式目录
 *   compat: { protocol: 'anthropic' },       // 可选，方言开关
 * }
 * ```
 *
 * @module dsh-account-bridge/families/generic
 */

import { assertApiReply } from '../wire/assert-reply.js'
import { diagnosticReporter } from '../wire/diagnostics.js'
import { httpError } from '../wire/http-error.js'
import {
  normaliseUsage,
  toChatMessages,
  toChatSystem,
  toChatTools,
  translateChatStream,
} from '../wire/chat-completions.js'
import {
  toAnthropicMessages,
  toAnthropicTools,
  translateAnthropicStream,
} from '../wire/anthropic.js'
import { toAnthropicSystem } from '../wire/anthropic.js'

/** 不知道就问不出来的两个数：保守的默认值，声明里可以覆盖。 */
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_OUTPUT = 8_192

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 内置的几个常用端点。它们的 URL 是公开且稳定的，所以能预设；
 * 预设的价值只是省掉一次打字，选完之后照样是普通的 generic 账号。
 */
const PRESETS = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', env: 'SILICONFLOW_API_KEY' },
  { id: 'moonshot', label: 'Moonshot（Kimi）', baseUrl: 'https://api.moonshot.cn/v1', env: 'MOONSHOT_API_KEY' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', env: 'ZHIPUAI_API_KEY' },
  { id: 'dashscope', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY' },
  { id: 'ollama', label: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', env: '' },
  { id: 'lmstudio', label: '本机 LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', env: '' },
]

const COMPAT_DEFAULTS = {
  protocol: 'openai',
  modelsPath: '/models',
  chatPath: '/chat/completions',
  messagesPath: '/messages',
  /** `'bearer'` | `'x-api-key'` | `'none'`；省略时按 protocol 决定。 */
  authHeader: undefined,
  /** `'auto'`（默认：声明了就用声明，否则用 live） | `'live'` | `'union'`。 */
  catalog: 'auto',
  /** 发不发 `stream_options:{include_usage:true}`——不认这个字段的网关会直接 400。 */
  streamUsage: true,
  maxTokensField: 'max_tokens',
  headers: {},
}

/** 合并出这一份凭据实际使用的方言参数。 */
export function compatOf(auth = {}) {
  const raw = auth.compat && typeof auth.compat === 'object' ? auth.compat : {}
  const protocol = raw.protocol === 'anthropic' ? 'anthropic' : 'openai'
  return {
    ...COMPAT_DEFAULTS,
    ...raw,
    protocol,
    headers: { ...(COMPAT_DEFAULTS.headers ?? {}), ...(raw.headers ?? {}) },
    authHeader: raw.authHeader ?? (protocol === 'anthropic' ? 'x-api-key' : 'bearer'),
  }
}

/**
 * 本机 / 内网地址的样子。
 *
 * 这里**必须把四个点分十进制字节写全**，不能只判前缀：`^10\.` 会把 `10.example.com`
 * 这样的**公网主机名**判成本机地址，于是给它发 `http://`——一个静默的降级。
 * 端口可选，后面必须紧跟路径分隔符或字符串结尾，否则 `10.0.0.1.example.com` 也会中招。
 */
const LOCAL_HOST =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?(\/|$)/i

/**
 * 结尾斜杠去掉；没写协议就补一个。
 *
 * 只有**确实是本机/内网 IP** 的才补 `http`，其余一律 `https`：公网端点配 http
 * 会在把 API Key 发出去之前就被中间人拿走，而猜错的代价是「请求失败」——
 * 后者用户一眼能看出来，前者不能。所以要 http 的本机端点以外，宁可猜错。
 */
export function normaliseBaseUrl(value) {
  let url = String(value ?? '').trim()
  if (url.length === 0) return ''
  if (!/^https?:\/\//i.test(url)) url = `${LOCAL_HOST.test(url) ? 'http' : 'https'}://${url}`
  return url.replace(/\/+$/, '')
}

/** baseUrl + 路径 拼成一个端点（路径已是绝对 URL 时原样放行）。 */
export function endpointOf(auth, path) {
  const baseUrl = normaliseBaseUrl(auth.baseUrl)
  if (!baseUrl) {
    const error = new Error('generic: account has no baseUrl')
    error.code = 'INVALID_REQUEST'
    throw error
  }
  if (/^https?:\/\//i.test(String(path ?? ''))) return String(path)
  return `${baseUrl}${path ?? ''}`
}

/**
 * 取出这次请求要用的密钥。
 *
 * `apiKeyEnv` 只存变量名：密钥留在环境里，不进凭据库，插件重启也能跟着环境变。
 * 变量没设时要说清楚是哪个变量没设——「401」对用户毫无帮助。
 */
export function resolveApiKey(auth = {}) {
  if (typeof auth.apiKey === 'string' && auth.apiKey.length > 0) return auth.apiKey
  if (typeof auth.apiKeyEnv === 'string' && auth.apiKeyEnv.length > 0) {
    const value = process.env[auth.apiKeyEnv]
    if (typeof value === 'string' && value.length > 0) return value
    const error = new Error(`generic: 环境变量 ${auth.apiKeyEnv} 是空的，没有可用的密钥`)
    error.code = 'AUTH'
    throw error
  }
  return undefined
}

/** 上游请求头。 */
export function headersOf(auth, compat, { json = false, stream = false } = {}) {
  const headers = { accept: stream ? 'text/event-stream' : 'application/json' }
  if (json) headers['content-type'] = 'application/json'
  const key = resolveApiKey(auth)
  if (key) {
    if (compat.authHeader === 'x-api-key') headers['x-api-key'] = key
    else if (compat.authHeader !== 'none') headers.authorization = `Bearer ${key}`
  }
  if (compat.protocol === 'anthropic') headers['anthropic-version'] = ANTHROPIC_VERSION
  for (const [name, value] of Object.entries(compat.headers ?? {})) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value
  }
  return headers
}

/** 声明式目录 → 统一的模型条目。字符串与对象都收。 */
export function declaredModels(auth = {}) {
  const raw = Array.isArray(auth.models) ? auth.models : []
  const out = []
  for (const entry of raw) {
    const item = typeof entry === 'string' ? { id: entry } : entry
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue
    out.push({ ...item, name: item.name ?? item.id, declared: true })
  }
  return out
}

/** 上游目录响应 → 统一的模型条目。OpenAI 与 Anthropic 都是 `{data:[...]}`。 */
export function parseCatalog(json) {
  const list = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.models)
      ? json.models
      : Array.isArray(json)
        ? json
        : []
  const out = []
  for (const entry of list) {
    const id = entry?.id ?? entry?.name ?? entry?.model
    if (typeof id !== 'string' || id.length === 0) continue
    // 只收「能收文本」的：OpenRouter 这类目录里混着纯生图模型，收进来只会让选择器变脏。
    const inputModalities = entry?.architecture?.input_modalities ?? entry?.input_modalities
    if (Array.isArray(inputModalities) && !inputModalities.includes('text')) continue
    const outputModalities = entry?.architecture?.output_modalities
    if (Array.isArray(outputModalities) && !outputModalities.includes('text')) continue
    out.push({ ...entry, id, name: entry.name ?? entry.display_name ?? id })
  }
  return out
}

/** 一项模型元数据。声明里写了的以声明为准，没写的用目录里的，再没有就用保守默认值。 */
export function modelInfo(id, name, source = {}, provider) {
  const contextWindow =
    firstNumber(source, ['contextWindow', 'context_window', 'context_length', 'max_context_length', 'top_provider.context_length']) ??
    DEFAULT_CONTEXT_WINDOW
  const maxOutput =
    firstNumber(source, ['maxOutput', 'max_output_tokens', 'max_completion_tokens', 'top_provider.max_completion_tokens']) ??
    DEFAULT_MAX_OUTPUT
  const modalities = Array.isArray(source.modalities)
    ? source.modalities
    : Array.isArray(source.input_modalities)
      ? source.input_modalities
      : source.architecture?.input_modalities
  const inputModalities = Array.isArray(modalities) && modalities.length > 0 ? modalities.filter((item) => typeof item === 'string') : ['text']
  const efforts = (Array.isArray(source.efforts) ? source.efforts : [])
    .map((item) => (typeof item === 'string' ? { id: item, name: item } : item?.id ? { id: item.id, name: item.name ?? item.id } : undefined))
    .filter(Boolean)
  return {
    provider,
    id,
    name: name ?? id,
    context: { contextWindow },
    defaultMaxTokens: maxOutput,
    toolUpdate: 'in-history',
    inputModalities,
    ...(efforts.length > 0 ? { reasoning: { efforts } } : {}),
  }
}

/** 从若干候选字段里取第一个有限数（支持 `a.b` 形式的浅路径）。 */
function firstNumber(source, keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    const value = key
      .split('.')
      .reduce((current, part) => (current && typeof current === 'object' ? current[part] : undefined), source)
    const number = typeof value === 'string' ? Number(value) : value
    if (typeof number === 'number' && Number.isFinite(number) && number > 0) return number
  }
  return undefined
}

/** 账号记录的统一构造器（登录流与发现两条入口共用）。 */
function recordFromAuth(auth, label, source, externallyOwned) {
  return {
    family: 'generic',
    label: label ?? normaliseBaseUrl(auth.baseUrl) ?? 'generic',
    source,
    externallyOwned,
    auth,
    createdAt: new Date().toISOString(),
  }
}

/** 账号默认显示名：预设名 > 主机名。 */
export function labelFor(auth = {}) {
  const preset = PRESETS.find((item) => normaliseBaseUrl(item.baseUrl) === normaliseBaseUrl(auth.baseUrl))
  if (preset) return auth.apiKeyEnv ? `${preset.label}（${auth.apiKeyEnv}）` : preset.label
  const baseUrl = normaliseBaseUrl(auth.baseUrl)
  try {
    const host = new URL(baseUrl).host
    return auth.apiKeyEnv ? `${host}（${auth.apiKeyEnv}）` : host
  } catch {
    return baseUrl || 'generic'
  }
}

/**
 * 弹一个 baseUrl 输入框，把「用户随手粘的东西」变成合法 URL。
 *
 * 重问而不是抛错：这是个自由文本输入，「粘贴时多带了个空格 / 忘了协议」是常态，
 * 让它变回一句 `TypeError: Invalid URL` 对用户毫无帮助。三次不合法才放弃。
 */
async function askBaseUrl(session) {
  let message = '这个端点的 baseURL 是什么？（例如 https://api.example.com/v1）'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await session.prompt({ kind: 'text', message })
    const baseUrl = normaliseBaseUrl(answer)
    if (baseUrl.length === 0) throw new Error('generic: 没有填写 baseURL，已取消')
    try {
      new URL(baseUrl)
      return baseUrl
    } catch {
      message = `「${answer}」不是一个合法的地址，再来一次（例如 https://api.example.com/v1）：`
    }
  }
  throw new Error('generic: baseURL 连续三次都不合法，已取消')
}

/**
 * 问密钥。
 *
 * 这里有个刻意的偷懒：**不区分「粘贴密钥」和「写变量名」两个问题**，而是用一个问题、
 * 一条写死的规则（全大写下划线 = 变量名）分辨。理由是这样只需要一次输入，
 * 而多问一次「你是要存密钥还是要引环境变量？」是在逼用户先理解我们的内部区别。
 * 规则写进提示语，所以没有猜谜空间。
 */
async function askKey(session, { presetEnv } = {}) {
  const answer = await session.prompt({
    kind: 'secret',
    message: presetEnv
      ? `粘贴 API Key（留空则改用环境变量 ${presetEnv}）：`
      : '粘贴 API Key；也行直接填一个环境变量名（全大写，例如 MY_RELAY_KEY）；两者都留空表示这个端点不需要密钥：',
  })
  const value = typeof answer === 'string' ? answer.trim() : ''
  if (value.length === 0) return presetEnv ? { apiKeyEnv: presetEnv } : {}
  // 密钥原文几乎不可能长成 `MY_RELAY_KEY` 这样（OpenAI 风格都带 `-`、小写、很长），
  // 所以这条规则在真实输入上不会误判。
  return /^[A-Z][A-Z0-9_]{2,}$/.test(value) ? { apiKeyEnv: value } : { apiKey: value }
}

/** 把一组 `{baseUrl, ...凭据}` 定稿成一条账号记录并提交。 */
async function commitEndpoint(session, auth) {
  await session.commit({
    kind: 'grant',
    payload: recordFromAuth(auth, labelFor(auth), 'manual', auth.apiKeyEnv !== undefined),
  })
}

/** `preset`：从内置常用端点里挑一个。 */
async function runPresetLogin(session) {
  const options = [
    ...PRESETS.map((preset, index) => ({ value: String(index), label: `${preset.label} ｜ ${preset.baseUrl}` })),
    { value: 'custom', label: '其它（手动填 baseURL）' },
  ]
  const answer = await session.prompt({ kind: 'select', message: '要接入哪个端点？', options })
  const preset = PRESETS[Number(answer)]
  // 「其它」走到手动路径。这里直接调函数，不递归 `run()`——session 是宿主给的活对象，
  // 复制它再改 `method` 是在赌它没有 getter 和私有字段。
  if (!preset) {
    await runManualLogin(session)
    return
  }
  const auth = { baseUrl: preset.baseUrl, ...(await askKey(session, { presetEnv: preset.env })) }
  await commitEndpoint(session, auth)
}

/** `manual`：自己填 baseURL。 */
async function runManualLogin(session) {
  const baseUrl = await askBaseUrl(session)
  const auth = { baseUrl, ...(await askKey(session)) }
  await commitEndpoint(session, auth)
}

/** @type {import('../families.js').Family} */
export const genericFamily = {
  id: 'generic',
  displayName: '通用 API（自建 / 中转）',
  route: 'acct-generic',
  risk: 'low',

  // 这一族**没有 `discover`**，而且是故意的：它是给「本机没有任何客户端登录态」的服务用的。
  // 扫描环境变量看着聪明，实际会把用户为别的用途设的 key 一股脑变成 provider——
  // 想用环境变量的话，`login` 里选预设或填 baseURL 时回一个变量名即可（只记名字，不记密钥）。

  /** 登录流与工具入口共用同一个构造器，两条入口必须产出逐字节相同的记录。 */
  recordFromAuth,

  // ---------------------------------------------------------------- 登录

  login: {
    methods: [
      { id: 'preset', label: '从常用端点里挑一个' },
      { id: 'manual', label: '手动填 baseURL' },
    ],
    async run(session) {
      if (session.method === 'manual') await runManualLogin(session)
      else await runPresetLogin(session)
    },
  },

  // ---------------------------------------------------------------- 目录

  /**
   * 模型目录 = 声明 ∪ 上游 `/models`（按 `compat.catalog` 决定取哪一边）。
   *
   * 上游目录**挂了不算失败**：自建端点十有八九没有 `/models`，那不是错误，
   * 是这一族要兜的底。真的一边都没有时，错误消息必须告诉用户怎么自救（声明 `models`），
   * 而不是扔一句「空目录」。
   */
  async listModels(ctx, payload, signal) {
    const auth = payload?.auth ?? {}
    const compat = compatOf(auth)
    const declared = declaredModels(auth)
    let live = []
    if (compat.catalog !== 'declared') {
      try {
        const response = await ctx.fetch(endpointOf(auth, compat.modelsPath), { headers: headersOf(auth, compat), signal }, payload?.proxy)
        if (response.ok) live = parseCatalog(await response.json())
      } catch {
        /* 目录接口不可用 ≠ 这一族不可用；下面还有声明兜着 */
      }
    }

    const byId = new Map()
    const primary = compat.catalog === 'live' ? live : declared
    const secondary = compat.catalog === 'live' ? declared : live
    for (const model of primary) byId.set(model.id, model)
    for (const model of secondary) if (!byId.has(model.id)) byId.set(model.id, model)

    const models = [...byId.values()].map((model) => modelInfo(model.id, model.name, model))
    if (models.length > 0) return models

    const error = new Error(
      `generic: ${labelFor(auth)} 既没有可用的 /models，也没有声明任何模型。` +
        '请在账号的 auth.models 里列出至少一个模型 id。',
    )
    error.code = 'INVALID_REQUEST'
    throw error
  },

  resolveModel(provider, model) {
    return modelInfo(model, model, {}, provider)
  },

  // 这一族没有 `quota`：接口形状取决于对端，猜不如不猜（`undefined` = 不显示额度条）。

  // ---------------------------------------------------------------- 调用

  async *stream(ctx, options) {
    const { payload, model, messages, tools, effort, system, maxTokens, signal, replay } = options
    const auth = payload?.auth ?? {}
    const compat = compatOf(auth)
    const declared = declaredModels(auth).find((item) => item.id === model)
    const limit = Math.max(1, Number(maxTokens) || declared?.maxOutput || DEFAULT_MAX_OUTPUT)
    const proxy = payload?.proxy

    if (compat.protocol === 'anthropic') {
      // 身份块去掉、缓存断点剥掉：我们不认识对端，冒充身份与塞未知字段都是在赌。
      const systemBlocks = toAnthropicSystem(system, messages, { identity: '' }).map(
        ({ cache_control: _ignored, ...block }) => block,
      )
      const body = {
        model,
        max_tokens: limit,
        messages: toAnthropicMessages(messages, { cache: false, replay }),
        stream: true,
        ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
        ...(tools?.length ? { tools: toAnthropicTools(tools), tool_choice: { type: 'auto' } } : {}),
      }
      const response = await ctx.fetch(
        endpointOf(auth, compat.messagesPath),
        { method: 'POST', headers: headersOf(auth, compat, { json: true, stream: true }), body: JSON.stringify(body), signal },
        proxy,
      )
      // 200 也可能是网页（Cloudflare 挑战页、登录页、空 body）：先确认它像 API 回复。
      const reply = await assertApiReply(response, { who: 'generic' })
      if (!reply.ok) throw httpError(reply, await reply.text().catch(() => ''), 'generic')
      yield* translateAnthropicStream(reply, {
        signal,
        onDiagnostic: diagnosticReporter(ctx, options.onDiagnostic),
        model,
      })
      return
    }

    const chatMessages = toChatMessages(messages)
    const systemText = toChatSystem(system, messages)
    const body = {
      model,
      messages: systemText.length > 0 ? [{ role: 'system', content: systemText }, ...chatMessages] : chatMessages,
      stream: true,
      ...(compat.streamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(limit > 0 ? { [compat.maxTokensField]: limit } : {}),
      ...(tools?.length ? { tools: toChatTools(tools), tool_choice: 'auto' } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    }
    const response = await ctx.fetch(
      endpointOf(auth, compat.chatPath),
      { method: 'POST', headers: headersOf(auth, compat, { json: true, stream: true }), body: JSON.stringify(body), signal },
      proxy,
      true,
    )
    // 200 也可能是网页（Cloudflare 挑战页、登录页、空 body）：先确认它像 API 回复。
    const reply = await assertApiReply(response, { who: 'generic' })
    if (!reply.ok) throw httpError(reply, await reply.text().catch(() => ''), 'generic')
    yield* translateChatStream(reply, { signal })
  },
}

export { PRESETS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, normaliseUsage, endpointOf as endpointFor }
