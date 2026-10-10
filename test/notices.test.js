// W0 工程基线：许可与署名台账的自检。
//
// 这不是「文档检查」——它是一条**双向**约束：
//   台账说要借某个文件 → 那个文件必须存在，且头部必须写着来源于台账。
// 反过来，借了却没登记会在这里被抓住。加借用代码时先跑它。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** 抓 `## 借用的代码` 到下一个 `## ` 标题之间的所有表格行。 */
function borrowTableRows() {
  const text = read('THIRD_PARTY_NOTICES.md')
  const start = text.indexOf('## 借用的代码')
  assert.ok(start >= 0, 'THIRD_PARTY_NOTICES.md 里找不到 "## 借用的代码" 一节')
  const rest = text.slice(start + 1)
  const next = rest.indexOf('\n## ')
  assert.ok(next > 0, '"## 借用的代码" 之后必须有下一个 "## " 标题（计划借用 / 只学规格…）')
  const body = rest.slice(0, next)

  const rows = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // cells[0] 是行首竖线前的空串；真正的列是 cells[1..]
    const [, upstream, usedIn] = cells
    if (!upstream || upstream === '上游文件' || /^-+$/.test(upstream)) continue
    if (!usedIn) continue
    rows.push({ upstream, usedIn, line: line.trim() })
  }
  return rows
}

/** 抓 `## 只学规格、未借用代码` 到下一个 `## ` 标题之间的所有表格行。 */
function specTableRows() {
  const text = read('THIRD_PARTY_NOTICES.md')
  const start = text.indexOf('## 只学规格、未借用代码')
  assert.ok(start >= 0, 'THIRD_PARTY_NOTICES.md 里找不到 "## 只学规格、未借用代码" 一节')
  const rest = text.slice(start + 1)
  const next = rest.indexOf('\n## ')
  const body = next > 0 ? rest.slice(0, next) : rest

  const rows = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // 这一节的列是：上游 | 落地点 | 学的是什么
    const [, upstream, usedIn] = cells
    if (!upstream || upstream === '上游' || /^-+$/.test(upstream)) continue
    if (!usedIn) continue
    rows.push({ upstream, usedIn, line: line.trim() })
  }
  return rows
}

/** 从「用在本仓」单元格里挑出所有 `src/...` / `test/...` 路径。 */
function filesIn(cell) {
  const out = []
  const re = /`((?:src|test)\/[^`]+)`/g
  let m
  while ((m = re.exec(cell)) !== null) out.push(m[1])
  return out
}

function jsFilesUnder(dir) {
  const out = []
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const absChild = join(abs, name)
      const relChild = `${rel}/${name}`
      if (statSync(absChild).isDirectory()) walk(absChild, relChild)
      else if (name.endsWith('.js')) out.push(relChild)
    }
  }
  walk(join(ROOT, dir), dir)
  return out
}

test('LICENSE 是 MIT，且 package.json 声明一致', () => {
  const license = read('LICENSE')
  assert.match(license, /^MIT License/, 'LICENSE 首行必须是 "MIT License"')
  assert.match(license, /Copyright \(c\) \d{4} /, 'LICENSE 必须有版权行')
  assert.equal(JSON.parse(read('package.json')).license, 'MIT')
})

test('THIRD_PARTY_NOTICES.md 会随包发布（它同时是许可要求的署名）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(
    pkg.files.includes('THIRD_PARTY_NOTICES.md'),
    'package.json 的 files 必须含 THIRD_PARTY_NOTICES.md，否则装到别人机器上就没有署名文件了',
  )
})

test('台账里每一条「用在本仓」的文件都存在，且头部写着来源于台账', () => {
  const rows = borrowTableRows()
  for (const row of rows) {
    const files = filesIn(row.usedIn)
    assert.ok(files.length > 0, `台账行没有指出用在本仓的哪个文件：${row.line}`)
    for (const rel of files) {
      const abs = join(ROOT, rel)
      assert.ok(existsSync(abs), `台账指向了不存在的文件 ${rel}（来自：${row.upstream}）`)
      const source = read(rel)
      assert.match(
        source,
        /THIRD_PARTY_NOTICES\.md/,
        `${rel} 的头部必须注明来源并指向 THIRD_PARTY_NOTICES.md（台账行：${row.line}）`,
      )
    }
  }
})

test('反方向：源码里声称「借自某上游」的，台账里必须有登记', () => {
  // 两节都算数：「借用的代码」与「只学规格、未借用代码」。区别在于前者还要过
  // 下面那条 AGPL 守卫（不许出现 relaykit），后者不需要——它本来就不抄代码。
  const registered = new Set()
  for (const row of [...borrowTableRows(), ...specTableRows()]) {
    for (const rel of filesIn(row.usedIn)) registered.add(rel)
  }

  const suspects = []
  for (const rel of jsFilesUnder('src')) {
    const source = read(rel)
    if (!/THIRD_PARTY_NOTICES\.md/.test(source)) continue
    if (!registered.has(rel)) suspects.push(rel)
  }
  assert.deepEqual(
    suspects,
    [],
    '这些文件自称借用了上游代码，却没在 THIRD_PARTY_NOTICES.md 的「借用的代码」或「只学规格、未借用代码」里登记',
  )
})

test('不把 AGPL 代码抄进来：被借用文件里不出现 relaykit', () => {
  const rows = borrowTableRows()
  for (const row of rows) {
    for (const rel of filesIn(row.usedIn)) {
      const lower = read(rel).toLowerCase()
      assert.ok(
        !lower.includes('relaykit'),
        `${rel} 出现了 relaykit —— RelayKit 是 AGPL-3.0，不能被本仓（MIT）引用或改写`,
      )
    }
  }
})
