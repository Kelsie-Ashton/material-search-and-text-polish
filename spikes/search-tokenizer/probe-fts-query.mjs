/**
 * 在**真实 schema**（backend/src/db/schema.sql）上验证 trigram 的查询语义。
 *
 * 检索层的每一行都建立在这几个假设上，而它们是靠不住的经验之谈，
 * 所以先把它们一条条钉死。用真实 schema 而不是临时建表，是因为
 * schema 里的 external content + 触发器 + detail='full' 都可能影响行为。
 *
 * 运行：node probe-fts-query.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const schemaPath = path.resolve(import.meta.dirname, '../../backend/src/db/schema.sql')
const db = new Database(':memory:')
db.exec(fs.readFileSync(schemaPath, 'utf8'))
db.pragma('foreign_keys = ON')

const now = Date.now()
db.prepare(`INSERT INTO directories (path,path_key,label,created_at) VALUES ('D:/m','d:/m','m',?)`).run(now)
const dirId = db.prepare('SELECT id FROM directories').get().id

const TEXTS = [
  '今天我们来探店这家火锅店，老板说他们家的麻辣锅底是祖传配方',
  '剪辑师从素材里挑出转场效果最自然的几段，然后单独处理背景音乐',
  '这段口播稿讲的是如何用三分钟讲清楚一个复杂的产品逻辑',
]
const insertAsset = db.prepare(
  `INSERT INTO assets (directory_id,path,path_key,file_name,ext,kind,size_bytes,mtime_ms,fingerprint,created_at,updated_at)
   VALUES (?,?,?,'a.mp4','.mp4','video',1,1,'1:1',?,?)`,
)
const insertSeg = db.prepare(
  `INSERT INTO asset_text_segments (asset_id,source,ordinal,text,created_at) VALUES (?,'audio',?,?,?)`,
)
TEXTS.forEach((t, i) => {
  const id = Number(insertAsset.run(dirId, `D:/m/a${i}.mp4`, `d:/m/a${i}.mp4`, now, now).lastInsertRowid)
  insertSeg.run(id, i, t, now)
})

function q(label, expr) {
  try {
    const rows = db
      .prepare(
        'SELECT rowid, bm25(fts_segments) AS rank FROM fts_segments WHERE fts_segments MATCH ? ORDER BY rank',
      )
      .all(expr)
    const ranks = rows.map((r) => Number(r.rank.toFixed(3)))
    console.log(`${label.padEnd(40)} → ${rows.length} 行  rank=[${ranks.join(', ')}]`)
  } catch (cause) {
    console.log(`${label.padEnd(40)} → 抛错: ${cause.message}`)
  }
}

console.log('语料：')
TEXTS.forEach((t, i) => console.log(`  ${i}: ${t}`))

console.log('\n=== 结论 1：引号包裹 = 子串匹配；<3 字一律 0 行 ===')
q('"火锅店"（3字）', '"火锅店"')
q('"锅底是祖"（跨词边界子串）', '"锅底是祖"')
q('"麻辣"（2字）← 静默失效', '"麻辣"')
q('"祖传"（2字）← 静默失效', '"祖传"')
q('"探店"（2字）← 静默失效', '"探店"')

console.log('\n=== 结论 2：显式 AND 语义正确（两词都 ≥3 字时）===')
q('"火锅店" AND "祖传配方" 同段', '"火锅店" AND "祖传配方"')
q('"火锅店" AND "剪辑师" 异段', '"火锅店" AND "剪辑师"')
q('"火锅店" OR "剪辑师"', '"火锅店" OR "剪辑师"')

console.log('\n=== 结论 3：短词会毁掉整个查询，且两种毁法都危险 ===')
q('"剪辑师" 单独（对照）', '"剪辑师"')
q('"剪辑师" AND "探店"  ← 变 0 行', '"剪辑师" AND "探店"')
q('"剪辑师" 探店（空格）  ← 短词被丢弃', '"剪辑师" 探店')
q('"剪辑师" OR "探店"   ← 短词被丢弃', '"剪辑师" OR "探店"')
console.log('  ↑ 显式 AND 下短词让结果为 0；隐式 AND/OR 下短词被静默忽略、')
console.log('    返回的是「只按长词搜」的结果——后者更危险，因为它看起来是对的。')

console.log('\n=== 结论 4：词内残留空格会让匹配失败 ===')
q('"火锅店"（对照）', '"火锅店"')
q('" 火锅店 "（两侧有空格）', '" 火锅店 "')
console.log('  ↑ 每个词必须先 trim 再拼进 MATCH 表达式')

console.log('\n=== 结论 5：引号完全中和操作符（不抛错）===')
q('"美食-视频"', '"美食-视频"')
q('美食-视频（裸）', '美食-视频')
q('"美食""视频"（内部引号翻倍）', '"美食""视频"')
q('美食"视频（裸）', '美食"视频')
q('"NEAR(探店 视频)"', '"NEAR(探店 视频)"')
q('"a:b"', '"a:b"')
q('"*探店*"', '"*探店*"')

console.log('\n=== 结论 6：bm25 rank 是负数，越小越相关 ===')
console.log('  上面所有非空结果的 rank 都是负数；上例中 -0.506 < -0.498，')
console.log('  即「火锅店」比「剪辑师」更相关（语料更短，词占比更高）。')
const agg = db
  .prepare('SELECT MIN(bm25(fts_segments)) AS r FROM fts_segments WHERE fts_segments MATCH ?')
  .get('"火锅店" OR "剪辑师"')
console.log(`  聚合用 MIN(rank) = ${Number(agg.r.toFixed(3))}（用 MAX 会取到最不相关的那个）`)

db.close()
