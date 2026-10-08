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

  apply(ctx, config)

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
