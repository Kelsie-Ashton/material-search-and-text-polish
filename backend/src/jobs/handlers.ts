import type { Db } from '../db/index.js'
import { findDirectory, markDirectoryScanned } from '../library/directories.js'
import { scanDirectory, type ScanProgress } from '../library/scanner.js'
import { err, ok } from '../shared/result.js'
import type { JobQueue } from './queue.js'

/**
 * 把业务动作注册成任务处理器。
 *
 * 处理器只做「翻译」：把 `JobContext` 翻成扫描器认识的东西，
 * 再把结果翻回 `Result`。业务逻辑一律留在 library/ 里——
 * 这样扫描器可以直接被单测调用，不必起队列，也不必等任务调度。
 */

/** 把扫描进度翻成一句人话，直接显示在界面上。 */
function describeProgress(progress: ScanProgress): string {
  if (progress.phase === 'sweeping') {
    return progress.removed > 0
      ? `正在清理 ${progress.removed} 个已删除的文件`
      : '正在清理已删除的文件'
  }

  const parts = [`已发现 ${progress.visited} 项`]
  if (progress.indexed > 0) parts.push(`新增 ${progress.indexed}`)
  if (progress.updated > 0) parts.push(`更新 ${progress.updated}`)
  if (progress.unchanged > 0) parts.push(`未变化 ${progress.unchanged}`)
  // 这一项必须显示：用户看到「已发现 500 项，新增 80」时，
  // 不把 420 个不支持的文件的去向说清楚，他会以为程序漏扫了
  if (progress.skippedUnsupported > 0) parts.push(`跳过 ${progress.skippedUnsupported} 个不支持的文件`)
  return parts.join('，')
}

export function registerJobHandlers(queue: JobQueue, db: Db): void {
  queue.register('scan', async (context) => {
    const directoryId = context.job.targetId
    if (directoryId === null) {
      return err('VALIDATION_FAILED', '扫描任务缺少目标目录')
    }

    const directory = findDirectory(db, directoryId)
    if (!directory) {
      // 用户点完扫描又立刻删掉了目录——这不是崩溃，是一句可读的提示
      return err('DIRECTORY_NOT_FOUND', `素材目录已被移除（id=${directoryId}）`, {
        id: directoryId,
      })
    }

    const result = await scanDirectory(db, directory, {
      scanId: context.job.id,
      isCancelled: context.isCancelled,
      onProgress: (progress) => {
        // 总量传 0 表示「未知」：扫描前不可能知道有多少文件。
        // 界面据此显示不确定进度，而不是一个永远停在 0% 的假进度条。
        context.reportProgress(progress.visited, 0, describeProgress(progress))
      },
    })

    if (!result.ok) return result

    markDirectoryScanned(db, directoryId)
    return ok(result.value)
  })
}
