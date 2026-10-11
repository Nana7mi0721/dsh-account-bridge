/**
 * CodeBuddy（腾讯，中国版）族。
 *
 * 与 `src/families/workbuddy.js` 的 `workbuddyFamily` 是**同一个适配器的两个产品
 * 变体**（同一条线协议、同一套凭据文件目录，差异只在端点、产品码、UA、归属名、
 * 凭据里合法的 realm）。所以这里不重复实现任何协议逻辑：真正的东西在
 * `createBuddyFamily()`，本文件只有这个产品的**声明式配置**。
 * 先例是本仓早先按同样理由合并的 `qoder` / `qodercn`。
 *
 * 这个文件为什么单独存在，而不是把 CodeBuddy 也塞进 `workbuddy.js` 里建两份：
 * `registry.js` 的 `FAMILIES` 数组要的是**族对象**，而 `id` 决定了凭据记录键
 * （`<scope>/<family>-<n>`）与上游路由名。一族一文件是契约 §2 的要求，
 * 而且它让「这一族收哪些凭据」这句话有地方写。
 *
 * 三件必须一起读的事：
 *
 * 1. **本机实测：这份凭据属于本族**。`workbuddy-desktop.info`（8646 B）里的
 *    `auth.domain` 是 `www.codebuddy.cn`，那是登录站 / 认证 realm，也正是
 *    CodeBuddy 的 `knownDomains` 之一（`temp/codearts/src/product.ts:363`）。
 *    文件名是骗人的——两个产品**共用同一个文件目录、只差文件名**，
 *    而中国版的客户端把 CodeBuddy 的凭据写成了 `workbuddy-desktop.info`。
 * 2. **`copilot.tencent.com` 是两家共用的域**（两个产品的 `knownDomains` 都含它，
 *    本机那份时间戳副本的 realm 就是它），所以本族**不会**因为「域是腾讯的就收」
 *    而只是恰好也收它；真正把两家分开的是 `*.workbuddy.ai` / `*.codebuddy.cn`。
 * 3. **凭据是密文**（`{$wbEncrypted:1, envelope}`），本族不解，只如实报
 *    `importable:false` 并引导到「手动粘贴令牌」。这条不是本族的选择，
 *    是这台机器上的事实（与 WorkBuddy 5.6+ 同一套静态加密）。
 *
 * 借用的**证据**（协议事实，不是代码）登记在 `THIRD_PARTY_NOTICES.md` 的
 * 「借用的证据（协议事实与事故史，不是代码）」一节；
 * `src/wire/buddy.js` 是这些事实的落地处。
 * @module dsh-account-bridge/families/buddy
 */

import {
  CODEBUDDY_CHAT_BASE,
  CODEBUDDY_FALLBACK_MODELS,
  CODEBUDDY_PRODUCT,
  CODEBUDDY_WEB_HOME,
} from '../wire/buddy.js'
import { createBuddyFamily } from './workbuddy.js'

export const ID = CODEBUDDY_PRODUCT.id
export const ROUTE = 'acct-codebuddy'
/** 界面上的名字。与 codearts 的 `displayName` 同形（`src/product.ts:333`）。 */
export const DISPLAY_NAME = 'CodeBuddy（腾讯）'

/**
 * 中国版的凭据文件。
 *
 * **只有一个变体**：CodeBuddy 中国版没有国际网关，所以不设第二条产品线——
 * 多列一个「国际版」只会让用户面对一个永远扫不到东西的选项。
 *
 * ⚠️ 文件名与 WorkBuddy 中国版**逐字相同**，这不是笔误：两个产品共用同一个目录
 * （`CodeBuddyExtension/Data/Public/auth`），文件名由各自的客户端决定，而腾讯这两
 * 个客户端挑了一样的名字。所以归属判据只能是内容里的 `auth.domain`，不是文件名
 * ——`src/families/workbuddy.js` 的 `documentDomain()` 就是为这件事写的。
 */
export const VARIANTS = Object.freeze([
  Object.freeze({
    id: 'cn',
    filename: 'workbuddy-desktop.info',
    label: 'CodeBuddy 桌面端（中国版）',
    authFileEnv: 'CODEBUDDY_AUTH_FILE',
  }),
])

/**
 * 本机实测到的两处站点。
 *
 * `CODEBUDDY_CHAT_BASE` 是接口域名（`copilot.tencent.com`），
 * `CODEBUDDY_WEB_HOME` 是登录站 / 成长中心（`www.workbuddy.cn`，不签发 token）。
 * 后者只进文档与注释，**不进请求**：`product.ts:345-361` 那段注释专门讲清楚了
 * 「`domain` = token 的 `iss` = 登录站 realm」这件事，把网页站当成 realm 登记
 * 会让两套归属判据对同一个域给出矛盾答案。
 */
export const ENDPOINTS = Object.freeze({
  api: CODEBUDDY_CHAT_BASE,
  web: CODEBUDDY_WEB_HOME,
})

/**
 * CodeBuddy（腾讯，中国版）。
 *
 * `risk: 'high'` 的理由与 WorkBuddy 一样、不是随手抄的：这一族的凭据是**账号级
 * 订阅令牌**，一个账号被打到限流会连着影响用户自己的客户端；而且这里的额度是
 * 积分制，读不懂就该说读不懂（`quota` 返回 `undefined`），不能报 0。
 */
export const buddyFamily = createBuddyFamily({
  product: CODEBUDDY_PRODUCT,
  noun: 'CodeBuddy',
  displayName: DISPLAY_NAME,
  route: ROUTE,
  variants: VARIANTS,
  homeEnv: 'CODEBUDDY_HOME',
  // `fallbackModels` 是**快照**不是权威：首次 `listModels` 成功之前，设置页里
  // 至少有一份能看的清单。远端目录一到就以远端为准（`resolveModel` 里那条短路）。
  fallbackModels: CODEBUDDY_FALLBACK_MODELS,
  // `copilot.tencent.com` 刻意**不在**这里：它是两家共用的（见文件头第 2 条），
  // 一个域分不出两个产品时，本族宁可报「可导入」并让上游去 401，
  // 也不肯凭猜把一份真凭据判给别家。
  sharedDomains: ['copilot.tencent.com'],
  // `*.workbuddy.ai`：国际版 WorkBuddy 的独占域（`src/product.ts:549`）。
  // 后缀匹配要的是 `.<模式>`，所以两条都写（apex 与子域）。
  siblingOwnership: [
    { domains: ['workbuddy.ai', 'www.workbuddy.ai'], who: 'WorkBuddy 国际版', where: 'WorkBuddy' },
  ],
})
