import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { err, ok, type Result } from '../shared/result.js'
import { createTestDb } from '../test/temp-db.js'
import { createJobQueue, type JobQueue } from './queue.js'

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** 可以用代码放行的闸门，用来把任务精确地卡在「运行中」。 */
function createGate(): { wait: () => Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait: () => promise, open }
}

/**
 * 队列的测试全都围绕「时序」——而时序 bug 恰恰是不写测试就发现不了的那类。
 * 所以这些测试不 mock 计时器：用真实的小延迟换取对真实调度的验证。
 */
describe('任务队列', () => {
  let db: Db
  let queue: JobQueue

  beforeEach(() => {
    db = createTestDb()
    queue = createJobQueue(db)
  })

  afterEach(async () => {
    await queue.whenIdle()
    db.close()
  })

  function statusOf(id: number): string {
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as
      | { status: string }
      | undefined
    return row?.status ?? '缺失'
  }

  describe('串行执行', () => {
    it('一次只跑一个任务，且按入队顺序', async () => {
      let concurrent = 0
      let maxConcurrent = 0
      const order: number[] = []

      queue.register('scan', async (context) => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await delay(5)
        order.push(context.job.targetId as number)
        concurrent -= 1
        return ok(null)
      })

      for (const target of [1, 2, 3]) queue.enqueue('scan', target)
      await queue.whenIdle()

      // 并发度必须恒为 1：转写与 OCR 是 CPU 密集的，
      // 同时跑两个只会让两个都变慢，还会打满内存
      expect(maxConcurrent).toBe(1)
      expect(order).toEqual([1, 2, 3])
    })

    it('全部成功后状态为 succeeded', async () => {
      queue.register('scan', async () => ok({ scanned: 3 }))

      const first = queue.enqueue('scan', 1)
      expect(first.ok).toBe(true)
      if (!first.ok) return

      await queue.whenIdle()

      const job = queue.get(first.value.id)
      expect(job.ok).toBe(true)
      if (job.ok) {
        expect(job.value.status).toBe('succeeded')
        expect(job.value.result).toEqual({ scanned: 3 })
      }
    })
  })

  describe('进度上报', () => {
    it('写入数据库并可被查询到', async () => {
      const gate = createGate()
      queue.register('scan', async (context) => {
        context.reportProgress(3, 10, '正在读取目录')
        await gate.wait()
        return ok(null)
      })

      const created = queue.enqueue('scan', 1)
      if (!created.ok) throw new Error('入队失败')
      await delay(10)

      const job = queue.get(created.value.id)
      expect(job.ok).toBe(true)
      if (job.ok) {
        expect(job.value.progressCurrent).toBe(3)
        expect(job.value.progressTotal).toBe(10)
        expect(job.value.progressMessage).toBe('正在读取目录')
      }

      gate.open()
    })
  })

  describe('取消', () => {
    it('取消排队中的任务会立即生效，处理器不会被执行', async () => {
      const gate = createGate()
      let handlerRan = false

      queue.register('scan', async () => {
        handlerRan = true
        await gate.wait()
        return ok(null)
      })

      const blocking = queue.enqueue('scan', 1) // 先占住 worker
      if (!blocking.ok) throw new Error('入队失败')
      await delay(5)

      const queued = queue.enqueue('scan', 2) // 这条只能排队
      if (!queued.ok) throw new Error('入队失败')

      const canceled = queue.cancel(queued.value.id)
      expect(canceled.ok).toBe(true)
      if (canceled.ok) expect(canceled.value).toBe('canceled-immediately')
      expect(statusOf(queued.value.id)).toBe('canceled')

      gate.open()
      await queue.whenIdle()
      expect(handlerRan).toBe(true) // 只有第一条跑过

      const second = queue.get(queued.value.id)
      if (second.ok) expect(second.value.startedAt).toBeNull()
    })

    it('取消运行中的任务返回「将在检查点停止」，且处理器能感知', async () => {
      const reached: number[] = []

      queue.register('scan', async (context) => {
        for (let step = 0; step < 50; step += 1) {
          if (context.isCancelled()) break
          context.reportProgress(step, 50)
          reached.push(step)
          await delay(5)
        }
        return ok({ lastStep: reached.length - 1 })
      })

      const created = queue.enqueue('scan', 1)
      if (!created.ok) throw new Error('入队失败')

      await delay(20) // 让它真的跑起来
      const canceled = queue.cancel(created.value.id)

      expect(canceled.ok).toBe(true)
      if (canceled.ok) {
        // 返回值必须区分这两种情况，否则界面只能骗用户说「已取消」，
        // 而转写其实还在后台跑几十秒
        expect(canceled.value).toBe('will-stop-at-checkpoint')
      }

      await queue.whenIdle()

      // 即使处理器返回的是 ok，被取消的任务也必须记为 canceled，
      // 否则用户会看到一个「成功」的扫描，而它其实只扫了一半
      expect(statusOf(created.value.id)).toBe('canceled')
      expect(reached.length).toBeLessThan(50)
    })

    it('取消已结束的任务被拒绝', async () => {
      queue.register('scan', async () => ok(null))
      const created = queue.enqueue('scan', 1)
      if (!created.ok) throw new Error('入队失败')
      await queue.whenIdle()

      const canceled = queue.cancel(created.value.id)

      expect(canceled.ok).toBe(false)
      if (!canceled.ok) expect(canceled.error.code).toBe('JOB_NOT_CANCELLABLE')
    })

    it('取消不存在的任务返回 NOT_FOUND', () => {
      const canceled = queue.cancel(999)

      expect(canceled.ok).toBe(false)
      if (!canceled.ok) expect(canceled.error.code).toBe('JOB_NOT_FOUND')
    })
  })

  describe('失败隔离', () => {
    it('处理器返回失败不会阻断队列中的后续任务', async () => {
      const ran: number[] = []

      queue.register('scan', async (context): Promise<Result<unknown>> => {
        const target = context.job.targetId as number
        ran.push(target)
        if (target === 1) return err('SCAN_DIRECTORY_MISSING', '目录没了')
        return ok(null)
      })

      queue.enqueue('scan', 1)
      queue.enqueue('scan', 2)
      const third = queue.enqueue('scan', 3)
      if (!third.ok) throw new Error('入队失败')

      await queue.whenIdle()

      expect(ran).toEqual([1, 2, 3])
      expect(statusOf(third.value.id)).toBe('succeeded')
    })

    it('处理器抛异常也被接住并记为失败', async () => {
      queue.register('scan', async () => {
        throw new Error('意料之外的崩溃')
      })

      const created = queue.enqueue('scan', 1)
      if (!created.ok) throw new Error('入队失败')
      await queue.whenIdle()

      const job = queue.get(created.value.id)
      expect(job.ok).toBe(true)
      if (job.ok) {
        expect(job.value.status).toBe('failed')
        expect(job.value.errorCode).toBe('INTERNAL')
        expect(job.value.errorMessage).toContain('意料之外的崩溃')
      }
    })

    it('未注册处理器的任务类型记为失败而不是卡住', async () => {
      const created = queue.enqueue('polish', 1)
      if (!created.ok) throw new Error('入队失败')
      await queue.whenIdle()

      const job = queue.get(created.value.id)
      if (job.ok) expect(job.value.status).toBe('failed')
    })
  })

  describe('防重复入队', () => {
    it('同一目标的重复扫描被数据库层挡住', async () => {
      const gate = createGate()
      queue.register('scan', async () => {
        await gate.wait()
        return ok(null)
      })

      const first = queue.enqueue('scan', 1)
      expect(first.ok).toBe(true)

      const second = queue.enqueue('scan', 1)

      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.error.code).toBe('SCAN_ALREADY_RUNNING')

      gate.open()
    })

    it('不同目标的扫描可以各自排队', async () => {
      const gate = createGate()
      queue.register('scan', async () => {
        await gate.wait()
        return ok(null)
      })

      expect(queue.enqueue('scan', 1).ok).toBe(true)
      expect(queue.enqueue('scan', 2).ok).toBe(true)

      gate.open()
    })

    it('前一个扫描结束后可以再次扫描同一目录', async () => {
      queue.register('scan', async () => ok(null))

      const first = queue.enqueue('scan', 1)
      if (!first.ok) throw new Error('入队失败')
      await queue.whenIdle()

      // 部分唯一索引只约束 queued/running，已结束的任务不该再拦着
      expect(queue.enqueue('scan', 1).ok).toBe(true)
    })
  })

  describe('崩溃恢复', () => {
    it('把上次残留的 running 任务放回队列', async () => {
      // 直接造一条「上次进程被杀时留下的」运行中任务
      db.prepare(
        `INSERT INTO jobs (type, status, target_id, created_at, started_at)
         VALUES ('scan', 'running', 1, ?, ?)`,
      ).run(Date.now(), Date.now())

      const recovered = queue.recoverInterrupted()

      expect(recovered).toBe(1)
      const rows = db.prepare('SELECT status FROM jobs').all() as Array<{ status: string }>
      expect(rows[0]?.status).toBe('queued')

      // recoverInterrupted 刻意不自行启动消费——它通常在启动时被调用，
      // 那时 handler 可能还没注册完。所以这里由调用方显式 start()。
      queue.register('scan', async () => ok(null))
      queue.start()
      await queue.whenIdle()
    })

    it('start() 会消费恢复出来的任务，不需要再入队任何东西来触发', async () => {
      // 这条测试钉住 start() 的存在意义：只恢复不启动，
      // 任务会静默卡在 queued 里，界面上永远显示「排队中」。
      db.prepare(
        `INSERT INTO jobs (type, status, target_id, created_at, started_at)
         VALUES ('scan', 'running', 7, ?, ?)`,
      ).run(Date.now(), Date.now())

      const sawTargets: Array<number | null> = []
      queue.register('scan', async (context) => {
        sawTargets.push(context.job.targetId)
        return ok(null)
      })

      queue.recoverInterrupted()
      queue.start()
      await queue.whenIdle()

      expect(sawTargets).toEqual([7])
    })

    it('恢复出来的任务排在本次新增的任务之前', async () => {
      db.prepare(
        `INSERT INTO jobs (type, status, target_id, created_at, started_at)
         VALUES ('scan', 'running', 7, ?, ?)`,
      ).run(Date.now(), Date.now())

      const sawTargets: Array<number | null> = []
      queue.register('scan', async (context) => {
        sawTargets.push(context.job.targetId)
        return ok(null)
      })

      queue.recoverInterrupted()
      queue.enqueue('scan', 99)
      queue.start()
      await queue.whenIdle()

      // 恢复出来的那条 id 更小，应当先跑
      expect(sawTargets).toEqual([7, 99])
    })

    it('没有残留任务时返回零', () => {
      expect(queue.recoverInterrupted()).toBe(0)
    })
  })

  describe('任务列表', () => {
    it('可以只看进行中的任务', async () => {
      const gate = createGate()
      queue.register('scan', async () => {
        await gate.wait()
        return ok(null)
      })

      const running = queue.enqueue('scan', 1)
      if (!running.ok) throw new Error('入队失败')
      queue.enqueue('scan', 2) // 排队中

      await delay(5)
      const active = queue.list({ activeOnly: true, type: 'scan' })

      expect(active).toHaveLength(2)

      gate.open()
    })
  })

  describe('任务落定回调', () => {
    /**
     * 回调存在的唯一理由是让别的表上跟着任务走的冗余列有人收尾，
     * 而它能收尾的前提是**回调收到的是终态**。所以这个 describe 的重点
     * 不是「回调被调用了」，而是「调用时任务已经是终态了」。
     */
    it('回调收到的是终态，不是运行中的状态', async () => {
      const seen: string[] = []
      queue.onSettled((job) => {
        seen.push(job.status)
        // 回调里读数据库也必须已经是终态——监听者多半是照着库里的真相
        // 去推导别的表，只看传进来的对象是不够的
        seen.push(statusOf(job.id))
      })

      queue.register('scan', async () => ok(null))
      queue.enqueue('scan', 1)
      await queue.whenIdle()

      expect(seen).toEqual(['succeeded', 'succeeded'])
    })

    it('成功、失败、排队中取消都算落定，三种都会通知', async () => {
      const seen: Array<{ status: string; reason: string | null }> = []
      queue.onSettled((job) => {
        seen.push({ status: job.status, reason: job.errorCode })
      })

      queue.register('scan', async () => ok(null))
      queue.register('extract', async () => err('EXTRACTION_FAILED', '模型没加载上'))

      const succeeded = queue.enqueue('scan', 1)
      const failed = queue.enqueue('extract', 2)
      await queue.whenIdle()

      // 排队中的那条直接抹掉——它永远不会进处理器，但同样是一次落定
      const queued = queue.enqueue('extract', 3)
      if (!succeeded.ok || !queued.ok) throw new Error('入队失败')
      queue.cancel(queued.value.id)
      await queue.whenIdle()

      expect(failed.ok).toBe(true)
      expect(seen).toContainEqual({ status: 'succeeded', reason: null })
      expect(seen).toContainEqual({ status: 'failed', reason: 'EXTRACTION_FAILED' })
      expect(seen).toContainEqual({ status: 'canceled', reason: null })
    })

    it('没有注册处理器的任务也通知——它同样结束了', async () => {
      const seen: string[] = []
      queue.onSettled((job) => seen.push(job.status))

      queue.enqueue('polish', 1)
      await queue.whenIdle()

      expect(seen).toEqual(['failed'])
    })

    it('回调抛异常不会拖垮队列，后面的任务照跑', async () => {
      // 回调跑在 finish() 里面，而 finish() 在 runJob 的 catch 分支里也会被调用——
      // 抛出去的异常会被当成「任务执行失败」，一个写坏的监听者就能让整个队列停摆。
      const seen: string[] = []
      queue.onSettled(() => {
        throw new Error('这个监听者坏了')
      })
      queue.onSettled((job) => seen.push(`第二个监听者:${job.status}`))

      queue.register('scan', async () => ok(null))
      queue.enqueue('scan', 1)
      queue.enqueue('scan', 2)
      await queue.whenIdle()

      // 坏掉的监听者没能拦住第二个监听者，也没能拦住第二个任务
      expect(seen).toEqual(['第二个监听者:succeeded', '第二个监听者:succeeded'])
    })

    it('可以挂多个监听者，互不影响', async () => {
      const calls: string[] = []
      queue.onSettled(() => calls.push('甲'))
      queue.onSettled(() => calls.push('乙'))

      queue.register('scan', async () => ok(null))
      queue.enqueue('scan', 1)
      await queue.whenIdle()

      expect(calls).toEqual(['甲', '乙'])
    })
  })
})
