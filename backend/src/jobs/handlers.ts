import type { Db } from '../db/index.js'
import { importSubtitleText } from '../extraction/importer.js'
import { extractMediaText, isMediaKind, type MediaDeps } from '../extraction/media.js'
import { isSubtitleExtension } from '../extraction/subtitle.js'
import { findAsset } from '../library/assets.js'
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

/**
 * 可替换的提取依赖，默认是真实实现。
 *
 * 只为了测试而存在，但它换来的是**整条队列链路可测**：入队 → 取出 →
 * 分派 → 转写 → 落库 → 状态流转。否则要验证这条链路就得真下载 238 MB
 * 的模型，于是没人会去验证它——而「接进分派」这件事的价值恰恰全在链路上。
 */
export interface HandlerDeps {
  media?: Partial<MediaDeps>
  /** 中间产物目录，测试指向临时目录，避免污染真实的 data/tmp */
  workDir?: string
}

export function registerJobHandlers(queue: JobQueue, db: Db, deps: HandlerDeps = {}): void {
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

  /**
   * 文字提取（按类型分派）。
   *
   * **为什么音视频必须走队列而不是在 HTTP 请求里跑。** 转写一个素材要几分钟
   * 到几十分钟，一次请求不可能挂那么久（浏览器、代理、Node 的默认超时都不同意）。
   * 队列还顺带给了两件东西：串行（多个素材不会同时抢 CPU 打满机器），
   * 以及取消（用户可以中途放弃一个长视频）。
   */
  queue.register('extract', async (context) => {
    const assetId = context.job.targetId
    if (assetId === null) {
      return err('VALIDATION_FAILED', '提取任务缺少目标素材')
    }

    const asset = findAsset(db, assetId)
    if (!asset) {
      // 用户点了提取又立刻删掉了素材——可读的提示，不是崩溃
      return err('ASSET_NOT_FOUND', `素材已被移除（id=${assetId}）`, { id: assetId })
    }

    // 分派。字幕走解析、音视频走转写、其余如实拒绝。
    //
    // 字幕在路由那边是同步处理的（毫秒级，见 routes/extraction.ts），
    // 正常情况下不会出现在队列里。这里仍然认它，是为了不让「队列里的提取」
    // 与「路由里的提取」变成两套规矩——将来若有「批量重新提取」之类的入口
    // 把字幕也丢进队列，它应当照常工作，而不是得到一句「不是音频或视频」。
    if (isSubtitleExtension(asset.ext)) {
      return importSubtitleText(db, assetId)
    }

    if (!isMediaKind(asset.kind)) {
      return err(
        'EXTRACTION_UNSUPPORTED_TYPE',
        `「${asset.ext}」的文字提取需要本地识别引擎（语音转写 / OCR），尚未提供`,
        { ext: asset.ext, kind: asset.kind },
      )
    }

    // 总时长事前不知道（要探测完才知道），所以 total 传 0 表示「未知」，
    // 界面据此显示不确定进度，而不是一个永远停在 0% 的假进度条。
    context.reportProgress(0, 0, '正在提取文字…')

    const result = await extractMediaText(db, assetId, {
      isCancelled: context.isCancelled,
      deps: deps.media,
      workDir: deps.workDir,
    })
    if (!result.ok) return result

    // 结果写成一句人话：任务列表里「成功」两个字没有信息量，
    // 用户想知道的是「到底提取出了多少」以及「为什么是空的」。
    const { segmentCount, empty, hasAudio, reused } = result.value
    if (!hasAudio) {
      return ok({ ...result.value, message: '该素材没有音轨，已提取、文本为空' })
    }
    if (empty) {
      return ok({ ...result.value, message: '没有识别出文字，已提取、文本为空' })
    }
    return ok({
      ...result.value,
      message: reused
        ? `复用上次结果，共 ${segmentCount} 段`
        : `提取完成，共 ${segmentCount} 段`,
    })
  })
}
