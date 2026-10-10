/**
 * Qoder（阿里 Qoder / qodercli）的私有线协议。
 *
 * 这一份 wire 和仓库里别族的都不一样：Qoder **不说** OpenAI 也不说 Anthropic 的方言，
 * 它用的是 qodercli 自己的信封 + 一套叫 COSY 的签名。所以请求构造与流解析都得自己写，
 * 而为了能把字节钉死，这里全部写成**纯函数**——签名里每一个随机量（AES 密钥、请求 id、
 * 时间戳）和 RSA 公钥都从参数进来，不给就现取。
 *
 * 逆向结论的来源：`_dsh_research/research/_part-qoder.md` 与
 * `_dsh_research/raw/src_masknull_dsh-qoder-connect/src/qoder/transport/`。
 * **签名算法上游没有官方文档**（只有结果码有，见 {@link QODER_RESULT_CODES}），
 * 这一份是照逆向实现复刻的，未经本机真机验证（本机没装 Qoder）。
 *
 * 三处**笔记没写、从原始源码里核出来**的坑，都写在各自函数上方：
 * ① `Cosy-Clienttype` 到底该是 5 还是 10；② body 还要过一遍 WAF 自定义编码；
 * ③ 签名路径要剥掉 `/algo` 前缀（这条笔记里有，但很容易连带把 HTTP 路径也剥了）。
 *
 * @module dsh-account-bridge/wire/qoder
 */

import { createCipheriv, createHash, publicEncrypt, randomUUID } from 'node:crypto'
import { readSse } from './sse.js'
import { mergeUsageNonZero } from './usage.js'

// ---------------------------------------------------------------- 常量

/**
 * COSY 签名用的 RSA 公钥（1024-bit PKCS#1）。
 *
 * 硬编码的理由和上游客户端一样：它是**公**钥，不是凭据，泄漏与否不改变安全性；
 * 换密钥意味着上游改了协议，那时这一整份 wire 都要重写。
 * 允许参数覆盖只是为了能用固定输入把签名钉死（当时的定标向量放在 `test/fixtures/`，
 * 随单元测试一起删了；要重建就照 `_dsh_research` 里那份 Python 第二实现复核器做）。
 */
export const COSY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----
`

/** 客户端版本号。它同时出现在 `Cosy-Version` 与签名信封的 `cosyVersion` 里。 */
export const QODER_IDE_VERSION = '1.1.47'
export const QODER_USER_AGENT = `qoder/${QODER_IDE_VERSION}`

/**
 * `Cosy-Clienttype`：**普通客户端标识 `5`**。
 *
 * 笔记里那句「`Cosy-Clienttype` 必须是字符串 `'10'`」是**不准确的**，别照抄：
 * 原始源码把这件事拆成两个常量——`qoderClientType = '5'`（`cosy.ts:21`，所有
 * 签名请求都用它）与 `qoderDesktopClientType = '10'`（`cosy.ts:33`，**只**给
 * 活动/签到那几条 `/sash/...` 路由用）。实测证据（`cosy.ts:22-32` 注释）说的是
 * `/sash/api/v1/me/campaigns` 用 5 回 200+空数组、用 10 才回真数据——那是**活动**
 * 端点的行为，不是 chat / model-list / quota 的行为。
 * 活动我们不接（本插件不做签到），所以这里**不该**出现 `10`：给 chat 发一个桌面
 * 标识是拿没验证过的值去赌一个有静默失败历史的字段。
 * 见 {@link QODER_DESKTOP_CLIENT_TYPE}——**两者不是一回事，别把 `10` 拿来给 chat 用**。
 */
export const QODER_CLIENT_TYPE = '5'
/** 桌面标识，**只**用于 `/sash/...` 活动端点；本族不发起那些请求，故仅作记录。 */
export const QODER_DESKTOP_CLIENT_TYPE = '10'
export const QODER_DATA_POLICY = 'disagree'
export const QODER_LOGIN_VERSION = 'v2'
export const QODER_MACHINE_TYPE = '5'
export const QODER_CLIENT_IP = '127.0.0.1'
/** `openApiUrl` 上那几条 JSON 请求自己声明的 cosy 版本，与 {@link QODER_IDE_VERSION} 不同。 */
export const QODER_OPENAPI_COSY_VERSION = '1.0.1'
/** 模型目录/远端没给 context window 时的兜底。 */
export const DEFAULT_CONTEXT_WINDOW = 180_000
export const DEFAULT_MAX_TOKENS = 32_768

/** 区域 → 端点。两个区域的令牌**永不互串**，所以 region 是凭据的一部分。 */
export const REGIONS = ['china', 'global']

export const ENDPOINTS = {
  global: {
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
  },
  china: {
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
  },
}

/** 区域归一化：认不出来的一律当国内（阿里的主场）。 */
export function normalizeRegion(value) {
  return value === 'global' ? 'global' : 'china'
}

export function regionEndpoints(region) {
  return ENDPOINTS[normalizeRegion(region)]
}

/**
 * PAT → jobToken 的兑换端点。
 *
 * 每次使用都要换一只**24 小时有效**的 jobToken，而且**新兑换会让旧的退役**，
 * 所以这一族的 `refresh` 不是可选项（见 `families/qoder.js`）。
 */
export function exchangeUrl(region) {
  return `${regionEndpoints(region).openApiUrl}/api/v1/jobToken/exchange`
}

export function userInfoUrl(region) {
  return `${regionEndpoints(region).openApiUrl}/api/v1/userinfo`
}

export function quotaUrl(region) {
  return `${regionEndpoints(region).openApiUrl}/api/v2/quota/usage`
}

/** 模型目录。注意 `Encode=1`：它和 body 的 WAF 编码不是一回事（那个是请求侧的）。 */
export function modelListUrl(region) {
  return `${regionEndpoints(region).baseUrl}algo/api/v2/model/list?Encode=1`
}

/**
 * 对话 SSE 端点。
 *
 * HTTP 路径带 `/algo`，**签名路径不带**——这是最容易写错的一处：
 * 抄整条 pathname 去签名会得到一个上游永远拒的签名（`computeSigPath`）。
 */
export function chatUrl(region) {
  return `${regionEndpoints(region).baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation`
    + '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
}

// ---------------------------------------------------------------- 工具

function md5Hex(input) {
  return createHash('md5').update(input).digest('hex')
}

function utf8Bytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8')
}

/**
 * 从 URL 里取出**用于签名**的路径：pathname，且剥掉开头的 `/algo`。
 *
 * `query` 不参与签名；`/algo` 只存在于 HTTP URL 上（上游网关自己加的），
 * 签名要用的是剥掉之后的那一段。
 */
export function computeSigPath(urlStr) {
  const pathname = new URL(urlStr).pathname
  return pathname.startsWith('/algo') ? pathname.slice('/algo'.length) : pathname
}

/** `x86_64_windows` 这类标识；认不出的平台按 linux 报（上游只认这两个）。 */
export function machineOs(platform = process.platform, arch = process.arch) {
  const windows = platform === 'win32'
  const arm = arch === 'arm64'
  if (windows) return arm ? 'aarch64_windows' : 'x86_64_windows'
  return arm ? 'aarch64_linux' : 'x86_64_linux'
}

// ---------------------------------------------------------------- WAF body 编码

/**
 * Qoder WAF 要求的 body 编码：**先 base64，再把 base64 重排 + 换字母表**。
 *
 * 这一条**笔记里完全没有**（笔记只写了 URL 上那个 `Encode=1` 查询参数，那是另一回事），
 * 是从 `wire/encoding.ts:18-49` 抓出来的。算法本身很怪，逐字复刻：
 *
 * 1. `std = base64utf8(body)`，长度 `n`；
 * 2. `a = floor(n / 3)`，重排为 `std[n-a:] + std[a:n-a] + std[:a]`；
 * 3. 按 `qoderStdAlphabet → qoderCustomAlphabet` 逐字节换表，`=` 换成 `$`；
 * 4. 输出是 **latin1 字符串**——它不是 base64，别想解开。
 *
 * 漏掉这一步的后果是**请求被 WAF 拒**（不是静默改行为），所以能测出来；
 * 但在真机上才知道，所以必须按源码逐字复刻而不是"看起来差不多就行"。
 */
const QODER_CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 字节翻译表：非 base64 字母的字节原样通过。 */
const ENCODE_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let index = 0; index < 256; index += 1) table[index] = index
  for (let index = 0; index < QODER_STD_ALPHABET.length; index += 1) {
    table[QODER_STD_ALPHABET.charCodeAt(index)] = QODER_CUSTOM_ALPHABET.charCodeAt(index)
  }
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  return table
})()

/** 把一段明文（或已编码的 body）变成上游要的 WAF 形。 */
export function encodeQoderBody(plaintext) {
  const std = utf8Bytes(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  const source = Buffer.from(rearranged, 'latin1')
  const target = Buffer.allocUnsafe(n)
  for (let index = 0; index < n; index += 1) {
    target[index] = ENCODE_TABLE[source[index]] ?? 0
  }
  return target.toString('latin1')
}

// ---------------------------------------------------------------- COSY 签名

/**
 * `openApiUrl` 上那几条请求（兑换/身份/额度）用的基础头。
 *
 * 它们**不签名**——上游对这几条只要求身份头。`accept-encoding: identity` 是必须的：
 * 桌面宿主不代解压，压缩体会以二进制噪声进 JSON 解析器。
 */
export function openApiHeaders(region) {
  return {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': QODER_USER_AGENT,
    'cosy-version': QODER_OPENAPI_COSY_VERSION,
    'cosy-clienttype': QODER_CLIENT_TYPE,
  }
}

/**
 * 生成一整套 COSY 签名头。**纯函数**：所有随机量与时间戳都可注入，
 * 不给才现取（`crypto.randomUUID` / `Date.now`）。
 *
 * 算法（`cosy.ts:95-169`，逐字复刻）：
 * - `aesKey` = 16 个十六进制字符（uuid 去掉 `-` 后取前 16）；
 * - `info` = AES-128-CBC(key=aesKey, **iv=aesKey**) 加密
 *   `{uid, security_oauth_token, name, aid:'', email}` 的 base64；
 * - `cosyKey` = RSA-PKCS1(aesKey) 的 base64；
 * - `payloadB64` = base64(`{version:'v1', requestId, info, cosyVersion, ideVersion:''}`)；
 * - `sigInput` = `payloadB64 \n cosyKey \n timestamp \n bodyStr \n sigPath`，取 md5 hex；
 * - `Authorization: Bearer COSY.<payloadB64>.<sig>`。
 *
 * 注意签名/哈希里的 `bodyStr` 是**已经过 WAF 编码的那一份**——
 * 调用方必须先 {@link encodeQoderBody} 再签名（顺序错了签名就不匹配）。
 *
 * **`random.cosyKey` 是可注入的，这不是为了测试才留的后门**：签名输入里含有
 * `cosyKey`，而 RSA-PKCS1v1.5 **加密自带随机填充**——同一个公钥加密同一个
 * `aesKey`，两次得到的密文不同，于是 `Authorization` 也不同。也就是说
 * "固定输入 → 固定输出"这条性质**对整条签名只在 cosyKey 给定时才成立**。
 * 注入它以后，签名就是纯粹确定的，跨语言（Python/cryptography）也能复核同一串
 * 字节；不注入时走真实加密，线上行为不变。
 *
 * @param {object} input
 * @param {Buffer|string} input.body 已编码的请求体（GET 传 `null`）
 * @param {string} input.url 真实请求 URL（签名路径由它推导）
 * @param {{userID: string, authToken: string, name?: string, email?: string, machineID?: string}} input.credentials
 * @param {string} [input.publicKey] 覆盖 COSY 公钥（默认 {@link COSY_PUBLIC_KEY}）
 * @param {object} [input.random] 注入随机量/时间，仅供定标与排障使用
 * @param {string} [input.random.cosyKey] 注入已加密的 aesKey（让签名完全确定）
 * @returns {Record<string, string>}
 */
export function buildCosyHeaders(input) {
  const { body = null, url, credentials } = input ?? {}
  const random = input?.random ?? {}
  const userID = credentials?.userID
  const authToken = credentials?.authToken
  if (typeof userID !== 'string' || userID.length === 0) throw new Error('qoder: COSY needs a non-empty user id')
  if (typeof authToken !== 'string' || authToken.length === 0) throw new Error('qoder: COSY needs a non-empty auth token')

  const aesKey = random.aesKey ?? randomUUID().replace(/-/g, '').slice(0, 16)
  const requestId = random.requestId ?? randomUUID()
  const xRequestId = random.xRequestId ?? randomUUID()
  const timestamp = String(random.timestamp ?? Math.floor(Date.now() / 1000))

  const userInfo = JSON.stringify({
    uid: userID,
    security_oauth_token: authToken,
    name: credentials.name || '',
    aid: '',
    email: credentials.email || '',
  })

  const cipher = createCipheriv('aes-128-cbc', Buffer.from(aesKey), Buffer.from(aesKey))
  const infoB64 = Buffer.concat([cipher.update(userInfo, 'utf8'), cipher.final()]).toString('base64')

  const publicKey = input.publicKey ?? COSY_PUBLIC_KEY
  const cosyKey = random.cosyKey ?? publicEncrypt(
    { key: publicKey, padding: 1 /* RSA_PKCS1_PADDING */ },
    Buffer.from(aesKey),
  ).toString('base64')

  const payloadB64 = Buffer.from(JSON.stringify({
    version: 'v1',
    requestId,
    info: infoB64,
    cosyVersion: QODER_IDE_VERSION,
    ideVersion: '',
  })).toString('base64')

  const sigPath = computeSigPath(url)
  const bodyBytes = body === null || body === undefined ? Buffer.alloc(0) : utf8Bytes(body)
  const bodyStr = bodyBytes.toString('utf8')
  const sig = md5Hex(`${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`)

  const machineID = credentials.machineID || random.machineID || randomUUID()

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': QODER_IDE_VERSION,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': QODER_MACHINE_TYPE,
    'Cosy-Machineos': machineOs(),
    'Cosy-Clienttype': QODER_CLIENT_TYPE,
    'Cosy-Clientip': QODER_CLIENT_IP,
    'Cosy-Bodyhash': md5Hex(bodyBytes),
    'Cosy-Bodylength': String(bodyBytes.length),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': QODER_DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': QODER_LOGIN_VERSION,
    'X-Request-Id': xRequestId,
  }
}

// ---------------------------------------------------------------- 请求信封

/**
 * 把 DSH 的消息形状翻成 qodercli 的 `messages`。
 *
 * 与 `wire/chat-completions.js` 的差别只有三处，都是上游形状逼出来的：
 * - assistant 的纯文本内容**不能为空串**（空串会被拒），统一写 `' '`；
 * - 思考内容走 `reasoning_content` 字段，不拼进正文；
 * - 工具结果消息是 `{role:'tool', tool_call_id, content}`，**平铺**，不套 `tool` 块。
 *
 * 图片**不转发**：上游要先把图上传到 center 拿一个对象地址（`image-upload.ts`），
 * 这一步本族没实现，所以带图的消息会被降级成文本（图片块被丢弃）。
 * 这是有意的诚实降级：不声明多模态、不编一个本地路径当 URL。
 */
export function toQoderMessages(messages = []) {
  const out = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const role = message.role
    if (role === 'system') continue // system 由调用方经 `system` 参数单独传
    const parts = Array.isArray(message.content) ? message.content : undefined

    if (role === 'tool') {
      const text = parts
        ? parts.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
        : typeof message.content === 'string' ? message.content : ''
      out.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId ?? message.tool_call_id ?? ''),
        content: text,
      })
      continue
    }

    if (role === 'assistant') {
      const text = parts
        ? parts.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
        : typeof message.content === 'string' ? message.content : ''
      const reasoning = parts
        ? parts.filter((part) => part?.type === 'reasoning').map((part) => part.text ?? '').join('')
        : ''
      const toolCalls = (Array.isArray(message.toolCalls) ? message.toolCalls : []).map((call) => ({
        id: String(call?.id ?? ''),
        type: 'function',
        function: {
          name: String(call?.name ?? ''),
          arguments: typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.arguments ?? {}),
        },
      }))
      if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue
      out.push({
        role: 'assistant',
        content: text || ' ',
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      })
      continue
    }

    const text = parts
      ? parts.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
      : typeof message.content === 'string' ? message.content : ''
    out.push({ role: 'user', content: text })
  }
  return out
}

/** DSH 的工具声明 → 上游的 `{type:'function', function:{...}}`。 */
export function toQoderTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => typeof tool?.name === 'string' && tool.name.length > 0)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }))
    .sort((left, right) => left.function.name.localeCompare(right.function.name))
}

/** system 提示词：`system` 参数优先，其次把 messages 里的 system 拼起来。 */
export function toQoderSystem(system, messages = []) {
  if (typeof system === 'string' && system.length > 0) return system
  const parts = []
  for (const message of messages) {
    if (message?.role !== 'system') continue
    if (typeof message.content === 'string') parts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const part of message.content) if (part?.type === 'text') parts.push(part.text ?? '')
    }
  }
  return parts.join('\n\n')
}

/** 会话 id 的稳定前缀（相同账号 + 模型得同一个前缀，`session_id` 才是可关联的）。 */
export function stableSessionPrefix(userID, modelKey) {
  return createHash('sha256').update(`qoder-session\u0000${userID}\u0000${modelKey}`).digest('hex').slice(0, 16)
}

/**
 * 构造对话请求体（qodercli 信封）。
 *
 * 字段名与顺序都照 `serialize.ts` 复刻——上游对这些字段是"照着抄"式的宽容，
 * 但缺字段的行为**未知**，所以不省。`messages` 里的空字符串内容会被上游拒，
 * 由 {@link toQoderMessages} 保证。
 *
 * @param {object} input
 * @param {string} input.model 模型 key（`model_config.key`）
 * @param {Array} input.messages 已翻译的消息
 * @param {Array} [input.tools] 已翻译的工具
 * @param {string} [input.system]
 * @param {number} [input.maxTokens]
 * @param {string} [input.effort] 思考档位
 * @param {boolean} [input.isReasoning] 该模型是否思考型
 * @param {string} [input.userID]
 * @param {string} [input.requestId]
 * @param {string} [input.sessionId]
 * @param {string} [input.beginAt] ISO 时间
 */
export function buildQoderBody(input) {
  const {
    model, messages = [], tools = [], system, maxTokens, effort, isReasoning,
    userID = '', requestId, sessionId, beginAt,
  } = input ?? {}
  const limit = Math.max(1_024, Math.min(Number(maxTokens) || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS))
  const reasoning = Boolean(isReasoning) || (typeof effort === 'string' && effort.length > 0)
  const lastUser = [...messages].reverse().find((message) => message?.role === 'user')
  const title = (typeof lastUser?.content === 'string' ? lastUser.content : '').slice(0, 30)

  return {
    request_id: requestId ?? randomUUID(),
    request_set_id: requestId ?? randomUUID(),
    chat_record_id: createHash('sha256')
      .update(JSON.stringify([model, messages, tools, limit]))
      .digest('hex')
      .slice(0, 16),
    session_id: `${stableSessionPrefix(userID, model)}-${sessionId ?? randomUUID()}`,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: system ?? '',
    messages,
    tools,
    parameters: {
      max_tokens: limit,
      ...(typeof effort === 'string' && effort.length > 0 ? { reasoning_effort: effort } : {}),
    },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: model, is_reasoning: reasoning },
        originalContent: '',
      },
      features: [],
      text: '',
    },
    model_config: {
      key: model,
      is_reasoning: reasoning,
      max_output_tokens: limit,
      source: input?.source ?? 'system',
    },
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: '',
      name: title,
      begin_at: beginAt ?? new Date().toISOString(),
    },
  }
}

// ---------------------------------------------------------------- 模型目录

/** `thinking_config.enabled.efforts` → `[{id,name}]`；认不出的形状一律不声明。 */
function effortsOf(entry) {
  const raw = entry?.thinking_config?.enabled?.efforts
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) out.push({ id: item, name: item })
    else if (typeof item?.id === 'string' && item.id.length > 0) out.push({ id: item.id, name: item.name ?? item.id })
  }
  return out
}

/**
 * 上游 `/algo/api/v2/model/list` → 统一的模型条目。
 *
 * 只收 `enable === true` 的；`key` 是模型 id（请求里 `model_config.key` 用它）。
 * context window 三级回退：唯一 `is_default` 的 `context_config.token_count`
 * → `max_input_tokens` → `undefined`（交给保守默认值，**不编**）。
 */
export function normalizeQoderModels(payload) {
  const list = Array.isArray(payload?.assistant) ? payload.assistant : []
  const out = []
  for (const entry of list) {
    if (entry?.enable !== true) continue
    const id = entry.key ?? entry.model ?? entry.id
    if (typeof id !== 'string' || id.length === 0) continue
    const contexts = Array.isArray(entry.context_config) ? entry.context_config : []
    const preferred = contexts.filter((item) => item?.is_default === true)
    const defaultContext = (preferred.length === 1 ? preferred[0] : undefined)?.token_count
    const supportsImages = entry.is_vl === true
    const efforts = effortsOf(entry)
    out.push({
      id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
      contextWindow: Number.isFinite(defaultContext)
        ? defaultContext
        : Number.isFinite(entry.max_input_tokens) ? entry.max_input_tokens : undefined,
      maxTokens: Number.isFinite(entry.max_output_tokens) ? entry.max_output_tokens : DEFAULT_MAX_TOKENS,
      inputModalities: supportsImages ? ['text', 'image'] : ['text'],
      isReasoning: entry?.thinking_config?.default_value === true || entry.is_reasoning === true,
      efforts,
      source: typeof entry.source === 'string' && entry.source.length > 0 ? entry.source : 'system',
    })
  }
  return out
}

/**
 * 目录不可用时的**保守兜底**。
 *
 * 这是「快照」不是「发现」：上游目录接口是真接口，正常路径下都会用它；
 * 这里只在目录请求失败时兜住，让用户至少能发一个请求。
 * 6 条 key 来自上游客户端的默认档位（`catalog.ts` 的 `defaultModels`）。
 */
export const FALLBACK_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 180_000, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ['text', 'image'], isReasoning: false, efforts: [], source: 'system' },
  { id: 'ultimate', name: 'Ultimate', contextWindow: 1_000_000, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ['text', 'image'], isReasoning: true, efforts: [], source: 'system' },
  { id: 'performance', name: 'Performance', contextWindow: 1_000_000, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ['text', 'image'], isReasoning: false, efforts: [], source: 'system' },
  { id: 'efficient', name: 'Efficient', contextWindow: 180_000, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ['text', 'image'], isReasoning: false, efforts: [], source: 'system' },
  { id: 'lite', name: 'Lite', contextWindow: 180_000, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ['text'], isReasoning: false, efforts: [], source: 'system' },
  { id: 'cmodel', name: 'Cantus (Qoder)', contextWindow: 1_000_000, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: ['text', 'image'], isReasoning: false, efforts: [], source: 'system' },
]

// ---------------------------------------------------------------- 额度

/** 三种资源包在响应里的字段名（顺序＝面板展示顺序，用户额度在前）。 */
const QUOTA_BUCKETS = [
  ['userQuota', '个人额度'],
  ['orgResourcePackage', '组织资源包'],
  ['addOnQuota', '赠送额度'],
]

/** 单个资源包 → `{total, used, remaining}`；三个都读不到就 undefined（不编 0）。 */
function normalizeBucket(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const used = number(raw.used)
  const remaining = number(raw.remaining)
  let total = number(raw.total) ?? number(raw.cap)
  if (total === undefined && used !== undefined && remaining !== undefined) total = used + remaining
  if (total === undefined || total <= 0) return undefined
  return { total, used: used ?? Math.max(0, total - (remaining ?? total)), remaining: remaining ?? Math.max(0, total - (used ?? 0)) }
}

/**
 * `/api/v2/quota/usage` → DSH 的额度桶。
 *
 * **读不到就 `undefined`**（面板不显示），绝不编一个 0%：
 * 报一个假的"额度充足"比什么都不报更糟。
 * `percentage` 的上游单位不一致（0-1 与 0-100 都出现过），
 * 只在 `<=1 且 total>1` 时才乘 100——这条照 `account-reader.ts:70-72`。
 */
export function parseQoderQuota(payload) {
  const source = payload?.data ?? payload
  if (!source || typeof source !== 'object') return undefined
  const out = []
  for (const [field, name] of QUOTA_BUCKETS) {
    const bucket = normalizeBucket(source[field])
    if (!bucket) continue
    const raw = source[field]
    let percentage = typeof raw.percentage === 'number' && Number.isFinite(raw.percentage)
      ? raw.percentage
      : (bucket.used / bucket.total) * 100
    if (raw.percentage <= 1 && bucket.total > 1) percentage *= 100
    out.push({
      id: field,
      name,
      remainingFraction: Math.max(0, Math.min(1, (100 - percentage) / 100)),
      unit: typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : 'credits',
      total: bucket.total,
      remaining: bucket.remaining,
    })
  }
  return out.length > 0 ? out : undefined
}

// ---------------------------------------------------------------- 失败归类

/**
 * 上游结果码表里**会改变路由**的那几条（`codes.ts`，有官方文档背书）。
 *
 * 只有 quota 与 auth 两类在这里；其余码按 HTTP 状态走就够了，
 * 猜一个没见过的码比让它按状态码兜底更糟。
 */
export const QODER_RESULT_CODES = Object.freeze({
  105: { family: 'auth', name: 'Login or access token expired' },
  110: { family: 'quota', name: 'Daily usage limit reached' },
  113: { family: 'quota', name: 'Usage quota exhausted' },
  114: { family: 'quota', name: 'Free-trial account limit reached' },
  115: { family: 'quota', name: 'Free-user quota reached' },
  116: { family: 'quota', name: 'Team administrator Credits exhausted' },
  117: { family: 'quota', name: 'Team member Credits exhausted' },
  118: { family: 'quota', name: 'Personal Credits exhausted' },
  119: { family: 'quota', name: 'Free usage limit for the selected model reached' },
  122: { family: 'quota', name: 'Billing-group Credits limit reached' },
  80411: { family: 'context', name: 'Input content is too long' },
})

/** 上游把结果码写在 `code`（可能嵌在转义的 JSON 里），只认引号包着的那个。 */
export function qoderResultCode(body) {
  if (typeof body !== 'string' || body.length === 0) return undefined
  for (const match of body.replace(/\\/g, '').matchAll(/"(?:error_)?code"\s*:\s*"?(\d+)"?/g)) {
    const entry = QODER_RESULT_CODES[Number(match[1])]
    if (entry) return { code: Number(match[1]), ...entry }
  }
  return undefined
}

/** 排队的标记（实测 2026-09-26：401/403 也可能是排队，不是死令牌）。 */
const QUEUE_MARKERS = /"code"\s*:\s*"?10605"?|"isQueued"\s*:\s*true|"queueCount"|"serviceAvailable"\s*:\s*false/

/** `retryAfterSeconds` → 毫秒，用于把排队的退避时长带出去。 */
export function queueRetryAfterMs(body) {
  if (typeof body !== 'string' || body.length === 0) return undefined
  const text = body.replace(/\\/g, '')
  if (!QUEUE_MARKERS.test(text)) return undefined
  const match = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(text)
  return match ? Number(match[1]) * 1000 : undefined
}

/**
 * 把一个响应归类成 DSH 的中立失败码。
 *
 * 本仓的 `wire/http-error.js::mapStatus` 解决 95% 的情况，剩下的 5% 是 Qoder 的私货：
 *
 * - **401/403 + 排队标记**：上游用鉴权状态码宣布"模型队列满了"。按 AUTH 处理会
 *   把一只好令牌清掉并让用户重新登录，而真正该做的是等 30 秒。
 * - **403 + 文档码 `110`（每日计数超限）**：同样不是死令牌，是明天会自己好的额度。
 * - **`80411`（输入过长）**：无论状态码都归 `CONTEXT_WINDOW_EXCEEDED`。
 *
 * 判定顺序与 `mapStatus` 一致：状态码先，然后文档码，最后排队的文本标记。
 * 引用了什么码就把它带在 `failure.qoderCode` 上——错误消息里给用户看得到原因，
 * 但那种 401/403 的**数字不进错误文本**（宿主上层的文本分类器会把 401/403
 * 直接读成"密钥无效"，把真正的原因盖掉）。
 */
export function classifyQoderFailure(response, text) {
  const status = Number(response?.status) || 0
  const detail = typeof text === 'string' ? text : ''
  const lower = detail.toLowerCase()
  const documented = qoderResultCode(detail)

  // 上游的"文档码 / 排队退避"必须**直接带在抛出的错误上**，不能先写进
  // WeakMap<response, extra> 再等 qoderHttpError 合并：流解析里派生错误时用的是
  // **合成 response 对象**（信封内 statusCodeValue !== 200），那份 WeakMap 的 key
  // 和调用方读错误的地方根本不是同一个对象，附加字段就悄悄丢了。
  const finish = (code, extra) => {
    const error = new Error(`qoder: HTTP ${status} ${detail.slice(0, 300)}`)
    error.code = code
    error.failure = { status, code, ...extra }
    return error
  }

  const queue = status === 401 || status === 403 || status === 429 ? queueRetryAfterMs(detail) : undefined
  if (status === 401 || status === 403) {
    if (QUEUE_MARKERS.test(detail.replace(/\\/g, ''))) {
      return finish('RATE_LIMIT', { qoderCode: 10605, ...(queue === undefined ? {} : { providerRetryAfterMs: queue }) })
    }
    if (documented?.family === 'quota') return finish('QUOTA', { qoderCode: documented.code })
    if (documented?.family === 'context') return finish('CONTEXT_WINDOW_EXCEEDED', { qoderCode: documented.code })
    return finish('AUTH')
  }
  if (/invalid_grant|invalid_token|invalid_client|unauthorized_client|invalid_scope/.test(lower)) {
    return finish('AUTH')
  }
  if (documented?.family === 'auth') return finish('AUTH', { qoderCode: documented.code })
  if (status === 402 || documented?.family === 'quota') {
    return finish('ACCOUNT_QUOTA', documented?.family === 'quota' ? { qoderCode: documented.code } : undefined)
  }
  if (status === 429) {
    return finish(lower.includes('quota') || lower.includes('usage limit') || lower.includes('extra usage') ? 'QUOTA' : 'RATE_LIMIT')
  }
  if (documented?.family === 'context') return finish('CONTEXT_WINDOW_EXCEEDED', { qoderCode: documented.code })
  if (status === 400 && lower.includes('context')) return finish('CONTEXT_WINDOW_EXCEEDED')
  if (status === 408 || status === 504) return finish('TIMEOUT')
  return finish('SERVER')
}

/** 上游响应 → 可直接抛的错误。是本族唯一允许构造失败的地方。 */
export function qoderHttpError(response, text) {
  const error = classifyQoderFailure(response, text)
  const retryAfterHeader = Number(response?.headers?.get?.('retry-after'))
  if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 && error.failure.providerRetryAfterMs === undefined) {
    error.failure = { ...error.failure, providerRetryAfterMs: retryAfterHeader * 1000 }
  }
  return error
}

// ---------------------------------------------------------------- 流解析

/** 结束原因：本仓契约只认这三个（见 docs/family-contract.md §5.2）。 */
function finishKindOf(value) {
  if (value === 'length') return 'max-tokens'
  if (value === 'tool_calls' || value === 'toolUse') return 'tool-calls'
  return 'stop'
}

/** 上游 usage → DSH 的用量形状（字段名与 `wire/chat-completions.js` 对齐）。 */
export function normalizeQoderUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const out = {}
  const input = number(usage.prompt_tokens)
  if (input !== undefined) out.inputTokens = input
  const output = number(usage.completion_tokens)
  if (output !== undefined) out.outputTokens = output
  const cached = number(usage.prompt_tokens_details?.cached_tokens)
  if (cached !== undefined) out.cachedInputTokens = cached
  const written = number(usage.prompt_tokens_details?.cache_write_tokens)
  if (written !== undefined) out.cacheCreationInputTokens = written
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 解析一帧外层信封。
 *
 * 上游把内层模型 JSON **再嵌一层**：`data: {"statusCodeValue":200,"body":"{\"choices\":[…]}"}`，
 * 所以这里要解两次。`statusCodeValue !== 200` 时**错误消息必须带上 `body`**：
 * 被拒的对话是"HTTP 200 的 SSE，第一帧里写失败原因"，丢了 body 就只剩
 * 一句"invalid API key"，真正的原因（排队 / 额度 / 风控）永远看不到。
 *
 * `[DONE]` 有两种写法：整帧就是 `data: [DONE]`（裸的，不是 JSON——直接
 * `JSON.parse` 会抛），以及正常信封里 `body === '[DONE]'`。两种都要认。
 */
export function parseQoderEnvelope(data) {
  const raw = typeof data === 'string' ? data.trim() : ''
  if (raw === '[DONE]') return { done: true }
  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    return { malformed: `qoder: malformed SSE envelope: ${raw.slice(0, 120)}` }
  }
  if (!envelope || typeof envelope !== 'object') return { malformed: 'qoder: SSE envelope is not an object' }
  const status = envelope.statusCodeValue
  if (typeof status === 'number' && status !== 200) {
    return {
      status,
      body: typeof envelope.body === 'string' ? envelope.body : '',
      error: `qoder: upstream refused the request with status ${status}`
        + (typeof envelope.body === 'string' && envelope.body.length > 0 ? `: ${envelope.body.slice(0, 300)}` : ''),
    }
  }
  const body = typeof envelope.body === 'string' ? envelope.body.trim() : ''
  if (body.length === 0) return { empty: true }
  if (body === '[DONE]') return { done: true }
  try {
    return { inner: JSON.parse(body) }
  } catch {
    return { malformed: `qoder: malformed inner payload: ${body.slice(0, 120)}` }
  }
}

/**
 * 上游 SSE → 契约 §5 的 chunk 序列。
 *
 * 与上游实现（`wire/sse.ts`）的**有意差异**：空回答这里**抛** `EMPTY_RESPONSE`，
 * 而不是 yield 一个 `finish{reason:{kind:'error'}}`——本仓契约 §5.2 要求抛错，
 * 池子才好在"一个字都没吐"时换号（`pool.js:386-391`）。
 *
 * 工具调用按上游的 `index` 聚合成一个块：参数是分片到的，块要等收尾才 `block-end`。
 */
export async function* translateQoderStream(response, options = {}) {
  const { signal } = options
  const toolCalls = new Map()
  let nextIndex = 0
  let active = null
  let usage
  let terminal = 'stop'
  let produced = false
  let sawDone = false

  const closeActive = () => {
    if (!active) return undefined
    const state = active
    active = null
    return { type: 'block-end', index: state.index, block: { type: state.type, text: state.text } }
  }

  const openToolCall = (slot, index) => {
    if (slot.blockIndex === undefined) slot.blockIndex = index
    return slot.blockIndex
  }

  for await (const event of readSse(response, { signal })) {
    const data = event?.data
    if (typeof data !== 'string' || data.trim().length === 0) continue
    const frame = parseQoderEnvelope(data.trim())

    if (frame.done) {
      sawDone = true
      break
    }
    if (frame.error) {
      const error = new Error(frame.error)
      // 信封里的状态码是上游自己的：401/403 的排队与额度要靠 body 才分得清。
      const synthetic = {
        status: typeof frame.status === 'number' ? frame.status : 502,
        headers: { get: () => null },
      }
      const classified = classifyQoderFailure(synthetic, frame.body ?? '')
      error.code = classified.code
      error.failure = classified.failure
      throw error
    }
    if (frame.malformed) {
      const error = new Error(frame.malformed)
      error.code = 'MALFORMED_RESPONSE'
      throw error
    }
    if (frame.empty || !frame.inner) continue

    const inner = frame.inner
    usage = mergeUsageNonZero(usage, normalizeQoderUsage(inner.usage))

    for (const choice of Array.isArray(inner.choices) ? inner.choices : []) {
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
        terminal = finishKindOf(choice.finish_reason)
      }
      const delta = choice?.delta
      if (!delta) continue

      const segments = [
        ['reasoning', typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''],
        ['text', typeof delta.content === 'string' ? delta.content : ''],
      ]
      for (const [type, text] of segments) {
        if (text.length === 0) continue
        if (active?.type !== type) {
          const ended = closeActive()
          if (ended) yield ended
          active = { type, index: nextIndex, text: '' }
          nextIndex += 1
          produced = true
          yield { type: 'block-start', index: active.index, blockType: type }
        }
        active.text += text
        yield type === 'text'
          ? { type: 'text-delta', index: active.index, text }
          : { type: 'reasoning-delta', index: active.index, text }
      }

      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const key = Number.isInteger(call?.index) ? call.index : 0
        let slot = toolCalls.get(key)
        if (!slot) {
          slot = { id: '', name: '', arguments: '', blockIndex: undefined }
          toolCalls.set(key, slot)
        }
        // 上游在参数分片里会把 id / name 发成空串或 null：只在非空时采纳，
        // 且采纳过的值不允许多次出现不同的（出现了说明流本身乱序，宁可报错）。
        if (typeof call?.id === 'string' && call.id.length > 0) {
          if (slot.id.length > 0 && slot.id !== call.id) {
            const error = new Error('qoder: the stream changed a tool call id midway')
            error.code = 'MALFORMED_RESPONSE'
            throw error
          }
          slot.id = call.id
        }
        const name = call?.function?.name
        if (typeof name === 'string' && name.length > 0) {
          if (slot.name.length > 0 && slot.name !== name) {
            const error = new Error('qoder: the stream changed a tool call name midway')
            error.code = 'MALFORMED_RESPONSE'
            throw error
          }
          slot.name = name
        }
        const args = call?.function?.arguments
        if (typeof args === 'string') slot.arguments += args

        if (slot.id.length === 0 || slot.blockIndex !== undefined) continue
        // 第一片带 id：开块并把已有的参数一起吐出去。
        const ended = closeActive()
        if (ended) yield ended
        openToolCall(slot, nextIndex)
        nextIndex += 1
        produced = true
        yield { type: 'block-start', index: slot.blockIndex, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: slot.blockIndex,
          id: slot.id,
          ...(slot.name.length > 0 ? { name: slot.name } : {}),
          argumentsDelta: slot.arguments,
        }
        slot.emitted = slot.arguments.length
      }
    }
  }

  const endedText = closeActive()
  if (endedText) yield endedText

  for (const [, slot] of [...toolCalls].sort(([left], [right]) => left - right)) {
    if (slot.id.length === 0) {
      const error = new Error('qoder: the stream ended with a tool call that has no id')
      error.code = 'MALFORMED_RESPONSE'
      throw error
    }
    const args = slot.arguments.trim().length > 0 ? slot.arguments : '{}'
    if (slot.blockIndex === undefined) {
      // 参数到了但从没见过 id 的块（上游偶尔把 id 放在最后一片）：这里补开。
      openToolCall(slot, nextIndex)
      nextIndex += 1
      produced = true
      yield { type: 'block-start', index: slot.blockIndex, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: slot.blockIndex,
        id: slot.id,
        ...(slot.name.length > 0 ? { name: slot.name } : {}),
        argumentsDelta: '',
      }
    } else if (slot.arguments.length > (slot.emitted ?? 0)) {
      const delta = slot.arguments.slice(slot.emitted ?? 0)
      slot.emitted = slot.arguments.length
      yield { type: 'tool-call-delta', index: slot.blockIndex, id: slot.id, argumentsDelta: delta }
    }
    if (slot.name.length === 0) {
      const error = new Error('qoder: the stream ended with a tool call that has no name')
      error.code = 'MALFORMED_RESPONSE'
      throw error
    }
    yield {
      type: 'block-end',
      index: slot.blockIndex,
      block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: args },
    }
  }

  if (!produced) {
    const error = new Error('qoder: the response completed without any content block')
    error.code = 'EMPTY_RESPONSE'
    throw error
  }
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: toolCalls.size > 0 ? 'tool-calls' : terminal } }
  // `sawDone` 只影响日志语义：上游偶尔不发 `[DONE]` 就断流，
  // 只要内容完整（有块、有 finish_reason）就当成功——把它升级成 TRANSPORT 会
  // 让一条已经完整回答的流被判失败并换号，代价远大于收益。
  void sawDone
}
