import type { Db } from '../db/index.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ExtractStatus } from '../library/assets.js'

/**
 * 素材提取状态的物化列（`assets.extract_status`）与任务状态的同步。
 *
 * ## 为什么需要这个文件
 *
 * `extract_status` 是**冗余**的：真正的真相分散在两处——「现在有没有任务在跑」
 * 在 `jobs`，「上次跑出了什么结果」在 `extraction_runs`。冗余是因为列表页每行
 * 都要展示与筛选这个状态，不能每渲染一行就去 join 两张表。
 *
 * 冗余的代价是必须有人负责让它不跑偏，而这个状态有**五个**会发生变化的时刻：
 * 入队、开始跑、跑完、被取消、进程崩了。若在这五处各写一段 UPDATE，
 * 迟早有一处被漏掉或写得跟别处不一致——而这类不一致不会报错，
 * 只会让某个素材永远停在「提取中」，或者明明有文本却显示「未提取」。
 *
 * 所以这里不写五段 UPDATE，只写**一个推导函数**：从 jobs 与 extraction_runs
 * 算出该是什么状态。五个时刻都只是「重新推导一次」。少一个分支要维护，
 * 也少一个分支能写错。
 *
 * ## 为什么不放在 persist.ts
 *
 * persist.ts 负责的是**文本**（段落、字形、运行记录），它在自己的事务里顺手把
 * 终态写上，这是对的。但「取消」「任务压根没跑起来」这些路径根本不经过 persist，
 * 状态却同样需要归位。所以状态推导独立于文本落库。
 */

/**
 * 从任务与运行记录推导出素材此刻应有的提取状态。
 *
 * 判据的顺序很重要：**先看有没有活跃任务**，再看最近一次尝试的结果。
 * 反过来的话，一个正在重跑的素材会立刻显示成上次的终态，
 * 用户点完提取看不到任何变化，会以为按钮没生效。
 */
function deriveStatus(db: Db, assetId: number): ExtractStatus {
  const active = db
    .prepare(
      `SELECT status FROM jobs
        WHERE type = 'extract' AND target_id = ? AND status IN ('queued', 'running')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(assetId) as { status: string } | undefined

  if (active) {
    // 排队与运行在界面上都是「提取中」，但分开存：任务列表要能区分
    // 「马上轮到它」和「正在跑」，用户对这两件事的耐心完全不同。
    return active.status === 'running' ? 'running' : 'pending'
  }

  // 没有活跃任务了，看最近一次尝试的结果。
  const run = db
    .prepare('SELECT status FROM extraction_runs WHERE asset_id = ? ORDER BY id DESC LIMIT 1')
    .get(assetId) as { status: string } | undefined

  // 从来没提取过（或被取消、或类型根本不支持而没留下运行记录）——
  // 回到「未提取」，用户随时可以再点一次
  if (!run) return 'none'

  return run.status === 'succeeded' ? 'done' : 'failed'
}

/**
 * 重新推导并写回某个素材的状态，返回落定的结果。
 *
 * 素材已被删除时静默返回（UPDATE 打到 0 行）——「给一个不存在的素材同步状态」
 * 不是错误，只是没什么可同步的。
 */
export function syncAssetExtractStatus(db: Db, assetId: number): ExtractStatus {
  const status = deriveStatus(db, assetId)
  const now = Date.now()

  // 终态才动 extracted_at，中间态不动：它是「上次成功提取的时刻」，
  // 每入队一次就刷新会让用户以为文本是新提取的
  if (status === 'done') {
    db.prepare(
      'UPDATE assets SET extract_status = ?, extracted_at = ?, updated_at = ? WHERE id = ?',
    ).run(status, now, now, assetId)
    return status
  }

  db.prepare('UPDATE assets SET extract_status = ?, updated_at = ? WHERE id = ?').run(
    status,
    now,
    assetId,
  )
  return status
}

/**
 * 把素材状态的同步挂到队列上：提取任务一落定就重新推导对应素材的状态。
 *
 * ## 为什么这件事不能由 handler 自己做
 *
 * 处理器里最自然的写法是在 `finally` 里同步一次——毕竟「无论怎么结束都要归位」。
 * 但它**结束得太早了**：`queue.runJob` 是在 handler 返回之后才把 job 行写成终态，
 * 所以在 handler 的 `finally` 里读到的 job 仍是 running，推导函数据此判定
 * 「还有任务在跑」，把 persist.ts 刚写好的 done / failed 覆盖回 running。
 * 素材于是永远停在「提取中」，没有报错，也永远不会自己好。
 *
 * 真相是：只有任务真的落了定，素材状态才谈得上确定。所以同步挂在
 * `onSettled` 上——队列在写完 job 行之后才叫它。
 *
 * 覆盖「跑完 / 失败 / 被取消 / 压根没注册处理器」全部结束方式，
 * 因为它们在队列里都汇流到同一个 `finish()`。
 */
export function watchExtractJobs(queue: JobQueue, db: Db): void {
  queue.onSettled((job) => {
    // 只有提取任务有对应的素材状态。扫描任务的 target 是目录，润色还没实现，
    // 拿它们的 id 去改 assets 只会误伤同号的素材。
    if (job.type !== 'extract' || job.targetId === null) return
    syncAssetExtractStatus(db, job.targetId)
  })
}

/**
 * 启动对账：把停在「提取中」但没有任务在跑的素材拉回真实状态。
 *
 * **不做这件事，一次崩溃就会留下永久性的谎言。** 进程被杀时正在跑的素材状态
 * 停在 running，而队列的 `recoverInterrupted` 只把 jobs 放回队列——它管不到
 * assets。于是那个素材永远显示「提取中」且没有任何东西在跑，用户只能干等。
 *
 * 返回修正过的素材数，供启动日志与测试断言。
 */
export function reconcileAssetStatus(db: Db): number {
  const stuck = db
    .prepare("SELECT id, extract_status FROM assets WHERE extract_status IN ('pending', 'running')")
    .all() as Array<{ id: number; extract_status: string }>

  let changed = 0
  for (const asset of stuck) {
    const settled = syncAssetExtractStatus(db, asset.id)
    if (settled !== asset.extract_status) changed += 1
  }

  return changed
}
