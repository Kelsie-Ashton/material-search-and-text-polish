import { apiGet, apiPost } from './client'

/**
 * 任务接口封装 —— 界面查看进度、取消长任务的地方。
 *
 * 单独一个文件而不是挂在 library.ts 下：任务不是素材库的东西，
 * 扫描、提取、润色都会往里塞任务，各页面都要读同一份进度。
 * 后端那边也是独立的一套 `/api/jobs`，两边形状保持一一对应。
 *
 * 类型**刻意重写一遍**而不从 backend/ import：两个包各自独立编译，
 * 跨包相对导入会破坏 Vite 的构建与 TS 的 rootDir 约定。
 * 代价是可能漂移——所以注释里标了后端对应的文件，改 DTO 时照着找回来。
 */

interface Envelope<T> {
  ok: true
  value: T
}

async function unwrap<T>(promise: Promise<unknown>): Promise<T> {
  const payload = (await promise) as Envelope<T>
  return payload.value
}

/** 对应 backend/src/jobs/queue.ts 的 JobRecord */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface JobRecord {
  id: number
  type: 'scan' | 'extract' | 'polish'
  status: JobStatus
  targetId: number | null
  progressCurrent: number
  progressTotal: number
  progressMessage: string | null
  cancelRequested: boolean
  result: unknown
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type CancelOutcome = 'canceled-immediately' | 'will-stop-at-checkpoint'

export interface ListJobsQuery {
  type?: JobRecord['type'] | undefined
  targetId?: number | undefined
  /** 只看还在跑的（含排队）。界面每秒轮询用的就是它。 */
  activeOnly?: boolean | undefined
}

/**
 * 一次取回所有符合条件的任务。
 *
 * 界面上有 200 行素材时，绝不能改成「每行问一次它的进度」——
 * 那就是每秒 200 个请求。取回来按 targetId 自己配对。
 */
export function listJobs(query: ListJobsQuery = {}): Promise<JobRecord[]> {
  const search = new URLSearchParams()
  if (query.type !== undefined) search.set('type', query.type)
  if (query.targetId !== undefined) search.set('targetId', String(query.targetId))
  if (query.activeOnly !== undefined) search.set('active', query.activeOnly ? '1' : '0')

  const qs = search.toString()
  return unwrap<{ items: JobRecord[] }>(apiGet(qs === '' ? '/api/jobs' : `/api/jobs?${qs}`)).then(
    (value) => value.items,
  )
}

export function getJob(id: number): Promise<JobRecord> {
  return unwrap<JobRecord>(apiGet(`/api/jobs/${id}`))
}

/**
 * 取消任务。
 *
 * 返回的 `outcome` 必须如实展示给用户：`will-stop-at-checkpoint` 表示
 * 转写还在后台跑、要几十秒才停，这时说「已取消」就是在骗人。
 * `job` 是取消后的最新状态，拿到就能直接渲染，不必再补一次轮询。
 */
export function cancelJob(id: number): Promise<{ outcome: CancelOutcome; job: JobRecord }> {
  return unwrap<{ outcome: CancelOutcome; job: JobRecord }>(apiPost(`/api/jobs/${id}/cancel`))
}
