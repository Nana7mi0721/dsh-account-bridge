/**
 * 翻译层的诊断旁路：**只上报，不改变行为**。
 *
 * 为什么要有它：翻译层会遇到「上游说了我们看不懂的话」——新的 `stop_reason`、
 * 没见过的字段、无法表达的续传态。这些时刻的正确做法**不是抛错**（那会把一次本来
 * 可用的回答变成一次失败），也不是假装没看见（那就永远发现不了上游变了），
 * 而是**照常把回答交出去，同时把这件事记下来**。
 *
 * W2b 只用到「未知 stop_reason」这一处；W8 会把这里扩成一个有结构、能落到日志与
 * 面板上的 Sink。所以现在这一版刻意做到最小：一个可注入的 `report(entry)`，
 * 默认实现往宿主日志写一行 warning，没有 `ctx.log` 就**什么都不做**。
 *
 * 三个约束（W8 也要守）：
 * 1. **绝不抛**：观察者出错不能连累被观察的请求；
 * 2. **绝不改 chunk 序列**：诊断是旁路，不影响发出去的任何东西；
 * 3. **不传就没有观察者**：单元测试直接调翻译层时不产生任何输出。
 *
 * @module dsh-account-bridge/wire/diagnostics
 */

/**
 * 造一个上报函数。
 *
 * @param {{log?: {warn?: Function}}} [ctx] 宿主给的上下文（只用 `log.warn`）
 * @param {(entry: object) => void} [override] 调用方指定的上报函数（优先）
 * @returns {(entry: object) => void} 永远不抛的上报函数
 */
export function diagnosticReporter(ctx, override) {
  if (typeof override === 'function') return override
  return (entry) => {
    try {
      const message = typeof entry === 'string' ? entry : entry?.message
      if (typeof message === 'string' && message.length > 0) ctx?.log?.warn?.(message)
    } catch {
      // 观察者自己的问题，与被观察的请求无关。
    }
  }
}
