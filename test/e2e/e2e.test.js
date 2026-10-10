/**
 * 唯一的测试文件。
 *
 * 它不做断言之外的事：真正的检查全部发生在**真宿主**里（`probe/index.js`），
 * 这里只负责跑一轮、然后逐条把探针的结论变成测试结果。
 *
 * 一条纪律：**报告只有在真宿主里跑完才存在**。探针写不出报告、宿主起不来、假上游没就绪，
 * 都必须是失败，不能变成「跳过」——跳过的端到端测试等于没有测试。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runE2E } from './harness.mjs'

// 只跑一轮：一个宿主、一份报告，所有检查共用。
const report = await runE2E().catch((error) => ({ ok: false, error: String(error?.stack ?? error?.message ?? error), checks: [] }))

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
  // 四条前置 + 十九条真机检查。
  assert.ok(report.checks.length >= 23, `只有 ${report.checks.length} 条检查，少于预期的 23 条`)
})
