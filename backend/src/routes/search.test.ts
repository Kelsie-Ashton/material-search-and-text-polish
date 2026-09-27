import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import type { Db } from '../db/index.js'
import { createTestDb } from '../test/temp-db.js'

describe('检索路由', () => {
  let db: Db
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createTestDb()
    app = createApp({ db })

    const now = Date.now()
    db.prepare(
      `INSERT INTO directories (path, path_key, label, created_at) VALUES ('D:/m','d:/m','素材',?)`,
    ).run(now)
    const assetId = Number(
      db
        .prepare(
          `INSERT INTO assets (directory_id, path, path_key, file_name, ext, kind,
                               size_bytes, mtime_ms, fingerprint, created_at, updated_at)
           VALUES (1, 'D:/m/探店视频.mp4', 'd:/m/a', '探店视频.mp4', '.mp4', 'video', 1, 1, '1:1', ?, ?)`,
        )
        .run(now, now).lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO asset_text_segments (asset_id, source, ordinal, text, created_at)
       VALUES (?, 'audio', 0, '今天我们来探店这家火锅店', ?)`,
    ).run(assetId, now)
  })

  afterEach(() => {
    db.close()
  })

  it('返回命中结果、分流信息与提示', async () => {
    const res = await request(app).get('/api/search').query({ q: '探店' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.value.items).toHaveLength(1)
    expect(res.body.value.items[0].asset.fileName).toBe('探店视频.mp4')
    // 界面要如实告诉用户「这个词是怎么被搜的」
    expect(res.body.value.terms).toEqual([{ text: '探店', length: 2, path: 'like' }])
    expect(res.body.value.warnings.map((w: { code: string }) => w.code)).toContain(
      'SHORT_TERM_LIKE_FALLBACK',
    )
  })

  it('空关键词返回 400 而不是 500', async () => {
    const res = await request(app).get('/api/search').query({ q: '   ' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('SEARCH_QUERY_EMPTY')
  })

  it('缺少 q 参数也返回 400', async () => {
    const res = await request(app).get('/api/search')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('SEARCH_QUERY_EMPTY')
  })

  it('非法的筛选参数返回 400', async () => {
    const badKind = await request(app).get('/api/search').query({ q: '探店', kind: '不是类型' })
    expect(badKind.status).toBe(400)

    const badStatus = await request(app).get('/api/search').query({ q: '探店', status: '不是状态' })
    expect(badStatus.status).toBe(400)

    const badLimit = await request(app).get('/api/search').query({ q: '探店', limit: '-1' })
    expect(badLimit.status).toBe(400)
  })

  it('空串筛选参数表示不筛选', async () => {
    const res = await request(app).get('/api/search').query({ q: '探店', kind: '', status: '' })

    expect(res.status).toBe(200)
  })

  it('操作符注入返回 200 而不是 500', async () => {
    // 裸的 美食-视频 会让 SQLite 抛 `no such column: 视频`。
    // 若那里没转义，用户随便搜个带连字符的词就会看到「服务器内部错误」。
    const res = await request(app).get('/api/search').query({ q: '美食-视频' })

    expect(res.status).toBe(200)
  })

  it('无命中时返回空列表而不是 404', async () => {
    const res = await request(app).get('/api/search').query({ q: '完全不存在的词' })

    expect(res.status).toBe(200)
    expect(res.body.value.items).toEqual([])
    expect(res.body.value.total).toBe(0)
  })

  it('没有数据库时不挂载检索路由', async () => {
    const bare = createApp()

    const res = await request(bare).get('/api/search').query({ q: '探店' })

    expect(res.status).toBe(404)
  })
})
