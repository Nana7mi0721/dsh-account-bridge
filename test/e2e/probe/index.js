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
  'acct-codebuddy',
  'acct-commandcode',
  'acct-grok',
  'acct-copilot',
  'acct-trae',
  'acct-zcode',
  'acct-raccoon',
  'acct-codearts',
  'acct-opencode',
  'acct-generic',
]

const checks = []
const log = []

/** 1×1 的透明 PNG：够让翻译层把它变成 data URL，又不占地方。 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * 一次「什么都带上」的调用：system、工具、图片、工具结果、上一轮的工具调用。
 *
 * 图片块由调用方给：宿主的正典形状是 `{ type:'image', attachment:{…} }`（图片存在附件库里，
 * 由 `attachments` 服务落盘），而不是把 base64 塞进消息里。`image` 参数让探针两种都能试。
 *
 * 助手轮必须带 `source`（`AssistantMessage.source: ModelMessageSource`，即
 * `{ kind:'model', provider, model }`）：宿主给适配器做投影时会读 `source.replayState`，
 * 缺了整块就在 `Cannot read properties of undefined (reading 'replayState')` 上炸掉，
 * 请求连发都发不出去。
 */
function richCall(marker, image, model) {
  return {
    system: 'You are a mock assistant. Answer in one word.',
    maxTokens: 128,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'which file' } },
          required: ['path'],
        },
      },
    ],
    messages: [
      {
        id: `e2e-${marker}`,
        role: 'user',
        content: [
          { type: 'text', text: `${marker} look at this picture` },
          image ?? { type: 'image', mediaType: 'image/png', data: TINY_PNG },
        ],
      },
      {
        id: `e2e-${marker}-a1`,
        role: 'assistant',
        source: { kind: 'model', provider: 'acct-generic', model },
        content: [
          { type: 'text', text: 'let me look' },
          {
            type: 'tool-call',
            id: 'call_prev_1',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'README.md' }),
          },
        ],
      },
      {
        id: `e2e-${marker}-t1`,
        role: 'tool',
        toolCallId: 'call_prev_1',
        content: [{ type: 'text', text: 'TOOL-RESULT-BODY' }],
      },
      { id: `e2e-${marker}-u2`, role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ],
  }
}

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
    check(`${ROUTES.length} 条 acct-* route 全部注册成 provider`, absent.length === 0, `缺 ${absent.join(', ')}；实际 ${[...byId.keys()].join(', ')}`)
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
    check(`${ROUTES.length} 个族的模型元数据都是宿主能吃的形状`, badMeta.length === 0, badMeta.join(' | '))

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

    // 「现在池子里每个 e2e 号被停了多久」。
    //
    // 为什么必须**在失败刚发生时**读，而不是等一整轮跑完再读：池子在每次成功之后都会调
    // `src/health.js` 的 `clear()`，而它把这个账号的成员键与账号键**一起删掉**
    // （`src/health.js:280-284`）。探针在一笔失败后面还有十几笔会成功的请求，四个号轮流
    // 被答中 ⇒ 冷却被逐个擦干净，最后读 state 时全表都是 `reason: null, minutes: 0`：
    // 断言照样绿，实际什么都没验（第一版就是这样白跑了两轮，反向验证才发现）。
    const restsNow = async (why) => {
      const snapshot = await safe(() => api('state'), `state(${why})`)
      return (snapshot?.families ?? [])
        .flatMap((family) => family.accounts ?? [])
        .filter((account) => String(account.label ?? '').startsWith('e2e-'))
        .map((account) => ({
          label: account.label,
          reason: account.cooldown?.reason ?? null,
          minutes: account.cooldown?.until ? Math.round((account.cooldown.until - Date.now()) / 60_000) : 0,
        }))
    }

    // 上一轮留下的账号先清掉：E2E 必须能在同一个 profile 上反复跑，而且**池里只能有
    // 这一轮建的这四个号**。只清 `e2e-` 前缀是不够的——早几轮建的号会留在 `generic` 池里，
    // 于是「这一笔失败落在谁头上」「某个账号被停了多久」这类断言会落到别的号上：
    // 检查照样绿，实际上什么都没验（第一版就是这样，白跑了一轮）。
    const state0 = await safe(() => api('state'), 'state')
    const leftovers = (state0?.families ?? [])
      .filter((family) => family.family === 'generic')
      .flatMap((family) => family.accounts ?? [])
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

    // ------------------------------------------------------------ 附件库里的那张图
    /**
     * 宿主正典的图片块是 `{ type:'image', attachment:{ attachmentId:'sha256:…', … } }`
     * （`ImageBlock` 的定义里没有 `data`）。图片得先经 `attachments` 服务落盘才拿到引用，
     * 所以这里存一张 1×1 的透明 PNG，两个方言的形状检查都用它。
     */
    const attachments = probeCtx.get?.('attachments')
    let tinyRef = null
    let tinyRefError = null
    try {
      tinyRef = await attachments?.saveImage?.({
        data: new Uint8Array(Buffer.from(TINY_PNG, 'base64')),
        mediaType: 'image/png',
        name: 'e2e-tiny.png',
      })
    } catch (error) {
      tinyRefError = `${error?.code ?? ''} ${error?.message ?? error}`
    }
    say('附件库 =', tinyRef ? JSON.stringify(tinyRef) : `没拿到引用（${tinyRefError ?? '没有 attachments 服务'}）`)
    const tinyImage = tinyRef ? { type: 'image', attachment: tinyRef } : undefined

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
    const infer = async (model, conversation, prompt = 'Reply with exactly: PONG', extra = {}) => {
      const chunks = []
      try {
        for await (const chunk of llm.stream({
          provider: 'acct-generic',
          model,
          maxTokens: 64,
          ...extra,
          messages: extra.messages ?? [{ id: conversation, role: 'user', content: [{ type: 'text', text: prompt }] }],
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
      const usages = chunks.filter((chunk) => chunk.type === 'usage')
      return {
        kind: finish?.reason?.kind ?? null,
        failure: finish?.reason?.failure ?? null,
        text,
        reasoning: chunks.filter((chunk) => chunk.type === 'reasoning-delta').length,
        types: chunks.map((chunk) => chunk.type),
        // 下面几项是「翻译回显」那一组要的：块、工具增量、用量、上游给的回放状态。
        blocks: chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
        deltas: chunks
          .filter((chunk) => chunk.type === 'tool-call-delta')
          .map((chunk) => ({ index: chunk.index, id: chunk.id, name: chunk.name, argumentsDelta: chunk.argumentsDelta })),
        usage: usages.length > 0 ? usages[usages.length - 1].usage : null,
        replayState: finish?.replayState ?? null,
      }
    }

    /**
     * 发一笔请求，再把它在假上游留下的**原文**取回来。
     *
     * 为什么非看原文不可：宿主侧的结果（`PONG`、`tool-calls`）证明不了「我们发出去的是什么」。
     * 删掉单元测试时丢掉的那半覆盖正是这个——旧 golden 快照拍的就是请求与流两层，
     * 现在由假上游记原文来替。
     *
     * 标记（`TRACE-…`）必须是唯一的：同一时间宿主自己也在发请求（目录刷新），
     * 按标记找比按下标找稳。`sent` 是「最近一笔带我标记的请求」。
     */
    const trace = async (model, marker, extra) => {
      await safe(() => fetch(`${BASE}/__requests`, { method: 'DELETE' }), 'clear requests')
      const result = await infer(model, `e2e-${marker}`, marker, extra)
      const listed = await safe(() => fetch(`${BASE}/__requests`).then((r) => r.json()), 'requests')
      const all = Array.isArray(listed?.requests) ? listed.requests : []
      const mine = all.filter((entry) => JSON.stringify(entry.body ?? null).includes(marker))
      return { ...result, sent: mine[mine.length - 1] ?? null, matched: mine.length, seen: all.length }
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

    // 毫秒退避的两个头：`retry-after-ms` 里写的**不是数**（网关写 `soon` 是常事），
    // 真数字在旁边那个 `x-retry-after-ms` 里。这条守的是 `src/wire/http-error.js` 的
    // `retryAfterMs()`：早期实现用 `??` 串两个头，只看「有没有这个头」不看「它有没有
    // 写出一个数」⇒ 整条毫秒路返回 undefined，上游说的 15 分钟被丢掉（表现为池子
    // 只按自己的默认退避等，用户会看到同一个账号被反复试）。
    // 断言 `providerRetryAfterMs` 是那个 900000：不是 undefined，也不是我们编的默认值。
    const ms = await infer('mock-429-ms', 'e2e-ms')
    check(
      '毫秒退避：`retry-after-ms` 不是数字时看旁边那个 `x-retry-after-ms`',
      ms.failure?.code === 'RATE_LIMIT' && ms.failure?.providerRetryAfterMs === 900000,
      JSON.stringify(ms),
    )

    // 同一个 403，正文说「余额不足」。旧行为是「403 一律 AUTH」⇒ 停号 **24 小时**、
    // 宿主还把它显示成「API 密钥无效」；而 AUTH 与额度类的差别就是 24 小时与 30 分钟。
    // 停号时长那半条在下面读 state 时一起断言（`为什么` 与 `停多久` 必须同时改对）。
    const forbidden = await infer('mock-403-credit', 'e2e-403')
    check('403 说「余额不足」时归类为 ACCOUNT_QUOTA，而不是 AUTH', forbidden.failure?.code === 'ACCOUNT_QUOTA', JSON.stringify(forbidden))

    // 同一个 403，但报文体里**一个钱字都没有**，只有一个结构字段 `pricingUrl`
    // （Qoder 国内版实测原样）。认不出来它就会被当成服务器故障白退避——另一个插件
    // 就是这么丢了换号的（issue IKKJFH）。这条验的是共享词表的那条「文案腿」。
    const paywall = await infer('mock-paywall', 'e2e-paywall')
    check('上游只给一个定价页链接时也算额度，不是「服务器故障」', paywall.failure?.code === 'QUOTA', JSON.stringify(paywall))

    // J2：**每个账号都回同一个 401**。认证类在我们这里停 24 小时
    // （`COOLDOWN.auth`），是最贵的一档；而「一个账号这么说」与「每个账号都这么说」
    // 是两件事——后者通常说明问题在这次请求（或者出口 IP），不是账号。magpie 的
    // `LESSONS.md` 第 4 条就是拿「把所有账号一起 rest 了 5 天」换来的。
    // 判据与它一样：这一轮 ≥2 个账号都回 AUTH，且没有任何账号回过别的东西
    // ⇒ 一个也不罚。停号那半条在下面读 state 时一起断言。
    // 这两条必须**当场**断言（上面刚失败、下面还有十几笔会成功的请求）：
    // 池子在每次成功之后都会调 `src/health.js` 的 `clear()`，而它把这个账号的冷却整条删掉
    // ⇒ 等到最后再读 state，全表都是「没有冷却」：断言照样绿，实际什么都没验。
    // 一小时的界限很宽：额度 30 分钟、限流 1 分钟、退避上限 30 分钟都过得去，24 小时过不去。
    const afterBilling = await restsNow('after the billing failures')
    check('那笔 403 没有把账号停掉一整天', afterBilling.every((row) => row.minutes <= 60), JSON.stringify(afterBilling))
    // 上一条有个前提：**冷却真的被记上了**。如果它读到的永远是空的（第一版就是这样，
    // 因为 state 那时根本不报冷却），`every(...)` 会在空表上恒真——先证明尺子是准的。
    check('额度/欠费的冷却确实记到了账号上', afterBilling.some((row) => row.minutes > 0), JSON.stringify(afterBilling))

    const everyAuth = await infer('mock-401-all', 'e2e-401-all')
    check('401 从每个账号来：宿主看到的仍是 AUTH', everyAuth.failure?.code === 'AUTH', JSON.stringify(everyAuth))

    // J2 的另一半：上面那笔 401 **每个账号都回了**，所以一个都不该被停。
    // 这一条改坏了会很贵且很安静：`COOLDOWN.auth` 是 24 小时，而「每个账号都这么说」
    // 在真机上最常见的成因是出口或网关，不是每个令牌同时作废。
    const afterAuth = await restsNow('after the 401')
    check(
      '401 从每个账号来时，一个也没被停（「每个账号都这么说」不是账号的事）',
      afterAuth.every((row) => row.minutes <= 60),
      JSON.stringify(afterAuth),
    )

    // ------------------------------------------------------------------ 翻译回显
    // 这一组补的是删掉单元测试时丢掉的那半覆盖：**我们发出去的是什么**，以及
    // **上游给的东西有没有变成宿主认识的样子**。以前由 golden 快照守着
    // （请求层的 `dsh_to_*.json` 与流层的 `*_to_dsh.json`），现在由假上游记原文来替。

    // 一次工具调用：`arguments` 被拆成三片发过来，宿主拿到的必须是**拼好的 JSON 字符串**，
    // 而且收尾必须说 `tool-calls`——说 `stop` 宿主会以为模型把话说完了，其实它在等工具结果。
    const toolCall = await infer('mock-tool-call', 'e2e-toolcall')
    const toolBlock = (toolCall.blocks ?? []).find((block) => block?.type === 'tool-call')
    let parsedArgs = null
    try {
      parsedArgs = JSON.parse(toolBlock?.arguments ?? 'null')
    } catch {
      parsedArgs = null
    }
    check(
      '翻译回显：一次工具调用拼成了 JSON 字符串，收尾说 tool-calls',
      toolCall.kind === 'tool-calls' && toolBlock?.name === 'read_file' && parsedArgs?.path === 'src/index.js',
      JSON.stringify({ kind: toolCall.kind, blocks: toolCall.blocks, deltas: toolCall.deltas }),
    )

    // 先报 4242 个输入 token，再用一帧**零**去覆盖它。零是「这一帧没说」，不是「用量是 0」。
    const usageZero = await infer('mock-usage-zero', 'e2e-usage')
    check(
      '翻译回显：零值不会擦掉已经读到的用量',
      usageZero.text === 'PONG' && usageZero.usage?.inputTokens === 4242,
      JSON.stringify({ text: usageZero.text, usage: usageZero.usage }),
    )

    // `length`（OpenAI）与 `pause_turn`（Anthropic）都表示「没说完」。宿主只认三个 kind，
    // 两个方言的说法都要落成 `max-tokens`，谁都不许把它当成正常结束。
    const cut = await infer('mock-cut-short', 'e2e-cut')
    check('翻译回显：被上游截断的一轮不是正常结束', cut.kind === 'max-tokens', JSON.stringify(cut))

    // 签名：上游**分两片**发过来。这个模型只挂在 Anthropic 那条路的目录里，
    // 所以这一笔一定走 `thinking` 块 + `signature_delta`，不会因为池子挑到别的账号而变。
    const signed = await infer('mock-signed-thinking', 'e2e-signed')
    const envelope = JSON.stringify(signed.replayState ?? null)
    check(
      '翻译回显：上游给的思考签名一个字符都不丢',
      signed.text === 'PONG' && signed.reasoning > 0 && envelope.includes('mock-signature-0123456789abcdef'),
      JSON.stringify({ text: signed.text, reasoning: signed.reasoning, replayState: signed.replayState }),
    )

    // 默认不回放：历史里带着签名的思考块，**下一轮不该原样发回去**（`replay` 默认关，
    // 理由写在 `src/index.js` 的 DEFAULTS 里）。
    // 正向的那半（开着回放时签名确实被带回去）本轮不测：那需要给插件传 profile 级 config，
    // 而编排器不写 profile 的 `cordis.patch.yml`——如实说，不假装验过。
    const noReplay = await trace('mock-anthropic-only', 'TRACE-NOREPLAY', {
      maxTokens: 64,
      messages: [
        { id: 'e2e-noreplay-u1', role: 'user', content: [{ type: 'text', text: 'TRACE-NOREPLAY 第一轮' }] },
        {
          id: 'e2e-noreplay-a1',
          role: 'assistant',
          // 宿主存回放状态的地方就是这里（`message.source`），而 `replayValue()` 还要求
          // `source.kind === 'model'` 且 `source.model === 信封里的 model`。
          source: {
            kind: 'model',
            model: 'mock-anthropic-only',
            replayState: {
              response: { kind: 'account-bridge/anthropic-messages', version: 1, model: 'mock-anthropic-only' },
              blocks: [{ type: 'reasoning', signature: 'SIGNATURE-FROM-LAST-TURN' }, { type: 'text' }],
            },
          },
          content: [{ type: 'reasoning', text: 'SECRET-THOUGHT' }, { type: 'text', text: 'let me look' }],
        },
        { id: 'e2e-noreplay-u2', role: 'user', content: [{ type: 'text', text: 'TRACE-NOREPLAY 第二轮' }] },
      ],
    })
    const noReplayText = JSON.stringify(noReplay.sent?.body ?? null)
    check(
      '翻译回显：默认不回放上一轮的思考签名',
      // 「助手轮确实到了上游」这一条是防假通过的：消息压根没发出去时，
      // 「没带签名」这句话毫无信息量。
      noReplayText.includes('let me look') &&
        !noReplayText.includes('SIGNATURE-FROM-LAST-TURN') &&
        !noReplayText.includes('SECRET-THOUGHT'),
      JSON.stringify({ sent: noReplay.sent?.body ?? null, matched: noReplay.matched }),
    )

    // 请求形状：system、工具定义、图片、工具结果都要以**那个方言**的样子出去。
    // 两个只挂单方言目录的模型把这一笔钉死在各自那条路上（`#streamWithPool` 按目录过滤账号）。
    const shapeOpenAI = await trace('mock-openai-only', 'TRACE-SHAPE-OPENAI', richCall('TRACE-SHAPE-OPENAI', tinyImage, 'mock-openai-only'))
    const openaiBody = shapeOpenAI.sent?.body ?? null
    const openaiIssues = []
    if (shapeOpenAI.sent?.dialect !== 'openai') openaiIssues.push(`走的不是 chat/completions（${shapeOpenAI.sent?.dialect ?? '没有请求'}）`)
    if (openaiBody?.max_tokens !== 128) openaiIssues.push(`max_tokens=${JSON.stringify(openaiBody?.max_tokens)}`)
    if (openaiBody?.stream_options?.include_usage !== true) openaiIssues.push('没发 stream_options.include_usage')
    const firstMessage = openaiBody?.messages?.[0]
    if (firstMessage?.role !== 'system' || !String(firstMessage?.content ?? '').includes('mock assistant')) {
      openaiIssues.push(`system 没成为第一条消息：${JSON.stringify(firstMessage)}`)
    }
    if (!JSON.stringify(openaiBody?.messages ?? []).includes('data:image/png;base64,')) openaiIssues.push('图片没变成 data URL')
    if (openaiBody?.messages?.find((message) => message.role === 'tool')?.tool_call_id !== 'call_prev_1') {
      openaiIssues.push('工具结果没带 tool_call_id')
    }
    if (openaiBody?.messages?.find((message) => message.role === 'assistant')?.tool_calls?.[0]?.id !== 'call_prev_1') {
      openaiIssues.push('上一轮的工具调用没还原成 assistant.tool_calls')
    }
    if (openaiBody?.tools?.[0]?.type !== 'function' || openaiBody?.tools?.[0]?.function?.name !== 'read_file') {
      openaiIssues.push(`工具定义形状不对：${JSON.stringify(openaiBody?.tools)}`)
    }
    if (JSON.stringify(openaiBody).includes('cache_control')) openaiIssues.push('发了 cache_control（对端可能不认）')
    check(
      '请求形状（OpenAI 方言）：system、工具、图片、工具结果都原样过去',
      openaiIssues.length === 0,
      `${openaiIssues.join('；')} — 假上游收到 ${shapeOpenAI.seen} 笔、命中标记 ${shapeOpenAI.matched} 笔；推理结果 ${JSON.stringify({
        threw: shapeOpenAI.threw,
        failure: shapeOpenAI.failure,
        kind: shapeOpenAI.kind,
        text: shapeOpenAI.text,
      })} — ${JSON.stringify(openaiBody)}`,
    )

    const shapeAnthropic = await trace('mock-anthropic-only', 'TRACE-SHAPE-ANTHROPIC', richCall('TRACE-SHAPE-ANTHROPIC', tinyImage, 'mock-anthropic-only'))
    const anthropicBody = shapeAnthropic.sent?.body ?? null
    const anthropicIssues = []
    if (shapeAnthropic.sent?.dialect !== 'anthropic') anthropicIssues.push(`走的不是 messages（${shapeAnthropic.sent?.dialect ?? '没有请求'}）`)
    if (anthropicBody?.max_tokens !== 128) anthropicIssues.push(`max_tokens=${JSON.stringify(anthropicBody?.max_tokens)}`)
    if (!Array.isArray(anthropicBody?.system) || !JSON.stringify(anthropicBody.system).includes('mock assistant')) {
      anthropicIssues.push(`system 不是顶层数组：${JSON.stringify(anthropicBody?.system)}`)
    }
    if (JSON.stringify(anthropicBody).includes('Claude Code')) anthropicIssues.push('冒充了 Claude Code 的身份块')
    if (!JSON.stringify(anthropicBody?.messages ?? []).includes('"type":"image"')) anthropicIssues.push('图片没成为 image 块')
    if (!JSON.stringify(anthropicBody?.messages ?? []).includes('"type":"tool_result"')) anthropicIssues.push('工具结果没成为 tool_result')
    if (!JSON.stringify(anthropicBody?.messages ?? []).includes('"type":"tool_use"')) anthropicIssues.push('上一轮的工具调用没成为 tool_use')
    if (anthropicBody?.tools?.[0]?.input_schema?.required?.[0] !== 'path') {
      anthropicIssues.push(`工具定义形状不对：${JSON.stringify(anthropicBody?.tools)}`)
    }
    if (JSON.stringify(anthropicBody).includes('cache_control')) anthropicIssues.push('发了 cache_control（对端可能不认）')
    check(
      '请求形状（Anthropic 方言）：system、工具、图片、工具结果都原样过去',
      anthropicIssues.length === 0,
      `${anthropicIssues.join('；')} — 假上游收到 ${shapeAnthropic.seen} 笔、命中标记 ${shapeAnthropic.matched} 笔；推理结果 ${JSON.stringify({
        threw: shapeAnthropic.threw,
        failure: shapeAnthropic.failure,
        kind: shapeAnthropic.kind,
        text: shapeAnthropic.text,
      })} — ${JSON.stringify(anthropicBody)}`,
    )

    // ------------------------------------------------------------------ 数据面与诊断面
    const state = await safe(() => api('state'), 'state')
    const stateText = JSON.stringify(state ?? null)
    check('回环 state 不外传凭据', !stateText.includes(KEY), 'state 的 JSON 里出现了假上游的密钥')
    check(`state 里有 ${ROUTES.length} 个族`, (state?.families ?? []).length === ROUTES.length, `实际 ${(state?.families ?? []).length} 个`)

    // ZCode（智谱）专有的一条：它的本机发现**必须说「有凭据但导不进来」**，不能返回空数组。
    //
    // 为什么值得单独一条：这一族刻意**不解密** `~/.zcode/v2/credentials.json` 里的
    // `enc:v1:` 凭据（派生密钥公开可复现 ⇒ 读它等于复制「读别人应用的登录态」的能力）。
    // 而 `AGENTS.md` 的硬规矩是「**「读不出来」不等于「没有」**」——返回空数组会让用户
    // 以为本机从没登录过 ZCode，那是把一次**有意的拒绝**说成了**不存在**。
    // 这条检查断言的是「如实报告」而不是具体文案，所以改文案不会让它假失败。
    const zcodeRow = byId.get('acct-zcode')
    const discover = tool('account_bridge_discover')
    const zcodeScan = await safe(() => discover?.execute?.({ family: 'zcode' }), 'discover(zcode)')
    const zcodeScanText = typeof zcodeScan === 'string' ? zcodeScan : String(zcodeScan?.content?.[0]?.text ?? zcodeScan ?? '')
    check(
      'ZCode 的显示名与本机发现都如实报告',
      String(zcodeRow?.name ?? '').includes('ZCode') &&
        zcodeScanText.includes('zcode') &&
        /有凭据但导不进来|importable/i.test(zcodeScanText),
      `name=${JSON.stringify(zcodeRow?.name)}；discover=${zcodeScanText.slice(0, 300)}`,
    )

    // Raccoon（商汤小浣熊）专有的一条：它的本机发现**必须说「有凭据但导不进来」并列出查过的路径**。
    //
    // 为什么值得单独一条：这一族的处境与 ZCode 不同——**连凭据位点都不存在**
    // （登录态只在客户端进程内存里，退出即失效，磁盘上不落盘）。这种「没有」最容易被写成
    // 一个空的 `return []`，而 `AGENTS.md` 的硬规矩是「**「读不出来」不等于「没有」**」：
    // 空数组会让用户以为本族不支持导入，而真相是**这一族本机压根没有可导入的东西**，
    // 且它只有「粘贴 access_token」这一条登录路。
    // 断言的是「如实报告」而不是具体文案（改 reason 的措辞不会让它假失败）。
    const raccoonRow = byId.get('acct-raccoon')
    const raccoonScan = await safe(() => discover?.execute?.({ family: 'raccoon' }), 'discover(raccoon)')
    const raccoonScanText = typeof raccoonScan === 'string' ? raccoonScan : String(raccoonScan?.content?.[0]?.text ?? raccoonScan ?? '')
    check(
      'Raccoon 的显示名与本机发现都如实报告',
      String(raccoonRow?.name ?? '').includes('Raccoon') &&
        raccoonScanText.includes('raccoon') &&
        /有凭据但导不进来|importable/i.test(raccoonScanText) &&
        // 「查过哪些路径」必须真的出现在报告里：只说「没有」而说不出查过哪里，
        // 用户没法复核我们是不是查错了地方（这一族唯一的可复核证据就是这份路径清单）。
        /\.raccoon/.test(raccoonScanText),
      `name=${JSON.stringify(raccoonRow?.name)}；discover=${raccoonScanText.slice(0, 300)}`,
    )

    // CodeArts（华为云）专有的一条：显示名如实、本机发现**如实说「导不进来」并列出查过的位点**，
    // 而且它**不能**是一个「有凭据但没实现导入」的假承诺。
    //
    // 为什么值得单独一条：这一族的处境是「**唯一的登录路是粘贴三件套**」——
    // CodeArts 的临时凭据不落在任何固定文件里（参考实现的凭据走它自己的凭据存储），
    // 本机 2026-10-11 核实 `~/.codearts`、`~/.cache/deveco` 都不存在。
    // 这种处境最容易被写成两个极端，两个都错：
    //   ① `return []`（＝「本机没有过 CodeArts」，而真相是**我们压根没有可读的位点**）；
    //   ② 报 `importable: true`（＝让用户点「导入」，然后因为本族没有
    //      `recordFromDiscovery` 而失败，`src/discover.js:196` 那条分支）。
    // 断言的是「如实报告 + 说出查过哪里」，不是具体文案（改 reason 的措辞不会假失败）。
    const codeartsRow = byId.get('acct-codearts')
    const codeartsScan = await safe(() => discover?.execute?.({ family: 'codearts' }), 'discover(codearts)')
    const codeartsScanText =
      typeof codeartsScan === 'string' ? codeartsScan : String(codeartsScan?.content?.[0]?.text ?? codeartsScan ?? '')
    check(
      'CodeArts 的显示名与本机发现都如实报告',
      String(codeartsRow?.name ?? '').includes('CodeArts') &&
        codeartsScanText.includes('codearts') &&
        /有凭据但导不进来|importable/i.test(codeartsScanText) &&
        // 「查过哪些位点」必须真的出现在报告里：只说「没有」而说不出查过哪里，
        // 用户没法复核我们是不是查错了地方（这一族唯一的可复核证据就是这份清单）。
        // 两个位点任一出现即可（`~/.cache/deveco` 的模型目录缓存，或 `~/.codearts`）。
        /cache[\\/]deveco|\.codearts/.test(codeartsScanText),
      `name=${JSON.stringify(codeartsRow?.name)}；discover=${codeartsScanText.slice(0, 300)}`,
    )

    // CodeArts 的第二条：它的登录面**只有粘贴一条路，而且那条路在状态里是可见的**。
    //
    // 为什么值得单独一条：本族的 `browser` 登录**故意没做**（要 DPoP/PKCE 签名与真实
    // 浏览器通道，本仓两样都没有），而 `paste` 是 agent 场景下唯一走得通的路
    // ——`src/login/broker.js` 只会自动回答单选项 select，其余交互一律 `DECLINED`。
    // 一个「方法列表是空的」或「方法 id 不是 paste」的族，用户点「+ 添加账号」
    // 会得到一个什么都不做的按钮，而这件事在别的检查里**完全看不见**。
    const codeartsStateRow = (state?.families ?? []).find((entry) => entry.family === 'codearts')
    const codeartsMethodIds = (codeartsStateRow?.loginMethods ?? []).map((method) => method.id)
    check(
      'CodeArts 的登录面如实只有 paste 一条路',
      codeartsMethodIds.includes('paste') && codeartsStateRow?.discoverable === true,
      `loginMethods=${JSON.stringify(codeartsStateRow?.loginMethods ?? null)}；discoverable=${codeartsStateRow?.discoverable}`,
    )

    // OpenCode Zen 专有的一条：显示名如实、本机发现**恰好报出 `opencode` 那一条**，
    // 而且**没有**把 `auth.json` 里另外六把别家的 key 当成本族的凭据。
    //
    // 为什么值得单独一条：这一族的凭据位点是一个**多租户**文件——本机的
    // `~/.local/share/opencode/auth.json` 里躺着 7 个 provider 的 key
    // （`deepseek` / `siliconflow-cn` / `longcat` / `zhipuai` / `google` / `amd` / `opencode`），
    // 而**只有最后那个是 Zen 的凭据**。最容易出的错就是「把整个文件当凭据读进来」
    // 或者「把 7 条都报成本族可导入」：前者会把别人的 key 拿去打 Zen（必然 401），
    // 后者会让用户在导入面板里看到 7 个假的 Zen 账号。
    // 断言的是「如实报告」+「点出查过的路径」，不是具体文案。
    const opencodeRow = byId.get('acct-opencode')
    const opencodeScan = await safe(() => discover?.execute?.({ family: 'opencode' }), 'discover(opencode)')
    const opencodeScanText =
      typeof opencodeScan === 'string' ? opencodeScan : String(opencodeScan?.content?.[0]?.text ?? opencodeScan ?? '')
    // 只断言**呈现在报告里**的东西，而且把「身份」与「解释」分开看：
    // `reason` 是**故意**点名那六个键的（不点名的话，用户看到「导不进来」没法复核我们查对没查对），
    // 所以拿整份报告去断言「不含 deepseek」会是个假失败。真正要守的是
    // **身份位（family / label / sourcePath）上不能出现别家的东西**。
    const foreignKeyNames = ['deepseek', 'siliconflow-cn', 'longcat', 'zhipuai', 'google', 'amd']
    const opencodeIdentities = [...opencodeScanText.matchAll(/^- (\S+) ｜ ([^｜\n]*?)(?: ｜ 来源 (\S+))?(?: ｜ |$)/gm)]
      .map((match) => `${match[1]} ${match[2]} ${match[3] ?? ''}`)
      .join('\n')
    check(
      'OpenCode Zen 的显示名与本机发现都如实报告，且没有把别家的 key 当成自己的凭据',
      String(opencodeRow?.name ?? '').includes('OpenCode Zen') &&
        opencodeScanText.includes('opencode') &&
        // 查过的路径必须真的出现：这一族全部的「我们查对了地方」证据就是这份路径清单
        // （而且它是**一个**文件，不是一族一个目录）。
        /auth\.json/.test(opencodeScanText) &&
        // 身份位上只有 opencode 这一条，别家的名字一个都不许出现。
        foreignKeyNames.every((name) => !opencodeIdentities.toLowerCase().includes(name)),
      `name=${JSON.stringify(opencodeRow?.name)}；identities=${JSON.stringify(opencodeIdentities)}；discover=${opencodeScanText.slice(0, 400)}`,
    )

    // OpenCode Zen 的第二条：登录面**如实只有 paste 一条路，而且那条路在状态里可见**。
    //
    // 为什么值得单独一条：本族是本仓**唯一一个 key 级的族**——没有 OAuth、没有浏览器通道，
    // 凭据就是一把静态 key，所以「粘贴」不是兜底而是**唯一**的登录路。一个方法列表是空的族，
    // 用户点「+ 添加账号」会得到一个什么都不做的按钮，而这件事在别的检查里完全看不见。
    // 另一半断言 `discoverable === true`：本族**有**可导入的本机凭据（上面那条检查已证明），
    // 所以发现面必须是开着的——这正是它与 codearts/raccoon 那种「有凭据但导不进来」的分界。
    const opencodeStateRow = (state?.families ?? []).find((entry) => entry.family === 'opencode')
    const opencodeMethodIds = (opencodeStateRow?.loginMethods ?? []).map((method) => method.id)
    check(
      'OpenCode Zen 的登录面如实只有 paste 一条路',
      opencodeMethodIds.includes('paste') && opencodeStateRow?.discoverable === true,
      `loginMethods=${JSON.stringify(opencodeStateRow?.loginMethods ?? null)}；discoverable=${opencodeStateRow?.discoverable}`,
    )

    // 两个腾讯变体必须**看着就是两个东西**：它们共用同一份凭据文件与同一条线协议
    // （`families/workbuddy.js` 的工厂 + 两份产品描述符），所以「显示名撞了」
    // 或「只注册进来一个」是这两族最容易出的错，而它在上一条计数检查里看不见
    // ——计数只数个数，不数名字。名字撞了用户就没法在设置页里分辨该往哪一族导入。
    const variantNames = ['acct-workbuddy', 'acct-codebuddy'].map((route) => String(byId.get(route)?.name ?? ''))
    check(
      '两个腾讯变体（WorkBuddy / CodeBuddy）是两条独立且有各自名字的 provider',
      variantNames[0].includes('WorkBuddy') && variantNames[1].includes('CodeBuddy') && variantNames[0] !== variantNames[1],
      JSON.stringify(variantNames),
    )

    // `discover` 的 `family` 参数必须真的管用，**而且写错名字时要说话**。
    //
    // 为什么值得两条：工具从前在「只报告」模式下**完全忽略** `args.family`，于是
    // `family: 'codex'` 会把每一族都扫一遍。那种输出看起来完全正常（它确实在报告本机的
    // 发现），用户只会以为「我想看的这一族本机没有可导入的账号」——而真相是那个参数根本
    // 没被读。写错族名更糟：静默扫全部，用户连自己拼错了都不知道。
    const scanTextOf = (value) => (typeof value === 'string' ? value : String(value?.content?.[0]?.text ?? value ?? ''))
    const bogusScan = scanTextOf(await safe(() => discover?.execute?.({ family: 'no-such-family' }), 'discover(bogus)'))
    check(
      'discover 给一个不存在的族名时会说出来，而不是静默扫全部',
      /没有叫/.test(bogusScan) && /no-such-family/.test(bogusScan) && /codex/.test(bogusScan),
      bogusScan.slice(0, 240),
    )
    const codexScan = scanTextOf(await safe(() => discover?.execute?.({ family: 'codex' }), 'discover(codex)'))
    const scannedFamilies = new Set(
      codexScan
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).split('｜')[0].trim()),
    )
    check(
      'discover 带 family 时只报那一族',
      [...scannedFamilies].every((family) => family === 'codex'),
      `扫到的族：${[...scannedFamilies].join(', ') || '（无）'}；报告 ${codexScan.slice(0, 200)}`,
    )

    const diagnostics = await safe(() => api('diagnostics'), 'diagnostics')
    check('诊断面可用', typeof diagnostics?.requests === 'number', JSON.stringify(diagnostics)?.slice(0, 200))
    // 翻译层丢了什么，只有这本账说得出；验收时先看这一行。
    say('诊断 =', JSON.stringify(diagnostics)?.slice(0, 700))

    // 账号级冷却必须能看见：上面已经制造过失败，池子应该记了点什么。
    const accounts = (state?.families ?? []).flatMap((family) => family.accounts ?? [])
    const e2eAccounts = accounts.filter((account) => String(account.label ?? '').startsWith('e2e-'))
    check('四个 e2e 账号都在池子里', e2eAccounts.length === 4, `实际 ${e2eAccounts.map((a) => a.label).join(', ')}`)
    check('账号行带状态字段', e2eAccounts.every((account) => typeof account.status === 'string'), JSON.stringify(e2eAccounts.map((a) => ({ id: a.id, status: a.status }))))

    // ------------------------------------------------------------------ 出口代理（放在最后：它会让每个账号都暂时用不了）
    //
    // 这条检查的判据是反的：**请求成功才是失败**。
    //
    // 为什么：账号上写了出口代理，就是要求这个账号的流量从那个出口出去。而 `src/http.js`
    // 从前在拿不到 `undici` 时只记一句日志，然后每个请求都**悄悄走直连**——用户以为换了
    // IP，实际带着真实地址出去了，而这一切在成功的响应里完全看不出来。现在它抛
    // `PROXY_UNAVAILABLE`，于是「配了一个打不通的代理 ⇒ 请求必须失败」就成了可断言的形状：
    // 要是在这儿拿到 PONG，说明又回到了静默走直连。
    //
    // 四个账号全配上：池子会换号，只给一个账号配的话下一个候选就把它救回来了。
    // 代理填 `127.0.0.1:9`（discard 端口，本机不会有人监听）。
    //
    // **判据不能只是「这次请求失败了」**：四个账号都可能在前面那些故障检查里带着冷却，
    // 那时请求会以「没有可用账号」失败——看起来是红的，实际什么都没验。所以这里做三件事：
    // ① 先把全部冷却解掉并把假上游的请求账本清空；② 配代理；③ 断言请求**一个字节都没到上游**
    // （`/__requests` 的计数仍是 0），并且失败不是「没有可用账号」那种空响。
    // 静默走直连时，假上游一定会收到那一笔 ⇒ 计数变成 1 ⇒ 这条立刻红。
    await safe(() => api('unfreeze', {}), 'unfreeze')
    await safe(
      () => fetch(`${BASE}/__requests`, { method: 'DELETE' }).then((response) => response.json()),
      'mock:clear',
    )
    for (const account of e2eAccounts) {
      await safe(() => api('proxy', { account: account.id, proxy: 'http://127.0.0.1:9' }), `proxy(${account.id})`)
    }
    const viaDeadProxy = await infer('mock-alpha', 'e2e-proxy')
    const seenByMock = await safe(
      () => fetch(`${BASE}/__requests`).then((response) => response.json()),
      'mock:requests',
    )
    const failureText = String(viaDeadProxy.failure?.message ?? '')
    check(
      '四个账号都配了打不通的代理时：请求失败，而且**一个字节都没到上游**（成功就等于静默走直连）',
      viaDeadProxy.text !== 'PONG'
        && Number(seenByMock?.count ?? -1) === 0
        && !/no account could serve/i.test(failureText),
      `text=${JSON.stringify(viaDeadProxy.text)}；失败=${failureText || '（无）'}；上游收到 ${seenByMock?.count} 笔`,
    )
    for (const account of e2eAccounts) {
      await safe(() => api('proxy', { account: account.id, proxy: '' }), `proxy-clear(${account.id})`)
    }
    await safe(() => api('unfreeze', {}), 'unfreeze-after')
  }
}
