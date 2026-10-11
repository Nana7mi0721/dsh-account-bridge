/**
 * 已实现的族登记处。新增一族 = 在这里加一行。
 *
 * 「同一个适配器的两个产品变体各占一行」这件事的字段清单借自 dsh-codearts-auth
 * （**证据**，不是代码），与其它借来的东西一起登记在 `THIRD_PARTY_NOTICES.md`
 * ——`test/e2e/preflight.mjs` 会强制这句话在场。
 * @module dsh-account-bridge/families/registry
 */

import { agyFamily } from './agy.js'
import { buddyFamily } from './buddy.js'
import { claudeFamily } from './claude.js'
import { codeartsFamily } from './codearts.js'
import { codexFamily } from './codex.js'
import { commandcodeFamily } from './commandcode.js'
import { copilotFamily } from './copilot.js'
import { traeFamily } from './trae.js'
import { zcodeFamily } from './zcode.js'
import { genericFamily } from './generic.js'
import { grokFamily } from './grok.js'
import { minimaxFamily } from './minimax.js'
import { qoderFamily } from './qoder.js'
import { raccoonFamily } from './raccoon.js'
import { workbuddyFamily } from './workbuddy.js'

/**
 * 全部族，顺序即 UI 展示顺序：第一档三族 → 第二档 → 通用兜底族放最后
 * （它是「以上都不适用时」的出口，排在前面会喧宾夺主）。
 */
export const FAMILIES = [
  codexFamily,
  claudeFamily,
  agyFamily,
  minimaxFamily,
  qoderFamily,
  // 同厂商相邻：WorkBuddy 与 CodeBuddy 是同一个适配器的两个产品变体
  // （`families/workbuddy.js` 的工厂 + 两份产品描述符），摆在挨着的位置
  // 才能让「为什么有两个」一眼看见。
  workbuddyFamily,
  buddyFamily,
  commandcodeFamily,
  grokFamily,
  copilotFamily,
  traeFamily,
  // ZCode（智谱）与上面十一族没有同厂关系，但它与 `generic` 的位置有一个硬区别：
  // 下面那一族是「以上都不适用」的出口，**必须留在最后**，所以新的具体族一律插在它之前。
  zcodeFamily,
  // Raccoon（商汤小浣熊）同理：与 ZCode 无同厂关系，位置只是「出口之前的最后一个具体族」。
  raccoonFamily,
  // CodeArts（华为云）同理。⚠ 它**不能续期**（临时凭据没有 refresh_token）：
  // `refresh` 是刻意的 no-op、`needsRefresh` 恒 `false`，这是本族与上面每一族最大的
  // 差别，见 `families/codearts.js` 的文件头第一节。
  codeartsFamily,
  genericFamily,
]

/** 全部族的 id。 */
export function familyIds() {
  return FAMILIES.map((family) => family.id)
}

/** 按 id 找族。 */
export function familyById(id) {
  return FAMILIES.find((family) => family.id === id)
}

/**
 * 按配置挑族。
 * `undefined` / 空数组 ⇒ 全部（空数组不是「一个都不要」，那样插件没有任何意义）。
 */
export function selectFamilies(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [...FAMILIES]
  const wanted = new Set(ids)
  return FAMILIES.filter((family) => wanted.has(family.id))
}

/**
 * route 撞车检查：`registerAdapter` 遇到已被占用的 provider 会抛 `DUPLICATE_ADAPTER`，
 * 而且一旦有一个冲突就是全有或全无，所以要在注册前自己先查出来。
 */
export function assertUniqueRoutes(families) {
  const seen = new Map()
  for (const family of families) {
    const previous = seen.get(family.route)
    if (previous) {
      throw new Error(`account-bridge: family "${family.id}" and "${previous}" both claim route "${family.route}"`)
    }
    seen.set(family.route, family.id)
  }
  return families
}
