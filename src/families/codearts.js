/**
 * CodeArts（华为云）族：把 snap-access 网关上那个 OpenAI 兼容的对话端点接进池子。
 *
 * 这一族的形状与 `./raccoon.js` 一致（那是本仓最新、最干净的样板）：协议细节全在
 * `../wire/codearts.js`，这里只做「凭据 → 请求 → 流」的编排。下面逐条写**为什么**。
 *
 * ## 一、续期：有一个**刻意的 no-op** `refresh`，而 `needsRefresh` 恒 `false`
 *
 * CodeArts 的凭据是华为云**临时**凭据（STS 三件套：`access_key_id` /
 * `secret_access_key` / `security_token`）。它**没有 refresh_token** —— 参考实现的
 * 续期路径是重新走一遍登录拿一份新的（`src/service.ts` 里那套 DPoP + PKCE 的
 * `/snap-manager/v1/login/ticket` 流程），本仓**不做**（没有浏览器通道）。
 *
 * 所以本族的 `refresh` 是**刻意的 no-op**：它不换凭据，只是把白名单里的键原样返回
 * ——存在的唯一理由是账号卡片的「刷新」按钮走 `src/pool.js` 的
 * `family.refresh(...)` 且**那一行没有可选链**（省略了就是个 TypeError）。
 * 同一个决定在 `zcode` / `commandcode` 里已经做过两次。
 *
 * ⚠ 配套的一条更重要：`needsRefresh` **必须恒返回 `false`**。池子在
 * `src/pool.js` 的 `#freshPayload()` 里先问 `needsRefresh?.()`，为真就去
 * `refreshAccount()`；本族的 no-op 不会让 `expires_at` 前进，所以在这里返回 `true`
 * 等于**每个请求**白跑一次刷新（还会把模型目录缓存清掉）。详见该方法的注释。
 *
 * 代价要说清楚：**池子没有续期可用**，所以凭据一过期，本族只能靠换号撑；
 * 池里只有一个 CodeArts 账号时，那一个过期就等于这一族不可用。
 * 唯一能提前看到的信号是面板上的「token 已过期」红字——它读凭据里的数字
 * `expiresAt`，由 `authFromPayload` 从上游给的 `expires_at` 归一而来（解析不出来就不补，
 * **不编寿命**）。
 *
 * ## 二、benefit 模型要**两次尝试**，而且第二次不能算账号失败
 *
 * benefit（免费额度）模型（`glm-5.3-flash`、`deepseek-v4.1-flash`）必须带
 * `maas_type: benefit`，否则 `404 InferHub.002002009.404 "model is not registered"`；
 * 而账号**没有 benefit 包**时，带上该头的请求会 **HTTP 200 + SSE 里报
 * `InferHub.4004.200 benefit not found`**（参考实现 `llm-adapter.ts` 真机实测）。
 *
 * 于是正确处置是**补上或去掉这个头各重试一次**——同一个账号、同一个模型、同一份凭据。
 * ⚠ 这条重试**绝不能走池子的换号**：`health.js` 看到 `404`/SSE 内嵌错误会把它
 * 当成账号或上游失败，而「这个账号没有 benefit 包」换多少个号都一样。
 * 所以重试发生在**族内部**（`stream()` 里的 `benefitOverride` / `tried` 那一对状态），
 * 且重试成功后**不产生任何失败信号**。
 *
 * 反方向的坑同样要防：`maas_type: benefit` **必须参与签名**（它是纯净的请求头，
 * 不是后置头），而 `Agent-Type` / `X-Language` **绝不能参与签名**——本仓 2026-10-11
 * 真机捕获过：`x-security-token` 格式不对时网关回 `400 {"error_code":"APIG.0602"}`，
 * 而参考实现用真实凭据实测过「后置头进了 canonical request ⇒ 恒 401 APIG.0301」。
 *
 * ## 三、`max_tokens` 必须自己钳到 65536
 *
 * 参考实现实测：**65536 可用、131072 触发空流**（上游回
 * `The request param is invalid`）。而 DSH 的 `maxTokens` 是一等构造参数，
 * 只校验「正安全整数」、**没有上限**，且会从一个 provider 带到另一个 provider。
 * 所以最后一道防线在这里。
 *
 * ## 四、并发上限（`TM.00001041`）不是账号的错
 *
 * CodeArts **按账号**限并发。超了以 `TM.00001041`（"并发会话数已达上限"）失败，
 * 也可能是 SSE 里的 `InferHub.ModelArts.81111.429`（TPM 超限）。
 * 这类失败**不该写账号冷却**——账号是好的，只是此刻轮不到。故 `stream()` 把它
 * 归成 `RATE_LIMIT`（`health.js`：换号 + 5 分钟），而**不是** `ACCOUNT_QUOTA`
 * （那是 24 小时）。
 *
 * ## 五、会话与缓存键
 *
 * `prompt_cache_key` 缺了缓存命中**恒为 0**（参考实现实测 2026-08-24），
 * 所以它必须按**账号 + 会话**派生；同理 `Chat-Id` / `Session-Id` 两个头。
 * 三者都经 `accountScopedSession()`（`../wire/identity.js`）派生——
 * ⚠ 拿不到 `account.id` 或 `session` 时**一个标识字段都不发**（契约硬规矩）。
 *
 * ## 六、借来的东西
 *
 * 本文件与 `../wire/codearts.js` 的协议事实、端点、码值、字段名全部来自参考实现
 * `dsh-codearts-auth`（Gitee，MIT，`Copyright (c) 2026 Jet`），逐条登记在仓根的
 * `THIRD_PARTY_NOTICES.md` 里。签名算法照 `temp/codearts/src/sign.ts` 用
 * `node:crypto` 重写（它用 `crypto.subtle`，本仓不依赖 `globalThis.crypto`）。
 *
 * ## 七、本族的验证状态：**真机推理未验**
 *
 * 本机没有华为云账号、没装 CodeArts 客户端、`~/.codearts` 与 `~/.cache/deveco`
 * 都不存在（2026-10-11 核实），所以下面这些**只到「端到端验到 route 与元数据」**：
 * 真实推理、benefit 重试、并发上限、积分读数**一条都没在真机上跑过**。
 * 唯一真机捕获的是**无效凭据的错误信封**（见 `THIRD_PARTY_NOTICES.md` 的捕获段）。
 * 上面写的每一条协议事实都是「从参考实现读来的」，不是本仓实测的。
 */

import { existsSync } from 'node:fs'
import { accountScopedSession } from '../wire/identity.js'
import { assertApiReply } from '../wire/assert-reply.js'
import { diagnosticReporter } from '../wire/diagnostics.js'
import { httpError, retryAfterMs } from '../wire/http-error.js'
import { toChatSystem, toChatMessages, toChatTools, translateChatStream } from '../wire/chat-completions.js'
import {
  CODEARTS_BUILTIN_MODELS_URL,
  CODEARTS_CHAT_AGENT_TYPE,
  CODEARTS_CHAT_URL,
  CODEARTS_GATEWAY_CONFIG_URL,
  CODEARTS_MAX_OUTPUT_TOKENS,
  CODEARTS_PACKAGE_INFO_URL,
  classifyCodeArtsFailure,
  codeArtsCredentialShape,
  codeArtsExpiryOf,
  codeArtsHeaders,
  codeartsReadHeaders,
  describeCodeArtsFailure,
  isBenefitModel,
  isBenefitNotFound,
  parseCodeArtsAccountInfo,
  parseCodeArtsCredits,
  parseCodeArtsModels,
  signCodeArtsRequest,
} from '../wire/codearts.js'

export const ID = 'codearts'
export const ROUTE = 'acct-codearts'
export const DISPLAY_NAME = 'CodeArts (华为云)'

/**
 * 上下文窗口的保守默认。
 *
 * 这一家**绝大多数模型没公开容量**（参考实现的原话：「其余模型未公开上下文容量，
 * 留 undefined 让后端裁剪」），而契约要求「不知道的值宁可保守也不要编」。
 * 故默认取 131072——与已知最小的那个（`GLM-5.2` = 202752）相比明显更小，
 * 宁可少装一点上下文，也不要在用户那里撞一次「prompt is too long」。
 */
const CONSERVATIVE_CONTEXT_WINDOW = 131_072

/** 单次输出上限的保守默认。等于上游的硬边界（见文件头第三节）。 */
const CONSERVATIVE_MAX_TOKENS = CODEARTS_MAX_OUTPUT_TOKENS

/**
 * 参考实现 `llm-adapter.ts:54-72` 的 `CONTEXT_WINDOWS`，逐条带它的出处。
 *
 * ⚠ 只抄这五个：它们是参考实现**写明出处**的那几个（IDE 模型卡 / gateway 配置 /
 * UI 标注）。其余模型一律走 `CONSERVATIVE_CONTEXT_WINDOW`——**不给一个自己编的数**。
 * 参考实现在这里留 `undefined` 是让**它的**后端裁剪；本仓的 `resolveModelInfo`
 * 需要一个具体数字（`context.contextWindow` 是必填），所以这里是保守回落而不是留空。
 */
const CONTEXT_WINDOWS = new Map([
  ['GLM-5.2', 202_752],
  ['glm-5.3-flash', 1_048_576],
  ['deepseek-v4-flash', 1_048_576],
  ['deepseek-v4-pro', 1_048_576],
  ['deepseek-v4.1-flash', 1_000_000],
])

/**
 * 两处目录都读不到时的兜底表（参考实现 `llm-adapter.ts:39-53` 的 `DEFAULT_MODELS`）。
 *
 * ⚠ benefit 属性**不在**这张表里：它由 `isBenefitModel()` 判（目录优先、静态兜底），
 * 而「名字带 flash 就是 benefit」是参考实现**踩过并修掉**的错判
 * （`glm-5.3-flash` 是 benefit，`deepseek-v4-flash` 不是）。
 */
export const FALLBACK_MODELS = Object.freeze([
  'GLM-5.2',
  'GLM-5.1',
  'GLM-5',
  'glm-5.3-flash',
  'openpangu-2.0-flash',
  'openpangu-2.0-pro',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
])

/**
 * 模块级记忆（只在内存里，进程重启即失）。
 *
 * `catalogCache` 存**真读到过**的目录条目，`benefitKnown` 记「gateway 那条腿读到过」
 * ——后者决定 `isBenefitModel` 能不能信目录：gateway 腿失败时目录里一个 benefit
 * 模型都不会有，此时**回落静态兜底表**才是对的（否则 benefit 模型会漏带那个头而 404）。
 */
const catalogCache = new Map()
let benefitKnown = false

/**
 * 积分读数记忆。
 *
 * ⚠ 存的是**整份读数**（可能是 `undefined`）而不是「数字」：`undefined` 的语义是
 * 「这个账号没有积分口径」（Token 计费），与 `total: 0`（有口径、余额恰好 0）
 * 是两件事。`quota()` 读不到时返回 `undefined`，面板就显示「额度未知」。
 */
let creditsMemory = { at: 0, reading: undefined }

/** 读一次积分之后多久内不重复读（面板每 30 秒刷一次，不该每刷一次打一个请求）。 */
const CREDITS_TTL_MS = 60_000

function warn(ctx, message) {
  try {
    if (typeof ctx?.log?.warn === 'function') ctx.log.warn(message)
    else if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
  } catch {
    // 日志本身不该成为失败原因。
  }
}

/** 从池子给的 payload 里取凭据。`usable` 判的是**三件套齐全**（见 wire 的注释）。 */
function credentialOf(payload) {
  return codeArtsCredentialShape(payload?.auth ?? payload ?? {})
}

/** 传输层错误包装。`TRANSPORT` 在 `health.js` 里是「换号但**不记冷却**」——正是它该得的。 */
function transportError(error) {
  const wrapped = new Error(`codearts: ${error?.message ?? error}`)
  wrapped.code = 'TRANSPORT'
  wrapped.failure = { code: 'TRANSPORT', message: wrapped.message }
  wrapped.cause = error
  return wrapped
}

function missingCredential(message) {
  const error = new Error(message)
  error.code = 'MISSING_CREDENTIAL'
  error.failure = { code: 'MISSING_CREDENTIAL', message }
  return error
}

/**
 * 把 `maxTokens` 钳进安全区间；非法值返回 `undefined`（**不编造**，由调用方取默认）。
 *
 * ⚠ 不能用 `src/util.js` 的 `clamp()`：那个函数对非字符串**原样返回**（它只截断
 * 日志文本），拿它钳数字会静默失效。
 */
function clampMaxTokens(value) {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) return undefined
  const integer = Math.floor(number)
  if (integer <= 0) return undefined
  return Math.min(integer, CODEARTS_MAX_OUTPUT_TOKENS)
}

/**
 * 本机有哪些 CodeArts 客户端可能留下的位点（**纯声明，不碰文件系统**）。
 *
 * ⚠ **本族刻意不实现 `recordFromDiscovery`**，理由是**查过、确实没有可导入的位点**：
 *
 * - CodeArts 的凭据**不落在一个固定的凭据文件里**。参考实现的凭据存储走的是
 *   DSH 自己的 `ctx.credentials`（`CODEARTS_ACCOUNT_XXX`），IDE 那边则由插件在
 *   登录后自己拿着用，本机不存盘。
 * - 参考实现里唯一与本机相关的落点是 `~/.cache/deveco/`（模型目录缓存，
 *   `models.ts` 的 `CODEARTS_MODELS_CACHE_DIR`，`DSH_CODEARTS_CACHE_DIR` 可覆盖），
 *   但那是**目录缓存不是凭据**，导进来也没有鉴别信息。
 * - 2026-10-11 本机核实：`~/.codearts`、`~/.cache/deveco`、
 *   `~/AppData/Roaming|Local/Huawei`、`~/AppData/Roaming|Local/JetBrains`、
 *   `~/.config/JetBrains` **一个都不存在**。
 *
 * 所以这一族只能靠 `paste` 登录。`discover()` 仍然如实报「查过哪些位点」，
 * 让用户能复核是不是查错了地方（`docs/family-contract.md` 对 discover 的要求是
 * 「没找到候选位点返回 `[]`」，而这里**有位点要交代**：用户该知道为什么导不进来）。
 *
 * ⚠ 本函数**不碰文件系统**，只做字符串拼装（与 `raccoonDataDirs` 同款）：
 * 探测存在性是调用方（`discover()`）的事，纯声明的函数里读盘会让它变得不可测。
 * 也正因为如此，这里**只描述「这个位点是什么」，不断言它存不存在**——
 * 那句判断必须来自一次真查（见 `discover()`）。
 */
export function codeartsDiscoveryCandidates({ env = process.env, platform = process.platform, home } = {}) {
  const root = home ?? env.USERPROFILE ?? env.HOME ?? ''
  const separator = platform === 'win32' ? '\\' : '/'
  const join = (...parts) => parts.filter((part) => part.length > 0).join(separator)
  const candidates = [
    {
      sourcePath: join(root, '.cache', 'deveco'),
      label: 'CodeArts 模型目录缓存',
      note: '参考实现在这里存模型目录缓存（`codearts_models.json`），**从来没有凭据**',
    },
    {
      sourcePath: join(root, '.codearts'),
      label: 'CodeArts 客户端数据目录',
      note: 'CodeArts 客户端的临时凭据不落盘（参考实现的凭据走 DSH 自己的凭据存储）',
    },
  ]
  const cacheOverride = env.DSH_CODEARTS_CACHE_DIR
  if (typeof cacheOverride === 'string' && cacheOverride.trim().length > 0) {
    candidates.unshift({
      sourcePath: cacheOverride.trim(),
      label: 'CodeArts 模型目录缓存（DSH_CODEARTS_CACHE_DIR 指定）',
      note: '同上：这个覆盖点指向的仍是模型目录缓存，不是凭据',
    })
  }
  return candidates
}

/**
 * 这一族。
 *
 * `risk: 'high'`，理由（不是「新代码所以高」这种空话）：
 *
 * 1. **没有续期**：凭据一过期就没有任何自愈路径，只能人工重新登录；
 * 2. **真机推理未验**：本机没有可用账号，`stream()` 的正路（含 benefit 两次尝试）
 *    **一次都没在真机上跑过**——签名是自己按 `sign.ts` 重写的 HMAC，写错一个
 *    字节就是恒 401，而本仓验不出来；
 * 3. **凭据形态比别家重**：三个值缺一不可，而它们来自一次**交互式登录**
 *    （用户要从别处把三个值抄过来），抄错任何一个的表现都是 401。
 */
export const codeartsFamily = {
  id: ID,
  displayName: DISPLAY_NAME,
  route: ROUTE,
  risk: 'high',

  /**
   * 本机发现：如实报「查过哪些位点、为什么导不进来」。
   *
   * ⚠ **返回一条**（而不是每个位点一条），与 `raccoon` 同款：这一族的情况不是
   * 「有位点但格式不对」，而是**根本不存在任何凭据位点**（见 `codeartsDiscoveryCandidates`
   * 的长注释）。`src/tools.js` 渲染「有凭据但导不进来」时**只打印 `label` 与 `reason`、
   * 不打印 `sourcePath`**（`importable: true` 的条目才会带上来源），所以「查过哪些路径」
   * **必须写进 reason**，否则用户没有任何可复核的凭据 —— 这正是 `raccoon` 那条
   * reason 里列路径的原因，也是本仓探针对这一族断言路径出现的原因。
   *
   * ⚠ 这里的「在不在」是**真查**出来的（`existsSync`，只读目录不读内容）：客户端不落盘
   * 登录态，所以**不存在**该读的文件，无谓地遍历只会把「不存在」混淆成「读失败了」。
   * 同理不能反过来把「本机不存在这个目录」写成一个常量——换一台机器就是假话。
   *
   * 只有当**真的**在某个位点看到可导入的凭据时才返回 `importable: true` ——
   * 这里没有这种情况，于是返回值恒为「有候选位点但导不进来」。
   * 与 ZCode 那条注释同一个道理：**「读不出来」不等于「没有」**，
   * 但也**不能把「没有位点」说成「有位点」**——所以 reason 里逐条写清每个位点是什么。
   */
  discover() {
    const candidates = codeartsDiscoveryCandidates()
    const listing = candidates
      .map(({ sourcePath, label, note }) => {
        let exists = false
        try {
          exists = existsSync(sourcePath)
        } catch {
          // 权限/路径异常不是「找到了」——当作没查到，但 reason 里照实说「没查到」。
          exists = false
        }
        const verdict = exists ? '这个目录在本机存在' : '本机不存在这个目录（或读不到）'
        return `- \`${sourcePath}\`（${label}）：${verdict}；${note}`
      })
      .join('\n')
    return [
      {
        family: ID,
        sourcePath: candidates[0]?.sourcePath ?? '',
        label: 'CodeArts（华为云）临时凭据',
        importable: false,
        reason:
          '本机没有可导入的 CodeArts 凭据位点：这一族的凭据是华为云**临时**凭据（STS 三件套），' +
          '由一次交互式登录签发、只在登录进程里活着，磁盘上不落盘。' +
          `已查过 ${candidates.length} 个候选位点：\n${listing}\n` +
          '本族的登录方式只有「粘贴三件套」——请在设置页用它手工添加账号。',
      },
    ]
  },

  login: {
    /**
     * ⚠ 只有 `paste` ——**故意不做 `browser`**。
     *
     * 参考实现有完整的浏览器登录（`login.ts` 的 ticket + 轮询、`oauth.ts` 的
     * DPoP/PKCE），但本仓要落地它需要两件本仓没有的东西：
     * ① 一个能跑 `crypto.subtle` 椭圆曲线签名的 DPoP 密钥对（零新依赖下要另写一大段）；
     * ② 一个**在真实浏览器里**完成华为认证页跳转的通道，而本仓登录面只有
     *    `src/login/broker.js` 那个非交互中介（它只自动回答**单选项 select**，
     *    其余一律 `DECLINED`）。
     *
     * 「拿不准就不做，如实只留 paste」是任务与契约一致的要求：一个半成品的
     * browser 登录比没有更坏——用户会点它、会卡在中途，而错误信息说不出为什么。
     * 所以这一族的能力面如实只有 paste。
     */
    // ⚠ 形状是 `[{id, label}]`（契约 §4.1 写明）：`src/api.js` 只取这两个键，
    // 写成 `name` / `description` 会让设置页显示一行空白的方法名。
    methods: [
      { id: 'paste', label: '粘贴华为云临时凭据（AK / SK / SecurityToken）' },
    ],

    /**
     * 逐项问三个值 → 组记录 → `commit`。
     *
     * ⚠ 四条要点（前三条是契约硬规矩，第四条是本族自己踩出来的形状）：
     * - 签名是 `run(session, ctx)` —— **两个位置参数**，不是 `{session}`；
     * - `session.prompt` 只有三种 kind，**没有 `initial`/`default` 字段**，
     *   所以这里不试图回填任何默认值；
     * - 三个值都是 `kind: 'secret'`（**密码类必须用 secret**，它不会被回显到界面上）。
     *   `security_token` 虽然叫 token，但它是鉴权材料的一部分，与 SK 同级，一并用 secret；
     * - `commit` 的形状是 `{ kind: 'grant', payload: <池子记录> }`，payload 必须是
     *   `recordFromAuth()` 那一份（**不是**裸 auth：池子读的是 `payload.auth`），
     *   且它**必须排在 `run` 返回之前**，晚一步宿主抛 `NOT_COMMITTED`。
     */
    async run(session) {
      const ak = String((await session.prompt({ kind: 'secret', message: 'access_key_id（AK）' })) ?? '').trim()
      const sk = String((await session.prompt({ kind: 'secret', message: 'secret_access_key（SK）' })) ?? '').trim()
      const token = String((await session.prompt({ kind: 'secret', message: 'security_token（临时凭据的第三个值）' })) ?? '').trim()
      const missing = []
      if (ak.length === 0) missing.push('access_key_id')
      if (sk.length === 0) missing.push('secret_access_key')
      if (token.length === 0) missing.push('security_token')
      if (missing.length > 0) {
        throw missingCredential(`account-bridge: codearts 需要临时凭据三件套，缺 ${missing.join(' / ')}`)
      }
      // `expires_at` 无从得知（用户粘贴的三件套里没有它）⇒ **留空而不是编一个**。
      // ⚠ 留空之后面板上不会显示有效期 —— 这是这套凭据的真实情况（三件套里就没有
      // 过期时刻），编一个 +24h 只会让界面显示一个假的日子。
      const auth = { access_key_id: ak, secret_access_key: sk, security_token: token }
      await session.commit({ kind: 'grant', payload: recordFromAuth(auth, labelFor(auth), 'manual', false) })
      await session.notify({
        message: 'CodeArts 临时凭据已保存。⚠️ 它没有 refresh_token，过期后需要重新粘贴一次。',
      })
    },
  },

  /**
   * **刻意的 no-op**（与 `zcode` / `commandcode` 同一个决定，本族的理由更硬）：
   * CodeArts 的临时凭据**没有 refresh_token**，上游也没有「续期」这个动作
   * ——过期只能重新登录（见文件头第一节）。
   *
   * ⚠ 为什么仍然要实现它，而不是省略：
   * - 账号卡片的「刷新」按钮走 `src/api.js` 的 `adapter.refreshAccount()`
   *   → `src/pool.js` 的 `refreshAccount()` 里的 `family.refresh(...)`，
   *   **那一行没有可选链**。省略了，用户点到的就是一个 TypeError，而不是一句人话。
   *   （本族目前**不会**显示那个按钮：`publicAccount().renewable` 要求凭据里有一个
   *   字符串 `refresh`，本族没有——但那是界面层的巧合，不该拿它当「这里可以不实现」的理由。）
   * - 它也是给未来的自己的落点：哪天华为云给出续期端点，改这一个函数即可。
   *
   * ⚠ 返回**新的 auth 对象**（池子做浅合并 `{...current.auth, ...returned}`）：
   * 走 `authFromPayload` 的白名单原样带回去。返回 `{}` 会把凭据从记录里**抹掉**
   * ——用户点一下「刷新」等于把账号删了。缺件时如实抛 `MISSING_CREDENTIAL`
   * （与 `stream()` 同一句话），而不是假装续期成功。
   */
  async refresh(ctx, payload) {
    const credential = credentialOf(payload)
    if (!credential.usable) {
      throw missingCredential(
        `account-bridge: codearts 需要 access_key_id / secret_access_key / security_token 三件套（当前缺 ${credential.missing.join(' / ')}）`,
      )
    }
    return authFromPayload(payload)
  },

  /**
   * **恒 `false`，且这是本族最反直觉的一处**，理由必须写全否则会被人「修好」成崩溃：
   *
   * - 池子唯一的消费点是 `src/pool.js` 的 `#freshPayload()`：
   *   `if (!family.needsRefresh?.(account)) return account` → 否则 `refreshAccount()`
   *   → `auth = await family.refresh(this.#ctx, account, undefined)`（`refreshAccount()`）。
   *   本族一旦在这里返回 `true`，**每一个请求**都会走进一次 `refreshAccount`
   *   ——而它不可能改善任何东西：上面那个 `refresh` 是 no-op，返回的 auth 与原样一样
   *   ⇒ `expires_at` 不变 ⇒ 下一次请求 `needsRefresh` 又是 `true`，于是**每次请求**
   *   都白跑一次（它还会 `#catalogs.delete()`，把模型目录缓存一起清掉、每次重新打两处目录端点）。
   * - **提醒不会因此丢掉**：面板上的「token 已过期」红字读的是凭据里的**数字** `expiresAt`
   *   （`src/api.js` 的 `publicAccount()` + `src/client.js` 的那条判据），
   *   `authFromPayload` 会把上游给的 `expires_at` 归一成它；真过期时上游还会给
   *   `401 APIG.0301`，本族把它归 `AUTH`，池子换号 + 长冷却 —— 那才是「该重新登录了」
   *   的真实信号。参考实现在这里回落 `+24h` 是它自己的估计值，编一个寿命只会让提醒
   *   出现在一个假的时间点上。
   * 这一条与 `zcode` / `trae` / `commandcode` 三族的决定一致：**不能续期的族不得声称需要续期**。
   */
  needsRefresh() {
    return false
  },

  /**
   * 模型目录：读**两处**，合并去重。
   *
   * 两处都在签名后追加 `Agent-Type: PromptCenter` / `X-Language: zh-cn` / `Content-Type`：
   * 参考实现明确把「对话端点用 `INFERHUB_AGENT`」与「目录端点用 `PromptCenter`」分开写，
   * 本仓照抄这个分家。⚠ 这两个头**必须后置**（见文件头第二节）。
   *
   * 任一条腿失败都降级（`warn` + 用另一条腿的结果），**两条都失败**才回落兜底表。
   * 只有 `outcome` 两条腿都 ok 时才把 `benefitKnown` 置真——否则 benefit 判定会
   * 采信一份「gateway 腿其实没读到」的目录。
   */
  async listModels(ctx, payload, signal) {
    const { auth, usable } = credentialOf(payload)
    if (!usable) {
      warn(ctx, 'account-bridge: codearts 的凭据缺少临时凭据三件套，模型目录改用兜底列表')
      return fallbackCatalog()
    }
    let gateway
    let builtin
    try {
      gateway = await readSigned(ctx, payload, auth, CODEARTS_GATEWAY_CONFIG_URL, signal)
    } catch (error) {
      warn(ctx, `account-bridge: codearts 读 benefit 目录失败（${error?.message ?? error}），这一条腿跳过`)
    }
    try {
      builtin = await readSigned(ctx, payload, auth, CODEARTS_BUILTIN_MODELS_URL, signal)
    } catch (error) {
      warn(ctx, `account-bridge: codearts 读常规模型目录失败（${error?.message ?? error}），这一条腿跳过`)
    }
    if (gateway === undefined && builtin === undefined) return fallbackCatalog()
    const { models, outcome } = parseCodeArtsModels({ gateway, builtin })
    if (outcome.gatewayOk) benefitKnown = true
    for (const entry of models) catalogCache.set(entry.id, entry)
    if (models.length === 0) {
      // ⚠ 「两条腿都 ok 但都是空列表」是**合法状态**（账号一个模型都没有）。
      // 此时**不能**用兜底表盖住它——那会让面板显示一堆这个账号其实用不了的模型。
      // 只有「腿失败」才回落；这里两条腿都成的情况下如实返回空。
      if (outcome.gatewayOk || outcome.builtinOk) return []
      return fallbackCatalog()
    }
    return models.map((entry) => modelInfo(entry.id, entry.name, entry, ROUTE))
  },

  /**
   * 单个模型的元数据。
   *
   * 先查**本进程真读到过**的目录，再查兜底表，都没有就按保守默认回一条
   * （契约：`resolveModel` 取不到才回保守默认，**不要因为没见过就返回 undefined**——
   * 那会让模型在下拉框里消失）。
   */
  resolveModel(provider, model) {
    const id = typeof model === 'string' && model.trim().length > 0 ? model.trim() : String(model ?? '')
    const known = catalogCache.get(id)
    if (known !== undefined) return modelInfo(known.id, known.name, known, provider ?? ROUTE)
    if (FALLBACK_MODELS.includes(id)) return modelInfo(id, id, {}, provider ?? ROUTE)
    return modelInfo(id, id, {}, provider ?? ROUTE)
  },

  /**
   * 积分 / 额度读数。
   *
   * 走 `/snap-manager/v1/statistics/plugin`（参考实现说它是「积分账户检测的唯一真相源」），
   * 头与目录端点同款（后置 `PromptCenter` 那一套）。
   *
   * ⚠ 三条如实：
   * - **读不到就返回 `undefined`**（面板显示「额度未知」），绝不编 0
   *   （`parseCodeArtsCredits` 已经把「没有 credit metric」与「余额恰好 0」分开了）；
   * - 60 秒内不重复打请求（面板每 30 秒刷一次）；
   * - 失败**不抛**：积分读不到不该把这一族打成不可用。
   */
  async quota(ctx, payload, signal) {
    const { auth, usable } = credentialOf(payload)
    if (!usable) return undefined
    const now = Date.now()
    if (creditsMemory.at > 0 && now - creditsMemory.at < CREDITS_TTL_MS) return creditsMemory.reading
    try {
      const response = await readSigned(ctx, payload, auth, CODEARTS_PACKAGE_INFO_URL, signal)
      if (response === undefined) return creditsMemory.reading
      // ⚠ 两处读的是**同一份**回包：`parseCodeArtsCredits` 只读 `metrics`，
      // 而「这个账号是积分计费还是 Token 计费」在 `data.package` 里。
      // 后者读不到**不该**把前者的读数变成 0（那是两个概念），所以两者各读各的。
      const account = parseCodeArtsAccountInfo(response)
      const reading = parseCodeArtsCredits(response)
      if (reading === undefined && account?.isCreditPackage === true) {
        // 「上游说这个账号是积分套餐，但 metrics 里一个 credit 项都没有」——
        // 这**可能是**上游改了字段名。如实告警，但**仍然返回 undefined**
        // （绝不把「读不到」编成 0）。
        warn(ctx, 'account-bridge: codearts 说这个账号是积分套餐，但回包里没有 credit metric；额度显示为未知')
      }
      creditsMemory = { at: now, reading }
      return reading
    } catch (error) {
      warn(ctx, `account-bridge: codearts 读积分失败（${error?.message ?? error}）`)
      return undefined
    }
  },

  /**
   * 一次流式对话。
   *
   * 请求体逐字照参考实现 `llm-adapter.ts:1217`（见文件头）：`stream: true`、
   * `prompt_cache_key`（缺了缓存命中恒 0）、`include: ['reasoning.encrypted_content']`、
   * `reasoning_summary: 'auto'`、`tool_stream: true`。
   *
   * ⚠ 「关闭思考」是**顶层** `thinking: { type: 'disabled' }`（不是 raccoon 那种
   * `extra_body.thinking`，混用静默无效）；而 `enabled` 与不传等价 ⇒ 开启档
   * **不发**这个字段。
   */
  async *stream(ctx, options = {}) {
    const { payload, model, messages = [], tools, effort, system, maxTokens, signal, account, session } = options
    const report = diagnosticReporter(ctx, options.onDiagnostic)
    const credential = credentialOf(payload)
    const { ak, sk, token, usable } = credential
    if (!usable) {
      throw missingCredential(
        `account-bridge: codearts 需要 access_key_id / secret_access_key / security_token 三件套（当前缺 ${credential.missing.join(' / ')}）`,
      )
    }
    const modelId = String(model ?? '').trim()
    if (modelId.length === 0) {
      // ⚠ 归 `INVALID_REQUEST` 而不是 `MISSING_CREDENTIAL`：账号没有任何问题，
      // 而 `MISSING_CREDENTIAL` 会让 `health.js` 换号 + 冷 24 小时（冤枉一个健康账号）。
      const error = new Error('account-bridge: codearts 需要一个 model id')
      error.code = 'INVALID_REQUEST'
      error.failure = { code: 'INVALID_REQUEST', message: error.message }
      throw error
    }

    // 会话标识：三处（两个头 + prompt_cache_key）同源，都按**账号 + 会话**派生。
    // ⚠ 拿不到 account/session 时**一个都不发**（契约硬规矩）。
    const scoped = accountScopedSession(ID, account?.id, session)
    const body = buildRequestBody({ model: modelId, messages, tools, effort, system, maxTokens, scoped })

    let attempt = 0
    /**
     * benefit 头的**强制覆盖**：`undefined` = 按目录判；`true` = 一定带上；`false` = 一定不带。
     *
     * ⚠ 这里**不能**用一个布尔：两个方向是**相反的两个症状**（见文件头第二节）——
     * - 该带没带 ⇒ `404 InferHub.002002009.404 model is not registered` ⇒ 要**补上**该头；
     * - 不该带却带了（账号没有 benefit 包）⇒ **HTTP 200 + SSE** `InferHub.4004.200
     *   benefit not found` ⇒ 要**去掉**该头（参考实现 `llm-adapter.ts` 把这一条写成
     *   `benefitHeaderDropped`，名字指的是「已经试过不带该头的那次了」）。
     * 所以两个方向各只允许试一次，且用 `tried` 记账防来回弹（最多两次请求）。
     */
    let benefitOverride
    const tried = new Set()
    while (attempt < 2) {
      attempt += 1
      const benefit = benefitOverride ?? isBenefitModel(modelId, catalogEntries())
      tried.add(benefit ? 'with' : 'without')
      // ⚠ `body` 在循环里序列化、并且**同一份字符串既拿去签名又当请求体**：
      // 两次尝试的**头集合**不同（`maas_type` 只在其中一次参与签名），所以签名必须
      // 按次算；而签名算的 `x-sdk-content-sha256` 是 body 的哈希 —— 两次 body 相同，
      // 但把它和签名放在一起按次生成，才不会出现「签名配着另一份 body 发出去」这种事故。
      const serialized = JSON.stringify(body)
      const extraHeaders = benefit ? { maas_type: 'benefit' } : undefined
      const signed = signCodeArtsRequest({
        ak,
        sk,
        securityToken: token,
        method: 'POST',
        url: CODEARTS_CHAT_URL,
        body: serialized,
        extraHeaders,
      })
      const headers = codeArtsHeaders(signed, {
        'Content-Type': 'application/json',
        'Agent-Type': CODEARTS_CHAT_AGENT_TYPE,
        'X-Language': 'zh-cn',
      })
      if (scoped !== undefined) {
        headers['Chat-Id'] = scoped
        headers['Session-Id'] = scoped
      }
      headers.lang = 'en'

      let response
      try {
        response = await ctx.fetch(
          CODEARTS_CHAT_URL,
          { method: 'POST', headers, body: serialized, signal },
          payload?.proxy,
          true,
        )
      } catch (error) {
        throw transportError(error)
      }

      // `assertApiReply`：网关挂掉时可能回 HTML 错误页，翻译层读它只会得到
      // 「流里什么都没有」这种没法排障的结论。这里先把它转成一条说得清的错误。
      const reply = await assertApiReply(response, { who: 'codearts' })

      if (!reply.ok) {
        const text = await reply.text().catch(() => '')
        const failure = httpError(reply, text, 'codearts')
        const kind = classifyCodeArtsFailure(reply.status, text)
        const detail = describeCodeArtsFailure(reply.status, text)

        // ⚠ benefit 头的**两个方向**都在这里收口，判据是「这次的头对不对」而不是
        // 「第几次」：`404 model is not registered` ⇒ 该带没带 ⇒ 补上重试；
        // `InferHub.4004.200`（也可能走 4xx 通道）⇒ 不该带却带了 ⇒ 去掉重试。
        // 两条都**不算账号失败**（不走池子换号），因为换号解决不了这个问题。
        const needsBenefit = kind === 'benefit' && !benefit && !tried.has('with')
        const mustDropBenefit = benefit && !tried.has('without') && isBenefitNotFound(text, undefined, text)
        if (needsBenefit || mustDropBenefit) {
          benefitOverride = needsBenefit
          report({
            code: 'CODEARTS_BENEFIT_HEADER',
            severity: 'warning',
            phase: 'request',
            message: needsBenefit
              ? `account-bridge: codearts 模型 ${modelId} 需要走 benefit 通道（${detail}），带上 maas_type 重试一次`
              : `account-bridge: codearts 这个账号拿不到 ${modelId} 的 benefit 通道（${detail}），去掉 maas_type 重试一次`,
          })
          continue
        }

        const waitMs = retryAfterMs(reply.headers)
        if (waitMs !== undefined) failure.failure = { ...failure.failure, providerRetryAfterMs: waitMs }

        // 并发上限 / TPM 超限：**不是账号的错**，归 RATE_LIMIT（换号 + 5 分钟），
        // 而不是 ACCOUNT_QUOTA（24 小时）。见文件头第四节。
        if (kind === 'queue') {
          failure.code = 'RATE_LIMIT'
          failure.failure = { ...failure.failure, code: 'RATE_LIMIT' }
          failure.message = `account-bridge: codearts 并发/TPM 已达上限（${detail}），换一个账号重试`
        } else if (kind === 'auth') {
          // 凭据失效。⚠ 本族的 `refresh` 是 no-op（没有 refresh_token），所以只能如实说
          // 「请重新登录」，而不是像别族那样提示「池子会续期」。
          failure.message = `account-bridge: codearts 不接受这份临时凭据（${detail}）。它没有 refresh_token，请在设置页重新粘贴一次`
        } else {
          failure.message = `account-bridge: codearts ${detail}`
        }

        report({
          code: kind === 'auth' ? 'CODEARTS_AUTH_REJECTED' : 'UPSTREAM_REJECTED',
          severity: 'error',
          phase: 'response',
          message: failure.message,
        })
        throw failure
      }

      // 成功路径：交给共享的 OpenAI 兼容翻译层。
      // ⚠ 除「一个字都还没吐出来的 benefit 失败」外**不 catch** ——
      // `translateChatStream` 抛的错误带着正确的 code（`EMPTY_RESPONSE` / `SERVER` …），
      // 包一层只会把它变成 TRANSPORT。
      // ⚠ 为什么手动 `for await` 而不是 `yield*`：需要知道**有没有已经交付出去的块**。
      // 已经 yield 过的块收不回来，重试一次会让同一个 index 出现两份内容；
      // 而 `InferHub.4004.200` 是**流开头**的错误帧（还没吐任何块），所以重试是安全的。
      //
      // ⚠⚠ **这条 catch 实际上是条窄路，别把它当成 benefit 失败的总兜底**：
      // 上游把业务码放在 `data:{"error_code":"InferHub.4004.200","error_msg":"…"}`
      // 这种**只有业务码的帧**里（顶层，既没有 `error` 也没有 `choices`），而共享翻译层
      // `../wire/chat-completions.js` 只认 `payload.error`（它全文没有 `error_code` /
      // `error_msg` 这两个词），于是那种帧被当空帧跳过，流读完后以
      // `EMPTY_RESPONSE`（message 逐字 `chat-completions: the response completed
      // without any content block`）收场 —— **业务码在那条路上拿不到**。
      // 所以本族的处置是：
      //   · HTTP 路径（4xx/5xx 带回包）⇒ 上面 `mustDropBenefit` 认得出来，能自动救回；
      //   · SSE 路径（200 + 只有业务码的帧）⇒ 降级成 `EMPTY_RESPONSE`，
      //     由 `health.js` 按 SERVER 处置（换号 + 60 秒 + 罚 member）。
      // 后者对账号是**安全的**（不会被误判成凭据死亡而冷 24 小时），只是这一轮救不回来。
      // 这里保留 `isBenefitNotFound(undefined, undefined, error?.message)` 是因为它
      // **不需要猜**：判据只有一条——错误文本里真的出现业务码 `InferHub.4004.200`
      // （`src/wire/codearts.js` 的 `isBenefitNotFound` 只认这个码值，不认
      // 「benefit not found」这类自然语言）。若上游哪天改用 `{"error":{…}}` 形状，
      // 这条路就自动生效。
      let emitted = false
      try {
        for await (const chunk of translateChatStream(reply, { signal, onDiagnostic: report })) {
          emitted = true
          yield chunk
        }
        return
      } catch (error) {
        if (!emitted && benefit && !tried.has('without') && isBenefitNotFound(undefined, undefined, error?.message)) {
          benefitOverride = false
          report({
            code: 'CODEARTS_BENEFIT_HEADER',
            severity: 'warning',
            phase: 'stream',
            message: `account-bridge: codearts 这个账号拿不到 ${modelId} 的 benefit 通道（${error?.message ?? error}），去掉 maas_type 重试一次`,
          })
          continue
        }
        throw error
      }
    }
  },
}

/**
 * 真读到过的目录条目，供 `isBenefitModel` 用。
 *
 * ⚠ gateway 那条腿**没读到过**时返回 `undefined`（而不是空数组）：
 * `isBenefitModel(model, undefined)` 会回落静态兜底表，而
 * `isBenefitModel(model, [])` 会认为「目录里查无此模型 ⇒ 不是 benefit」——
 * 后者会让 benefit 模型漏带那个头而 404。
 */
function catalogEntries() {
  if (!benefitKnown) return undefined
  return [...catalogCache.values()]
}

/** 兜底表 → 模型元数据列表（**永不写进 `catalogCache`**）。 */
function fallbackCatalog() {
  return FALLBACK_MODELS.map((id) => modelInfo(id, id, {}, ROUTE))
}

/**
 * 请求体。逐字照参考实现 `llm-adapter.ts:1217`，逐条理由见文件头。
 *
 * ⚠ `tool_stream: true` 是**上游**的工具流式开关，与本仓的 SSE 翻译无关，
 * 别因为「本仓也要流式」就以为它能省掉。
 */
function buildRequestBody({ model, messages, tools, effort, system, maxTokens, scoped }) {
  const body = {
    model,
    messages: toChatMessages(messages, { onDiagnostic: undefined }),
    stream: true,
    include: ['reasoning.encrypted_content'],
    reasoning_summary: 'auto',
    tool_stream: true,
    max_tokens: clampMaxTokens(maxTokens) ?? CONSERVATIVE_MAX_TOKENS,
  }
  if (effort === 'off') body.thinking = { type: 'disabled' }
  const prompt = toChatSystem(system, messages)
  if (prompt.length > 0) body.messages = [{ role: 'system', content: prompt }, ...body.messages]
  const chatTools = toChatTools(tools)
  if (Array.isArray(chatTools) && chatTools.length > 0) body.tools = chatTools
  if (scoped !== undefined) body.prompt_cache_key = scoped
  return body
}

/**
 * 发一个**签名 GET**，返回解析后的 JSON（`{ raw: true }` 时返回原始 JSON 对象，
 * 让调用方自己决定怎么读）。
 *
 * 失败返回 `undefined` 而不抛：调用方（`listModels` / `quota`）都是「读不到就降级」
 * 的语义，抛出去只会让它们多写一层 try。
 */
async function readSigned(ctx, payload, auth, url, signal) {
  const { ak, sk, token } = codeArtsCredentialShape(auth)
  const signed = signCodeArtsRequest({
    ak,
    sk,
    securityToken: token,
    method: 'GET',
    url,
    body: new Uint8Array(),
  })
  const response = await ctx.fetch(
    url,
    { method: 'GET', headers: codeartsReadHeaders(signed), signal },
    payload?.proxy,
    // 第 4 参不传：这是普通 JSON 请求，不是流（传 true 会让走代理时没有 bodyTimeout，
    // 一个卡住的目录请求能挂到天荒地老）。
  )
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    warn(ctx, `account-bridge: codearts ${url} 返回 ${describeCodeArtsFailure(response.status, text)}`)
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    warn(ctx, `account-bridge: codearts ${url} 的回包不是 JSON（前 120 字符：${text.slice(0, 120)}）`)
    return undefined
  }
}

/**
 * 模型元数据。
 *
 * `reasoning` 只有两档（`on` / `off`）：CodeArts 的「关闭思考」是**顶层
 * `thinking: {type:'disabled'}`**，没有中间档可发（参考实现只实现开关两态）。
 * **多给一档就是编**——契约要求「不知道的值宁可保守也不要编」。
 */
export function modelInfo(id, name, entry = {}, provider = ROUTE) {
  const stated = CONTEXT_WINDOWS.get(id)
  const contextWindow = Number.isFinite(stated) ? stated : CONSERVATIVE_CONTEXT_WINDOW
  const maxTokens = Math.min(entry?.maxTokens ?? CONSERVATIVE_MAX_TOKENS, contextWindow)
  return {
    provider,
    id,
    name: typeof name === 'string' && name.length > 0 ? name : id,
    context: { contextWindow },
    defaultMaxTokens: maxTokens,
    toolUpdate: 'in-history',
    inputModalities: ['text'],
    reasoning: {
      efforts: [
        { id: 'on', name: '开启' },
        { id: 'off', name: '关闭' },
      ],
      defaultEffort: 'on',
    },
  }
}

/**
 * 只带走白名单里的键。
 *
 * ⚠ 与 raccoon 同款：凭据对象一旦被原样存进记录，里面任何多余的键都会
 * 跟着 `publicAccount()` 的白名单重建一起出站。所以这里**只留已知的键**。
 */
export function authFromPayload(payload) {
  const source = payload?.auth ?? payload ?? {}
  const out = {}
  for (const key of ['access_key_id', 'secret_access_key', 'security_token', 'expires_at', 'domain_id', 'user_id', 'user_name']) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim()
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  // 面板的「token 已过期」红字读的是**数字** `expiresAt`
  // （`src/api.js` 的 `publicAccount()` 只认 `Number.isFinite(auth.expiresAt)`，
  // 而三件套里上游给的是字符串 `expires_at`）。解析得出来就补一个数字形式，
  // **解析不出来就不补**——参考实现那份 `+24h` 兜底是它的估计值，本仓不编寿命。
  const expiry = codeArtsExpiryOf(source)
  if (typeof expiry === 'number' && Number.isFinite(expiry)) out.expiresAt = expiry
  return out
}

/**
 * 记录名。
 *
 * 优先 `user_name`（华为云账号名），其次 `domain_id` 的短形态，最后用 AK 的
 * **后 6 位**——**绝不编一个人名**。三样都没有时给 `CodeArts`（一个诚实的
 * 兜底名，因为这一族的粘贴路里确实没有身份字段）。
 *
 * ⚠ AK 本身**不是密钥**（它出现在每个请求的 `Authorization` 头里），但完整 AK
 * 也没必要写进界面，所以只取后 6 位当区分符。
 */
export function labelFor(auth) {
  const source = auth ?? {}
  const userName = typeof source.user_name === 'string' ? source.user_name.trim() : ''
  if (userName.length > 0) return userName
  const domain = typeof source.domain_id === 'string' ? source.domain_id.trim() : ''
  if (domain.length > 0) return `domain ${domain.slice(0, 8)}`
  const ak = typeof source.access_key_id === 'string' ? source.access_key_id.trim() : ''
  if (ak.length > 6) return `AK …${ak.slice(-6)}`
  return 'CodeArts'
}

/**
 * 凭据 → 池子记录。`source` 默认 `manual`（本族没有客户端导入这条路）。
 *
 * ⚠ `label` 必须由调用方**先**算好（`labelFor(auth)`）后传进来：写成
 * `labelFor(clean)` 会让「算标签」和「建记录」互相调用，而 `authFromPayload()`
 * 只留白名单键 ⇒ 身份字段全被剥掉时算出来的标签会与调用方预期的不一致。
 * 调用方（`login.run`）手上有原始 auth，由它算最准。
 */
export function recordFromAuth(auth, label, source = 'manual', externallyOwned = false) {
  const clean = authFromPayload({ auth })
  return {
    family: ID,
    label: typeof label === 'string' && label.length > 0 ? label : 'CodeArts',
    source,
    externallyOwned,
    auth: clean,
    createdAt: new Date().toISOString(),
  }
}

/**
 * 这一族的**真机状态**（供探针与文档引用）。
 *
 * 写成一个导出而不是散在注释里：探针要断言「本族如实报告自己没被真机验过」，
 * 而断言一个字符串常量比断言一句注释可靠。
 */
export const CODEARTS_VERIFICATION = 'route-and-metadata-only'

/**
 * 清掉模块级记忆。**只给测试与探针用**——正常路径不需要，池子每个进程只跑一次。
 */
export function __resetCodeArtsCaches() {
  catalogCache.clear()
  benefitKnown = false
  creditsMemory = { at: 0, reading: undefined }
}
