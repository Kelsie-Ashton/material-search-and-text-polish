import fs from 'node:fs'

import type { Db } from '../db/index.js'
import { findAsset } from '../library/assets.js'
import { err, ok, type Result } from '../shared/result.js'
import { readTextScript } from '../settings/preferences.js'
import {
  countSegments,
  engineLabel,
  findCachedRun,
  markFailed,
  persistSegments,
  type ExtractedSegment,
} from './persist.js'
import { PLAIN_TEXT_EXTENSIONS, isPlainTextExtension, parsePlainText } from './plaintext.js'
import { SUBTITLE_EXTENSIONS, decodeSubtitleText, isSubtitleExtension, parseSubtitle } from './subtitle.js'

/**
 * 文本类素材的直接导入（任务 5.15）。
 *
 * 这是整条提取链路里**唯一不需要下载任何模型**的部分，因此它能先于
 * 语音转写与 OCR 独立交付（design.md 决策 12、tasks 5.14–5.16）。
 *
 * 覆盖两类文件，差别只在有没有时间轴：
 *
 *   - **字幕**（`.srt` / `.vtt` / `.ass` / `.ssa`）——包了一层时间轴与样式
 *     标记，解析出来带时间码（见 subtitle.ts）。
 *   - **纯文本**（`.txt` / `.md` / `.json` / `.csv`）——本身就是文字，
 *     按行切段入库，没有时间码（见 plaintext.ts）。
 *
 * 两类都刻意**不走后台任务队列**：队列是为「长耗时、吃资源、要能取消」的
 * 转写与识别准备的（决策 4），而读一个几百 KB 的文本文件是毫秒级的纯
 * 字符串处理。为它造一个假任务只会让前端多一轮无意义的轮询。
 *
 * 另：本模块**只读文件，不写不删**。素材的正文提取绝不能碰原始文件。
 *
 * 落库前会按用户在设置页选的「默认文本保存方式」统一转换字形（见 chinese.ts）。
 * 字幕文件尤其需要：网上下的 `.ass` 大量是繁体，而检索是按字符匹配的，
 * 繁简对不上就是零结果。
 */

/**
 * 解析器版本。参与指纹缓存判定——解析逻辑改了，缓存就该失效。
 *
 * v2：折行不再一律换成空格。`\N`/`\n` 两侧都是中日韩文字时直接相接，
 * 否则「今天我们来\N探店这家火锅店」会被存成「…来 探店…」，
 * 搜「探店」零结果。**不升版本号的话，已经提取过的素材会一直命中旧缓存，
 * 拿到那份被空格劈开的文本，改了代码却毫无反应。**
 *
 * 注意它只是**基础**版本号，实际写进库的是 `engineLabel()` 拼上字形偏好的结果。
 * 另外它管的是「直接导入」这一整条路径，不只字幕——纯文本也在内，
 * 所以名字里的 subtitle 只是历史遗留，改动任一解析器都要动这个号。
 */
export const PARSER_VERSION = 'subtitle-v2'

/** 提取文本的来源标记，与 schema 里 `asset_text_segments.source` 对应 */
const SOURCE = 'file'

/**
 * 直接导入的文本文件不该有这么大。超过这个体积基本可以断定不是文本
 * （或文件已损坏），拒绝读进内存比事后 OOM 更好。
 */
const MAX_TEXT_BYTES = 16 * 1024 * 1024

/**
 * 可直接导入、不需要任何识别引擎的文本格式。
 *
 * 这两类合起来正好等于 config.ts 里 `text` 那一档的**全部**扩展名，
 * 也就是说：扫描器认作文本的素材，都能直接导入。有一条测试钉住这个不变量
 * （见 importer.test.ts）——否则往 config 里加一个扩展名，它会静默地
 * 卡在「暂不提供」上，而用户完全无从判断是程序没做还是文件有问题。
 */
export const DIRECT_IMPORT_EXTENSIONS: readonly string[] = [
  ...SUBTITLE_EXTENSIONS,
  ...PLAIN_TEXT_EXTENSIONS,
]

export function canImportDirectly(ext: string): boolean {
  return isSubtitleExtension(ext) || isPlainTextExtension(ext)
}

/** 按扩展名分派到对应的解析器：字幕带时间轴，纯文本按行切。 */
function parseDirectText(content: string, ext: string): ExtractedSegment[] {
  return isSubtitleExtension(ext) ? parseSubtitle(content, ext) : parsePlainText(content)
}

export interface ImportTextResult {
  assetId: number
  /** done = 已提取；即便一个字都没解析出来也是 done，只是文本为空 */
  status: 'done'
  segmentCount: number
  /** true 表示命中指纹缓存，本次没有重新解析 */
  reused: boolean
  /** 解析出的段落数为 0 时为 true，界面据此给出「没有可导入的内容」提示 */
  empty: boolean
}

export function importTextFile(db: Db, assetId: number): Result<ImportTextResult> {
  const asset = findAsset(db, assetId)
  if (!asset) return err('ASSET_NOT_FOUND', `素材不存在（id=${assetId}）`, { id: assetId })

  if (!canImportDirectly(asset.ext)) {
    return err(
      'EXTRACTION_UNSUPPORTED_TYPE',
      `「${asset.ext}」不是可直接读取的文本格式，可用的是：${DIRECT_IMPORT_EXTENSIONS.join('、')}`,
      { ext: asset.ext },
    )
  }

  // 落库前先读偏好。**这一步必须在缓存判定之前**——它参与缓存键。
  const script = readTextScript(db)
  const label = engineLabel(PARSER_VERSION, script)

  if (asset.sizeBytes > MAX_TEXT_BYTES) {
    const message = `文本文件过大（${Math.round(asset.sizeBytes / 1024 / 1024)} MB），已跳过`
    markFailed(db, asset, { label, source: SOURCE, code: 'EXTRACTION_FAILED', message })
    return err('EXTRACTION_FAILED', message, { id: assetId, sizeBytes: asset.sizeBytes })
  }

  const cached = findCachedRun(db, asset, label)
  if (cached !== null) {
    const segmentCount = countSegments(db, assetId)
    return ok({
      assetId,
      status: 'done',
      segmentCount,
      reused: true,
      empty: segmentCount === 0,
    })
  }

  let content: string
  try {
    content = decodeSubtitleText(fs.readFileSync(asset.path))
  } catch (error) {
    // 文件在磁盘上被删了、被移走了、或没有读权限——这三种对用户来说是
    // 不同的问题，但都表现为「读不到」，把系统给的原文带上更好排查。
    const message = `无法读取文本文件：${error instanceof Error ? error.message : String(error)}`
    markFailed(db, asset, { label, source: SOURCE, code: 'EXTRACTION_FAILED', message })
    return err('EXTRACTION_FAILED', message, { id: assetId, path: asset.path })
  }

  // 解析单独兜一次底。两个解析器都是纯字符串处理，构造上不会抛；
  // 但这是**用户点一下按钮就走到**的路径，一旦抛出就是 500，
  // 用户看到的是一句「服务器错误」，而真正的原因（哪个文件、什么内容）
  // 哪儿都没留下。宁可记成一次提取失败——素材状态、原因都在库里，
  // 好过让整个请求崩掉。
  let segments: ExtractedSegment[]
  try {
    segments = parseDirectText(content, asset.ext)
  } catch (error) {
    const message = `无法解析文本文件：${error instanceof Error ? error.message : String(error)}`
    markFailed(db, asset, { label, source: SOURCE, code: 'EXTRACTION_FAILED', message })
    return err('EXTRACTION_FAILED', message, { id: assetId, path: asset.path })
  }

  const segmentCount = persistSegments(db, asset, {
    source: SOURCE,
    label,
    script,
    segments,
  })

  return ok({
    assetId,
    status: 'done',
    segmentCount,
    reused: false,
    // 空字幕是「已提取、无内容」，不是失败——前者不需要重试，后者需要
    empty: segmentCount === 0,
  })
}

/** 已导入的段落，供详情面板回看提取结果。 */
export interface TextSegment {
  id: number
  source: string
  ordinal: number
  text: string
  startMs: number | null
  endMs: number | null
}

const DEFAULT_SEGMENT_LIMIT = 200
const MAX_SEGMENT_LIMIT = 1000

export function listSegments(
  db: Db,
  assetId: number,
  options: { limit?: number | undefined; offset?: number | undefined } = {},
): { items: TextSegment[]; total: number } {
  const total = countSegments(db, assetId)
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEGMENT_LIMIT, 1), MAX_SEGMENT_LIMIT)
  const offset = Math.max(options.offset ?? 0, 0)

  const rows = db
    .prepare(
      `SELECT id, source, ordinal, text, start_ms, end_ms
         FROM asset_text_segments
        WHERE asset_id = ?
        ORDER BY ordinal ASC
        LIMIT ? OFFSET ?`,
    )
    .all(assetId, limit, offset) as Array<{
    id: number
    source: string
    ordinal: number
    text: string
    start_ms: number | null
    end_ms: number | null
  }>

  return {
    items: rows.map((row) => ({
      id: row.id,
      source: row.source,
      ordinal: row.ordinal,
      text: row.text,
      startMs: row.start_ms,
      endMs: row.end_ms,
    })),
    total,
  }
}
