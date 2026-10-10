/**
 * 端到端验收探针——**跑在真宿主里面**。
 *
 * 为什么必须跑在宿主里：本插件是进程内适配器，它到底有没有被宿主认成一个 provider、
 * 宿主的 `llm.stream()` 拿到的是什么、换号之后调用方看见的是哪一段——这些只在真宿主里
 * 才有答案。单测能证明函数是对的，证明不了「接上去是对的」，而后者才是这个插件存在的意义。
 *
 * 编排方式见 `test/e2e/harness.mjs`：编排器起假上游（`mock-upstream.mjs`）→ 起无头宿主 →
 * 本探针在宿主里跑完全部检查 → 把结果写成一份 JSON 落到 `BRIDGE_E2E_OUT` → 编排器读它断言。
 *
 * 三条宿主契约（都是踩出来的，写在这里免得下次又踩）：
 * 1. `ctx.inject([...], cb)` 的回调里抛出去是**静默的**：探针会一声不响地停在半路。
 *    所以整段必须包 try/catch，并且**无论如何都要落盘一份报告**。
 * 2. 适配器抛的错，宿主**不会**转给调用方，而是变成一个 `{type:'finish', reason:{kind:'error',
 *    failure:{...}}}` 块。判断一次推理成没成，要看这个块，不是看有没有 throw。
 * 3. `llm.listProviders()` 等方法的返回值**不一定是 promise**（可能同步返回数组），
 *    对返回值直接 `.catch()` 会抛 TypeError。
 */

import { writeFileSync } from 'node:fs'

const OUT = process.env.BRIDGE_E2E_OUT
const BASE = process.env.BRIDGE_MOCK_BASE
const KEY = process.env.BRIDGE_MOCK_KEY
const ROUTES = [
  'acct-codex',
  'acct-claude',
  'acct-agy',
  'acct-minimax',
  'acct-qoder',
  'acct-workbuddy',
  'acct-commandcode',
  'acct-grok',
  'acct-copilot',
  'acct-trae',
  'acct-generic',
]

const checks = []
const log = []

/** 记一条检查。`detail` 只在失败时给人看，所以它要比 name 具体得多。 */
function check(name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail: String(detail ?? '').slice(0, 800) })
  console.log(`[e2e] ${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` — ${detail}`}`)
  return pass
}

function say(...parts) {
  const line = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
  log.push(line)
  console.log('[e2e]', line)
}

function flush(error) {
  if (!OUT) return
  const report = { ok: !error && checks.length > 0 && checks.every((entry) => entry.pass), error: error ? String(error.stack ?? error) : null, checks, log }
  try {
    writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
  } catch (writeError) {
    console.log('[e2e] !! 报告写不出去 =', writeError?.message)
  }
}

export function apply(ctx) {
  ctx.inject(['tools', 'llm'], async (probeCtx) => {
    // 全局兜底：探针卡住时也要留一份报告，否则编排器只能等到超时，什么都不知道。
    const deadline = setTimeout(() => {
      check('探针在 180 秒内跑完', false, '超时——报告是半截的，看 log 停在哪一步')
      flush(new Error('probe timed out'))
    }, 180_000)
    deadline.unref?.()
    try {
      await run(probeCtx)
    } catch (error) {
      check('探针本身没有抛错', false, `${error?.code ?? ''} ${error?.message ?? error}`)
      flush(error)
    } finally {
      clearTimeout(deadline)
      flush(null)
    }
  })

  async function run(probeCtx) {
    // 宿主启动后要几秒才把所有服务接好；这段时间里 `llm.listProviders()` 可能还是空的。
    await new Promise((resolve) => setTimeout(resolve, 12_000))

    if (!BASE) {
      check('编排器给了假上游地址（BRIDGE_MOCK_BASE）', false, '没有这个环境变量就只能跳过，不能算通过')
      return
    }

    const tool = (name) => probeCtx.tools.get?.(name) ?? null
    const llm = probeCtx.llm
    const safe = async (fn, what) => {
      try {
        return await fn()
      } catch (error) {
        return `FAILED ${what}: ${error?.code ?? ''} ${error?.message ?? error}`
      }
    }

    // ------------------------------------------------------------------ 工具面
    const WANTED_TOOLS = [
      'account_bridge_accounts',
      'account_bridge_login',
      'account_bridge_accounts_remove',
      'account_bridge_limits',
      'account_bridge_add_endpoint',
      'account_bridge_discover',
    ]
    const missing = WANTED_TOOLS.filter((name) => !tool(name))
    check('六个 account_bridge_* 工具全部注册', missing.length === 0, `缺 ${missing.join(', ')}`)

    // ------------------------------------------------------------------ provider 面
    const providers = (await safe(() => llm.listProviders(), 'listProviders')) ?? []
    const rows = Array.isArray(providers) ? providers : []
    const byId = new Map(rows.map((row) => [row.id ?? row.provider, row]))
    const absent = ROUTES.filter((route) => !byId.has(route))
    check('十一条 acct-* route 全部注册成 provider', absent.length === 0, `缺 ${absent.join(', ')}；实际 ${[...byId.keys()].join(', ')}`)
    const named = ROUTES.filter((route) => byId.get(route)?.name)
    check('每条 route 都带显示名', named.length === ROUTES.length, `没有名字的：${ROUTES.filter((r) => !byId.get(r)?.name).join(', ')}`)

    // 每个族的模型元数据都必须是宿主能吃下去的形状：contextWindow 为正整数、id 回显一致。
    const badMeta = []
    for (const route of ROUTES) {
      if (!byId.has(route)) continue
      const info = await safe(() => llm.resolveModelInfo(route, 'e2e-probe-model'), `resolveModelInfo(${route})`)
      if (typeof info === 'string') {
        badMeta.push(`${route}: ${info}`)
        continue
      }
      const window = info?.context?.contextWindow
      if (!Number.isInteger(window) || window <= 0) badMeta.push(`${route}: contextWindow=${JSON.stringify(window)}`)
      if (info?.id !== 'e2e-probe-model' || info?.provider !== route) badMeta.push(`${route}: 回显不对 ${JSON.stringify({ id: info?.id, provider: info?.provider })}`)
    }
    check('十一个族的模型元数据都是宿主能吃的形状', badMeta.length === 0, badMeta.join(' | '))

    // ------------------------------------------------------------------ 回环数据面
    const api = async (action, body = {}) => {
      const response = await fetch(`http://127.0.0.1:3080/account-bridge/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const envelope = await response.json()
      if (!envelope?.ok) throw new Error(`${action}: ${envelope?.error?.code} ${envelope?.error?.message}`)
      return envelope.value
    }

    // 上一轮留下的账号先清掉：E2E 必须能在同一个 profile 上反复跑。
    const state0 = await safe(() => api('state'), 'state')
    const leftovers = (state0?.families ?? [])
      .flatMap((family) => family.accounts ?? [])
      .filter((account) => String(account.label ?? '').startsWith('e2e-'))
    const remove = tool('account_bridge_accounts_remove')
    for (const account of leftovers) await safe(() => remove.execute({ account: account.id }), `remove(${account.id})`)
    say(`清掉上一轮账号 ${leftovers.length} 个`)

    // ------------------------------------------------------------------ 建账号
    const add = tool('account_bridge_add_endpoint')
    if (!add) {
      check('account_bridge_add_endpoint 可用', false, '没注册就没法建账号，后面的检查全部无法进行')
      return
    }
    const added = []
    const addOne = async (args, label) => {
      const text = String(await add.execute(args))
      const id = /`([a-z][a-z0-9-]*)`/.exec(text)?.[1]
      if (id) added.push(id)
      say(`add_endpoint(${label}) = ${text.split('\n')[0]}`)
      return id
    }
    await addOne({ baseUrl: `${BASE}/v1`, apiKey: KEY, label: 'e2e-a' }, 'e2e-a')
    await addOne({ baseUrl: `${BASE}/v1`, apiKey: KEY, label: 'e2e-b' }, 'e2e-b')
    await addOne({ baseUrl: `${BASE}/anthropic`, apiKey: KEY, label: 'e2e-anthropic', protocol: 'anthropic', models: 'declared-only:64000' }, 'e2e-anthropic')
    // 第四个账号是给「换号」那条检查准备的：`claude-mock-hold` 只有 Anthropic 方言这条路能走
    // （OpenAI 那条路会被假上游的 `stream_options` 检查挡在 400），所以至少要有两个能走通它的账号，
    // 否则换号无处可换，检查会错误地失败。
    await addOne({ baseUrl: `${BASE}/anthropic`, apiKey: KEY, label: 'e2e-anthropic-b', protocol: 'anthropic' }, 'e2e-anthropic-b')
    check('四个账号建出来了', added.length === 4, `只建出 ${added.length} 个：${added.join(', ')}`)

    // ------------------------------------------------------------------ 目录
    const models = await safe(() => llm.listModels('acct-generic'), 'listModels')
    const ids = Array.isArray(models) ? models.map((model) => model.id) : []
    check('generic 目录里有假上游的模型', ['mock-alpha', 'mock-beta'].every((id) => ids.includes(id)), `实际 ${ids.join(', ')}`)
    check('只出图的模型没有进选择器', !ids.includes('mock-image-only'), `目录里有 mock-image-only：${ids.join(', ')}`)
    check('声明式目录里的模型也在', ids.includes('declared-only'), `目录里没有 declared-only：${ids.join(', ')}`)

    // ------------------------------------------------------------------ 真机推理
    /**
     * 跑一次真推理，把「收到什么」和「怎么结束的」都带回来。
     *
     * 会话 id 决定粘性（`#conversationId()` 读第一条 user 消息的 `id`），所以每类检查用
     * 不同的 id：不然它们会挤在同一个账号上，测不出「换号」这件事。
     */
    const infer = async (model, conversation, prompt = 'Reply with exactly: PONG') => {
      const chunks = []
      try {
        for await (const chunk of llm.stream({
          provider: 'acct-generic',
          model,
          maxTokens: 64,
          messages: [{ id: conversation, role: 'user', content: [{ type: 'text', text: prompt }] }],
        })) {
          chunks.push(chunk)
          if (chunks.length >= 400) break
        }
      } catch (error) {
        return { threw: `${error?.code ?? ''} ${error?.message ?? error}`, types: chunks.map((chunk) => chunk.type) }
      }
      const finish = chunks.find((chunk) => chunk.type === 'finish')
      const text = chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.text ?? '')
        .join('')
      return {
        kind: finish?.reason?.kind ?? null,
        failure: finish?.reason?.failure ?? null,
        text,
        reasoning: chunks.filter((chunk) => chunk.type === 'reasoning-delta').length,
        types: chunks.map((chunk) => chunk.type),
      }
    }

    const alpha = await infer('mock-alpha', 'e2e-openai')
    check('真机推理（OpenAI 方言）回 PONG', alpha.text === 'PONG' && alpha.kind === 'stop', JSON.stringify(alpha))

    const declared = await infer('declared-only', 'e2e-anthropic')
    check('真机推理（Anthropic 方言 + 声明式目录）回 PONG', declared.text === 'PONG' && declared.kind === 'stop', JSON.stringify(declared))

    // 换号：假上游对这个模型**第一次**先吐 20 个思考块再报错，第二个账号才答得出。
    // 这一条同时验两件事：换号真的发生了，以及失败那次的思考**一个都没泄漏**给调用方。
    const hold = await infer('claude-mock-hold', 'e2e-hold')
    check('思考不算输出：第一个账号失败后换号答出 PONG', hold.text === 'PONG' && hold.kind === 'stop', JSON.stringify(hold))
    check('失败那次的思考没有泄漏给调用方', hold.reasoning === 0, `收到 ${hold.reasoning} 个 reasoning-delta：${JSON.stringify(hold)}`)

    // 两条通道说同一句话：屏幕上写的码必须与池子怎么处理这个账号一致。
    const credit = await infer('mock-credit', 'e2e-credit')
    check('「余额不足」归类为 ACCOUNT_QUOTA', credit.failure?.code === 'ACCOUNT_QUOTA', JSON.stringify(credit))

    const week = await infer('mock-429-week', 'e2e-week')
    check('上游说「一周后再来」时归类为 RATE_LIMIT，而不是额度用尽', week.failure?.code === 'RATE_LIMIT', JSON.stringify(week))

    // ------------------------------------------------------------------ 数据面与诊断面
    const state = await safe(() => api('state'), 'state')
    const stateText = JSON.stringify(state ?? null)
    check('回环 state 不外传凭据', !stateText.includes(KEY), 'state 的 JSON 里出现了假上游的密钥')
    check('state 里有十一个族', (state?.families ?? []).length === ROUTES.length, `实际 ${(state?.families ?? []).length} 个`)

    const diagnostics = await safe(() => api('diagnostics'), 'diagnostics')
    check('诊断面可用', typeof diagnostics?.requests === 'number', JSON.stringify(diagnostics)?.slice(0, 200))

    // 账号级冷却必须能看见：上面已经制造过失败，池子应该记了点什么。
    const accounts = (state?.families ?? []).flatMap((family) => family.accounts ?? [])
    const e2eAccounts = accounts.filter((account) => String(account.label ?? '').startsWith('e2e-'))
    check('四个 e2e 账号都在池子里', e2eAccounts.length === 4, `实际 ${e2eAccounts.map((a) => a.label).join(', ')}`)
    check('账号行带状态字段', e2eAccounts.every((account) => typeof account.status === 'string'), JSON.stringify(e2eAccounts.map((a) => ({ id: a.id, status: a.status }))))
  }
}
