import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { createJobQueue, type JobQueue } from '../jobs/queue.js'
import { createAsset, createDirectory } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import { reconcileAssetStatus, syncAssetExtractStatus, watchExtractJobs } from './asset-status.js'

/**
 * 素材提取状态的推导与对账。
 *
 * `assets.extract_status` 是冗余列，真相在 `jobs`（有没有在跑）与
 * `extraction_runs`（上次跑成什么样）。冗余列的全部风险都集中在
 * 「推导规则写错」和「该推导的时刻漏了」，所以这里两个方向都测：
 * 规则本身，以及那五个时刻有没有人负责触发它。
 */

let db: Db
let queue: JobQueue
let directoryId: number

/** 直接写一个任务行，绕开队列的调度——测的是推导规则，不是队列 */
function insertJob(
  type: string,
  status: string,
  targetId: number | null,
): number {
  const info = db
    .prepare(
      `INSERT INTO jobs (type, status, target_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(type, status, targetId, Date.now())
  return Number(info.lastInsertRowid)
}

/** 直接写一条运行记录，绕开提取链路 */
function insertRun(assetId: number, status: string): void {
  db.prepare(
    `INSERT INTO extraction_runs (asset_id, fingerprint, status, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(assetId, 'fp-0001', status, Date.now(), Date.now())
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
})

afterEach(() => {
  db.close()
})

describe('状态推导', () => {
  it('从来没提取过的素材是「未提取」', () => {
    const asset = createAsset(db, directoryId)

    expect(syncAssetExtractStatus(db, asset.id)).toBe('none')
  })

  it('排队中的提取任务让素材显示「排队中」，跑起来则显示「提取中」', () => {
    const queued = createAsset(db, directoryId, { fileName: '排队.mp4' })
    const running = createAsset(db, directoryId, { fileName: '在跑.mp4' })
    insertJob('extract', 'queued', queued.id)
    insertJob('extract', 'running', running.id)

    expect(syncAssetExtractStatus(db, queued.id)).toBe('pending')
    expect(syncAssetExtractStatus(db, running.id)).toBe('running')
  })

  it('成功的运行记录让素材显示「已提取」，失败则显示「提取失败」', () => {
    const done = createAsset(db, directoryId, { fileName: '成功.mp4' })
    const failed = createAsset(db, directoryId, { fileName: '失败.mp4' })
    insertRun(done.id, 'succeeded')
    insertRun(failed.id, 'failed')

    expect(syncAssetExtractStatus(db, done.id)).toBe('done')
    expect(syncAssetExtractStatus(db, failed.id)).toBe('failed')
  })

  it('有活跃任务时以任务为准，不受上次运行结果影响', () => {
    // 判据顺序的规则本身。写反了，重提一个已提取过的素材时界面在整个转写期间
    // 都显示「已提取」，用户点完按钮看不到任何变化。
    const asset = createAsset(db, directoryId)
    insertRun(asset.id, 'succeeded')
    insertJob('extract', 'queued', asset.id)

    expect(syncAssetExtractStatus(db, asset.id)).toBe('pending')
  })

  it('已经结束的任务不算活跃，状态回到运行记录的结论', () => {
    // 「有任务行」不等于「有活跃任务」。三种终态都必须排除掉，
    // 否则一次被取消的提取会让素材永远显示「提取中」。
    for (const terminal of ['succeeded', 'failed', 'canceled']) {
      const asset = createAsset(db, directoryId, { fileName: `终态-${terminal}.mp4` })
      insertJob('extract', terminal, asset.id)

      expect(syncAssetExtractStatus(db, asset.id)).toBe('none')
    }
  })

  it('只看提取任务：扫描与润色任务不该改到同号的素材', () => {
    // 三类任务的 target_id 是各自空间里的 id。不加 type 过滤的话，
    // 扫描目录 7 会顺手把素材 7 的状态改掉——而它跟这个素材毫无关系。
    const asset = createAsset(db, directoryId)
    insertJob('scan', 'running', asset.id)
    insertJob('polish', 'queued', asset.id)

    expect(syncAssetExtractStatus(db, asset.id)).toBe('none')
  })

  it('最新的活跃任务说了算，而不是任意一条', () => {
    const asset = createAsset(db, directoryId)
    // 先有一条结束了的，再有一条正在跑的
    insertJob('extract', 'failed', asset.id)
    insertJob('extract', 'running', asset.id)

    expect(syncAssetExtractStatus(db, asset.id)).toBe('running')
  })

  it('重新推导不改动已经提取过的文本与时长', () => {
    // 状态是派生出来的，推导一次不该有别的副作用——
    // 尤其不能碰 extracted_at 之外的东西。
    const asset = createAsset(db, directoryId)
    insertRun(asset.id, 'succeeded')
    db.prepare('UPDATE assets SET duration_ms = ? WHERE id = ?').run(9700, asset.id)

    syncAssetExtractStatus(db, asset.id)

    const row = db.prepare('SELECT duration_ms FROM assets WHERE id = ?').get(asset.id) as {
      duration_ms: number
    }
    expect(row.duration_ms).toBe(9700)
  })

  it('只有成功的那一刻才写 extracted_at，中间态不写', () => {
    // extracted_at 是「上次成功提取的时刻」。每入队一次就刷新，
    // 用户会以为文本是新提取出来的。
    const asset = createAsset(db, directoryId)
    insertJob('extract', 'queued', asset.id)
    syncAssetExtractStatus(db, asset.id)

    const queued = db.prepare('SELECT extracted_at FROM assets WHERE id = ?').get(asset.id) as {
      extracted_at: number | null
    }
    expect(queued.extracted_at).toBeNull()

    // 任务结束、运行记录成功之后才写上
    db.prepare("UPDATE jobs SET status = 'succeeded' WHERE target_id = ? AND type = 'extract'").run(
      asset.id,
    )
    insertRun(asset.id, 'succeeded')
    syncAssetExtractStatus(db, asset.id)

    const done = db.prepare('SELECT extracted_at FROM assets WHERE id = ?').get(asset.id) as {
      extracted_at: number | null
    }
    expect(done.extracted_at).not.toBeNull()
  })

  it('给一个不存在的素材同步状态不是错误', () => {
    expect(() => syncAssetExtractStatus(db, 9999)).not.toThrow()
  })
})

describe('启动对账', () => {
  it('把停在中间态但没有任务在跑的素材拉回真实状态', () => {
    // 崩溃恢复的核心。进程被杀时正在跑的素材状态停在「提取中」，
    // 而队列的 recoverInterrupted 只管 jobs 表——不对账的话，
    // 那个素材永远显示「提取中」，没有任何东西在跑，用户只能干等。
    const stuck = createAsset(db, directoryId, { fileName: '卡住.mp4' })
    db.prepare("UPDATE assets SET extract_status = 'running' WHERE id = ?").run(stuck.id)

    expect(reconcileAssetStatus(db)).toBe(1)
    expect(statusOf(stuck.id)).toBe('none')
  })

  it('对账会看运行记录，失败过就如实回到「提取失败」', () => {
    const asset = createAsset(db, directoryId)
    db.prepare("UPDATE assets SET extract_status = 'running' WHERE id = ?").run(asset.id)
    insertRun(asset.id, 'failed')

    expect(reconcileAssetStatus(db)).toBe(1)
    expect(statusOf(asset.id)).toBe('failed')
  })

  it('把上次崩溃时排着队的素材推回「排队中」——队列恢复后它们会被重新跑', () => {
    const asset = createAsset(db, directoryId)
    db.prepare("UPDATE assets SET extract_status = 'running' WHERE id = ?").run(asset.id)
    insertJob('extract', 'queued', asset.id)

    expect(reconcileAssetStatus(db)).toBe(1)
    expect(statusOf(asset.id)).toBe('pending')
  })

  it('没有卡住的素材时一个都不改，返回 0', () => {
    const asset = createAsset(db, directoryId)
    insertRun(asset.id, 'succeeded')
    syncAssetExtractStatus(db, asset.id)

    expect(reconcileAssetStatus(db)).toBe(0)
  })

  it('本身已经是对的中间态不重复计数', () => {
    // 返回的是「修正了几个」而不是「看了几个」。启动日志里报一个虚高的数字，
    // 会让人以为每次启动都在修东西。
    const asset = createAsset(db, directoryId)
    db.prepare("UPDATE assets SET extract_status = 'running' WHERE id = ?").run(asset.id)
    insertJob('extract', 'running', asset.id)

    expect(reconcileAssetStatus(db)).toBe(0)
  })
})

describe('任务落定回调', () => {
  it('提取任务落定后把素材状态重新推导一次', async () => {
    const asset = createAsset(db, directoryId)
    insertRun(asset.id, 'succeeded')
    // 模拟「任务跑起来时把它推成了提取中」——这正是处理器开头做的那一下
    db.prepare("UPDATE assets SET extract_status = 'running' WHERE id = ?").run(asset.id)
    watchExtractJobs(queue, db)

    queue.enqueue('extract', asset.id)
    await queue.whenIdle()

    // 队列里没注册处理器，任务会以「没有处理器」落定。它落定了，
    // 素材就该按运行记录重新推导回「已提取」，而不是停在没人收尾的「提取中」。
    // 这里顺带证明回调不挑结束方式：失败照样触发。
    expect(statusOf(asset.id)).toBe('done')
  })

  it('非提取任务不碰素材：目录 id 与素材 id 是两个空间', async () => {
    const asset = createAsset(db, directoryId)
    insertRun(asset.id, 'succeeded')
    // 这个素材的「正确状态」是 done，但当前故意留成 running。
    // 只要回调误触发，它就会被改成 done——于是这个断言能察觉误触发。
    db.prepare("UPDATE assets SET extract_status = 'running' WHERE id = ?").run(asset.id)
    watchExtractJobs(queue, db)

    // 扫描任务的目标是目录。素材与目录的 id 各自编号，很容易撞上同一个数字。
    queue.enqueue('scan', asset.id)
    await queue.whenIdle()

    expect(statusOf(asset.id)).toBe('running')
  })
})
