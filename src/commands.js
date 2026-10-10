/**
 * `/pool` 命令族——人在对话框里直接问账号池的状态，不经过模型。
 *
 * 为什么值得有：设置页那个面板要开浏览器点三下才看得到；而「刚才那条为什么换号了」
 * 「这个号还要冻多久」「额度到底还剩多少」是**在对话中途**才会冒出来的问题。
 * 命令面不产生模型消息（`ctx.commands` 的设计就是如此），所以问一句不会烧任何额度。
 *
 * 三条设计约束：
 *
 * 1. **`status` 不发网络请求。** 它只读凭据记录与内存里的冷却表。理由与面板一致：
 *    自动查额度等于拿用户的账号去刷上游风控。想真查必须是显式的一条 `check`。
 *
 * 2. **「未知」与「0%」必须写成两个句子。** `check` 读不到额度时写「额度 未知」，
 *    不写 `0%`——这正是计划书 §C3 的要求（`quota()` 返回 `undefined` 与返回
 *    `remainingFraction: 0` 是两件不同的事，前者是上游没这个接口）。
 *
 * 3. **解冻要说明它为什么安全。** 冷却表是纯内存的派生状态；删掉最坏的结果是下一次
 *    请求再撞一次同样的失败、再记一条冷却。不说清楚的话，人不敢用这条命令，
 *    于是账号会一直冻着——那才是真正的损失。
 */

import { AFFINITY_MODES } from './affinity.js'
import { quotaOf } from './api.js'

/** 命令名要走宿主的 COMMAND_NAME 正则：小写字母/数字/`_`/`-`。 */
export const COMMAND_NAME = 'pool'

export const USAGE = [
  '`/pool` 或 `/pool status` —— 列出每族的账号与健康（不发网络请求）',
  '`/pool check [族]` —— 真去查一次额度（会打上游）',
  '`/pool unfreeze [族] [账号]` —— 清掉冷却，让号立刻重新参与调度',
  '`/pool sticky [auto|session|turn|off]` —— 看/改会话粘性，以及「这段会话为什么粘它」',
  '`/pool sticky forget [族]` —— 丢掉粘性记录（下次重新选号）',
  '`/pool lost` —— 最近一次请求里翻译层丢掉了什么（哪些东西模型没看到）',
  '`/pool limits [族 账号 [每分钟] [并发]]` —— 看/改某个账号的流量上限（不给数就是看）',
].join('\n')

/** 上限是「账号级 / 族级 / 全局」哪一层给的。 */
const LIMIT_FROM_TEXT = {
  account: '账号级',
  family: '族级',
  global: '全局',
}

/** 「为什么粘它/不粘」那 11 个裁决说成人话。 */
export const WHY_TEXT = {
  off: '粘性关着',
  'sticky-new': '这段会话还没有人答过',
  gone: '上次答它的那个账号已经不在了',
  resting: '上次答它的那个账号在冷却里',
  spent: '上次答它的那个账号快用满了',
  session: '整段会话都粘（session）',
  turn: '这一轮还在进行中（在回传工具结果）',
  'sticky-miss': '新的一轮开始了（turn 模式）',
  'cache-weak': '上次它只从缓存里读了不到 1024 token，不值得为它换号',
  'cache-cold': '上次答复到现在超过 5 分钟，缓存凉了',
  'sticky-hit': '上游缓存还在，继续用它',
}

/** `remainingFraction` → `62%`；不是有限数就返回 undefined，绝不把未知写成 0%。 */
export function percentText(fraction) {
  if (!Number.isFinite(fraction)) return undefined
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
}

/** 毫秒 → `还有 4 分钟` / `还有 2.3 小时`。 */
export function untilText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  const seconds = Math.round(ms / 1000)
  // 先按秒判再进分钟：30 秒四舍五入成「1 分钟」会让人以为还有富余。
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 90) return `${minutes} 分钟`
  return `${(minutes / 60).toFixed(1)} 小时`
}

/**
 * 额度窗口 → 一行文字。
 *
 * 传进来的 `windows` 有三种状态，**必须区分**：`undefined` = 这一族没有额度接口；
 * `[]` = 有接口但这次没读出东西；有元素 = 真读数（`remainingFraction` 仍可能是
 * undefined，那表示窗口存在但没给百分比）。
 */
export function quotaText(windows) {
  if (windows === undefined) return '额度 未知（这一族没有额度接口）'
  if (windows.length === 0) return '额度 未知'
  const parts = windows.map((window) => {
    const percent = percentText(window.remainingFraction)
    const label = window.name ?? window.id
    return percent === undefined ? `${label} ?` : `${label} ${percent}`
  })
  return `额度 ${parts.join(' / ')}`
}

/**
 * 一个账号一行。`why` 是 adapter.healthOf() 的返回值（健康时 undefined）。
 *
 * `quotaText_` 要的是**已经渲染好的字符串**，不是额度窗口数组——这一点是刻意的：
 * `windows === undefined` 有两种完全不同的含义（「这一族没有额度接口」与
 * 「有接口但这次没读出来」），把它们都传成 `undefined` 会让调用方无法区分，
 * 于是「查了但没查到」会渲染成**什么都不显示**，看起来像没查。
 * 所以渲染的责任留在知道上下文的那一方（`statusText` / `checkText`），
 * 这里只负责拼行。
 */
export function accountLine(account, { why, quotaText: rendered } = {}) {
  const flags = []
  if (account.disabled === true) flags.push('已停用')
  if (account.externallyOwned === true) flags.push('共用')
  if (Number.isFinite(account.expiresAt) && account.expiresAt <= Date.now()) flags.push('token 已过期')
  if (why) flags.push(`⏸ ${why}`)
  const bits = [`\`${account.id}\``, account.label ?? '(无标签)', ...flags]
  if (rendered !== undefined) bits.push(rendered)
  return `- ${bits.join(' · ')}`
}

/** 族名 → 族对象；也接受 route（`acct-codex`）与 displayName，省得人记两套名字。 */
export function findFamily(families, token) {
  if (!token) return undefined
  const needle = token.toLowerCase()
  return families.find((family) =>
    family.id === needle
    || family.route.toLowerCase() === needle
    || family.displayName.toLowerCase() === needle)
}

/** 把 rawInput 切成词，容忍多空格与两侧空白。 */
export function splitInput(rawInput) {
  return String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
}

/**
 * 建一个 `/pool` 命令定义。
 *
 * `handler` 不抛异常：宿主规定返回值必须是 `{kind:'success'|'error'}`，
 * 抛出去会在适配器那一层变成一条笼统的失败，不如自己把话说清楚。
 */
export function createPoolCommand({ adapter, store, families, ctx, log }) {
  async function statusText() {
    const rows = await adapter.status()
    const lines = []
    let total = 0
    for (const row of rows) {
      const family = families.find((item) => item.id === row.family)
      const methods = (family?.login?.methods ?? []).map((method) => method.id).join('/')
      lines.push(`### ${row.displayName}（\`${row.family}\` → \`${row.route}\`）`)
      if (row.accounts.length === 0) {
        lines.push(methods ? `- （没有账号；可用的登录方式：${methods}）` : '- （没有账号）')
        continue
      }
      total += row.accounts.length
      for (const account of row.accounts) {
        lines.push(accountLine(account, { why: adapter.healthOf(row.family, account.id) }))
      }
    }
    if (total === 0) {
      lines.push('')
      lines.push('一个账号都没有。在**设置 → 账号池**里加一个，或者用 `account_bridge_accounts` 工具从本机导入。')
    }
    lines.push('')
    lines.push(`共 ${rows.length} 族 / ${total} 个账号。这里**没有**查额度——想真查一次用 \`/pool check\`。`)
    return lines.join('\n')
  }

  async function checkText(token) {
    const family = token ? findFamily(families, token) : undefined
    if (token && !family) {
      return { kind: 'error', text: `没有叫 \`${token}\` 的族。可用：${families.map((item) => item.id).join(' / ')}` }
    }
    const targets = family ? [family] : families
    const lines = []
    let accounts = 0
    let reported = 0
    for (const item of targets) {
      const rows = await store.list(item.id)
      lines.push(`### ${item.displayName}（\`${item.id}\`）`)
      if (rows.length === 0) {
        lines.push('- （没有账号）')
        continue
      }
      if (typeof item.quota !== 'function') {
        lines.push(`- ${rows.length} 个账号 · 额度 未知（这一族没有额度接口）`)
        accounts += rows.length
        continue
      }
      for (const account of rows) {
        accounts += 1
        const windows = await quotaOf(item, account, ctx)
        if (windows !== undefined) reported += 1
        // 走到这里说明这一族**有** quota()，所以读不到只能写「未知」——
        // 不能什么都不写（那看起来像没查），也不能写 0%（那是编数）。
        lines.push(accountLine(
          {
            id: account.id,
            label: account.label,
            disabled: account.disabled === true,
            externallyOwned: account.externallyOwned === true,
            expiresAt: account.auth?.expiresAt,
          },
          { quotaText: quotaText(windows) },
        ))
      }
    }
    lines.push('')
    lines.push(`查了 ${accounts} 个账号，其中 ${reported} 个读到了真实额度。`)
    lines.push('读不到的写「未知」——那是上游没给，不是 0%。')
    return { kind: 'success', text: lines.join('\n') }
  }

  async function unfreezeText(familyToken, accountId) {
    const family = familyToken ? findFamily(families, familyToken) : undefined
    if (familyToken && !family) {
      // 账号 id 的形状是 `<族>-<n>`，所以 `/pool unfreeze codex-1` 是很自然会敲错的一条。
      // 「没有叫 codex-1 的族」是**对的**但没用——直接把正确写法给出来。
      if (!accountId && /^[a-z][a-z0-9]*-\d+$/.test(familyToken)) {
        const owner = families.find((item) => familyToken.startsWith(`${item.id}-`))
        const suggestion = owner ? `\`/pool unfreeze ${owner.id} ${familyToken}\`` : '`/pool unfreeze <族> <账号>`'
        return { kind: 'error', text: `\`${familyToken}\` 看起来是账号 id，不是族。账号要带族写：${suggestion}` }
      }
      return { kind: 'error', text: `没有叫 \`${familyToken}\` 的族。可用：${families.map((item) => item.id).join(' / ')}` }
    }
    if (accountId && !family) {
      return { kind: 'error', text: '要指定账号就得先指定族，例如 `/pool unfreeze codex codex-1`。' }
    }
    const targets = family ? [family.id] : families.map((item) => item.id)
    let removed = 0
    for (const id of targets) removed += adapter.unfreeze(id, accountId)
    const scope = family ? (accountId ? `\`${family.id}/${accountId}\`` : `整族 \`${family.id}\``) : '全部族'
    if (removed === 0) {
      return { kind: 'success', text: `${scope} 本来就没有冷却中的条目，没动任何东西。` }
    }
    return {
      kind: 'success',
      text: `解冻了 ${scope}，清掉 ${removed} 条冷却。\n\n`
        + '冷却表只是内存里的派生状态，所以这个动作是安全的：如果那个号真的还不能用，'
        + '下一次请求会再撞一次同样的失败、再记一条冷却。',
    }
  }

  /**
   * 会话粘性（W7）：看四态、看「为什么」、改四态、丢掉记录。
   *
   * 只读那一条不发网络请求；改模式只影响**这一次运行**（持久值在 `cordis.patch.yml`），
   * 这一点必须在输出里说清楚，否则人会以为改完就记住了。
   */
  async function stickyText(token, familyToken) {
    if (token === 'forget' || token === 'clear') {
      const family = familyToken ? findFamily(families, familyToken) : undefined
      if (familyToken && !family) {
        return { kind: 'error', text: `没有叫 \`${familyToken}\` 的族。可用：${families.map((item) => item.id).join(' / ')}` }
      }
      adapter.clearSticky?.(family?.id)
      return {
        kind: 'success',
        text: family
          ? `丢掉了 \`${family.id}\` 的粘性记录。下一轮由选号重新决定用谁——那也意味着上游的 prompt cache 会重算一次。`
          : '丢掉了全部粘性记录。下一轮由选号重新决定用谁——那也意味着上游的 prompt cache 会重算一次。',
      }
    }
    if (token !== undefined && token !== '') {
      if (!AFFINITY_MODES.includes(token)) {
        return { kind: 'error', text: `粘性只能是 ${AFFINITY_MODES.join(' / ')} 之一，收到 \`${token}\`。` }
      }
      adapter.affinityMode = token
    }
    const book = adapter.affinityBook?.()
    const rows = adapter.lastWhy?.() ?? []
    const lines = [
      `### 会话粘性：\`${adapter.affinityMode}\``,
      '',
      `- 可选：${AFFINITY_MODES.map((mode) => `\`${mode}\``).join(' / ')}（\`auto\` 是默认）`,
      `- 落盘：${book?.persisted === true ? '✅ 已接上（重启不失忆）' : '⚠️ 只在内存里（重启即失忆，其余功能不受影响）'}`,
      `- 记着的会话：${book?.size ?? 0} 段`,
      '',
      '| 模式 | 含义 |',
      '|---|---|',
      '| `auto` | 轮内总是粘；跨轮看**实测**——上次上游说它从缓存读了多少 token（不到 1024 不值得留），以及有没有凉掉（超过 5 分钟） |',
      '| `session` | 整段会话都粘，不管缓存读了多少 |',
      '| `turn` | 只在轮内粘（agent 在回传工具结果时），用户一开口就重新选号 |',
      '| `off` | 不粘，永远按额度与节奏排序 |',
    ]
    if (rows.length > 0) {
      lines.push('')
      lines.push('最近几次选择（新的在前）：')
      for (const row of rows.slice(-12).reverse()) {
        const said = WHY_TEXT[row.why] ?? row.why
        lines.push(`- \`${row.family}/${row.model}\` → \`${row.accountId ?? '—'}\`：${said}`)
      }
    }
    lines.push('')
    lines.push('改模式只影响**这一次运行**；要持久就写进 `cordis.patch.yml` 的 `config.affinity`。')
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * 诊断码 → 人话。**只解释「丢了什么」，不解释「为什么」**——理由是上游的事，
   * 我们只能说清自己这边少收到了什么。
   */
  const LOST_TEXT = {
    UNKNOWN_BLOCK_TYPE: '历史里有一种块我们不认识，整块没发给上游（模型没看到它）',
    IMAGE_WITHOUT_DATA: '图片没有可用的数据，没能发给上游（模型没看到这张图）',
    REPLAY_STATE_MISSING: '该回放的思考签名/加密内容没存下来，这一块没往回发（上游可能因此重算）',
    CONTINUATION_STATE_LOST: '上游要的续传态我们表达不出来，这一轮只能当普通结束',
    TOOL_ARGUMENTS_UNPARSABLE: '工具参数不是合法 JSON，参数被当成空对象发出去了（工具行为变了）',
    TOOL_CALL_WITHOUT_NAME: '上游给了一个没有名字的工具调用，没法转给宿主',
    UNRENDERED_BLOCK_TYPE: '流里出现了一种我们不会渲染的块，这段内容在界面上不存在',
    UNRENDERED_ITEM_TYPE: '流里出现了一种我们不会渲染的条目，这段内容在界面上不存在',
    UNHANDLED_DELTA_TYPE: '流里出现了一种我们不认识的增量类型，这段内容丢了',
    UNKNOWN_STREAM_EVENT: '流里出现了一种我们不认识的事件，整条忽略',
    UNKNOWN_STOP_REASON: '上游给了一个我们不认识的停止原因，被当成正常结束（可能其实没说完）',
  }

  async function lostText() {
    const book = adapter.diagnostics?.()
    const entries = book?.entries ?? []
    const requests = book?.requests
    const dirty = book?.lostRequests ?? 0
    // 报的是**最近一次真的丢了东西的**请求，不是字面上的「最后一次请求」：
    // agent 一轮里最后一次请求常常是干净的（回传工具结果那一轮），那样会说「什么都没丢」，
    // 而用户刚刚才看见模型没读到他的图片。
    const lines = ['### 翻译层丢掉了什么（最近 8 次请求里丢得最凶的那一次）', '']
    if (entries.length === 0) {
      lines.push(
        requests === 0
          ? '还没有走过一次请求。'
          : requests === undefined
            ? '什么都没丢——上游说的每一句我们都听懂了，也都表达得出来。'
            : `最近 **${requests}** 次请求**什么都没丢**——上游说的每一句我们都听懂了，也都表达得出来。`,
      )
      return { kind: 'success', text: lines.join('\n') }
    }
    lines.push(
      dirty > 1
        ? `最近 **${requests}** 次请求里有 **${dirty}** 次丢了东西，下面是最新那一次（${book.family ?? '—'}）。`
        : `最近 **${requests}** 次请求里有 **1** 次丢了东西（${book.family ?? '—'}）。`,
    )
    lines.push('')
    lines.push(
      book.hasErrors
        ? '⚠️ 有 `error` 级：**模型或工具真的少收到了东西**，不只是界面上少显示一段。'
        : '只有 `warning` 级：界面上少显示了一段，内容本身没变。',
    )
    lines.push('')
    lines.push('| 严重性 | 位置 | 码 | 次数 | 说明 |')
    lines.push('|---|---|---|---|---|')
    for (const entry of entries) {
      const where = entry.path ?? '—'
      const what = LOST_TEXT[entry.code] ?? entry.message
      lines.push(`| ${entry.severity} | \`${where}\` | \`${entry.code}\` | ${entry.count} | ${what} |`)
    }
    if ((book.dropped ?? 0) > 0) {
      lines.push('')
      lines.push(`另有 **${book.dropped}** 条因为超过上限被丢掉（同一个位置只留第一次）。`)
    }
    lines.push('')
    lines.push('`error` 级值得查：多半是上游换了字段名，或者某个历史块类型我们还不支持。')
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * `/pool limits` —— 看/改账号级流量上限。
   *
   * 四种输入：无参数 = 列全部；`族` = 列这一族；`族 账号` = 列这一个；
   * `族 账号 每分钟 并发` = 改（给了 0 或垃圾就是「取消这一项」，回到上一级）。
   * 这里刻意**不显示**凭据、也不发网络请求——上限是本地算的。
   */
  async function limitsText(rest) {
    const [familyToken, accountToken, rpmToken, concurrencyToken] = rest
    const said = (value) => (Number(value) > 0 ? `${Number(value)}` : '无')

    if (accountToken === undefined) {
      const wanted = familyToken ? findFamily(families, familyToken) : undefined
      if (familyToken && !wanted) {
        return { kind: 'error', text: `没有叫 \`${familyToken}\` 的族。可用：${families.map((item) => item.id).join(' / ')}` }
      }
      const lines = ['### 账号的流量上限', '', '| 账号 | 一分钟（次） | 同时在外（个） | 来自 |', '|---|---|---|---|']
      let total = 0
      for (const row of await adapter.status()) {
        if (wanted && row.family !== wanted.id) continue
        const family = families.find((item) => item.id === row.family)
        for (const account of row.accounts) {
          const limits = adapter.limitsFor(family, account)
          total += 1
          lines.push(`| \`${account.id}\` | ${said(limits.rpm)} | ${said(limits.concurrency)} | ${LIMIT_FROM_TEXT[limits.from] ?? limits.from} |`)
        }
      }
      if (total === 0) {
        lines.push('| — | — | — | — |')
        lines.push('')
        lines.push('一个账号都没有。')
        return { kind: 'success', text: lines.join('\n') }
      }
      lines.push('')
      lines.push('「无」= 这个账号没有上限。**上限不是必须的**：只在某一家的风控会因为你发太快而拒绝时才要配。')
      lines.push('改一个：`/pool limits codex codex-1 5 2`（一分钟 5 次、同时最多 2 个）。')
      return { kind: 'success', text: lines.join('\n') }
    }

    const family = findFamily(families, familyToken)
    if (!family) {
      return { kind: 'error', text: `没有叫 \`${familyToken}\` 的族。可用：${families.map((item) => item.id).join(' / ')}。用法：\`/pool limits <族> <账号> [每分钟] [并发]\`` }
    }
    const account = await store.read(accountToken)
    if (!account || account.family !== family.id) {
      return { kind: 'error', text: `\`${family.id}\` 里没有账号 \`${accountToken}\`。用 \`/pool limits\` 看现有的。` }
    }

    const given = [rpmToken, concurrencyToken].filter((token) => token !== undefined)
    const lines = [`### \`${account.id}\` 的流量上限`]
    if (given.length === 0) {
      const limits = adapter.limitsFor(family, account)
      lines.push('')
      lines.push(`- 一分钟：**${said(limits.rpm)}** 次（${LIMIT_FROM_TEXT[limits.from] ?? limits.from}）`)
      lines.push(`- 同时在外：**${said(limits.concurrency)}** 个（${LIMIT_FROM_TEXT[limits.from] ?? limits.from}）`)
      lines.push('')
      lines.push(`改它：\`/pool limits ${account.family} ${account.id} 5 2\`；取消：把数字写成 0。`)
      return { kind: 'success', text: lines.join('\n') }
    }

    const wanted = { maxRpm: rpmToken, maxConcurrency: concurrencyToken }
    const changed = []
    const next = await store.update(account.id, (current) => {
      const copy = { ...current }
      for (const [key, raw] of Object.entries(wanted)) {
        if (raw === undefined) continue
        const value = Number(raw)
        if (Number.isFinite(value) && value > 0) {
          copy[key] = Math.floor(value)
          changed.push(`${key === 'maxRpm' ? '一分钟' : '同时在外'} → ${copy[key]}`)
        } else {
          delete copy[key]
          changed.push(`${key === 'maxRpm' ? '一分钟' : '同时在外'} → 无上限`)
        }
      }
      return copy
    })
    adapter.invalidate(family.id)
    adapter.invalidateHealth()
    const limits = adapter.limitsFor(family, next ?? account)
    lines.push('')
    for (const line of changed) lines.push(`- ${line}`)
    lines.push('')
    lines.push(`现在：一分钟 ${said(limits.rpm)} 次 / 同时在外 ${said(limits.concurrency)} 个（${LIMIT_FROM_TEXT[limits.from] ?? limits.from}）。`)
    lines.push('')
    lines.push('计数的是**真的发出去的每一次**请求，包括重试、换号，以及插件自己刷模型目录的那次。超上限会被立刻拒绝并带 `Retry-After`，**不会**把账号冷却掉。')
    return { kind: 'success', text: lines.join('\n') }
  }

  async function handler({ rawInput }) {
    const [verb, ...rest] = splitInput(rawInput)
    try {
      switch (verb) {
        case undefined:
        case 'status':
          return { kind: 'success', text: await statusText() }
        case 'check':
          return await checkText(rest[0])
        case 'unfreeze':
        case 'thaw':
          return await unfreezeText(rest[0], rest[1])
        case 'sticky':
        case 'affinity':
          return await stickyText(rest[0], rest[1])
        case 'lost':
        case 'diagnostics':
          return await lostText()
        case 'limits':
        case 'rpm':
          return await limitsText(rest)
        default:
          return { kind: 'error', text: `不认识的子命令 \`${verb}\`。\n\n${USAGE}` }
      }
    } catch (error) {
      log?.warn?.('account-bridge: /pool %s failed: %s', verb ?? 'status', error?.stack ?? error)
      return { kind: 'error', text: `/pool 失败了：${error?.message ?? String(error)}` }
    }
  }

  return {
    name: COMMAND_NAME,
    description: '账号池：看每族账号与健康、真查一次额度、解冻冷却中的账号、看会话粘性、流量上限与翻译损失',
    input: { hint: '[status|check|unfreeze|sticky|lost|limits] [族] [账号]' },
    handler,
  }
}
