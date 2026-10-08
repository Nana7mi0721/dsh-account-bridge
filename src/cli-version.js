/**
 * 「我们冒充的上游 CLI 是哪个版本」。
 *
 * 上游用这个版本号决定下发哪份模型目录、以及要不要限流：版本太旧会少模型，
 * 而 Claude 的额度端点对认不出的客户端会「激进限流」。所以口径是
 * **取新版**，只受配置显式覆盖。
 *
 * 两个约束决定了这里必须是同步返回 + 后台刷新：
 * - 请求头是同步拼的（`requestHeaders` 不是 async），拿不到版本也得先把请求发出去；
 * - 网络查询绝不能挡在对话路径上。
 * 所以 `resolveCliVersion()` 立刻返回「已知最新值 / 兜底常量」，
 * 顺手在后台起一次 npm registry 查询，查到了给后续请求用。
 * @module dsh-account-bridge/cli-version
 */

/** 兜底版本：查不到、也没配时的最后一道。 */
const FALLBACK = { claude: '2.1.283', codex: '0.51.0' }

/** 只读公开元数据，绝不把凭据发到这个端点。 */
const NPM_LATEST = {
  claude: 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest',
  codex: 'https://registry.npmjs.org/@openai%2fcodex/latest',
}

const TTL_MS = 6 * 60 * 60_000
const TIMEOUT_MS = 5_000

/** family → {version, fetchedAt, pending} */
const cache = new Map()

/** 版本号形态校验：绝不把上游回的任何字符串原样拼进请求头。 */
function isVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
}

/**
 * 当前该冒充的版本。同步返回，永不抛。
 * @param {object} ctx 族上下文（`ctx.config` / `ctx.fetch` / `ctx.log`）
 * @param {'claude'|'codex'} family
 */
export function resolveCliVersion(ctx, family) {
  const configured = ctx?.config?.[`${family}ClientVersion`]
  if (isVersion(configured)) return configured

  const entry = cache.get(family)
  if (entry && Date.now() - entry.fetchedAt < TTL_MS && isVersion(entry.version)) return entry.version
  if (entry && isVersion(entry.version) && !entry.pending) {
    // 有过期值也先用着，同时后台更新。
    refresh(ctx, family)
    return entry.version
  }
  refresh(ctx, family)
  return isVersion(entry?.version) ? entry.version : FALLBACK[family]
}

/** 后台查一次 npm；失败就维持现状。 */
function refresh(ctx, family) {
  const entry = cache.get(family) ?? { version: FALLBACK[family], fetchedAt: 0, pending: false }
  cache.set(family, entry)
  if (entry.pending) return
  const url = NPM_LATEST[family]
  if (!url || typeof ctx?.fetch !== 'function') return
  entry.pending = true
  ctx
    .fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((json) => {
      if (isVersion(json?.version)) {
        entry.version = json.version
        entry.fetchedAt = Date.now()
      }
    })
    .catch(() => {
      /* 离线、被墙、registry 抽风都无所谓，兜底常量照样能用 */
    })
    .finally(() => {
      entry.pending = false
      // 失败时把 fetchedAt 推一下，避免每次都重试。
      if (entry.fetchedAt === 0) entry.fetchedAt = Date.now() - TTL_MS + 10 * 60_000
    })
}

export { FALLBACK as CLI_VERSION_FALLBACK }
