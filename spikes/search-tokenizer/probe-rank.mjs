/**
 * bm25 的聚合方式。
 *
 * 踩到的坑：`MIN(bm25(fts_segments))` 直接抛
 * 「unable to use function bm25 in the requested context」——
 * bm25 只能在 FTS 表的扫描上下文中求值，不能塞进聚合函数。
 *
 * 设计里「聚合用 MIN(rank)」这句话本身没错，但必须换个写法：
 * 先在子查询里把 rank 算出来，再在外层聚合。
 *
 * 同时验证「每个素材最多取 N 个最佳段落」的窗口函数写法。
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
const insertAsset = db.prepare(
  `INSERT INTO assets (directory_id,path,path_key,file_name,ext,kind,size_bytes,mtime_ms,fingerprint,created_at,updated_at)
   VALUES (?,?,?,?,  '.mp4','video',1,1,'1:1',?,?)`,
)
const insertSeg = db.prepare(
  `INSERT INTO asset_text_segments (asset_id,source,ordinal,text,created_at) VALUES (?,'audio',?,?,?)`,
)

// a0 命中 5 段（用来验证「一个素材霸占整个结果页」的问题）
const a0 = Number(insertAsset.run(dirId, 'D:/m/a0.mp4', 'd:/m/a0.mp4', 'a0.mp4', now, now).lastInsertRowid)
for (let i = 0; i < 5; i += 1) {
  insertSeg.run(a0, i, `第${i}段 火锅店 的火锅店描述 ${'很长的填充内容'.repeat(i + 1)}`, now)
}
const a1 = Number(insertAsset.run(dirId, 'D:/m/a1.mp4', 'd:/m/a1.mp4', 'a1.mp4', now, now).lastInsertRowid)
insertSeg.run(a1, 0, '另一段提到火锅店的文字', now)

function show(label, fn) {
  try {
    const rows = fn()
    console.log(`\n${label}`)
    for (const r of rows) console.log('  ' + JSON.stringify(r))
  } catch (cause) {
    console.log(`\n${label}\n  → 抛错: ${cause.message}`)
  }
}

show('✗ 错误写法：MIN(bm25(...))', () =>
  db.prepare('SELECT MIN(bm25(fts_segments)) AS r FROM fts_segments WHERE fts_segments MATCH ?').all('"火锅店"'),
)

show('✓ 子查询算 rank，外层聚合', () =>
  db
    .prepare(
      `SELECT s.asset_id, MIN(t.rank) AS best_rank, COUNT(*) AS hits
         FROM (SELECT rowid AS sid, bm25(fts_segments) AS rank
                 FROM fts_segments WHERE fts_segments MATCH ?) t
         JOIN asset_text_segments s ON s.id = t.sid
        GROUP BY s.asset_id
        ORDER BY best_rank ASC`,
    )
    .all('"火锅店"'),
)

show('✓ 窗口函数：每素材最多 2 段，且是 rank 最小的那几段', () =>
  db
    .prepare(
      `SELECT asset_id, segment_id, rank, text FROM (
         SELECT s.asset_id,
                s.id AS segment_id,
                s.ordinal,
                t.rank,
                s.text,
                ROW_NUMBER() OVER (PARTITION BY s.asset_id ORDER BY t.rank ASC) AS n
           FROM (SELECT rowid AS sid, bm25(fts_segments) AS rank
                   FROM fts_segments WHERE fts_segments MATCH ?) t
           JOIN asset_text_segments s ON s.id = t.sid
       ) WHERE n <= 2
       ORDER BY asset_id, rank ASC`,
    )
    .all('"火锅店"'),
)

db.close()
