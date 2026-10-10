// W11：与别人共用宿主的配置文件时，那条纪律得有人看着。
//
// 这不是「文档检查」，是一条**双向**约束：
//   `docs/host-writes.md` 定了四条红线 → 代码里就不许出现对应的写操作；
//   反过来，哪天我们真去写 `cordis.patch.yml` 了，这里会先红。
// 它同时钉住那份文档本身：六个 row id 与四条红线的标题必须逐字还在，
// 免得文档被慢慢改空、而代码那边以为规矩还有效。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
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

/** 只在「写」的形式上匹配，避免把 `readFileSync` 之类也算进来。 */
const WRITE_CALL = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|renameSync|rmSync|unlinkSync)\s*\(/

test('会写盘的文件正好是那两个厂商客户端，其余一律只读', () => {
  // 允许写盘的两个文件：写的是 grok / minimax **自己的** auth.json
  //（刷新令牌轮换后必须回写，否则用户被登出）。见 README 对应两节。
  const ALLOWED = new Set(['src/families/grok.js', 'src/families/minimax.js'])

  const writers = jsFilesUnder('src').filter((rel) => WRITE_CALL.test(read(rel)))
  assert.deepEqual(
    writers.slice().sort(),
    [...ALLOWED].sort(),
    '会写盘的源文件变了：要么是新增了一个写入方（那就先读 docs/host-writes.md），要么是少的那个不再回写了',
  )
})

test('源码里没有任何指向宿主配置文件的写操作', () => {
  const forbidden = [
    { what: 'cordis.patch.yml', why: '多主的文件，必须 read-modify-write 且只碰自己的条目' },
    { what: 'cordis.yml', why: '同上（profile 里它是空数组，改的是 patch 那份）' },
    { what: '.credentials.yaml', why: '凭据要 .env 与 store 两处一起写，且只删自己写的值' },
  ]
  for (const rel of jsFilesUnder('src')) {
    const text = read(rel)
    for (const { what, why } of forbidden) {
      // 注释里提到这些文件名是允许的（`src/api.js`、`src/commands.js` 就提到了），
      // 这里只抓「同一行里既出现文件名、又有写调用」的形状。
      const hits = text.split('\n').filter((line) => line.includes(what) && WRITE_CALL.test(line))
      assert.deepEqual(hits, [], `${rel} 在写 ${what}：${why}`)
    }
  }
})

test('docs/host-writes.md 还在，而且四条红线与六个 row id 逐字还在', () => {
  const doc = read('docs/host-writes.md')

  for (const id of [
    'agent-default-model',
    'llm-pi-ai',
    'web-search-deepseek',
    'llm-deepseek',
    'agent-loop',
    'api-gateway',
  ]) {
    assert.ok(doc.includes(`\`${id}\``), `docs/host-writes.md 里少了要避开的 row id：${id}`)
  }

  for (const red of ['① 绝不整份重写', '② 避开这 6 个 row id', '③ 凭据要写两处', '④ 只删自己写的值']) {
    assert.ok(doc.includes(red), `docs/host-writes.md 里少了红线：${red}`)
  }

  // 桌面版只读 store 那一条是「写两处」的理由，理由丢了规矩就会被当成形式。
  assert.match(doc, /桌面版\*\*只读 store\*\*|桌面版只读 store/, '要写两处的理由必须留着')
})
