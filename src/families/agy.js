/**
 * Antigravity 族 —— 驱动本机 `agy` CLI 子进程。
 *
 * ## 为什么走 CLI 而不是直连 Google 私有 HTTP
 *
 * 社区两条路：直连 `daily-cloudcode-pa.googleapis.com/v1internal:*`（chaos-03x、suntianc）
 * 或驱动本机 `agy`（agy-link）。我们选后者：前者要手搓 Electron 指纹与
 * `ClientMetadata`，还得把 57 个工具 schema 翻译成 Google 的私有格式，脆得很；
 * CLI 路线把协议、重试、工具沙箱全留在上游。
 *
 * 代价（如实记下，不粉饰）：
 * - **依赖用户本机装了 agy CLI**，没装这一族就不可用；
 * - **每一回合固定烧掉约 27k input tokens**（agy 自带系统提示 + 57 个工具 schema），
 *   哪怕你只问一个「PONG」；
 * - **委派型而非工具调用型**：agy 用它自己的 57 个工具、在它自己的 cwd 里干活，
 *   DSH 的工具给不了它，agy 的工具活动也不会变成 DSH 的 tool-call 块。
 *   我们只把它吐出的文本交回 DSH。
 *
 * ## 登录
 *
 * **不做插件内登录**，只做「探测本机已有登录」。原因是实测出来的：agy 的登录要你
 * 把浏览器里显示的授权码**贴回它自己的控制台**——而 DSH 是 GUI 进程，没有控制台
 * 可给它；管道喂码它根本不读（60 秒硬超时，见 m01702 段的排查）。
 * 想用这一族，先在终端里跑一次 `agy` 完成登录，再回来「导入」。
 *
 * ## 账号数
 *
 * Windows 上 agy 把令牌存进**凭据管理器**（`cmdkey /list` 里的
 * `LegacyGeneric:target=gemini:antigravity`），那是**按用户**而不是按 HOME 隔离的，
 * target 名也不含路径成分 ⇒ **给子进程换 HOME 隔离不出第二个账号**。
 * 所以本族在 Windows 上实际只能挂一个账号。与其假装支持多账号，不如照实说。
 *
 * @module dsh-account-bridge/families/agy
 */

import { CliMissingError, killTree, resolveBin, runCli, spawnCli } from '../cli-run.js'
import { buildPrompt, classifyAgyFailure, parseModels, translateAgyStream } from '../wire/agy.js'
import { withSource } from '../util.js'

/** PATH 上的默认可执行名；配置项 `agyBin` 可以覆盖成绝对路径。 */
const DEFAULT_BIN = 'agy'
/** `agy models` 是本地命令 + 一次网络往返；实测约 3 秒，30 秒是宽松上限。 */
const MODELS_TIMEOUT_MS = 30_000
/** 单回合上限。agy 自己不给超时（`--print-timeout 0s` = 无限等），我们必须给。 */
const TURN_TIMEOUT_MS = 30 * 60_000

/**
 * 上下文窗口。**agy 不报告这个值**，所以这里是保守估计——宁可低估
 * （DSH 提前压缩）也不要高估（把超长请求送上去被拒，白烧一次 27k）。
 */
function contextWindowFor(id) {
  if (id.startsWith('gemini-')) return 1_000_000
  if (id.startsWith('claude-')) return 200_000
  if (id.startsWith('gpt-oss')) return 128_000
  return 200_000
}

/** 输出上限。同样没有上游依据，取一个各家都吃得下的保守值。 */
const MAX_OUTPUT_TOKENS = 32_000

/** 模型目录 → DSH 的模型元数据。 */
function modelInfo(model, provider) {
  const id = typeof model === 'string' ? model : model.id
  const name = typeof model === 'string' ? model : (model.name ?? model.id)
  return {
    provider,
    id,
    name,
    context: { contextWindow: contextWindowFor(id) },
    defaultMaxTokens: MAX_OUTPUT_TOKENS,
    toolUpdate: 'in-history',
    // 委派型：我们只喂纯文本，图片进不去（CLI 的输入是 NDJSON 里的一段字符串）。
    inputModalities: ['text'],
    // 刻意**不**声明 reasoning.efforts：agy 的档位已经烧进模型 id
    // （`gemini-3.8-flash-high`），再暴露一个 effort 旋钮只会让人以为改得动。
  }
}

/**
 * 本机登录探测：跑一次 `agy models`。
 *
 * 为什么用 `models` 而不是读文件：agy 1.2.8 在 Windows **不写磁盘令牌文件**
 * （`~/.gemini/antigravity-cli/` 下只有日志与会话库），所以「有没有令牌文件」
 * 这个判据根本不成立。`agy models` 未登录时 exit=1 且 stderr 打
 * `Please sign in to view available models.`，登录后 exit=0 并列出模型——
 * 它是唯一可靠的探针，还顺带把目录一起拿回来。
 *
 * @param {object} [ctx]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{installed: boolean, signedIn: boolean, models: Array<{id: string, name: string}>, detail: string}>}
 */
export async function probeAgy(ctx, signal) {
  const bin = resolveBin(ctx, 'agy', DEFAULT_BIN)
  let result
  try {
    // stdin 由 runCli 立刻 end()：实测 `agy models` 在「EOF 过的管道」上会永久挂起。
    result = await runCli({ bin, args: ['models'], timeoutMs: MODELS_TIMEOUT_MS, signal })
  } catch (error) {
    if (error instanceof CliMissingError) {
      return { installed: false, signedIn: false, models: [], detail: error.message }
    }
    return { installed: true, signedIn: false, models: [], detail: error.message }
  }

  if (result.timedOut) {
    return { installed: true, signedIn: false, models: [], detail: `\`${bin} models\` timed out` }
  }
  const text = `${result.stdout}\n${result.stderr}`
  if (/Please sign in|not logged into Antigravity/i.test(text)) {
    return { installed: true, signedIn: false, models: [], detail: 'agy is installed but not signed in' }
  }
  if (result.code !== 0) {
    return {
      installed: true,
      signedIn: false,
      models: [],
      detail: `\`${bin} models\` exited with ${result.code}: ${result.stderr.trim().slice(-200)}`,
    }
  }
  return { installed: true, signedIn: true, models: parseModels(result.stdout), detail: '' }
}

/** 记录里的凭据标记：令牌在 agy 自己的钥匙串里，我们不持有也不复制。 */
const CLI_AUTH = { kind: 'cli', owner: 'agy' }

/** @type {import('../families.js').Family} */
export const agyFamily = {
  id: 'agy',
  displayName: 'Antigravity (Google)',
  route: 'acct-agy',
  risk: 'medium',

  // ---------------------------------------------------------------- 本机发现

  async discover(ctx) {
    const probe = await probeAgy(ctx)
    if (!probe.installed) return []
    if (!probe.signedIn) {
      return [
        {
          family: 'agy',
          label: 'agy CLI（未登录）',
          importable: false,
          reason: '本机的 agy CLI 还没有登录。先在终端里跑一次 `agy` 完成登录，再回来导入。',
        },
      ]
    }
    return [
      {
        family: 'agy',
        label: 'agy CLI（本机登录）',
        importable: true,
        externallyOwned: true,
        modelCount: probe.models.length,
        auth: { ...CLI_AUTH },
      },
    ]
  },

  /**
   * 见 codex 族同名方法的说明：统一发现的落盘入口。
   *
   * agy 这条不复制任何令牌——令牌在 agy 自己的钥匙串里，我们只记「用本机 agy 的登录态」
   * 这件事。所以记录里 `auth` 是一个标记对象，不是凭据。
   */
  recordFromDiscovery(item) {
    return withSource({
      family: 'agy',
      label: item.label ?? 'agy CLI（本机登录）',
      source: 'client-import',
      externallyOwned: true,
      auth: { ...CLI_AUTH },
      createdAt: new Date().toISOString(),
    }, item)
  },

  // ---------------------------------------------------------------- 模型目录

  async listModels(ctx, _payload, signal) {
    const probe = await probeAgy(ctx, signal)
    if (!probe.signedIn) return []
    return probe.models.map((model) => modelInfo(model, this.route))
  },

  /** 单个模型的完整元数据（`resolveModel` 要求严格回显 provider/id）。 */
  resolveModel(provider, model) {
    return modelInfo(model, provider)
  },

  // ---------------------------------------------------------------- 登录

  login: {
    methods: [{ id: 'import', label: '导入本机 agy CLI 登录' }],
    async run(session, ctx) {
      const probe = await probeAgy(ctx, session?.signal)
      if (!probe.installed) {
        throw new Error('没有找到 agy CLI。请先安装 Antigravity CLI 并在终端里完成一次登录，再回来导入。')
      }
      if (!probe.signedIn) {
        throw new Error(
          'agy CLI 已安装但尚未登录。请在**终端**里运行 `agy`，用浏览器完成登录'
            + '（这一步必须由终端做：授权码要贴在 agy 自己的控制台里，DSH 给不了它控制台）。',
        )
      }
      await session.commit({
        kind: 'grant',
        payload: {
          family: 'agy',
          label: 'agy CLI（本机登录）',
          source: 'client-import',
          externallyOwned: true,
          auth: { ...CLI_AUTH },
          createdAt: new Date().toISOString(),
        },
      })
    },
  },

  // ---------------------------------------------------------------- 推理

  /**
   * 跑一个回合。
   *
   * **用 `--input-format stream-json` 而不是 `-p=<prompt>`**：后者把提示词塞进 argv，
   * DSH 的历史动辄几万字符，撞上 Windows 的 argv 上限直接炸；stdin 那条路实测同样稳。
   * （`-p` 还有个坑：它**吃掉下一个 argv**，`agy -p --output-format x` 会把
   * `--output-format` 当成提示词。我们不用它，就不踩。）
   *
   * @param {object} ctx
   * @param {{payload: object, model: string, messages: Array, system?: string, signal?: AbortSignal}} options
   */
  async *stream(ctx, options) {
    const { model, signal } = options
    const bin = resolveBin(ctx, 'agy', DEFAULT_BIN)
    const prompt = buildPrompt(options)
    if (!prompt.trim()) {
      const error = new Error('account-bridge: empty prompt')
      error.code = 'BAD_REQUEST'
      throw error
    }

    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--print-timeout', '0s']
    if (typeof model === 'string' && model.length > 0) args.push('--model', model)

    const handle = spawnCli({ bin, args, cwd: workdirOf(ctx) })
    handle.write(`${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`)
    handle.endInput()

    let aborted = false
    const onAbort = () => {
      aborted = true
      // agy 卡在 dial-retry 循环时永远忽略 SIGTERM，所以要走进程树。
      killTree(handle.child)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => killTree(handle.child), TURN_TIMEOUT_MS)
    timer.unref?.()

    try {
      yield* translateAgyStream(handle.lines())
    } catch (error) {
      // 翻译层抛的是「上游说了什么」；这里补上进程侧的事实，让报错可诊断。
      const tail = handle.stderrText().trim().slice(-400)
      if (tail && !String(error.message).includes(tail)) error.message += ` — stderr: ${tail}`
      if (!error.code) error.code = classifyAgyFailure(error.message, handle.child.exitCode)
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      killTree(handle.child)
    }

    if (aborted) {
      const error = new Error('account-bridge: agy turn aborted')
      error.code = 'TRANSPORT'
      throw error
    }
  },
}

/**
 * agy 是 agent，会往 cwd 里写东西。给它一个专用目录，别让它污染用户的项目。
 * 没配就继承进程 cwd（报错信息里会带上 stderr，不会静默）。
 */
function workdirOf(ctx) {
  const configured = ctx?.config?.agyWorkdir
  return typeof configured === 'string' && configured.trim() ? configured.trim() : undefined
}
