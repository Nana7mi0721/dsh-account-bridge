/**
 * 一个最小的「假宿主」，让插件在没有 DSH 运行时的情况下也能被加载与驱动。
 * 它只实现本插件真正用到的那几个契约，用来抓接线错误，不替代真机验证。
 * @module dsh-account-bridge/test/harness
 */

import { apply } from '../src/index.js'

/** 内存版 credentials 服务（语义与 dsh-credentials-local 对齐）。 */
export function createMemoryCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async describeRecord(key) {
      const stored = records.get(key)
      if (!stored) return { configured: false, writable: true }
      return { configured: true, kind: stored.kind, writable: true }
    },
    async listRecords() {
      return [...records].map(([key, record]) => ({ key, kind: record.kind }))
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) return records.get(key)
      records.set(key, next)
      return next
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }
}

/** 造一个假 ctx，并立刻 apply 插件。 */
export function createMockHost(config) {
  const credentials = createMemoryCredentials()
  const services = {
    credentials,
    llm: {
      routes: new Map(),
      registerAdapter(routes, adapter) {
        for (const route of routes) {
          if (services.llm.routes.has(route)) {
            const error = new Error(`provider "${route}" is already registered`)
            error.code = 'DUPLICATE_ADAPTER'
            throw error
          }
        }
        for (const route of routes) services.llm.routes.set(route, adapter)
        return () => {
          for (const route of routes) services.llm.routes.delete(route)
        }
      },
    },
    authorization: {
      flows: new Map(),
      registerFlow(definition) {
        if (services.authorization.flows.has(definition.key)) {
          const error = new Error(`a flow is already registered for "${definition.key}"`)
          error.code = 'DUPLICATE_FLOW'
          throw error
        }
        services.authorization.flows.set(definition.key, definition)
        return () => services.authorization.flows.delete(definition.key)
      },
      async begin() {
        throw new Error('not implemented in the harness')
      },
      async cancel() {},
    },
    tools: {
      definitions: new Map(),
      register(definition) {
        services.tools.definitions.set(definition.name, definition)
        return () => services.tools.definitions.delete(definition.name)
      },
    },
    // 与 `dsh-commands` 的 `normalizeDefinition` 对齐：名字要过 COMMAND_NAME 正则、
    // description 非空、给了 `input` 就必须有非空 `hint`、同 scope 重名会抛。
    // 校验写在假实现里而不是只靠真机，是为了让「命令定义写错了」在单测里就炸。
    commands: {
      definitions: new Map(),
      register(definition) {
        if (!/^[a-z][a-z0-9_-]*$/.test(definition.name)) {
          throw new TypeError(`command name "${definition.name}" must be lowercase`)
        }
        if (typeof definition.description !== 'string' || definition.description.trim() === '') {
          throw new TypeError(`command "${definition.name}" description must not be empty`)
        }
        if (definition.input !== undefined
          && (typeof definition.input?.hint !== 'string' || definition.input.hint.trim() === '')) {
          throw new TypeError(`command "${definition.name}" input hint must be a non-empty string`)
        }
        if (typeof definition.handler !== 'function') {
          throw new TypeError(`command "${definition.name}" handler must be a function`)
        }
        if (services.commands.definitions.has(definition.name)) {
          throw new Error(`commands: "${definition.name}" is already registered in this scope`)
        }
        services.commands.definitions.set(definition.name, definition)
        return () => services.commands.definitions.delete(definition.name)
      },
    },
    // 与 `dsh-host-webserver` 的契约对齐：`register({kind,path,handler})`，
    // **重复 path 会抛**（宿主侧就是这么写的），返回 disposer。
    webServer: {
      routes: new Map(),
      register(route) {
        if (services.webServer.routes.has(route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
        services.webServer.routes.set(route.path, route)
        return () => services.webServer.routes.delete(route.path)
      },
    },
  }

  const disposers = []
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  }

  const ctx = {
    logger,
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    get(serviceName) {
      return services[serviceName]
    },
    inject(deps, callback) {
      const missing = deps.filter((dep) => !services[dep])
      if (missing.length > 0) return undefined
      const child = {
        ...ctx,
        get: (serviceName) => services[serviceName],
        [deps[0]]: services[deps[0]],
        effect: ctx.effect,
        inject: ctx.inject,
      }
      for (const dep of deps) child[dep] = services[dep]
      callback(child)
      return child
    },
  }

  // 默认关掉启动扫描：它会真的去读用户主目录、并起子进程跑 `agy models`。
  // 单测要的是确定性，不是「在跑测试的这台机器上碰巧发现了什么」。
  apply(ctx, { discoverOnStartup: false, ...(config ?? {}) })

  return {
    ctx,
    services,
    credentials,
    disposers,
    dispose() {
      for (const dispose of disposers.splice(0)) dispose?.()
    },
  }
}
