import fs from 'node:fs'
import path from 'node:path'

import { SUPPORTED_EXTENSIONS, type AssetKind } from '../config.js'
import { inTransaction, type Db } from '../db/index.js'
import { extensionOf, fileNameOf, fingerprintOf, normalizePathKey } from '../shared/paths.js'
import { err, ok, type Result } from '../shared/result.js'
import type { DirectoryRecord } from './directories.js'

/**
 * 素材目录扫描器。
 *
 * 三条互相牵连的设计约束，改动任何一条都要重新验证另外两条：
 *
 *   1. **分批提交 + 让出事件循环**。better-sqlite3 是同步 API，
 *      若把整个扫描包在一个事务里，会阻塞事件循环直到扫描结束——
 *      结果是「扫描进度查询接口」自己无法响应，界面上的进度条卡死。
 *
 *   2. **两阶段，且中断时绝不执行第二阶段**。第一阶段边走边盖
 *      `last_seen_scan_id` 章；第二阶段删除没盖到章的行。
 *      中断时未访问到的文件还带着上一轮的旧章，一旦 sweeping 就会被误删。
 *      所以中断只发生在第一阶段，且此时直接返回，跳过第二阶段。
 *
 *      注意第二阶段删的是**索引行**（`DELETE FROM assets`），不是磁盘文件：
 *      用户在别处删掉一个视频后，这里只是让索引跟上，绝不碰他的磁盘。
 *      本模块也受 eslint.config.mjs 的删除 API 禁令约束。
 *
 *   3. **跳过符号链接与 junction**。用户素材目录里常有指向父目录的快捷方式，
 *      跟随它就会无限递归。
 *
 *      实测 Node 的 dirent 用 lstat 语义：Windows junction 的
 *      `isSymbolicLink()` 为 true，而 `isDirectory()` 与 `isFile()` **都为 false**。
 *      也就是说下面有两道独立的防线都能挡住它——这是有意保留的纵深，
 *      不是重复代码：若将来有人把 readdir 换成会跟随链接的实现，
 *      `!isFile()` 那道就失效了，而 `isSymbolicLink()` 仍然拦得住。
 *      代价是「用户真的想通过符号链接纳入另一个目录」的场景不支持——
 *      这是刻意的取舍：环路会让扫描永不结束，而后者用户至少能手动添加。
 */

/** 每多少条写一次库并让出事件循环。太小则事务开销大，太大则进度条卡顿。 */
const DEFAULT_BATCH_SIZE = 250

/** 错误清单的上限。一个满是坏文件的目录不该把内存撑爆。 */
const MAX_REPORTED_ERRORS = 50

export type ScanPhase = 'walking' | 'sweeping'

export interface ScanProgress {
  phase: ScanPhase
  /**
   * 已处理的文件条目数：受支持的文件 + 读不了的条目 + 类型不支持的文件。
   *
   * **不含**目录本身、符号链接与被跳过的 junction——它们不产生事件，
   * 因为用户不关心「扫过了几个文件夹」。别把它当成 readdir 的条数。
   */
  visited: number
  indexed: number
  updated: number
  unchanged: number
  /** 因扩展名不受支持而没进索引的文件数。用来向用户解释「为什么少了几百个」。 */
  skippedUnsupported: number
  removed: number
}

export interface ScanError {
  path: string
  message: string
}

export interface ScanSummary extends ScanProgress {
  /**
   * 是否完整跑完并执行了清除阶段。
   * 被取消或根目录不可读时为 false——界面据此提示
   * 「本次未清理已删除的文件」，而不是让用户以为索引是最新的。
   */
  completedCleanly: boolean
  cancelled: boolean
  errors: ScanError[]
}

export interface ScanOptions {
  /** 本次扫描的批次号，写入 assets.last_seen_scan_id。通常传 jobs.id。 */
  scanId: number
  isCancelled?: () => boolean
  onProgress?: (progress: ScanProgress) => void
  batchSize?: number
}

interface WalkStats {
  path: string
  sizeBytes: number
  mtimeMs: number
}

type WalkItem =
  | { kind: 'file'; value: WalkStats }
  | { kind: 'error'; value: ScanError }
  /** 类型不受支持的文件：不入索引，但要计数，好让界面能解释「为什么少了几百个」 */
  | { kind: 'skipped'; value: { path: string } }

/**
 * 显式让出事件循环。
 *
 * 实测：把下面这个调用整行删掉，「扫描期间定时器仍能触发」的测试**依然通过**。
 * 原因是 walkFiles 走的是 fs.promises，每个文件的 stat 都是一次真正的 I/O 等待，
 * 本来就会让出事件循环 —— 所以它当前是**冗余的**。
 *
 * 保留它是为了让「不阻塞」这个不变量显式且与遍历实现无关：
 * 若有人为了省掉每文件一次 stat 的系统调用，把 fs.promises.stat 换成
 * fs.statSync（在 readdir 已经给出 dirent 的前提下这是很自然的优化），
 * 异步让出点会**全部消失**，而这里仍能兜住。
 * 成本是每 250 个文件一次 setImmediate，可以忽略。
 */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

/** 扩展名 → 素材大类；不支持的类型返回 null（跳过，但不是错误）。 */
function kindForExtension(ext: string): AssetKind | null {
  for (const [kind, extensions] of Object.entries(SUPPORTED_EXTENSIONS)) {
    if ((extensions as readonly string[]).includes(ext)) return kind as AssetKind
  }
  return null
}

/**
 * 深度优先遍历目录，逐个产出**受支持的文件**。
 *
 * 用显式栈而不是递归：素材库里出现几十层嵌套目录并不罕见，
 * 递归遇到超深目录会爆栈，而爆栈是 `RangeError`，会被当成「不该发生的错误」。
 */
async function* walkFiles(
  root: string,
  isCancelled: () => boolean,
): AsyncGenerator<WalkItem> {
  const stack: string[] = [root]

  while (stack.length > 0) {
    if (isCancelled()) return

    const current = stack.pop() as string

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch (cause) {
      // 单个子目录读不了（权限、被占用、路径过长）不该中断整次扫描
      yield {
        kind: 'error',
        value: { path: current, message: reasonOf(cause, '无法读取目录') },
      }
      continue
    }

    for (const entry of entries) {
      if (isCancelled()) return

      const full = path.join(current, entry.name)

      // 见文件头约束 3：跳过符号链接与 junction，避免扫描环路
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }

      if (!entry.isFile()) continue // 管道、设备文件等一律不碰

      const ext = extensionOf(full)
      if (kindForExtension(ext) === null) {
        // 不支持的类型：不进索引，但**必须上报**。
        // 用户看到「我明明有 500 个文件，怎么只索引了 80 个」时，
        // 唯一能解释这件事的就是这个计数——静默跳过会让他以为程序坏了。
        yield { kind: 'skipped', value: { path: full } }
        continue
      }

      try {
        const stats = await fs.promises.stat(full)
        yield {
          kind: 'file',
          value: { path: full, sizeBytes: stats.size, mtimeMs: stats.mtimeMs },
        }
      } catch (cause) {
        // readdir 与 stat 之间文件被删或改名
        yield {
          kind: 'error',
          value: { path: full, message: reasonOf(cause, '无法读取文件信息') },
        }
      }
    }
  }
}

function reasonOf(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code
    return code ? `${fallback}（${code}）` : cause.message
  }
  return fallback
}

interface ExistingAsset {
  id: number
  path: string
  fingerprint: string
}

export async function scanDirectory(
  db: Db,
  directory: DirectoryRecord,
  options: ScanOptions,
): Promise<Result<ScanSummary>> {
  const { scanId } = options
  const isCancelled = options.isCancelled ?? ((): boolean => false)
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE

  // 先确认根目录还在。被用户删掉或拔掉移动硬盘时要给出明确原因，
  // 而不是安静地扫出 0 个文件——那看起来像「素材库空了」，
  // 会让用户以为索引出了问题。
  try {
    const stats = await fs.promises.stat(directory.path)
    if (!stats.isDirectory()) {
      return err('SCAN_DIRECTORY_MISSING', `目录已不是文件夹：${directory.path}`, {
        path: directory.path,
      })
    }
  } catch (cause) {
    return err(
      'SCAN_DIRECTORY_MISSING',
      `目录无法访问，可能已被删除或所在磁盘未连接：${directory.path}`,
      { path: directory.path, cause: reasonOf(cause, '') },
    )
  }

  // 已有记录按 path_key 建索引，用于判定新增 / 变化 / 未变
  const existing = new Map<string, ExistingAsset>()
  const rows = db
    .prepare('SELECT id, path, path_key, fingerprint FROM assets WHERE directory_id = ?')
    .all(directory.id) as Array<{ id: number; path: string; path_key: string; fingerprint: string }>
  for (const row of rows) {
    existing.set(row.path_key, { id: row.id, path: row.path, fingerprint: row.fingerprint })
  }

  const insert = db.prepare(
    `INSERT INTO assets (
       directory_id, path, path_key, file_name, ext, kind,
       size_bytes, mtime_ms, fingerprint, last_seen_scan_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const updateChanged = db.prepare(
    `UPDATE assets
        SET path = ?, file_name = ?, ext = ?, kind = ?,
            size_bytes = ?, mtime_ms = ?, fingerprint = ?,
            last_seen_scan_id = ?, updated_at = ?
      WHERE id = ?`,
  )
  const touchUnchanged = db.prepare(
    'UPDATE assets SET last_seen_scan_id = ? WHERE id = ?',
  )

  const progress: ScanProgress = {
    phase: 'walking',
    visited: 0,
    indexed: 0,
    updated: 0,
    unchanged: 0,
    skippedUnsupported: 0,
    removed: 0,
  }
  const errors: ScanError[] = []
  const recordError = (error: ScanError): void => {
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(error)
  }

  const applyBatch = (items: WalkStats[]): void => {
    const now = Date.now()
    inTransaction(db, () => {
      for (const item of items) {
        const pathKey = normalizePathKey(item.path)
        const fingerprint = fingerprintOf(item.sizeBytes, item.mtimeMs)
        const found = existing.get(pathKey)

        if (!found) {
          const ext = extensionOf(item.path)
          insert.run(
            directory.id,
            item.path,
            pathKey,
            fileNameOf(item.path),
            ext,
            kindForExtension(ext) ?? 'text',
            item.sizeBytes,
            Math.floor(item.mtimeMs),
            fingerprint,
            scanId,
            now,
            now,
          )
          progress.indexed += 1
          continue
        }

        if (found.fingerprint === fingerprint) {
          // 未变化也要盖章，否则第二阶段会把仍然存在的文件当成已删除
          touchUnchanged.run(scanId, found.id)
          progress.unchanged += 1
          continue
        }

        const ext = extensionOf(item.path)
        updateChanged.run(
          item.path,
          fileNameOf(item.path),
          ext,
          kindForExtension(ext) ?? 'text',
          item.sizeBytes,
          Math.floor(item.mtimeMs),
          fingerprint,
          scanId,
          now,
          found.id,
        )
        progress.updated += 1
      }
    })
  }

  let batch: WalkStats[] = []
  let cancelled = false

  for await (const item of walkFiles(directory.path, isCancelled)) {
    progress.visited += 1

    if (item.kind === 'error') {
      recordError(item.value)
      continue
    }

    if (item.kind === 'skipped') {
      progress.skippedUnsupported += 1
      continue
    }

    batch.push(item.value)
    if (batch.length >= batchSize) {
      applyBatch(batch)
      batch = []
      // 见文件头约束 1：让出事件循环，进度查询接口才能响应
      await yieldToEventLoop()
      options.onProgress?.({ ...progress })
    }
  }

  if (batch.length > 0) applyBatch(batch)

  // 见文件头约束 2：中断时到此为止，绝不进入清除阶段
  cancelled = isCancelled()
  if (cancelled) {
    options.onProgress?.({ ...progress })
    return ok({
      ...progress,
      completedCleanly: false,
      cancelled: true,
      errors,
    })
  }

  progress.phase = 'sweeping'

  const removed = inTransaction(db, () => {
    const info = db
      .prepare(
        `DELETE FROM assets
          WHERE directory_id = ?
            AND (last_seen_scan_id IS NULL OR last_seen_scan_id <> ?)`,
      )
      .run(directory.id, scanId)
    return Number(info.changes)
  })
  progress.removed = removed

  options.onProgress?.({ ...progress })

  return ok({
    ...progress,
    completedCleanly: true,
    cancelled: false,
    errors,
  })
}
