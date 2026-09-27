import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from './app.js'

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
