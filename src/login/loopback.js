/**
 * PKCE + OAuth 回环回调服务器。
 *
 * 关键约束（来自族级考古）：
 * - Google 只发 GET，DSH 的 RPC 只能 POST ⇒ 回环必须是**真的 HTTP 路由**；
 * - Claude 的 redirect_uri 里带端口 ⇒ 只能用临时端口（port 0）；
 * - Codex 固定用 1455/1457 两个端口，依次尝试；
 * - 「浏览器回调」与「粘贴码」是两条路，谁先到用谁，另一条要能被取消。
 * @module dsh-account-bridge/login/loopback
 */

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

/** 生成 PKCE 的 verifier / challenge（S256）。 */
export function createPkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, method: 'S256' }
}

/** 生成 OAuth state。 */
export function createState() {
  return randomBytes(16).toString('base64url')
}

/**
 * 起一个回环服务器等 OAuth 回调。
 *
 * @param {{
 *   ports?: number[],           端口候选，`0` 表示由系统分配临时端口
 *   path?: string,              回调路径，如 '/auth/callback'
 *   host?: string,              默认 '127.0.0.1'
 *   timeoutMs?: number,         等待上限，默认 5 分钟
 *   signal?: AbortSignal,
 *   onReady?: (info: {port: number, redirectUri: string}) => void,
 * }} options
 * @returns {Promise<{
 *   port: number,
 *   redirectUri: string,
 *   waitForCode: (expectedState?: string) => Promise<{code: string, state?: string}>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startLoopback(options = {}) {
  const {
    ports = [0],
    path = '/callback',
    host = '127.0.0.1',
    timeoutMs = 5 * 60_000,
    signal,
    onReady,
  } = options

  let resolveCode
  let rejectCode
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // 没人 await 时的拒绝不算未处理异常
  codePromise.catch(() => {})

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname !== path) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') ?? undefined
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderPage(error, code))
    if (error) {
      rejectCode(new Error(`authorization denied: ${error} ${url.searchParams.get('error_description') ?? ''}`.trim()))
      return
    }
    if (!code) {
      rejectCode(new Error('authorization callback carried no code'))
      return
    }
    resolveCode({ code, state })
  })

  const port = await listenOnAny(server, ports, host)
  const redirectUri = `http://localhost:${port}${path}`
  const onReadyInfo = { port, redirectUri }
  onReady?.(onReadyInfo)

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    await new Promise((resolve) => server.close(() => resolve()))
  }
  const onAbort = () => {
    rejectCode(signal.reason ?? new Error('aborted'))
    void close()
  }
  const timer = setTimeout(() => {
    rejectCode(new Error(`authorization callback timed out after ${Math.round(timeoutMs / 1000)}s`))
    void close()
  }, timeoutMs)
  timer.unref?.()
  signal?.addEventListener?.('abort', onAbort, { once: true })

  return {
    ...onReadyInfo,
    waitForCode: async (expectedState) => {
      const result = await codePromise
      // 严格相等：**回调没带 state 也算不匹配**。
      //
      // 原来这里写的是 `result.state !== undefined && result.state !== expectedState`，
      // 那个多出来的判断把「回调压根没带 state」——最可疑的那种情况——判成了通过。
      // 回调路由（见上面 `handle`）不校验任何头部，本机任意实体都能
      // `GET /callback?code=<攻击者自己的授权码>`，不带 state 就能把它的令牌写进受害者
      // 的账号池。OAuth 的 state 本来就是为这件事存在的（RFC 6749 §10.12），
      // 而上游一定会把它回显回来 ⇒ 缺了就拒绝，没有兼容性代价。
      if (expectedState !== undefined && result.state !== expectedState) {
        throw new Error(
          result.state === undefined
            ? 'authorization callback carried no state'
            : 'authorization callback state mismatch',
        )
      }
      return result
    },
    close,
  }
}

/** 在候选端口里挑一个能 listen 的；`0` 表示让系统分配。 */
function listenOnAny(server, ports, host) {
  return new Promise((resolve, reject) => {
    let index = 0
    const attempt = () => {
      if (index >= ports.length) {
        reject(new Error(`no free port among ${ports.join(', ')}`))
        return
      }
      const port = ports[index++]
      const onError = (error) => {
        server.removeListener('listening', onListening)
        if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') attempt()
        else reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    attempt()
  })
}

/** 回调成功后给用户看的极简页面。 */
function renderPage(error, code) {
  const ok = !error && Boolean(code)
  const title = ok ? '登录成功' : '登录失败'
  const detail = ok ? '可以关闭这个页面，回到 DSH。' : `授权被拒绝：${escapeHtml(error ?? 'unknown')}`
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px/1.6 system-ui;margin:12vh auto;max-width:32rem;text-align:center">
<h1 style="font-size:1.4rem">${title}</h1><p>${detail}</p></body>`
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
}
