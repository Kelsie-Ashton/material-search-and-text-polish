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

  /** 在临时目录里落一个真实纯文本文件并建好素材记录 */
  function textAsset(name: string, ext: string, content: string) {
    const file = path.join(workDir, name)
    fs.writeFileSync(file, content)
    return createAsset(db, directoryId, { fileName: name, path: file, ext, kind: 'text' })
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
      // 两条路径的返回形状不同，调用方必须能分辨自己拿到的是哪一种。
      // 这个字段是**契约的一部分**，删掉它前端就只能靠「有没有 jobId」去猜。
      expect(res.body.value.mode).toBe('imported')
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
      expect(res.body.error.message).toContain('OCR')
      // 告诉前端是哪个扩展名没被支持，界面才好把这句话写具体
      expect(res.body.error.details).toMatchObject({ ext: '.png' })
    })

    it('纯文本按行读入，没有时间轴', async () => {
      // 纯文本与字幕的唯一区别就是没有时间轴。`.txt` 以前被挡在门外，
      // 理由写的是「要先判定编码」——那件事已经做完了（与字幕共用
      // decodeSubtitleText 的 BOM → 严格 UTF-8 → GBK 判定），所以它该能读了。
      const asset = textAsset('歌词.txt', '.txt', '第一句歌词\n\n第二句歌词\n')

      const res = await request(app).post(`/api/extraction/assets/${asset.id}`)

      expect(res.status).toBe(200)
      expect(res.body.value.mode).toBe('imported')
      expect(res.body.value.segmentCount).toBe(2)

      const segments = await request(app).get(`/api/extraction/assets/${asset.id}/segments`)
      // 空行是排版，不是内容——它不该变成一个搜不出东西的空段落
      expect(segments.body.value.items.map((s: { text: string }) => s.text)).toEqual([
        '第一句歌词',
        '第二句歌词',
      ])
      // 没有时间轴：null 而不是 0。0 会被界面显示成 00:00，
      // 让人以为这行字出现在文件开头，而实际上我们根本不知道它在哪儿。
      expect(segments.body.value.items[0].startMs).toBeNull()
    })

    it('.json 也走同一条路，不需要额外的东西', async () => {
      const asset = textAsset('转写.json', '.json', '{\n"text": "今天我们来探店这家火锅店"\n}')

      const res = await request(app).post(`/api/extraction/assets/${asset.id}`)

      expect(res.status).toBe(200)
      expect(res.body.value.mode).toBe('imported')

      const segments = await request(app).get(`/api/extraction/assets/${asset.id}/segments`)
      // 按纯文本读，所以 JSON 的语法符号会原样留在段落里（`{` 自成一个段落）。
      // 这不是解析错误，也不打算修：真要结构化解析 JSON（比如带时间轴的
      // Whisper 输出），得先确定认哪几种方言，那是另一件事。
      // 关键是**词照样搜得到**——下面这条断言才是这个功能存在的理由。
      expect(segments.body.value.items.map((s: { text: string }) => s.text)).toEqual([
        '{',
        '"text": "今天我们来探店这家火锅店"',
        '}',
      ])
    })

    it('没能直接读取的文本格式：说的是「还不能读」，不是「需要识别引擎」', async () => {
      // config.ts 里 text 那一档的扩展名现在与「可直接导入」完全一致，
      // 所以这条分支目前只有「往 config 加了扩展名、却忘了在 importer 里接上」
      // 才会走到。用 .log 模拟那一天。
      //
      // 关键是这两句话不能说反：说一个文本文件「需要识别引擎」，
      // 用户会以为读个日志都要下模型，然后往完全错误的方向排查。
      const asset = textAsset('日志.log', '.log', '随便什么内容')

      const res = await request(app).post(`/api/extraction/assets/${asset.id}`)

      expect(res.status).toBe(501)
      expect(res.body.error.message).toContain('不能直接读进索引')
      expect(res.body.error.message).not.toContain('识别引擎')
    })

    it('读不出来的文本文件：记成提取失败并说明原因，不把请求打崩', async () => {
      // 索引里有、磁盘上没了——用户手工删了文件就会这样。
      // 这是**用户点一下按钮就会走到**的路径，一旦抛出去就是 500，
      // 用户看到一句「服务器错误」，而真正的原因哪儿都没留下。
      const asset = createAsset(db, directoryId, {
        fileName: '不在了.txt',
        path: path.join(workDir, '不在了.txt'),
        ext: '.txt',
        kind: 'text',
      })

      const res = await request(app).post(`/api/extraction/assets/${asset.id}`)

      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('EXTRACTION_FAILED')
      expect(res.body.error.message).toContain('无法读取')
    })

    it('音视频返回 202 与任务 id，而不是傻等它跑完', async () => {
      // 转写一个素材要几分钟到几十分钟。若在这里同步执行，一次请求会挂到
      // 浏览器/代理超时，用户拿到的是一个失败的请求——但活其实还在后台干。
      const asset = createAsset(db, directoryId, { fileName: '探店.mp4', ext: '.mp4' })

      const res = await request(app).post(`/api/extraction/assets/${asset.id}`)

      expect(res.status).toBe(202)
      expect(res.body.ok).toBe(true)
      expect(typeof res.body.value.jobId).toBe('number')
      expect(res.body.value.mode).toBe('queued')
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
