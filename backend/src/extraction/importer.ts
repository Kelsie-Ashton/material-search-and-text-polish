import fs from 'node:fs'

import { type Db, inTransaction } from '../db/index.js'
import { type AssetDetail, findAsset } from '../library/assets.js'
import { err, ok, type Result } from '../shared/result.js'
import type { TextScript } from '../shared/text-script.js'
import { readTextScript } from '../settings/preferences.js'
import { convertScript } from './chinese.js'
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

interface RunRow {
  id: number
}

/**
 * 记录一次失败的提取。
 *
 * 失败也要留下 `extraction_runs` 行：用户看到「提取失败」时，
 * 下一步一定是问「为什么」。原因必须落在库里，而不是只回给这一次请求。
 */
function markFailed(db: Db, asset: AssetDetail, label: string, code: string, message: string): void {
  const now = Date.now()
  inTransaction(db, () => {
    const run = db
      .prepare(
        `INSERT INTO extraction_runs
           (asset_id, fingerprint, status, engine_versions, error_code, error_message, started_at, finished_at)
         VALUES (?, ?, 'failed', ?, ?, ?, ?, ?)`,
      )
      .run(asset.id, asset.fingerprint, label, code, message, now, now)

    db.prepare(
      `INSERT INTO extraction_run_sources (run_id, source, status, segment_count, error_code, error_message)
       VALUES (?, ?, 'failed', 0, ?, ?)`,
    ).run(run.lastInsertRowid, SOURCE, code, message)

    db.prepare(
      `UPDATE assets SET extract_status = 'failed', extract_error = ?, updated_at = ? WHERE id = ?`,
    ).run(message, now, asset.id)
  })
}

/**
 * 本次提取的「引擎版本」标签，同时也是缓存键的一部分。
 *
 * **字形必须进来。** 落库的文本会随用户偏好变（简体 / 繁体），
 * 所以「同一份文件、同一个解析器版本」并不保证产出同一份文本。
 * 若只按 PARSER_VERSION 判缓存，用户把偏好从简体改成繁体再点提取，
 * 会命中旧缓存、拿到简体——**设置改了却毫无反应**，
 * 而且不报任何错，是最难查的那类问题。
 */
function engineLabel(script: TextScript): string {
  return `${PARSER_VERSION}+${script}`
}

/**
 * 指纹缓存：文件没变、解析器版本与字形偏好都没变、且上次跑成功了，就不必重来。
 *
 * 这不只是省时间——**重新导入会先删掉旧段落再写入**，无谓地重跑一次
 * 就多一次「中途失败导致文本丢失」的机会。
 */
function findCachedRun(db: Db, asset: AssetDetail, label: string): number | null {
  const row = db
    .prepare(
      `SELECT id FROM extraction_runs
        WHERE asset_id = ? AND fingerprint = ? AND status = 'succeeded' AND engine_versions = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(asset.id, asset.fingerprint, label) as RunRow | undefined
  return row?.id ?? null
}

function countSegments(db: Db, assetId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM asset_text_segments WHERE asset_id = ?')
    .get(assetId) as { n: number }
  return row.n
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
  const label = engineLabel(script)

  if (asset.sizeBytes > MAX_SUBTITLE_BYTES) {
    const message = `字幕文件过大（${Math.round(asset.sizeBytes / 1024 / 1024)} MB），已跳过`
    markFailed(db, asset, label, 'EXTRACTION_FAILED', message)
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
    markFailed(db, asset, label, 'EXTRACTION_FAILED', message)
    return err('EXTRACTION_FAILED', message, { id: assetId, path: asset.path })
  }

  const cues = parseSubtitle(content, asset.ext)
  const now = Date.now()

  inTransaction(db, () => {
    // 重新导入是**替换**而非追加：旧段落必须清掉，否则改过字幕再导入一次，
    // 检索会把新旧两份文本都命中，用户看到重复且互相矛盾的片段。
    db.prepare('DELETE FROM asset_text_segments WHERE asset_id = ?').run(assetId)

    const run = db
      .prepare(
        `INSERT INTO extraction_runs
           (asset_id, fingerprint, status, engine_versions, started_at, finished_at)
         VALUES (?, ?, 'succeeded', ?, ?, ?)`,
      )
      .run(asset.id, asset.fingerprint, label, now, now)

    db.prepare(
      `INSERT INTO extraction_run_sources (run_id, source, status, segment_count)
       VALUES (?, ?, 'succeeded', ?)`,
    ).run(run.lastInsertRowid, SOURCE, cues.length)

    // 段落写入由 fts_segments 上的 AFTER INSERT 触发器同步进全文索引，
    // 这里不需要（也不能）手动维护 FTS。
    const insert = db.prepare(
      `INSERT INTO asset_text_segments
         (asset_id, run_id, source, ordinal, text, start_ms, end_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    cues.forEach((cue, index) => {
      insert.run(
        asset.id,
        run.lastInsertRowid,
        SOURCE,
        index,
        // 唯一一处字形转换。**落库的文本必须是转换后的**，
        // 因为 FTS 索引由触发器跟着这一行同步——索引里存的就是这里写下的字，
        // 事后再改就没机会了（除非整段重写）。
        convertScript(cue.text, script),
        cue.startMs,
        cue.endMs,
        now,
      )
    })

    db.prepare(
      `UPDATE assets SET extract_status = 'done', extract_error = NULL, extracted_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, now, asset.id)
  })

  return ok({
    assetId,
    status: 'done',
    segmentCount: cues.length,
    reused: false,
    empty: cues.length === 0,
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
