/**
 * usage 的合并纪律：**后到的非零值覆盖，零值绝不擦除**。
 *
 * 为什么需要一条纪律：usage 在流式协议里是**分片上报**的。Anthropic 在 `message_start`
 * 报 `input_tokens`、在 `message_delta` 报 `output_tokens`；兼容端点则经常在
 * `message_delta` 里顺手回一个 `{input_tokens: 0}`——**不是「输入是 0」，而是「这一帧
 * 没什么可说的」**。用 `{...previous, ...next}` 合并就等于让后者擦掉前者：
 *
 * - 账单面板上输入 token 变成 0；
 * - 更糟的是凡是以 usage 为信号的判断（缓存命中、上下文用量）全部失真；
 * - 而且它**只在部分端点、部分账号上出现**，是最难复现的那类偏差。
 *
 * 所以规则是三条：
 *
 * 1. 后到的**有限数字且非零** ⇒ 覆盖；
 * 2. **零值不擦除**已有的读数（但「本来就没有」时会把 0 记下来——那是一次真实的读数）；
 * 3. `undefined` / `null` / `NaN` / 非数字 ⇒ 视为「这一帧没上报」，什么都不做。
 *
 * 第 2 条和第 3 条合起来，让「未上报」（`key` 不在对象里 / `undefined`）与
 * 「显式为 0」（`key: 0`）在类型上仍然分得开。别的语言里这件事常用可空类型或指针
 * 表达；JS 里最省事的等价物就是「键在不在」。
 *
 * 「非零才覆盖」这条纪律借自 RelayKit（AGPL-3.0，只借设计与规则、不搬代码）。
 * 来源、基线提交与改写范围见 `THIRD_PARTY_NOTICES.md`。
 *
 * @module dsh-account-bridge/wire/usage
 */

/** 一个值算不算「这次真的报了一个数」。 */
function reports(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 把新读到的一帧 usage 并进已累积的 usage。
 *
 * @param {Record<string, number>|undefined} previous 已累积的（可能还没有）
 * @param {Record<string, number>|undefined} next 这一帧读到的
 * @returns {Record<string, number>|undefined} 合并结果；两边都没有时返回 `previous`
 */
export function mergeUsageNonZero(previous, next) {
  if (!next || typeof next !== 'object') return previous
  let merged = previous
  for (const [key, value] of Object.entries(next)) {
    if (!reports(value)) continue
    if (value === 0 && reports(merged?.[key])) continue
    if (merged === previous) merged = { ...(previous ?? {}) }
    merged[key] = value
  }
  return merged
}

/**
 * 合并一串 usage 帧（`reduce` 的可读版本）。
 *
 * @param {Array<Record<string, number>|undefined>} frames
 * @returns {Record<string, number>|undefined}
 */
export function mergeUsageFrames(frames) {
  let merged
  for (const frame of frames ?? []) merged = mergeUsageNonZero(merged, frame)
  return merged
}
