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
import { registerAccountBridgeRoutes } from './api.js'
import { COMMAND_NAME, createPoolCommand } from './commands.js'
import { assertUniqueRoutes, selectFamilies } from './families/registry.js'
import { createToolDefinitions } from './tools.js'
import { discoverLocalAccounts } from './discover.js'

/** 插件 id。`cordis.patch.yml` 里 `insert[].name` 用的是**包名**（模块说明符），不是这个。 */
export const name = 'dsh-account-bridge'

/** 见文件头第 1 条：绝不在这里列服务。 */
export const inject = []

const DEFAULTS = {
  /** 启用哪些族；省略/空数组 = 全部已实现的族。 */
  families: undefined,
  /**
   * 冒充的上游 CLI 版本。留空 = 自动（查 npm 最新，查不到用兜底常量）。
   * 上游用它决定下发哪份模型目录、以及要不要限流，见 src/cli-version.js。
   */
  claudeClientVersion: undefined,
  codexClientVersion: undefined,
  /**
   * agy CLI 的位置。留空 = 走 PATH 上的 `agy`。
   * 这一族是**驱动本机 CLI** 的，路径不对整族直接不可用（报错会说你没装）。
   */
  agyBin: undefined,
  /** agy 的工作目录。agy 是个 agent，会往 cwd 里写东西；留空 = 继承进程 cwd。 */
  agyWorkdir: undefined,
  /**
   * 启动时在后台扫一遍本机客户端的登录态（P2.5），只打日志，不导入任何东西。
   *
   * 默认开。关掉它的理由很实际：`agy` 族的探测要起一个子进程跑 `agy models`，
   * 不想让插件在启动路径上派生子进程的人可以关。
   */
  discoverOnStartup: true,
  /**
   * 换号窗口的三个上限，见 `src/pool.js` 里 `HOLD_DEFAULTS` 那一组的注释。
   * 一般不用动；上游特别慢（首字节要等 20 秒以上）时把 `holdLongestMs` 调长即可。
   */
  holdLongestMs: undefined,
  holdThinkingMs: undefined,
  holdMostBytes: undefined,
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
    hold: {
      // 任何一个没配就整组回落默认值——只调一个不等于把另两个清零。
      ...(settings.holdLongestMs === undefined ? {} : { longestMs: settings.holdLongestMs }),
      ...(settings.holdThinkingMs === undefined ? {} : { thinkingMs: settings.holdThinkingMs }),
      ...(settings.holdMostBytes === undefined ? {} : { mostBytes: settings.holdMostBytes }),
    },
  })

  /**
   * 登录中介。要等 `authorization` 服务就绪才存在，而 HTTP 面的挂载只看 `webServer`，
   * 两个服务谁先到不确定——所以用一个闭包变量在两者之间搭桥，而不是让 api.js
   * 去猜哪个 ctx 里有什么。
   */
  let activeBroker

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
    activeBroker = broker
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
      for (const definition of createToolDefinitions({ adapter, broker, store, families, log, ctx: familyContext })) {
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

  // 3.4) `/pool` 命令族：在对话框里直接问账号池，不产生模型消息、不烧额度。
  ctx.inject(['commands'], (cmdCtx) => {
    try {
      const handle = cmdCtx.commands.register(createPoolCommand({
        adapter,
        store,
        families,
        ctx: familyContext,
        log,
      }))
      cmdCtx.effect(() => disposeOf(handle))
      log.info?.('account-bridge: registered /%s command', COMMAND_NAME)
    } catch (error) {
      log.warn?.('account-bridge: registering /%s failed: %s', COMMAND_NAME, error?.message ?? error)
    }
  })

  // 3.5) 网页设置页的数据面。客户端插件跑在浏览器里，拿不到宿主对象，
  //      只能经 HTTP 说话；官方的 `ctx.remote` 是构建期固定的，第三方加不了。
  //      所以这里自己挂一条回环专用的 JSON 路由，见 src/api.js 的说明。
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const dispose = registerAccountBridgeRoutes({
        webServer: webCtx.webServer,
        adapter,
        store,
        families,
        ctx: familyContext,
        log,
        // broker 在 authorization 服务就绪后才存在；路由层每次动作现取，
        // 避免「webServer 先于 authorization 注册」时拿到一个 undefined。
        get broker() {
          return activeBroker
        },
      })
      webCtx.effect(() => dispose)
    } catch (error) {
      log.warn?.('account-bridge: mounting the HTTP API failed: %s', String(error?.message ?? error))
    }
  })

  log.info?.('account-bridge: ready (families: %s)', families.map((family) => family.id).join(', ') || 'none')

  // 4) P2.5：启动时在**后台**扫一遍本机已登录的客户端，把「能白捡几个账号」说出来。
  //
  // 刻意不 await：agy 族的探测要起子进程跑 `agy models`（秒级），放进 apply 的路径上会
  // 拖慢插件加载。扫描只用于提示，不参与任何后续判断——导入永远是显式动作。
  if (settings.discoverOnStartup !== false) {
    void discoverLocalAccounts({ families, store, ctx: familyContext, log })
      .then((scan) => {
        const fresh = scan.importable.filter((entry) => !entry.alreadyImported)
        if (fresh.length > 0) {
          log.info?.(
            'account-bridge: 发现 %d 个可导入的本机登录态（%s）——用 account_bridge_discover 查看或导入',
            fresh.length,
            fresh.map((entry) => `${entry.family}: ${entry.label ?? '未命名'}`).join('; '),
          )
        }
        if (scan.unsupported.length > 0) {
          log.info?.(
            'account-bridge: 另外探测到 %d 处尚未实现的族的凭据（%s）',
            scan.unsupported.length,
            scan.unsupported.map((entry) => entry.family).join(', '),
          )
        }
      })
      .catch((error) => {
        log.warn?.('account-bridge: 本机账号发现失败: %s', String(error?.message ?? error))
      })
  }
}

export { AccountBridgeAdapter, AccountStore, CooldownTable, LoginBroker }
