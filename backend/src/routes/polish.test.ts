import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../app.js'
import { createCredentialsStore, type CredentialsStore } from '../credentials/store.js'
import type { Db } from '../db/index.js'
import type { LLMProvider, PolishOutput } from '../llm/provider.js'
import { AppError, ok, type Result } from '../shared/result.js'
import { createAsset, createDirectory, createSegment } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'

/**
 * 润色路由的测试（任务 6.2 / 6.5 / 6.11 的接口面）。
 *
 * 路由层的价值不在「转发给 service」，而在**它替用户挡下了什么**，
 * 以及**错误码有没有变成对的状态码**：界面上「凭证无效要去设置页」
 * 和「额度不足要去充值」是两句不同的话，靠的就是这个区分。
 */

const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

let db: Db
let dir: string
let store: CredentialsStore
let directoryId: number

beforeEach(() => {
  db = createTestDb()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-route-'))
  store = createCredentialsStore(path.join(dir, 'credentials.json'))
  directoryId = createDirectory(db).id
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function buildApp(polish: LLMProvider['polish']) {
  const provider = { polish, verifyCredential: vi.fn() } as unknown as LLMProvider
  return {
    app: createApp({
      db,
      credentialsStore: store,
      polishDeps: { createProvider: () => provider },
    }),
  }
}

function assetWithText(text = '今天我们来探店'): number {
  const assetId = createAsset(db, directoryId).id
  createSegment(db, assetId, text)
  return assetId
}

/** 默认的桩：一次成功的润色 */
function succeedingApp(body = '整理好的文案') {
  const polish = vi.fn(
    async (): Promise<Result<PolishOutput>> =>
      ok({ body, model: 'claude-opus-5', inputTokens: 10, outputTokens: 20 }),
  )
  return { ...buildApp(polish as unknown as LLMProvider['polish']), polish }
}

describe('POST /api/polish/assets/:id', () => {
  it('润色成功时返回结果正文', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText()
    const { app } = succeedingApp('整理好的文案。')

    const res = await request(app).post(`/api/polish/assets/${assetId}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.value.status).toBe('done')
    expect(res.body.value.result.body).toBe('整理好的文案。')
  })

  it('未配置凭证返回 409，并指向设置页', async () => {
    // 409 而不是 401/403：这不是「凭证错了」，是「还没配」——
    // 界面据此提示「去设置页填写」，而不是「你的 Key 无效」。
    const assetId = assetWithText()
    const { app, polish } = succeedingApp()

    const res = await request(app).post(`/api/polish/assets/${assetId}`)

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CREDENTIALS_NOT_CONFIGURED')
    expect(res.body.error.message).toContain('设置页')
    expect(polish).not.toHaveBeenCalled()
  })

  it('素材不存在返回 404 而不是 500', async () => {
    store.save({ apiKey: KEY })
    const { app } = succeedingApp()

    const res = await request(app).post('/api/polish/assets/9999')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('id 不合法返回 400', async () => {
    store.save({ apiKey: KEY })
    const { app } = succeedingApp()

    for (const bad of ['abc', '0', '-1', '1.5']) {
      const res = await request(app).post(`/api/polish/assets/${bad}`)

      expect(res.status, `id=${bad} 应当被拒绝`).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('上游网络故障返回 503，而不是一个说不清的 500', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText()
    const { app } = buildApp((async () => ({
      ok: false,
      error: new AppError('CREDENTIALS_NETWORK', '无法连接到服务，请检查网络或代理设置'),
    })) as unknown as LLMProvider['polish'])

    const res = await request(app).post(`/api/polish/assets/${assetId}`)

    // 503 = 服务暂时不可用，客户端重试有意义。这跟 500（我们写错了）是两回事，
    // 日志里混在一起会让真正的 bug 淹没在用户的网络抖动里。
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('CREDENTIALS_NETWORK')
  })

  it('额度不足返回 402 —— 界面据此提示「去充值」而不是「检查网络」', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText()
    const { app } = buildApp((async () => ({
      ok: false,
      error: new AppError('CREDENTIALS_BILLING', '账户额度不足，请前往服务商后台充值'),
    })) as unknown as LLMProvider['polish'])

    const res = await request(app).post(`/api/polish/assets/${assetId}`)

    expect(res.status).toBe(402)
  })

  it('正文为空时返回 422，并说清要先提取', async () => {
    store.save({ apiKey: KEY })
    const assetId = createAsset(db, directoryId).id
    const { app } = succeedingApp()

    const res = await request(app).post(`/api/polish/assets/${assetId}`)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('EXTRACTION_NO_CONTENT')
    expect(res.body.error.message).toContain('先提取')
  })
})

describe('GET /api/polish/assets/:id', () => {
  it('还没润色过时返回空结果而不是错误', async () => {
    // 「还没润色过」是最常见的初始状态，不是错误。
    const assetId = assetWithText()
    const { app } = succeedingApp()

    const res = await request(app).get(`/api/polish/assets/${assetId}`)

    expect(res.status).toBe(200)
    expect(res.body.value).toEqual({ result: null, lastFailure: null })
  })

  it('润色过之后读得到结果', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText()
    const { app } = succeedingApp('已经润色好的文案')
    await request(app).post(`/api/polish/assets/${assetId}`)

    const res = await request(app).get(`/api/polish/assets/${assetId}`)

    expect(res.body.value.result.body).toBe('已经润色好的文案')
  })

  it('把上次失败的原因一并带回来', async () => {
    // 界面看到的是「没有结果」，但原因可能是「从没跑过」，
    // 也可能是「跑过但失败了」——这两件事该给完全不同的提示，
    // 而只靠 result: null 分不出来。
    store.save({ apiKey: KEY })
    const assetId = assetWithText()
    const { app } = buildApp((async () => ({
      ok: false,
      error: new AppError('CREDENTIALS_BILLING', '账户额度不足，请前往服务商后台充值'),
    })) as unknown as LLMProvider['polish'])
    await request(app).post(`/api/polish/assets/${assetId}`)

    const res = await request(app).get(`/api/polish/assets/${assetId}`)

    expect(res.body.value.result).toBeNull()
    expect(res.body.value.lastFailure.code).toBe('CREDENTIALS_BILLING')
  })

  it('素材不存在返回 404，而不是一个空结果', async () => {
    // 拼错的 id 拿到「没有润色结果」，会与「确实还没润色过」混为一谈。
    const { app } = succeedingApp()

    const res = await request(app).get('/api/polish/assets/9999')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('id 不合法返回 400', async () => {
    const { app } = succeedingApp()

    const res = await request(app).get('/api/polish/assets/abc')

    expect(res.status).toBe(400)
  })
})
