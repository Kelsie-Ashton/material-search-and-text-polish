import { describe, expect, it } from 'vitest'

import {
  countRows,
  createAsset,
  createDirectory,
  createSegment,
  ftsRowIds,
} from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'

describe('连接 PRAGMA', () => {
  it('foreign_keys 必须是开启的', () => {
    const db = createTestDb()

    // better-sqlite3 默认 OFF。这一条挂掉意味着所有 ON DELETE CASCADE
    // 都在静默失效——删掉目录后素材索引会残留成孤儿，且不报任何错。
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

    db.close()
  })
})

describe('删目录只清索引', () => {
  it('级联删除素材与文本，且 FTS 不残留幽灵条目', () => {
    const db = createTestDb()

    const dir = createDirectory(db)
    const asset = createAsset(db, dir.id)
    createSegment(db, asset.id, '这是一段关于美食探店的中文台词')

    // 前提：索引确实建起来了
    expect(ftsRowIds(db, '美食探店')).toEqual([expect.any(Number)])
    expect(countRows(db, 'asset_text_segments')).toBe(1)

    db.prepare('DELETE FROM directories WHERE id = ?').run(dir.id)

    expect(countRows(db, 'directories')).toBe(0)
    expect(countRows(db, 'assets')).toBe(0)
    expect(countRows(db, 'asset_text_segments')).toBe(0)

    // 关键断言：external content 表不会自动清理索引。
    // 没有 AFTER DELETE 触发器时，这里会仍然返回那条已删除的 rowid，
    // 用户就会看到点不开的搜索结果。
    expect(ftsRowIds(db, '美食探店')).toEqual([])

    // integrity-check 验证索引与内容表完全一致，比逐条断言更能兜住遗漏。
    expect(() =>
      db.prepare("INSERT INTO fts_segments(fts_segments) VALUES('integrity-check')").run(),
    ).not.toThrow()

    db.close()
  })

  it('级联确实穿透到子表的触发器（不是靠应用层补救）', () => {
    const db = createTestDb()

    const dir = createDirectory(db)
    const asset = createAsset(db, dir.id)
    createSegment(db, asset.id, '第一个片段', { ordinal: 0 })
    createSegment(db, asset.id, '第二个片段', { ordinal: 1 })

    // 直接删素材（而不是删目录），验证的是同一条级联链的另一端
    db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id)

    expect(ftsRowIds(db, '第一个片段')).toEqual([])
    expect(ftsRowIds(db, '第二个片段')).toEqual([])
    expect(() =>
      db.prepare("INSERT INTO fts_segments(fts_segments) VALUES('integrity-check')").run(),
    ).not.toThrow()

    db.close()
  })

  it('更新段落时索引同步刷新，不留下旧文本', () => {
    const db = createTestDb()

    const dir = createDirectory(db)
    const asset = createAsset(db, dir.id)
    const segment = createSegment(db, asset.id, '原来的台词')

    db.prepare('UPDATE asset_text_segments SET text = ? WHERE id = ?').run('改过的台词', segment.id)

    expect(ftsRowIds(db, '原来的台词')).toEqual([])
    expect(ftsRowIds(db, '改过的台词')).toEqual([segment.id])

    db.close()
  })
})

describe('trigram 分词器的边界行为', () => {
  const text = '这是一段关于美食探店的中文台词'

  it('两字查询静默返回 0 行 —— 检索必须为短词准备 LIKE 兜底', () => {
    const db = createTestDb()
    const dir = createDirectory(db)
    const asset = createAsset(db, dir.id)
    createSegment(db, asset.id, text)

    // 「美食」明明在文中，trigram 却什么都搜不到，而且**不报错**。
    // 这正是设计里「逐词分流」的由来：≥3 字走 FTS，≤2 字只走 LIKE。
    // 如果哪天这条断言失败，说明 SQLite 行为变了，检索模块可以简化。
    expect(ftsRowIds(db, '美食')).toEqual([])

    db.close()
  })

  it('三字及以上查询正常命中', () => {
    const db = createTestDb()
    const dir = createDirectory(db)
    const asset = createAsset(db, dir.id)
    const segment = createSegment(db, asset.id, text)

    expect(ftsRowIds(db, '美食探')).toEqual([segment.id])
    expect(ftsRowIds(db, '美食探店')).toEqual([segment.id])

    db.close()
  })

  it('多词查询中只要有一个短词，整个查询就废掉', () => {
    const db = createTestDb()
    const dir = createDirectory(db)
    const asset = createAsset(db, dir.id)
    createSegment(db, asset.id, text)

    // 这解释了为什么不能「有一个词够长就把整个查询交给 FTS」，
    // 必须逐词分流后分别召回。
    const both = db
      .prepare('SELECT rowid FROM fts_segments WHERE fts_segments MATCH ?')
      .all('"美食" AND "美食探店"')
    expect(both).toEqual([])

    db.close()
  })
})

describe('数据库级不变量', () => {
  it('同一目录重复入队扫描会被挡住', () => {
    const db = createTestDb()
    const dir = createDirectory(db)

    const insert = db.prepare(
      "INSERT INTO jobs (type, status, target_id, created_at) VALUES ('scan', 'queued', ?, ?)",
    )
    insert.run(dir.id, Date.now())

    // 重复点「扫描」是必然发生的用户行为，靠部分唯一索引在数据库层挡住，
    // 而不是指望每个调用点都先查询再插入。
    expect(() => insert.run(dir.id, Date.now())).toThrow(/UNIQUE/i)

    // 任务结束后应能再次入队
    db.prepare("UPDATE jobs SET status = 'succeeded' WHERE target_id = ?").run(dir.id)
    expect(() => insert.run(dir.id, Date.now())).not.toThrow()

    db.close()
  })

  it('每个素材最多只有一条 current 的成功润色结果', () => {
    const db = createTestDb()
    const dir = createDirectory(db)
    const asset = createAsset(db, dir.id)

    const insert = db.prepare(
      `INSERT INTO polish_results
         (primary_asset_id, body, model, prompt_version, status, is_current, created_at)
       VALUES (?, ?, 'claude-opus-5', 'v1', 'succeeded', 1, ?)`,
    )
    insert.run(asset.id, '第一次润色', Date.now())

    expect(() => insert.run(asset.id, '第二次润色', Date.now())).toThrow(/UNIQUE/i)

    // 软覆盖：旧行让位后新行才能成为 current，历史得以保留
    db.prepare('UPDATE polish_results SET is_current = 0 WHERE primary_asset_id = ?').run(asset.id)
    expect(() => insert.run(asset.id, '第二次润色', Date.now())).not.toThrow()
    expect(countRows(db, 'polish_results')).toBe(2)

    // 失败的结果不受该索引约束，不会挤掉成功结果
    db.prepare(
      `INSERT INTO polish_results
         (primary_asset_id, body, model, prompt_version, status, is_current, created_at)
       VALUES (?, '', 'claude-opus-5', 'v1', 'failed', 0, ?)`,
    ).run(asset.id, Date.now())

    db.close()
  })

  it('同名标签无法重复创建（name_key 唯一）', () => {
    const db = createTestDb()
    const insert = db.prepare(
      'INSERT INTO tags (name, name_key, created_at) VALUES (?, ?, ?)',
    )

    insert.run('美食', '美食', Date.now())
    expect(() => insert.run('美食', '美食', Date.now())).toThrow(/UNIQUE/i)

    db.close()
  })
})
