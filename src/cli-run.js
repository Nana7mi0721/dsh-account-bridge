/**
 * 驱动上游 CLI 的子进程层（目前只有 agy 一族用）。
 *
 * 为什么需要单独一层：上游 CLI 的怪癖跟业务无关，但每条都会咬人——
 * - **Windows 上必须按进程树杀**：agy 卡在 dial-retry 循环时**永远忽略 SIGTERM**
 *   （agy-link 的注释原话），只 `child.kill()` 会留下僵尸；
 * - **超时要自己设**：`agy models` 在 stdin 是「EOF 过的管道」时会**永久挂起**
 *   （实测：`printf '' | agy models` 超过 60 秒不返回），CLI 自己不给超时；
 * - **stdin 必须显式处理**：不给输入就立刻 `end()`，否则有的子命令会等 EOF 等到天荒地老。
 * @module dsh-account-bridge/cli-run
 */

import { spawn } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

/** 可执行文件找不到时抛这个，`classify()` 会把它归成 AUTH 之外的本地配置问题。 */
export class CliMissingError extends Error {
  constructor(bin) {
    super(
      `account-bridge: cannot run "${bin}" — it is not on PATH. Install it, or set the plugin's "…Bin" option to its full path.`,
    )
    this.code = 'CLI_MISSING'
    this.bin = bin
  }
}

/**
 * 取某族要用 CLI 路径：配置项优先，其次默认名（交给 PATH 解析）。
 * 配置项名约定 `<familyId>Bin`。
 */
export function resolveBin(ctx, familyId, fallback) {
  const configured = ctx?.config?.[`${familyId}Bin`]
  return typeof configured === 'string' && configured.trim() ? configured.trim() : fallback
}

/** 按进程树结束子进程（Windows 用 taskkill，POSIX 用进程组）。 */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

/**
 * 起一个子进程。
 *
 * @param {object} options
 * @param {string} options.bin
 * @param {string[]} [options.args]
 * @param {Record<string,string|undefined>} [options.env] 追加/覆盖的环境变量
 * @param {string} [options.cwd]
 * @returns {{child: import('node:child_process').ChildProcess, lines: () => AsyncGenerator<string>, write: (text: string) => void, endInput: () => void, exited: Promise<{code: number|null, signal: string|null}>, kill: () => void, stderrText: () => string}}
 */
export function spawnCli({ bin, args = [], env = {}, cwd }) {
  const child = spawn(bin, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX 下开进程组，才能一次杀掉整棵树。
    detached: !IS_WIN,
    env: { ...process.env, ...env },
  })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    // 只留尾部，避免上游刷屏把内存吃光。
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
  })

  // spawn 失败（比如可执行文件不存在）走 'error' 事件，不会进 stderr。
  // 必须单独记下来：只靠退出码分不清「命令跑失败了」和「命令根本没跑起来」。
  let spawnError
  child.on('error', (error) => {
    spawnError = error
  })

  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }))
  })

  /** 按行读 stdout 的异步生成器；跨 chunk 的撕裂行会被拼回来。 */
  async function* lines() {
    child.stdout.setEncoding('utf8')
    let buffer = ''
    for await (const chunk of child.stdout) {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim()) yield line
        index = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) yield buffer.replace(/\r$/, '')
  }

  // spawn 失败时往 stdin 写会抛 EPIPE；这个监听器只是把那个噪声吞掉，
  // 真正的诊断信息在 spawnError 里。
  child.stdin?.on('error', () => {})

  return {
    child,
    lines,
    write: (text) => {
      if (child.stdin.writable) child.stdin.write(text)
    },
    endInput: () => {
      if (child.stdin.writable) child.stdin.end()
    },
    exited,
    kill: () => killTree(child),
    stderrText: () => stderr || spawnError?.message || '',
    spawnError: () => spawnError,
  }
}

/**
 * 跑一个子进程并缓冲全部输出。给 `agy models` 这类一次性命令用。
 *
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export async function runCli({ bin, args = [], env = {}, cwd, timeoutMs = 30_000, signal }) {
  const handle = spawnCli({ bin, args, env, cwd })
  handle.endInput()

  let stdout = ''
  handle.child.stdout.setEncoding('utf8')
  handle.child.stdout.on('data', (chunk) => {
    stdout += chunk
    if (stdout.length > 512_000) stdout = stdout.slice(-256_000)
  })

  let timedOut = false
  let timer
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      handle.kill()
    }, timeoutMs)
    timer.unref?.()
  }

  const onAbort = () => handle.kill()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const { code } = await handle.exited
    // 先看 spawn 有没有成功。只判退出码会把「没装 CLI」当成一次普通失败，
    // 让上层以为「装是装了、只是没登录」，给出的指引就完全错了。
    const failed = handle.spawnError()
    if (failed) {
      if (isMissingBinary(failed)) throw new CliMissingError(bin)
      throw failed
    }
    if (code === null && handle.stderrText() === '') throw new CliMissingError(bin)
    return { code, stdout, stderr: handle.stderrText(), timedOut }
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 判断 `spawn` 抛出的 ENOENT 是不是「可执行文件不存在」。 */
export function isMissingBinary(error) {
  return error?.code === 'ENOENT' || error?.code === 'CLI_MISSING'
}
