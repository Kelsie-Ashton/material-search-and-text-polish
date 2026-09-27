/**
 * 上一步发现：子查询算 rank、外层 MIN 聚合仍然抛
 * 「unable to use function bm25 in the requested context」，
 * 但同样的子查询配上窗口函数就能跑。
 *
 * 猜疑：SQLite 的「子查询扁平化」优化把子查询合并进了外层，
 * bm25 于是又落回聚合上下文。窗口函数恰好阻止了扁平化。
 *
 * 验证：显式 MATERIALIZED 是否能让聚合写法也成立——
 * 如果成立，就用它，因为它比「靠窗口函数副作用阻止优化」可靠得多，
 * 后者是隐式依赖查询优化器的行为，换个 SQLite 版本就可能失效。
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
   VALUES (?,?,?,?,'.mp4','video',1,1,'1:1',?,?)`,
)
const insertSeg = db.prepare(
  `INSERT INTO asset_text_segments (asset_id,source,ordinal,text,created_at) VALUES (?,'audio',?,?,?)`,
)

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

const RANK_SUBQUERY = `SELECT rowid AS sid, bm25(fts_segments) AS rank
                         FROM fts_segments WHERE fts_segments MATCH ?`

show('A. 普通子查询 + MIN（已知失败）', () =>
  db
    .prepare(
      `SELECT s.asset_id, MIN(t.rank) AS best_rank, COUNT(*) AS hits
         FROM (${RANK_SUBQUERY}) t
         JOIN asset_text_segments s ON s.id = t.sid
        GROUP BY s.asset_id ORDER BY best_rank ASC`,
    )
    .all('"火锅店"'),
)

show('B. WITH ... AS MATERIALIZED + MIN', () =>
  db
    .prepare(
      `WITH hits AS MATERIALIZED (${RANK_SUBQUERY})
       SELECT s.asset_id, MIN(h.rank) AS best_rank, COUNT(*) AS hits
         FROM hits h
         JOIN asset_text_segments s ON s.id = h.sid
        GROUP BY s.asset_id ORDER BY best_rank ASC`,
    )
    .all('"火锅店"'),
)

show('C. MATERIALIZED 里直接 JOIN，外层就只剩聚合', () =>
  db
    .prepare(
      `WITH hits AS MATERIALIZED (
         SELECT s.asset_id AS asset_id, s.id AS segment_id, s.ordinal AS ordinal,
                s.text AS text, s.source AS source, s.start_ms AS start_ms, s.end_ms AS end_ms,
                s.frame_ms AS frame_ms, bm25(fts_segments) AS rank
           FROM fts_segments
           JOIN asset_text_segments s ON s.id = fts_segments.rowid
          WHERE fts_segments MATCH ?
       )
       SELECT asset_id, MIN(rank) AS best_rank, COUNT(*) AS hits
         FROM hits GROUP BY asset_id ORDER BY best_rank ASC`,
    )
    .all('"火锅店"'),
)

show('D. 在 C 的基础上按素材取前 2 段（窗口函数）', () =>
  db
    .prepare(
      `WITH hits AS MATERIALIZED (
         SELECT s.asset_id AS asset_id, s.id AS segment_id, s.text AS text,
                bm25(fts_segments) AS rank
           FROM fts_segments
           JOIN asset_text_segments s ON s.id = fts_segments.rowid
          WHERE fts_segments MATCH ?
       ),
       top AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY rank ASC) AS n FROM hits)
       SELECT asset_id, segment_id, rank, text FROM top WHERE n <= 2 ORDER BY asset_id, rank`,
    )
    .all('"火锅店"'),
)

show('E. 对照：不用 MATERIALIZED，只加窗口函数（隐式阻止扁平化）', () =>
  db
    .prepare(
      `SELECT asset_id, MIN(rank) AS best_rank FROM (
         SELECT s.asset_id AS asset_id, bm25(fts_segments) AS rank,
                ROW_NUMBER() OVER (PARTITION BY s.asset_id ORDER BY bm25(fts_segments)) AS n
           FROM fts_segments JOIN asset_text_segments s ON s.id = fts_segments.rowid
          WHERE fts_segments MATCH ?
       ) GROUP BY asset_id ORDER BY best_rank`,
    )
    .all('"火锅店"'),
)

db.close()
