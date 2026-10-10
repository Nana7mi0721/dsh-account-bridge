/**
 * `commandcode` 族 —— CommandCode（commandcode.ai）的账号级反代。
 *
 * 上游 `api.commandcode.ai` 同时提供**三套**形状不同的 API，本族要在三者之间
 * **自动协商**（用户不该知道 `/alpha/generate` 是什么）：
 *
 * | 传输 | 路径 | 什么时候用 |
 * |---|---|---|
 * | `openai` | `/provider/v1/chat/completions` | 默认，目录没意见时 |
 * | `messages` | `/provider/v1/messages` | 目录的 `supported_endpoints` 含 `/messages`，或 `claude-*` 前缀 |
 * | `cli` | `/alpha/generate` | 官方 CLI 的私有信封：只有 Go 套餐（403 `upgrade_required`）才降到这里 |
 *
 * 协商的三条纪律（都在 `wire/commandcode.js` 里，这里只负责调）：
 * 1. **目录是权威**，前缀只是目录缺席时的兜底；
 * 2. **降级要有证据**：只有上游点名「这个模型必须走另一个端点」或 Go 套餐的
 *    403 才换传输。一次 500 / 限流**一律不换**——那会把真实故障伪装成协议问题；
 * 3. **换传输不是换账号**：这是本族自己的重试，池子那边完全不知道（也不该知道）。
 *
 * 凭据形态：**长期 API key，没有刷新也没有过期**（key 本身就是 bearer）。
 * 所以 `needsRefresh()` 恒 `false`、`refresh()` 原样返回——这不是漏写，
 * 是这个上游没有刷新语义（`src/accounts.ts:438-453`：401 直接永久禁用，
 * 直到用户换 key）。也正因为没有轮换，`externallyOwned` 的记录**不需要写回**。
 *
 * @module dsh-account-bridge/families/commandcode
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { assertApiReply } from '../wire/assert-reply.js'
import { diagnosticReporter } from '../wire/diagnostics.js'
import { httpError } from '../wire/http-error.js'
import { randomId, withSource } from '../util.js'
import {
  CREDITS_PATH,
  DEFAULT_API_BASE,
  DEFAULT_CLI_VERSION,
  MODELS_PATH,
  WHOAMI_PATH,
  buildBody,
  endpointOf,
  emptyResponse,
  modelInfo,
  parseCatalog,
  requestHeaders,
  resolveProtocol,
  routingMismatch,
  translateCommandCodeStream,
} from '../wire/commandcode.js'

/** 用户能设的密钥来源环境变量名（与官方插件一致）。 */
const API_KEY_ENV = 'COMMANDCODE_API_KEY'
/** 覆盖 CLI 状态目录，测试与多 profile 用；默认 `~/.commandcode`。 */
const HOME_ENV = 'COMMANDCODE_HOME'
/** 登录成功后回跳的 Studio 页面（上游 `STUDIO_AUTH_PATH`）。 */
const STUDIO_AUTH_PATH = '/studio/auth/cli'
/** 回调端口偏好区间。0 = 让系统分配（默认，测试安全）。 */
const LOGIN_START_PORT = 5959
const LOGIN_MAX_PORT_ATTEMPTS = 10
/** 回调 body 上限，**按字节**（上游 `LOGIN_BODY_LIMIT_BYTES`）。 */
const LOGIN_BODY_LIMIT_BYTES = 10_000
const LOGIN_TIMEOUT_MS = 120_000
/** 只有这些页面可以把凭据 POST 进回调（上游 `LOGIN_ALLOWED_ORIGINS`）。 */
const LOGIN_ALLOWED_ORIGINS = ['http://localhost:3000', 'https://staging.commandcode.ai', 'https://commandcode.ai']
/**
 * 上游报出的限额是**不可信输入**：把 resetAt 钉在过远的未来会让这个账号
 * 永久退出轮换（上游 `MAX_TRUSTED_RESET_MS` 就是为这个存在的）。
 */
const MAX_TRUSTED_RESET_MS = 30 * 24 * 60 * 60 * 1000
/** 额度快照的有效期（额度是给面板看的，不需要每次刷新都打上游）。 */
const QUOTA_TTL_MS = 60_000

/**
 * 模型目录的进程内缓存（`stream` 的路由决策要读它）。
 *
 * 只缓「目录说了什么」，**绝不缓存「哪次报错教了我们什么」**——没有协议记忆表，
 * 因为上游 issue #46 的教训是：决策依赖模型，而缓存键只有网关+密钥，
 * 记住它会把整个账号钉死在一套传输上。
 */
const catalogs = new Map()

// ------------------------------------------------------------------ 凭据

/** CLI 状态目录：`COMMANDCODE_HOME` 覆盖，默认 `~/.commandcode`。 */
export function commandCodeHome(env = process.env) {
  const override = env[HOME_ENV]
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  return join(homedir(), '.commandcode')
}

/**
 * 登录文件里的凭据记录 → API key。
 *
 * 上游 `apiKeyFromCredentialRecord`：`type==='api'` 取 `value.key`，
 * `type==='oauth'` 取 `value.access`，没有 type 就两者都试。
 */
export function apiKeyFromCredentialRecord(value) {
  if (!isRecord(value)) return undefined
  if (value.type === 'api') return nonEmptyString(value.key)
  if (value.type === 'oauth') return nonEmptyString(value.access)
  return nonEmptyString(value.key) ?? nonEmptyString(value.access)
}

/**
 * `~/.commandcode/auth.json` → `{ apiKey, userName?, keyName? }`。
 *
 * 解析顺序照抄上游 `adapter.ts:540-568`：先看**字符串**形式的
 * `apiKey` / `commandcode`，再看记录形式的 `commandcode` / `command-code`。
 * 上游注释明说只读这一个文件（pi/OMP 的 auth file 故意不扫），这里同样不扫。
 */
export function parseAuthFile(json) {
  if (!isRecord(json)) return undefined
  const direct = nonEmptyString(json.apiKey) ?? nonEmptyString(json.commandcode)
  const key =
    direct ??
    apiKeyFromCredentialRecord(json.commandcode) ??
    apiKeyFromCredentialRecord(json['command-code'])
  if (key === undefined) return undefined
  const record = isRecord(json.commandcode) ? json.commandcode : isRecord(json['command-code']) ? json['command-code'] : {}
  return {
    apiKey: key,
    userName: nonEmptyString(json.userName) ?? nonEmptyString(record.userName),
    keyName: nonEmptyString(json.keyName) ?? nonEmptyString(record.keyName),
  }
}

/**
 * 凭据记录（credentials seam / provider store）→ 认证对象。
 *
 * 值可能是字符串，也可能是别的插件写下的 `{apiKey}` / `{api_key}` / `{key}`
 * 包装——`/alpha/whoami` 只认 bearer，形状猜错就是 401。
 */
export function credentialFromRecord(value) {
  if (typeof value === 'string') {
    const key = nonEmptyString(value)
    return key === undefined ? undefined : { apiKey: key }
  }
  if (!isRecord(value)) return undefined
  const key =
    nonEmptyString(value.apiKey) ??
    nonEmptyString(value.api_key) ??
    nonEmptyString(value.key) ??
    apiKeyFromCredentialRecord(value)
  if (key === undefined) return undefined
  const userName = nonEmptyString(value.userName) ?? nonEmptyString(value.email)
  return { apiKey: key, ...(userName === undefined ? {} : { userName }) }
}

function authOf(item) {
  return { apiKey: item.apiKey, ...(item.userName ? { userName: item.userName } : {}) }
}

function labelOf(item) {
  return item.userName ?? item.keyName ?? 'CommandCode'
}

/** 上游地址：记录里可覆盖（自建/区域网关），默认官方。 */
function apiBaseOf(auth) {
  const override = nonEmptyString(auth?.apiBase)
  return override ?? DEFAULT_API_BASE
}

/** 只接受 `user_` 形状的 key：别的形状几乎肯定是读错了文件。 */
function looksLikeApiKey(key) {
  return typeof key === 'string' && key.startsWith('user_') && key.length >= 12
}

// ------------------------------------------------------------------ discover

/**
 * 本机登录态发现。
 *
 * 四源按**用户可见的优先级**依次尝试，并如实报出「找到了哪一处」：
 *
 * 1. `credentials` 服务（`COMMANDCODE_API_KEY`）——官方文档里第一推荐的写法，
 *    也是 DSH 自己的凭据 UI 写进去的地方；
 * 2. 环境变量（凭证服务没起来或没配时的兜底）；
 * 3. `~/.commandcode/auth.json`——`command-code login` 落盘的位置（**只读**）；
 * 4. credentials 里 `commandcode` 名下的存量记录（浏览器登录那一次写的）。
 *
 * 四处都没有**不返回空数组**：那在 UI 上就是「什么都没发现」，
 * 用户拿不到任何下一步。这里返回一条 `importable:false` 的说明项，
 * 把三条能自救的路都写清楚。
 */
async function discover(ctx) {
  return discoverWith(ctx, {})
}

/**
 * `discover` 的本体，带环境覆盖。
 *
 * 测试要能同时构造「env 里有 key」「auth.json 里有 key」两种情形，而
 * `process.env` 与 `homedir()` 都不该被迫改进程全局——所以这里收一层。
 */
export async function discoverWith(ctx, { env = process.env, home } = {}) {
  const [credential, stored] = await Promise.all([
    fromCredentialsService(ctx),
    fromStoredRecords(ctx),
  ])
  const candidates = [credential, fromEnvironment(env), await fromAuthFile({ env, home }), ...stored]
  const hits = candidates.filter((candidate) => candidate?.apiKey !== undefined)
  if (hits.length === 0) {
    // 文件在但读不出来的情况要点名说清楚（否则用户会一直以为已经登录成功了）。
    const broken = candidates.find((candidate) => candidate?.problem !== undefined)
    const brokenNote = broken === undefined ? '' : `（注意：${broken.problem}）`
    const homeDir = home ?? commandCodeHome(env)
    return [
      {
        family: 'commandcode',
        sourcePath: `${homeDir} (auth.json)`,
        label: 'CommandCode',
        importable: false,
        reason:
          `本机没有找到 CommandCode 登录态：四处理都没有可用凭据——① credentials 里的 ${API_KEY_ENV} 未配置，` +
          `② 环境变量 ${API_KEY_ENV} 未设置，③ ${join(homeDir, 'auth.json')} 不存在，` +
          '④ credentials 里没有存量记录。' +
          brokenNote +
          '任选一条即可：跑 `command-code login`（写 ~/.commandcode/auth.json）、' +
          `设置环境变量 ${API_KEY_ENV}、或在本设置页用「登录」里的「粘贴 API key」加一个账号。`,
      },
    ]
  }
  // 同一个 key 在多个源里出现时只留优先级最高的那一处。
  const seen = new Set()
  return hits
    .filter((item) => {
      if (seen.has(item.apiKey)) return false
      seen.add(item.apiKey)
      return true
    })
    .map((item) => ({
      family: 'commandcode',
      sourcePath: item.sourcePath,
      label: labelOf(item),
      importable: true,
      externallyOwned: true,
      auth: authOf(item),
    }))
}

/** ① credentials 服务：`resolve()` 走它自己的分层（env → 存储 → .env）。 */
async function fromCredentialsService(ctx) {
  const credentials = ctx?.get?.('credentials')
  if (typeof credentials?.resolve !== 'function') return undefined
  try {
    const resolved = await credentials.resolve(API_KEY_ENV)
    const value = resolved?.value ?? resolved
    const key = typeof value === 'string' ? nonEmptyString(value) : credentialFromRecord(value)?.apiKey
    if (key === undefined) return undefined
    const source = nonEmptyString(resolved?.source) ?? 'credentials'
    return { apiKey: key, sourcePath: `${source}: ${API_KEY_ENV} (credentials)`, origin: 'credentials' }
  } catch {
    // 凭据服务读失败不该让整族发现挂掉；后面的源还有机会。
    return undefined
  }
}

/** ② 环境变量（launching environment 里 export 的那一份）。 */
function fromEnvironment(env = process.env) {
  const key = nonEmptyString(env[API_KEY_ENV])
  if (key === undefined) return undefined
  return { apiKey: key, sourcePath: `env: ${API_KEY_ENV}`, origin: 'env' }
}

/** ③ `~/.commandcode/auth.json` —— 官方 CLI 的落盘位置，**只读**。 */
async function fromAuthFile({ env = process.env, home } = {}) {
  const path = join(home ?? commandCodeHome(env), 'auth.json')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    // 文件在但读不懂：这**不是**「没装」。要点名说清楚，否则用户会一直以为登录成功了。
    return {
      problem: `${path} 存在但不是合法 JSON`,
      sourcePath: path,
    }
  }
  const parsed = parseAuthFile(json)
  if (parsed === undefined) {
    return { problem: `${path} 里没有 apiKey / commandcode 字段`, sourcePath: path }
  }
  return { ...parsed, sourcePath: path, origin: 'auth-file' }
}

/** ④ credentials 里的存量记录（浏览器登录写下的那些）。 */
async function fromStoredRecords(ctx) {
  const credentials = ctx?.get?.('credentials')
  if (typeof credentials?.listRecords !== 'function' || typeof credentials?.readRecord !== 'function') return []
  let records = []
  try {
    records = (await credentials.listRecords()) ?? []
  } catch {
    return []
  }
  const out = []
  for (const entry of records) {
    const key = entry?.key ?? entry
    if (!matchesCommandCodeKey(key)) continue
    let value
    try {
      value = await credentials.readRecord(key)
    } catch {
      continue
    }
    const parsed = credentialFromRecord(value)
    if (parsed === undefined) continue
    out.push({ ...parsed, sourcePath: `credentials: ${stringifyKey(key)}`, origin: 'credentials-record' })
  }
  return out
}

/** 记录键是不是本插件/本 provider 名下的（`scope` + `id` 拼出来的键）。 */
function matchesCommandCodeKey(key) {
  const text = stringifyKey(key).toLowerCase()
  return text.includes('commandcode') || text.includes('command-code')
}

function stringifyKey(key) {
  if (typeof key === 'string') return key
  if (isRecord(key)) return [key.scope, key.id].filter((part) => typeof part === 'string').join('/')
  return ''
}

/** 一项发现 → 账号记录（`withSource` 把 `sourcePath` 记进记录，供去重用）。 */
function recordFromDiscovery(item) {
  const auth = { ...item.auth }
  return withSource(
    {
      family: 'commandcode',
      label: item.label ?? 'CommandCode',
      source: 'client-import',
      externallyOwned: true,
      auth,
      createdAt: Date.now(),
    },
    item,
  )
}

// ------------------------------------------------------------------ 登录

/** apiBase → Studio 站点（上游 `studioBaseForApiBase`）。 */
export function studioBaseForApiBase(apiBase) {
  const base = nonEmptyString(apiBase) ?? DEFAULT_API_BASE
  if (base.includes('staging-api.')) return 'https://staging.commandcode.ai'
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(base)) return 'http://localhost:3000'
  return 'https://commandcode.ai'
}

/** 浏览器要打开的授权页（上游 `buildCommandAuthUrl`）。 */
export function buildStudioAuthUrl({ studioBase, port, state }) {
  const callback = `http://localhost:${port}/callback`
  return (
    `${studioBase}${STUDIO_AUTH_PATH}` +
    `?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(state)}`
  )
}

/**
 * 回调请求 → 响应（**纯函数**，好测）。
 *
 * 与上游 `handleCallback` 的分支一一对应：非 `/callback` → 404，非 POST（含
 * OPTIONS 预检）→ 405/204，body 超限 → 413，不是 JSON → 400，state 不符 →
 * 403（**不作终止**：伪造请求不该让真登录等死），缺字段 → 400。
 * CORS 只对白名单回显，其它一律不给头。
 */
export function parseCallbackRequest({ method, path = '/callback', origin, body, expectedState }) {
  const allowOrigin = LOGIN_ALLOWED_ORIGINS.includes(origin) ? origin : ''
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...(allowOrigin === '' ? {} : { 'access-control-allow-origin': allowOrigin }),
  }
  const fail = (status, error) => ({ status, headers, body: { success: false, error } })
  const pathname = String(path).split('?')[0]
  if (pathname !== '/callback') return fail(404, 'Not found')
  if (method === 'OPTIONS') return { status: 204, headers, body: undefined }
  if (method !== 'POST') return fail(405, 'Method not allowed')
  const bytes = Buffer.byteLength(typeof body === 'string' ? body : '', 'utf8')
  if (bytes > LOGIN_BODY_LIMIT_BYTES) return fail(413, 'Payload too large')
  let json
  try {
    json = JSON.parse(body)
  } catch {
    return fail(400, 'Invalid JSON')
  }
  if (!isRecord(json)) return fail(400, 'Invalid JSON')
  if (json.error !== undefined && json.error !== null && json.error !== '') {
    // 用户在 Studio 页点了拒绝：state 仍要先校验，只终止匹配的那一次等待。
    if (json.state !== expectedState) return fail(403, 'Invalid state token')
    return { status: 200, headers, body: { success: false, error: String(json.error) }, rejected: String(json.error) }
  }
  if (json.state !== expectedState) return fail(403, 'Invalid state token')
  const credentials = callbackCredentials(json)
  if (credentials === undefined) return fail(400, 'Missing required fields')
  return { status: 200, headers, body: { success: true }, credentials }
}

/** Studio 回传的五个字段（上游 `isCallbackCredentials`）。 */
function callbackCredentials(json) {
  const apiKey = nonEmptyString(json.apiKey)
  const state = nonEmptyString(json.state)
  const userId = nonEmptyString(json.userId)
  const userName = nonEmptyString(json.userName)
  const keyName = nonEmptyString(json.keyName)
  if (apiKey === undefined || state === undefined || userId === undefined || userName === undefined || keyName === undefined) {
    return undefined
  }
  return { apiKey, state, userId, userName, keyName }
}

/**
 * 起一个**只服务于 Studio 回调**的 HTTP 服务器。
 *
 * 不复用 `src/login/loopback.js`：那个实现只认 GET + query 参数，而 Studio 是
 * POST 一份 JSON 到 `/callback`（没有 OAuth code exchange 这一步）。它的
 * `ports` 从 5959 起试 10 个的语义在这里保留——**只有偏好端口被占用才顺延**，
 * 其它错误（权限、地址不可用）直接抛，不能把真问题伪装成「换个端口就好了」。
 */
async function startCallbackServer({ ports = [0], expectedState, signal, onReady }) {
  let lastError
  for (const port of ports) {
    const attempt = await listenOnce(port, { expectedState, signal, onReady })
    if (attempt.server !== undefined) return attempt
    lastError = attempt.error
    if (attempt.error?.code !== 'EADDRINUSE') break
  }
  throw lastError ?? new Error('commandcode: could not start the login callback server')
}

function listenOnce(port, { expectedState, signal, onReady }) {
  return new Promise((resolve) => {
    let account
    const server = createServer((request, response) => {
      const chunks = []
      let size = 0
      let aborted = false
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > LOGIN_BODY_LIMIT_BYTES) {
          aborted = true
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (aborted) {
          respond(response, { status: 413, headers: corsHeaders(request.headers.origin), body: { success: false, error: 'Payload too large' } })
          return
        }
        const result = parseCallbackRequest({
          method: request.method,
          path: request.url,
          origin: request.headers.origin,
          body: Buffer.concat(chunks).toString('utf8'),
          expectedState,
        })
        respond(response, result)
        if (result.credentials !== undefined) account = result.credentials
        if (result.rejected !== undefined) account = { rejected: result.rejected }
      })
      request.on('error', () => {
        aborted = true
      })
    })
    server.on('error', (error) => resolve({ error }))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      const close = () =>
        new Promise((done) => {
          signal?.removeEventListener?.('abort', onAbort)
          server.close(() => done())
        })
      const onAbort = () => {
        server.close()
      }
      signal?.addEventListener?.('abort', onAbort)
      resolve({
        server,
        port: actualPort,
        close,
        waitForAccount: (timeoutMs = LOGIN_TIMEOUT_MS) =>
          new Promise((done) => {
            const deadline = Date.now() + timeoutMs
            const poll = () => {
              if (account !== undefined) {
                done(account)
                return
              }
              if (Date.now() > deadline || signal?.aborted === true) {
                done(undefined)
                return
              }
              setTimeout(poll, 100)
            }
            poll()
          }),
      })
    })
    onReady?.(server)
  })
}

function respond(response, result) {
  response.writeHead(result.status, result.headers)
  response.end(result.body === undefined ? '' : JSON.stringify(result.body))
}

function corsHeaders(origin) {
  return {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...(LOGIN_ALLOWED_ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin } : {}),
  }
}

/**
 * 拿 `/alpha/whoami` 验一次 key。
 *
 * 上游在**存盘之前**就验（`login.ts:134-140`）：存进去一个打不通的 key，
 * 用户要到第一次推理才发现，那时已经分不清是 key 错还是别的问题。
 */
async function validateKey(ctx, apiKey, proxy, signal) {
  const response = await ctx.fetch(
    `${DEFAULT_API_BASE}${WHOAMI_PATH}`,
    {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        // `/alpha/whoami` 属于账号面：带版本号与 x-cli-environment，不带 taste/co-flag。
        ...requestHeaders(apiKey, { surface: 'account', cliVersion: cliVersionOf(ctx, undefined) }),
      },
      signal: signal ?? AbortSignal.timeout(15_000),
    },
    proxy,
  )
  if (response.status === 401) return { ok: false, reason: 'invalid_key' }
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
  return { ok: true }
}

const login = {
  methods: [
    { id: 'browser', label: '在浏览器里登录 CommandCode' },
    { id: 'paste', label: '粘贴 API key' },
    { id: 'import', label: '导入本机已有的登录态' },
  ],

  async run(session, ctx) {
    const method = session.method ?? 'browser'
    if (method === 'import') return runImport(session, ctx)
    if (method === 'paste') return runPaste(session, ctx)
    return runBrowser(session, ctx)
  },
}

async function runImport(session, ctx) {
  const items = await discover(ctx)
  const usable = items.filter((item) => item.importable === true)
  if (usable.length === 0) {
    throw new Error(`commandcode: 没有可导入的本机登录态（${items[0]?.reason ?? '未知原因'}）`)
  }
  let picked = usable[0]
  if (usable.length > 1) {
    const answer = await session.prompt({
      kind: 'select',
      message: '导入哪一个 CommandCode 登录态？',
      options: usable.map((item, index) => ({ value: String(index), label: `${item.label}（${item.sourcePath}）` })),
    })
    picked = usable[Number(answer)] ?? usable[0]
  }
  await commitLogin(session, picked.auth, picked.label, 'client-import', true)
  return picked
}

async function runPaste(session, ctx) {
  const key = await session.prompt({
    kind: 'secret',
    message: `粘贴 CommandCode API key（形如 user_...；也可以在 ${API_KEY_ENV} 里设置后走「导入」）`,
  })
  const apiKey = nonEmptyString(key)
  if (apiKey === undefined) throw new Error('commandcode: 没有拿到 API key')
  const check = await validateKey(ctx, apiKey, session.proxy, session.signal)
  if (!check.ok) {
    throw new Error(`commandcode: 这个 API key 没通过校验（${check.reason}）；请到 commandcode.ai 的设置页确认`)
  }
  await commitLogin(session, { apiKey }, 'CommandCode', 'manual', false)
  return { apiKey }
}

async function runBrowser(session, ctx) {
  const state = randomId(16)
  const studio = studioBaseForApiBase(session.apiBase)
  const ports = session.port !== undefined ? [session.port] : [0, ...portPreferences()]
  const server = await startCallbackServer({ ports, expectedState: state, signal: session.signal })
  try {
    const url = buildStudioAuthUrl({ studioBase: studio, port: server.port, state })
    await session.notify({
      message:
        '即将在浏览器里打开 CommandCode 的授权页；在那里确认之后这个窗口会自动完成。' +
        '（Studio 页面必须和本机在同一台机器上，回调是 http://localhost 的。）',
      url,
    })
    const account = await server.waitForAccount(session.timeoutMs ?? LOGIN_TIMEOUT_MS)
    if (account === undefined) {
      throw new Error('commandcode: 浏览器登录没有在 2 分钟内完成（可以改用「粘贴 API key」）')
    }
    if (account.rejected !== undefined) throw new Error(`commandcode: 授权被拒绝（${account.rejected}）`)
    const check = await validateKey(ctx, account.apiKey, session.proxy, session.signal)
    if (!check.ok) throw new Error(`commandcode: 浏览器回传的 API key 没通过校验（${check.reason}）`)
    await commitLogin(session, { apiKey: account.apiKey, userName: account.userName }, account.userName, 'oauth', false)
    return account
  } finally {
    await server.close()
  }
}

/** 5959 起试 10 个只是**偏好**：0 排在最前面，端口被占用时也不会让登录失败。 */
function portPreferences() {
  const ports = []
  for (let offset = 0; offset < LOGIN_MAX_PORT_ATTEMPTS; offset += 1) ports.push(LOGIN_START_PORT + offset)
  return ports
}

/** 提交前必须 commit，否则 seam 抛 `NOT_COMMITTED`；`createdAt` 由 store 补。 */
async function commitLogin(session, auth, label, source, externallyOwned) {
  const record = {
    family: 'commandcode',
    label: label ?? 'CommandCode',
    source,
    externallyOwned,
    auth,
    createdAt: Date.now(),
  }
  await session.commit({ kind: 'grant', payload: record })
  return record
}

// ------------------------------------------------------------------ 刷新

/**
 * CommandCode 的凭据是**长期 API key**：没有 refresh token、没有过期时间。
 *
 * 所以这里只做「还拿得出 key 吗」的检查，原样返回——返回一个新对象只是为了
 * 满足契约（`refresh` 返回的是 auth 对象），里面的键一个都没变。
 * 上游对 401 的处理是**永久禁用该账号直到 key 改变**（`accounts.ts:438-453`），
 * 那是池子的冷却表在管，不需要在这里做任何事。
 */
async function refresh(ctx, payload) {
  const auth = payload?.auth ?? {}
  const key = nonEmptyString(auth.apiKey)
  if (key === undefined) {
    const error = new Error('commandcode: 这条记录里没有 apiKey，请重新登录或导入')
    error.code = 'AUTH'
    error.failure = { code: 'AUTH' }
    throw error
  }
  return { ...auth, apiKey: key }
}

/**
 * 永远不刷新。
 *
 * **这不是漏写**：这一族的 key 不会过期、也不会轮换，所以「现在要不要刷」
 * 的正确答案恒为「不要」。写成 `true` 只会让池子每个请求都打一次上游。
 */
function needsRefresh() {
  return false
}

// ------------------------------------------------------------------ 目录

/**
 * 模型目录。
 *
 * `GET /provider/v1/models` **不需要 key 也能浏览**（上游明说），所以这里
 * 不做凭据前置检查：401 之前先拿到目录，面板才有东西显示。
 *
 * 失败时**回落一个极小的兜底目录**：池子在没有旧快照时会直接抛给宿主，
 * 整个 route 的模型会消失。兜底清单里的每个 id 都注明「这是我们猜的",
 * 真实 id 以 `listModels` 成功后的目录为准。
 */
async function listModels(ctx, payload, signal) {
  const apiKey = nonEmptyString(payload?.auth?.apiKey)
  const apiBase = apiBaseOf(payload?.auth)
  const url = `${apiBase}${MODELS_PATH}`
  try {
    const response = await ctx.fetch(
      url,
      { method: 'GET', headers: requestHeaders(apiKey, {}), signal },
      payload?.proxy,
    )
    if (!response.ok) {
      throw await httpError(response, await response.text().catch(() => ''), 'commandcode')
    }
    const json = await response.json()
    const models = parseCatalog(json)
    if (models.length === 0) {
      ctx.log?.warn?.('account-bridge: commandcode catalog at %s is empty', url)
      return fallbackModels()
    }
    catalogs.set(catalogKey(payload), models)
    return models.map((entry) => modelInfo(entry.id, entry.name, entry, 'acct-commandcode'))
  } catch (error) {
    ctx.log?.warn?.('account-bridge: commandcode catalog failed (%s); falling back to a minimal list', error?.message ?? error)
    return fallbackModels()
  }
}

/**
 * 目录彻底拿不到时的兜底。
 *
 * 保守到只有三条，且都走默认的 `openai` 传输：宁可少列几个模型，
 * 也不要在面板上列出一堆打不通的 id。
 */
function fallbackModels() {
  return FALLBACK_MODEL_IDS.map((id) => modelInfo(id, id, undefined, 'acct-commandcode'))
}

const FALLBACK_MODEL_IDS = ['commandcode-default', 'command-code', 'claude-sonnet-4-5']

/** 目录的缓存键：同一网关+密钥的目录是一样的。 */
function catalogKey(payload) {
  return `${apiBaseOf(payload?.auth)}|${nonEmptyString(payload?.auth?.apiKey) ?? ''}`
}

function resolveModel(provider, model) {
  return modelInfo(model, model, undefined, provider)
}

// ------------------------------------------------------------------ 额度

/**
 * 双窗口额度（5 小时 + 周）。
 *
 * 源结构（上游 `adapter.ts:1640-1678` `parseWindowLimit`）：
 * `{ creditsData?, windowLimits?: { fiveHour?: {used, cap, exceeded, resetAt}, weekly?: {…} } }`。
 *
 * 三条不编的规矩：
 * - **窗口缺失 ≠ cap 为 0**：缺失是「账单端点没报这个窗口」（无限制套餐），
 *   `cap: 0` 是「真实上报的无限花费」，两者的 remainingFraction 都是**未知**，
 *   不能折算成 0% 或 100%；
 * - 两个窗口都读不到 → 整个 `quota` 返回 `undefined`（宁可不画进度条）；
 * - `resetAt` 在这些端点上毫秒/秒混用，所以按量级判断；过远的丢弃。
 */
async function quota(ctx, payload, signal) {
  const auth = payload?.auth ?? {}
  const now = Date.now()
  const cached = quotaCache.get(`${catalogKey(payload)}`)
  if (cached !== undefined && now - cached.at < QUOTA_TTL_MS) return cached.windows

  const url = `${apiBaseOf(auth)}${CREDITS_PATH}`
  let windows
  try {
    const response = await ctx.fetch(
      url,
      {
        method: 'GET',
        // `/alpha/billing/credits` 也是账号面。
        headers: requestHeaders(nonEmptyString(auth.apiKey), {
          surface: 'account',
          cliVersion: cliVersionOf(ctx, auth),
        }),
        signal,
      },
      payload?.proxy,
    )
    if (!response.ok) return undefined
    const json = await response.json().catch(() => undefined)
    windows = parseWindowLimits(json, now)
  } catch {
    // 额度是给面板看的，拿不到就当没有，绝不因为额度查询失败连累请求路径。
    return undefined
  }
  if (windows === undefined) return undefined
  quotaCache.set(catalogKey(payload), { at: now, windows })
  return windows
}

const quotaCache = new Map()

/** 账单响应 → 契约里的两条窗口。读不到 → `undefined`。 */
export function parseWindowLimits(json, now = Date.now()) {
  const source = isRecord(json?.windowLimits) ? json.windowLimits : {}
  const fiveHour = windowOf(source.fiveHour, now)
  const weekly = windowOf(source.weekly, now)
  const out = []
  if (fiveHour !== undefined) out.push({ id: 'five-hour', name: '5 小时窗口', ...fiveHour })
  if (weekly !== undefined) out.push({ id: 'weekly', name: '周窗口', ...weekly })
  return out.length === 0 ? undefined : out
}

function windowOf(raw, now) {
  if (!isRecord(raw)) return undefined
  const used = nonNegative(raw.used)
  const cap = nonNegative(raw.cap)
  // cap 为 0 或缺失 = 上游报的「无限花费」：比例算不出来，如实报未知。
  const remainingFraction =
    cap !== undefined && cap > 0 && used !== undefined ? Math.min(1, Math.max(0, 1 - used / cap)) : undefined
  const resetAt = trustedReset(raw.resetAt, now)
  return {
    ...(remainingFraction === undefined ? {} : { remainingFraction }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(raw.exceeded === true ? { exceeded: true } : {}),
  }
}

/** 上游的 resetAt 毫秒/秒都可能，且过远的不可信（钉死会永久退出轮换）。 */
function trustedReset(value, now) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  const ms = number > 1e12 ? number : number * 1000
  if (ms <= now) return undefined
  if (ms - now > MAX_TRUSTED_RESET_MS) return undefined
  return ms
}

// ------------------------------------------------------------------ 推理

/**
 * 一次流式推理，带**三传输自动协商**。
 *
 * 循环的形状就是协商规则本身：
 * 1. 按目录/前缀选一套传输；
 * 2. 上游说「这个模型不在这个端点上」→ 换到它点名的那个；
 * 3. 上游说 Go 套餐没有 Provider API（403 `upgrade_required`）→ 降到 CLI；
 * 4. 其它任何失败**原样抛出**（不换协议、不换账号——换号是池子的事）。
 *
 * 已经吐过 chunk 就不再换：那些 chunk 已经交给宿主了，重放一遍等于把半句话
 * 说两次。`cli` 是终点（上游没有比它更低的传输）。
 */
async function* stream(ctx, options) {
  const { payload, model, messages, tools, system, maxTokens, effort, temperature, sessionId, signal } = options
  const auth = payload?.auth ?? {}
  const apiKey = nonEmptyString(auth.apiKey)
  if (apiKey === undefined) {
    const error = new Error('commandcode: this account has no API key')
    error.code = 'AUTH'
    error.failure = { code: 'AUTH' }
    throw error
  }
  const apiBase = apiBaseOf(auth)
  const entry = catalogEntry(payload, model)
  const forced = forcedProtocol(auth)
  let protocol = resolveProtocol({ model, entry, forced })
  const attempted = new Set()
  let delivered = false

  while (true) {
    attempted.add(protocol)
    const body = buildBody({
      protocol,
      model,
      messages,
      tools,
      system,
      maxTokens,
      effort,
      temperature,
      sessionId,
      ceiling: entry?.maxOutput,
    })
    const response = await ctx.fetch(
      endpointOf(apiBase, protocol),
      {
        method: 'POST',
        headers: requestHeaders(apiKey, {
          // CLI 面与 Provider 面的头不同：Provider 面**必须不带** CLI 身份头。
          surface: protocol === 'cli' ? 'cli' : 'provider',
          cliVersion: protocol === 'cli' ? cliVersionOf(ctx, auth) : undefined,
          json: true,
          stream: true,
          zdr: auth?.zdr === true,
        }),
        body: JSON.stringify(body),
        signal,
      },
      payload?.proxy,
      /* streaming */ true,
    )
    // 200 也可能是网页（Cloudflare 挑战页、登录页、空 body）：先确认它像 API 回复。
    const reply = await assertApiReply(response, { who: 'commandcode' })
    if (!reply.ok) {
      const text = await reply.text().catch(() => '')
      const failure = await httpError(reply, text, 'commandcode')
      const next = delivered ? undefined : routingMismatch(protocol, reply.status, text)
      // 降级只在「上一套确实不可用」时发生，且绝不回头重复试同一套。
      if (next === undefined || attempted.has(next)) throw failure
      ctx.log?.info?.(
        'account-bridge: commandcode %s rejected protocol %s (%s); retrying over %s',
        model,
        protocol,
        describeReason(reply.status, text),
        next,
      )
      protocol = next
      continue
    }
    try {
      // 刻意**不传 `model`**：`model` 只用来决定「收尾带不带 replayState」，
      // 而这条线自己组装 messages（`toMessagesMessages`），从不把思考块发回去
      // ⇒ 攒出来的信封没有任何人会读，只会白白留在会话文件里。
      for await (const chunk of translateCommandCodeStream(reply, protocol, { signal, onDiagnostic: diagnosticReporter(ctx, options.onDiagnostic) })) {
        if (chunk.type === 'block-end') delivered = true
        yield chunk
      }
    } catch (error) {
      if (error?.code === 'EMPTY_RESPONSE') {
        // 上游确实回了一个空回答：契约要求原样抛出（池子会据此换号重试）。
        throw emptyResponse(`the model returned no content over ${protocol}`)
      }
      throw error
    }
    return
  }
}

/** 记录里显式钉的传输（自建网关/调试用）；三个协议号之外的忽略。 */
function forcedProtocol(auth) {
  const value = nonEmptyString(auth?.protocol) ?? nonEmptyString(auth?.wire)
  return value === 'cli' || value === 'openai' || value === 'messages' ? value : undefined
}

/** 目录里这个模型的路由信息（没拉过目录就返回 `undefined`，走前缀兜底）。 */
function catalogEntry(payload, model) {
  const models = catalogs.get(catalogKey(payload))
  if (models === undefined) return undefined
  const entry = models.find((candidate) => candidate.id === model)
  if (entry === undefined) return undefined
  // ⚠ 只缓存**目录说过的话**，绝不缓存「哪次报错教了我们什么」：
  //    上游 issue #46 —— 决策依赖模型，而缓存键只有网关+密钥。
  return entry
}

/** 上游 CLI 版本号只来自配置：本仓的 `resolveCliVersion` 不认这一族。 */
/**
 * CLI 面的版本号：账号钉的 → 全局配置 → 上游源码里抄来的兜底常量。
 *
 * 本仓的 `src/cli-version.js` 只认 claude/codex（`FALLBACK['commandcode']` 是
 * undefined），所以这条链在族里自己走。
 */
function cliVersionOf(ctx, auth) {
  return (
    nonEmptyString(auth?.cliVersion) ??
    nonEmptyString(ctx?.config?.commandcodeClientVersion) ??
    DEFAULT_CLI_VERSION
  )
}

function describeReason(status, text) {
  const detail = String(text ?? '').slice(0, 120)
  return `HTTP ${status}${detail.length > 0 ? ` ${detail}` : ''}`
}

// ------------------------------------------------------------------ 小工具

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function nonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

export const commandcodeFamily = {
  id: 'commandcode',
  displayName: 'CommandCode',
  route: 'acct-commandcode',
  risk: 'medium',
  discover,
  recordFromDiscovery,
  login,
  refresh,
  needsRefresh,
  listModels,
  resolveModel,
  quota,
  stream,
}
