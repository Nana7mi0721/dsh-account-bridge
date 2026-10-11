/**
 * ZCode（Z.AI / 智谱）线协议：端点与凭据形态、官方身份块、模型目录、失败归类。
 *
 * 这一族**整条线都是 Anthropic Messages 方言**（官方 `resources/config/provider/zcode-builtin.json`
 * 里两条 providerRules 的 `api.type` 都是 `anthropic-messages`），所以请求/响应/流式翻译
 * 一律复用 `src/wire/anthropic.js`——这里只放「ZCode 自己的部分」：
 *
 * 1. **两条通道，响应格式完全相同，只有端点与凭据不同**（`zcode-transport.ts:1-40`）：
 *    - `start-plan`（积分制）：`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`，
 *      凭据是 **ZCode JWT**（`zcodejwttoken`）；
 *    - `coding-plan`（订阅制）：`https://api.z.ai/api/anthropic/v1/messages`，
 *      凭据是 **Coding Plan API key**（`id.secret` 两段形态）。
 *    ⚠ 积分制**无论** `zai` 还是 `bigmodel` 渠道都走 `zcode.z.ai`——不要因为"国际版"改域名。
 *
 * 2. **官方身份块是准入开关**（`zcode-identity.ts` 的实测矩阵）：`system` 里没有
 *    `cliPrefix + stable` 这个结构，上游直接回 **HTTP 405 + `{"code":3012}`**，
 *    而且**有冷却惩罚**（第 1 次 30 分钟 → 24h 内第 3 次起 24h → 第 5 次停用）。
 *    ⚠ 状态码是 **405 不是 403**，而 405 在共享的 `mapStatus()` 里会落到 `SERVER`
 *    （换号 + 60 秒冷却），真实语义却是"别重试"——所以这里必须**先**判 3012。
 *
 * 3. **失败词表只有一份**：本模块不自己抄一份 quota/credit 正则，而是把判定委托给
 *    `mapStatus()`（它内部用 `failureWords()`）；只有 ZCode 私有的业务码在这里判。
 *
 * 本模块里的 ZCode 协议事实（两条通道的端点/凭据、身份块、业务码语义、目录字段）
 * 借自另一个中文插件（**借的是证据不是代码**），登记见 THIRD_PARTY_NOTICES.md 的「借用的证据」。
 * @module dsh-account-bridge/wire/zcode
 */

import { failureWords } from './failure-words.js'
import { mapStatus } from './http-error.js'
import { OFFICIAL_IDENTITY, CONTEXT_PREFIX_INTRO, CONTEXT_PREFIX_OUTRO } from './zcode-identity.js'

// ------------------------------------------------------------------ 端点

/** ZCode 自己的源站（`zcode-transport.ts:81`）。`HTTP-Referer` 就是它。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** start-plan（积分制）的模型请求端点。 */
export const ZCODE_START_PLAN_MESSAGES_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`

/** coding-plan（订阅制）的模型请求端点（`zcode-upstream.ts:61-64`）。 */
export const ZCODE_CODING_PLAN_MESSAGES_URL = 'https://api.z.ai/api/anthropic/v1/messages'

/** 模型目录端点（`zcode-upstream.ts` 的 `ZCODE_CLIENT_CONFIGS_URL`）。 */
export const ZCODE_CLIENT_CONFIGS_URL = `${ZCODE_ORIGIN}/api/v1/client/configs`

/** 用量/余额端点。响应里的单位是 **token 不是积分**（`meter: 'model_usage'`）。 */
export const ZCODE_BILLING_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`

/**
 * 兜底版本号（`zcode.ts` 的 `ZCODE_APP_VERSION_FALLBACK`）。
 * 官方注释里同时记着实测的 `3.14.4`——取实测的那个，因为版本头只影响"像不像官方客户端"。
 */
export const ZCODE_APP_VERSION_FALLBACK = '3.14.4'

/**
 * 两条通道**各自**的模型白名单。
 *
 * ⚠ 这是**兜底**，不是权威：真值来自目录响应里每条模型的 `channels` 字段
 * （`channelsForModel()` 优先读它）。留这份常量是因为目录拉取会失败，而
 * `pickChannel()` 在目录不可用时**不能**因此把所有请求都判成"这个模型不存在"。
 *
 * 取值来自 `zcode-transport.ts:52-58`：coding-plan 只列官方 `builtinModelIds`
 * 确认过的两个（远端 models 实测有 11 个，但白名单限制，其余 9 个**未验证**）。
 */
export const CHANNEL_MODELS = {
  'start-plan': ['glm-5.3-flash', 'glm-5.2', 'glm-5-turbo'],
  'coding-plan': ['glm-5.3', 'glm-5.3-flash'],
}

/** `CHANNEL_MODELS` 的键集合，给 `pickChannel()` 做合法性校验。 */
const CHANNELS = Object.freeze(['start-plan', 'coding-plan'])

/** 上下文/输出兜底值（`zcode-upstream.ts:689-752` 的保守值）。**0 会让 DSH 认为无窗口**。 */
const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 32_768

/**
 * 思考档位的规范顺序。
 *
 * 上游的键插入序实测是 `low, max, high`，而 IDE 展示 `low, high, max`——直接透传会让
 * 档位选择器的顺序随机变化（同一个模型两次刷新可能不一样）。所以按这张表重排，
 * 表里没有的档位**按原序追加**（上游加新档位时不能被丢掉）。
 */
const REASONING_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// ------------------------------------------------------------------ 凭据

/** URN 形态（`urn:zai:...`）的编码校验。 */
const URN_RE = /^urn:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/i

/**
 * 凭据是不是**合法**的 URN。
 *
 * 为什么 `rejectUrn: true` 这个选项存在：任务书自己就是一个反例——它把凭据形态写成了
 * `urn:zai:coding-plan-...`，而那是**端点/通道的标识**，不是凭据。用户照着粘进来的
 * 东西必须在**验证阶段**就被挡住，而不是拿它发一次请求、让上游回一个 401 然后把
 * 账号冷 24 小时（`health.js` 的 `COOLDOWN.auth`）。
 */
export function isUsableZcodeCredential(value, { rejectUrn = false } = {}) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length < 16) return false
  // 头/尾不可能有空白或控制字符；有就是复制时带上了别的东西。
  if (trimmed !== value || /[\s\u0000-\u001f]/.test(trimmed)) return false
  if (rejectUrn && URN_RE.test(trimmed)) return false
  // `enc:v1:` 密文：`~/.zcode/v2/credentials.json` 里就长这样，解不开，绝不当凭据用。
  if (trimmed.startsWith('enc:v1:')) return false
  return true
}

/**
 * 凭据形态 → 走哪条通道。
 *
 * 判据是**形态**而不是猜测（`pascalCase` 的 `id.secret` 是 Coding Plan API key）：
 * 两段点分 ⇒ `coding-plan`（端点 `api.z.ai`，要 API key）；其余（JWT / 不透明令牌）
 * ⇒ `start-plan`（端点 `zcode.z.ai`，要 JWT）。
 *
 * 出错的代价**不对称**：把 API key 发去 `zcode.z.ai` 必被拒，把 JWT 发去 `api.z.ai`
 * 同样必被拒——但两者都只吃一次 401，而且 `credentialsForChannel()` 会按形态
 * 先判一次"这条通道根本没有能用的凭据"，于是**根本不会发出去**。
 */
export function credentialShape(value) {
  const token = typeof value === 'string' ? value.trim() : ''
  if (token.length === 0) return undefined
  if (token.startsWith('enc:v1:')) return 'encrypted'
  if (URN_RE.test(token)) return 'urn'
  // `id.secret`：两段都是 [A-Za-z0-9_-] 且各自不短。
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(token)) return 'api-key'
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return 'jwt'
  return 'token'
}

/**
 * 该账号 `auth` 里**这条通道**要用的凭据，没有就返回 `undefined`。
 *
 * ⚠ 返回 `undefined` 而不是抛错：调用方（`pickChannel()`）要靠"没有"这个事实去挑
 * 另一条腿。抛错会让"这个账号只有 start-plan 凭据"变成一个失败。
 */
export function credentialsForChannel(auth, channel) {
  const { value, usable, shape } = credentialMaterial(auth)
  if (!usable) return undefined
  if (channel === 'coding-plan') return shape === 'api-key' ? value : undefined
  if (channel === 'start-plan') return shape === 'api-key' ? undefined : value
  return undefined
}

/**
 * 账号里那份凭据**材料**的三态：能用 / 不能用（形态不认识）/ 压根没有。
 *
 * 为什么要单独一个函数：**「不能用」和「没有」必须分开报**（参考实现记录的教训反着用）。
 * - `enc:v1:…`（本机 ZCode 客户端那份密文）与 `urn:…`（OAuth 里那种标识）都**不是**令牌。
 *   把它们当凭据发出去只会换回一个 401，而 401 在本仓是「停这个账号 24 小时」
 *   （`COOLDOWN.auth`）——用一个**我们明知不认识**的字符串去打上游，代价是账号停一天。
 * - 而分类上它又**不能**算「请求的问题」（`INVALID_REQUEST` 会不罚账号继续换下一个账号试）：
 *   每个账号都会一样地失败。所以它必须报 `MISSING_CREDENTIAL`，让用户的动作是**重新粘贴**。
 */
export function credentialMaterial(auth) {
  const raw = typeof auth?.access === 'string' && auth.access.trim().length > 0 ? auth.access.trim() : undefined
  const shape = credentialShape(raw)
  const usable = shape === 'api-key' || shape === 'jwt' || shape === 'token'
  return { value: raw, shape, usable }
}

/**
 * 这个账号能不能走某条通道（用于面板与 `listModels()` 提前判断）。
 *
 * `describeChannels()` 的存在理由与参考实现一致：让 UI/日志**提前**知道缺哪条腿，
 * 而不是等到发请求时才吃一个 401。
 */
export function describeChannels(auth) {
  return {
    'start-plan': credentialsForChannel(auth, 'start-plan') !== undefined,
    'coding-plan': credentialsForChannel(auth, 'coding-plan') !== undefined,
  }
}

/**
 * 从账号 `auth` 里取**稳定的**账号标识。
 *
 * ⚠ 只用 `user_id`，**绝不用 `device_mid`**：后者是我们随机生成的、每次登录都变
 * （`zcode.ts:56-59` 实测同一 JWT 换任意随机 UUID 都 200 ⇒ 值不被绑定校验），
 * 拿它认账号会把同一个账号当成两个。参考实现记录过一次"跨账号覆盖"缺陷，判据就是这个。
 */
export function accountIdentity(auth) {
  const userId = typeof auth?.userId === 'string' && auth.userId.trim().length > 0 ? auth.userId.trim() : undefined
  if (userId !== undefined) return userId
  return undefined
}

/**
 * `user_id` → 手机号展示形态（`zcode.ts` 的 `phoneFromUserId`）。
 *
 * 有些账号的 `user_id` 前缀不是手机号，所以**校验不过就不显示**，绝不硬套——
 * 把一个 uuid 的前 11 位当手机号展示会给用户一个不存在的号码。
 */
export function phoneFromUserId(userId) {
  if (typeof userId !== 'string' || userId.length < 11) return undefined
  const head = userId.slice(0, 11)
  if (!/^1[3-9]\d{9}$/.test(head)) return undefined
  return `${head.slice(0, 3)}****${head.slice(-4)}`
}

// ------------------------------------------------------------------ 通道选择

/**
 * 目录条目里的 `channels` 字段 → 通道名数组。
 *
 * 上游可能回 `channels: ['coding-plan']`，也可能回对象数组。两种都认，认不出来返回
 * 空数组（空数组 = 「目录没说」，不是「不支持任何通道」——后者会把模型整个藏起来）。
 */
export function channelsOf(entry) {
  const raw = entry?.channels ?? entry?.channel
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const out = []
  for (const item of list) {
    const name = typeof item === 'string' ? item : typeof item?.id === 'string' ? item.id : typeof item?.name === 'string' ? item.name : undefined
    if (name && CHANNELS.includes(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 目录**说**这个模型属于哪些通道；目录没说时退回 `CHANNEL_MODELS` 常量。
 *
 * 目录优先是刻意的：白名单会随产品更新漂移，而目录响应是**这一次**的真值。
 */
export function channelsForModel(model, catalogEntry) {
  const declared = channelsOf(catalogEntry)
  if (declared.length > 0) return declared
  return CHANNELS.filter((channel) => (CHANNEL_MODELS[channel] ?? []).includes(model))
}

/**
 * 挑一条腿。
 *
 * `prefer` 由调用方给（族里按证据侧的决定传 `'start-plan'`：**积分是白给的，
 * 不该被订阅额度先消耗**，`zcode-transport.ts` 的 `resolveChannelFor`）。规则：
 * 1. 首选腿能用（模型属于它 **且** 凭据形态对）就用它；
 * 2. 否则用另一条腿（只要它也能用）；
 * 3. 都不行 ⇒ 返回 `undefined`，由调用方抛 `MISSING_CREDENTIAL`。
 *
 * ⚠ 凭据形态不对**不当成失败**：那只是"这条腿这次走不了"，换腿是正确动作。
 */
export function pickChannel(auth, model, { prefer = 'start-plan', catalogEntry } = {}) {
  const available = describeChannels(auth)
  const channels = channelsForModel(model, catalogEntry)
  const order = prefer === 'coding-plan' ? ['coding-plan', 'start-plan'] : ['start-plan', 'coding-plan']
  for (const channel of order) {
    // 目录没说这个模型的通道归属时（`channels` 为空数组）**不否决**任何一条腿：
    // 目录失败不该让整个族不可用，让上游去回答"这个模型不存在"更诚实。
    const allowed = channels.length === 0 || channels.includes(channel)
    if (allowed && available[channel]) return channel
  }
  return undefined
}

// ------------------------------------------------------------------ 请求头

/**
 * 出站请求头（逐字复刻 `zcode-upstream.ts:92-111` 的 `buildZcodeHeaders`）。
 *
 * 两条纪律：
 * - **`X-Device-Mid` 是硬需求**（缺它 billing 全家桶回 `400 {"code":3001}`）；
 *   而 `HTTP-Referer` 是 `zcode.z.ai` 专属，发去 `api.z.ai` 只会多一个无用头
 *   （上游注释：api.z.ai 网关只认 `Authorization` + `anthropic-version`）。
 * - 这些头**不是 3012 的判据**（判据是 `system` 内容），但仍照发——它们是
 *   "像官方客户端"的一部分，而少发的代价是未知的，多发的代价是零。
 *
 * `authorization` 由调用方给**已经拼好 `Bearer ` 前缀**的整串：本模块不认识凭据，
 * 传进来的字符串除了进这个头以外不会被用在任何地方（绝不进日志/错误消息）。
 */
export function buildZcodeHeaders({ deviceMid, appVersion, channel, authorization, json = true } = {}) {
  const version = typeof appVersion === 'string' && appVersion.length > 0 ? appVersion : ZCODE_APP_VERSION_FALLBACK
  const headers = {
    'User-Agent': `ZCode/${version}`,
    'X-ZCode-App-Version': version,
    'X-Release-Channel': 'stable',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': String(deviceMid ?? ''),
    'X-Platform': 'win32',
    'X-Os-Category': 'windows',
    'anthropic-version': '2023-06-01',
  }
  if (channel !== 'coding-plan') headers['HTTP-Referer'] = ZCODE_ORIGIN
  if (json) headers['Content-Type'] = 'application/json'
  if (typeof authorization === 'string' && authorization.length > 0) headers.Authorization = authorization
  return headers
}

// ------------------------------------------------------------------ system 与请求体

/**
 * 官方身份块。
 *
 * ⚠ **只发一块**：`OFFICIAL_IDENTITY` 本身就是 `cliPrefix + '\n\n' + stable 三段` 的
 * 拼合（2900 字符，见 `zcode-identity.js` 的 sha256 指纹）。把三段再拆成独立块
 * 发出去，总长会从 2900 变成 5211——上游的判据是"结构在不在"而不是"块数多少"，
 * 所以多发不会直接报错，但**我们已经没有逐字节对得上的参照物**了，
 * 而"与官方一致"正是这个块唯一的价值。初版这里就重发了一遍（自测抓到的）。
 */
function identityBlocks() {
  return [{ type: 'text', text: OFFICIAL_IDENTITY }]
}

/**
 * 环境块（`zcode-identity.ts:168-189`）。
 *
 * 不发的后果是"问模型你自己是谁"只能得到笼统的 GLM，而且它会以为该给 bash 命令
 * ——而这里跑的是 PowerShell。块里的信息**全是我们自己知道的**，没有任何用户数据。
 */
export function buildEnvironmentSection({ cwd, model, platform = 'win32', osVersion, arch, isGitRepo } = {}) {
  const shell = platform === 'win32' ? 'powershell' : 'bash'
  const lines = [
    '# Environment',
    'You have been invoked in the following environment:',
    ` - Primary working directory: ${typeof cwd === 'string' && cwd.length > 0 ? cwd : '.'}`,
    // `isGitRepo` 由调用方给：判定要碰文件系统，而 `src/wire/*` 是**不碰磁盘**的
    // 纯翻译层（族里才是能拿 `ctx` 的那一层）。缺省 `no` 是保守选择——这一行只是
    // 给模型一点方位感，说错一个字的代价远小于把 fs 依赖拖进 wire 层。
    ` - Is a git repository: ${isGitRepo === true ? 'yes' : 'no'}`,
    ` - Platform: ${platform}`,
    ` - Shell: ${shell}`,
    ` - OS Version: ${typeof osVersion === 'string' && osVersion.length > 0 ? osVersion : typeof arch === 'string' && arch.length > 0 ? `${platform} ${arch}` : platform}`,
    ` - You are powered by the model named zcode/${model ?? 'glm-5.3-flash'}.`,
  ]
  return { type: 'text', text: lines.join('\n') }
}

/**
 * 顶层 `system` 数组：**官方身份块在最前**，环境块次之，调用方（DSH）的 system 在最后。
 *
 * 只有**最后一块**打 `cache_control`：system 是前缀式的，一个断点覆盖它前面的一切
 * （含 tools），而 Anthropic 单请求上限 4 个断点——每块都打会占满，tools 那个就打不上了。
 */
export function buildZcodeSystemBlocks({ system, model, cwd, platform, osVersion, arch, isGitRepo } = {}) {
  const blocks = [...identityBlocks(), buildEnvironmentSection({ cwd, model, platform, osVersion, arch, isGitRepo })]
  if (typeof system === 'string' && system.trim().length > 0) blocks.push({ type: 'text', text: system })
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }
  return blocks
}

/**
 * 把「日期块」插到**第一条 user 消息**前面（`zcode-identity.ts:207-240`）。
 *
 * ⚠ 官方客户端发它，而实测**推翻**了"它是 3012 的最后一个开关"这个旧说法
 * （去掉照样 200）。照发的原因是零成本 + 与官方一致，不是为了过闸门。
 *
 * 三条实现约束：
 * - 只处理第一条消息，且必须是 `user`——插到别处等于改写了对话结构；
 * - **幂等**：已经以 `<system-reminder>` 开头就跳过（DSH 自己也会发这种块，
 *   重复插入会让模型看到两个矛盾的日期）；
 * - 内容形态两种都产出（字符串 / 块数组），但**不压平已有的块数组**。
 */
export function withContextPrefix(messages, now = new Date()) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const first = messages[0]
  if (!first || first.role !== 'user') return messages
  const dateBlock = buildContextPrefixBlock(now)
  const content = first.content
  if (typeof content === 'string') {
    if (content.startsWith('<system-reminder>')) return messages
    return [{ ...first, content: [dateBlock, { type: 'text', text: content }] }, ...messages.slice(1)]
  }
  if (!Array.isArray(content)) return messages
  if (content.some((block) => typeof block?.text === 'string' && block.text.startsWith('<system-reminder>'))) return messages
  return [{ ...first, content: [dateBlock, ...content] }, ...messages.slice(1)]
}

/**
 * 日期块正文。
 *
 * ⚠ `outro` 前面那 **6 个空格**是官方原文的一部分（`zcode-identity.ts` 的常量里就有），
 * 不是排版失误——`trim` 掉它会让块与官方不再逐字节一致，而"逐字节一致"是我们
 * 唯一能拿来说"这个块是对的"的东西。
 */
export function buildContextPrefixBlock(now = new Date()) {
  const text = ['<system-reminder>', CONTEXT_PREFIX_INTRO, `# currentDate\nToday's date is ${formatLocalIsoDate(now)}.`, '', CONTEXT_PREFIX_OUTRO, '</system-reminder>'].join('\n')
  return { type: 'text', text }
}

/** `YYYY-MM-DD`，**本地时区**（不是 UTC）：`toISOString()` 会在 UTC+8 的上午给出昨天。 */
export function formatLocalIsoDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// ------------------------------------------------------------------ 模型目录

/**
 * 目录响应 → 模型条目数组。
 *
 * ⚠⚠ **`data.builtinModels` 是对象不是数组**（键是序号字串，实测 `{"0":{…GLM-5.3},"1":{…GLM-5.3-Flash}}`）。
 * 用 `Array.isArray` 判定会得到"0 个模型"这个**假阴性**，而且它长得像"上游改了协议"
 * ——实际上上游一直是这个形状。
 */
export function parseClientConfigs(json) {
  const raw = json?.data?.builtinModels
  if (raw === null || typeof raw !== 'object') return []
  const entries = Array.isArray(raw) ? raw : Object.values(raw)
  const out = []
  for (const record of entries) {
    if (record === null || typeof record !== 'object') continue
    const id = typeof record.modelId === 'string' && record.modelId.length > 0 ? record.modelId : typeof record.id === 'string' ? record.id : undefined
    if (id === undefined) continue
    const contextWindow = positiveNumber(record.contextWindow)
    const maxCompletionTokens = positiveNumber(record.maxCompletionTokens ?? record.maxTokens)
    // ⚠ 能力字段**必须抄上游，不能按"同族应该一样"推断**：实测只有 Flash 有
    // `capabilities.vision === true`，而参考实现早期把所有模型都标 supportsImage，
    // 症状是"上下文窗口显示 1,000,000，但思考档位选择器根本没出现"。
    const vision = record.capabilities !== null && typeof record.capabilities === 'object' && record.capabilities.vision === true
    const levels = record.reasoning !== null && typeof record.reasoning === 'object' ? record.reasoning.levels : undefined
    const keys = levels !== null && typeof levels === 'object' ? Object.keys(levels) : []
    out.push({
      id,
      name: typeof record.name === 'string' && record.name.length > 0 ? record.name : id,
      // 缺字段时给保守值：**0 会让 DSH 认为没有窗口**，那比报小一点更糟。
      contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: maxCompletionTokens ?? DEFAULT_MAX_TOKENS,
      supportsImage: vision,
      channels: channelsOf(record),
      ...(keys.length > 0 ? { reasoningLevels: orderReasoningLevels(keys) } : {}),
      ...(typeof record.reasoning?.defaultLevel === 'string' && record.reasoning.defaultLevel.length > 0
        ? { defaultReasoningLevel: record.reasoning.defaultLevel }
        : {}),
    })
  }
  return out
}

/**
 * 思考档位排序：已知档位按 `REASONING_ORDER`，未知档位**按原序追加**。
 *
 * 上游的键插入序实测是 `low, max, high`（而 IDE 展示 `low, high, max`）——不重排的话
 * 档位选择器的顺序会随上游 JSON 的键序漂移。
 */
export function orderReasoningLevels(keys) {
  const known = REASONING_ORDER.filter((level) => keys.includes(level))
  const unknown = keys.filter((key) => !REASONING_ORDER.includes(key))
  return [...known, ...unknown]
}

/** 有限正数才收；0/负数/字符串数字之外的都当"没说"。 */
function positiveNumber(value) {
  const number = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return undefined
  return Math.floor(number)
}

/**
 * 目录条目 → 宿主认识的模型元数据（`docs/family-contract.md` §5.3）。
 *
 * `reasoning.efforts` 的 `name` 用档位原文首字母大写：DSH 的档位选择器直接显示它，
 * 而 `xhigh` 这种小写串在界面上很别扭。
 */
export function modelInfo(id, entry = {}, provider) {
  const contextWindow = positiveNumber(entry.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const defaultMaxTokens = positiveNumber(entry.maxTokens) ?? DEFAULT_MAX_TOKENS
  const levels = Array.isArray(entry.reasoningLevels) ? entry.reasoningLevels : []
  const defaultEffort = typeof entry.defaultReasoningLevel === 'string' && levels.includes(entry.defaultReasoningLevel) ? entry.defaultReasoningLevel : undefined
  return {
    provider,
    id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
    context: { contextWindow },
    defaultMaxTokens,
    toolUpdate: 'in-history',
    // 三态（`AGENTS.md` 的静默失效表）：明确不支持就是 `['text']`，**不能省略**——
    // 省略等于"未知"，宿主会把图片发到一个不认图片的模型上。
    inputModalities: entry.supportsImage === true ? ['text', 'image'] : ['text'],
    ...(levels.length > 0
      ? {
          reasoning: {
            efforts: levels.map((value) => ({ id: value, name: value.charAt(0).toUpperCase() + value.slice(1) })),
            ...(defaultEffort === undefined ? {} : { defaultEffort }),
          },
        }
      : {}),
  }
}

// ------------------------------------------------------------------ 失败归类

/**
 * 业务码 → 语义类别。
 *
 * 只有 ZCode 私有的这几个码在这里；**额度/欠费的文本判定不在这里**——那是
 * `failureWords()` 的活（它是共享词表，抄第二份必然漂移）。
 *
 * 码的取值来自 `zcode-upstream.ts` / `providers-zcode.md`：
 * - `1005` 余额不足 / 超出配额；`1113` 无可用资源包 ⇒ 额度类；
 * - `3009` 并发限流 ⇒ 限流类（**退避即可，别换号别标记**）；
 * - `3012` 风控（HTTP **405**）⇒ 阻断类，**这条最危险**：上游对它有冷却惩罚
 *   （30min → 24h → 停用），反复重试会把用户账号打停；
 * - `1002` 凭据失效；`3001` 参数错误（缺 `X-Device-Mid` 时 billing 就回它）。
 */
export function zcodeBusinessCode(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const parsed = tryParse(text)
  const raw = parsed?.code ?? parsed?.data?.code ?? parsed?.error?.code
  const number = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : undefined
  if (number === undefined) return undefined
  const family =
    number === 3012 ? 'blocked' : number === 3009 ? 'concurrency' : number === 1005 || number === 1113 ? 'quota' : number === 1002 ? 'auth' : number === 3001 ? 'parameter' : 'unknown'
  return { code: number, family }
}

/**
 * 一笔失败响应 → 可直接抛的错误。**本族唯一允许构造失败的地方。**
 *
 * 判定顺序（每一步都有事故背景，别重排）：
 * 1. **3012 先判**，不看状态码：它以 405 回来，而 405 在 `mapStatus()` 里落 `SERVER`
 *    （换号 + 60 秒冷却 + 重试）——真实语义是"这个请求体被风控挡了，重试会加重惩罚"。
 *    这里归 `AUTH` 是**刻意**的：它同时拿到"换号"（换个账号确实可能过）与
 *    "24 小时"（挡住重试，保护用户账号）。文案必须说清它不是"密钥无效"。
 * 2. **3009 并发限流**：`RATE_LIMIT` + **不换号**由调用方保证（`3009` 时换号没意义），
 *    这里只给码。
 * 3. 其余一律委托 `mapStatus()`：词表只有一份。`1005`/`1113` 与"余额不足"这类
 *    文本由它内部的 `failureWords()` 判，**这里不重复判**。
 *
 * ⚠ `detail` 里绝不能带凭据：调用方传进来的 `text` 是上游响应体，而我们把
 * `slice(0, 300)` 截断后放进 message——上游响应体里不会有我们的令牌。
 */
export function classifyZcodeFailure(response, text = '') {
  const status = Number(response?.status) || 0
  const detail = typeof text === 'string' ? text : ''
  const business = zcodeBusinessCode(detail)
  const finish = (code, extra = {}) => {
    const error = new Error(`zcode: HTTP ${status} ${detail.slice(0, 300)}`)
    error.code = code
    error.failure = { status, code, ...(business === undefined ? {} : { zcodeCode: business.code }), ...extra }
    return error
  }

  if (business?.family === 'blocked') {
    // 归 AUTH 是为了同时拿到「换号」与「停 24 小时」，但**文案必须诚实**：
    // 它不是密钥问题，宿主默认会把 AUTH 显示成「API 密钥无效」，那是误导。
    const error = finish('AUTH')
    error.message =
      `zcode: 上游按风控拦下了这次请求（HTTP ${status}，业务码 3012）。` +
      '这不是密钥问题：请勿反复重试（重试有冷却惩罚，多次会停用账号）。'
    error.zcodeBlocked = true
    return error
  }
  if (business?.family === 'concurrency') return finish('RATE_LIMIT')

  const code = mapStatus(status, detail)
  const error = finish(code)
  // 401 + `1001`（api.z.ai 网关原文 "Authentication parameter not received in Header"）
  // 的语义是「**这条通道没有可用的凭据**」，不是「这个账号被吊销了」。两者都归 AUTH，
  // 所以**不做区分**（`code` 只能是 DSH 的中立码，宿主不认识我们自定义的值）。
  // 区别体现在 `zcodeCode` 上：排障时能看出是缺凭据还是凭据被拒。
  return error
}

/** 上游说"过一会儿再来"的时间（秒或毫秒都认），治不了就返回 undefined（**不编数**）。 */
export function retryAfterFrom(response) {
  const headers = response?.headers
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  // 上限一小时（与 `health.js` 的 `LONGEST_WAIT_MS` 同口径）：上游偶尔会回一个
  // 明显失真的值（"明天再来"），照单全收会把账号冻到用户以为坏了。
  return Math.min(seconds * 1000, 60 * 60_000)
}

/**
 * **额度耗尽**的判据，用于"这个账号今天还能不能用"。
 *
 * ⚠ 必须**先排除 3009**（并发限流）：把限流读成"当日用尽"会把一个完全健康的账号
 * 标掉，而参考实现记录过这个缺陷。文本一侧交给 `failureWords()`。
 */
export function isZcodeQuotaExhausted(status, text) {
  const business = zcodeBusinessCode(text)
  if (business?.family === 'concurrency') return false
  if (business?.family === 'quota') return true
  const said = failureWords(status, typeof text === 'string' ? text : '')
  return said === 'quota' || said === 'credit'
}

/** 响应体里的 JSON（可能的几种包法都试一遍），失败返回 undefined。 */
function tryParse(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}
