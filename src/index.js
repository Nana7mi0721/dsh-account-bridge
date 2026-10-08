/**
 * dsh-account-bridge —— 把多个上游订阅账号（账号级反代）统一进 DSH 的插件。
 *
 * 一个插件、一条 route 一族、一族多账号：
 *   模型选择器 = 各账号目录的并集；同一模型多账号可用时自动 failover；
 *   会话粘性保住上游 prompt cache；失败按 (族, 账号, 模型) 记冷却。
 *
 * 三条架构约定（改代码前先读）：
 * 1. **静态 `inject` 保持空数组**。静态 inject 一个当前 composition 里不存在的服务，
 *    会让 entry 永久 pending，而 loader 把 pending 当成「profile 加载失败」。
 *    所有依赖一律走惰性 `ctx.inject([...], cb)`。
 * 2. **凭据只放 `ctx.credentials` 的记录里**，不进 settings 文档、不进 cordis.patch.yml、
 *    不进 session log（session log 模型看得到）。
 * 3. **登录一律走 `ctx.authorization`**：flow 是宿主注册的，
 *    我们的 `run(session)` 只负责协议本身。
 * @module dsh-account-bridge
 */

import { createFetcher } from './http.js'
import { CooldownTable } from './health.js'
import { LoginBroker } from './login/broker.js'
import { AccountBridgeAdapter } from './pool.js'
import { AccountStore } from './store.js'
import { assertUniqueRoutes, selectFamilies } from './families/registry.js'
import { createToolDefinitions } from './tools.js'

/** 插件 id。`cordis.patch.yml` 里 `insert[].name` 用的是**包名**（模块说明符），不是这个。 */
export const name = 'dsh-account-bridge'

/** 见文件头第 1 条：绝不在这里列服务。 */
export const inject = []

const DEFAULTS = {
  /** 启用哪些族；省略/空数组 = 全部已实现的族。 */
  families: undefined,
  /** 冒充的 Codex CLI 版本：上游用它决定下发哪份模型目录，太旧会少模型。 */
  codexClientVersion: '0.51.0',
}

/** 取一个可能尚未就绪的服务。 */
function serviceOf(ctx, serviceName) {
  try {
    const viaGet = ctx.get?.(serviceName)
    if (viaGet) return viaGet
  } catch {
    /* 服务没注册时会抛，落到下面再试一次属性访问 */
  }
  try {
    return ctx[serviceName]
  } catch {
    return undefined
  }
}

/** cordis 的 disposer 既可能是函数，也可能是带 dispose 的对象。 */
function disposeOf(handle) {
  if (typeof handle === 'function') return handle
  if (handle && typeof handle.dispose === 'function') return () => handle.dispose()
  return () => {}
}

/**
 * 插件入口。
 * @param {any} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  const log = ctx.logger ?? console

  const families = assertUniqueRoutes(selectFamilies(settings.families))
  const fetcher = createFetcher({ log })
  const familyContext = { fetch: fetcher, log, config: settings }

  const store = new AccountStore(() => serviceOf(ctx, 'credentials'), log)
  const health = new CooldownTable()
  const adapter = new AccountBridgeAdapter({
    ctx: familyContext,
    store,
    health,
    families,
    log,
  })

  ctx.effect(() => () => {
    fetcher.close?.().catch(() => {})
  })

  // 1) 模型与推理：把每族的 route 注册进 llm。
  if (families.length > 0) {
    const routes = families.map((family) => family.route)
    ctx.inject(['llm'], (llmCtx) => {
      try {
        const handle = llmCtx.llm.registerAdapter(routes, adapter)
        llmCtx.effect(() => disposeOf(handle))
        log.info?.('account-bridge: registered route(s) %s', routes.join(', '))
      } catch (error) {
        log.error?.('account-bridge: registerAdapter(%s) failed: %s', routes.join(', '), error?.message ?? error)
      }
    })
  }

  // 2) 登录：每族一个 flow。key 就是登录槽位的凭据键，seam 会往那里写。
  ctx.inject(['authorization'], (authCtx) => {
    const broker = new LoginBroker({ authorization: authCtx.authorization, store, log })
    for (const family of families) {
      const methods = family.login?.methods ?? []
      if (methods.length === 0) continue
      const key = store.keyOf(store.loginSlot(family.id))
      const handle = authCtx.authorization.registerFlow({
        key,
        label: family.displayName,
        methods,
        run: (session) => family.login.run(session, familyContext),
      })
      authCtx.effect(() => disposeOf(handle))
    }
    log.info?.('account-bridge: registered %d authorization flow(s)', families.length)

    // 3) 工具面：在不依赖客户端 UI 的前提下，让人能拿到登录 URL、看到账号状态。
    //
    // 这里**刻意不 import `@deepseek-ai/dsh-tools`**：插件按裸模块名 import 核心包会
    // `ERR_MODULE_NOT_FOUND`（真机实测），核心包只在 asar 里、只能经 ctx 服务访问。
    // `tools.register(definition)` 只校验 `output.schema`/`output.render`，
    // 所以本地拼一个等价定义即可，见 src/tools.js 的说明。
    authCtx.inject(['tools'], (toolsCtx) => {
      for (const definition of createToolDefinitions({ adapter, broker, store, families, log })) {
        try {
          const handle = toolsCtx.tools.register(definition)
          toolsCtx.effect(() => disposeOf(handle))
          log.info?.('account-bridge: registered tool %s', definition.name)
        } catch (error) {
          log.warn?.('account-bridge: registering tool %s failed: %s', definition.name, error?.message ?? error)
        }
      }
    })
  })

  log.info?.('account-bridge: ready (families: %s)', families.map((family) => family.id).join(', ') || 'none')
}

export { AccountBridgeAdapter, AccountStore, CooldownTable, LoginBroker }
