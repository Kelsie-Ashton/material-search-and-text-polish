import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { createCredentialsStore } from '../credentials/store.js'
import type { Db } from '../db/index.js'
import { createTestDb } from '../test/temp-db.js'

const REAL_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

let dir: string
let file: string
let app: ReturnType<typeof createApp>

beforeEach(() => {
  // 注入临时文件：这些用例绝不能碰用户真实的 data/credentials.json
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-route-'))
  file = path.join(dir, 'credentials.json')
  app = createApp({ credentialsStore: createCredentialsStore(file) })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/settings/credentials', () => {
  it('未配置时返回 configured:false，而不是错误', async () => {
    const res = await request(app).get('/api/settings/credentials')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, value: { configured: false } })
  })

  it('已配置时只回显末四位', async () => {
    await request(app).put('/api/settings/credentials').send({ apiKey: REAL_KEY })
    const res = await request(app).get('/api/settings/credentials')

    expect(res.status).toBe(200)
    expect(res.body.value.maskedKey).toBe('****6789')
    expect(res.body.value.model).toBe('claude-opus-5')

    // 安全约束：任何一次响应体里都不能出现完整密钥
    expect(res.text).not.toContain(REAL_KEY)
    expect(res.text).not.toContain(REAL_KEY.slice(0, 24))
  })
})

describe('PUT /api/settings/credentials', () => {
  it('保存成功并落到磁盘', async () => {
    const res = await request(app).put('/api/settings/credentials').send({ apiKey: REAL_KEY })

    expect(res.status).toBe(200)
    expect(res.body.value.maskedKey).toBe('****6789')
    expect(res.text).not.toContain(REAL_KEY)

    // 密钥确实写进了 data/credentials.json —— 而该目录已被 .gitignore 覆盖
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey).toBe(REAL_KEY)
  })

  it('首次配置时省略 apiKey 返回 400', async () => {
    const res = await request(app).put('/api/settings/credentials').send({ model: 'claude-opus-5' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('已配置后只改模型，无需重新粘贴 Key', async () => {
    await request(app).put('/api/settings/credentials').send({ apiKey: REAL_KEY })

    const res = await request(app).put('/api/settings/credentials').send({ model: 'claude-sonnet-5' })

    expect(res.status).toBe(200)
    expect(res.body.value.model).toBe('claude-sonnet-5')
    // 密钥原样保留 —— 设置页只回显末四位，用户拿不到原 Key，
    // 所以「只想换个模型」不能以重新粘贴密钥为前提。
    expect(res.body.value.maskedKey).toBe('****6789')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey).toBe(REAL_KEY)
  })

  it('空 apiKey 返回 400', async () => {
    const res = await request(app).put('/api/settings/credentials').send({ apiKey: '   ' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('DELETE /api/settings/credentials', () => {
  it('清除后回到未配置状态', async () => {
    await request(app).put('/api/settings/credentials').send({ apiKey: REAL_KEY })

    const res = await request(app).delete('/api/settings/credentials')
    expect(res.status).toBe(200)
    expect(res.body.value.cleared).toBe(true)

    const after = await request(app).get('/api/settings/credentials')
    expect(after.body.value).toEqual({ configured: false })
  })
})

describe('POST /api/settings/credentials/test', () => {
  it('未配置时返回 409，引导用户先去设置页', async () => {
    const res = await request(app).post('/api/settings/credentials/test')

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CREDENTIALS_NOT_CONFIGURED')
  })
})

describe('GET /api/settings/polish-availability', () => {
  it('未配置时是降级状态而非错误', async () => {
    const res = await request(app).get('/api/settings/polish-availability')

    // 这条路径必须返回 200：未配置是最常见的初始状态，
    // 前端据此禁用润色按钮并给出提示，而不是弹一个错误框。
    expect(res.status).toBe(200)
    expect(res.body.value).toEqual({ available: false, reason: 'not_configured' })
  })

  it('配置后变为可用并带出模型名', async () => {
    await request(app).put('/api/settings/credentials').send({ apiKey: REAL_KEY })
    const res = await request(app).get('/api/settings/polish-availability')

    expect(res.body.value).toEqual({ available: true, model: 'claude-opus-5' })
  })
})

/**
 * 应用偏好路由。
 *
 * 单独一组用例，因为这几条**需要数据库**；上面的凭证用例刻意不传 db，
 * 顺带钉住「偏好路由缺席时凭证路由照常工作」这件事。
 */
describe('/api/settings/preferences', () => {
  let db: Db
  let dbApp: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createTestDb()
    dbApp = createApp({ credentialsStore: createCredentialsStore(file), db })
  })

  afterEach(() => {
    db.close()
  })

  it('未设置过时返回简体', async () => {
    const res = await request(dbApp).get('/api/settings/preferences')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, value: { textScript: 'simplified' } })
  })

  it('改成繁体后能读回来', async () => {
    const put = await request(dbApp).put('/api/settings/preferences').send({
      textScript: 'traditional',
    })

    expect(put.status).toBe(200)
    // 返回完整偏好：设置页拿它整体刷新，省掉一次 GET
    expect(put.body.value).toEqual({ textScript: 'traditional' })

    const get = await request(dbApp).get('/api/settings/preferences')
    expect(get.body.value).toEqual({ textScript: 'traditional' })
  })

  it('非法取值返回 400 且不改变已存的值', async () => {
    await request(dbApp).put('/api/settings/preferences').send({ textScript: 'traditional' })

    const res = await request(dbApp).put('/api/settings/preferences').send({ textScript: 'klingon' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')

    // 拒绝之后原值必须还在：静默回落成简体，用户会在毫无察觉的情况下
    // 换了保存字形，下次提取时才发现文本全变了。
    const get = await request(dbApp).get('/api/settings/preferences')
    expect(get.body.value.textScript).toBe('traditional')
  })

  it('偏好与凭证互不干扰', async () => {
    // 两者存储位置完全不同（表 vs 文件）。这条断言的是：
    // 改偏好不会碰凭证文件，清凭证也不会重置偏好。
    await request(dbApp).put('/api/settings/credentials').send({ apiKey: REAL_KEY })
    await request(dbApp).put('/api/settings/preferences').send({ textScript: 'traditional' })

    await request(dbApp).delete('/api/settings/credentials')

    const res = await request(dbApp).get('/api/settings/preferences')
    expect(res.body.value.textScript).toBe('traditional')

    // 反过来：偏好表里不该出现任何密钥痕迹
    const dumped = JSON.stringify(db.prepare('SELECT * FROM app_settings').all())
    expect(dumped).not.toContain(REAL_KEY)
    expect(dumped).not.toContain(REAL_KEY.slice(0, 24))
  })

  it('没有数据库时该路由不存在，但凭证路由照常工作', async () => {
    // 降级必须干净：宁可返回 JSON 404，也不能挂一个一调就 500 的路由。
    const noDb = await request(app).get('/api/settings/preferences')
    expect(noDb.status).toBe(404)
    expect(noDb.body.error.code).toBe('NOT_FOUND')

    const creds = await request(app).get('/api/settings/credentials')
    expect(creds.status).toBe(200)
  })
})
