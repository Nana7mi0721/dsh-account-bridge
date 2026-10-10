/**
 * 端到端验收的编排器。
 *
 * 一次 `runE2E()` 做四件事：
 *   1. 起假上游（`mock-upstream.mjs`，端口由系统分配）
 *   2. 起一个**真的无头宿主**（就是用户桌面版那个可执行文件，`ELECTRON_RUN_AS_NODE=1`
 *      让它以 node 跑 CLI），profile 是专用的 `e2e`，插件以 `link:` 装进去，所以改源码
 *      即时生效，不必重装
 *   3. 等宿主里的探针（`probe/index.js`）把报告写成 JSON——探针自己决定检查什么
 *   4. 收摊：把宿主进程树与假上游都杀掉，并**等到端口真的空出来**再返回
 *
 * 为什么非要起真宿主：这个插件是**进程内适配器**。它有没有被宿主认成 provider、宿主的
 * `llm.stream()` 拿到什么、换号之后调用方看见哪一段——单测里没有宿主，答不了这些问题。
 *
 * 第一次跑某台机器时会慢：`fresh` profile 的经验是空白 home 上 `plugin add` 会把
 * `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 一起装上（走网络）。之后是秒级。
 * 装在 `test/e2e/.home`（已 gitignore），**不动用户自己的 `~/.dsh`**。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { preflight } from './preflight.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..')
const MOCK = join(HERE, 'mock-upstream.mjs')
const PROBE = join(HERE, 'probe')

export const API_PORT = 3080
export const MOCK_KEY = 'sk-mock-secret'

/** 宿主可执行文件与 CLI 脚本：环境变量可覆盖，默认是这台机器上的桌面版。 */
export function hostPaths(env = process.env) {
  const home = env.DSH_DESKTOP ?? 'D:\\Program\\deepseek harness desktop'
  return {
    exe: env.DSH_HOST_EXE ?? join(home, 'DeepSeek Harness.exe'),
    cli: env.DSH_HOST_CLI ?? join(home, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    archive: join(home, 'resources', 'app.asar'),
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 让系统给一个空闲端口（绑 0 再放开），免得多轮验收互相撞车。 */
export function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

async function portFree(port, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const free = await new Promise((done) => {
      const socket = createServer()
      socket.once('error', () => done(false))
      socket.once('listening', () => socket.close(() => done(true)))
      socket.listen(port, '127.0.0.1')
    })
    if (free) return true
    if (Date.now() > until) return false
    await sleep(200)
  }
}

/** 杀掉一整棵进程树。Windows 上 `child.kill()` 管不到子进程，必须 taskkill /T。 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 进程可能刚好自己退了 */
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 同上 */
    }
  }
}

/** 攒住子进程的输出，出问题时把尾巴贴进错误里——没有日志的失败最难查。 */
function collect(child, limit = 40_000) {
  const state = { text: '' }
  const take = (buf) => {
    state.text = (state.text + buf.toString('utf8')).slice(-limit)
  }
  child.stdout?.on('data', take)
  child.stderr?.on('data', take)
  return state
}

function tail(text, lines = 25) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(-lines)
    .join('\n')
}

/**
 * 跑一次 `plugin add`，判定「装好了没有」。
 *
 * 这里**不能只看退出码**：pnpm 打印完 `Done in 2.4s using pnpm v11.7.0` 之后，
 * CLI 进程不会自己退出（实测挂满 600 秒后被我们杀掉，退出码 -2）——那是这个
 * 宿主 CLI 的行为，不是安装失败。所以成功的判据是**日志**：出现过 `Done in`，
 * 且之后几秒没有任何新输出（真还有第二轮 pnpm 在跑的话，进度行不会安静这么久）。
 * 反之，日志里出现 `plugin command failed` / `installation rejected` /
 * `ERR_PNPM_…` 就是失败，立刻收摊，不陪着挂。
 */
async function pluginAdd({ exe, cli, home, profile, dir, env, timeoutMs = 300_000, quietMs = 6_000 }) {
  const child = spawn(exe, [cli, 'plugin', '--profile', profile, 'add', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
  })
  const log = collect(child)
  const failed = /plugin command failed|installation rejected|ERR_PNPM_/
  let exited = null
  child.on('error', (error) => {
    exited = { code: -1, why: String(error.message) }
  })
  child.on('close', (status) => {
    exited = { code: status ?? -1, why: '' }
  })

  const until = Date.now() + timeoutMs
  let seen = -1
  let quietSince = Date.now()
  for (;;) {
    if (log.text.length !== seen) {
      seen = log.text.length
      quietSince = Date.now()
    }
    if (exited) {
      killTree(child)
      return { code: exited.code, why: exited.why, log }
    }
    if (failed.test(log.text)) {
      killTree(child)
      return { code: 1, why: '命令行自己报了错', log }
    }
    if (/Done in \d/.test(log.text) && Date.now() - quietSince >= quietMs) {
      killTree(child)
      return { code: 0, why: '', log }
    }
    if (Date.now() > until) {
      killTree(child)
      return { code: -2, why: `${timeoutMs} 毫秒还没装完`, log }
    }
    await sleep(200)
  }
}

/** 起假上游，等它就绪。 */
export async function startMock({ port, quiet = true } = {}) {
  const where = port ?? (await freePort())
  const child = spawn(process.execPath, [MOCK, String(where)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const log = collect(child)
  const until = Date.now() + 10_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`假上游起不来（退出码 ${child.exitCode}）：\n${tail(log.text)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${where}/__ready`)
      if (response.ok) break
    } catch {
      /* 还没监听上 */
    }
    if (Date.now() > until) throw new Error(`假上游 10 秒内没有就绪：\n${tail(log.text)}`)
    await sleep(100)
  }
  if (!quiet) child.stdout.pipe(process.stdout)
  return { port: where, base: `http://127.0.0.1:${where}`, child, log, stop: () => killTree(child) }
}

/**
 * 宿主自己带着的 web-app 与 runtime 版本号。
 *
 * 为什么要问它：`dsh plugin add @deepseek-ai/dsh-web-app` **不带版本号是装不上的**——npm 上的
 * `latest` 是 `0.0.1-rc.1`，与我们这台宿主（`0.2.0-rc.2`）peer 不兼容，插件管理器会拒绝安装。
 * 版本号必须与宿主一致，而唯一权威的来源就是宿主自己那份 `package.json`。
 *
 * 读 asar 里的路径是可以的：Electron 给 `fs` 打了补丁，`ELECTRON_RUN_AS_NODE=1` 下依然有效
 * （实测读得出 `0.2.0-rc.2`）。读不到就退回去问 CLI 的 `--version`。
 */
async function discoverHostBundleVersions({ exe, cli, archive, env }) {
  if (env.BRIDGE_E2E_WEBAPP_VERSION) return { webApp: env.BRIDGE_E2E_WEBAPP_VERSION, source: '环境变量' }
  const script =
    'const fs=require("fs");const pick=(p)=>{try{return JSON.parse(fs.readFileSync(p,"utf8")).version}catch{return null}};' +
    `const root=${JSON.stringify(archive)};` +
    'process.stdout.write(JSON.stringify({webApp:pick(root+"/dsh/node_modules/@deepseek-ai/dsh-web-app/package.json"),' +
    'runtime:pick(root+"/dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json")}))'
  const run = (args) =>
    new Promise((done) => {
      const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
      const log = collect(child, 4_000)
      child.on('error', () => done(''))
      child.on('close', () => done(log.text))
    })
  try {
    const answer = JSON.parse(await run(['-e', script]))
    if (answer.webApp) return { webApp: answer.webApp, runtime: answer.runtime, source: 'asar' }
    if (answer.runtime) return { webApp: answer.runtime, runtime: answer.runtime, source: 'asar(runtime)' }
  } catch {
    /* 掉到下面的 CLI 兜底 */
  }
  const version = (await run([cli, '--version'])).trim().split('\n').pop()?.trim()
  if (/^\d/.test(version ?? '')) return { webApp: version, runtime: version, source: 'cli --version' }
  throw new Error('问不出宿主的版本号：asar 读不到，`--version` 也没有回话。用 BRIDGE_E2E_WEBAPP_VERSION 直接给。')
}

/**
 * 把插件与探针装进专用 profile。已经装过就跳过——这里省下的几秒在多轮验收里很值钱。
 * 用绝对路径 `add`，pnpm 会建成 `link:`，所以源码改动**即时生效**，不必重装。
 *
 * 一个坑（踩过）：插件管理器给**新** profile 的默认 bundle 只有 `@deepseek-ai/dsh-base`，
 * **不含 web-app** ⇒ 宿主机根本不开 HTTP 服务 ⇒ 回环数据面整块测不到（探针那边表现为
 * `fetch failed`）。所以这里先把 `@deepseek-ai/dsh-web-app` 写进依赖与 bundles，再让
 * `plugin add` 顺带把它装上。
 */
export async function bootstrapProfile({ home, profile, env = process.env, timeoutMs = 600_000 }) {
  const { exe, cli, archive } = hostPaths(env)
  if (!existsSync(exe)) throw new Error(`找不到宿主可执行文件：${exe}（用 DSH_DESKTOP / DSH_HOST_EXE 指路）`)
  // CLI 脚本住在 asar 里，**磁盘上没有这个文件**（`existsSync` 一定为 false），
  // Electron 自己会把它当路径解析。所以这里只能检查那个归档在不在。
  if (!existsSync(cli) && !existsSync(archive)) {
    throw new Error(`找不到宿主 CLI：${cli}（用 DSH_HOST_CLI 指路，或给 DSH_DESKTOP）`)
  }

  const dir = join(home, 'profiles', profile)
  const manifest = join(dir, 'package.json')
  mkdirSync(dir, { recursive: true })

  // pnpm 的构建脚本闸门：koffi 要现编译。不显式允许的话整次安装会以
  // `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.1.1` 中止 ——
  // 而那时候 web-app 已经解包一半了，看起来像别的问题。
  // 注意宿主自己会先写一份占位：`koffi: set this to true or false`。占位也算「有」，
  // 所以不能只判键在不在，要把那一行换成 true。
  const workspace = join(dir, 'pnpm-workspace.yaml')
  const workspaceText = existsSync(workspace) ? readFileSync(workspace, 'utf8') : 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
  const allowed = /allowBuilds:\n(\s+koffi:.*\n)/
  const patched = allowed.test(workspaceText)
    ? workspaceText.replace(allowed, 'allowBuilds:\n  koffi: true\n')
    : `${workspaceText.replace(/\s*$/, '')}\nallowBuilds:\n  koffi: true\n`
  if (patched !== workspaceText) writeFileSync(workspace, patched)

  const versions = await discoverHostBundleVersions({ exe, cli, archive, env })
  const doc = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { name: `dsh-profile-${profile}`, private: true }
  doc.dependencies = { ...(doc.dependencies ?? {}), '@deepseek-ai/dsh-web-app': doc.dependencies?.['@deepseek-ai/dsh-web-app'] ?? versions.webApp }
  // bundle 的顺序＝加载顺序。`base` 必须最前，`web-app` 紧随（HTTP 服务与界面壳都在里面），
  // 插件排最后。宿主自己 append 的顺序不保证这一点，所以每次都由我们排好。
  const ordered = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-account-bridge', 'dsh-e2e-probe']
  const extra = (doc.dsh?.profile?.bundles ?? []).filter((name) => !ordered.includes(name))
  doc.dsh = { ...(doc.dsh ?? {}), profile: { ...(doc.dsh?.profile ?? {}), bundles: [...ordered, ...extra] } }
  writeFileSync(manifest, `${JSON.stringify(doc, null, 2)}\n`)

  // 装好了就别再动：`plugin add` 每次都要跑 pnpm，几十秒起步。上一轮装到一半失败过的
  // profile 不能当「装好了」——所以认我们自己的戳，而不是「node_modules 里有个目录」。
  const stamp = join(dir, '.e2e-bootstrapped')
  const installed = (dir_) =>
    existsSync(stamp) &&
    existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-app')) &&
    readFileSync(manifest, 'utf8').includes(`link:${dir_}`)
  const missing = [REPO, PROBE].filter((dir_) => !installed(dir_))
  if (missing.length === 0) return { manifest, versions }

  for (const dir_ of [REPO, PROBE]) {
    const outcome = await pluginAdd({ exe, cli, home, profile, dir: dir_, env, timeoutMs })
    if (outcome.code !== 0) {
      throw new Error(`装 ${dir_} 到 profile ${profile} 失败（${outcome.why || `退出码 ${outcome.code}`}）：\n${tail(outcome.log.text)}`)
    }
  }
  writeFileSync(stamp, `${new Date().toISOString()} ${versions.source} ${versions.webApp}\n`)
  return { manifest, versions }
}

/**
 * 跑一轮端到端验收，返回探针那份报告。
 *
 * @param {{home?:string, profile?:string, timeoutMs?:number, verbose?:boolean}} options
 * @returns {Promise<{ok:boolean, checks:Array<{name:string,pass:boolean,detail:string}>, error:string|null, host:string, mock:string}>}
 */
export async function runE2E({ home, profile = 'e2e', timeoutMs = 240_000, verbose = false } = {}) {
  const env = process.env
  const { exe, cli } = hostPaths(env)
  const root = resolve(home ?? process.env.BRIDGE_E2E_HOME ?? join(HERE, '.home'))
  const report = join(root, 'report.json')
  mkdirSync(root, { recursive: true })
  rmSync(report, { force: true })

  await bootstrapProfile({ home: root, profile, env })

  const mock = await startMock()
  // 上一轮如果没退干净，这里会看到 3080 被占；等它自己消失比直接失败好，但要有限度。
  if (!(await portFree(API_PORT, 5_000))) {
    mock.stop()
    throw new Error(`端口 ${API_PORT} 还被占着——上一轮宿主没退干净，先把它关掉再跑`)
  }

  const host = spawn(exe, [cli, '--profile', profile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: root,
      BRIDGE_MOCK_BASE: mock.base,
      BRIDGE_MOCK_KEY: MOCK_KEY,
      BRIDGE_E2E_OUT: report,
    },
  })
  const log = collect(host)
  if (verbose) host.stdout.pipe(process.stdout)

  const until = Date.now() + timeoutMs
  let payload = null
  let note = '探针没有写报告'
  for (;;) {
    if (existsSync(report)) {
      // 探针先把文件建起来再写完，读到解析不了就再等一拍。
      try {
        payload = JSON.parse(readFileSync(report, 'utf8'))
        break
      } catch {
        /* 还在写 */
      }
    }
    if (host.exitCode !== null) {
      note = `宿主提前退出（退出码 ${host.exitCode}）`
      break
    }
    if (Date.now() > until) {
      note = `宿主 ${Math.round(timeoutMs / 1000)} 秒内没有给出报告`
      break
    }
    await sleep(300)
  }

  killTree(host)
  const hostLog = tail(log.text, 40)
  await portFree(API_PORT, 20_000)
  mock.stop()

  if (!payload) throw new Error(`${note}。宿主日志尾部：\n${hostLog}`)
  // 前置检查与探针的检查放在同一份报告里：只有一套测试，就只有一份结论。
  return { ...payload, checks: [...preflight(REPO), ...(payload.checks ?? [])], host: hostLog, mock: tail(mock.log.text, 40) }
}

/** 让 `node test/e2e/harness.mjs` 直接跑一轮，方便手工排查（不进 CI，也不被测试文件 import 时触发）。 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const verbose = !process.argv.includes('--quiet')
  runE2E({ verbose })
    .then((report) => {
      const failed = report.checks.filter((check) => !check.pass)
      console.log(`\n${report.checks.length - failed.length}/${report.checks.length} 通过`)
      for (const check of failed) console.log(`  FAIL ${check.name} — ${check.detail}`)
      if (report.error) console.log(`\n探针抛错：\n${report.error}`)
      if (verbose && failed.length) console.log(`\n宿主日志尾部：\n${report.host}`)
      process.exitCode = report.ok ? 0 : 1
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 2
    })
}

// 报告落盘的位置也导出一下，测试文件要用它解释失败。
export const reportPath = (home) => join(resolve(home ?? process.env.BRIDGE_E2E_HOME ?? join(HERE, '.home')), 'report.json')
