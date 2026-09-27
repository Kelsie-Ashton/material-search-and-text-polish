import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import type { Db } from '../db/index.js'
import { syncAssetExtractStatus } from '../extraction/asset-status.js'
import { createJobQueue, type JobQueue } from '../jobs/queue.js'
import { ok } from '../shared/result.js'
import { createAsset, createDirectory } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'

/**
 * 任务路由的测试 —— 界面轮询进度、取消长任务的入口。
 *
 * 这里全部用**真实的队列**，不是直接往 jobs 表里塞行：路由的价值恰恰在于
 * 「它转述的是队列的真实状态」。手写的行会绕开 claim、串行、取消标志
 * 这些真正会出错的地方，测出来的绿是假的。
 *
 * 「正在跑」与「排着队」这两个状态靠一个闸门造出来：处理器卡在
 * 一个不会自己 resolve 的 Promise 上，第一条占住队列，第二条就只能排队。
 */

describe('任务路由', () => {
  let db: Db
  let queue: JobQueue
  let app: ReturnType<typeof createApp>
  let directoryId: number
  /**
   * 闸门：处理器停在它上面，队列就被占住了。
   *
   * 写成「开一次就一直开着」而不是存一个 resolve 函数，是因为队列是串行的——
   * 第一条跑完后第二条才会被取走，那时它需要的是一个**新的**等待。
   * 只记住最后一个 resolve 的话，第二条会永远等不到放行，
   * whenIdle 挂到超时，而失败信息里只会写「hook 超时」，看不出是闸门的问题。
   */
  let openGate: () => void

  function makeGate(): { wait: () => Promise<void>; open: () => void } {
    let isOpen = false
    let pending: (() => void) | null = null
    return {
      wait: async () => {
        if (isOpen) return
        await new Promise<void>((resolve) => {
          pending = resolve
        })
      },
      open: () => {
        isOpen = true
        pending?.()
        pending = null
      },
    }
  }

  /** 一个会把队列占住的提取处理器 */
  function blockQueue(): void {
    const gate = makeGate()
    openGate = gate.open
    queue.register('extract', async () => {
      await gate.wait()
      return ok({ done: true })
    })
  }

  function asset(name: string) {
    return createAsset(db, directoryId, { fileName: name })
  }

  function extractJobs(): Array<{ id: number; status: string; targetId: number | null }> {
    return queue.list({ type: 'extract' }).map((job) => ({
      id: job.id,
      status: job.status,
      targetId: job.targetId,
    }))
  }

  function statusOf(assetId: number): string {
    const row = db.prepare('SELECT extract_status FROM assets WHERE id = ?').get(assetId) as {
      extract_status: string
    }
    return row.extract_status
  }

  beforeEach(() => {
    db = createTestDb()
    queue = createJobQueue(db)
    directoryId = createDirectory(db).id
    openGate = () => {}
    app = createApp({ db, jobQueue: queue })
  })

  afterEach(async () => {
    // 顺序不能反：先放行、再等队列真的空下来，最后才关库。
    // 直接关库的话，被闸门卡住的处理器会在一个已关闭的连接上继续写任务终态，
    // 抛出的还是一个异步的 unhandled rejection——它不会让任何断言失败，
    // 只会在输出里留下一堆吓人的栈。
    openGate()
    await queue.whenIdle()
    db.close()
  })

  describe('GET /api/jobs', () => {
    it('一次返回所有任务，最新的排在前面', async () => {
      blockQueue()
      const first = asset('第一个.mp4')
      const second = asset('第二个.mp4')
      queue.enqueue('extract', first.id)
      queue.enqueue('extract', second.id)

      const response = await request(app).get('/api/jobs')

      expect(response.status).toBe(200)
      expect(response.body.ok).toBe(true)
      const ids = response.body.value.items.map((job: { id: number }) => job.id)
      expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a))
      expect(response.body.value.items).toHaveLength(2)
    })

    it('active=1 只返回正在跑和排着队的', async () => {
      // 界面每隔一秒问的就是这一个查询。把已结束的任务也带回去，
      // 前端每轮都要自己过滤一遍，且一屏的历史任务会一直跟着涨。
      //
      // 先跑完一条，再堵住队列造出「一条在跑、一条排队」——顺序不能反：
      // 串行队列里排在堵住那条后面的任务永远不会结束。
      queue.register('extract', async () => ok({ done: true }))
      const finished = asset('跑完的.mp4')
      queue.enqueue('extract', finished.id)
      await queue.whenIdle()

      blockQueue()
      const running = asset('在跑.mp4')
      const queued = asset('排队.mp4')
      queue.enqueue('extract', running.id)
      queue.enqueue('extract', queued.id)

      const active = await request(app).get('/api/jobs?type=extract&active=1')
      const all = await request(app).get('/api/jobs?type=extract')

      expect(active.status).toBe(200)
      const items = active.body.value.items as Array<{ targetId: number; status: string }>
      expect(items.map((job) => job.targetId).sort()).toEqual([queued.id, running.id].sort())
      expect(items.every((job) => ['queued', 'running'].includes(job.status))).toBe(true)
      // 不加筛选时那条已结束的也在，证明上面少掉的确实是它
      expect(all.body.value.items).toHaveLength(3)
    })

    it('按素材筛选：前端只关心某一行的进度时用得上', async () => {
      blockQueue()
      const wanted = asset('想要的.mp4')
      const other = asset('别的.mp4')
      queue.enqueue('extract', wanted.id)
      queue.enqueue('extract', other.id)

      const response = await request(app).get(`/api/jobs?targetId=${wanted.id}`)

      expect(response.status).toBe(200)
      const items = response.body.value.items as Array<{ targetId: number }>
      expect(items).toHaveLength(1)
      expect(items[0]?.targetId).toBe(wanted.id)
    })

    it('几个筛选条件可以叠加', async () => {
      blockQueue()
      const target = asset('目标.mp4')
      queue.enqueue('extract', target.id)
      queue.enqueue('scan', directoryId)

      const response = await request(app).get(`/api/jobs?type=scan&targetId=${directoryId}`)

      expect(response.status).toBe(200)
      expect(response.body.value.items).toHaveLength(1)
      expect(response.body.value.items[0].targetId).toBe(directoryId)
    })

    it('一个任务都没有时返回空列表，不是错误', async () => {
      const response = await request(app).get('/api/jobs')

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ ok: true, value: { items: [] } })
    })

    it('不认识的任务类型如实报参数错误，而不是当成「不筛选」', async () => {
      // 静默忽略拼错的类型，用户会以为「这个类型没有任务」——
      // 而真相是他把 extract 拼成了 extracts
      const response = await request(app).get('/api/jobs?type=extracts')

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('VALIDATION_FAILED')
    })

    it('active 只认 1/0/true/false，别的值报参数错误', async () => {
      const response = await request(app).get('/api/jobs?active=yes')

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('VALIDATION_FAILED')
    })

    it('targetId 不是正整数时报参数错误', async () => {
      const response = await request(app).get('/api/jobs?targetId=abc')

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('VALIDATION_FAILED')
    })
  })

  describe('GET /api/jobs/:id', () => {
    it('返回单个任务的进度与结果', async () => {
      blockQueue()
      const target = asset('目标.mp4')
      const job = queue.enqueue('extract', target.id)
      expect(job.ok).toBe(true)
      if (!job.ok) return

      const response = await request(app).get(`/api/jobs/${job.value.id}`)

      expect(response.status).toBe(200)
      expect(response.body.value).toMatchObject({
        id: job.value.id,
        type: 'extract',
        targetId: target.id,
        status: 'running',
      })
    })

    it('任务不存在时 404，且与「参数不合法」区分开', async () => {
      const missing = await request(app).get('/api/jobs/9999')
      expect(missing.status).toBe(404)
      expect(missing.body.error.code).toBe('JOB_NOT_FOUND')

      const invalid = await request(app).get('/api/jobs/abc')
      expect(invalid.status).toBe(400)
      expect(invalid.body.error.code).toBe('VALIDATION_FAILED')
    })
  })

  describe('POST /api/jobs/:id/cancel', () => {
    it('取消排着队的任务：立刻生效，素材回到未提取', async () => {
      // 串行队列里第二个素材排着队是最常见的状态。它还没被取走，
      // 取消不该留下任何痕迹——素材也不该停在「排队中」。
      blockQueue()
      const running = asset('在跑.mp4')
      const queued = asset('排队.mp4')
      queue.enqueue('extract', running.id)
      const second = queue.enqueue('extract', queued.id)
      expect(second.ok).toBe(true)
      if (!second.ok) return

      // 入队走的是 queue，绕过了提取路由，所以这里补上路由会在入队后做的那一步：
      // 把素材推成「排队中」。下面要验证的正是取消能把它从「排队中」拉回来。
      expect(syncAssetExtractStatus(db, queued.id)).toBe('pending')

      const response = await request(app).post(`/api/jobs/${second.value.id}/cancel`)

      expect(response.status).toBe(200)
      expect(response.body.value.outcome).toBe('canceled-immediately')
      expect(response.body.value.job.status).toBe('canceled')
      expect(statusOf(queued.id)).toBe('none')
    })

    it('取消正在跑的任务：如实说明「跑完这一步才停」', async () => {
      // 骗用户说「已取消」而它在后台继续跑几十分钟，是这里最容易犯的错。
      // 转写要几十秒才到下一个检查点，界面必须知道这个差别。
      blockQueue()
      const target = asset('目标.mp4')
      const job = queue.enqueue('extract', target.id)
      expect(job.ok).toBe(true)
      if (!job.ok) return

      const response = await request(app).post(`/api/jobs/${job.value.id}/cancel`)

      expect(response.status).toBe(200)
      expect(response.body.value.outcome).toBe('will-stop-at-checkpoint')
      // 任务此刻还没结束——它只是被请求了取消
      expect(response.body.value.job.status).toBe('running')
      expect(response.body.value.job.cancelRequested).toBe(true)
    })

    it('已经结束的任务无法取消，返回 409', async () => {
      queue.register('extract', async () => ok({ done: true }))
      const target = asset('跑完的.mp4')
      const job = queue.enqueue('extract', target.id)
      expect(job.ok).toBe(true)
      if (!job.ok) return
      await queue.whenIdle()

      const response = await request(app).post(`/api/jobs/${job.value.id}/cancel`)

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('JOB_NOT_CANCELLABLE')
    })

    it('任务不存在时 404，参数不合法时 400', async () => {
      const missing = await request(app).post('/api/jobs/9999/cancel')
      expect(missing.status).toBe(404)
      expect(missing.body.error.code).toBe('JOB_NOT_FOUND')

      const invalid = await request(app).post('/api/jobs/abc/cancel')
      expect(invalid.status).toBe(400)
      expect(invalid.body.error.code).toBe('VALIDATION_FAILED')
    })
  })

  it('取消提取任务不会误伤别的素材', async () => {
    // 状态同步按 target_id 落到具体素材上。写错成「同步所有素材」，
    // 一次取消就能把整个素材库的提取状态刷成未提取。
    blockQueue()
    const untouched = asset('不相干的.mp4')
    db.prepare("UPDATE assets SET extract_status = 'done' WHERE id = ?").run(untouched.id)

    const cancelled = asset('被取消的.mp4')
    const job = queue.enqueue('extract', cancelled.id)
    expect(job.ok).toBe(true)
    if (!job.ok) return

    await request(app).post(`/api/jobs/${job.value.id}/cancel`)

    expect(statusOf(untouched.id)).toBe('done')
  })

  it('extractJobs 辅助函数取到的是真实队列状态', () => {
    // 这一条是给上面那些用例兜底的：它们全都建立在「闸门真的把任务卡住了」上。
    // 闸门一旦失效（比如 Promise 立刻 resolve），所有断言都会在错误的前提上通过。
    blockQueue()
    const target = asset('目标.mp4')
    queue.enqueue('extract', target.id)

    const jobs = extractJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.status).toBe('running')
  })
})
