import { Router } from 'express'

import type { Db } from '../db/index.js'
import { syncAssetExtractStatus } from '../extraction/asset-status.js'
import type { JobQueue, JobRecord, JobType } from '../jobs/queue.js'
import { sendResult } from '../shared/http.js'
import { err, ok } from '../shared/result.js'

/**
 * 任务路由 —— 界面查看进度、取消长任务的地方。
 *
 * ## 为什么是轮询而不是推送
 *
 * 这个应用跑在本机回环地址上，轮询一个内存队列的代价约等于零，而 SSE / WebSocket
 * 会引入一条长连接的生命周期管理（重连、心跳、后端重启后前端如何察觉）。
 * 对「几十分钟量级的本地任务」来说，一秒问一次的收益与复杂度完全不成比例。
 *
 * ## 一次问全，不要每个素材问一次
 *
 * `GET /api/jobs?type=extract&active=1` 一次返回所有在跑的任务，前端按
 * `targetId` 对到列表的每一行。素材库页有 200 行时，逐行查询就是 200 个请求
 * 每秒——本机也扛不住这种写法。
 *
 * ## `progressTotal` 为 0 表示「不知道总量」
 *
 * 扫描事前不知道有多少文件，转写事前也不知道要多久。前端据此显示**不确定进度**，
 * 而不是拿 0 去做除数。这个约定与扫描一致。
 */

const JOB_TYPES: JobType[] = ['scan', 'extract', 'polish']

/** 路径参数解析成正整数，失败返回 null。 */
function parseId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

/** 可选的 id 查询参数：省略或空串表示「不筛选」，给了但不合法才是错误。 */
function parseOptionalId(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

function parseOptionalEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
): T | undefined | null {
  if (raw === undefined || raw === '') return undefined
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) return null
  return raw as T
}

/** 布尔查询参数：只认 '1' / 'true'。 */
function parseOptionalBool(raw: unknown): boolean | undefined | null {
  if (raw === undefined || raw === '') return undefined
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  return null
}

/**
 * 任务状态变了，素材的提取状态往往也要跟着变。
 *
 * 只有提取任务的目标是素材；扫描的目标是目录，没有这类状态要同步。
 * 取消尤其需要：一个还在排队的提取被取消后，任务没了、运行记录也没有，
 * 素材若不归位就会永远停在「提取中」。
 *
 * 队列的落定回调（`watchExtractJobs`）也会在任务结束时做同一件事，
 * 所以装配完整时这里是第二次调用。留着它是因为**路由不该依赖那个回调有没有被挂上**：
 * 两边调用的是同一个推导函数，写的是同一列，第二次是幂等的——
 * 用一次多余的写换掉「路由的行为取决于装配顺序」这种最难查的耦合。
 */
function syncTarget(db: Db, job: JobRecord): void {
  if (job.type === 'extract' && job.targetId !== null) {
    syncAssetExtractStatus(db, job.targetId)
  }
}

export function createJobsRouter(db: Db, queue: JobQueue): Router {
  const router = Router()

  router.get('/', (req, res) => {
    const type = parseOptionalEnum(req.query['type'], JOB_TYPES)
    const targetId = parseOptionalId(req.query['targetId'])
    const activeOnly = parseOptionalBool(req.query['active'])

    if (type === null || targetId === null || activeOnly === null) {
      sendResult(res, err('VALIDATION_FAILED', '任务查询参数不合法'))
      return
    }

    sendResult(res, ok({ items: queue.list({ type, targetId, activeOnly }) }))
  })

  router.get('/:id', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '任务 id 不合法'))
      return
    }

    sendResult(res, queue.get(id))
  })

  router.post('/:id/cancel', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '任务 id 不合法'))
      return
    }

    const cancelled = queue.cancel(id)
    if (!cancelled.ok) {
      sendResult(res, cancelled)
      return
    }

    // 取消成功后立刻读回任务：前端拿到 outcome 与最新状态可以一次渲染完，
    // 不必再补一次轮询。outcome 区分「已经取消」与「跑完这一步才停」，
    // 界面据此给准确提示，而不是骗用户说「已取消」却还在后台干活。
    const job = queue.get(id)
    if (!job.ok) {
      sendResult(res, job)
      return
    }

    syncTarget(db, job.value)
    sendResult(res, ok({ outcome: cancelled.value, job: job.value }))
  })

  return router
}
