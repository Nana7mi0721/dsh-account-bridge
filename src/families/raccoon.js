/**
 * Raccoon（商汤小浣熊）族。
 *
 * 上线前踩过 / 差点踩到的坑，逐条写在这里（为什么这么写，而不是做了什么）：
 *
 * 1. ⚠ **思考档位只有「开 / 关」两态，而且必须走 `extra_body`**。参考实现
 *    （`temp/codearts/src/raccoon-adapter.ts:540-572`、`raccoon-product.ts:26-71`）实测：
 *    服务端**接受** `reasoning_effort` 的 8 个枚举值却**不产生任何可观测效果**
 *    （8 轮配对实验，`max-minimal` 的差值是 4 正 4 负的纯随机；它一度在 4 轮小样本里
 *    看到「单调趋势」，8 轮后消失=巧合）；真正有效的是 `extra_body.thinking.type`。
 *    所以本族**只暴露 `on` / `off` 两档**，既不暴露强度档，也**不假装**有强度档。
 *    ⚠ 还有一个更贵的坑：`thinking` 放**顶层**会被静默忽略（连非法值都不报错），
 *    必须嵌在 `extra_body` 里——写成顶层会表现为「档位开关按了没反应」，
 *    排查时完全看不出是发错了位置。
 * 2. ⚠ **图片能力不能用远端的 `tags` 判**。参考实现曾把「目录里 `tags` 含 `vision`」
 *    当成服务端能力声明，而 `sn-deepseek-v4-1-flash` 的 tags 恰好没有 `vision`
 *    ⇒ 它播报 `inputModalities: ['text']` ⇒ **DSH 在 `LlmRuntime` 里把图片替换成
 *    文本占位符**（`projectImagesForTextModel`）⇒ 图根本没发出去，用户看到的却是
 *    模型说「我读不到图片」。它用「带随机 6 位数字的图」实测推翻了 tags
 *    （`sn-deepseek-v4-1-flash` 5/5 读对）。本族因此一律播报 `['text','image']`，
 *    理由与代价写在 `../wire/raccoon.js` 的 `raccoonSupportsImage` 上。
 * 3. ⚠ **目录端点给的是「目录」，不是「凭据有效性」**——但它确实会 401。
 *    本族把 `listModels` / `quota` 的失败一律降级成「回落兜底表 / 返回 undefined」，
 *    绝不让一次目录失败连累账号健康（`refresh` 失败才是账号问题）。
 * 4. ⚠ **`refresh` 返回的是新的 `auth` 对象，不是整个记录**；池子做的是**浅合并**，
 *    没带的键保留旧值。所以这里显式带上所有「会变或必须保住」的键——尤其是
 *    `refresh_token`：上游**可能只回新的 access_token**，此时**必须保留旧值**，
 *    否则续期一次就把账号变成不可续期（参考实现 `raccoon-oauth.ts:281-359` 的原话）。
 * 5. ⚠ **只在 `paste` 里让用户粘令牌，不给扫码/短信**。扫码要把二维码渲染给用户看，
 *    短信要过阿里云滑块验证码（`aliyunCaptcha`）且手机号得按 AES-128-CFB 加密
 *    （`phoneCipherSecret`）——都不是「插件里静默做完」的事；参考实现是靠一个网页
 *    carrier page 才做到的。本族也**不实现签到/领取**：每日积分是**服务端按日自动发**
 *    的（没有端点），唯一那个 `desktop/v1/login/points/grant` 是唯一会改变用户账号
 *    状态的写请求，本仓对 Trae / Qoder 同样砍掉了这类动作。
 * 6. ⚠ **认证失败只换号，绝不写冷却标记**。上游网关曾对**全池**回
 *    `401 + authorization_verify_error`（网关侧授权校验故障，与某个号的额度无关），
 *    当时把 401 也当「可换号」并写了 24h 冷却 ⇒ 一个请求内 6 个号各被封 24 小时、
 *    整个 provider 死一天（症状 `no usable credential; log in first`）。
 *    本仓的处置是**不自己写这套分类器**：共享的 `../wire/http-error.js` 里 401 恒 AUTH、
 *    403 只有带「钱」义词才算额度、其余一律 AUTH，而 `../health.js` 对 AUTH 的动作
 *    正是「换号 + 24h + 罚 account」里的「换号」那一半——本仓不写标记，
 *    冷却在内存里（`health.js`），所以「罚账号」不会变成永久的。
 * 7. ⚠ **目录缓存只能记真实远端目录**。参考实现 `raccoon-adapter.ts:411-433` 记着：
 *    曾把兜底表也记成「已加载」，于是一次瞬时失败让那个 provider **整个进程生命周期**
 *    只剩兜底模型。本族的 `catalogCache` 只在真的解析出条目时才写，
 *    回落兜底表时**绝不覆盖**已经见过的真元数据。
 *
 * 本族的协议事实借自另一个中文插件（**借的是证据不是代码**），登记见
 * `THIRD_PARTY_NOTICES.md` 的「借用的证据」一节，逐条标了出处与强度。
 * @module dsh-account-bridge/families/raccoon
 */

import { existsSync } from 'node:fs'
import { assertApiReply } from '../wire/assert-reply.js'
import { toChatMessages, toChatSystem, toChatTools, translateChatStream } from '../wire/chat-completions.js'
import { diagnosticReporter } from '../wire/diagnostics.js'
import { httpError, retryAfterMs } from '../wire/http-error.js'
import {
  RACCOON_BALANCE_URL,
  RACCOON_CATALOG_URL,
  RACCOON_CHAT_URL,
  RACCOON_REFRESH_LEAD_MS,
  RACCOON_REFRESH_URL,
  RACCOON_REQUEST_TIMEOUT_MS,
  RACCOON_USER_INFO_URL,
  parseRaccoonCatalog,
  parseRaccoonQuota,
  raccoonClientPlatform,
  raccoonCredentialShape,
  raccoonDataDirs,
  raccoonDisplayName,
  raccoonExpiryOf,
  raccoonHeaders,
  raccoonLabel,
  raccoonUserInfoFrom,
  trackRaccoonBalance,
} from '../wire/raccoon.js'

export const ID = 'raccoon'
export const ROUTE = 'acct-raccoon'
export const DISPLAY_NAME = 'Raccoon (商汤)'

/** 对话线上那个平台头的值（参考实现 `raccoon-product.ts:175-182`：只能是这三个之一）。 */
const CLIENT_PLATFORM = raccoonClientPlatform()

/**
 * 保守上下文窗口（本仓**没有**真机验过任何模型的窗口）。
 *
 * 为什么不照抄参考实现兜底表里的 256k / 1M：那是它 2026-09-26 的实测值，本仓没有账号
 * 复验，而契约 §5.3 对不知道的值的口径是「**宁可保守也不要编**——低估只是提前压缩，
 * 高估会送超长请求被上游拒掉、白烧一次额度」。128k 对这条线上最小的那个模型也安全。
 * 目录里读到真值时**以目录为准**（`catalogCache`），这个数只在读不到时兜底。
 */
const CONSERVATIVE_CONTEXT_WINDOW = 131_072

/**
 * 保守输出上限。参考实现兜底表里最大 100k、最小 63_999，但那是实测值；
 * 保守值只影响「我们主动要多少」，要少了用户最多多轮一次，要多了会被上游拒。
 */
const CONSERVATIVE_MAX_TOKENS = 8_192

/**
 * 模型兜底表。**只列参考实现证据里出现过的 id**（`raccoon-product.ts:218-265`，
 * 它 2026-09-26 实测 `model_catalog` 的 `visible:true` 条目），顺序照抄远端。
 *
 * ⚠ 展示名里的倍率是它实测的 `billing_*` 字段，本仓**照抄但标注为未复验**；
 * 远端目录能读到时以远端为准（这里只是冷启动兜底）。
 * ⚠ 表里**没有 `Raccoon-Auto`**：它是客户端 i18n 条目渲染的「自动选模」入口，
 * 不是远端模型，直接发给 `chat/completions` 会 404（参考实现实测）。
 */
export const FALLBACK_MODELS = [
  { id: 'sn-sensenova-6-8-flash', name: 'SenseNova-6.8-Flash · 免费' },
  { id: 'sn-sensenova-6-8-flash-lite', name: 'SenseNova-6.8-Flash-Lite · 免费' },
  { id: 'sn-glm-5-3', name: 'GLM-5-3 · x0.75' },
  { id: 'sn-kimi-k3', name: 'Kimi-K3 · x1' },
  { id: 'sn-glm-5-3-flash', name: 'GLM-5-3-Flash · x0.2→x0.1' },
  { id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash · x0.25' },
]

/** 目录里见过的真实元数据（只放真读到的；兜底表**永不**写进来）。 */
const catalogCache = new Map()

/** 见过的最大积分余额，用来把「没有总额字段的余额」投影成相对读数（只在内存）。 */
const balanceMemory = new Map()

/**
 * 统一日志出口。宿主给的 ctx 形状不止一种：插件运行时有 `ctx.log`，
 * 而端到端测试的替身只有 `ctx.logger`（`src/families/qoder.js` 同款防线）。
 * 日志失败**绝不能**连累主流程——那会把一次「日志写不出去」放大成「不能推理」。
 */
function warn(ctx, message) {
  try {
    if (typeof ctx?.log?.warn === 'function') ctx.log.warn(message)
    else if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
  } catch {
    /* 日志失败不该连累主流程 */
  }
}

/** 凭据材料是否够用。`usable === false` 时归 `MISSING_CREDENTIAL` 而不是 `AUTH`。 */
function credentialOf(payload) {
  const auth = payload?.auth ?? payload ?? {}
  const access = typeof auth.access_token === 'string' ? auth.access_token : ''
  return { auth, access, usable: access.length > 0 }
}

/** 传输层错误包装。`TRANSPORT` 在 `health.js` 里是「换号但不记冷却」——正是它该得的。 */
function transportError(error) {
  const wrapped = new Error(`raccoon: ${error?.message ?? error}`)
  wrapped.code = 'TRANSPORT'
  wrapped.failure = { code: 'TRANSPORT' }
  wrapped.cause = error
  return wrapped
}

// ------------------------------------------------------------------ 发现

/**
 * 本机发现。**在本机（以及任何一台没装 Raccoon Work 客户端的机器上）它必须是
 * `importable: false`**，理由不是「我们没实现」，而是上游的登录态**只在客户端进程
 * 内存里**：参考实现 `raccoon-auth.ts` 与笔记
 * `docs/agent-notes/providers-loomy-raccoon-minimax.md` 都记着同一个结论。
 *
 * 契约 §4.4：有凭据但格式不对要 `importable:false` + 诚实 reason；**没找到候选位点**
 * 时返回 `[]`（那才是「没找到」）。这里的处境比两者都更明确——**不存在任何位点**，
 * 所以返回一条 `importable:false`，把「查过哪些路径」写进 reason 让人能复核。
 * （`src/discover.js` 会把非 importable 的条目放进「有凭据但导不进来」并显示 reason。）
 */
export function raccoonDiscoveryCandidates() {
  return raccoonDataDirs()
}

// ------------------------------------------------------------------ 族对象

export const raccoonFamily = {
  id: ID,
  displayName: DISPLAY_NAME,
  route: ROUTE,
  /**
   * `risk: 'high'`。
   *
   * 理由有两条，都是这一家的形状决定的：① 请求体里**没有任何客户端侧签名**，
   * 认证就是一个 `Bearer` 明文令牌，令牌被上游按 IP / UA 之外的维度风控时我们没有
   * 任何对策；② 参考实现明确记着上游网关对**全池**回 401 的事故形态（见文件头第 6 条），
   * 也就是说服务的可用性不完全由我们的账号状态决定。③ 本族的登录方式**只有粘贴**，
   * 出问题时的恢复成本比扫码/短信高。
   */
  risk: 'high',

  /**
   * @returns {Promise<Array<{family, sourcePath, label, importable, reason?}>>}
   */
  async discover() {
    const candidates = raccoonDiscoveryCandidates()
    // ⚠ 这里只读「目录在不在」，不读任何文件内容：客户端不落盘登录态，
    // 所以**不存在**该读的文件，无谓地遍历只会把「不存在」混淆成「读失败了」。
    // 逐个查一次是为了让 reason 里列出的路径是**真的查过**的，而不是抄一份常量。
    const checked = candidates.filter((dir) => {
      try {
        return existsSync(dir)
      } catch {
        // 权限/路径异常不是「找到了」——当作没查到，但要在 reason 里如实体现。
        return false
      }
    })
    const listed = candidates.map((dir) => `\`${dir}\``).join('、')
    const reason =
      `本机没有可导入的 Raccoon 凭据位点：Raccoon Work 的登录态只在客户端进程内存里，退出即失效，磁盘上不落盘。` +
      `已查过 ${candidates.length} 个候选路径（${listed}）` +
      (checked.length > 0 ? `，其中存在的有 ${checked.map((dir) => `\`${dir}\``).join('、')}，但里面没有凭据文件。` : `，一个都不存在。`) +
      `本族的登录方式只有「粘贴 access_token」——请在设置页用它手工添加账号。`
    return [
      {
        family: ID,
        sourcePath: candidates[0] ?? '',
        label: 'Raccoon Work 客户端（进程内登录态）',
        importable: false,
        reason,
      },
    ]
  },

  // 这里**没有** `recordFromDiscovery`：本族没有任何 `importable: true` 的发现结果
  // （Raccoon Work 的登录态只在客户端进程内存里，磁盘上不落盘），所以写了也只是一个
  // 永远不会被调用的空壳。`src/discover.js` 对「有凭据但导不进来」的条目会照常显示
  // `reason`，用户看到的是「为什么导不进来」，不是一句「这个族不支持导入」的假判断。
  // 与 `copilot` 族同一个决定。

  login: {
    methods: [{ id: 'paste', label: '粘贴 access_token（可选 refresh_token）' }],
    /**
     * 交互式登录。**必须在 `run` 返回之前 `commit`**，晚一步 seam 抛 `NOT_COMMITTED`。
     *
     * 为什么这里要拿令牌**真发一次请求**：粘贴的字符串对不对，只有上游认不认才算数；
     * 把明显无效的令牌落盘会让用户看到一个「已登录」但每次推理都 401 的账号。
     * ⚠ 探测用**只读的 `user_info`**，不碰任何写端点。
     */
    async run(session, ctx) {
      const access = String((await session.prompt({ kind: 'secret', message: '粘贴 Raccoon 的 access_token' })) ?? '').trim()
      const shape = raccoonCredentialShape(access)
      if (shape === 'empty') throw missingCredential('account-bridge: raccoon 需要 access_token')
      if (shape === 'short') throw missingCredential('account-bridge: raccoon 的 access_token 太短，不像是令牌')
      const refreshToken = String(
        (await session.prompt({
          kind: 'secret',
          message: '可选：粘贴 refresh_token（留空表示不自动续期）',
        })) ?? '',
      ).trim()
      const probe = await validateCredential(ctx, { access_token: access, refresh_token: refreshToken || undefined })
      if (!probe.ok) throw probe.error
      const auth = {
        access_token: access,
        ...(refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
        ...probe.info,
        ...(probe.expiresAt !== undefined ? { expiresAt: probe.expiresAt } : {}),
        client_platform: CLIENT_PLATFORM,
        obtainedAt: new Date().toISOString(),
      }
      // commit 是同步的，但契约要求它排在 run 返回之前。
      await session.commit({
        kind: 'grant',
        payload: recordFromAuth(auth, raccoonLabel(probe.info), 'manual', false),
      })
      await session.notify({
        message: probe.info?.phone ? `Raccoon 已登录：${probe.info.phone}` : 'Raccoon 已登录',
      })
    },
  },

  /**
   * 续期。**返回新的 `auth` 对象**（不是整个 payload）——池子随后做的是
   * `{...current.auth, ...returned}` 的**浅合并**，所以这里要显式带上所有
   * 「会变」或「必须保住」的键。
   *
   * ⚠ `signal` 在池子的调用点上是 `undefined`（契约明说），所以这里**不能**对它
   * `.addEventListener`；自造一个超时是唯一的兜底。
   */
  async refresh(ctx, payload) {
    const { auth, usable } = credentialOf(payload)
    if (!usable) throw missingCredential('account-bridge: raccoon 凭据里没有 access_token')
    const refreshToken = typeof auth.refresh_token === 'string' ? auth.refresh_token : ''
    if (refreshToken.length === 0) {
      // 用户粘贴时留空的那条路：没有 refresh_token 就**没有**续期能力。
      // 归 AUTH 而不是 TRANSPORT：这是账号材料的问题，不是网络抖动，
      // 换号是对的（`health.js` 对 AUTH 的动作就是换号）。
      const error = new Error('account-bridge: raccoon 凭据缺少 refresh_token，请重新登录')
      error.code = 'INVALID_CREDENTIAL'
      error.failure = { code: error.code }
      throw error
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RACCOON_REQUEST_TIMEOUT_MS)
    let response
    try {
      response = await ctx.fetch(
        RACCOON_REFRESH_URL,
        {
          method: 'POST',
          headers: raccoonHeaders({ access_token: auth.access_token ?? '' }),
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: controller.signal,
        },
        payload.proxy,
      )
    } catch (error) {
      throw transportError(error)
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text().catch(() => '')
    const json = parseJson(text)
    if (!response.ok) {
      // ⚠ 401（或业务码 200003）表示 refresh_token 已失效：抛「请重新登录」，**不重试**。
      // 参考实现 `raccoon-oauth.ts:281-359` 就是这么判的（状态码与业务码两条腿）。
      const code = json?.code
      if (response.status === 401 || code === 200003) {
        const error = new Error('account-bridge: raccoon 登录态已过期，请重新登录')
        error.code = 'AUTH'
        error.failure = { code: error.code, status: response.status, message: text.slice(0, 300) }
        throw error
      }
      throw httpError(response, text, 'raccoon')
    }
    const next = json?.data ?? {}
    const accessToken = typeof next.access_token === 'string' ? next.access_token : ''
    if (accessToken.length === 0) {
      const error = new Error('account-bridge: raccoon 续期响应里没有 access_token')
      error.code = 'SERVER'
      error.failure = { code: error.code, status: response.status }
      throw error
    }
    const expiresAt = raccoonExpiryOf({ access_token: accessToken })
    // ⚠ 必须把旧 auth 摊开：浅合并下没带的键会保留旧值，但**主动带上是把意图写清楚**
    // ——尤其是 refresh_token，上游可能只回新的 access_token。
    return {
      ...auth,
      access_token: accessToken,
      refresh_token: typeof next.refresh_token === 'string' && next.refresh_token.length > 0 ? next.refresh_token : refreshToken,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      client_platform: auth.client_platform ?? CLIENT_PLATFORM,
      obtainedAt: new Date().toISOString(),
    }
  },

  /**
   * 该不该续期。
   *
   * ⚠ 没有过期时间戳时返回 **true**：那说明令牌是别处塞进来的、寿命未知，
   * 「不知道」不等于「还早」——续一次最多多打一个请求，而不续会让这个账号
   * 在下次推理时 401（那要多花一次失败请求 + 一次换号）。
   */
  needsRefresh(payload, now = Date.now()) {
    const { auth, usable } = credentialOf(payload)
    if (!usable) return false
    if (typeof auth.refresh_token !== 'string' || auth.refresh_token.length === 0) return false
    const expiresAt = raccoonExpiryOf(auth)
    if (expiresAt === undefined) return true
    return expiresAt - now <= RACCOON_REFRESH_LEAD_MS
  },

  /**
   * 模型目录。读不到就回落兜底表，**绝不**把兜底表写进 `catalogCache`
   * （那会让一次瞬时失败在这个进程里永久降级）。
   */
  async listModels(ctx, payload, signal) {
    const { auth } = credentialOf(payload)
    try {
      const response = await ctx.fetch(
        RACCOON_CATALOG_URL,
        { headers: { ...raccoonHeaders(auth), accept: 'application/json' }, signal },
        payload?.proxy,
      )
      if (response.ok) {
        const entries = parseRaccoonCatalog(await response.json().catch(() => undefined))
        for (const entry of entries) catalogCache.set(entry.id, entry)
        if (entries.length > 0) return entries.map((entry) => modelInfo(entry.id, entry.displayName, entry, ROUTE))
      } else {
        warn(ctx, `account-bridge: raccoon 模型目录返回 HTTP ${response.status}，改用兜底列表`)
      }
    } catch (error) {
      warn(ctx, `account-bridge: raccoon 模型目录读取失败（${error?.message ?? error}），改用兜底列表`)
    }
    // 兜底表 + 目录里见过但这次没给的：后者是本进程早先真读到过的，丢掉它等于
    // 因为一次失败把用户切走的模型从列表里抹掉。
    const merged = new Map(FALLBACK_MODELS.map((entry) => [entry.id, entry]))
    for (const [id, entry] of catalogCache) merged.set(id, { id, name: entry.displayName ?? raccoonDisplayName(entry) })
    return [...merged.values()].map((entry) => modelInfo(entry.id, entry.name, catalogCache.get(entry.id) ?? {}, ROUTE))
  },

  /**
   * 单个模型的元数据。契约 §5.3：不知道的值宁可保守也不要编。
   *
   * ⚠ 这里只拿得到模型名，所以真元数据来自 `listModels` 见过的 `catalogCache`
   * ——**声明式的兜底表不许覆盖**它。
   */
  resolveModel(provider, model) {
    const known = catalogCache.get(model)
    if (known !== undefined) return modelInfo(model, known.displayName ?? raccoonDisplayName(known), known, provider ?? ROUTE)
    const fallback = FALLBACK_MODELS.find((entry) => entry.id === model)
    return modelInfo(model, fallback?.name ?? model, {}, provider ?? ROUTE)
  },

  /**
   * 积分额度。**读不到就返回 `undefined`**——报一个假额度比不报更糟
   * （契约 §C3）。失败也不抛：抛了会连累账号健康状态，而「读不到余额」
   * 根本不是账号的毛病。
   */
  async quota(ctx, payload, signal) {
    const { auth } = credentialOf(payload)
    try {
      const response = await ctx.fetch(
        RACCOON_BALANCE_URL,
        { headers: { ...raccoonHeaders(auth), accept: 'application/json' }, signal },
        payload?.proxy,
      )
      if (!response.ok) return undefined
      const json = await response.json().catch(() => undefined)
      const key = payload?.id ?? auth.userId ?? 'default'
      const seenMax = trackRaccoonBalance(balanceMemory.get(key), json)
      if (seenMax !== undefined) balanceMemory.set(key, seenMax)
      return parseRaccoonQuota(json, { seenMax })
    } catch (error) {
      warn(ctx, `account-bridge: raccoon 积分读取失败（${error?.message ?? error}）`)
      return undefined
    }
  },

  /**
   * 推理。会话标识（`account` / `session`）**刻意不用**：这条线上没有那三个
   * Claude 线字段，理由写在 `../wire/raccoon.js` 的 `RACCOON_HAS_NO_SESSION_IDENTITY`。
   */
  async *stream(ctx, options) {
    const { payload, model, messages, tools, system, maxTokens, effort, signal } = options
    const { auth, usable } = credentialOf(payload)
    if (!usable) throw missingCredential('account-bridge: raccoon 凭据里没有 access_token')
    const report = diagnosticReporter(ctx, options.onDiagnostic)
    report({ code: 'RACCOON_ATTEMPT', severity: 'warning', phase: 'request', message: `raccoon 请求 ${model}` })
    const body = {
      model,
      messages: toChatMessages(messages, { onDiagnostic: report }),
      stream: true,
    }
    const prompt = toChatSystem(system, messages)
    if (prompt.length > 0) body.messages = [{ role: 'system', content: prompt }, ...body.messages]
    if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens
    const chatTools = toChatTools(tools)
    // tools 必须放**顶层**（参考实现 `raccoon-adapter.ts:548-572` 的 body 形状）。
    if (chatTools.length > 0) body.tools = chatTools
    const thinking = thinkingOf(effort, report)
    if (thinking !== undefined) body.extra_body = thinking
    let response
    try {
      response = await ctx.fetch(
        RACCOON_CHAT_URL,
        {
          method: 'POST',
          headers: {
            ...raccoonHeaders(auth, { platform: CLIENT_PLATFORM }),
            accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal,
        },
        payload.proxy,
        // 第 4 参 true：走代理且流式时 undici 的 ProxyAgent 才会用 `bodyTimeout: 0`；
        // 默认 5 分钟会在长回答中途把连接掐断（表现为「没有报错就中断」）。
        true,
      )
    } catch (error) {
      throw transportError(error)
    }
    const reply = await assertApiReply(response, { who: 'raccoon' })
    if (!reply.ok) {
      const text = await reply.text().catch(() => '')
      // `waitMs` / `error.failure.providerRetryAfterMs` 一起给：宿主只看前者，
      // 而后者是排障时唯一能看到的「上游到底说了多久」。
      const waitMs = retryAfterMs(reply.headers)
      const failure = httpError(reply, text, 'raccoon')
      if (waitMs !== undefined) failure.failure = { ...failure.failure, providerRetryAfterMs: waitMs }
      report({
        code: 'UPSTREAM_REJECTED',
        severity: 'error',
        phase: 'response',
        message: `raccoon 上游 HTTP ${reply.status}：${text.slice(0, 200)}`,
      })
      throw failure
    }
    yield* translateChatStream(reply, { signal, onDiagnostic: report })
  },
}

// ------------------------------------------------------------------ 登录/探测

/**
 * 用一次**只读**请求验证粘贴进来的令牌。
 *
 * 判据（照抄 `src/families/zcode.js` 的 `validateCredential` 口径，理由同款）：
 * - 2xx ⇒ 通过，并把 `user_info` 里的 phone / nickname / 组织码一起带回去当 label；
 * - 401 / 403 ⇒ **挡住，不落盘**：粘错了就是粘错了，落盘会造出一个「已登录但每次都 401」
 *   的账号；这条也是本机真机捕获过的那条（见 `THIRD_PARTY_NOTICES.md` 的捕获段）。
 * - 402 / 429 ⇒ **接受**：那是额度或限流，不是「令牌不对」，挡下来会让用户在余额耗尽时
 *   反而无法重新登录；
 * - **其它非 2xx / 传输失败 ⇒ 也接受，但标 `unverified`**：上游 5xx 与网络抖动说明不了
 *   令牌有问题，用一次抖动把用户挡在门外是错的。代价是此时没有 label 可用，
 *   于是记录名回落成中性的 `Raccoon`（**绝不编一个人名**）。
 *
 * ⚠ `ctx.fetch` 的**第 4 个参数**（是否流式）不传：这是一个普通 JSON 请求。
 */
export async function validateCredential(ctx, credential, { signal, proxy } = {}) {
  const auth = { ...credential, client_platform: CLIENT_PLATFORM }
  let response
  try {
    response = await ctx.fetch(
      RACCOON_USER_INFO_URL,
      { headers: raccoonHeaders(auth), signal },
      proxy ?? credential?.proxy,
    )
  } catch (error) {
    return { ok: true, unverified: true, error: transportError(error), info: {}, userId: undefined, label: raccoonLabel({}) }
  }
  if (response.status === 401 || response.status === 403) {
    const text = await response.text().catch(() => '')
    const error = httpError(response, text, 'raccoon')
    // 归 AUTH 而不是 MISSING_CREDENTIAL：令牌**存在**，只是上游不认。
    // 归错这一类会让用户以为「没粘上」，而真正要做的是重新拿一个令牌。
    error.message = `account-bridge: raccoon 不接受这个 access_token（HTTP ${response.status}），请重新获取`
    return { ok: false, error }
  }
  if (response.ok) {
    const json = await response.json().catch(() => undefined)
    const info = raccoonUserInfoFrom(json)
    const expiresAt = raccoonExpiryOf(credential)
    return { ok: true, info, expiresAt, userId: info.userId, label: raccoonLabel(info) }
  }
  return {
    ok: true,
    unverified: true,
    status: response.status,
    info: {},
    userId: undefined,
    label: raccoonLabel({}),
  }
}

/** 缺材料时的统一错误：归 `MISSING_CREDENTIAL`，`health.js` 对它换号 + 24h + 罚 account。 */
function missingCredential(message) {
  const error = new Error(message)
  error.code = 'MISSING_CREDENTIAL'
  error.failure = { code: error.code }
  return error
}

/**
 * 思考档位 → `extra_body` 内容。**这是本族唯一有实测支撑的档位通道。**
 *
 * - `'off'` ⇒ `{thinking: {type: 'disabled'}}`：参考实现 6/6 与 8/8 两组实测
 *   `reasoning_tokens` **全为 0**，是真的关掉了；
 * - `'on'` / 未指定 ⇒ 报 `EFFORT_NOT_SENT` 并**不发这个字段**。理由是实测的：
 *   不发参数（均值 222 reasoning_tokens）与显式 `{type:'enabled'}`（均值 218）
 *   **等价**，而少发一个字段就少一个「上游方言变了」的失败面。
 *   这同时让「DSH 默认档」落到服务端默认上，不需要我们替它选。
 * - 其它值（比如将来 DSH 加了强度档）⇒ 报诊断、**不发**：这条线上没有强度的证据，
 *   硬塞一个 `reasoning_effort` 会被接受却毫无效果（那比报错更难查）。
 */
function thinkingOf(effort, report) {
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  if (effort === undefined || effort === null || effort === '' || effort === 'on') {
    report({
      code: 'EFFORT_NOT_SENT',
      severity: 'warning',
      phase: 'request',
      message: 'raccoon 的开启档位与服务端默认等价（实测），本次不下发 thinking 字段',
    })
    return undefined
  }
  report({
    code: 'EFFORT_UNSUPPORTED',
    severity: 'warning',
    phase: 'request',
    message: `raccoon 只有开启/关闭两档，收到 "${effort}" 这张线上没有对应证据，本次不下发`,
  })
  return undefined
}

// ------------------------------------------------------------------ 记录构造

/** `payload` → 记录里的 `auth`（只带走我们认识且非空的字段）。 */
export function authFromPayload(payload) {
  const { auth } = credentialOf(payload)
  const out = {}
  for (const key of ['access_token', 'refresh_token', 'userId', 'nickname', 'phone', 'office_identity', 'expiresAt', 'client_platform', 'device_id']) {
    const value = auth?.[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/** 显示名：能拿到就照 `raccoonLabel` 的优先级（phone → 组织码 → 昵称）。 */
export function labelFor(payload) {
  const auth = authFromPayload(payload)
  return raccoonLabel(auth)
}

/**
 * 记录构造。`source` 只有三种（`oauth` / `client-import` / `manual`），
 * `externallyOwned` 表示「凭据的真身在别处」——本族**没有**这种位点（客户端不落盘），
 * 所以始终传 false，写回逻辑也就不存在（这正好让本文件不碰任何写盘 API）。
 */
export function recordFromAuth(auth, label, source = 'manual', externallyOwned = false) {
  const clean = authFromPayload(auth)
  return {
    family: ID,
    label: typeof label === 'string' && label.length > 0 ? label : raccoonLabel(clean),
    source,
    externallyOwned,
    auth: clean,
    createdAt: new Date().toISOString(),
  }
}

// ------------------------------------------------------------------ 元数据

/**
 * 契约 §5.3 的形状。不知道的值取保守默认（`CONSERVATIVE_*`），
 * **不照抄**别处的实测值。
 */
export function modelInfo(id, name, entry = {}, provider = ROUTE) {
  const contextWindow =
    typeof entry.contextWindow === 'number' && Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0
      ? entry.contextWindow
      : CONSERVATIVE_CONTEXT_WINDOW
  const maxTokens =
    typeof entry.maxTokens === 'number' && Number.isSafeInteger(entry.maxTokens) && entry.maxTokens > 0
      ? Math.min(entry.maxTokens, contextWindow)
      : Math.min(CONSERVATIVE_MAX_TOKENS, contextWindow)
  return {
    provider,
    id,
    name: typeof name === 'string' && name.length > 0 ? name : id,
    context: { contextWindow },
    defaultMaxTokens: maxTokens,
    toolUpdate: 'in-history',
    // 一律播报图片能力：远端目录**从不**下发模态字段，所以没有「不支持」的否据，
    // 而按 `tags` 判会重演参考实现那个「图片被静默换成占位符」的缺陷。
    inputModalities: ['text', 'image'],
    reasoning: {
      // 只有开/关两态：强度档在这条线上被服务端接受但**没有任何效果**（实测）。
      efforts: [
        { id: 'on', name: '开启' },
        { id: 'off', name: '关闭' },
      ],
      defaultEffort: 'on',
    },
  }
}

/** 给一次性脚本用（本仓库不许加单测，所以留一个显式的清缓存出口）。 */
export function __resetRaccoonCaches() {
  catalogCache.clear()
  balanceMemory.clear()
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
