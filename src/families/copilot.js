/**
 * GitHub Copilot 族：把账号级的 GitHub Copilot 订阅接进 DSH 的模型选择器。
 *
 * 协议细节全在 `src/wire/copilot.js`（设备码状态机、token 交换、目录映射、失败归类），
 * 这个文件只做「把它们接到契约要求的形状上」这一件事。
 *
 * ## 一、能力边界：先说做不到的
 *
 * 1. **`GET /copilot_internal/v2/token` 是 GitHub 自述的 non-public、unstable 接口**，
 *    随时可能整体失效（youngrock 的 `README.md:80-83` 原文：「That endpoint is a non-public,
 *    unstable interface; GitHub may change or revoke it at any time.」；考古 §2.3/§3.1③）。
 *    没有它就拿不到 Copilot token，也就没有这个族。`risk` 因此照实写 `'high'`，
 *    **维护者接线时请把这一句抄进 README 的族清单**（本文件不许改 README）。
 *    失效时的样子是 401/403/404，而不是一句「你没有订阅」——所以我们的错误信息一律带
 *    HTTP 状态和上游原文，方便区分「协议变了」和「账号没订阅」。
 * 2. **`editor-version` 是一颗定时炸弹**：上游对太旧的编辑器版本回 `401 IDE token expired`，
 *    长得和「令牌被撤」一模一样。所以版本号动态取（`createVersionResolver`，缓存 24h）
 *    并在任何 401 上强制作废缓存重试一次。注意那是 **VS Code 本体**的版本号
 *    （`1.107.0` 那一档），不是 copilot-chat 扩展的版本号（`0.56.0` 那一档）——
 *    本机实测扩展就是 0.56.0，填错了是 100% 401。要写死的时候用
 *    `ctx.config.copilotEditorVersion`（形态必须是 `\d+.\d+.\d+`），这是留给
 *    「上游又一次拒了我们的版本号、而你不想等我们发版」的应急出口。
 * 3. **Copilot 没有额度接口**，所以 `quota()` 返回 `undefined`，面板显示「未知」。
 *    见 V1ki `src/providers/pool-usage.ts:74-81`（那里有一段专门解释为什么 copilot 拿不到额度）
 *    以及 `src/index.ts`（它只给 codex/claude/grok/antigravity 注册了 usageFetcher，没有 copilot）。
 *    契约 §C3 的规矩：读不到就是「未知」，**绝不编一个 0%**。
 * 4. **本机没有任何可导入的 Copilot 登录态。** Windows 上 VS Code 把令牌交给 DPAPI
 *    加密保管（`%APPDATA%\Microsoft\Credentials\` 下的凭据 blob），只有同一个 Windows 用户
 *    能解开；macOS/Linux 是系统钥匙串。VS Code 也从不把它写成可读的 JSON 文件。
 *    参考实现的 1051 行代码里同样没有读 VS Code 登录态的路径（对 `github-copilot`/
 *    `hosts.json` 零命中）。所以 `discover()` 如实返回一条 `importable: false` 的记录 +
 *    可复核的 reason，登录只能走设备码。
 *
 * ## 二、只接了 `/chat/completions` 一条线（有意的降级，不是漏写）
 *
 * VS Code 的模型目录会给每个模型声明 `supported_endpoints`，新版 GPT 系（gpt-5.6 之类）
 * 只列 `/responses`。**那种模型我们一个都不列**：列进选择器，用户点下去必然 400。
 * 目录里其余模型（含缺这个字段的旧条目）走 chat 线，翻译复用
 * `src/wire/chat-completions.js`，本族不抄第二份翻译层。
 *
 * 代价是 `planReasoningEffort` 那条降级：上游在 chat 线上拒绝「function tools +
 * reasoning_effort」的组合（HTTP 400 `invalid_request_body`，V1ki 在 gpt-5.4 上实测），
 * 官方建议是改道 `/responses`。我们没接 responses，于是**在有工具调用时把 effort 退掉**
 * 并 `log.warn` 一次（按模型去重，不刷屏）。
 * TODO：接上 responses 线是这条降级的根治办法，但那是另一个 wire 模块 + 另一套翻译，
 * 不该塞进这个族的第一个版本里。
 *
 * ## 三、base URL 与凭据
 *
 * - 推理 base URL **按账号**取自 token 交换响应里的 `endpoints.api`（个人账号与 Business
 *   账号的 host 不同；连上游 `/models` 目录里声明的端点都可能是错的，见 lujianjun19
 *   `docs/adr/0002-narrow-to-credential-provider.md:7`）。缺了就抛错，**绝不回落任何写死的域名**。
 * - `auth.refresh` 是 GitHub 的 `ghu_*` 长期 token：**它不轮换**，所以「刷新凭据」= 拿同一个
 *   token 重做一次 token 交换，`auth.expiresAt` 是那个短期 Copilot token 的寿命。
 *   登录态是我们自己用设备码换来的，不是从别的程序那儿借来的 ⇒ **不写回任何文件**
 *   （`externallyOwned: false`，对比 minimax 那种「与桌面端共用一份、刷新要写回」的族）。
 *   如果以后有人想加导入路径：记住 `ghu_*` 长期有效、不轮换，刷新不需要写回源文件。
 *
 * @module dsh-account-bridge/families/copilot
 */

import { existsSync } from 'node:fs'

import {
  CHAT_WIRE,
  apiBaseUrl,
  copilotChatBody,
  copilotError,
  copilotHeaders,
  createVersionResolver,
  credentialSites,
  exchangeCopilotToken,
  fetchGitHubLogin,
  importBlockerReason,
  modelInfo,
  modelsFromCatalog,
  needsRefresh as copilotNeedsRefresh,
  pollDeviceToken,
  requestDeviceCode,
  requestWithEditorVersion,
} from '../wire/copilot.js'
import { translateChatStream } from '../wire/chat-completions.js'
import { redact, sleep, tryJson } from '../util.js'

const ROUTE = 'acct-copilot'
const DISPLAY_NAME = 'GitHub Copilot'
const DEFAULT_LABEL = 'GitHub Copilot'

/**
 * 目录拉不到时的兜底快照（V1ki `src/index.ts:267-272` 的 copilot 静态目录，四个 id 与视觉能力
 * 照抄）。**上下文窗口一律按保守值给**：兜底的作用是「让这个族别从模型选择器里消失」，
 * 不是「提供准确的元数据」——真实的窗口在目录能拉到时由上游给。
 */
const FALLBACK_MODELS = [
  { id: 'gpt-4.1', name: 'GPT-4.1' },
  { id: 'gpt-4o', name: 'GPT-4o' },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
]

/**
 * `editor-version` 的进程级解析器（缓存 24h、并发合并、失败回落常量）。
 * 放在模块级是有意的：一个插件进程就是一份缓存，没必要每个请求都问一次发布列表。
 */
const versions = createVersionResolver()

/**
 * 用来发请求的解析器。优先 `ctx.config.copilotEditorVersion`（应急写死），
 * 否则走动态解析。**写死那条路只在真的被上游拒了的时候才该用**：它迟早会旧到全盘 401。
 */
const editorVersions = {
  resolve(ctx, proxy, options = {}) {
    const pinned = ctx?.config?.copilotEditorVersion
    if (typeof pinned === 'string' && /^\d+\.\d+\.\d+$/.test(pinned)) return Promise.resolve(pinned)
    return versions.resolve(ctx, proxy, options)
  },
}

/** 已经提醒过「effort 被退掉」的模型（每个模型只说一次，别把日志刷满）。 */
const warnedEffortDrop = new Set()

/**
 * 进程内记住目录里见过的模型元数据。
 * `resolveModel(provider, model)` 只拿得到模型 id（契约给它的签名就是这样，没有 payload），
 * 所以这是它唯一能给出**真实**上下文窗口的途径；没见过的 id 会用保守兜底。
 */
const catalogMemory = new Map()

function rememberModels(models, { overwrite = true } = {}) {
  for (const model of models) {
    if (overwrite || !catalogMemory.has(model.id)) catalogMemory.set(model.id, model)
  }
}

/** 请求里有没有图片（决定发不发 `copilot-vision-request`）。 */
function hasImageInput(messages = []) {
  for (const message of messages) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'image') return true
    }
  }
  return false
}

/** 账号记录。`source` 只有两个取值：设备码登录 = `'oauth'`（本族没有导入路径）。 */
function recordFromAuth(auth, label) {
  return {
    family: 'copilot',
    label: typeof label === 'string' && label.length > 0 ? label : DEFAULT_LABEL,
    source: 'oauth',
    // 登录态是我们自己换来的：别的程序不拥有它，我们也不往别的程序的文件里写。
    externallyOwned: false,
    auth,
    createdAt: new Date().toISOString(),
  }
}

/** 目录拉取失败只提醒一次同一条原因，避免每次模型选择都刷一遍日志。 */
function warnCatalogFallback(ctx, error) {
  ctx?.log?.warn?.(
    'account-bridge: copilot 模型目录不可用（%s），先用兜底快照；真实窗口等目录恢复后再更新',
    redact(String(error?.message ?? error)),
  )
}

export const copilotFamily = {
  id: 'copilot',
  displayName: DISPLAY_NAME,
  route: ROUTE,
  /**
   * `'high'`：两个结构性风险都是「不归我们管、一失效就整族不可用」——
   * 非公开的 token 交换接口，以及一个会让所有请求 401 的 `editor-version`。
   * 照实写，不为了让面板好看而降级（契约要求如实）。
   */
  risk: 'high',

  // ---------------------------------------------------------------- 发现

  /**
   * 本机**没有**可导入的 Copilot 登录态（见文件头第 4 条），所以这里返回的是一条
   * 「查过了、不可导入」的诚实记录，而不是空数组。
   *
   * 为什么不是空数组：空数组在面板上等于「这一族什么都没找到」，而用户真正需要知道的是
   * 「为什么我在 VS Code 里明明登录了却不能导入」——那正是 `reason` 里的答案，
   * 而且里面列了我们**真的去看过**的位点，用户可以自己复核。
   */
  async discover() {
    const sites = credentialSites()
    const existing = []
    for (const site of sites) {
      try {
        if (existsSync(site.path)) existing.push(site.path)
      } catch {
        // 权限/怪路径：当作不存在，理由里会如实少列这一条。
      }
    }
    return [
      {
        family: 'copilot',
        sourcePath: existing[0] ?? sites[0].path,
        label: 'GitHub Copilot（VS Code 登录态）',
        importable: false,
        reason: importBlockerReason(sites, { existing }),
      },
    ]
  },

  // 这里没有 `recordFromDiscovery`：本族没有任何 `importable: true` 的发现结果，
  // 写一个只会返回壳的函数就是契约 §2 说的「空壳」（写了 = 宣称有这个能力）。

  // ---------------------------------------------------------------- 登录

  login: {
    // 只有一种方式：设备码。没有导入方式（第 4 条），也没有浏览器回调方式
    // （GitHub App 的 client_id 不允许我们改回调地址，而且设备码本来就够用）。
    methods: [{ id: 'device', label: '用设备码登录 GitHub Copilot' }],

    /**
     * RFC 8628 设备码登录：
     * 拿设备码 → **用 `session.notify` 把 user_code/verification_uri 推给用户** → 轮询到授权完成
     * → 拿 GitHub token 换 Copilot token（这一步才证明这个账号真有 Copilot）→ commit。
     *
     * 全程**只用 `notify`、不用 `prompt`**（设备码是给用户照着念的，不是要他输入什么），
     * 所以这条登录在 agent 侧的非交互路径上也能跑完——broker 只会自动回答
     * 「只有一个选项的 select」，我们不依赖那个。
     *
     * 契约要求 `run()` **必须在 resolve 之前 commit**，否则 seam 抛 `NOT_COMMITTED`。
     */
    async run(session, ctx) {
      const proxy = session.proxy
      const signal = session.signal

      const device = await requestDeviceCode({ ctx, proxy, signal })
      session.notify({
        message:
          `在浏览器里打开 ${device.verificationUri}，输入代码 ${device.userCode} 并授权。` +
          `设备码 ${Math.round(device.expiresInMs / 60_000)} 分钟内有效。`,
        url: device.verificationUri,
        // broker 会把 code 记进 attempt（`src/login/broker.js:79-84`），面板可以直接显示它。
        code: device.userCode,
      })

      const { accessToken } = await pollDeviceToken({ ctx, proxy, device, signal, sleep })

      // 换 Copilot token 是「这个账号到底有没有 Copilot」的唯一判据：
      // 没有订阅 / 没被授权的账号在这一步被拒（401/403）。
      // **别把它和 UA 触发的反爬 403 搞混**——那是 GitHub 认不出 User-Agent，
      // 跟订阅无关，所以错误信息里一定要带上游原文。
      const auth = await exchangeCopilotToken({
        ctx,
        githubToken: accessToken,
        proxy,
        signal,
        resolver: editorVersions,
      })

      // 用户名只是为了给账号起个显示名；读不到就叫 GitHub Copilot（不编一个假名字）。
      const login = await fetchGitHubLogin({ ctx, githubToken: accessToken, proxy, signal })

      await session.commit({
        kind: 'grant',
        // `refresh` 是 GitHub 的长期 token：它不轮换，但刷新时必须拿它去换新的 Copilot token。
        payload: recordFromAuth({ ...auth, refresh: accessToken }, login),
      })
    },
  },

  // ---------------------------------------------------------------- 凭据

  /**
   * 「刷新」= 拿同一个 GitHub token（`ghu_*`，不轮换）重做一次 token 交换，
   * 换回一个新的短期 Copilot token。
   *
   * 返回的是**新的 auth 对象**（不是整个 payload）：池子做浅合并
   * `{...current.auth, ...auth}`，所以这里显式带上 `refresh`，让「它不变」这件事一眼可见。
   * 池子调这里时 `signal` 传的是 `undefined`，实现里没有假定它存在。
   */
  async refresh(ctx, payload, signal) {
    const auth = payload?.auth ?? {}
    const next = await exchangeCopilotToken({
      ctx,
      githubToken: auth.refresh,
      proxy: payload?.proxy,
      signal,
      resolver: editorVersions,
    })
    return { ...next, refresh: auth.refresh }
  },

  /** Copilot token 到期前 5 分钟就该换（`expiresAt` 缺失时不猜）。 */
  needsRefresh(payload, now) {
    return copilotNeedsRefresh(payload, now)
  },

  // ---------------------------------------------------------------- 目录

  /**
   * 目录来自账号自己的 `endpoints.api`（**不是**写死的域名）。
   *
   * 拉不到时**不抛**：回落到兜底快照，绝不把整族模型弄消失（codex / minimax 同款理由：
   * 一个 403 就让用户的模型选择器里少掉一整族，比列出一个可能不可用的 id 更糟）。
   */
  async listModels(ctx, payload, signal) {
    const auth = payload?.auth ?? {}
    const fallback = () => {
      const models = FALLBACK_MODELS.map(
        // 目录里见过这个 id 就用**真实**的元数据：上游刚抽风不该把用户已经看到的
        // 200k 窗口缩成兜底值（读不到的仍然给保守值）。
        (model) => catalogMemory.get(model.id) ?? modelInfo(model.id, model.name, { images: true }, ROUTE),
      )
      // 兜底条目**不覆盖**目录里已经见过的真实元数据。
      rememberModels(models, { overwrite: false })
      return models
    }
    try {
      const base = apiBaseUrl(auth)
      const response = await requestWithEditorVersion({
        ctx,
        proxy: payload?.proxy,
        signal,
        request: {
          url: `${base}/models`,
          init: { method: 'GET', headers: copilotHeaders({ token: auth.access }), signal },
        },
        resolver: editorVersions,
      })
      const text = await response.text().catch(() => '')
      if (!response.ok) throw copilotError(response, text, 'copilot models')
      const models = modelsFromCatalog(tryJson(text), ROUTE)
      rememberModels(models)
      return models
    } catch (error) {
      warnCatalogFallback(ctx, error)
      return fallback()
    }
  },

  /**
   * 单个模型的元数据。契约要求严格回显 `provider` / `id`。
   * 目录里见过这个 id 就用它的真实窗口（见 `catalogMemory`），否则用保守兜底。
   */
  resolveModel(provider, model) {
    const known = catalogMemory.get(model)
    return known ? { ...known, provider, id: model } : modelInfo(model, model, {}, provider)
  },

  // ---------------------------------------------------------------- 额度

  /**
   * **Copilot 没有额度接口**，所以这里返回 `undefined`（面板显示「未知」）。
   *
   * 为什么不干脆不实现：行为一样（`src/api.js:129-148` 对「没有 quota 方法」和
   * 「返回 undefined」都归一成 `undefined`），但写在这里能把「为什么没有」留在代码里：
   * 见 V1ki `src/providers/pool-usage.ts:74-81`（专门解释 copilot 拿不到额度）
   * 与 `src/index.ts`（它只给 codex/claude/grok/antigravity 注册了 usageFetcher）。
   * 契约 §C3：读不到就是「未知」——**绝不编一个 0%**。
   */
  async quota() {
    return undefined
  },

  // ---------------------------------------------------------------- 调用

  /**
   * 一次推理。上游是 OpenAI Chat Completions 兼容的，所以翻译全部交给
   * `src/wire/chat-completions.js`（chunk 序列、usage、`finish.reason.kind` 的映射、
   * 以及「一个内容块都没出就抛 `EMPTY_RESPONSE`」都在那边——本族不抄第二份）。
   *
   * `ctx.fetch` 的**第 4 个参数必须传 `true`**：不传的话配了代理的账号会在长推理里
   * 被 undici 默认 30s 的 `bodyTimeout` 掐断（`src/http.js` 文件头的那次事故）。
   */
  async *stream(ctx, options) {
    const { payload, model, messages, tools, effort, system, maxTokens, signal } = options
    const auth = payload?.auth ?? {}
    if (typeof auth.access !== 'string' || auth.access.length === 0) {
      const error = new Error('copilot: this account has no Copilot token on record; sign in again')
      error.code = 'AUTH'
      throw error
    }

    // 缺 endpoints.api 时这里抛 AUTH（绝不回落写死的域名，见文件头第三条）。
    const base = apiBaseUrl(auth)
    const { body, droppedEffort } = copilotChatBody({ model, system, messages, tools, effort, maxTokens })
    if (droppedEffort !== undefined && !warnedEffortDrop.has(model)) {
      warnedEffortDrop.add(model)
      ctx?.log?.warn?.(
        'account-bridge: copilot %s 带着工具调用，reasoning effort "%s" 已退回上游默认（chat 线上游拒绝这个组合，见 src/wire/copilot.js 的 planReasoningEffort）',
        model,
        droppedEffort,
      )
    }

    const response = await requestWithEditorVersion({
      ctx,
      proxy: payload?.proxy,
      signal,
      streaming: true,
      resolver: editorVersions,
      request: {
        url: `${base}${CHAT_WIRE}`,
        init: {
          method: 'POST',
          headers: copilotHeaders({
            token: auth.access,
            json: true,
            stream: true,
            hasImages: hasImageInput(messages),
          }),
          body: JSON.stringify(body),
          signal,
        },
      },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw copilotError(response, text, 'copilot')
    }
    yield* translateChatStream(response, { signal })
  },
}
