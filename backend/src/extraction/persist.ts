import { inTransaction, type Db } from '../db/index.js'
import type { AssetDetail } from '../library/assets.js'
import type { TextScript } from '../shared/text-script.js'
import { convertScript } from './chinese.js'

/**
 * 提取结果落库 —— 全项目**唯一**一处写入 `asset_text_segments` 的地方。
 *
 * 为什么要把这段从 importer 里抽出来：它承载了三条只有在落库这一刻才成立的
 * 不变量，复制到第二条提取路径上就一定会有一条被漏掉。
 *
 * 1. **字形转换必须发生在这里。** FTS 索引由触发器跟着 `asset_text_segments`
 *    的行同步，索引里存的就是写入时的字。若在某条路径上忘了转，那条路径的
 *    内容就是搜不到的——而且不报错。收敛成一处，加新提取路径（OCR、画面文字）
 *    时就没有"忘记转"这个选项。
 * 2. **重跑是替换而非追加。** 旧段落必须先删掉，否则改过的素材会有新旧两份文本，
 *    检索时同一句话出现两次。
 * 3. **段落、运行记录、素材状态必须同事务。** 分两次提交的话，中途失败会留下
 *    「状态说已提取、实际没有文本」或反过来的不一致。
 */

/** 一段提取文本。字幕解析与语音转写都产出这个结构。 */
export interface ExtractedSegment {
  text: string
  startMs: number | null
  endMs: number | null
}

/**
 * 本次提取的「引擎版本」标签，同时也是缓存键的一部分。
 *
 * **字形必须进来。** 落库的文本会随用户偏好变（简体 / 繁体），
 * 所以「同一份文件、同一个引擎」并不保证产出同一份文本。
 * 若只按引擎版本判缓存，用户把偏好从简体改成繁体再点提取，
 * 会命中旧缓存、拿到简体——**设置改了却毫无反应**，
 * 而且不报任何错，是最难查的那类问题。
 */
export function engineLabel(base: string, script: TextScript): string {
  return `${base}+${script}`
}

/**
 * 指纹缓存：文件没变、引擎版本与字形偏好都没变、且上次跑成功了，就不必重来。
 *
 * 这不只是省时间——**重新导入会先删掉旧段落再写入**，无谓地重跑一次
 * 就多一次「中途失败导致文本丢失」的机会。对语音转写而言更是几十分钟的差别。
 */
export function findCachedRun(db: Db, asset: AssetDetail, label: string): number | null {
  const row = db
    .prepare(
      `SELECT id FROM extraction_runs
        WHERE asset_id = ? AND fingerprint = ? AND status = 'succeeded' AND engine_versions = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(asset.id, asset.fingerprint, label) as { id: number } | undefined
  return row?.id ?? null
}

export function countSegments(db: Db, assetId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM asset_text_segments WHERE asset_id = ?')
    .get(assetId) as { n: number }
  return row.n
}

/**
 * 读某次运行里某个来源的结果。
 *
 * 缓存命中时需要它来回答「上次这个来源**跑了没有**」——没有音轨的视频
 * 也会留下一条成功的运行记录（来源状态是 skipped），光看「有没有段落」
 * 无法把「没有音轨」与「有音轨但一个字都没转出来」区分开，
 * 而界面对这两种情况要给出不同的提示。
 */
export function readRunSource(
  db: Db,
  runId: number,
  source: string,
): { status: string; segmentCount: number } | null {
  const row = db
    .prepare('SELECT status, segment_count FROM extraction_run_sources WHERE run_id = ? AND source = ?')
    .get(runId, source) as { status: string; segment_count: number } | undefined
  return row ? { status: row.status, segmentCount: row.segment_count } : null
}

/**
 * 记录一次失败的提取。
 *
 * 失败也要留下 `extraction_runs` 行：用户看到「提取失败」时，
 * 下一步一定是问「为什么」。原因必须落在库里，而不是只回给这一次请求——
 * 一次网络抖动之后用户刷新页面，那条原因就不该消失。
 */
export function markFailed(
  db: Db,
  asset: AssetDetail,
  options: { label: string; source: string; code: string; message: string },
): void {
  const now = Date.now()
  inTransaction(db, () => {
    const run = db
      .prepare(
        `INSERT INTO extraction_runs
           (asset_id, fingerprint, status, engine_versions, error_code, error_message, started_at, finished_at)
         VALUES (?, ?, 'failed', ?, ?, ?, ?, ?)`,
      )
      .run(asset.id, asset.fingerprint, options.label, options.code, options.message, now, now)

    db.prepare(
      `INSERT INTO extraction_run_sources (run_id, source, status, segment_count, error_code, error_message)
       VALUES (?, ?, 'failed', 0, ?, ?)`,
    ).run(run.lastInsertRowid, options.source, options.code, options.message)

    db.prepare(
      `UPDATE assets SET extract_status = 'failed', extract_error = ?, updated_at = ? WHERE id = ?`,
    ).run(options.message, now, asset.id)
  })
}

export interface PersistInput {
  /** audio / frame / image / file —— 与 schema 里的注释对应 */
  source: string
  /** 已含字形的引擎版本标签，见 engineLabel */
  label: string
  script: TextScript
  segments: readonly ExtractedSegment[]
  /**
   * 该来源跑了但没产出（视频没有音轨、画面没有文字）。
   *
   * 与「失败」是两件事，必须分开记：前者不需要重试，后者需要。
   * 状态记 skipped、文本为空、素材仍算「已提取」。
   */
  sourceSkippedReason?: string
  /** 这次提取得知的媒体时长，写回素材供详情页展示 */
  durationMs?: number | null
}

/**
 * 把一次来源的提取结果写入库，返回落库的段落数。
 *
 * 调用前必须先做过缓存判定——本函数无条件重写。
 */
export function persistSegments(db: Db, asset: AssetDetail, input: PersistInput): number {
  const now = Date.now()
  const sourceStatus = input.sourceSkippedReason === undefined ? 'succeeded' : 'skipped'

  inTransaction(db, () => {
    // 重新提取是**替换**而非追加。旧段落不清掉的话，改过素材再提取一次，
    // 检索会把新旧两份文本都命中，用户看到重复且互相矛盾的片段。
    db.prepare('DELETE FROM asset_text_segments WHERE asset_id = ?').run(asset.id)

    const run = db
      .prepare(
        `INSERT INTO extraction_runs
           (asset_id, fingerprint, status, engine_versions, started_at, finished_at)
         VALUES (?, ?, 'succeeded', ?, ?, ?)`,
      )
      .run(asset.id, asset.fingerprint, input.label, now, now)

    db.prepare(
      `INSERT INTO extraction_run_sources (run_id, source, status, segment_count, error_message)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      run.lastInsertRowid,
      input.source,
      sourceStatus,
      input.segments.length,
      input.sourceSkippedReason ?? null,
    )

    // 段落写入由 fts_segments 上的 AFTER INSERT 触发器同步进全文索引，
    // 这里不需要（也不能）手动维护 FTS。
    const insert = db.prepare(
      `INSERT INTO asset_text_segments
         (asset_id, run_id, source, ordinal, text, start_ms, end_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    input.segments.forEach((segment, index) => {
      insert.run(
        asset.id,
        run.lastInsertRowid,
        input.source,
        index,
        // 唯一一处字形转换，见本模块顶部说明。
        convertScript(segment.text, input.script),
        segment.startMs,
        segment.endMs,
        now,
      )
    })

    // 时长只在这次真的拿到了才覆盖：探测失败（null）不该把上次的好值抹掉
    if (input.durationMs != null) {
      db.prepare('UPDATE assets SET duration_ms = ? WHERE id = ?').run(input.durationMs, asset.id)
    }

    db.prepare(
      `UPDATE assets SET extract_status = 'done', extract_error = NULL, extracted_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, now, asset.id)
  })

  return input.segments.length
}
