import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { createCredentialsStore } from '../credentials/store.js'

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
