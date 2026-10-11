/**
 * OpenCode Zen 族——本仓**唯一一个凭据是静态 API key** 的族。
 *
 * 上游 `https://opencode.ai/zen/v1` 是 OpenAI 兼容端点，但它有两件 `generic` 预设
 * 做不到的事，本族存在的理由就是这两条：
 *
 * 1. **目录按凭据裁剪，而能力表在别处**。`GET /zen/v1/models` 只回
 *    `id/object/created/owned_by` 四个字段，**没有任何能力信息**；
 *    能力元数据只存在于第三方 `https://models.dev/api.json` 的 `opencode` 条目里。
 *    所以 `listModels` 是**两份目录的交集**，并集规则见 `src/wire/opencode.js` 的
 *    `mergeCatalogs`（上游目录是边界）。
 * 2. **失败归类必须盖掉状态码**。本族会见到三个「看起来像鉴权失败」的状态码，
 *    其中两个与凭据毫无关系（详见 `src/wire/opencode.js` 文件头第五节）——
 *    照 `src/wire/http-error.js` 的默认映射，它们会让一个健康的账号被冷 **24 小时**。
 *
 * ## 一、凭据从哪来，以及为什么**没有** `refresh` / `needsRefresh`
 *
 * 凭据是本机 OpenCode CLI 登录后写在 `~/.local/share/opencode/auth.json` 里的
 * **静态 API key**（`{"<provider>":{"type":"api","key":"sk-…"}}`）。
 * 本仓真机看过那个文件：它有 **7 条**，每条一个 provider，
 * 其中**只有键名 `opencode` 的那一条**是 Zen 的凭据
 * （另外六条 `deepseek` / `siliconflow-cn` / `longcat` / `zhipuai` / `google` / `amd`
 * 是**别家**的 key，导入进来只会得到一堆必然 401 的账号）。
 *
 * ⚠ **本族刻意不实现 `refresh`，也不实现 `needsRefresh`**：
 * API key 不过期，上游没有续期端点，本机也没有第二个进程会替它轮换这把 key。
 * 本仓三条先例（`zcode` / `commandcode` / `codearts`）都写了「刻意的 no-op `refresh`」，
 * 因为账号卡片的「刷新」按钮走 `src/pool.js` 的 `family.refresh(...)` 且那一行
 * **没有可选链**；`codearts` 的注释里也说了「省略了就是个 TypeError」。
 * 本族省略它的依据是 `src/pool.js` 现有的 `NO_REFRESH` 守卫：池子对「没有 `refresh`
 * 的族」显式抛一个说得清楚的错，而不是崩在那个调用点上。**如果那条守卫哪天被删掉，
 * 这里就要补一个 no-op `refresh`** —— 写这一句是为了让删守卫的人知道有人依赖它。
 *
 * 代价说清楚：本族**没有续期能力**，而它也不需要——key 要么一直有效，要么被吊销；
 * 被吊销时上游回 401 `AuthError`，本族把它归 `AUTH`，池子换号 + 长冷却，
 * 那才是「该重新登录了」的真实信号（不是本族编出来的一个到期时间）。
 *
 * ## 二、免费档**默认被滤出选择器**，这是一条实测结论不是偏好
 *
 * 本仓真机捕获：免费模型（`-free` 结尾、models.dev 里 `cost` 全 0）`POST /chat/completions`
 * 一律 **403** `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier
 * can only be used from within OpenCode"}}`。参考实现记录了匿名通道要用的指纹头
 * （`x-opencode-client: cli` 等），**本仓照实现补齐之后仍然 403** ⇒ 那道门比请求头深。
 *
 * 所以：`listModels` 默认走 `excludeFree`。一个**必然失败**的模型留在选择器里，
 * 用户选中它只会得到一次失败；滤掉它换来的是一句能解释的话（README 的对应小节）。
 * ⚠ 这里**不伪造任何 `x-opencode-*` 客户端指纹**：一个已经被证伪的身份换不来通道，
 * 只会让我方请求看起来像在冒充一个特定客户端（`src/wire/opencode.js` 第三节）。
 *
 * ## 三、`stream()` **不发** `stream_options`，也**不发** `reasoning_effort`
 *
 * 这两条都是「宁可少发」的结果，理由是本仓探针**推翻了简报的探法**：
 * 简报假设「402 = 请求被接受、400 = 形状被拒」，于是可以在没钱的 key 上把请求形状探清。
 * 实测不成立——付费档上连**故意非法**的请求（`messages:"nope"`、`max_tokens:"eight"`、
 * `tools:"nope"`、未知顶层字段、非法 `reasoning_effort:"turbo"`）**全部回 402**；
 * 免费档上同样这批形状**全部回 403 FreeTierError**（只有 `model` 缺失会先撞 401 `ModelError`）。
 * ⇒ 网关在计费与免费闸之前**不做任何请求体校验**，拒因来自上游 provider，
 * 而 provider 的拒因在没钱时被 402 掩盖。
 * ⇒ 「上游接受不接受 `stream_options` / `max_completion_tokens` / `reasoning_effort`」
 * **在本仓的凭据条件下探不出来**，这三项一律标**未验**，因此**一律不发**：
 * 少发一个未验的字段就少一个失败面，而 DSH 的 token 统计少一次 `usage` 只是账不准、不是功能缺失。
 * 发出去的是**最少且被广泛支持**的那个形状：`model` / `messages` / `stream: true` /
 * `max_tokens` / `tools`（有工具时）。
 *
 * ## 四、额度**读不到**，所以 `quota()` 如实返回 `undefined`
 *
 * 上游没有任何余额/额度端点（本仓探测的端点清单里没有，参考实现也没记）。
 * 契约 §0 第五条：「没有就别实现，报假额度比不报更糟」。
 * ⇒ `quota()` 返回 `undefined`，面板显示「额度未知」。**绝不编 0%。**
 * 唯一与钱有关的真实信号是 `402 Insufficient account funds`——它由失败归类承载
 * （`ACCOUNT_QUOTA` ⇒ 池子换号），不是额度读数。
 *
 * ## 五、会话与缓存键：这条线上**没有**那三个字段
 *
 * 契约 §5 要求的 `x-claude-code-session-id` / `metadata.user_id` / `prompt_cache_key`
 * 是 **Claude 线**的形状。Zen 这条线的请求头里没有任何一个，请求体里也**没有**任何
 * 被验证过的缓存键字段 ⇒ 本族既不 import `accountScopedSession`，也不发任何会话 id。
 * 照 `src/wire/raccoon.js:72-80` 的写法在这里记一句：**不是漏了**，
 * 是这条线上本来就没有那个字段，所以既没有裸会话 id 可泄漏，也不存在「三处同值」的问题。
 *
 * ## 六、借来的东西
 *
 * 本族的**协议事实全部来自本仓自己的真机探针**（脚本在仓外 `_dsh_research/`，逐字报文
 * 登记在 `THIRD_PARTY_NOTICES.md` 的「本仓自己真机捕获」一节）。
 * 唯一借自外部的是一份**数据表的字段名与量纲**（`https://models.dev/api.json` 的
 * `opencode` 条目），借了什么、证据强度如何，同样在 `THIRD_PARTY_NOTICES.md` 里逐条写明。
 * ⚠ 参考实现（`temp/codearts/src/opencode*.ts`）的**指纹算法本仓一个字都没有抄**——
 * 实测证明它换不来通道（第二节），抄一个被证伪的东西没有意义。
 *
 * ## 七、本族验证状态（如实）
 *
 * - **真机验过**：`GET /zen/v1/models`（带真 key 13 条 / 不带 key 87 条）、
 *   免费档 403 `FreeTierError`（含补齐指纹头）、付费档 402 `Insufficient account funds`、
 *   乱写 key 401 `AuthError`、缺/空 `model` 401 `ModelError`、非法模型 400 `Model is unavailable.`。
 * - **真机未验**：**一次真实的推理**。那把 key **没有余额**（付费档一律 402），
 *   而免费档对第三方客户端关闭 —— 两条路都走不到「模型真的说了话」。
 *   所以 `stream()` 的**成功路径**（SSE 逐块翻译）只由 `test/e2e/` 的假上游覆盖，
 *   没有任何真机字节流证据。这一条必须跟着 README 一起看，别把它读成「跑通过」。
 * @module dsh-account-bridge/families/opencode
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { assertApiReply } from '../wire/assert-reply.js'
import {
  toChatMessages,
  toChatSystem,
  toChatTools,
  translateChatStream,
} from '../wire/chat-completions.js'
import { httpError, retryAfterMs } from '../wire/http-error.js'
import {
  CONSERVATIVE_CONTEXT_WINDOW,
  CONSERVATIVE_MAX_TOKENS,
  MODELS_DEV_TTL_MS,
  MODELS_DEV_URL,
  OPENCODE_CHAT_URL,
  OPENCODE_MODELS_URL,
  classifyOpencodeFailure,
  describeOpencodeFailure,
  excludeFree,
  isFreeTier,
  mergeCatalogs,
  opencodeHeaders,
  parseModelsDev,
  parseZenModels,
  resolveOpencodeModel,
} from '../wire/opencode.js'
import { withSource } from '../util.js'

/** 族 id（必须等于文件名，契约 §2）。 */
export const ID = 'opencode'

/** route（全插件唯一，`assertUniqueRoutes` 在启动时校验）。 */
export const ROUTE = 'acct-opencode'

/** 面板上显示的名字。 */
export const DISPLAY_NAME = 'OpenCode Zen'

/** 目录缓存 TTL：比 models.dev 的 60 分钟短，因为**两处**都要重拉。 */
const CATALOG_TTL_MS = 5 * 60_000

/**
 * 本族凭据在 `auth.json` 里的键名。
 *
 * ⚠ 只有这一个键是 Zen 的凭据。本仓真机看过那个文件的其余六个键是别家的 key
 * （它们各自指向 openrouter/deepseek/siliconflow 一类的端点，不是 Zen），
 * 导进来只会得到一堆必然 401 的账号。
 */
const CLIENT_KEY = 'opencode'

/** auth.json 相对家目录的位置（macOS / Linux / Windows 三个平台都用 `~/.local/share`）。 */
const CLIENT_AUTH_PARTS = ['.local', 'share', 'opencode', 'auth.json']

/** 本族要读的凭据文件（绝对路径）。 */
export function clientAuthPath() {
  return join(homedir(), ...CLIENT_AUTH_PARTS)
}

/**
 * `auth.json` 里那六个**不是**本族凭据的键（本仓真机读到的原始清单）。
 *
 * 写成一个常量而不是「遍历所有键」有两个理由：
 * ① 排除清单必须是**确定**的，不能随用户机器上装了哪些别的 CLI 而漂移；
 * ② 发现结果里要能说清「我们看到了它们、并判定它们不是本族的」——从文件里
 *    动态读出来的键名会被写进给用户看的文案，那是把用户机器上的其他凭据名
 *    带到一个显示面上。这六个是本仓真机上的一批**证据**，不是「当前有哪些」的查询。
 */
const NON_ZEN_KEYS = ['deepseek', 'siliconflow-cn', 'longcat', 'zhipuai', 'google', 'amd']

/**
 * 模块级目录记忆（与 `src/families/generic.js` 的 `catalogMemory` 同款）。
 *
 * ⚠ 存的是**未滤免费档**的那一份：`resolveModel` 只拿到一个模型名，
 * 若用户手里还留着一个免费档模型的会话，这里要能说出它是什么，而不是回落成保守默认值。
 * `listModels` 返回的才是滤过的那一份。
 */
const catalogMemory = new Map()
/** 目录装配时刻（TTL = `CATALOG_TTL_MS`，两处目录都要重拉）。 */
let catalogLoadedAt = 0

/**
 * models.dev 单独缓存，**和目录的 TTL 分开**。
 *
 * ⚠ 共用一个时间戳会出一个很隐蔽的 bug：目录 5 分钟过期、models.dev 60 分钟过期，
 * 若拿目录的时间戳当后者的判据，60 分钟窗口内的每一次目录重拉都会**重新拉一遍**
 * models.dev（判据永远说「刚拉过」，于是永远不拉）。所以两个时刻分开记。
 */
let modelsDevCache = undefined
let modelsDevLoadedAt = 0
/** models.dev 的 in-flight 合并：同一时刻只拉一次（best-effort，失败不缓存）。 */
let modelsDevInFlight = undefined

/** 记一条目录条目（只记真的读到的，兜底值**永不**写进来）。 */
function rememberCatalog(rows) {
  for (const row of rows) {
    if (typeof row?.id === 'string' && row.id.length > 0) catalogMemory.set(row.id, row)
  }
}

/** 日志：`ctx.log` 与 `ctx.logger` 两种形状都兼容，且**日志失败不连累主流程**。 */
function warn(ctx, message) {
  try {
    if (typeof ctx?.log?.warn === 'function') ctx.log.warn(message)
    else if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
  } catch {
    // 日志是尽力而为：它自己炸了不该让一次推理失败。
  }
}

/** 凭据缺件时抛的错（`code` 是健康层认得的归属码）。 */
function missingCredential(message) {
  const error = new Error(message)
  error.code = 'MISSING_CREDENTIAL'
  error.failure = { code: 'MISSING_CREDENTIAL', message }
  return error
}

/** 传输层错误：网络问题不代表账号有问题（`TRANSPORT` 换号但**不记冷却**）。 */
function transportError(error) {
  const wrapped = new Error(`account-bridge: opencode 传输失败：${error?.message ?? error}`)
  wrapped.code = 'TRANSPORT'
  wrapped.failure = { code: 'TRANSPORT', message: wrapped.message }
  wrapped.cause = error
  return wrapped
}

/**
 * 从记录里取凭据。
 *
 * 判据只有一条：`auth.apiKey` 是非空字符串（`authFromPayload` 的白名单保证了
 * 记录里不会有别的形状）。取不到就报**缺件**，而不是发一个空 `Bearer` 出去。
 */
export function credentialOf(payload) {
  const auth = payload?.auth ?? payload ?? {}
  const apiKey = typeof auth.apiKey === 'string' ? auth.apiKey.trim() : ''
  if (apiKey.length === 0) {
    return {
      usable: false,
      missing: ['apiKey'],
      auth: {},
    }
  }
  return { usable: true, missing: [], auth: { apiKey } }
}

/**
 * 白名单重建凭据对象。
 *
 * 与 raccoon / codearts 同款：凭据对象一旦被原样存进记录，里面任何多余的键都会
 * 跟着 `publicAccount()` 的白名单重建一起出站。所以**只留已知的键**。
 */
export function authFromPayload(payload) {
  const source = payload?.auth ?? payload ?? {}
  const out = {}
  for (const key of ['apiKey', 'label']) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim()
  }
  return out
}

/**
 * 给账号起一个能分辨的 label。
 *
 * ⚠ **只用密钥的前 6 位**（`sk-XVQ…` 这种形状），而且刻意**不含** key 的其余部分——
 * label 会出现在面板与列表里，而它是凭据的一部分。key 短于 9 位时退化成
 * `Zen key`（那说明用户粘错东西了，给一个「前 6 位」反而是把错值抄进界面）。
 */
export function labelFor(auth) {
  const key = typeof auth?.apiKey === 'string' ? auth.apiKey : ''
  return key.length >= 9 ? `Zen key ${key.slice(0, 6)}…` : 'Zen key'
}

/** 组装一条池子记录（`recordFromAuth` 的三个调用点共用）。 */
export function recordFromAuth(auth, label, source = 'manual', externallyOwned = false) {
  return {
    family: ID,
    label: label ?? labelFor(auth),
    source,
    externallyOwned,
    auth: authFromPayload(auth),
    createdAt: new Date().toISOString(),
  }
}

/** 只给探针与一次性自测用：清掉记忆，让下一轮重新装配。 */
export function __resetOpencodeCaches() {
  catalogMemory.clear()
  catalogLoadedAt = 0
  modelsDevCache = undefined
  modelsDevLoadedAt = 0
  modelsDevInFlight = undefined
}

/**
 * 读本机 `auth.json`，**只**取 `opencode` 那一条。
 *
 * @returns {{kind:'ok', key:string} | {kind:'missing'} | {kind:'read-error', message:string} | {kind:'shape-error', message:string}}
 */
function readClientKey() {
  const file = clientAuthPath()
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // ⚠「读不出来」不等于「没有」：文件不存在与读失败必须分开报，否则用户会看到
    // 「没装 OpenCode」而真实原因是权限/路径问题（`AGENTS.md` 的硬规矩）。
    if (error?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'read-error', message: `${error?.code ?? 'ERROR'}: ${error?.message ?? error}` }
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { kind: 'shape-error', message: `auth.json 不是合法 JSON（${error?.message ?? error}）` }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { kind: 'shape-error', message: 'auth.json 的顶层不是对象' }
  }
  const entry = json[CLIENT_KEY]
  if (entry === undefined) return { kind: 'missing' }
  if (entry === null || typeof entry !== 'object') {
    return { kind: 'shape-error', message: `auth.json 的 \`${CLIENT_KEY}\` 条目不是对象` }
  }
  const key = typeof entry.key === 'string' ? entry.key.trim() : ''
  if (key.length === 0) {
    return { kind: 'shape-error', message: `auth.json 的 \`${CLIENT_KEY}\` 条目里没有非空字符串 \`key\`` }
  }
  // `type` 本仓真机见到的都是 `'api'`，但**不拿它当门槛**：它不是本仓要用的值，
  // 将来上游加一个类型（或用户手改）不该让一个能用的 key 导不进来。
  return { kind: 'ok', key }
}

/** 「查过哪些路径 + 为什么别家 key 不是本族凭据」的那段公共文案。 */
function discoveryReason(headline) {
  return [
    headline,
    `查过：${clientAuthPath()}`,
    `只认 \`${CLIENT_KEY}\` 这一个键——另外六个键（${NON_ZEN_KEYS.join(' / ')}）是**别家**的 API key，不是 Zen 凭据，导入它们只会得到必然 401 的账号。`,
  ].join(' ')
}

/**
 * 本机发现：读 `~/.local/share/opencode/auth.json`，**只认 `opencode` 这一条**。
 *
 * ⚠ **恒返回一条**（照 codearts 的做法）：`src/tools.js` 渲染非 importable 条目时
 * **只打印 label 与 reason、不打印 sourcePath**，所以「查过哪些路径」必须写进 reason，
 * 否则用户看到的是「没找到」而不知道去哪放。
 *
 * ⚠ 三种「没有」必须分开报（`AGENTS.md`：「读不出来」不等于「没有」）：
 * 文件不存在 ⇒ 如实说没找到；读失败/解析失败/结构不对 ⇒ 报**未知**并带上原始错误；
 * 只有真的读到一条非空 key 才算 `importable: true`。
 *
 * ⚠ 凭据**不进 reason、不进 label**（`labelFor` 只取前 6 位）——发现结果是给界面看的。
 */
export async function discover() {
  const sourcePath = clientAuthPath()
  const found = readClientKey()

  if (found.kind === 'missing') {
    return [{
      family: ID,
      sourcePath,
      label: 'OpenCode Zen（未找到 OpenCode 的登录态）',
      importable: false,
      reason: discoveryReason(`本机没有 \`${sourcePath}\`（OpenCode CLI 没登录，或者这个文件被删了）。`),
    }]
  }
  if (found.kind === 'read-error') {
    return [{
      family: ID,
      sourcePath,
      label: 'OpenCode Zen（登录态读不出来）',
      importable: false,
      reason: discoveryReason(`\`${sourcePath}\` 存在但读失败：${found.message}。这不是「没有凭据」，是**读不出来**——请检查文件权限后重试。`),
    }]
  }
  if (found.kind === 'shape-error') {
    return [{
      family: ID,
      sourcePath,
      label: 'OpenCode Zen（登录态形状不认识）',
      importable: false,
      reason: discoveryReason(`\`${sourcePath}\` 的内容不认识：${found.message}。这不是「没有凭据」，是**读不出来**——本仓不猜一个形状不对的文件。`),
    }]
  }

  const auth = { apiKey: found.key }
  return [{
    family: ID,
    sourcePath,
    label: labelFor(auth),
    importable: true,
    externallyOwned: true,
    auth,
  }]
}

/**
 * 把一条发现结果变成池子记录。
 *
 * 必须实现它，否则 `src/discover.js:193` 会把 `importable: true` 的条目标成
 * `blocked`（reason：`opencode 族没有实现 recordFromDiscovery，无法导入`）。
 *
 * `externallyOwned: true` 是**真话**：这把 key 属于 OpenCode CLI 的登录态，
 * 我们只是读它（本族**不写**那个文件，所以 `test/e2e/preflight.mjs` 第 3 条
 * 「会写盘的源码只有那两个族」不受影响）。
 */
export function recordFromDiscovery(item) {
  return withSource(recordFromAuth(item.auth, item.label, 'client-import', true), item)
}

/**
 * 拉一份 models.dev 能力表。**best-effort**：失败只 `warn` 一次并返回 `undefined`
 * （调用方回落到 Zen 目录 + 保守元数据），**绝不让第三方目录的可用性决定本族能不能用**。
 *
 * 三条纪律：
 * - TTL 60 分钟（`MODELS_DEV_TTL_MS`）——它是别人的服务，不在热路径上反复打；
 * - in-flight 合并——同一时刻只拉一次（并发调用共享同一个 promise）；
 * - **失败的结果不缓存**（`modelsDevLoadedAt` 只在成功时前进），
 *   所以下一次目录重拉会重试。`generic.js` 的「兜底表不算已加载」是同一条教训。
 *
 * ⚠ 刻意**走账号自己的出口代理**（`payload.proxy`）：一个只能经代理上网的环境里，
 * 直连 `models.dev` 会超时；既然这台机器已经为这个账号配了出口，就让这次拉取也走它。
 * ⚠ 不传第 4 个参数（它是一次非流式的短请求，5 分钟的 `bodyTimeout` 够用）。
 */
async function loadModelsDev(ctx, payload) {
  if (modelsDevLoadedAt > 0 && Date.now() - modelsDevLoadedAt < MODELS_DEV_TTL_MS) return modelsDevCache
  if (modelsDevInFlight !== undefined) return modelsDevInFlight
  modelsDevInFlight = (async () => {
    try {
      const response = await ctx.fetch(
        MODELS_DEV_URL,
        { method: 'GET', headers: { accept: 'application/json' } },
        payload?.proxy,
      )
      if (!response?.ok) {
        warn(ctx, `account-bridge: opencode 拉 models.dev 失败（HTTP ${response?.status}），本轮只用 Zen 目录的保守元数据`)
        return undefined
      }
      const table = parseModelsDev(await response.json())
      modelsDevCache = table
      modelsDevLoadedAt = Date.now()
      return table
    } catch (error) {
      warn(ctx, `account-bridge: opencode 拉 models.dev 失败（${error?.message ?? error}），本轮只用 Zen 目录的保守元数据`)
      return undefined
    } finally {
      // 无论成败都要解除合并，否则一次失败会把后续调用永远挂在同一个 promise 上。
      modelsDevInFlight = undefined
    }
  })()
  return modelsDevInFlight
}

/**
 * 目录：Zen `/models`（**边界**）× models.dev（**能力**），并默认滤掉免费档。
 *
 * 两处都是 best-effort 里**只有一处**可以失败：Zen 目录是边界的来源，它失败就没有
 * 「你有权用哪些」这个判据 ⇒ 如实抛（池子会换号）；models.dev 只是能力来源，
 * 它失败就退化成保守元数据（`CONSERVATIVE_CONTEXT_WINDOW` / `CONSERVATIVE_MAX_TOKENS`）。
 */
export async function listModels(ctx, payload, signal) {
  const credential = credentialOf(payload)
  if (!credential.usable) {
    throw missingCredential('account-bridge: opencode 这一族需要 Zen API key（当前凭据里没有 apiKey）')
  }
  const now = Date.now()
  if (now - catalogLoadedAt < CATALOG_TTL_MS && catalogMemory.size > 0) {
    return [...catalogMemory.values()]
  }

  let response
  try {
    // ⚠ 走账号自己的出口代理（`payload.proxy`，第 3 参）：目录是唯一的「你有权用哪些」
    // 判据，在只能经代理上网的环境里直连会超时 ⇒ 整个族看起来像坏了。
    // 不传第 4 参（非流式的短请求，5 分钟的 `bodyTimeout` 够用）。
    response = await ctx.fetch(
      OPENCODE_MODELS_URL,
      {
        method: 'GET',
        headers: opencodeHeaders(credential.auth.apiKey),
        signal,
      },
      payload?.proxy,
    )
  } catch (error) {
    throw transportError(error)
  }
  const reply = await assertApiReply(response, { who: ID })
  if (!reply.ok) {
    const text = await reply.text().catch(() => '')
    const failure = httpError(reply, text, ID)
    // ⚠ 这一层必须做：`httpError` 用的是共享的 `mapStatus`，而 401 在这一族有两个
    // 完全不同的含义（`AuthError` = 凭据废了 / `ModelError` = 模型名不对）。
    // 目录端点只会见到前者，但归类函数是同一个，写在这里是为了「这一族的 401 永远
    // 不按状态码判」这条规则只有一个出口。
    failure.code = classifyOpencodeFailure(reply.status, text)
    failure.failure = { ...failure.failure, code: failure.code }
    throw failure
  }

  const json = await reply.json().catch(() => undefined)
  const zen = parseZenModels(json)
  if (zen.length === 0) {
    // 拿到了 200 但一条模型都没有：如实抛，不要返回空目录（空目录会让宿主显示
    // 「这个 provider 没有模型」，而真相是上游回了一个我们不认识的形状）。
    const error = new Error('account-bridge: opencode 的 /models 回了一个空的模型列表')
    error.code = 'EMPTY_RESPONSE'
    error.failure = { code: 'EMPTY_RESPONSE', message: error.message }
    throw error
  }

  // models.dev 走自己的 TTL + in-flight 合并（best-effort，失败返回 `undefined`）。
  const dev = await loadModelsDev(ctx, payload)
  // ⚠ 并集规则**只在 `mergeCatalogs` 里写一遍**（并集最容易出的错是「双向都补」，
  // 那样会把用户没有权限用的模型也列出来）。这里不再手抄一段。
  const merged = mergeCatalogs(zen, dev ?? new Map())

  // ⚠ 免费档**默认滤出选择器**：实测免费模型一律 403（文件头第二节）。
  // `excludeFree` 的理由写在 `src/wire/opencode.js` 的 `isFreeTier` 上。
  const usable = excludeFree(merged)
  // 只记**真的从上游读到**的那一份（含免费档），这样 `resolveModel` 对
  // 一个已被滤掉的模型也能说清它是什么（而不是回落成保守默认值）。
  rememberCatalog(merged)
  catalogLoadedAt = Date.now()
  return usable
}

/**
 * 把一个模型名装配成宿主认得的元数据（契约 §5.3）。
 *
 * 目录记忆里的条目优先（它是上游 + models.dev 的原始值），取不到才走保守默认。
 * 与 `generic.js` 的 `catalogMemory` 同一条纪律：**兜底值不写进记忆**。
 */
export function resolveModel(provider, model) {
  const id = typeof model === 'string' ? model : ''
  const known = catalogMemory.get(id)
  return resolveOpencodeModel(id, known?.name, known ?? {}, provider ?? ROUTE)
}

/**
 * 额度：**读不到**。
 *
 * 上游没有任何余额端点，契约 §0 第五条说「没有就别实现，报假额度比不报更糟」。
 * 返回 `undefined` 让面板显示「额度未知」——这是真话。
 * ⚠ 本族**唯一**与钱有关的真实信号是 402 `Insufficient account funds`，
 * 它由失败归类承载（`ACCOUNT_QUOTA` ⇒ 池子换号），不是这里能读的读数。
 */
export async function quota() {
  return undefined
}

/**
 * 探一次凭据，给 `paste` 登录用。
 *
 * ⚠ 判据的来历值得写全，因为这里有一条**反直觉**的事实：`GET /zen/v1/models`
 * **完全不鉴权**——不带 `Authorization`、带乱写的 key 都回 **200 / 87 条**，
 * 只有带**上游认得的** key 才回**被裁剪过的**目录（本仓真机 13 条）。
 * ⇒ 「目录拿到了」证明不了任何事。**所以本函数不拿目录当凭据判据**，
 * 它拿目录**挑目标**，再用一次**对话请求**问上游「这把 key 认不认」。
 * （真机捕获里唯一那条真正的凭据判据就在对话端点上：
 * `401 AuthError` `Invalid API key.` / `Missing API key.`——`/models` 上永远拿不到它。）
 *
 * ⚠ 第一版这里探的是 `/models`，那是个**假验证**：乱写的 key 也回 200 ⇒ 判成
 * `{ok:true}`（连 `unverified` 都没有）⇒ 用户看到「密钥已保存」，第一次推理才炸 401。
 * 现在四种结果各有明确含义，一个都不含糊：
 * - `AUTH`（401 `AuthError`）⇒ **挡住**（真的不是凭据）；
 * - `ACCOUNT_QUOTA`（402）⇒ 接受 —— 它证明凭据**过了鉴权**，只是余额为零；
 * - `INVALID_REQUEST`（403 `FreeTierError`）⇒ 接受 —— 门认了这把钥匙，只是免费档不对第三方开放；
 * - 2xx ⇒ 接受（它真的答了话）。
 * - 其余非 2xx 与传输失败 ⇒ 接受但标 `unverified`（**别把「我们没验成功」说成「你的 key 不行」**）。
 *
 * 探针目标取自**这次调用自己拉到的目录**（`listModels` 已经滤掉免费档）：真 key 拿到的
 * 是**它有权用的**那一份，乱写的 key 拿到的是公开的那一份——两种情况下挑出来的付费模型
 * 都是这条线上真实存在的 id，于是「凭据」是唯一变量。
 *
 * ⚠ 代价要如实说：2xx 那条**真的会生成一次回答**，`max_tokens: 1` 把它压到最小
 * （有余额时约 1 个 token）。只发生在用户显式粘贴一次的时候，不在热路径上。
 * ⚠ 拿不到目录（网络挂了 / 上游改形状）⇒ 回落到「不验」，**不阻塞登录**：宁可说
 * 「未经验证」，也不能把一次网络故障说成「你的 key 不行」。
 * ⚠ 本函数没有端到端守卫：`test/e2e/` 的假上游不是 Zen，而这里的两个 URL 是写死的。
 *
 * @returns {Promise<{ok:boolean, status?:number, unverified?:boolean, reason?:string}>}
 */
export async function validateCredential(ctx, apiKey, signal) {
  let target
  try {
    const catalog = await listModels(ctx, { apiKey }, signal)
    target = catalog.find((entry) => typeof entry?.id === 'string' && entry.id.length > 0)?.id
  } catch {
    target = undefined
  }
  if (target === undefined) {
    return {
      ok: true,
      unverified: true,
      reason: '拿不到 Zen 的模型目录（或者这份凭据只授权了免费档），凭据未经验证——这不等于 key 不行',
    }
  }

  let response
  try {
    response = await ctx.fetch(OPENCODE_CHAT_URL, {
      method: 'POST',
      headers: opencodeHeaders(apiKey, { accept: 'application/json' }),
      // 最小请求体：一条 `ping` + `max_tokens: 1`。这里**故意**不 import `stream()` 的
      // 那套构造：探针要的是「上游认不认这把 key」，不是一次像样的推理。
      body: JSON.stringify({
        model: target,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal,
    })
  } catch (error) {
    return { ok: true, unverified: true, reason: `连接不上 Zen（${error?.message ?? error}），凭据未经验证` }
  }

  if (response?.ok) return { ok: true, status: response.status }
  const text = await response.text().catch(() => '')
  const code = classifyOpencodeFailure(response.status, text)
  if (code === 'AUTH') {
    return { ok: false, status: response.status, reason: describeOpencodeFailure(response.status, text) }
  }
  if (code === 'ACCOUNT_QUOTA' || code === 'INVALID_REQUEST') return { ok: true, status: response.status }
  return {
    ok: true,
    status: response.status,
    unverified: true,
    reason: `Zen 回了 HTTP ${response.status}，凭据未经验证：${describeOpencodeFailure(response.status, text)}`,
  }
}

/** 诊断上报：`options.onDiagnostic` 不存在时是一个空函数。 */
function diagnosticReporter(ctx, onDiagnostic) {
  return (event) => {
    try {
      if (typeof onDiagnostic === 'function') onDiagnostic(event)
    } catch {
      // 诊断通道自己炸了不该让一次推理失败。
    }
    // 不往 ctx.log 里写每条诊断：那是宿主日志，会淹没真问题。
    void ctx
  }
}

/**
 * 推理。
 *
 * 请求体是**最少且被广泛支持**的形状（文件头第三节）：`model` / `messages` /
 * `stream: true` / `max_tokens` / `tools`。
 * **不发** `stream_options`（usage 少一次只是账不准）、**不发** `reasoning_effort`
 * （三项都未验 ⇒ 少发一个字段少一个失败面），改发一条 `NOT_SENT` 诊断说明为什么不发。
 */
export async function* stream(ctx, options = {}) {
  const { payload, model, messages, tools, system, maxTokens, signal } = options
  const report = diagnosticReporter(ctx, options.onDiagnostic)

  const credential = credentialOf(payload)
  if (!credential.usable) {
    throw missingCredential('account-bridge: opencode 这一族需要 Zen API key（当前凭据里没有 apiKey）')
  }

  const body = {
    model,
    messages: toChatMessages(messages, { onDiagnostic: report }),
    stream: true,
    max_tokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : CONSERVATIVE_MAX_TOKENS,
  }
  const prompt = toChatSystem(system, messages)
  if (prompt.length > 0) body.messages = [{ role: 'system', content: prompt }, ...body.messages]
  const chatTools = toChatTools(tools)
  if (Array.isArray(chatTools) && chatTools.length > 0) body.tools = chatTools

  if (isFreeTier({ id: model }).free) {
    // 免费档必然 403（实测）。**不拦在这里**：拦下来会让用户看到一条我们编的错，
    // 而上游那条 403 的报文本身就把原因说清楚了（`describeOpencodeFailure` 还会补一句
    // 「换号重试都没用」）。这里只**提前说一声**，让日志里能看出我们预见到了。
    report({
      code: 'FREE_TIER_MODEL',
      severity: 'info',
      phase: 'request',
      message: '这个模型属于 Zen 的免费档，对第三方客户端一律 403（实测）——预期这次会失败',
    })
  }
  report({
    code: 'NOT_SENT',
    severity: 'info',
    phase: 'request',
    message: '未发送 stream_options / reasoning_effort：本仓无法验证 Zen 是否接受这两个字段（探针实测网关不做请求体校验），少发一个未验的字段就少一个失败面',
  })

  let response
  try {
    response = await ctx.fetch(OPENCODE_CHAT_URL, {
      method: 'POST',
      // ⚠ 第 4 个参数是 `streaming = true`：契约 §5 要求流式调用点传 true，
      // 代理通道才会关掉默认 5 分钟的 `bodyTimeout`（长回答会被它掐断）。
      headers: opencodeHeaders(credential.auth.apiKey, { accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal,
    }, payload?.proxy, true)
  } catch (error) {
    if (signal?.aborted) throw error
    throw transportError(error)
  }

  const reply = await assertApiReply(response, { who: ID })
  if (!reply.ok) {
    const text = await reply.text().catch(() => '')
    const waitMs = retryAfterMs(reply.headers)
    const failure = httpError(reply, text, ID)
    // ⚠ 覆盖 `httpError` 的状态码归类（本族最重要的那一条）：
    // 401 可能是 `ModelError`、403 可能是 `FreeTierError`，两者都与凭据无关，
    // 照状态码会把一个健康账号冷 24 小时。
    failure.code = classifyOpencodeFailure(reply.status, text)
    failure.message = `${ID}: ${describeOpencodeFailure(reply.status, text)}`
    failure.failure = { ...failure.failure, code: failure.code, message: failure.message }
    if (waitMs !== undefined) failure.failure = { ...failure.failure, providerRetryAfterMs: waitMs }
    report({
      code: 'UPSTREAM_REJECTED',
      severity: 'error',
      phase: 'response',
      message: failure.message,
    })
    throw failure
  }

  yield* translateChatStream(reply, { signal, onDiagnostic: report })
}

/**
 * 本族的真机验证状态（照 codearts 的 `CODEARTS_VERIFICATION` 写法）。
 *
 * 写成**导出常量**而不是只写注释，是因为探针能断言一个字符串、不能断言一句注释。
 * 取值含义：route 与元数据面已验证，**一次真实推理都没有跑通**
 * （那把 key 没余额，免费档又对第三方客户端关闭）。
 */
export const OPENCODE_VERIFICATION = 'route-and-metadata-only-no-live-inference'

/** 对外暴露的证明常量，供 README 与探针引用（避免两处各写一个数）。 */
export const OPENCODE_CONSERVATIVE = {
  contextWindow: CONSERVATIVE_CONTEXT_WINDOW,
  maxTokens: CONSERVATIVE_MAX_TOKENS,
}

/** 族对象（形状见 `docs/family-contract.md` §2）。 */
export const opencodeFamily = {
  id: ID,
  displayName: DISPLAY_NAME,
  route: ROUTE,

  /**
   * 风险：**`medium`** —— 本仓唯一一个不是 `high` 的族，理由要写全，否则会被当成漏填。
   *
   * 别家 OAuth 族的 `high` 来自一个共同的风险面：**本插件会替上游客户端续期令牌**，
   * 于是「续期一次就把 CLI 的登录态转走/顶掉」这件事始终悬着（`raccoon` 的
   * 「保留旧 refresh_token」那条教训就是它的形状）。本族**根本没有这个面**：
   * - 凭据是本机 CLI 写下的**静态 API key，不过期**，本族不实现 `refresh`
   *   ⇒ 不存在「插件与 CLI 抢着续期」的失配，也不会把用户的登录态转走；
   * - 本族**不写**那个 `auth.json`（只读），所以它不会破坏 OpenCode 自己的登录态；
   * - 免费档已滤出选择器（实测必然 403），目录与能力表都是只读拉取。
   *
   * 那为什么不是 `low`：**真机推理一次都没验过**（文件头第七节）——`stream()` 的成功路径
   * 只有假上游的证据。另外本机没有第二个进程会替这把 key 做任何事，
   * 用户改密码/吊销 key 时本仓只能靠一次 401 才发现。
   * 诚实的分级是「凭据面比别家轻，但行为面证据最少」⇒ `medium`。
   */
  risk: 'medium',

  discover,
  recordFromDiscovery,

  login: {
    /**
     * ⚠ 只有 `paste` —— **故意不做 `browser`**。
     *
     * 本仓的登录面只有 `src/login/broker.js` 那个非交互中介（它只自动回答
     * **单选项 select**，其余一律抛 `DECLINED`），没有在真实浏览器里完成一次
     * OpenCode 登录并把它写回 CLI 的 `auth.json` 的通道。
     * 「拿不准就不做，如实只留 paste」：一个半成品的 browser 登录比没有更坏——
     * 用户会点它、会卡在中途，而错误信息说不出为什么。
     *
     * 用户自己的路径也很短：在 OpenCode 里登录一次，本族的 `discover()`
     * 就能把 `auth.json` 里那条 key 导进来；或者直接粘贴 key。
     */
    methods: [
      { id: 'paste', label: '粘贴 OpenCode Zen 的 API key（sk-…）' },
    ],

    /**
     * 两步：问 key → 验 → `commit`。
     *
     * ⚠ 三条契约硬规矩（与 codearts 同款，踩过才有这一节）：
     * - 签名是 `run(session, ctx)` —— **两个位置参数**，不是 `{session}`；
     * - `session.prompt` 只有三种 kind，**没有 `initial`/`default` 字段**；
     * - `commit` 的形状是 `{kind:'grant', payload: <池子记录>}`，且**必须排在
     *   `run` 返回之前**（晚一步宿主抛 `NOT_COMMITTED`）。
     *
     * ⚠ 验证失败要**如实拒绝**（`src/login` 的语义是「用户看到的失败」），
     * 但「验不出来」不能当成「key 不行」——`validateCredential` 把两类分开返回。
     */
    async run(session, ctx) {
      const key = String((await session.prompt({ kind: 'secret', message: 'OpenCode Zen API key（sk-…）' })) ?? '').trim()
      if (key.length === 0) {
        throw missingCredential('account-bridge: opencode 需要一个 Zen API key，粘贴的是空值')
      }
      const auth = { apiKey: key }
      const verdict = await validateCredential(ctx, key)
      if (!verdict.ok) {
        throw missingCredential(`account-bridge: opencode 不接受这把密钥 —— ${verdict.reason ?? '上游判定凭据无效'}`)
      }
      await session.commit({ kind: 'grant', payload: recordFromAuth(auth, labelFor(auth), 'manual', false) })
      await session.notify({
        message: verdict.unverified
          ? `Zen 密钥已保存，但**未经验证**：${verdict.reason ?? '上游没有给出明确的接受信号'}。`
          : 'Zen 密钥已保存，并已向 Zen 确认过这把密钥有效。⚠️ 它不过期，所以没有「续期」这回事；被吊销时会在一次 401 之后被发现。',
      })
    },
  },

  listModels,
  resolveModel,
  quota,
  stream,
}
