/**
 * 带「每账号出口」的 HTTP 层。
 *
 * 核心的 `dsh-http-proxy` 只做进程级代理（`HTTPS_PROXY` 全局生效），不提供多出口，
 * 所以每账号独立出口得自己实现：
 * - 有 `proxy` 的账号：为该 proxy URL 缓存一个 undici dispatcher，逐请求传；
 * - 没有的账号：走全局 fetch（也就是核心行为，环境变量代理照常生效）。
 *
 * 三个已知的坑（都来自社区实机）：
 * - Node 内置 fetch **忽略** `HTTP_PROXY` 这类环境变量，别指望它；
 * - 给 fetch 传外部 dispatcher 时要传它认识的实例，混用会 `UND_ERR_INVALID_ARG`；
 * - undici 的 `bodyTimeout` 是「两个数据块之间的空闲计时器」，默认 30s 会在长推理里
 *   掐断整轮响应 ⇒ 流式请求必须用 `bodyTimeout: 0` 的 agent。
 * @module dsh-account-bridge/http
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** @type {Promise<any> | undefined} */
let undiciPromise

/**
 * 尽力加载 undici。找不到就返回 `undefined`，**由调用方决定怎么处理**。
 *
 * 为什么要找两个地方：本模块解析 `undici` 是按**真实路径**走的，而本插件在开发时是
 * `link:` 到仓库的（仓库里没有 `node_modules`），正式安装时才是 profile 的
 * `node_modules/dsh-account-bridge`（那一层有 undici —— pnpm 的 `hoistPattern: ['*']`
 * 把它提上来了）。所以先按常规解析，失败再按**宿主进程的入口**解析一次：桌面版的宿主
 * 自带一份 `dsh/node_modules/undici`，从那儿能拿到。
 */
function loadUndici() {
  undiciPromise ??= (async () => {
    try {
      return await import('undici')
    } catch {
      /* 按本模块解析不到，换宿主那一份 */
    }
    for (const from of [process.argv[1], process.execPath]) {
      if (typeof from !== 'string' || from.length === 0) continue
      try {
        const require = createRequire(from)
        return await import(pathToFileURL(require.resolve('undici')).href)
      } catch {
        /* 换下一个 */
      }
    }
    return undefined
  })()
  return undiciPromise
}

/**
 * 造一个 `fetch(url, init, proxyUrl, streaming)`，并挂上 `close()`。
 * @param {{log?: any}} [options]
 * @returns {((url: string, init: RequestInit, proxyUrl?: string, streaming?: boolean) => Promise<Response>) & {close: () => Promise<void>}}
 */
export function createFetcher(options = {}) {
  const { log } = options
  /** @type {Map<string, any>} */
  const agents = new Map()

  const dispatcherFor = async (proxyUrl, streaming) => {
    const undici = await loadUndici()
    if (!undici) {
      // **不许在这里悄悄走直连**。账号上写了代理就是要求流量从那个出口出去，静默改走本机
      // 出口的后果是：用户以为换了 IP，实际上请求带着他的真实地址出去了——而这一点在成功
      // 的响应里完全看不出来。宁可失败得响亮。
      throw Object.assign(
        new Error(
          'account-bridge: this account has a proxy configured, but the "undici" package is not '
            + 'reachable from the plugin, so the proxy cannot be used. Install the plugin normally '
            + '(not as a link: to a checkout), or clear this account\'s proxy.',
        ),
        { code: 'PROXY_UNAVAILABLE' },
      )
    }
    // 流式与普通分开缓存：流式那个必须关掉 bodyTimeout，不能拿来做普通请求
    const cacheKey = streaming ? `stream\u0000${proxyUrl}` : proxyUrl
    let agent = agents.get(cacheKey)
    if (!agent) {
      agent = streaming
        ? new undici.ProxyAgent({ uri: proxyUrl, bodyTimeout: 0, headersTimeout: 0 })
        : new undici.ProxyAgent({ uri: proxyUrl })
      agents.set(cacheKey, agent)
    }
    return agent
  }

  const fetchWith = async (url, init, proxyUrl, streaming = false) => {
    if (!proxyUrl || typeof proxyUrl !== 'string') return fetch(url, init)
    const dispatcher = await dispatcherFor(proxyUrl, streaming)
    return fetch(url, { ...init, dispatcher })
  }

  fetchWith.close = async () => {
    const closing = [...agents.values()].map((agent) => agent.close?.().catch(() => {}))
    agents.clear()
    await Promise.all(closing)
  }

  return fetchWith
}
