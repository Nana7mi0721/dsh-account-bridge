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

/** @type {Promise<any> | undefined} */
let undiciPromise

/** 尽力加载 undici；拿不到就退化成「不支持每账号代理」的普通 fetch。 */
function loadUndici() {
  undiciPromise ??= import('undici').catch(() => undefined)
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
  let warned = false

  const dispatcherFor = async (proxyUrl, streaming) => {
    const undici = await loadUndici()
    if (!undici) {
      if (!warned) {
        warned = true
        log?.warn?.('account-bridge: undici 不可用，每账号出口代理已禁用（请求将走全局出口）')
      }
      return undefined
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
    if (!dispatcher) return fetch(url, init)
    return fetch(url, { ...init, dispatcher })
  }

  fetchWith.close = async () => {
    const closing = [...agents.values()].map((agent) => agent.close?.().catch(() => {}))
    agents.clear()
    await Promise.all(closing)
  }

  return fetchWith
}
