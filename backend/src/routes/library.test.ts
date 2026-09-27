import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import type { Db } from '../db/index.js'
import { createJobQueue, type JobQueue } from '../jobs/queue.js'
import { ok } from '../shared/result.js'
import { createTestDb } from '../test/temp-db.js'

/**
 * 素材库路由的测试。
 *
 * 这里只验证**路由层自己**的职责：参数校验、状态码、JSON 形状。
 * 「目录能不能删」「扫描会不会漏文件」属于 library/ 的测试，
 * 在那边直接调函数验证，比穿过 HTTP 更准确也更快。
 */

/** 可以用代码放行的闸门，用来把扫描任务卡在「运行中」。 */
function createGate(): { wait: () => Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait: () => promise, open }
}

describe('素材库路由', () => {
  let db: Db
  let queue: JobQueue
  let app: ReturnType<typeof createApp>
  let tempRoot: string
  /** 每个测试创建的临时目录，结束后统一清掉 */
  let created: string[]

  beforeEach(() => {
    db = createTestDb()
    queue = createJobQueue(db)
    app = createApp({ db, jobQueue: queue })
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstp-library-'))
    created = [tempRoot]
  })

  afterEach(async () => {
    await queue.whenIdle()
    db.close()
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** 造一个真实存在的临时目录——addDirectory 会真的去 stat 它 */
  function makeDir(name: string): string {
    const dir = path.join(tempRoot, name)
    fs.mkdirSync(dir, { recursive: true })
    created.push(dir)
    return dir
  }

  async function addDirectoryViaApi(dirPath: string): Promise<number> {
    const res = await request(app).post('/api/library/directories').send({ path: dirPath })
    expect(res.status).toBe(201)
    return res.body.value.id as number
  }

  describe('目录', () => {
    it('初始列表为空，且空结果不是错误', async () => {
      const res = await request(app).get('/api/library/directories')

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.value.items).toEqual([])
    })

    it('添加真实存在的目录返回 201 并可被列出', async () => {
      const dir = makeDir('素材库')
      const res = await request(app).post('/api/library/directories').send({ path: dir })

      expect(res.status).toBe(201)
      expect(res.body.value.path).toBe(path.resolve(dir))
      // 没给 label 时用目录名兜底，界面才有东西可显示
      expect(res.body.value.label).toBe('素材库')

      const list = await request(app).get('/api/library/directories')
      expect(list.body.value.items).toHaveLength(1)
    })

    it('缺少 path 字段返回 400', async () => {
      const res = await request(app).post('/api/library/directories').send({})

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    })

    it('路径不存在返回 404，而不是笼统的 500', async () => {
      const res = await request(app)
        .post('/api/library/directories')
        .send({ path: path.join(tempRoot, '并不存在') })

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('DIRECTORY_NOT_FOUND')
    })

    it('指向文件而非目录返回 400', async () => {
      const file = path.join(tempRoot, 'a.mp4')
      fs.writeFileSync(file, 'x')
      created.push(file)

      const res = await request(app).post('/api/library/directories').send({ path: file })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('DIRECTORY_NOT_DIRECTORY')
    })

    it('重复添加同一目录返回 409', async () => {
      const dir = makeDir('重复')
      await addDirectoryViaApi(dir)

      const res = await request(app).post('/api/library/directories').send({ path: dir })

      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('DIRECTORY_DUPLICATE')
    })

    it('id 不是正整数时返回 400 而不是 404', async () => {
      const res = await request(app).get('/api/library/directories/abc')

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    })

    it('删除目录只清索引，磁盘上的目录必须还在', async () => {
      const dir = makeDir('别删我')
      const id = await addDirectoryViaApi(dir)
      fs.writeFileSync(path.join(dir, 'keep.mp4'), 'x')

      const res = await request(app).delete(`/api/library/directories/${id}`)

      expect(res.status).toBe(200)
      expect(res.body.value.filesUntouched).toBe(true)

      // 这条断言是整个产品最重要的一条：用户点「移除」时，
      // 无论界面上写了什么，磁盘上的文件必须一个不少。
      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.existsSync(path.join(dir, 'keep.mp4'))).toBe(true)
    })
  })

  describe('扫描任务', () => {
    it('触发扫描返回 202 并带上任务信息', async () => {
      const gate = createGate()
      queue.register('scan', async () => {
        await gate.wait()
        return ok(null)
      })

      const id = await addDirectoryViaApi(makeDir('待扫描'))
      const res = await request(app).post(`/api/library/directories/${id}/scan`)

      expect(res.status).toBe(202)
      expect(res.body.value.id).toBeGreaterThan(0)
      expect(res.body.value.type).toBe('scan')

      gate.open()
    })

    it('同一目录重复触发扫描返回 409 而不是排两条', async () => {
      const gate = createGate()
      queue.register('scan', async () => {
        await gate.wait()
        return ok(null)
      })

      const id = await addDirectoryViaApi(makeDir('重复扫描'))
      await request(app).post(`/api/library/directories/${id}/scan`)

      // 重复点「扫描」是必然发生的用户行为，必须在服务端挡住
      const res = await request(app).post(`/api/library/directories/${id}/scan`)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('SCAN_ALREADY_RUNNING')

      gate.open()
    })

    it('对不存在的目录触发扫描返回 404', async () => {
      const res = await request(app).post('/api/library/directories/9999/scan')

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('DIRECTORY_NOT_FOUND')
    })

    it('可以查询任务进度，也能取消', async () => {
      const gate = createGate()
      queue.register('scan', async (context) => {
        context.reportProgress(2, 0, '已发现 2 项')
        await gate.wait()
        return ok(null)
      })

      const id = await addDirectoryViaApi(makeDir('查进度'))
      const scan = await request(app).post(`/api/library/directories/${id}/scan`)
      const jobId = scan.body.value.id as number

      const got = await request(app).get(`/api/library/jobs/${jobId}`)
      expect(got.status).toBe(200)
      expect(got.body.value.progressMessage).toBe('已发现 2 项')

      // 202 而不是 200：任务还在跑，界面必须继续轮询，
      // 不能因为收到「成功」就把进度条抹掉
      const canceled = await request(app).post(`/api/library/jobs/${jobId}/cancel`)
      expect(canceled.status).toBe(202)
      expect(canceled.body.value.outcome).toBe('will-stop-at-checkpoint')

      gate.open()
    })

    it('取消不存在的任务返回 404', async () => {
      const res = await request(app).post('/api/library/jobs/9999/cancel')

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('JOB_NOT_FOUND')
    })

    it('任务列表可以按类型筛选，非法类型返回 400', async () => {
      const ok1 = await request(app).get('/api/library/jobs?type=scan')
      expect(ok1.status).toBe(200)

      const bad = await request(app).get('/api/library/jobs?type=不存在的类型')
      expect(bad.status).toBe(400)
      expect(bad.body.error.code).toBe('VALIDATION_FAILED')
    })
  })

  describe('素材', () => {
    it('空库返回空列表而不是 404', async () => {
      const res = await request(app).get('/api/library/assets')

      expect(res.status).toBe(200)
      expect(res.body.value.items).toEqual([])
      expect(res.body.value.total).toBe(0)
    })

    it('非法的 kind 与 status 都返回 400', async () => {
      const badKind = await request(app).get('/api/library/assets?kind=不是类型')
      expect(badKind.status).toBe(400)

      const badStatus = await request(app).get('/api/library/assets?status=不是状态')
      expect(badStatus.status).toBe(400)

      // 空串表示「不筛选」，不能当成非法值
      const emptyOk = await request(app).get('/api/library/assets?kind=&status=')
      expect(emptyOk.status).toBe(200)
    })

    it('素材不存在返回 404', async () => {
      const res = await request(app).get('/api/library/assets/9999')

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('ASSET_NOT_FOUND')
    })

    it('把文件名里的 % 当字面量而不是通配符', async () => {
      const id = await addDirectoryViaApi(makeDir('百分号'))
      const now = Date.now()
      const insert = db.prepare(
        `INSERT INTO assets
           (directory_id, path, path_key, file_name, ext, kind, size_bytes, mtime_ms,
            fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      insert.run(id, 'C:/m/100%纯棉.mp4', 'c:/m/100%纯棉.mp4', '100%纯棉.mp4', '.mp4', 'video', 1, now, '1:1', now, now)
      insert.run(id, 'C:/m/1000纯棉.mp4', 'c:/m/1000纯棉.mp4', '1000纯棉.mp4', '.mp4', 'video', 1, now, '1:1', now, now)

      const res = await request(app).get('/api/library/assets?q=100%25')

      // 不转义的话 % 会变成「匹配任意字符」，两条都会被搜出来
      expect(res.body.value.total).toBe(1)
      expect(res.body.value.items[0].fileName).toBe('100%纯棉.mp4')
    })
  })
})
