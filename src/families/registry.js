/**
 * 已实现的族登记处。新增一族 = 在这里加一行。
 * @module dsh-account-bridge/families/registry
 */

import { agyFamily } from './agy.js'
import { claudeFamily } from './claude.js'
import { codexFamily } from './codex.js'
import { commandcodeFamily } from './commandcode.js'
import { genericFamily } from './generic.js'
import { minimaxFamily } from './minimax.js'
import { qoderFamily } from './qoder.js'
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
  workbuddyFamily,
  commandcodeFamily,
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
