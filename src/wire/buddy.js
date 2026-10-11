/**
 * CodeBuddy（腾讯，中国版）的**产品描述符**。
 *
 * 这一层不含协议代码：CodeBuddy 与 WorkBuddy 走同一条线协议（`/v2/chat/completions`
 * 的 OpenAI 兼容 SSE），差异全在「我们像谁」——端点、产品码、UA、归属名、凭据里
 * 合法的 realm。所以本文件只声明这些值，翻译逻辑一律复用 `src/wire/workbuddy.js`
 * 里那几个收 `product` 尾参的函数。
 *
 * **为什么产品描述符不写在 `families/buddy.js` 里**：族那一层是「怎么和宿主打交道」，
 * 产品那一层是「上游怎么认出我们」。混在一起之后，下一次加第三个变体（比如
 * CodeBuddy 国际版）就又要去读一遍族的 700 行。
 *
 * 事实来源（借的是**证据**不是代码，见 `THIRD_PARTY_NOTICES.md` 的
 * 「借用的证据（协议事实与事故史，不是代码）」一节）：
 * - `temp/codearts/src/product.ts:326-365`：本产品的 `productCode` / `userAgent` /
 *   `clientVersion` / `attributionName` / `endpoint` / `knownDomains`；
 * - `temp/codearts/src/product.ts:230-322`：`CODEBUDDY_FALLBACK_MODELS` 十六条；
 * - `temp/codearts/src/buddy-adapter.ts:2040-2082`：这些值怎么变成请求头。
 *
 * @module dsh-account-bridge/wire/buddy
 */

/**
 * CodeBuddy（中国版）的产品身份。
 *
 * 逐字段对照 `temp/codearts/src/product.ts:326-365`，**只取本仓用得上的**：
 * 那边的 `platform` / `claimBase` / `webBase` / `cliVersion` / `defaultCredentialRef` /
 * `appendSessionParams` 服务的是它自己的凭据存储与 OAuth，与本仓的族契约无关
 * （本仓的凭据记录形状由 `docs/family-contract.md` §3 定义）。
 *
 * 一处**刻意的差异**：那边 `apiDomain: 'copilot.tencent.com'` 是与 `endpoint` 分开的
 * 两个字段（一个填 `X-Domain`、一个拼 URL）。本仓的 `X-Domain` 必须来自凭据
 * （那是账号所属的分组网关，见 `families/workbuddy.js` 的 `X-No-Department-Info`
 * 分支），所以这里**不声明 apiDomain**，少一个能被误用的字段。
 *
 * @type {import('./workbuddy.js').BuddyProduct}
 */
export const CODEBUDDY_PRODUCT = Object.freeze({
  id: 'codebuddy',
  noun: 'CodeBuddy',
  // 中国版只有 cn 一条产品线：`knownDomains` 里三个域都指向国内网关。
  region: 'cn',
  productCode: 'codebuddy',
  // 中国版**只有一条产品线，无需按模型分档**，全部模型沿用 IDE UA
  // （`src/product.ts:337` 的 userAgentByModelFamily 是空数组）。
  chatUserAgent: 'CodeBuddyIDE/1.106.1',
  clientVersion: '1.106.1',
  attributionName: 'CodeBuddy',
  /**
   * **`true`**：按产品码报身份（`X-Product: CodeBuddy` + `X-Product-Code: codebuddy`）。
   * 依据是 codearts 的 `src/buddy-adapter.ts:2056-2063`——它说 `X-Product` 是归属名，
   * 历史实现发 `X-Product: SaaS` 会让后台**归因不到产品**；而它的 CodeBuddy 产品正指向
   * 我们这个域名 `copilot.tencent.com`，所以这条证据对本产品直接成立。
   * （WorkBuddy 那边刻意保持 `SaaS`：见 `src/wire/workbuddy.js` 的
   * `WORKBUDDY_PRODUCT.sendProductCode`。）
   */
  sendProductCode: true,
  // 目录请求用同一个 IDE UA：本产品没有「CLI 花名册 / App 花名册」这一层分叉
  // （WorkBuddy 那边才是靠 UA 分叉的，见 `src/wire/workbuddy.js` 的
  // `catalogUserAgent`）。
  catalogUserAgent: 'CodeBuddyIDE/1.106.1',
  // ⚠️ **没有实证**：这个头的值只在 `temp/codearts` 里以 `'workbuddy'` 出现过
  // （那是产品码），本仓据此推断本产品要发自己的产品码。若上游不认，症状会是
  // 刷新 400，而不是静默 —— 见报告与 `THIRD_PARTY_NOTICES.md` 的证据强度列。
  // 不再往下猜 `'codebuddy-refresh'` 之类的字面量。
  refreshSource: 'codebuddy',
  origin: 'https://copilot.tencent.com',
  knownDomains: ['copilot.tencent.com', 'www.codebuddy.cn', 'codebuddy.cn'],
})

/** 中国版登录站（`claimBase` / `webBase`，`src/product.ts:332-333`）。本仓只在文档里用它。 */
export const CODEBUDDY_WEB_HOME = 'https://www.workbuddy.cn'

/**
 * CodeBuddy 的端点。
 *
 * 取值口径与 WorkBuddy 的 CN 区**完全一样**：`/v2/chat/completions` 与 `/v3/config`
 * 都打在 `copilot.tencent.com` 上（`src/buddy.ts` 的 `API_ENDPOINT` + `PREFIX_PATH`）。
 */
export const CODEBUDDY_CHAT_BASE = 'https://copilot.tencent.com'

/**
 * 内置模型目录（兜底用，**不是**权威来源）。
 *
 * 逐条抄自 `temp/codearts/src/product.ts:230-322`（十六条），字段名就地翻译成契约的词汇
 * （`maxOutputTokens` → `maxTokens`、`reasoningEfforts` → `efforts`、
 * `defaultReasoningEffort` → `defaultEffort`），**数值一个都没动**。
 *
 * 那边对这份表的自评必须一起抄过来，否则读者会以为这是权威：
 * - 数据来源是它读到的 `/v3/config` **`craft` agent 白名单**，并逐条用真实请求
 *   验证可用；远端目录里另有一批会回 `code=11102 service info not found` 的条目
 *   （`glm-4.6` / `minimax-m2.5` / `hunyuan-*` 等）**被它特意排除**——本仓照做，
 *   不把会报错的模型放进选择器。
 * - `deepseek-v4-flash` 的档位说**已被它自己推翻**（issue IKJQSH：服务端确实校验
 *   档位枚举，拼错的 `banana` 会 400），它选择「不擅自改动既有行为」；
 *   本仓同样不擅自改。
 * - `glm-5.1` 的 `supportsImages: true` 与它读到的 scoped 端点返回值矛盾
 *   （scoped 说 false，另三处说 true），它以「实测能看到图」为准。
 *
 * 本仓**没有在真机上复验过这份表的任何一条**（理由与证据强度见 README 的族状态表）。
 * 它的唯一作用是：首次 `listModels` 还没成功时，设置页里有一份能看的清单，
 * 而不是一片空白；远端目录一到就以远端为准（见 `families/buddy.js` 的
 * `resolveModel`）。
 */
export const CODEBUDDY_FALLBACK_MODELS = Object.freeze([
  // contextWindow 的单位是 token；`supportsImages` 决定我们敢不敢向宿主声明
  // `inputModalities: ['text','image']`（声明了却没转发成图片，宿主会把图片换成
  // 占位文字，用户看到的是「模型说它没收到图」）。
  Object.freeze({ id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, efforts: ['high'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, efforts: ['low', 'high'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, efforts: ['low', 'high'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 128_000, efforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, maxTokens: 50_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 64_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 32_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 64_000, efforts: ['high', 'xhigh'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000, efforts: ['medium'], supportsImages: true }),
  Object.freeze({ id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200_000, maxTokens: 64_000, efforts: ['medium'], supportsImages: true }),
  Object.freeze({ id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1_000_000, maxTokens: 32_000, efforts: ['medium'], supportsImages: true }),
  Object.freeze({ id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, maxTokens: 64_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsImages: true }),
  Object.freeze({ id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: 256_000, maxTokens: 32_000, efforts: ['medium'], supportsImages: true }),
  Object.freeze({ id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, efforts: ['medium'], supportsImages: true }),
  Object.freeze({ id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 64_000, efforts: ['medium'], supportsImages: true }),
])
