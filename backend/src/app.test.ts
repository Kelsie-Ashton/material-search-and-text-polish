import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from './app.js'
import { createCredentialsStore } from './credentials/store.js'
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

/**
 * 畸形请求体的处理。
 *
 * 这一组针对的是一个**真实踩到过**的问题：请求体不是合法 JSON 时，
 * body-parser 抛的错被兜底处理器当成「不该发生的编程错误」，回了 500。
 *
 * 客户端拿到「服务器内部错误」不知道该怎么办；更糟的是日志——真正的 bug
 * 会被这类噪声淹掉，而一个总在报警的日志等于没有日志。
 */
describe('畸形请求体', () => {
  let db: Db
  let app: ReturnType<typeof createApp>
  let dir: string

  beforeEach(() => {
    db = createTestDb()
    // **必须显式注入临时凭证存储。** 少了这一句，createApp 会回落到指向
    // 用户真实 data/credentials.json 的单例——于是这个测试文件会读着用户
    // 的真实密钥、向真实地址发出真实请求。这不是理论风险：加这段用例时
    // 就这么踩了一次，断言在本机「通过」而在干净环境必然失败，
    // 因为本机恰好存着可用凭证（settings.ts 的注释专门警告过这一点）。
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-test-'))
    app = createApp({ db, credentialsStore: createCredentialsStore(path.join(dir, 'credentials.json')) })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('不是合法 JSON 时返回 400，而不是 500', async () => {
    const res = await request(app)
      .put('/api/settings/credentials')
      .set('Content-Type', 'application/json')
      .send('{"apiKey": 这不是 JSON')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    // 说清是**请求体**的问题，而不是「服务器内部错误」——
    // 后者会让调用方去查服务端日志，而问题在他自己这边
    expect(res.body.error.message).toContain('JSON')
  })

  it('空请求体照常走业务逻辑，不被当成畸形', async () => {
    // 没有 body 与 body 写坏了是两回事：前者是合法的「什么都没带」，
    // 业务层爱怎么校验怎么校验。把它也拦成 400 会挡掉正常的无参请求。
    //
    // 这里走的是「未配置凭证」那条业务分支——它返回 409 而不是 500，
    // 正好证明请求确实到过处理器，没有被解析层拦下。
    const res = await request(app).post('/api/settings/credentials/test')

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CREDENTIALS_NOT_CONFIGURED')
  })
})
