/**
 * 面向模型/用户的工具面。
 *
 * 为什么要有工具：DSH 里 `ctx.authorization` 的 `interaction` 是**调用方**提供的，
 * 而面向终端用户的设置界面插槽（`settings.models.sign-in`）目前被官方账号引导占用。
 * 在客户端 UI 做出来之前，工具是最短的一条「让用户拿到登录 URL 并看到账号状态」的路。
 * @module dsh-account-bridge/tools
 */

import { discoverLocalAccounts, importDiscovered } from './discover.js'

/** 把毫秒差说成人话。 */
function humanize(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '可用'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.round(ms / 1000)} 秒后可用`
  if (minutes < 90) return `${minutes} 分钟后可用`
  return `${(minutes / 60).toFixed(1)} 小时后可用`
}

/** 渲染一次本机发现的结果。 */
function renderScan(scan, extra = []) {
  const lines = [`本机账号发现（${scan.scannedAt}）`, '']
  const { importable, blocked, unsupported, errors } = scan
  const fresh = importable.filter((entry) => !entry.alreadyImported)
  const known = importable.filter((entry) => entry.alreadyImported)

  if (fresh.length === 0 && known.length === 0 && unsupported.length === 0 && blocked.length === 0 && errors.length === 0) {
    lines.push('本机没有扫到任何已知客户端的登录态。')
    lines.push('')
    lines.push('这不是错误：装了对应客户端并在里面登录过之后，再跑一次这里就会列出来。')
    return lines.concat(extra).join('\n')
  }

  const section = (title, entries, render) => {
    if (entries.length === 0) return
    lines.push(`${title}（${entries.length}）`)
    for (const entry of entries) lines.push(`- ${render(entry)}`)
    lines.push('')
  }

  section('可以导入', fresh, (entry) => `${entry.family} ｜ ${entry.label ?? '未命名'}${entry.sourcePath ? ` ｜ 来源 ${entry.sourcePath}` : ''}`)
  section('已经导入过', known, (entry) => `${entry.family} ｜ ${entry.label ?? '未命名'}`)
  section('扫到了凭据，但这一族还没写', unsupported, (entry) => `${entry.family} ｜ ${entry.sourcePath} ｜ ${entry.reason}`)
  section('有凭据但导不进来', blocked, (entry) => `${entry.family} ｜ ${entry.label ?? '未命名'} ｜ ${entry.reason}`)
  section('发现过程出错的族', errors, (entry) => `${entry.family} ｜ ${entry.message}`)

  return lines.concat(extra).join('\n').trimEnd()
}

/** 渲染账号总览。 */
async function renderAccounts({ adapter, broker, store, families }, familyId) {
  const selected = familyId ? families.filter((family) => family.id === familyId) : families
  if (selected.length === 0) {
    return `没有名为 "${familyId}" 的族。已实现：${families.map((family) => family.id).join(', ')}`
  }
  const lines = []
  for (const family of selected) {
    const accounts = await store.list(family.id)
    const login = broker.snapshot(family.id)
    lines.push(`## ${family.displayName}（${family.id}）`)
    lines.push(`route: ${family.route} ｜ 账号数: ${accounts.length}`)
    if (login && login.status !== 'authorized') {
      lines.push(`登录尝试: ${login.status}${login.url ? ` ｜ ${login.url}` : ''}${login.error ? ` ｜ ${login.error}` : ''}`)
    }
    if (accounts.length === 0) {
      lines.push('（还没有账号。用 account_bridge_login 登录，或 account_bridge_import 导入本机客户端登录态。）')
    } else {
      for (const account of accounts) {
        const health = adapter.healthOf(family.id, account.id)
        const bits = [
          `- \`${account.id}\` ${account.label ?? ''}`.trimEnd(),
          `来源 ${account.source ?? 'oauth'}`,
          account.externallyOwned ? '外部所有(只读)' : undefined,
          account.disabled ? '已停用' : undefined,
          health ? health : '健康',
        ].filter(Boolean)
        lines.push(bits.join(' ｜ '))
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * 把「每属性一份规格」的简写编译成模型看得懂的 JSON Schema。
 *
 * 为什么不直接用宿主的 `defineTool`：它住在 `@deepseek-ai/dsh-tools` 里，
 * 而**插件按裸模块名 import 核心包会 `ERR_MODULE_NOT_FOUND`**——
 * profile 的 node_modules 是 pnpm 扁平布局，`@deepseek-ai/` 下只有 cosmokit 与 schemastery，
 * 核心包只在 asar 里、只能经 `ctx` 服务访问（本条已在真机上实测复现）。
 * 而 `tools.register(definition)` 只校验 `output.schema` 与 `output.render`，
 * 不校验 `parameters`——所以自己拼一个等价定义是安全的。
 */
function compileParameters(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = raw ?? {}
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

/** 统一用「一段文本」作为工具输出。 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  }
}

/** 构造全部工具定义（库内自足，不 import 核心包）。 */
export function createToolDefinitions({ adapter, broker, store, families, log, ctx }) {
  const definitions = []

  definitions.push({
    name: 'account_bridge_discover',
    description:
      'Scan this machine for client logins that the account-bridge plugin could import, WITHOUT signing anything in: ' +
      'reads the credential files left behind by the Codex CLI, Claude Code, the agy CLI, and reports which of them ' +
      'are usable. Also reports credential sites whose family is not implemented yet, so you can tell the human ' +
      'what is not covered instead of guessing. Pass import:true to actually adopt every importable account.',
    parameters: compileParameters({
      family: { type: 'string', description: 'Only look at this family. Omit to scan every family.' },
      import: { type: 'boolean', description: 'Adopt the importable accounts found (default false = report only).' },
    }),
    output: textOutput(),
    async execute(args) {
      try {
        const scan = await discoverLocalAccounts({ families, store, ctx, log })
        if (args.import !== true) {
          const extra = scan.importable.some((entry) => !entry.alreadyImported)
            ? ['想全部收下就再调一次本工具并带 `import: true`。']
            : []
          return renderScan(scan, extra)
        }

        const result = await importDiscovered({ families, store, scan, family: args.family, adapter })

        // 这次扫描发生在导入**之前**，所以刚收下的那些此刻还挂在「可以导入」里。
        // 不把它们挪走的话，输出会自相矛盾：上面说「可以导入 1 个」，下面说「已导入 1 个」。
        const taken = new Set(result.imported.map((entry) => `${entry.family}\u0000${entry.identity}`))
        const after = {
          ...scan,
          importable: scan.importable.filter((entry) => !taken.has(`${entry.family}\u0000${entry.identity}`)),
        }

        const extra = ['']
        if (result.imported.length > 0) {
          extra.push(`已导入 ${result.imported.length} 个账号：`)
          for (const entry of result.imported) {
            extra.push(`- \`${entry.id}\` ${entry.label ?? ''}${entry.sourcePath ? ` ｜ 来自 ${entry.sourcePath}` : ''}`)
          }
          extra.push('', '它们现在应该已经出现在模型选择器里了。')
        } else {
          extra.push('没有可导入的新账号——要么都导过了，要么本机没有登录态。')
        }
        for (const entry of result.skipped) extra.push(`- 跳过 ${entry.family}/${entry.label ?? '?'}：${entry.reason}`)
        return renderScan(after, extra)
      } catch (error) {
        log?.warn?.('account-bridge: account_bridge_discover failed: %s', String(error?.message ?? error))
        return `本机发现失败：${String(error?.message ?? error)}`
      }
    },
  })

  definitions.push({
    name: 'account_bridge_accounts',
    description:
      'List the accounts of the DSH account-bridge plugin: which upstream subscription accounts are signed in, ' +
      'where their credentials came from, and whether any of them is cooling down after a failure. ' +
      'Use this before blaming the network when a model call fails.',
    parameters: compileParameters({
      family: { type: 'string', description: 'Only show this family (e.g. "codex"). Omit to show every family.' },
    }),
    output: textOutput(),
    async execute(args) {
      try {
        return await renderAccounts({ adapter, broker, store, families }, args.family)
      } catch (error) {
        return `读取账号失败：${String(error?.message ?? error)}`
      }
    },
  })

  definitions.push({
    name: 'account_bridge_login',
    description:
      'Start signing a new upstream subscription account into the DSH account-bridge plugin. ' +
      'Returns a URL the human must open in a browser; the loopback callback finishes the sign-in by itself, ' +
      'so call account_bridge_accounts afterwards to see whether the new account appeared.',
    parameters: compileParameters({
      family: { type: 'string', required: true, description: `Which family to sign in to. Available: ${families.map((f) => f.id).join(', ')}` },
      method: { type: 'string', description: 'Optional login method id. Omit to use the family default.' },
    }),
    output: textOutput(),
    async execute(args) {
      const family = families.find((item) => item.id === args.family)
      if (!family) {
        return `没有名为 "${args.family}" 的族。已实现：${families.map((item) => item.id).join(', ')}`
      }
      const methods = family.login?.methods ?? []
      const method = args.method ?? methods[0]?.id
      if (args.method && !methods.some((item) => item.id === args.method)) {
        return `"${family.id}" 不支持登录方式 "${args.method}"。可选：${methods.map((item) => `${item.id}（${item.label}）`).join('、')}`
      }
      try {
        broker.reset(family.id)
        const snapshot = await broker.start(family, { method })
        const lines = [`已开始 ${family.displayName} 的登录（方式：${method}）。`]
        if (snapshot?.url) {
          lines.push('', `请让人类在浏览器里打开：${snapshot.url}`)
          lines.push('', '登录完成后回调会自动回来，不需要粘贴任何东西；之后用 account_bridge_accounts 确认。')
        } else if (snapshot?.message) {
          lines.push('', snapshot.message)
        } else {
          lines.push('', '暂时还没拿到登录 URL，稍后用 account_bridge_accounts 再看一次。')
        }
        if (snapshot?.status === 'failed' && snapshot.error) lines.push('', `失败原因：${snapshot.error}`)
        return lines.join('\n')
      } catch (error) {
        const message = String(error?.message ?? error)
        log?.warn?.('account-bridge: account_bridge_login failed: %s', message)
        return `启动登录失败：${message}`
      }
    },
  })

  definitions.push({
    name: 'account_bridge_accounts_remove',
    description: 'Remove one account from the DSH account-bridge plugin. This only deletes the local credential record; it does not touch the upstream service.',
    parameters: compileParameters({
      account: { type: 'string', required: true, description: 'Account id as shown by account_bridge_accounts, e.g. "codex-1".' },
    }),
    output: textOutput(),
    async execute(args) {
      try {
        const account = await store.read(args.account)
        if (!account) return `没有账号 "${args.account}"。`
        await store.remove(args.account)
        adapter.invalidate(account.family)
        return `已删除账号 ${args.account}（仅本地记录）。`
      } catch (error) {
        return `删除失败：${String(error?.message ?? error)}`
      }
    },
  })

  return definitions
}

export { compileParameters, humanize }
