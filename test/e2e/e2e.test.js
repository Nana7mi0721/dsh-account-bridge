/**
 * 唯一的测试文件。
 *
 * 它不做断言之外的事：真正的检查发生在两处**报告生产者**里，这里只负责跑一轮、
 * 然后逐条把它们的结论变成测试结果：
 *   · `probe/index.js` —— 跑在**真宿主**里，摸的是数据面（provider、池子、失败归类、翻译层）；
 *   · `client-render.mjs` —— 跑在**本进程**里，把 `src/client.js` 用 mini-react 渲染一遍，
 *     摸的是前端那一半（面板坏了不会有任何宿主症状，所以它需要自己这一份）。
 *
 * 一条纪律：**报告只有在真跑完才存在**。探针写不出报告、宿主起不来、假上游没就绪，
 * 都必须是失败，不能变成「跳过」——跳过的端到端测试等于没有测试。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runClientRender } from './client-render.mjs'
import { runE2E } from './harness.mjs'

// 只跑一轮：一个宿主、一份报告，所有检查共用。
const report = await runE2E().catch((error) => ({ ok: false, error: String(error?.stack ?? error?.message ?? error), checks: [] }))
const client = await runClientRender().catch((error) => ({ error: String(error?.stack ?? error?.message ?? error), checks: [] }))

test('端到端：宿主起来了，探针把报告写出来了', () => {
  assert.equal(report.error, null, `这一轮根本没跑起来：\n${report.error}`)
  assert.ok(report.checks.length > 0, '报告里一条检查都没有——探针可能半路停了')
})

for (const check of report.checks) {
  test(`端到端：${check.name}`, () => {
    assert.ok(check.pass, check.detail || '没有细节')
  })
}

test('端到端：探针把该跑的检查都跑了', () => {
  // 探针中途抛错时报告是半截的，条数会掉下来。这个下限就是「跑全了」的凭据：
  // 四条前置 + 二十六条真机检查。
  assert.ok(report.checks.length >= 34, `只有 ${report.checks.length} 条检查，少于预期的 34 条`)
})

test('前端：客户端模块在 Node 里渲染得出来', () => {
  assert.equal(client.error, null, `这一轮根本没跑起来：\n${client.error}`)
  assert.ok(client.checks.length > 0, '一条前端检查都没有')
})

for (const check of client.checks) {
  test(`前端：${check.name}`, () => {
    assert.ok(check.pass, check.detail || '没有细节')
  })
}

test('前端：该检查的分支都检查了', () => {
  // 少一条就说明渲染中途抛错了（报告是半截的，但 error 可能为 null —— 比如某个断言
  // 之后才炸）。21 条是目前的全量。
  assert.ok(client.checks.length >= 21, `只有 ${client.checks.length} 条前端检查，少于预期的 21 条`)
})
