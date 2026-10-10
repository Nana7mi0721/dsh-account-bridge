/**
 * 起宿主之前的三条静态检查。
 *
 * 为什么它们不算「单元测试」：这三条都**只有看源码才知道**，而它们对应的后果都得跑完一整轮
 * 端到端才看得见——一件是插件根本加载不了，一件是许可出了问题，一件是可能写坏用户的宿主编排。
 * 端到端能证明「行为对」，证明不了「这次没越界」，所以门槛放在端到端的前一步、同一份报告里。
 *
 * 一条纪律：**这里只放「源码里能一眼判定、且后果很贵」的规矩**，不搬任何逻辑断言进来。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 递归列出某个目录下的 .js（含子目录）。 */
function sources(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full))
    else if (entry.name.endsWith('.js')) found.push(full)
  }
  return found
}

const read = (file) => readFileSync(file, 'utf8')

/**
 * 跑完全部前置检查。
 *
 * @param {string} repo 仓库根目录
 * @returns {Array<{name:string, pass:boolean, detail:string}>}
 */
export function preflight(repo) {
  const src = join(repo, 'src')
  const files = sources(src)
  const checks = []

  // 1. 不许按裸模块名 import 核心包。核心包住在 app.asar 里，插件目录解析不到：
  //    真机上就是一句 `ERR_MODULE_NOT_FOUND`，而那时候宿主已经起来了，看起来像别的问题。
  const coreImport = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](@deepseek-ai\/[^'"]+)['"]/g
  const offences = []
  for (const file of files) {
    for (const match of read(file).matchAll(coreImport)) offences.push(`${relative(repo, file)}: ${match[1]}`)
  }
  checks.push({
    name: '前置：没有源码按裸模块名 import 核心包',
    pass: offences.length === 0,
    detail: offences.join(', ') || '（核心能力只能经 ctx 服务取）',
  })

  // 2. 借来的代码必须登记，且登记过的文件要指回台账。许可不同（MIT / Apache-2.0 / AGPL-3.0），
  //    台账是唯一能回答「这一行是从哪来的」的地方。
  const notices = read(join(repo, 'THIRD_PARTY_NOTICES.md'))
  const listed = [...notices.matchAll(/`(src\/[^`]+?\.js)`/g)].map((match) => match[1])
  const unmarked = listed.filter((path) => {
    try {
      return !read(join(repo, path)).includes('THIRD_PARTY_NOTICES.md')
    } catch {
      return true
    }
  })
  checks.push({
    name: '前置：台账里列出的每个文件都指回 THIRD_PARTY_NOTICES.md',
    pass: listed.length > 0 && unmarked.length === 0,
    detail: unmarked.length ? `没有注明来源：${unmarked.join(', ')}` : `台账登记 ${listed.length} 个文件`,
  })

  // 3. 会写盘的源码文件只准是那两个族（它们要刷新桌面端的凭据文件，且都带 CAS）。
  //    多出第三个就意味着有人在别处动用户的文件——那条路一旦走错，用户的登录态就没了。
  const writers = files
    .filter((file) => /\b(writeFileSync|writeFile|renameSync|rmSync|unlinkSync)\s*\(/.test(read(file)))
    .map((file) => relative(repo, file).replace(/\\/g, '/'))
  const allowed = new Set(['src/families/grok.js', 'src/families/minimax.js'])
  const strangers = writers.filter((path) => !allowed.has(path))
  checks.push({
    name: '前置：会写盘的源码只有那两个要刷新客户端凭据的族',
    pass: strangers.length === 0,
    detail: strangers.length ? `新出现会写盘的文件：${strangers.join(', ')}` : `会写盘的：${writers.join(', ') || '（无）'}`,
  })

  // 台账与文档本身还在（有人在重构里删掉一整节是很常见的）。
  const docs = join(repo, 'docs', 'host-writes.md')
  const rows = ['agent-default-model', 'llm-pi-ai', 'web-search-deepseek', 'llm-deepseek', 'agent-loop', 'api-gateway']
  let missingRows = []
  try {
    const text = read(docs)
    missingRows = rows.filter((row) => !text.includes(row))
  } catch {
    missingRows = ['docs/host-writes.md 不存在']
  }
  checks.push({
    name: '前置：宿主配置的红线文档还在（六条不能碰的 row id）',
    pass: missingRows.length === 0,
    detail: missingRows.join(', '),
  })

  return checks
}

/** 只为断言用：仓库里所有 .js 的相对路径。 */
export function sourceList(repo) {
  return sources(join(repo, 'src')).map((file) => relative(repo, file).replace(/\\/g, '/'))
}
