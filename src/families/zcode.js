/**
 * ZCode（Z.AI / 智谱 coding plan）族：把**智谱订阅/积分计划**的账号接成 DSH 的 provider。
 *
 * 这一族与其它十二族最不一样的地方：**上游把「请求体长什么样」当成准入开关。**
 * `system` 里没有官方的身份块结构就直接 `405 + {"code":3012}`，而且**有冷却惩罚**
 * （第 1 次 30 分钟 → 24h 内第 3 次起 24h → 第 5 次停用）。所以这里的每一处「照官方发」
 * 都不是形式主义，是**保护用户账号**。
 *
 * 上线前踩过 / 差点踩到的坑，逐条写在这里，改代码前先读：
 *
 * 1. **两条通道，响应格式完全相同，只有端点与凭据不同**（见 `src/wire/zcode.js`）。
 *    默认优先 `start-plan`（积分制，`zcode.z.ai`）——积分是白给的，不该被订阅额度先消耗。
 *    凭据**形态**决定它属于哪条腿：`id.secret` 两段点分 = Coding Plan API key（订阅制）；
 *    其余（JWT / 不透明令牌）= start-plan。形态不对**不当成失败**，换腿是正确动作。
 * 2. **绝不读本机 `~/.zcode/v2/credentials.json` 的值**。那里的凭据是
 *    `enc:v1:` 密文，派生密钥是**公开可复现**的（`zcode-credential-fallback:<平台>:<家目录>:<用户名>`
 *    过 sha256）——参考实现把读它的整段代码删掉，理由是「不复制『读别人应用登录态』的能力」。
 *    我们同意，而且**多一条自己的理由**：那是**单账号**格式，而我们是**多账号池**，
 *    拿一份磁盘凭据去填任意一条正是参考实现记录过的「跨账号覆盖」缺陷。
 *    发现路径因此**如实报 `importable:false` + 说明是加密存储**，而不是静默返回空
 *    （`AGENTS.md`：「读不出来」不等于「没有」）。
 * 3. **凭据是静态的，没有续期端点**（JWT payload 实测只有 `{user_id, token_version, sub, iat}`，
 *    没有 `exp`）。所以 `refresh()` 是**刻意的 no-op**，`needsRefresh()` 恒 `false`；
 *    过期只能靠一次 401 发现，然后由用户重新粘贴（面板显示「需重新登录」，
 *    因为 `api.js` 的 `renewable` 判据是「有没有 refresh token」）。
 * 4. **`device_mid` 自己派生，不认账号**。它是硬需求（缺它 billing 全家桶回 `400 code 3001`），
 *    但值**不被上游校验**（实测同一 JWT 换任意随机 UUID 都 200）。所以既不该读别人的
 *    `telemetry-state.json`，也**不能拿它当账号标识**——用它认账号会把同一个账号当成两个。
 * 5. **不实现签到 / 领取积分**：模型请求路径上不需要 captcha（官方 3.14.4 起关闭了校验，
 *    真机日志里 `hasCaptchaVerifyParam:false`），而领取那条路**始终索要** captcha，
 *    并需要先补两条 `event/report` 再查 preview——那是另一个功能，不是「接入模型」的一部分。
 * 6. **不实现官方客户端的 10 次流恢复重试**（真机日志里的 `streamRecoveryMaxRetries: 10`）：
 *    那会把一次已经失败的上游请求变成十次计费请求，而 DSH 自己那一层已经有重试。
 *
 * `system` 的组装（官方身份块 + 环境块 + 调用方 system）与日期块见 `src/wire/zcode-identity.js` 与
 * `src/wire/zcode.js`。身份块那套常量**逐字节**抄自参考实现并带 sha256 指纹，别手改。
 *
 * 本族的 ZCode 协议事实借自另一个中文插件（**借的是证据不是代码**），
 * 登记见 THIRD_PARTY_NOTICES.md 的「借用的证据」。
 * @module dsh-account-bridge/families/zcode
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertApiReply } from '../wire/assert-reply.js'
import { toAnthropicMessages, toAnthropicTools, translateAnthropicStream } from '../wire/anthropic.js'
import { diagnosticReporter } from '../wire/diagnostics.js'
import { deviceId } from '../wire/identity.js'
import {
  ZCODE_BILLING_BALANCE_URL,
  ZCODE_CLIENT_CONFIGS_URL,
  ZCODE_CODING_PLAN_MESSAGES_URL,
  ZCODE_START_PLAN_MESSAGES_URL,
  buildZcodeHeaders,
  buildZcodeSystemBlocks,
  classifyZcodeFailure,
  credentialMaterial,
  credentialShape,
  credentialsForChannel,
  describeChannels,
  modelInfo,
  parseClientConfigs,
  phoneFromUserId,
  pickChannel,
  retryAfterFrom,
  withContextPrefix,
} from '../wire/zcode.js'
import { decodeJwtPayload, tryJson, withSource } from '../util.js'

/**
 * 按账号派生标识时用的族名（与 `family.id` 一致；写死是为了改 id 时会当场露馅）。
 *
 * ⚠ 本族**不用** `accountScopedSession()`：契约 §5 说的那三处会话身份
 * （`x-claude-code-session-id` / `metadata.user_id` / `prompt_cache_key`）是 **Claude 线**的形状，
 * ZCode 这条线上一个都没有——上游认的是 `X-Device-Mid`，而那是**按账号派生**的**设备**标识，
 * 与「哪一段对话」无关。所以本族没有会话标识可发，也就不存在「三处必须同值」的问题。
 * 换句话说：这不是漏了，是这条线本来就没有那个字段。
 */
const IDENTITY_FAMILY = 'zcode'

/**
 * 目录整条挂掉时的兜底模型。
 *
 * 只列**证据里出现过**的 id：start-plan 三个 + coding-plan 两个（见 `src/wire/zcode.js` 的
 * `CHANNEL_MODELS`——那里是通道归属的兜底表，这里只是它的并集）。
 * 窗口/输出取保守值而不是实测的 1M/128k——高估窗口会让一次本该被拦下的请求白烧额度。
 */
export const FALLBACK_MODELS = [
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5-turbo', name: 'GLM-5-Turbo' },
]

/** 额度耗尽时上游回的两种业务码（`1005` 超出配额 / `1113` 无可用资源包）。 */
const QUOTA_CODES = new Set([1005, 1113])

/** 目录里那一段思考元数据：`stream()` 只拿得到模型名（契约 §5.3）。 */
const catalogCache = new Map()


// ------------------------------------------------------------------ 族对象

/** @type {import('../families.js').Family} */
export const zcodeFamily = {
  id: 'zcode',
  displayName: 'ZCode (智谱)',
  route: 'acct-zcode',
  /**
   * risk 定 `high`：coding plan 是**给官方 ZCode 客户端/IDE 用的订阅**，
   * 把它接进第三方宿主并没有被上游明确许可；而且上游对请求体做**内容级风控**
   * （3012），反复触发会把用户账号打成停用。风险落在用户账号上，照实标高。
   */
  risk: 'high',

  // ---------------------------------------------------------------- 本机发现

  /**
   * 看一眼本机有没有 ZCode 客户端登录态。
   *
   * ⚠ **只判断形态，绝不解析值**（理由见文件头第 2 条）。所以这里能返回的只有两种：
   * - 文件在、但值全是 `enc:v1:` 密文 ⇒ `importable:false` + 如实说「加密存储，导不进来」；
   * - 文件里有**没加密**的条目 ⇒ 仍然 `importable:false`，但理由是「我们不读别人的应用数据」。
   *
   * 这两条都不是「没有凭据」，措辞必须让用户看到区别——否则他会以为本机没登录过。
   */
  async discover() {
    const paths = credentialFileCandidates()
    const found = []
    for (const path of paths) {
      let text
      try {
        text = await readFile(path, 'utf8')
      } catch {
        continue
      }
      found.push({ path, text })
    }
    if (found.length === 0) {
      // 真的没有任何登录态文件：这才是「没找到」，返回空数组。
      return []
    }
    const items = []
    for (const { path, text } of found) {
      const parsed = tryJson(text)
      if (parsed === null || typeof parsed !== 'object') {
        items.push({
          family: 'zcode',
          sourcePath: path,
          label: 'ZCode 客户端（未能解析）',
          importable: false,
          reason: '这个文件不是一份 JSON 凭据表',
        })
        continue
      }
      const keys = Object.keys(parsed)
      if (keys.length === 0) {
        items.push({
          family: 'zcode',
          sourcePath: path,
          label: 'ZCode 客户端（空）',
          importable: false,
          reason: '文件里一条条目都没有',
        })
        continue
      }
      const encrypted = keys.filter((key) => typeof parsed[key] === 'string' && parsed[key].startsWith('enc:v1:'))
      const label = encrypted.length > 0 ? 'ZCode 客户端（凭据已加密）' : 'ZCode 客户端（不读取）'
      items.push({
        family: 'zcode',
        sourcePath: path,
        label,
        importable: false,
        reason:
          encrypted.length > 0
            ? `本机 ZCode 客户端的 ${keys.length} 条凭据里有 ${encrypted.length} 条是 enc:v1: 加密存储，` +
              '派生密钥是公开可复现的（等于「读别人应用的登录态」），本插件不实现解密——' +
              '请在下面手动粘贴 Coding Plan API key 或 ZCode JWT'
            : '本插件刻意不读取 ZCode 客户端的登录态（那会让用户分不清 DSH 拿到的是不是自己点的那次授权），' +
              '请在下面手动粘贴 Coding Plan API key 或 ZCode JWT',
      })
    }
    return items
  },

  /** 见 codex 族同名方法的说明：统一发现的落盘入口。`importable` 恒 false，所以走不到这里。 */
  recordFromDiscovery(item) {
    return withSource(recordFromAuth(item.auth, item.label, 'client-import', false), item)
  },

  // ---------------------------------------------------------------- 登录

  login: {
    methods: [
      { id: 'api-key', label: '粘贴 Z.AI Coding Plan API key（订阅制，id.secret 形态）' },
      { id: 'jwt', label: '粘贴 ZCode JWT（积分制，从官方客户端拿）' },
    ],
    async run(session, ctx) {
      const method = session.method === 'jwt' ? 'jwt' : 'api-key'
      const credential = await askCredential(session, method)
      const probe = await validateCredential(ctx, credential)
      if (!probe.ok) throw probe.error
      // ⚠ commit 必须在 run 返回**之前**（契约 §4.2）：晚一步宿主只看到
      // 「resolve 了但没有 grant」，报 `NOT_COMMITTED`。
      await session.commit({
        kind: 'grant',
        payload: recordFromAuth({ access: credential }, labelFor(credential, probe.userId), 'manual', false),
      })
    },
  },

  // ---------------------------------------------------------------- 凭据

  /**
   * **刻意的 no-op**：ZCode 的凭据是静态的，上游没有续期端点（见文件头第 3 条）。
   *
   * 为什么仍然要实现它而不是省略：
   * - 省略了，`api.js` 的「刷新」按钮会去调一个不存在的函数；而且 `needsRefresh` 恒 false
   *   之后根本没人会调它，留着是**给未来的自己留一个明确的落点**（万一上游加了续期端点）。
   * - 返回**新的 auth 对象**（池子浅合并）。这里必须把用户设定与 `device_mid` 原样带回去：
   *   返回 `{}` 会把它们**从记录里抹掉**，而 `device_mid` 丢了以后每个请求都要重新派生
   *   ——值虽然稳定，但那是「碰巧稳定」，不是「记录里存着」。
   */
  async refresh(ctx, payload) {
    const auth = payload.auth ?? {}
    return { ...auth, ...(auth.deviceMid === undefined ? { deviceMid: deviceId(IDENTITY_FAMILY, payload.id ?? 'zcode') } : {}) }
  },

  /** 静态凭据：永远不需要刷新（`expiresAt` 不存在时就该返回 false，别去猜）。 */
  needsRefresh() {
    return false
  },

  // ---------------------------------------------------------------- 目录

  /**
   * 模型目录：`GET /api/v1/client/configs?app_version=…&platform=unknown`。
   *
   * ⚠ 三个容易写错的地方：
   * - `data.builtinModels` 是**对象不是数组**（见 `src/wire/zcode.js` 的 `parseClientConfigs`）；
   * - 这个端点要 `Authorization`，但没有编码通道凭据时照样得给（它只是读配置）；
   * - **拉不到目录不能让整族从选择器里消失** ⇒ 兜底列表 + 上次见过的模型都补上
   *   （「一次瞬时故障不该把用户正在用的模型抹掉」）。
   */
  async listModels(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    const ids = new Map()
    const version = ctx?.config?.zcodeAppVersion
    const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(typeof version === 'string' && version.length > 0 ? version : '3.14.4')}&platform=unknown`
    try {
      const response = await ctx.fetch(
        url,
        { headers: buildZcodeHeaders({ deviceMid: deviceMidOf(auth, payload), authorization: `Bearer ${auth.access}`, json: false }), signal },
        payload.proxy,
      )
      if (response.ok) {
        for (const entry of parseClientConfigs(await response.json().catch(() => undefined))) {
          ids.set(entry.id, entry)
          catalogCache.set(entry.id, entry)
        }
      } else {
        ctx.log?.warn?.('account-bridge: zcode 模型目录返回 HTTP %s，改用兜底列表', response.status)
      }
    } catch (error) {
      ctx.log?.warn?.('account-bridge: zcode 模型目录不可用（%s）', error?.message ?? error)
    }

    const out = []
    for (const entry of ids.values()) out.push(modelInfo(entry.id, entry, zcodeFamily.route))
    if (out.length > 0) return out

    for (const model of FALLBACK_MODELS) {
      out.push(modelInfo(model.id, { name: model.name, ...(catalogCache.get(model.id) ?? {}) }, zcodeFamily.route))
    }
    // 目录里见过、但这次没给的模型也要显示。
    for (const [id, entry] of catalogCache) {
      if (!out.some((model) => model.id === id)) out.push(modelInfo(id, entry, zcodeFamily.route))
    }
    return out
  },

  /**
   * 同步、不联网（探针会拿一个**假模型名**调它，所以必须对任意名字都给得出形状）。
   * `contextWindow` 必须是正整数——0 会让宿主认为这个模型没有窗口。
   */
  resolveModel(provider, model) {
    return modelInfo(model, catalogCache.get(model) ?? { id: model }, provider)
  },

  // ---------------------------------------------------------------- 额度

  /**
   * 用量：`GET /zcode-plan/billing/balance`。**单位是 token 不是积分**
   * （响应里的 `meter: 'model_usage'`、`unit_type: 'token'`），所以进度条说的是
   * 「这个计费周期用了多少 token」，文案里必须写清楚，否则用户会以为是积分。
   *
   * 读不到就返回 `undefined`（契约 §C3）。**绝不编 0%**。
   */
  async quota(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    const response = await ctx.fetch(
      ZCODE_BILLING_BALANCE_URL,
      { headers: buildZcodeHeaders({ deviceMid: deviceMidOf(auth, payload), authorization: `Bearer ${auth.access}` }), signal },
      payload.proxy,
    )
    if (!response.ok) return undefined
    const json = tryJson(await response.text().catch(() => ''))
    return parseAllowance(json)
  },

  // ---------------------------------------------------------------- 调用

  async *stream(ctx, options) {
    // `account` / `session` 在这里**刻意不用**：契约 §5 说的那三处会话身份
    // （`x-claude-code-session-id` / `metadata.user_id` / `prompt_cache_key`）是 **Claude 线**
    // 的概念，ZCode 这条线上一个都没有——上游认的是 `X-Device-Mid`，
    // 而那是**按账号派生**的设备标识（不是会话标识）。所以这里既没有裸 id 可泄漏，
    // 也不存在「三处必须同值」的问题。显式解构出来是为了让下一个改这里的人知道
    // 「不是漏了」，而不是再去发明一个会话头。
    const { payload, model, messages, tools, system, maxTokens, effort, signal } = options
    const auth = payload.auth ?? {}
    const report = diagnosticReporter(ctx, options.onDiagnostic)
    const channel = pickChannel(auth, model, { catalogEntry: catalogCache.get(model) })
    if (channel === undefined) {
      // 一条腿都走不了 ⇒ 一个请求都不发。
      //
      // ⚠ 这里要分**两件后果完全不同**的事，分类错了会当场造成用户可见的损害：
      // - 凭据没了/形态不对 ⇒ `MISSING_CREDENTIAL`（`health.js` 归「换号 + 24 小时 / 账号档」）。
      //   用户的动作是**重新粘贴**，换号救不了。
      // - **凭据是好的，只是没有服务于这个模型的那条腿**（只有订阅 key 却选了积分制的模型）
      //   ⇒ 这是**请求**的问题，不是账号的问题。归 `MISSING_CREDENTIAL` 会把一个
      //   **完全可用**的账号停 24 小时——用户只是换了个模型，代价却是这个账号一整天不能用。
      //   `health.js` 对 `INVALID_REQUEST` 走的是「不换号、不惩罚任何账号」那条分支
      //   （`wire/anthropic.js` / `wire/chat-completions.js` 也用它表示「这个请求本身不行」）。
      const material = credentialMaterial(auth)
      // 「三条腿都不行」再拆一层：**材料本身不认识**（`enc:v1:` 密文 / `urn:` / 空）
      // 与「材料好但模型不在它那条线上」是两件事。前者是账号问题（重新粘贴），
      // 后者是请求问题（换模型）——归错一个就会把可用账号停 24 小时，或反过来把
      // 一个需要重新登录的账号当成「换个模型就好了」而不停地重试。
      const error = new Error(
        material.usable
          ? `zcode: 模型 "${model}" 不在这个账号持有的那条通道上（只有订阅制 key 时只能选 coding-plan 的模型，只有 ZCode JWT 时只能选 start-plan 的模型）——换一个模型就好，不是账号或密钥的问题`
          : material.shape === undefined
            ? 'zcode: 这个账号没有凭据，需要粘贴 Z.AI Coding Plan API key 或 ZCode JWT'
            : `zcode: 账号里那份凭据是「${material.shape}」形态，不是可用的令牌'
              + '（${material.shape === 'encrypted' ? '看起来是 ZCode 客户端那份 enc:v1: 密文——本插件不解密它' : '本插件只认 Coding Plan API key（id.secret）与 ZCode JWT'}）`,
      )
      error.code = material.usable ? 'INVALID_REQUEST' : 'MISSING_CREDENTIAL'
      error.failure = { code: error.code }
      throw error
    }
    const credential = credentialsForChannel(auth, channel)
    const url = channel === 'coding-plan' ? ZCODE_CODING_PLAN_MESSAGES_URL : ZCODE_START_PLAN_MESSAGES_URL
    const cached = catalogCache.get(model) ?? {}
    const body = {
      model,
      max_tokens: Math.max(1, Math.floor(Number(maxTokens) || cached.maxTokens || 32_768)),
      // ⚠ system 的顺序是**准入条件**：官方身份块在最前，环境块次之，调用方 system 在最后。
      system: buildZcodeSystemBlocks({
        system,
        model,
        ...environmentFacts(payload),
      }),
      messages: toAnthropicMessages(withContextPrefix(messages), {
        onDiagnostic: report,
        // 回放：只有上游给了签名的 reasoning 块才能带回去，由共享层判定。
        replay: true,
      }),
      stream: true,
      ...(Array.isArray(tools) && tools.length > 0 ? { tools: toAnthropicTools(tools), tool_choice: { type: 'auto' } } : {}),
    }
    // `effort` 刻意不映射：Anthropic 方言里它是 `thinking.budget_tokens`，而证据里
    // **没有**任何「ZCode 的 reasoningLevels 怎么换算成 thinking 预算」的事实。
    // 猜一个值发出去的代价是一次 400（或一个静默被忽略的字段），而用户看不出差别。
    if (effort !== undefined) {
      report({
        code: 'EFFORT_NOT_SENT',
        severity: 'warning',
        phase: 'request',
        message: `zcode: 收到了 effort="${effort}"，但没有证据说明它怎么映射到 Anthropic 的 thinking 预算，本次不下发`,
      })
    }

    const response = await ctx.fetch(
      url,
      {
        method: 'POST',
        headers: buildZcodeHeaders({
          deviceMid: deviceMidOf(auth, payload),
          appVersion: auth.appVersion ?? ctx?.config?.zcodeAppVersion,
          channel,
          authorization: `Bearer ${credential}`,
        }),
        body: JSON.stringify(body),
        signal,
      },
      payload.proxy,
      // 第 4 个参数必须是 true：长推理里两个数据块之间可能静默超过 30 秒，
      // 不带这个标志会被 undici 的 bodyTimeout 掐断（本仓库修过一次的 bug）。
      true,
    )
    const reply = await assertApiReply(response, { who: 'zcode' })
    if (!reply.ok) {
      const text = await reply.text().catch(() => '')
      throw failureOf(reply, text)
    }
    yield* translateAnthropicStream(reply, { signal, onDiagnostic: report, model })
  },
}

// ------------------------------------------------------------------ 端点与目录

/** 本机 ZCode 凭据文件的候选路径（只看，不解析值）。 */
export function credentialFileCandidates(home = homedir()) {
  return [join(home, '.zcode', 'v2', 'credentials.json')]
}

/** 该账号该发哪个 `X-Device-Mid`：记录里有就用它（稳定），否则按账号派生。 */
function deviceMidOf(auth, payload) {
  if (typeof auth.deviceMid === 'string' && auth.deviceMid.length > 0) return auth.deviceMid
  return deviceOf(payload)
}

/**
 * 按账号派生的 `device_mid`。
 *
 * `deviceId()` 给的是 sha256 hex（64 字符），形状与官方那个 UUID 不同——**上游不校验形状**
 * （实测同一 JWT 换任意随机 UUID 都 200），所以形状差异只在抓包时看得见，不影响功能。
 * 为什么不干脆生成 UUID：那需要再引一个依赖或自己拼随机数，而这里要的只是
 * 「同一账号稳定、不同账号不同」，sha256 恰好就是这样。
 */
export function deviceOf(payload) {
  return deviceId(IDENTITY_FAMILY, payload?.id ?? 'zcode')
}

/**
 * 环境块要的那几样事实。`isGitRepo` 只能在这里算：`src/wire/*` 是**纯翻译层**，
 * 不碰文件系统（那样它就没法在非 Node 环境里被复用）。
 *
 * `existsSync('.git')` 对「目录」和「文件」都返回 true，而这两种都算 git 仓库
 * （worktree / submodule 的 `.git` 就是一个文件）——正是我们要的语义。
 */
function environmentFacts(payload) {
  const cwd = payload?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return { platform: process.platform, arch: process.arch }
  return {
    cwd,
    platform: process.platform,
    arch: process.arch,
    isGitRepo: existsSync(join(cwd, '.git')),
  }
}

/**
 * 目录缓存的复位（给一次性脚本与将来的用例用；本仓库不许加单测）。
 */
export function __resetZcodeCaches() {
  catalogCache.clear()
}

// ------------------------------------------------------------------ 登录辅助

/**
 * 问凭据。**重问而不是抛错**：这是自由文本输入，「粘贴时多带了个空格 / 粘错了东西」
 * 是常态，让它变回一句 `TypeError` 对用户毫无帮助。三次不合法才放弃。
 */
async function askCredential(session, method) {
  let message =
    method === 'jwt'
      ? '粘贴 ZCode JWT（官方客户端里那个 zcodejwttoken 的值）：'
      : '粘贴 Z.AI Coding Plan API key（形如 id.secret 两段点分）：'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await session.prompt({ kind: 'secret', message })
    const value = typeof answer === 'string' ? answer.trim() : ''
    const shape = credentialShape(value)
    if (shape === 'api-key' || (method === 'jwt' && shape !== undefined && shape !== 'api-key')) return value
    // 逐条说清楚为什么不收：用户看到的是「你粘的是个 URN / 是加密串 / 太短」而不是
    // 一句「格式不对」——参考实现里 `urn:zai:...` 这种**端点标识**被当成凭据是最常见的误粘。
    const why =
      shape === 'urn'
        ? '那看起来是一个 urn: 开头的**端点标识**，不是凭据'
        : shape === 'encrypted'
          ? '那是 ZCode 客户端存的 enc:v1: **密文**，我们不解密（见文档）'
          : value.length < 16
            ? '太短了，不像一个完整的令牌'
            : '形态不对'
    message = `${why}。${method === 'jwt' ? '请粘贴 JWT' : '请粘贴 id.secret 形态的 API key'}，再试一次：`
  }
  throw new Error('zcode: 凭据连续三次都不合法，已取消')
}

/**
 * **拿真请求验一次凭据**，再决定要不要落盘。
 *
 * 为什么值得花这一次请求：凭据错的代价是「落盘一个坏账号 → 池子选中它 → 401 →
 * 账号被冷 24 小时」（`health.js` 的 `COOLDOWN.auth`），而验证的成本是一次
 * `max_tokens: 1` 的调用。**收益远大于成本**，所以我们不做「先存下再说」。
 *
 * 判据（真机实测的形状，见 `work/zcode-probe-live.mjs` 的记录）：
 * - **200** ⇒ 通过（也能顺便拿到 `user_id`，从响应体里取，取不到就算了）；
 * - **401** ⇒ 凭据不合法，**这里就挡住**，绝不落盘；
 * - **405 + code 3012** ⇒ 身份块被风控挡了。**这不是凭据问题**，但也不该把凭据落下
 *   ——落下去之后每一次调用都会再触发一次风控（有冷却惩罚），所以同样拒绝，并说清原因；
 * - **402 / 429 + 1005/1113** ⇒ 凭据**是好的**（上游认得它，只是额度用完了），接受；
 * - 其它非 2xx ⇒ 不阻断（网络/网关抖动不该让用户没法加账号），但**日志留痕**。
 *
 * ⚠ 401 这一条依赖真机事实：鉴权在 3012 风控**之前**判定（无凭据时两条通道都回 401，
 * 而不是 405）。所以「401 = 凭据不合法」是可靠的；反过来说，**200 不能证明身份块一定对**
 * ——不过那时候请求已经真的被模型接受了。
 */
export async function validateCredential(ctx, credential, { signal } = {}) {
  const shape = credentialShape(credential)
  const channel = shape === 'api-key' ? 'coding-plan' : 'start-plan'
  const url = channel === 'coding-plan' ? ZCODE_CODING_PLAN_MESSAGES_URL : ZCODE_START_PLAN_MESSAGES_URL
  const body = {
    model: channel === 'coding-plan' ? 'glm-5.3' : 'glm-5.3-flash',
    max_tokens: 1,
    system: buildZcodeSystemBlocks({ system: 'Reply with a single character.', model: 'glm-5.3-flash' }),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    stream: false,
  }
  let response
  try {
    response = await ctx.fetch(
      url,
      {
        method: 'POST',
        headers: buildZcodeHeaders({ deviceMid: deviceId(IDENTITY_FAMILY, 'probe'), channel, authorization: `Bearer ${credential}` }),
        body: JSON.stringify(body),
        signal,
      },
      undefined,
      false,
    )
  } catch (error) {
    // 连不上不是凭据的问题：照实说，让用户自己判断要不要重试。
    return { ok: false, error: transportError(error) }
  }
  const text = await response.text().catch(() => '')
  if (response.ok) {
    const userId = userIdFromBody(text)
    if (text.trim().length === 0) {
      // ⚠ 实测：**额度耗尽时请求根本没送达模型**，网关回的是 `200 + 空体`。
      // 所以「200 且空体」既可能是有效凭据遇上额度用尽，也可能是一次真的空回复
      // ——两者在 wire 上**完全无法区分**，这里只能按「凭据可用」处理（那是不阻断的
      // 那一侧），但必须留痕：否则用户会拿到一个「加成功了、一发就失败」的账号却零线索。
      ctx?.log?.warn?.(
        'account-bridge: zcode 凭据验证拿到 200 但响应体为空（可能是额度耗尽，也可能是上游空回复，wire 上无法区分）',
      )
    }
    return { ok: true, channel, userId }
  }
  const classified = classifyZcodeFailure(response, text)
  if (classified.zcodeBlocked === true || response.status === 401 || response.status === 403) {
    return { ok: false, error: classified }
  }
  const business = tryJson(text)?.code
  if (response.status === 402 || (response.status === 429 && QUOTA_CODES.has(Number(business)))) {
    // 额度用完 ≠ 凭据无效。用户加账号的那一刻额度可能正好在周期末尾。
    ctx?.log?.warn?.('account-bridge: zcode 凭据可用但额度已耗尽（HTTP %s code %s）', response.status, business)
    return { ok: true, channel, userId: undefined }
  }
  ctx?.log?.warn?.('account-bridge: zcode 凭据验证拿到意外状态 HTTP %s（%s），按可用处理', response.status, text.slice(0, 120))
  return { ok: true, channel, userId: undefined }
}

/**
 * `user_id` 从响应体里兜：Anthropic 方言的 200 里**没有**它，但上游加一个字段
 * 或者网关换个包装就可能带上。**取不到就返回 undefined**，绝不去猜一个。
 */
function userIdFromBody(text) {
  const json = tryJson(text)
  const value = json?.user_id ?? json?.data?.user_id ?? json?.user?.data?.user_id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 传输层失败 → 一个诚实的 `TRANSPORT`（`health.js` 对它「换号但不记冷却」）。 */
function transportError(error) {
  const wrapped = new Error(`zcode: 验证凭据时连不上上游（${error?.message ?? error}）`)
  wrapped.code = 'TRANSPORT'
  wrapped.failure = { code: 'TRANSPORT' }
  return wrapped
}

/**
 * 账号的显示名。优先手机号（从 `user_id` 派生），其次 JWT 里的 `sub`，
 * 都没有就如实说这是哪个入口的凭据——**绝不编一个人名**。
 */
export function labelFor(credential, userId) {
  const phone = phoneFromUserId(userId)
  if (phone !== undefined) return `ZCode ${phone}`
  const claims = decodeJwtPayload(credential)
  if (typeof claims?.user_id === 'string' && claims.user_id.length > 0) {
    const fromClaims = phoneFromUserId(claims.user_id)
    if (fromClaims !== undefined) return `ZCode ${fromClaims}`
  }
  if (typeof claims?.sub === 'string' && claims.sub.length > 0) return `ZCode ${claims.sub}`
  return credentialShape(credential) === 'api-key' ? 'ZCode Coding Plan' : 'ZCode'
}

/** 把一次登录的结果整理成账号记录。 */
export function recordFromAuth(auth, label, source, externallyOwned) {
  return {
    family: 'zcode',
    label: label ?? 'ZCode',
    source,
    externallyOwned,
    auth: { ...auth },
    createdAt: new Date().toISOString(),
  }
}

// ------------------------------------------------------------------ 额度投影

/**
 * `billing/balance` → DSH 的额度窗口（`api.js` 的 `quotaOf` 只认这几个字段）。
 *
 * ⚠ 单位是 **token**（`unit_type: 'token'`、`meter: 'model_usage'`）。企业版不下发
 * 额度数字（buckets 为空）⇒ 返回 `undefined`，面板显示「未知」而不是 0%。
 */
export function parseAllowance(json) {
  if (json === null || typeof json !== 'object') return undefined
  const buckets = Array.isArray(json.data?.buckets) ? json.data.buckets : Array.isArray(json.buckets) ? json.buckets : []
  const windows = []
  for (const bucket of buckets) {
    if (bucket === null || typeof bucket !== 'object') continue
    const total = firstPositive([bucket.total_units, bucket.totalUnits])
    const remaining = firstPositive([bucket.remaining_units, bucket.remainingUnits])
    // ⚠ `remaining === 0` 是**真实读数**（用完了），不能与「没这个字段」混为一谈：
    // 所以判据是 `total` 存在，而不是 `remaining` 存在。
    if (total === undefined || total <= 0) continue
    const left = remaining ?? total
    const resetAt = resetTimeOf(bucket.expiresAt ?? bucket.expires_at)
    windows.push({
      id: typeof bucket.meter === 'string' && bucket.meter.length > 0 ? bucket.meter : 'model_usage',
      name: typeof bucket.showName === 'string' && bucket.showName.length > 0 ? bucket.showName : 'Token 用量',
      remainingFraction: Math.min(1, Math.max(0, left / total)),
      ...(resetAt === undefined ? {} : { resetAt }),
    })
  }
  return windows.length > 0 ? windows : undefined
}

/** `expiresAt` 实测是 **Unix 秒**；毫秒与 ISO 串也认（换个包装就不认了太脆）。 */
function resetTimeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  if (typeof value === 'string' && value.length > 0) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber > 1e12 ? asNumber : asNumber * 1000
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function firstPositive(values) {
  for (const value of values) {
    const number = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) return number
  }
  return undefined
}

// ------------------------------------------------------------------ 失败归类

/**
 * 非 2xx → 可直接抛的错误。
 *
 * 归类逻辑全在 `src/wire/zcode.js` 的 `classifyZcodeFailure`（它内部用共享的
 * `mapStatus()` / `failureWords()`）；这里只负责把 `retry-after` 头合进 `failure`，
 * 让池子按上游说的时间冷却而不是按默认值（`http-error.js` 的 `retryAfterMs` 同口径）。
 */
export function failureOf(response, text) {
  const error = classifyZcodeFailure(response, text)
  const retryAfterMs = retryAfterFrom(response)
  if (retryAfterMs !== undefined && error.failure) error.failure.providerRetryAfterMs = retryAfterMs
  return error
}
