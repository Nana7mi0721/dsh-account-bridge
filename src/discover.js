/**
 * P2.5 —— 本机账号统一发现。
 *
 * 为什么要这一层：社区里所有账号级反代插件都只认**自己**的登录流程，
 * 没有一个会去问「这台机器上已经有哪些客户端登录过了」。结果是用户装了四个插件、
 * 登了四次同一个 Google 账号。这里把「发现」从各族内部提出来做成一次统一扫描。
 *
 * 两条原则：
 *
 * 1. **发现不等于导入。** 扫描只读，不写任何东西；导入是另一个显式动作。
 * 2. **做不到的要如实说。** 本机装了 WorkBuddy 但我们还没实现 `workbuddy` 族时，
 *    正确的行为是报「探测到了凭据，但该族尚未实现」，而不是假装没看见、也不是
 *    静默给出一个导入后会失败的条目。
 *
 * @module dsh-account-bridge/discover
 */

import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

/** 单族发现的超时。agy 族要起子进程跑 `agy models`，所以给得比 HTTP 探测宽。 */
const DEFAULT_FAMILY_TIMEOUT_MS = 15_000

/**
 * 已知但**尚未实现**的族的凭据位点（计划书 §3.13）。
 *
 * 这张表的作用不是导入，而是**诚实**：扫到了就告诉用户「这里有东西，但这一族还没写」。
 * 加族时应该把对应条目从这里删掉——族自己的 `discover()` 会接管。
 *
 * **当前是空的**：workbuddy / qoder / commandcode 三个占位都在各自族落地后删掉了
 * （它们现在由族自己的 `discover()` 报，报得比这里细）。留着这个机制是给下一批族用的——
 * 第三档还有 codebuddy / cline / opencode / kiro / devin / factory / zhipu / qwen / mimo /
 * sensenova / longcat 没写，那时候这张表会重新有内容。
 */
const UNSHIPPED_SITES = []

/**
 * 从一条记录里取出「稳定身份」参与哈希的字段。
 *
 * 顺序踩过两次坑，现在的规则是：**稳定标识 → 文件位置 → 轮换的令牌**。
 *
 * ① **不能用会轮换的令牌当身份**。`access` 每次刷新都换；`refresh` 在多数族里是长期的，
 * 但 MiniMax Code 的 refresh token **每刷一次就轮换一次**。真机上第一次跑就撞上了：
 * 插件刷新完把记录里的 refresh 换成新的，桌面端文件里还是旧的，两边指纹不一致 ⇒
 * 下一次扫描把同一份登录态当成新账号，又导进来一个 `minimax-2`。
 * 所以轮换的那几个（`refresh`/`refreshToken`/`access`）只能垫底。
 *
 * ② **有稳定标识时优先用它，而不是优先用路径**。一个族可能从多个候选位置摸到**同一份**
 * 登录态（计划书 §3.13 的 Windows Local/Roaming 就是这种），只按路径认会把一份登录算成
 * 两个账号；而稳定标识（accountId / loginEpoch / email）能把它们收拢成一个。
 *
 * ③ 没有稳定标识时才退到 `sourcePath`——它比会过期的令牌更能说明「这是哪一份登录态」。
 * 各族因此有义务把自己的稳定标识摆进 `auth`：`codex` 有 `accountId`，`minimax` 有
 * `loginEpoch`，`claude` 有 `email`，`agy` 有 `owner`。
 *
 * `access` 仍然留在链尾：两个都没有的账号若都退到 label，会被误判成同一个，
 * 表现为「第二个账号导不进来」，那比重复导入更难查。
 */
const STABLE_IDENTITY_KEYS = ['accountId', 'account_id', 'apiKey', 'loginEpoch', 'email', 'owner']
const ROTATING_IDENTITY_KEYS = ['refresh', 'refreshToken', 'access']

function firstString(auth, keys) {
  for (const key of keys) {
    const value = auth?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function identityMaterial(item) {
  const auth = item?.auth ?? {}
  const stable = firstString(auth, STABLE_IDENTITY_KEYS)
  if (stable) return stable
  const sourcePath = typeof item?.sourcePath === 'string' && item.sourcePath.length > 0 ? item.sourcePath : undefined
  if (sourcePath) return sourcePath
  return firstString(auth, ROTATING_IDENTITY_KEYS) ?? (typeof item?.label === 'string' ? item.label : '')
}

/**
 * 稳定身份指纹。
 *
 * 用哈希而不是原文：这段字符串会被放进工具输出给模型看，令牌原文不该出现在对话里。
 * 哈希不可逆，且截断到 16 位足够区分本机量的账号。
 */
export function identityOf(family, item) {
  return createHash('sha256').update(`${family}\u0000${identityMaterial(item)}`).digest('hex').slice(0, 16)
}

/** 文件存在吗（不抛错）。 */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 给一个 promise 加超时，超时抛带 `timedOut` 标记的错误。 */
async function withTimeout(promise, ms, what) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        // 刻意不 unref：这个定时器是唯一还能把这次等待结束掉的东西，
        // 放它自生自灭会让「族挂住了」变成「进程提前退出、扫描无声消失」。
        timer = setTimeout(() => {
          const error = new Error(`${what} 超时（${ms}ms）`)
          error.timedOut = true
          reject(error)
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 扫描本机已知位点，聚合出「这台机器上有什么可以导入」。
 *
 * @param {object} options
 * @param {Array} options.families  已注册的族
 * @param {object} options.store    AccountStore
 * @param {object} [options.ctx]    插件上下文（族可能要用，agy 族要用它读配置）
 * @param {object} [options.log]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{scannedAt: string, importable: Array, blocked: Array, unsupported: Array, errors: Array}>}
 */
export async function discoverLocalAccounts({ families = [], store, ctx, log, timeoutMs = DEFAULT_FAMILY_TIMEOUT_MS } = {}) {
  const importable = []
  const blocked = []
  const errors = []

  // 已导入账号的指纹表：family → Set(identity)。用 store 里现存的记录现算，
  // 不新增字段，所以对 P2.5 之前写下的账号同样有效。
  const known = new Map()
  if (store) {
    for (const family of families) {
      const set = new Set()
      try {
        for (const account of await store.list(family.id)) set.add(identityOf(family.id, account))
      } catch (error) {
        log?.warn?.('account-bridge: 读取 %s 已有账号失败: %s', family.id, String(error?.message ?? error))
      }
      known.set(family.id, set)
    }
  }

  // 各族并行扫。用 allSettled：**一个族炸了不能把整次扫描带走**——
  // 发现的全部价值就在于「在用户还没指定族的时候把所有族都问一遍」。
  const results = await Promise.allSettled(
    families.map(async (family) => {
      if (typeof family.discover !== 'function') return { family, items: [] }
      const items = await withTimeout(
        Promise.resolve(family.discover(ctx)),
        timeoutMs,
        `${family.id} 族的本机发现`,
      )
      return { family, items: Array.isArray(items) ? items : [] }
    }),
  )

  results.forEach((result, index) => {
    const family = families[index]
    if (result.status === 'rejected') {
      const message = String(result.reason?.message ?? result.reason)
      errors.push({ family: family.id, message })
      log?.warn?.('account-bridge: %s 族发现失败: %s', family.id, message)
      return
    }
    for (const item of result.value.items) {
      const identity = identityOf(family.id, item)
      const already = known.get(family.id)?.has(identity) === true
      const entry = {
        family: family.id,
        displayName: family.displayName,
        label: item.label,
        sourcePath: item.sourcePath,
        identity,
        alreadyImported: already,
      }
      if (item.importable === true && typeof family.recordFromDiscovery === 'function') {
        importable.push({ ...entry, item })
      } else if (item.importable === true) {
        blocked.push({ ...entry, reason: `${family.id} 族没有实现 recordFromDiscovery，无法导入` })
      } else {
        blocked.push({ ...entry, reason: item.reason ?? '该族的发现逻辑判定它不可导入' })
      }
    }
  })

  // 未实现族的位点：只报告存在性。
  const unsupported = []
  for (const site of UNSHIPPED_SITES) {
    if (families.some((family) => family.id === site.family)) continue
    const found = []
    for (const path of site.candidates()) {
      if (path && (await exists(path))) found.push(path)
    }
    if (found.length > 0) {
      unsupported.push({
        family: site.family,
        displayName: site.displayName,
        sourcePath: found[0],
        allPaths: found,
        reason: `${site.family} 族尚未实现（计划书 P6）｜${site.note}`,
      })
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    importable,
    blocked,
    unsupported,
    errors,
  }
}

/**
 * 一键导入扫描结果里的账号。
 *
 * @param {object} options
 * @param {Array} options.families
 * @param {object} options.store
 * @param {object} options.scan   `discoverLocalAccounts()` 的返回值
 * @param {string} [options.family]  只导入这一族；省略则导入全部可导入项
 * @param {object} [options.adapter] 有的话，导入后让该族目录缓存失效
 * @returns {Promise<{imported: Array, skipped: Array}>}
 */
export async function importDiscovered({ families = [], store, scan, family, adapter } = {}) {
  const imported = []
  const skipped = []
  const candidates = scan.importable.filter((entry) => (family ? entry.family === family : true))

  if (candidates.length === 0) return { imported, skipped }

  // 同一份本机登录态在一次扫描里可能被两个候选路径各报一次（例如 CODEX_HOME 与 ~/.codex
  // 指向同一处）。按指纹去重，别插两条一样的账号。
  const seen = new Set()
  for (const entry of candidates) {
    if (entry.alreadyImported) {
      skipped.push({ ...entry, reason: '已经导入过' })
      continue
    }
    if (seen.has(`${entry.family}\u0000${entry.identity}`)) {
      skipped.push({ ...entry, reason: '同一次扫描里的重复条目' })
      continue
    }
    seen.add(`${entry.family}\u0000${entry.identity}`)

    const definition = families.find((item) => item.id === entry.family)
    if (!definition) {
      skipped.push({ ...entry, reason: `族 ${entry.family} 未注册` })
      continue
    }
    try {
      const id = await store.nextAccountId(entry.family)
      const record = definition.recordFromDiscovery(entry.item)
      await store.write(id, record)
      imported.push({ family: entry.family, id, label: record.label, sourcePath: entry.sourcePath, identity: entry.identity })
      adapter?.invalidate?.(entry.family)
    } catch (error) {
      skipped.push({ ...entry, reason: String(error?.message ?? error) })
    }
  }

  return { imported, skipped }
}
