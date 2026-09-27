import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import type { Db } from '../db/index.js'
import { createJobQueue, type JobQueue } from '../jobs/queue.js'
import { createAsset, createDirectory } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'

/**
 * 提取路由的测试。
 *
 * 路由层的价值不在「转发给 service」——那是它最不容易做错的部分。
 * 在于**它替用户挡下了什么**：不可用的 id、尚未支持的类型、
 * 还没提取过的素材，这三种情况都必须给出彼此可区分的答复。
 */

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  '今天我们来探店这家火锅店',
  '',
  '2',
  '00:00:05,000 --> 00:00:08,000',
  '招牌菜是毛肚和鸭肠',
  '',
].join('\r\n')

describe('提取路由', () => {
  let db: Db
  let app: ReturnType<typeof createApp>
  let queue: JobQueue
  let workDir: string
  let directoryId: number

  /** 在临时目录里落一个真实字幕文件并建好素材记录 */
  function subtitleAsset(name = '探店.srt', ext = '.srt') {
    const file = path.join(workDir, name)
    fs.writeFileSync(file, SRT)
    return createAsset(db, directoryId, {
      fileName: name,
      path: file,
      ext,
      kind: 'text',
    })
  }

  beforeEach(() => {
    db = createTestDb()
    // 队列只入队、不启动消费：这里的测试关心的是「请求有没有正确地把活交出去」，
    // 真跑转写要下载模型（见 media.test.ts 的说明）。任务的执行另有用例覆盖。
    queue = createJobQueue(db)
    app = createApp({ db, jobQueue: queue })
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-route-'))
    directoryId = createDirectory(db).id
  })

  afterEach(() => {
    db.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  describe('发起提取', () => {
    it('字幕素材返回已提取与段落数', async () => {
      const asset = subtitleAsset()

      const res = await request(app).post(`/api/extraction/assets/${asset.id}`)

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.value.status).toBe('done')
      expect(res.body.value.segmentCount).toBe(2)
    })

    it('未支持的类型返回 501 并说明哪些格式现在可用', async () => {
      // 用户点了「提取文字」却拿到 404「接口不存在」，会以为程序坏了。
      // 必须让他知道：这个类型要等下一批，而字幕现在就能导。
      // 图片仍是这条路径——OCR 属于任务 5.1/5.2，尚未实现。
      const asset = createAsset(db, directoryId, { fileName: '封面.png', ext: '.png', kind: 'image' })

      const res = await request(app).post(`/api/extraction/assets/${asset.id}`)

      expect(res.status).toBe(501)
      expect(res.body.error.code).toBe('NOT_IMPLEMENTED')
      expect(res.body.error.message).toContain('.ass')
      expect(res.body.error.message).toContain('下一批')
      // 告诉前端是哪个扩展名没被支持，界面才好把这句话写具体
      expect(res.body.error.details).toMatchObject({ ext: '.png' })
    })

    it('音视频返回 202 与任务 id，而不是傻等它跑完', async () => {
      // 转写一个素材要几分钟到几十分钟。若在这里同步执行，一次请求会挂到
      // 浏览器/代理超时，用户拿到的是一个失败的请求——但活其实还在后台干。
      const asset = createAsset(db, directoryId, { fileName: '探店.mp4', ext: '.mp4' })

      const res = await request(app).post(`/api/extraction/assets/${asset.id}`)

      expect(res.status).toBe(202)
      expect(res.body.ok).toBe(true)
      expect(typeof res.body.value.jobId).toBe('number')
    })

    it('入队的任务带上素材 id，好让 worker 知道该处理谁', async () => {
      const asset = createAsset(db, directoryId, { fileName: '探店.mp4', ext: '.mp4' })

      await request(app).post(`/api/extraction/assets/${asset.id}`)

      // 不断言 status：入队会立刻踢一下队列，它可能已经跑完了。
      // 状态的流转是队列自己的用例该管的事，这里只问「活交给谁了」。
      const row = db
        .prepare("SELECT type, target_id FROM jobs WHERE type = 'extract' ORDER BY id DESC")
        .get() as { type: string; target_id: number }
      expect(row.type).toBe('extract')
      expect(row.target_id).toBe(asset.id)
    })

    it('素材不存在返回 404 而不是 500', async () => {
      const res = await request(app).post('/api/extraction/assets/9999')

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('ASSET_NOT_FOUND')
    })

    it('id 不合法返回 400', async () => {
      for (const bad of ['abc', '0', '-1', '1.5']) {
        const res = await request(app).post(`/api/extraction/assets/${bad}`)

        expect(res.status, `id=${bad} 应当被拒绝`).toBe(400)
        expect(res.body.error.code).toBe('VALIDATION_FAILED')
      }
    })
  })

  describe('读取段落', () => {
    it('返回提取出的段落与总数', async () => {
      const asset = subtitleAsset()
      await request(app).post(`/api/extraction/assets/${asset.id}`)

      const res = await request(app).get(`/api/extraction/assets/${asset.id}/segments`)

      expect(res.status).toBe(200)
      expect(res.body.value.total).toBe(2)
      expect(res.body.value.items[0]).toMatchObject({
        text: '今天我们来探店这家火锅店',
        source: 'file',
        startMs: 1000,
      })
    })

    it('素材不存在时返回 404，而不是一个空列表', async () => {
      // 这条是路由里那段「先确认素材存在」的意义所在：
      // 拼错的 id 拿到空列表，会与「这条素材确实还没提取过」混为一谈，
      // 用户会以为提取没跑，反复重试。
      const res = await request(app).get('/api/extraction/assets/9999/segments')

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('ASSET_NOT_FOUND')
    })

    it('还没提取过的素材返回空列表而不是错误', async () => {
      // 这与上一条是两件事：素材在、只是还没提取，不需要重试，
      // 空列表是准确答案。
      const asset = createAsset(db, directoryId, { fileName: '视频.mp4', ext: '.mp4' })

      const res = await request(app).get(`/api/extraction/assets/${asset.id}/segments`)

      expect(res.status).toBe(200)
      expect(res.body.value).toEqual({ items: [], total: 0 })
    })

    it('分页参数生效', async () => {
      const asset = subtitleAsset()
      await request(app).post(`/api/extraction/assets/${asset.id}`)

      const res = await request(app)
        .get(`/api/extraction/assets/${asset.id}/segments`)
        .query({ limit: 1, offset: 1 })

      expect(res.body.value.total).toBe(2)
      expect(res.body.value.items).toHaveLength(1)
      expect(res.body.value.items[0].text).toBe('招牌菜是毛肚和鸭肠')
    })

    it('非法的分页参数返回 400', async () => {
      const asset = subtitleAsset()

      for (const query of [{ limit: 'abc' }, { offset: '-1' }, { limit: '1.5' }]) {
        const res = await request(app)
          .get(`/api/extraction/assets/${asset.id}/segments`)
          .query(query)

        expect(res.status, JSON.stringify(query)).toBe(400)
        expect(res.body.error.code).toBe('VALIDATION_FAILED')
      }
    })
  })
})
