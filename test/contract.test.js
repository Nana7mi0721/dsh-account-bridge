/**
 * 真机才会暴露的两条契约，钉成回归测试。
 *
 * 两条都是「假宿主测不出来、真机一跑就炸」的类型：
 * 1. `registerAdapter` 对适配器做**鸭子类型检查**，缺方法当场抛错；
 * 2. 插件按**裸模块名** import 核心包会 ERR_MODULE_NOT_FOUND。
 * 前者已在真机上复现并修好，后者决定了本插件只能经 `ctx` 服务取核心能力。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { AccountBridgeAdapter } from '../src/pool.js'

/**
 * `@deepseek-ai/dsh-llm` 的 `registerAdapter` → `prepareRoutes` 会**无条件**调用这些方法：
 * 注册时调 `providerInfo` 与 `providerRetryPolicy`（`?? resolveRetryPolicy(...)` 只兜返回值，
 * 兜不住「方法不存在」），运行中再调其余五个。
 */
const RUNTIME_ADAPTER_METHODS = [
  'providerInfo',
  'providerRetryPolicy',
  'imageRequestPricing',
  'listModels',
  'resolveModel',
  'prepareCall',
  'stream',
]

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 递归列出 src 下的全部 .js。 */
async function listSources(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await listSources(full)))
    else if (entry.name.endsWith('.js')) found.push(full)
  }
  return found
}

test('the adapter implements every method the llm runtime calls on it', () => {
  const adapter = new AccountBridgeAdapter({
    ctx: {},
    store: {},
    health: {},
    families: [],
    log: { info() {}, warn() {}, error() {} },
  })
  for (const method of RUNTIME_ADAPTER_METHODS) {
    assert.equal(typeof adapter[method], 'function', `adapter.${method} must be a function`)
  }
})

test('providerRetryPolicy returns undefined so the host default policy applies', () => {
  const adapter = new AccountBridgeAdapter({
    ctx: {},
    store: {},
    health: {},
    families: [],
    log: { info() {}, warn() {}, error() {} },
  })
  // 返回 undefined（而不是抛出）＝沿用宿主默认策略：5 次重试、500ms 起、上限 10s、抖动 0.1。
  assert.equal(adapter.providerRetryPolicy('acct-codex'), undefined)
  assert.equal(adapter.imageRequestPricing('acct-codex', 'gpt-5-codex'), undefined)
})

test('no source file imports a @deepseek-ai package by bare specifier', async () => {
  const offences = []
  // 匹配 `from '@deepseek-ai/...'`、`import('@deepseek-ai/...')`、`require("@deepseek-ai/...")`。
  const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](@deepseek-ai\/[^'"]+)['"]/g
  for (const file of await listSources(SRC_DIR)) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(pattern)) {
      offences.push(`${path.relative(SRC_DIR, file)}: ${match[1]}`)
    }
  }
  assert.deepEqual(
    offences,
    [],
    'core packages live inside the app.asar and are NOT resolvable from a plugin directory; ' +
      'reach them through ctx services instead (verified on a real host: ERR_MODULE_NOT_FOUND)',
  )
})

/**
 * 接受了 `onDiagnostic` 的翻译函数——漏传就等于那一路的诊断**只存在于测试里**。
 *
 * 这条守卫是被一次真实疏漏逼出来的：W8 把十二条诊断码加进翻译层、单测全绿，但
 * `translateChatStream` 的三个调用点（generic / workbuddy / copilot）一个都没传
 * `onDiagnostic`，`translateResponsesStream`、`translateGrokStream`、两处
 * `toResponsesInput`、三处 `toAnthropicMessages` 同样。翻译层于是「会报告」，
 * 而生产路径上永远没有人在听——比不报告更糟，因为它让文档里那句话变成假的。
 */
const DIAGNOSTIC_AWARE = [
  'toAnthropicMessages',
  'toChatMessages',
  'translateAnthropicStream',
  'translateChatStream',
  'translateResponsesStream',
  'translateGrokStream',
  'translateCommandCodeStream',
  'toResponsesInput',
  'buildGrokBody',
]

/** 从 `名字(` 之后的左括号开始，配平括号，返回整段调用。 */
function callAt(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start)
}

test('every family passes onDiagnostic to the translators that accept one', async () => {
  const offences = []
  const dir = path.join(SRC_DIR, 'families')
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const file = path.join(dir, entry.name)
    const text = await readFile(file, 'utf8')
    for (const name of DIAGNOSTIC_AWARE) {
      const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g')
      for (const match of text.matchAll(pattern)) {
        const call = callAt(text, match.index + match[0].length - 1)
        if (!call.includes('onDiagnostic')) {
          offences.push(`${entry.name}: ${name}(…) has no onDiagnostic`)
        }
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    'a translator that can report but is never given a reporter is worse than one that ' +
      'stays silent: the docs claim it reports. Pass onDiagnostic: diagnosticReporter(ctx, options.onDiagnostic).',
  )
})
