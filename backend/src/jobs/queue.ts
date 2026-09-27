import { inTransaction, type Db } from '../db/index.js'
import { err, ok, type Result } from '../shared/result.js'

/**
 * 进程内串行任务队列。
 *
 * 为什么是进程内而不是引入 Redis / 消息队列：这是单用户本机应用，
 * 队列的全部价值在于「别让两个重活同时跑」以及「让用户看到进度」，
 * 而这两件事一个内存队列加一张 jobs 表就够了。引入外部依赖的运维成本
 * 远大于它带来的收益。
 *
 * ## 串行是刻意的
 * worker 一次只取一条 queued。转写与 OCR 都是 CPU 密集的，
 * 并发跑两个只会让两个都变慢，还会打满内存。素材扫描同理——
 * 用户不会因为「两个目录同时扫」而获得任何好处。
 *
 * ## 取消是协作式的
 * cancelJob 只改一个标志位，真正停下由 handler 在**检查点**响应。
 * 一个正在跑的转写可能要几十秒才到下一个检查点，
 * 所以 cancel 的返回值必须区分「已经取消了」与「跑完当前这步就停」，
 * 界面才能给出准确提示，而不是骗用户说「已取消」却还在后台干活。
 */

export type JobType = 'scan' | 'extract' | 'polish'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface JobRecord {
  id: number
  type: JobType
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

export interface JobContext {
  job: JobRecord
  /** handler 在检查点调用；返回 true 时应尽快收尾并返回失败或部分结果。 */
  isCancelled: () => boolean
  reportProgress: (current: number, total: number, message?: string) => void
}

export type JobHandler = (context: JobContext) => Promise<Result<unknown>>

export type CancelOutcome =
  /** 还在排队，直接抹掉了——不会有任何副作用发生 */
  | 'canceled-immediately'
  /** 正在跑，已置标志；handler 会在下一个检查点收尾 */
  | 'will-stop-at-checkpoint'

interface JobRowShape {
  id: number
  type: string
  status: string
  target_id: number | null
  payload: string | null
  progress_current: number
  progress_total: number
  progress_message: string | null
  cancel_requested: number
  result: string | null
  error_code: string | null
  error_message: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

function toRecord(row: JobRowShape): JobRecord {
  let parsed: unknown = null
  if (row.result !== null) {
    try {
      parsed = JSON.parse(row.result)
    } catch {
      // 结果列坏掉不该让「查进度」这个接口崩掉
      parsed = null
    }
  }

  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    targetId: row.target_id,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    progressMessage: row.progress_message,
    cancelRequested: row.cancel_requested === 1,
    result: parsed,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export interface JobQueue {
  register: (type: JobType, handler: JobHandler) => void
  enqueue: (type: JobType, targetId: number | null, payload?: unknown) => Result<JobRecord>
  get: (id: number) => Result<JobRecord>
  list: (options?: {
    type?: JobType
    activeOnly?: boolean
    /** 只看某个目标的任务（scan → 目录 id，extract/polish → 素材 id） */
    targetId?: number
  }) => JobRecord[]
  cancel: (id: number) => Result<CancelOutcome>
  /**
   * 注册「任务落定」回调：任务进入 succeeded / failed / canceled 之后触发。
   *
   * 别的表上若有跟着任务走的冗余列，靠它同步。素材的 `extract_status`
   * 就是这么跟着走的——**这个回调必须由队列在写完 job 行之后调用**，
   * 否则监听者读到的 job 状态还是 running，推导出来的自然是「提取中」。
   * 回调抛异常不会影响队列：单个监听者坏了不该让后面所有任务都轮不上。
   */
  onSettled: (listener: (job: JobRecord) => void) => void
  /** 把上次进程留下的 running 任务放回队列。必须在注册处理器之后、start() 之前调用。 */
  recoverInterrupted: () => number
  /**
   * 开始消费队列。
   *
   * 单独一个方法是必要的：`recoverInterrupted` 只改状态、不启动消费
   * （它可能在处理器注册完之前被调用），若没有这个入口，
   * 恢复出来的任务就永远卡在 queued 里没人取——正是恢复机制想避免的那个结局。
   */
  start: () => void
  /** 等到队列彻底空闲（既不运行也没有排队）。测试与优雅关闭用。 */
  whenIdle: () => Promise<void>
}

export function createJobQueue(db: Db): JobQueue {
  const handlers = new Map<JobType, JobHandler>()

  const settleListeners: Array<(job: JobRecord) => void> = []

  /** handler 通过它读到最新的 cancel_requested——不能只看 claim 时的快照 */
  const cancellationOf = new Map<number, { requested: boolean }>()

  let running = false

  function hasQueued(): boolean {
    return db.prepare("SELECT 1 AS x FROM jobs WHERE status = 'queued' LIMIT 1").get() !== undefined
  }

  function claimNext(): JobRecord | null {
    // 取任务与改状态必须在同一事务里。better-sqlite3 是同步的，
    // 所以这里不存在两个 worker 抢到同一条的可能；但把不变量写进事务，
    // 将来若改成多进程也不会静默出错。
    return inTransaction(db, () => {
      const row = db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
        .get() as JobRowShape | undefined
      if (!row) return null

      db.prepare(
        "UPDATE jobs SET status = 'running', started_at = ?, finished_at = NULL WHERE id = ?",
      ).run(Date.now(), row.id)

      return toRecord({ ...row, status: 'running', started_at: Date.now() })
    })
  }

  function finish(
    id: number,
    status: JobStatus,
    options: { result?: unknown; errorCode?: string; errorMessage?: string } = {},
  ): void {
    db.prepare(
      `UPDATE jobs
          SET status = ?, finished_at = ?,
              result = ?, error_code = ?, error_message = ?
        WHERE id = ?`,
    ).run(
      status,
      Date.now(),
      options.result === undefined ? null : JSON.stringify(options.result),
      options.errorCode ?? null,
      options.errorMessage ?? null,
      id,
    )

    // 通知必须在写完这一行**之后**：监听者要读 job 的终态来决定别的表怎么改。
    // 放在写之前（或指望 handler 自己收尾）会让它们读到 running，
    // 于是把刚定下来的终态又推回中间态——而且不报任何错。
    if (settleListeners.length === 0) return

    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRowShape | undefined
    if (!row) return
    const record = toRecord(row)

    for (const listener of settleListeners) {
      try {
        listener(record)
      } catch (cause) {
        // 监听者坏了是它自己的事。把异常吞在这里，是因为 finish() 还跑在
        // runJob 的 catch 分支里——抛出去会被当成「任务执行失败」，
        // 一个同步失败的监听者就能让整个队列停摆。
        console.error('[jobs] 任务落定回调抛错：', cause)
      }
    }
  }

  async function runJob(job: JobRecord): Promise<void> {
    const handler = handlers.get(job.type)
    if (!handler) {
      finish(job.id, 'failed', {
        errorCode: 'INTERNAL',
        errorMessage: `没有为任务类型「${job.type}」注册处理器`,
      })
      return
    }

    const flag = { requested: job.cancelRequested }
    cancellationOf.set(job.id, flag)

    const context: JobContext = {
      job,
      isCancelled: () => flag.requested,
      reportProgress: (current, total, message) => {
        db.prepare(
          `UPDATE jobs
              SET progress_current = ?, progress_total = ?, progress_message = ?
            WHERE id = ?`,
        ).run(current, total, message ?? null, job.id)

        // 每次上报顺便同步一次取消标志——这是 handler 得知用户点了取消的唯一途径
        const row = db
          .prepare('SELECT cancel_requested FROM jobs WHERE id = ?')
          .get(job.id) as { cancel_requested: number } | undefined
        if (row?.cancel_requested === 1) flag.requested = true
      },
    }

    try {
      const result = await handler(context)

      // handler 说取消了，就按取消收尾——哪怕它返回的是成功。
      // 让 handler 自己决定返回什么，容易写成「取消了但标记为成功」。
      if (flag.requested) {
        finish(job.id, 'canceled')
        return
      }

      if (result.ok) {
        finish(job.id, 'succeeded', { result: result.value })
      } else {
        finish(job.id, 'failed', {
          errorCode: result.error.code,
          errorMessage: result.error.message,
        })
      }
    } catch (cause) {
      // 单个任务失败绝不能阻断队列——一个坏文件不该让后面所有素材都轮不上
      finish(job.id, 'failed', {
        errorCode: 'INTERNAL',
        errorMessage: cause instanceof Error ? cause.message : '任务执行时发生未预期的错误',
      })
    } finally {
      cancellationOf.delete(job.id)
    }
  }

  function kick(): void {
    if (running) return
    running = true

    void (async () => {
      try {
        // 一次只取一条，跑完再取——这就是「串行」的全部实现
        for (;;) {
          const job = claimNext()
          if (!job) break
          await runJob(job)
        }
      } finally {
        running = false
      }

      // 收尾后补一次检查。这不是多余的：循环判定「没有排队任务」到
      // running 被清掉之间隔着一次微任务，若正好有 enqueue 落在这个窗口里，
      // 它看到的 running 仍是 true 而直接返回——那条任务就永远没人处理了。
      // 这里与上面的 running = false 之间没有 await，所以不存在新的窗口。
      if (hasQueued()) kick()
    })()
  }

  return {
    register(type, handler) {
      handlers.set(type, handler)
    },

    onSettled(listener) {
      settleListeners.push(listener)
    },

    enqueue(type, targetId, payload) {
      try {
        const info = inTransaction(db, () => {
          const now = Date.now()
          return db
            .prepare(
              `INSERT INTO jobs (type, status, target_id, payload, created_at)
               VALUES (?, 'queued', ?, ?, ?)`,
            )
            .run(type, targetId, payload === undefined ? null : JSON.stringify(payload), now)
        })

        const id = Number(info.lastInsertRowid)
        const created = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRowShape
        kick()
        return ok(toRecord(created))
      } catch (cause) {
        // 部分唯一索引 idx_jobs_active_* 挡住了重复入队。
        // 重复点「扫描」是必然发生的用户行为，与其让两遍扫描互相踩，
        // 不如直接告诉用户「已经有一个在跑了」。
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause
            ? String((cause as { code: unknown }).code)
            : ''
        if (code.startsWith('SQLITE_CONSTRAINT')) {
          return err(
            type === 'scan' ? 'SCAN_ALREADY_RUNNING' : 'CONFLICT',
            type === 'scan'
              ? '该目录已有扫描任务在进行中'
              : '该目标已有同类型任务在进行中',
            { type, targetId },
          )
        }
        throw cause
      }
    },

    get(id) {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRowShape | undefined
      if (!row) return err('JOB_NOT_FOUND', `任务不存在（id=${id}）`, { id })
      return ok(toRecord(row))
    },

    list(options = {}) {
      const clauses: string[] = []
      const params: unknown[] = []
      if (options.type) {
        clauses.push('type = ?')
        params.push(options.type)
      }
      if (options.targetId !== undefined) {
        clauses.push('target_id = ?')
        params.push(options.targetId)
      }
      if (options.activeOnly) {
        clauses.push("status IN ('queued', 'running')")
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const rows = db
        .prepare(`SELECT * FROM jobs ${where} ORDER BY id DESC`)
        .all(...params) as JobRowShape[]
      return rows.map(toRecord)
    },

    cancel(id) {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRowShape | undefined
      if (!row) return err('JOB_NOT_FOUND', `任务不存在（id=${id}）`, { id })

      if (row.status === 'queued') {
        // 还没开始跑，直接抹掉——不会留下任何半成品。
        // 走 finish 而不是自己写 UPDATE：这条路径同样是一次「落定」，
        // 监听者要据此把跟着任务走的冗余列（素材状态）拉回未提取。
        // 漏掉它，用户取消一个排队中的提取后会看到素材永远停在「排队中」。
        finish(id, 'canceled')
        return ok<CancelOutcome>('canceled-immediately')
      }

      if (row.status === 'running') {
        db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(id)
        // 立刻让内存标志生效，不必等 handler 下一次上报进度
        const flag = cancellationOf.get(id)
        if (flag) flag.requested = true
        return ok<CancelOutcome>('will-stop-at-checkpoint')
      }

      return err('JOB_NOT_CANCELLABLE', `任务已经结束（${row.status}），无法取消`, {
        id,
        status: row.status,
      })
    },

    recoverInterrupted() {
      // 上次进程被杀时留下的 running 任务，如果不重置就会永远卡在
      // 「运行中」，队列再也取不到它——一次崩溃就能让扫描功能永久失效。
      const info = db
        .prepare(
          "UPDATE jobs SET status = 'queued', started_at = NULL, cancel_requested = 0 WHERE status = 'running'",
        )
        .run()
      return Number(info.changes)
    },

    start() {
      kick()
    },

    whenIdle() {
      // 轮询而不是记住某个 drain promise：任务可能在等待期间被再次入队，
      // 记住的那个 promise 已经是过去时了。测试与优雅关闭都需要
      // 「等到真的什么都不剩」，而不只是「等到上一轮跑完」。
      return new Promise<void>((resolve) => {
        const check = (): void => {
          if (!running && !hasQueued()) {
            resolve()
            return
          }
          setImmediate(check)
        }
        check()
      })
    },
  }
}
