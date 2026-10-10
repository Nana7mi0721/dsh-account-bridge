/**
 * MiniMax Code（mcode）族：账号级反代。
 *
 * 走的是**账号通道**——MiniMax Code 桌面端 / CLI 的 OAuth 登录态（`mmoat_…`），
 * 直接打它自己的 Anthropic Messages 网关。三条容易走错的地方：
 *
 * 1. **不走订阅 Key**。`MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`（`sk-cp-…`）那条路
 *    宿主内置的 `pi-ai` 已经有 provider `minimax` / `minimax-cn` 了，而且是 key 级接入，
 *    不属于本插件的范围。两者是**两套凭据、两个网关**，绝不能混用：
 *    拿 mcode 的令牌去打 `www.minimax.io/v1/token_plan/remains` 会得到
 *    `status_code:1004 login fail: Please carry the API secret key`。
 *
 * 2. **要写回桌面端**。刷新时上游**轮换 refresh token**（实测），不回写的话
 *    MiniMax Code 下次自己刷新就会拿着已经作废的那一只，只能重新登录。
 *    这是对「导入的凭据默认只读」那条通则的有证据的例外，所以写回必须守规矩：
 *    原子写 + **generation CAS**（桌面端在两次读之间先刷了就让它赢，我们改用它的令牌）。
 *
 * 3. **没有动态模型目录**。`{llmBase}/models` 与 `/v1/models` 都是
 *    `503 direct_route_not_configured`，所以目录取客户端自己的 `~/.minimax/config.yaml`
 *    在 v3.1 时声明的那一份，写成快照。
 *
 * 协议要点：刷新打在 `account.minimax.{io,cn}/oauth2/token`（form-urlencoded），
 * 推理打在 `agent.minimax.{io,cn}/mavis/api/v1/llm/v1/messages`（**标准 Anthropic
 * Messages**，SSE 事件与 Claude 完全一致 ⇒ `../wire/anthropic.js` 整套复用）。
 * `thinking: {type:'adaptive'}` 上游接受，且与客户端自己的默认一致
 * （`thinking_config.default_value: 'true'`、`variants.thinking`），所以默认开着。
 * @module dsh-account-bridge/families/minimax
 */

import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { toAnthropicMessages, toAnthropicSystem, toAnthropicTools, translateAnthropicStream } from '../wire/anthropic.js'
import { assertApiReply } from '../wire/assert-reply.js'
import { diagnosticReporter } from '../wire/diagnostics.js'
import { httpError } from '../wire/http-error.js'
import { firstPositiveNumber, tryJson, withSource } from '../util.js'

export const CLIENT_ID = 'mcode-public'
export const SCOPE = 'agent.default'
export const AUDIENCE = 'agent-backend'
export const ANTHROPIC_VERSION = '2023-06-01'
/** 先国际、后国内：`cn` 只在没装国际版时才存在，顺序决定默认偏好。 */
export const REGIONS = ['en', 'cn']

const ACCOUNT_ORIGIN = { en: 'https://account.minimax.io', cn: 'https://account.minimax.cn' }
const LLM_BASE = { en: 'https://agent.minimax.io/mavis/api/v1/llm/v1', cn: 'https://agent.minimax.cn/mavis/api/v1/llm/v1' }
const QUOTA_ORIGIN = { en: 'https://api.minimax.io', cn: 'https://api.minimaxi.com' }

/** 提前 5 分钟刷新：与客户端自己的 `EARLY_MS` 一致。 */
const REFRESH_SKEW_MS = 5 * 60_000
const DEFAULT_MAX_TOKENS = 32_000
const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * 模型目录快照：取客户端 `~/.minimax/config.yaml` 里 `provider.minimax` 自己声明的那 4 条
 * （`limit.context` / `limit.output`）。上游没有目录接口，所以这是**快照不是发现**——
 * 客户端升级、上游上新模型时，这里要跟着改。
 */
export const MODELS = [
  { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 512_000, maxTokens: 128_000 },
  { id: 'MiniMax-M3.1-Flash-Preview', name: 'MiniMax M3.1 Flash (Preview)', contextWindow: 512_000, maxTokens: 128_000 },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 200_000, maxTokens: 128_000 },
  { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 (Highspeed)', contextWindow: 200_000, maxTokens: 128_000 },
]

/** 允许用 `MINIMAX_HOME` 覆盖（测试与便携安装用；桌面端自己只认 `~/.minimax`）。 */
export function minimaxHome() {
  const override = process.env.MINIMAX_HOME
  return override && override.length > 0 ? override : join(homedir(), '.minimax')
}

export function credentialPath(region) {
  return join(minimaxHome(), 'auth', 'prod', region, CLIENT_ID, 'auth.json')
}

export function statePath(region) {
  return join(minimaxHome(), 'auth', 'prod', region, CLIENT_ID, 'auth-state.json')
}

/**
 * 读一个 region 的登录态。
 *
 * 记录键里**含一个 NUL 字节**（`com.minimax.mcode.oauth.prod.en\u0000<随机串>`），
 * 所以只能整个 `records` 取第一个键，不能按名字拼——拼出来的键永远找不到。
 */
export async function readDesktop(region) {
  const path = credentialPath(region)
  let doc
  try {
    doc = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
  const records = doc?.records
  if (!records || typeof records !== 'object') return undefined
  const key = Object.keys(records)[0]
  const record = key ? records[key] : undefined
  if (typeof record?.accessToken !== 'string' || record.accessToken.length === 0) return undefined
  if (typeof record?.refreshToken !== 'string' || record.refreshToken.length === 0) return undefined
  if (!Number.isFinite(record?.expiresAtMs)) return undefined
  return {
    region,
    path,
    key,
    access: record.accessToken,
    refresh: record.refreshToken,
    expiresAt: record.expiresAtMs,
    generation: Number.isInteger(record.generation) ? record.generation : 0,
    // 稳定标识：`loginEpoch` 是桌面端每次登录生成的 UUID，重新登录才会换。
    // 统一发现的指纹需要它——没有的话只能退到会轮换的 refresh token 上，
    // 插件刷一次令牌就会把同一份登录态认成新账号（真机上多出过一个 `minimax-2`）。
    loginEpoch: typeof record.loginEpoch === 'string' && record.loginEpoch.length > 0 ? record.loginEpoch : undefined,
  }
}

/**
 * 原子写：同目录私有临时文件 → rename。
 * 与桌面端自己的写法一致（它也是这样写的，所以要跟它抢同一个文件就必须同样原子）。
 */
async function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await writeFile(tmp, text, { mode: 0o600 })
  try {
    await chmod(tmp, 0o600)
  } catch {
    // Windows 上 chmod 基本是空操作，不因为它在意的权限语义失败而中断写回。
  }
  await rename(tmp, path)
}

/**
 * 把刷新出来的令牌写回桌面端。
 *
 * **generation CAS**：重读文件，若 `generation` 已经不是我们读到的那一版，
 * 说明桌面端（或另一个进程）在这中间先刷了——我们手上这对令牌此时已经作废，
 * 写回去只会把它踢下线。这种情况**不写**，让调用方改用对方的令牌。
 * @returns {Promise<{ok: boolean, reason?: string, generation?: number}>}
 */
export async function writeBackDesktop(region, before, next) {
  const path = credentialPath(region)
  let doc
  try {
    doc = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const key = Object.keys(doc?.records ?? {})[0]
  const current = key ? doc.records[key] : undefined
  if (!current) return { ok: false, reason: 'gone' }
  if (current.generation !== before.generation) return { ok: false, reason: 'stale' }

  const generation = (Number.isInteger(current.generation) ? current.generation : 0) + 1
  doc.records[key] = {
    ...current,
    accessToken: next.access,
    refreshToken: next.refresh,
    expiresAtMs: next.expiresAt,
    generation,
  }
  await atomicWrite(path, `${JSON.stringify(doc, null, 2)}\n`)

  // auth-state.json 是桌面端的状态镜像。先写凭据再写状态；状态写失败只让它多刷一次，
  // 不影响令牌本身，所以吞掉。
  try {
    const state = tryJson(await readFile(statePath(region), 'utf8'))
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      state.status = 'authenticated'
      state.generation = generation
      state.expiresAtMs = next.expiresAt
      await atomicWrite(statePath(region), `${JSON.stringify(state, null, 2)}\n`)
    }
  } catch {
    // 凭据已经落盘，这就够了。
  }
  return { ok: true, generation }
}

/** 令牌响应 → 我们自己的 auth 形状。`region` 要带上，否则池子合并时会丢。 */
export function authFromGrant(grant, previous = {}) {
  const expiresIn = firstPositiveNumber(grant, ['expires_in', 'expiresIn'])
  return {
    access: grant.access_token ?? grant.accessToken,
    refresh: grant.refresh_token ?? grant.refreshToken ?? previous.refresh,
    expiresAt: expiresIn === undefined ? previous.expiresAt : Date.now() + expiresIn * 1000,
    region: previous.region ?? 'en',
    // generation 与 loginEpoch 跟着走：池子是**浅合并**（`{...current.auth, ...auth}`），
    // 这里不带上就会被旧值覆盖，写回时又退回「基准永远不匹配」的老毛病，
    // 统一发现的指纹也会跟着漂移。
    ...(previous.generation === undefined ? {} : { generation: previous.generation }),
    ...(previous.loginEpoch === undefined ? {} : { loginEpoch: previous.loginEpoch }),
  }
}

function modelInfo(id, name, entry, provider) {
  return {
    provider,
    id,
    name: name ?? id,
    context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    defaultMaxTokens: entry?.maxTokens ?? DEFAULT_MAX_TOKENS,
    toolUpdate: 'in-history',
    // 声明成 text+image：`toAnthropicMessages` 确实转发图片，视频不转发，所以不声明 video
    //（客户端 config 里写了 video，那是它自己的多模态面，不是我们能保证的）。
    inputModalities: ['text', 'image'],
  }
}

function catalogEntry(model) {
  return MODELS.find((entry) => entry.id === model)
}

function headers(auth) {
  return {
    authorization: `Bearer ${auth.access}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    accept: 'application/json',
  }
}

export const minimaxFamily = {
  id: 'minimax',
  displayName: 'MiniMax Code',
  route: 'acct-minimax',
  risk: 'low',

  // ---------------------------------------------------------------- 发现

  async discover() {
    const out = []
    for (const region of REGIONS) {
      const desktop = await readDesktop(region)
      if (!desktop) continue
      out.push({
        family: 'minimax',
        sourcePath: desktop.path,
        label: region === 'cn' ? 'MiniMax Code（国内）' : 'MiniMax Code（国际）',
        importable: true,
        externallyOwned: true,
        reason: '令牌与桌面端共用一份，刷新后会写回（带 generation 冲突检查）',
        auth: {
          access: desktop.access,
          refresh: desktop.refresh,
          expiresAt: desktop.expiresAt,
          region,
          // 稳定标识与版本号。`loginEpoch` 决定统一发现的指纹（见 `src/discover.js`），
          // 少了它，刷新一轮之后同一份登录态会被当成新账号再导一次。
          loginEpoch: desktop.loginEpoch,
          // 记下导入时桌面端文件的版本号。它不是写回时的 CAS 基准（那个要现读，
          // 见 `refresh`），只是让我们能判断「磁盘上是不是已经比我新了」。
          generation: desktop.generation,
        },
      })
    }
    return out
  },

  /** 见 codex 族同名方法的说明：统一发现的落盘入口。 */
  recordFromDiscovery(item) {
    return withSource({
      family: 'minimax',
      label: item.label ?? 'MiniMax Code',
      source: 'client-import',
      externallyOwned: true,
      auth: item.auth,
      createdAt: new Date().toISOString(),
    }, item)
  },

  // ---------------------------------------------------------------- 登录

  /**
   * 只有「从本机导入」一条路。
   *
   * MiniMax Code 的 OAuth 是它自己那套客户端流程（`client_id=mcode-public`、
   * `scope=agent.default`、`audience=agent-backend`），令牌落在它自己的文件里。
   * 我们不去复刻它的登录：复刻意味着要么让用户在我们的界面里走一个上游随时会变的流程，
   * 要么去解它的设备码——而用户机器上十有八九**已经登录过了**。
   * 所以这里只做「探测 + 导入」，登录本身请在 MiniMax Code 里做。
   */
  login: {
    methods: [{ id: 'import', label: '导入本机 MiniMax Code 登录' }],
    async run(session, ctx) {
      let desktop
      for (const region of REGIONS) {
        desktop = await readDesktop(region)
        if (desktop) break
      }
      if (!desktop) {
        throw new Error(
          '没有找到 MiniMax Code 的登录态。请先安装 MiniMax Code 并在里面登录一次'
            + `（国际版凭据在 ${credentialPath('en')}，国内版在 ${credentialPath('cn')}），再回来导入。`,
        )
      }
      await session.commit({
        kind: 'grant',
        payload: {
          family: 'minimax',
          label: desktop.region === 'cn' ? 'MiniMax Code（国内）' : 'MiniMax Code（国际）',
          source: 'client-import',
          externallyOwned: true,
          auth: {
            access: desktop.access,
            refresh: desktop.refresh,
            expiresAt: desktop.expiresAt,
            region: desktop.region,
            loginEpoch: desktop.loginEpoch,
            generation: desktop.generation,
          },
          createdAt: new Date().toISOString(),
        },
      })
      ctx.log?.info?.('account-bridge: imported MiniMax Code account (%s)', desktop.region)
    },
  },

  // ---------------------------------------------------------------- 凭据

  async refresh(ctx, payload, signal) {
    const auth = payload.auth ?? {}
    const region = REGIONS.includes(auth.region) ? auth.region : 'en'

    // 写回的 CAS 基准必须是**这次刷新之前那一刻**从磁盘读到的 generation，
    // 不能用导入时存下来的那个。桌面端每次启动都会自己刷一次，generation 早就走远了，
    // 拿导入时的旧值去比永远不相等 ⇒ 永远不写回 ⇒ 我们在服务端轮换掉的那对令牌
    // 在桌面端就成了死令牌，用户下次打开 MiniMax Code 直接被要求重新登录。
    // 顺带这也让「磁盘上更新」自愈：磁盘上是哪条刷新令牌血统，就用哪条。
    const desktop = payload.externallyOwned === true ? await readDesktop(region) : undefined

    // **读不到桌面端凭据就不许刷。**
    // MiniMax 的 refresh token 是一次性的：一旦我们拿着它换出新令牌，旧的那条服务端
    // 立刻作废（实测 `invalid_grant: this refresh token can no longer be used`）。
    // 此时如果写不回去，桌面端就被我们单方面踢下线了——这是本插件能造成的最大破坏，
    // 而且不可逆。真机上已经发生过一次（开发期的写回 bug，桌面端被迫重新登录）。
    // 所以宁可报错也不刷：让用户先打开 MiniMax Code 让它自己刷一轮（它会写回），
    // 再回来重新导入，两边就重新对齐了。
    if (payload.externallyOwned === true && !desktop) {
      const error = new Error(
        `minimax: 读不到桌面端凭据（${credentialPath(region)}），拒绝刷新。` +
          'MiniMax 的刷新令牌是一次性的，刷新会让桌面端那份作废而无法写回。' +
          '请先打开 MiniMax Code 让它自己刷新一次，再重新导入。',
      )
      error.code = 'AUTH'
      throw error
    }

    const refreshToken = desktop?.refresh ?? auth.refresh

    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      const error = new Error('minimax: account has no refresh token; sign in with MiniMax Code again')
      error.code = 'AUTH'
      throw error
    }
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPE,
      audience: AUDIENCE,
    })
    const response = await ctx.fetch(
      `${ACCOUNT_ORIGIN[region]}/oauth2/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        signal,
      },
      payload.proxy,
    )
    const text = await response.text()
    if (!response.ok) throw httpError(response, text, 'minimax')
    const grant = tryJson(text)
    if (!grant?.access_token) {
      const error = new Error('minimax token refresh returned no access_token')
      error.code = 'AUTH'
      throw error
    }
    const next = authFromGrant(grant, auth)

    // 只在账号确实是从桌面端导入的（externallyOwned）才写回；纯粹插件内登录的账号
    // 在桌面端没有对应文件，写回没有意义。
    if (desktop) {
      try {
        const result = await writeBackDesktop(region, desktop, next)
        if (result.ok) {
          next.generation = result.generation
          ctx.log?.debug?.('account-bridge: minimax wrote refreshed token back (%s)', region)
        } else {
          // `stale` 现在只可能是「桌面端在我们这一来一回的几百毫秒里也刷了一次」——
          // 那是真竞争，双方的令牌都刚轮换过，我们让位，不去覆盖对方。
          ctx.log?.warn?.('account-bridge: minimax did not write back (%s); the desktop app may need a fresh sign-in', result.reason)
        }
      } catch (error) {
        // 写回失败不能连累这次刷新：我们手上已经是可用的新令牌了。
        ctx.log?.warn?.('account-bridge: minimax write-back failed: %s', error?.message ?? error)
      }
    }
    return next
  },

  needsRefresh(payload, now = Date.now()) {
    const expiresAt = payload.auth?.expiresAt
    if (typeof expiresAt !== 'number') return false
    return expiresAt - REFRESH_SKEW_MS <= now
  },

  // ---------------------------------------------------------------- 目录

  /**
   * 上游没有目录接口（`503 direct_route_not_configured`），所以直接给快照。
   * 不发那次注定失败的请求——那不是「探测」是浪费一次往返。
   */
  async listModels() {
    return MODELS.map((entry) => modelInfo(entry.id, entry.name, entry))
  },

  resolveModel(provider, model) {
    return modelInfo(model, catalogEntry(model)?.name ?? model, catalogEntry(model), provider)
  },

  // ---------------------------------------------------------------- 额度

  /**
   * Token Plan 用量。**这一条在本机没有验证过**：本机账号没有 Token Plan，
   * 该端点回的是 `200 {"base_resp":{"status_code":0}}`——成功但没有数据字段。
   * 所以这里只认真正读到的百分比，读不到就返回 `undefined`（面板不显示），
   * **绝不编一个 0%**：那会让人以为额度满了。
   *
   * 注意这是 `api.minimax.{io,cn}/backend/...`（桌面端那条路），不是订阅 Key 的
   * `www.minimax.io/v1/token_plan/remains`（那个只认 `sk-cp-…`，见文件头）。
   */
  async quota(ctx, payload, signal) {
    const region = REGIONS.includes(payload.auth?.region) ? payload.auth.region : 'en'
    const response = await ctx.fetch(
      `${QUOTA_ORIGIN[region]}/backend/account/token_plan/remains_percent`,
      { headers: { authorization: `Bearer ${payload.auth?.access}`, accept: 'application/json' }, signal },
      payload.proxy,
    )
    if (!response.ok) return undefined
    const json = await response.json().catch(() => undefined)
    const data = json?.data ?? json
    const weekly = firstPositiveNumber(data, ['current_weekly_used_percent', 'weekly_used_percent'])
    if (weekly === undefined) return undefined
    return [
      {
        id: 'weekly',
        name: '周窗口',
        remainingFraction: Math.max(0, 1 - weekly / 100),
      },
    ]
  },

  // ---------------------------------------------------------------- 调用

  async *stream(ctx, options) {
    const { payload, model, messages, tools, system, maxTokens, signal } = options
    const auth = payload.auth ?? {}
    const region = REGIONS.includes(auth.region) ? auth.region : 'en'
    const limit = Math.max(1_024, Number(maxTokens) || 0 || catalogEntry(model)?.maxTokens || DEFAULT_MAX_TOKENS)
    const body = {
      model,
      max_tokens: limit,
      system: toAnthropicSystem(system, messages),
      messages: toAnthropicMessages(messages),
      stream: true,
      // 与客户端自己的 default_value: 'true' 一致。上游实测接受 adaptive，
      // 也接受 enabled+budget_tokens；两种都会回 thinking 块，而
      // `translateAnthropicStream` 已经把 thinking_delta 映射成 reasoning-delta。
      thinking: { type: 'adaptive' },
      ...(tools?.length ? { tools: toAnthropicTools(tools), tool_choice: { type: 'auto' } } : {}),
    }
    const response = await ctx.fetch(
      `${LLM_BASE[region]}/messages`,
      { method: 'POST', headers: headers(auth), body: JSON.stringify(body), signal },
      payload.proxy,
      true,
    )
    // 200 也可能是网页（Cloudflare 挑战页、登录页、空 body）：先确认它像 API 回复。
    const reply = await assertApiReply(response, { who: 'minimax' })
    if (!reply.ok) {
      const text = await reply.text().catch(() => '')
      throw httpError(reply, text, 'minimax')
    }
    yield* translateAnthropicStream(reply, { signal, onDiagnostic: diagnosticReporter(ctx, options.onDiagnostic) })
  },
}
