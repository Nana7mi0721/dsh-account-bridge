/**
 * 账号池的 HTTP 面：网页设置页用的 JSON 路由。
 *
 * 为什么要这条面，而不是用官方的 `ctx.remote` / typert：
 * 官方 RPC 的能力集是**构建期**由 `@deepseek-ai/dsh-api-remotes` 的显式 value import
 * 固定下来的，Client 不在运行时发现宿主的 Remote 定义；新增一个 namespace 需要改宿主
 * assembly。第三方插件改不了宿主，所以只能自己往 `ctx.webServer` 上挂路由。
 * （同生态里的 `@linxin666/dsh-client-ui-git-graph` 走的也是这条。）
 *
 * 三条约定：
 * 1. **只服务回环**。这一面能读账号列表、能起登录流程、能删账号，暴露到局域网等于把
 *    账号池的控制权交出去。非回环一律 403，没有开关、没有例外。
 * 2. **客户端要用「文档相对路径」来 POST**：GUI 由 `<base href="./">` 提供，我们这边注册
 *    的 path 带前导斜杠（`/account-bridge`），客户端那边必须写 `account-bridge/state`
 *    （不带斜杠）。带斜杠会逃出 base 前缀，永远到不了这里。
 * 3. **绝不在响应里回传凭据**。`auth.access` / `auth.refresh` / `auth.apiKey` 一律不出现在
 *    任何返回值里——这个面板是给浏览器看的，而浏览器里还有别的脚本。
 * @module dsh-account-bridge/api
 */

import { AFFINITY_MODES } from './affinity.js'
import { discoverLocalAccounts, importDiscovered } from './discover.js'

/** 路由前缀（宿主侧，带前导斜杠）。客户端用不带斜杠的 `account-bridge/...`。 */
export const PREFIX = '/account-bridge'

/** 请求体上限。这个面板只发小 JSON，1 MiB 是防呆不是配额。 */
const MAX_BODY_BYTES = 1 << 20

/** 一次 `check` 里单个账号的额度查询超时；上游挂掉时面板不能跟着挂。 */
const QUOTA_TIMEOUT_MS = 15_000

/** `state` 里回多少条「为什么粘/不粘」。它只是现场快照，不是日志。 */
const AFFINITY_WHY_SHOWN = 50

/** 回环地址的三种写法（IPv4 / IPv6 / IPv4-mapped）。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 判断请求是不是来自本机。 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress
  return typeof address === 'string' && LOOPBACK.has(address)
}

const OK = (value) => ({ ok: true, value })
const FAIL = (code, message) => ({ ok: false, error: { code, message } })

/**
 * 把账号 payload 削成「可以给浏览器看」的形状。
 *
 * 这是唯一的安全边界：`auth` 里的每一个字段都是能直接用掉的凭据，
 * 所以这里**白名单**式地重建，而不是删几个已知的敏感键——将来 auth 里加了新字段，
 * 默认是不外传，而不是默认外传。
 */
export function publicAccount(account, extra = {}) {
  const auth = account?.auth ?? {}
  return {
    id: account?.id,
    family: account?.family,
    label: account?.label,
    source: account?.source,
    externallyOwned: account?.externallyOwned === true,
    disabled: account?.disabled === true,
    proxy: typeof account?.proxy === 'string' && account.proxy.length > 0 ? account.proxy : undefined,
    /** 账号级的流量上限（没配就是 undefined，面板回落到族级/全局值）。 */
    maxRpm: Number(account?.maxRpm) > 0 ? Number(account.maxRpm) : undefined,
    maxConcurrency: Number(account?.maxConcurrency) > 0 ? Number(account.maxConcurrency) : undefined,
    createdAt: account?.createdAt,
    updatedAt: account?.updatedAt,
    /** 凭据是否带 refresh token——面板据此显示「可续期 / 需重新登录」。 */
    renewable: typeof auth.refresh === 'string' && auth.refresh.length > 0,
    /** 只暴露过期时刻，不暴露 token 本身。 */
    expiresAt: Number.isFinite(auth.expiresAt) ? auth.expiresAt : undefined,
    /** 这个账号用的是什么形态的凭据（oauth / cli / apikey / endpoint），不给值。 */
    authKind: auth.baseUrl ? 'endpoint' : auth.refresh || auth.access ? 'oauth' : auth.apiKey || auth.apiKeyEnv ? 'apikey' : 'cli',
    /** 有 baseUrl 的账号可以展示主机名（用户自己填的，不是机密）。 */
    host: typeof auth.baseUrl === 'string' ? safeHost(auth.baseUrl) : undefined,
    ...extra,
  }
}

/** 从 baseUrl 里取主机名；取不到就返回 undefined，绝不抛。 */
function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).host
  } catch {
    return undefined
  }
}

/** 读一个 JSON 请求体，带大小上限。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('request body must be a JSON object')
      error.code = 'BAD_BODY'
      throw error
    }
    return parsed
  } catch (error) {
    if (error?.code === 'BAD_BODY') throw error
    const wrapped = new Error('request body is not valid JSON')
    wrapped.code = 'BAD_BODY'
    throw wrapped
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 取某族某账号的额度。读不到就返回 `undefined`——
 * 面板显示「未知」，**绝不显示 0%**（0% 和「查不到」是两件事）。
 */
export async function quotaOf(family, payload, ctx, { timeoutMs = QUOTA_TIMEOUT_MS } = {}) {
  if (typeof family?.quota !== 'function') return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('quota timeout')), timeoutMs)
  try {
    const windows = await family.quota(ctx, payload, controller.signal)
    if (!Array.isArray(windows)) return undefined
    return windows
      .filter((window) => window && typeof window.id === 'string')
      .map((window) => ({
        id: window.id,
        name: window.name,
        remainingFraction: Number.isFinite(window.remainingFraction) ? window.remainingFraction : undefined,
        resetAt: Number.isFinite(window.resetAt) ? window.resetAt : undefined,
      }))
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 挂载账号池路由。
 *
 * @param {object} options
 * @param {any} options.webServer `ctx.webServer` 服务（必须有 `register`）。
 * @param {any} options.adapter 账号池适配器（要 `status` / `invalidate` / `invalidateHealth` / `refreshAccount`）。
 * @param {any} options.broker 登录中介。**刻意不参与解构**：HTTP 面在 `webServer` 就绪时挂载，
 *   而登录中介要等 `authorization` 就绪，两个服务谁先到不确定。这里每次动作现取
 *   （getter 或直接被重新赋值的属性都行），而不是把挂载那一刻的值钉死。
 * @param {any} options.store 账号存储。
 * @param {any[]} options.families 已启用的族。
 * @param {any} options.ctx 族上下文（`{fetch, log, config}`）。
 * @param {any} [options.log]
 * @returns {() => void} disposer。
 */
export function registerAccountBridgeRoutes(options) {
  const { webServer, adapter, store, families, ctx, log } = options
  const familyById = new Map(families.map((family) => [family.id, family]))

  /** 定位一个账号：先族内找，找不到再全族找（客户端只需要传 account id）。 */
  async function locate(accountId) {
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw Object.assign(new Error('missing "account"'), { code: 'BAD_REQUEST' })
    }
    for (const family of families) {
      const accounts = await store.list(family.id)
      const found = accounts.find((account) => account.id === accountId)
      if (found) return { family, account: found }
    }
    throw Object.assign(new Error(`no such account "${accountId}"`), { code: 'NOT_FOUND' })
  }

  /**
   * 就地改一条记录，**记录不在了就什么都不写**。
   *
   * `mutate` 以前是 `(current) => ({ ...current, … })`：从 `locate()` 到 `update()`
   * 之间记录要是被删掉了，`current` 就是 `undefined`，展开它得到的是一份
   * **只剩被改的那一个字段**的新记录——我们不但没改成，还凭空造了一条半截账号出来
   * （magpie `LESSONS.md` 第 9 条的同一个形状：读不出来被当成没有，写盘时把真数据抹掉）。
   * 现在记录不在就返回 `undefined`（`store.update` 的约定是「不改」），由这里报 NOT_FOUND。
   */
  async function amend(account, mutate) {
    const next = await store.update(account.id, (current) => (current ? mutate(current) : undefined))
    if (next === undefined) {
      throw Object.assign(new Error(`no such account "${account.id}"`), { code: 'NOT_FOUND' })
    }
    return next
  }

  /** 族 + 账号 + 健康 + 额度 的完整快照。 */
  async function snapshot({ withQuota = false } = {}) {
    const pools = await adapter.status()
    const out = []
    for (const pool of pools) {
      const family = familyById.get(pool.family)
      const attempts = options.broker?.snapshot?.(pool.family)
      const accounts = []
      for (const row of pool.accounts) {
        const payload = await store.read(row.id)
        let quota
        if (withQuota && payload && row.disabled !== true) {
          quota = await quotaOf(family, payload, ctx)
        }
        accounts.push(
          publicAccount(
            { ...payload, ...row },
            {
              quota,
              status: row.cooldown ? 'cooling' : 'ready',
              /**
               * **实际生效**的两个上限，以及它们是从哪一级来的。
               *
               * 面板要能回答「这个账号一分钟最多发几次」，而这个答案不总是写在这个账号上：
               * 账号级 > 族级 > 全局默认。只回账号自己那个字段，用户会以为「填了才有限制」，
               * 于是明明被族级限着却查不出来。
               */
              limits: payload
                ? {
                    ...adapter.limitsFor(family, payload),
                    from:
                      Number(payload.maxRpm) > 0 || Number(payload.maxConcurrency) > 0
                        ? 'account'
                        : Number(family?.maxRpm) > 0 || Number(family?.maxConcurrency) > 0
                          ? 'family'
                          : 'global',
                  }
                : undefined,
            },
          ),
        )
      }
      out.push({
        family: pool.family,
        displayName: pool.displayName,
        route: pool.route,
        risk: family?.risk,
        /** 这一族支持哪些登录方式（UI 据此决定「+ 添加账号」按钮怎么弹）。 */
        loginMethods: (family?.login?.methods ?? []).map((method) => ({ id: method.id, label: method.label })),
        /** 能不能扫本机客户端登录态（没有 discover 的族不显示「从本机导入」）。 */
        discoverable: typeof family?.discover === 'function',
        /** 本机客户端发现了但还没导入的账号数（给按钮上的角标用）。 */
        accounts,
        login: attempts
          ? { status: attempts.status, url: attempts.url, message: attempts.message, error: attempts.error, accountId: attempts.accountId }
          : undefined,
      })
    }
    return out
  }

  /**
   * 会话亲和的状态（W7）。`why` 只给最近几十条——它是给人看的诊断，不是历史记录。
   */
  function affinityState() {
    const book = adapter.affinityBook?.()
    const why = (adapter.lastWhy?.() ?? []).slice(-AFFINITY_WHY_SHOWN)
    return {
      mode: adapter.affinityMode,
      modes: AFFINITY_MODES,
      /** 落盘是否可用。`false` = 记录只在内存里，重启即失忆（其余功能不受影响）。 */
      persisted: book?.persisted === true,
      remembered: book?.size ?? 0,
      why: why.reverse().map((row) => ({ model: row.model, why: row.why, accountId: row.accountId, at: row.at })),
    }
  }

  /** 动作表。每个动作拿 `(body)` 返回一个普通值；抛错 → 信封里带 code。 */
  const actions = {
    /** 只读快照，不查额度（额度要打上游，面板打开时不该等它）。 */
    async state() {
      return { families: await snapshot(), affinity: affinityState() }
    },

    /**
     * 最近一次请求里翻译层丢掉了什么（W8）。
     *
     * 与 `/pool lost` 读的是**同一本账**。为什么要有一条 HTTP 面：那本账只活在内存里，
     * 而日志在桌面版里不落到我们能读的地方（`ctx.logger` 的去向由宿主决定）。
     * 没有这条面，「诊断真的产生了」这件事就只能靠单测里的假宿主来证——而这一整块的
     * 教训恰恰是「单测绿不等于生产路径上有人在听」。
     */
    async diagnostics() {
      return adapter.diagnostics?.() ?? { requests: 0, lostRequests: 0, entries: [], summary: {}, hasErrors: false, dropped: 0 }
    },

    /**
     * 闸门此刻的现场（W10）：每个账号这一分钟里占了几格、上限多少、车道有几个在飞。
     *
     * 与 `/pool limits` 看到的**不是同一件事**：那一条读的是「配置了什么」，这一条读的是
     * 「闸门真的在按什么算」。两者不一致时（配置写了 1、这里却是 0）说明限额没走到池子
     * 那一层——那正是最需要一眼看出来的时刻。
     */
    async gate() {
      return { rows: adapter.gate?.snapshot?.() ?? [] }
    },

    /**
     * 会话亲和的四态开关（W7），以及「这段会话为什么粘/不粘」的现场。
     *
     * **改的只是这一次运行**：持久值在 `cordis.patch.yml` 的 `config.affinity` 里，
     * 面板重启就回到配置那个值。这样「临时把粘性关掉看会不会好」不需要改配置重启。
     */
    async sticky(body) {
      if (body.mode !== undefined) {
        if (!AFFINITY_MODES.includes(body.mode)) {
          throw Object.assign(new Error(`mode must be one of ${AFFINITY_MODES.join(', ')}`), { code: 'BAD_REQUEST' })
        }
        adapter.affinityMode = body.mode
        log?.info?.('account-bridge: 会话亲和模式 → %s', body.mode)
      }
      if (body.clear === true) {
        if (body.family !== undefined && !familyById.has(body.family)) {
          throw Object.assign(new Error(`unknown family "${String(body.family)}"`), { code: 'BAD_REQUEST' })
        }
        adapter.clearSticky?.(body.family)
      }
      return affinityState()
    },

    /** 快照 + 逐账号查额度。慢，由「检查」按钮显式触发。 */
    async check(body) {
      if (typeof body.family === 'string' && !familyById.has(body.family)) {
        throw Object.assign(new Error(`unknown family "${body.family}"`), { code: 'BAD_REQUEST' })
      }
      const familiesOut = await snapshot({ withQuota: true })
      return { families: body.family ? familiesOut.filter((row) => row.family === body.family) : familiesOut }
    },

    /** 起一次登录。返回时 flow 还在跑，`state` 里能看到 URL / 状态。 */
    async login(body) {
      const family = familyById.get(body.family)
      if (!family) throw Object.assign(new Error(`unknown family "${String(body.family)}"`), { code: 'BAD_REQUEST' })
      if ((family.login?.methods ?? []).length === 0) {
        throw Object.assign(new Error(`family "${family.id}" has no login flow`), { code: 'NO_LOGIN' })
      }
      if (typeof options.broker?.start !== 'function') {
        throw Object.assign(
          new Error('登录服务尚未就绪（authorization 服务不在这个 composition 里）'),
          { code: 'NO_AUTHORIZATION' },
        )
      }
      const attempt = await options.broker.start(family, { method: body.method })
      adapter.invalidate(family.id)
      return { family: family.id, login: attempt }
    },

    /** 删一个账号。 */
    async remove(body) {
      const { family, account } = await locate(body.account)
      await store.remove(account.id)
      adapter.invalidate(family.id)
      adapter.invalidateHealth()
      // 只忘掉指向**这个**账号的记录：账号 id 会回收，留着重登会继承别人的粘性。
      adapter.forgetAccount?.(account.id)
      log?.info?.('account-bridge: removed %s', account.id)
      return { removed: account.id }
    },

    /** 停用 / 启用一个账号。停用只是不打它，记录与凭据都留着。 */
    async toggle(body) {
      const { family, account } = await locate(body.account)
      const disabled = body.disabled === undefined ? account.disabled !== true : body.disabled === true
      await amend(account, (current) => ({ ...current, disabled }))
      adapter.invalidate(family.id)
      adapter.invalidateHealth()
      // 这里**刻意不清粘性**：候选人变了不需要清——记录指向的账号要是停用了，`decide()`
      // 自己会给 `gone`；而清一下会把这一族所有会话的缓存亲和一起抹掉（曾经就是这样，
      // 结果每启用一个账号就把全部会话的上游缓存白烧一遍）。
      return { account: account.id, disabled }
    },

    /** 给一个账号单独配出口代理。空字符串 = 取消代理。 */
    async proxy(body) {
      const { family, account } = await locate(body.account)
      const raw = body.proxy === undefined || body.proxy === null ? '' : String(body.proxy).trim()
      await amend(account, (current) => {
        const next = { ...current }
        if (raw.length === 0) delete next.proxy
        else next.proxy = raw
        return next
      })
      // 代理是按 payload 走的，所以池缓存与健康表都要作废。
      adapter.invalidate(family.id)
      adapter.invalidateHealth()
      return { account: account.id, proxy: raw.length > 0 ? raw : undefined }
    },

    /**
     * 给一个账号单独配流量上限（W10）。`0` / 省略 / null 都表示「回到上一级」。
     *
     * 与 `proxy` 一样是按 payload 生效的，所以池缓存与健康表都要作废——限额一变，
     * 「谁有余量」的答案就变了，而那个答案被缓存在 `#pools` 里。
     */
    async limits(body) {
      const { family, account } = await locate(body.account)
      const read = (value) => (Number(value) > 0 ? Math.floor(Number(value)) : undefined)
      // **只动 body 里真的给了的那个键。** 「没给」与「给了 0」是两件事：
      // 前者是「这个字段别管」，后者是「取消这一项，回到上一级」。要是把「没给」
      // 也当成后者，改一个上限就会把另一个悄悄清掉。
      const keys = ['maxRpm', 'maxConcurrency'].filter((key) => Object.hasOwn(body, key))
      await amend(account, (current) => {
        const next = { ...current }
        for (const key of keys) {
          const value = read(body[key])
          if (value === undefined) delete next[key]
          else next[key] = value
        }
        return next
      })
      adapter.invalidate(family.id)
      adapter.invalidateHealth()
      const payload = await store.read(account.id)
      return { account: account.id, limits: adapter.limitsFor(family, payload ?? account) }
    },

    /** 扫本机客户端登录态，只报告，不改动任何东西。 */
    async discover(body) {
      const scoped = typeof body.family === 'string' ? families.filter((family) => family.id === body.family) : families
      const scan = await discoverLocalAccounts({ families: scoped, store, ctx, log })
      return {
        importable: scan.importable.map((entry) => ({
          family: entry.family,
          label: entry.label,
          sourcePath: entry.sourcePath,
          alreadyImported: entry.alreadyImported === true,
          reason: entry.reason,
        })),
        blocked: (scan.blocked ?? []).map((entry) => ({
          family: entry.family,
          label: entry.label,
          sourcePath: entry.sourcePath,
          reason: entry.reason,
        })),
        unsupported: scan.unsupported ?? [],
      }
    },

    /** 把扫描到的登录态收进来。 */
    async import(body) {
      const scoped = typeof body.family === 'string' ? families.filter((family) => family.id === body.family) : families
      const scan = await discoverLocalAccounts({ families: scoped, store, ctx, log })
      const result = await importDiscovered({ families: scoped, store, scan, family: body.family, adapter })
      for (const entry of result.imported) {
        const family = familyById.get(entry.family)
        if (family) adapter.invalidate(family.id)
      }
      adapter.invalidateHealth()
      return {
        imported: result.imported.map((entry) => ({ id: entry.id, family: entry.family, label: entry.label, sourcePath: entry.sourcePath })),
        skipped: result.skipped.map((entry) => ({ family: entry.family, label: entry.label, reason: entry.reason })),
      }
    },

    /** 手动续期一个账号（refresh token 换 access token），用于「token 失效」那一行。 */
    async refresh(body) {
      const { family, account } = await locate(body.account)
      const auth = await adapter.refreshAccount(family.id, account.id)
      adapter.invalidate(family.id)
      return { account: account.id, expiresAt: Number.isFinite(auth?.expiresAt) ? auth.expiresAt : undefined }
    },

    /** 解冻：清掉一个账号（或全族）的冷却，不改凭据。 */
    async unfreeze(body) {
      if (body.account === undefined) {
        adapter.invalidateHealth()
        return { unfrozen: '*' }
      }
      const { family, account } = await locate(body.account)
      adapter.invalidateHealth()
      return { unfrozen: account.id, family: family.id }
    },
  }

  /** 唯一的 handler：按 pathname 后缀分发，路径里的动作名就是上面 actions 的键。 */
  async function handler(req, res) {
    if (!isLoopback(req)) {
      writeJson(res, 403, FAIL('FORBIDDEN', 'account-bridge API is loopback-only'))
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, FAIL('METHOD_NOT_ALLOWED', 'use POST'))
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const action = url.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '')
    const run = actions[action]
    if (!run) {
      writeJson(res, 404, FAIL('NO_SUCH_ACTION', `no such action "${action}"`))
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, FAIL(error?.code ?? 'BAD_BODY', String(error?.message ?? error)))
      return
    }

    try {
      writeJson(res, 200, OK(await run(body)))
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
      const status = code === 'BAD_REQUEST' || code === 'BAD_BODY' ? 400 : code === 'NOT_FOUND' ? 404 : 500
      log?.warn?.('account-bridge: %s failed: %s', action, String(error?.message ?? error))
      writeJson(res, status, FAIL(code, String(error?.message ?? error)))
    }
  }

  const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler })
  log?.info?.('account-bridge: HTTP API mounted at %s (loopback only)', PREFIX)
  return dispose
}
