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
} from './persist.js'
import { SUBTITLE_EXTENSIONS, decodeSubtitleText, isSubtitleExtension, parseSubtitle } from './subtitle.js'

/**
 * 字幕文件的直接导入（任务 5.15）。
 *
 * 这是整条提取链路里**唯一不需要下载任何模型**的部分，因此它能先于
 * 语音转写与 OCR 独立交付（design.md 决策 12、tasks 5.14–5.16）。
 *
 * 刻意**不走后台任务队列**：队列是为「长耗时、吃资源、要能取消」的
 * 转写与识别准备的（决策 4），而解析一份几百 KB 的字幕是毫秒级的纯
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
 * 注意它只是**基础**版本号，实际写进库的是 `engineLabel()` 拼上字形偏好的结果。
 */
export const PARSER_VERSION = 'subtitle-v1'

/** 提取文本的来源标记，与 schema 里 `asset_text_segments.source` 对应 */
const SOURCE = 'file'

/**
 * 字幕文件不该有这么大。超过这个体积基本可以断定不是字幕
 * （或文件已损坏），拒绝读进内存比事后 OOM 更好。
 */
const MAX_SUBTITLE_BYTES = 16 * 1024 * 1024

export interface ImportSubtitleResult {
  assetId: number
  /** done = 已提取；即便一个字都没解析出来也是 done，只是文本为空 */
  status: 'done'
  segmentCount: number
  /** true 表示命中指纹缓存，本次没有重新解析 */
  reused: boolean
  /** 解析出的字幕条数为 0 时为 true，界面据此给出「没有可导入的内容」提示 */
  empty: boolean
}

export function importSubtitleText(db: Db, assetId: number): Result<ImportSubtitleResult> {
  const asset = findAsset(db, assetId)
  if (!asset) return err('ASSET_NOT_FOUND', `素材不存在（id=${assetId}）`, { id: assetId })

  if (!isSubtitleExtension(asset.ext)) {
    return err(
      'EXTRACTION_UNSUPPORTED_TYPE',
      `「${asset.ext}」不是可直接解析的字幕格式，可用的是：${SUBTITLE_EXTENSIONS.join('、')}`,
      { ext: asset.ext },
    )
  }

  // 落库前先读偏好。**这一步必须在缓存判定之前**——它参与缓存键。
  const script = readTextScript(db)
  const label = engineLabel(PARSER_VERSION, script)

  if (asset.sizeBytes > MAX_SUBTITLE_BYTES) {
    const message = `字幕文件过大（${Math.round(asset.sizeBytes / 1024 / 1024)} MB），已跳过`
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
    const message = `无法读取字幕文件：${error instanceof Error ? error.message : String(error)}`
    markFailed(db, asset, { label, source: SOURCE, code: 'EXTRACTION_FAILED', message })
    return err('EXTRACTION_FAILED', message, { id: assetId, path: asset.path })
  }

  const cues = parseSubtitle(content, asset.ext)
  const segmentCount = persistSegments(db, asset, {
    source: SOURCE,
    label,
    script,
    segments: cues,
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
