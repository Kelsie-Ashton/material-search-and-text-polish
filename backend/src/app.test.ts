import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from './app.js'
import type { Db } from './db/index.js'
import { createJobQueue } from './jobs/queue.js'
import { createTestDb } from './test/temp-db.js'

describe('后端骨架', () => {
  const app = createApp()

  it('GET /api/health 返回 200 且 ok 为真', async () => {
    const res = await request(app).get('/api/health')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.service).toBe('material-search-and-text-polish')
  })

  it('未知 /api 路径返回 JSON 404，而不是回落成 HTML', async () => {
    const res = await request(app).get('/api/definitely-not-here')

    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})

/**
 * 接线守卫。
 *
 * 素材库路由只有在同时拿到 db 与 jobQueue 时才挂载，而这件事
 * 没有任何编译期保障：忘了在 index.ts 里传，应用照常启动、
 * /api/health 照常 200，只是素材库整块功能静默消失。
 * 所以这里从两端各钉一条断言。
 */
describe('素材库路由的挂载条件', () => {
  let db: Db

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  it('同时提供 db 与 jobQueue 时，素材库路由存在', async () => {
    const app = createApp({ db, jobQueue: createJobQueue(db) })

    const res = await request(app).get('/api/library/directories')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('缺少 db 或 jobQueue 时不挂载，返回 404 而不是崩溃', async () => {
    const noDb = createApp({ jobQueue: createJobQueue(db) })
    const noQueue = createApp({ db })

    const first = await request(noDb).get('/api/library/directories')
    const second = await request(noQueue).get('/api/library/directories')

    expect(first.status).toBe(404)
    expect(second.status).toBe(404)
  })
})
