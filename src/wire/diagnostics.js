/**
 * 翻译层的诊断旁路：**只上报，不改变行为**。
 *
 * 为什么要有它：翻译层会遇到「上游说了我们看不懂的话」，也会遇到「我们这门语言里
 * 没有对应的说法」——新的 `stop_reason`、没见过的字段、无法表达的续传态、参数解析
 * 不出来的工具调用。这些时刻的正确做法**不是抛错**（那会把一次本来可用的回答变成
 * 一次失败），也不是假装没看见（那就永远发现不了上游变了、也永远解释不了「为什么
 * 模型像是没看见我的图片」），而是**照常把回答交出去，同时把这件事记下来**。
 *
 * 形状（W8 定稿，语义借自 RelayKit 的 `relayconvert/convdiag`，见
 * `THIRD_PARTY_NOTICES.md`「只学规格」）：
 *
 * ```
 * { code, severity, phase, message, path?, from?, to? }
 * ```
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `code` | 稳定的机器可读标识（`UNKNOWN_STOP_REASON`、`TOOL_ARGUMENTS_UNPARSABLE`…）。它是一个**承诺**：同一件事永远同一个 code |
 * | `severity` | `'warning'`＝展示层的差异（少了一段思考、丢了一个不认识的字段）；`'error'`＝**内容与工具行为发生了变化**（模型没看到你的图片、工具被空着参数调用了、续传态丢了） |
 * | `phase` | `'request'` / `'response'` / `'stream'`——同一条损失发生在这三段里，处置完全不同 |
 * | `path` | 发生在消息树的哪个位置（`messages[3].content[1]`），没有位置就不写 |
 * | `from` / `to` | 原样与改写后的说法，便于「上游把这个值换成了什么」一眼可见 |
 *
 * 四条铁律：
 * 1. **绝不抛**：观察者出错不能连累被观察的请求；
 * 2. **绝不改 chunk 序列**：诊断是旁路，不影响发出去的任何东西；
 * 3. **不传就没有观察者**：单元测试直接调翻译层时不产生任何输出；
 * 4. **只报告，不裁决**：要不要因此换号、要不要因此重试，由调用方看 `severity` 决定。
 *    本模块不 import 池子，池子也不替翻译层判断。
 *
 * @module dsh-account-bridge/wire/diagnostics
 */

/** 两档严重性。别再加档：多一档就要多一条没人能解释的规则。 */
export const SEVERITIES = Object.freeze(['warning', 'error'])

/** 损失发生在哪一段。 */
export const PHASES = Object.freeze(['request', 'response', 'stream'])

/** 一次请求最多记多少条诊断。超了丢**最旧的**，并且记下丢了多少条。 */
export const DEFAULT_DIAGNOSTIC_LIMIT = 64

/**
 * 把一堆字段整成一条诊断。
 *
 * **不认识的东西原样保留**：`code` 为空时用 `'UNKNOWN'` 顶上，而不是把这条扔掉——
 * 「上游说了句我们不认识的话」本身就是要记的事，扔掉等于回到静默。
 *
 * @param {{code?: string, severity?: string, phase?: string, message?: string, path?: string, from?: unknown, to?: unknown}} fields
 * @returns {Readonly<object>}
 */
export function makeDiagnostic(fields) {
  const source = fields ?? {}
  const code = typeof source.code === 'string' && source.code.length > 0 ? source.code : 'UNKNOWN'
  const severity = SEVERITIES.includes(source.severity) ? source.severity : 'warning'
  const phase = PHASES.includes(source.phase) ? source.phase : 'stream'
  const message =
    typeof source.message === 'string' && source.message.length > 0 ? source.message : code
  const entry = { code, severity, phase, message }
  // 可选字段只在真的有值时才出现：一条到处是 `undefined` 的记录在日志里读不出重点。
  if (typeof source.path === 'string' && source.path.length > 0) entry.path = source.path
  if (source.from !== undefined) entry.from = source.from
  if (source.to !== undefined) entry.to = source.to
  return Object.freeze(entry)
}

/**
 * 一次请求攒下来的诊断。
 *
 * 有界、去重（同一 `code` + `path` 只留第一次，并把次数记在 `count` 上）——
 * 一段坏掉的流可以刷出上万个同样的诊断，那不是信息，那是噪声。
 */
export class Diagnostics {
  #limit
  #list = []
  #index = new Map()
  #dropped = 0

  constructor({ limit = DEFAULT_DIAGNOSTIC_LIMIT } = {}) {
    this.#limit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_DIAGNOSTIC_LIMIT
  }

  /**
   * 记一条。**这个函数永远不抛**——它是被观察者的旁路，不能反过来把它拖垮。
   *
   * @param {object|string} entry 一条诊断，或一句现成的文案
   * @returns {object|undefined} 收下的那条（被去重或溢出时返回 `undefined`）
   */
  report(entry) {
    try {
      const made = makeDiagnostic(typeof entry === 'string' ? { message: entry } : entry)
      const key = `${made.code}\u0000${made.path ?? ''}`
      const seen = this.#index.get(key)
      if (seen) {
        seen.count += 1
        return undefined
      }
      if (this.#list.length >= this.#limit) {
        // 满了就丢最旧的，并且**记下来**——静默丢诊断，正是这个模块存在的理由。
        this.#dropped += 1
        const oldest = this.#list.shift()
        this.#index.delete(`${oldest.code}\u0000${oldest.path ?? ''}`)
      }
      const kept = { ...made, count: 1 }
      this.#list.push(kept)
      this.#index.set(key, kept)
      return kept
    } catch {
      return undefined
    }
  }

  /** 收下的诊断，按发生顺序。 */
  get entries() {
    return this.#list.map((entry) => ({ ...entry }))
  }

  /** 有没有 `error` 级——「内容真的变了」，调用方可能想据此提醒用户。 */
  get hasErrors() {
    return this.#list.some((entry) => entry.severity === 'error')
  }

  get size() {
    return this.#list.length
  }

  /** 因为超过上限被丢掉的条数（去重的不算）。 */
  get dropped() {
    return this.#dropped
  }

  /** 按 code 汇总：`{ CODE: {severity, count} }`。给 `/pool` 与面板用。 */
  summary() {
    const out = {}
    for (const entry of this.#list) {
      const seen = out[entry.code]
      if (seen) {
        seen.count += entry.count
        // 同一个 code 出现两种严重性时取更重的那个（保守）。
        if (entry.severity === 'error') seen.severity = 'error'
      } else {
        out[entry.code] = { severity: entry.severity, count: entry.count, phase: entry.phase }
      }
    }
    return out
  }

  /** 一行话，给日志。空的时候返回 `undefined`。 */
  describe() {
    if (this.#list.length === 0) return undefined
    const parts = Object.entries(this.summary()).map(([code, info]) => `${code}×${info.count}`)
    const dropped = this.#dropped > 0 ? `, +${this.#dropped} dropped` : ''
    return `${this.hasErrors ? 'lost content' : 'translation notes'}: ${parts.join(' ')}${dropped}`
  }
}

/**
 * 造一个上报函数。
 *
 * 给了 `override` 就用它（测试与池子这么接）；否则退回宿主日志的一行 `warn`。
 * 两条路都包了 try——**观察者自己出错，与被观察的请求无关**。
 *
 * @param {{log?: {warn?: Function}}} [ctx] 宿主给的上下文（只用 `log.warn`）
 * @param {(entry: object) => void} [override] 调用方指定的上报函数（优先）
 * @returns {(entry: object) => void} 永远不抛的上报函数
 */
export function diagnosticReporter(ctx, override) {
  if (typeof override === 'function') {
    return (entry) => {
      try {
        override(typeof entry === 'string' ? makeDiagnostic({ message: entry }) : makeDiagnostic(entry))
      } catch {
        // 观察者自己的问题，与被观察的请求无关。
      }
    }
  }
  return (entry) => {
    try {
      const made = typeof entry === 'string' ? makeDiagnostic({ message: entry }) : makeDiagnostic(entry)
      ctx?.log?.warn?.(made.message)
    } catch {
      // 同上。
    }
  }
}
