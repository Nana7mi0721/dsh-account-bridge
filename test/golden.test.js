// W8 的 golden 快照：把每条翻译线的完整输入输出逐字节钉住。
//
// 用法：
//   node --test test/golden.test.js              # 比对
//   UPDATE_GOLDEN=1 node --test test/golden.test.js   # 重生成（**重生成后读一遍 diff**）
//
// 为什么要有它：本仓的翻译层有五条线（Anthropic / Chat Completions / Responses /
// Grok Responses / Qoder 私有线），每条线上几十个分支。单测能保住「我知道的那条规则」，
// 保不住「我不知道的那条也被改动了」——后者正是 W4/W8 这两个工作包反复抓到的形状：
// `pause_turn` 落进 `default`、`output_index ?? 0` 关错块、`stream_options` 悄悄
// 发了出去。全是**没有被任何断言覆盖到**的那一半。
//
// 三条自律：
// 1. 快照红了先看 diff，**不许**直接 `UPDATE_GOLDEN=1` 抹平；
// 2. 重生成时必须把新文件一起提交，否则下一个人拿到的是「默认通过」的假绿；
// 3. 易变值（时间戳、随机 id、签名）在这里**本来就不该出现**——真出现了说明
//    翻译层在凭空造值，那是要先修代码、不是先归一化。`normalise` 只兜底
//    24 位以上的十六进制串与 base64 长串，免得某个上游的随机 id 漏进来。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CASES } from './golden/cases.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, 'golden')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

/**
 * 把易变值换成占位符。
 *
 * **这一条是防御性的，不是常规路径**：翻译层是纯函数，给定同样的输入就该给同样的
 * 输出。真归一化掉了一个值，说明有东西在凭空造 id——那要先修代码。
 */
function normalise(value) {
  if (typeof value === 'string') {
    if (/^[0-9a-f]{24,}$/i.test(value)) return '<hex-token>'
    if (/^[A-Za-z0-9+/]{80,}={0,2}$/.test(value)) return '<base64-blob>'
    return value
  }
  if (Array.isArray(value)) return value.map(normalise)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = normalise(value[key])
    return out
  }
  return value
}

for (const [dir, cases] of Object.entries(CASES)) {
  for (const [name, run] of Object.entries(cases)) {
    test(`golden ${dir}/${name}`, async () => {
      const file = join(ROOT, dir, `${name}.json`)
      const actual = normalise(await run())
      if (UPDATE) {
        mkdirSync(join(ROOT, dir), { recursive: true })
        writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`, 'utf8')
        return
      }
      assert.ok(
        existsSync(file),
        `缺少快照 ${file}——先跑 UPDATE_GOLDEN=1 node --test test/golden.test.js 生成它`,
      )
      const expected = JSON.parse(readFileSync(file, 'utf8'))
      assert.deepEqual(
        actual,
        expected,
        `${dir}/${name} 的输出变了。看 diff：是你有意的改动就 UPDATE_GOLDEN=1 重生成并提交新快照；不是你改的就说明有东西被动到了`,
      )
    })
  }
}

/** 反向守卫：用例表里有的，磁盘上就得有快照；反之亦然（防止删用例留下僵尸文件）。 */
test('golden 用例表与磁盘上的快照一一对应', () => {
  const names = Object.entries(CASES).flatMap(([dir, cases]) =>
    Object.keys(cases).map((name) => `${dir}/${name}`),
  )
  const onDisk = []
  for (const dir of Object.keys(CASES)) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const file of readdirSync(abs)) {
      if (file.endsWith('.json')) onDisk.push(`${dir}/${file.replace(/\.json$/, '')}`)
    }
  }
  if (UPDATE) return
  assert.deepEqual(
    onDisk.filter((name) => !names.includes(name)),
    [],
    '磁盘上有快照但用例表里没有同名用例——用例被删了却没删快照',
  )
  assert.deepEqual(
    names.filter((name) => !onDisk.includes(name)),
    [],
    '用例表里有快照没生成——跑 UPDATE_GOLDEN=1 并提交新文件',
  )
})
