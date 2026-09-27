import type { AssetKind } from '../config.js'
import type { Db } from '../db/index.js'
import type { ExtractStatus } from '../library/assets.js'
import { escapeLikePattern } from './normalize.js'
import { toSegmentHit } from './snippet.js'
import type { MatchSource, SegmentHit, SearchTerm } from './types.js'

/**
 * 三路召回。
 *
 * ## 为什么是三条路，而不是一条
 *
 * 因为三种数据的形态完全不同，用同一个工具必然有一方受损（实测见
 * spikes/search-tokenizer/probe-fts-query.mjs）：
 *
 *   - **文件名**：短文本、小基数、期望子串包含。走 LIKE。
 *     实测 10 万条 LIKE 全表扫 6.7 ms。
 *   - **标签**：更短的文本、更小的基数。走 LIKE，3000 条仅 0.1 ms。
 *   - **正文**：长文本、大基数、需要相关度排序。≥3 字走 FTS（trigram）。
 *     ≤2 字 FTS 无能为力（返回 0 行且不报错），退回 LIKE 全表扫。
 *
 * 最后一条曾经是设计里最纠结的地方：两字词是**最常见**的查询形态，
 * 而 trigram 恰好处理不了。原先打算「两字词只搜文件名与标签」并降级提示，
 * 但实测正文 LIKE 全表扫 20 万段只要 24 ms——完全负担得起。
 * 按原计划做会白白牺牲最常用的查询，所以兜底改为一律扫正文。
 */

/** 一次召回最多带回多少条正文片段，防止超大素材把内存吃光 */
const MAX_SEGMENT_ROWS = 2000

export interface RecallBucket {
  assetId: number
  /** 命中的具体文本（文件名或标签名），供界面展示「命中了哪个」 */
  matchedTexts: string[]
  /** 命中的关键词（已去重） */
  matchedTerms: Set<string>
}

export interface SegmentRecall {
  /** assetId → 该素材命中的正文片段 */
  segments: Map<number, SegmentHit[]>
  /** assetId → 该素材正文命中的总段数（可能大于片段数，只展示了前几条） */
  counts: Map<number, number>
  /** assetId → 该素材所有命中段里最小的 bm25（越小越相关）。纯 LIKE 命中时缺失。 */
  bestRanks: Map<number, number>
}

export function emptySegmentRecall(): SegmentRecall {
  return { segments: new Map(), counts: new Map(), bestRanks: new Map() }
}

/**
 * 合并正文的两条召回路径（FTS 与 LIKE 兜底）。
 *
 * 一个长词与一个短词可能命中**同一段**（「剪辑师」走 FTS、「探店」走 LIKE，
 * 两者常出现在同一句里）。所以片段要按 segmentId 去重，
 * 否则用户会在同一条结果里看到同一段文字重复两遍。
 *
 * 计数取**较大值**而不是相加：同一段被两条路径各算一次会让
 * 「共 N 段」虚高，用户点进去发现没那么多段。宁可少报也不能虚报。
 */
export function mergeSegmentRecalls(a: SegmentRecall, b: SegmentRecall): SegmentRecall {
  const merged = emptySegmentRecall()

  const seen = new Map<number, Set<number>>()
  for (const source of [a, b]) {
    for (const [assetId, hits] of source.segments) {
      const known = seen.get(assetId) ?? new Set<number>()
      const list = merged.segments.get(assetId) ?? []

      for (const hit of hits) {
        if (known.has(hit.segmentId)) continue
        known.add(hit.segmentId)
        list.push(hit)
      }
      seen.set(assetId, known)
      merged.segments.set(assetId, list)
    }

    for (const [assetId, count] of source.counts) {
      merged.counts.set(assetId, Math.max(merged.counts.get(assetId) ?? 0, count))
    }

    // rank 取更小的那个：两条路径都命中时，有相关度可用就用它
    for (const [assetId, rank] of source.bestRanks) {
      const current = merged.bestRanks.get(assetId)
      merged.bestRanks.set(assetId, current === undefined ? rank : Math.min(current, rank))
    }
  }

  return merged
}

/** 素材级筛选条件，三条召回路径都要用同一个，否则结果会自相矛盾。 */
export interface AssetFilter {
  kind?: AssetKind | undefined
  extractStatus?: ExtractStatus | undefined
  directoryId?: number | undefined
}

function filterClauses(filter: AssetFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  if (filter.kind !== undefined) {
    clauses.push('a.kind = ?')
    params.push(filter.kind)
  }
  if (filter.extractStatus !== undefined) {
    clauses.push('a.extract_status = ?')
    params.push(filter.extractStatus)
  }
  if (filter.directoryId !== undefined) {
    clauses.push('a.directory_id = ?')
    params.push(filter.directoryId)
  }

  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params }
}

/**
 * 按文件名召回。
 *
 * 所有词都走 LIKE，**不分长短**：文件名是短文本，用不上分词索引，
 * 而且用户搜文件名时期望的就是子串包含（「第三期」要能搜到「访谈第三期终版.mp4」）。
 * 多个词之间是 OR——任一命中即算该素材被召回，命中几个词由排序去区分。
 */
export function recallFileNames(
  db: Db,
  terms: SearchTerm[],
  filter: AssetFilter,
): Map<number, RecallBucket> {
  if (terms.length === 0) return new Map()

  const { sql: filterSql, params: filterParams } = filterClauses(filter)
  const conditions = terms.map(() => "a.file_name LIKE ? ESCAPE '\\'").join(' OR ')
  const params = terms.map((term) => `%${escapeLikePattern(term.text)}%`)

  const rows = db
    .prepare(`SELECT a.id AS asset_id, a.file_name FROM assets a WHERE (${conditions})${filterSql}`)
    .all(...params, ...filterParams) as Array<{ asset_id: number; file_name: string }>

  const buckets = new Map<number, RecallBucket>()
  for (const row of rows) {
    const bucket = buckets.get(row.asset_id) ?? {
      assetId: row.asset_id,
      matchedTexts: [],
      matchedTerms: new Set<string>(),
    }
    bucket.matchedTexts.push(row.file_name)
    // 记录是**哪个词**命中的：命中词越多，排序越靠前
    for (const term of terms) {
      if (row.file_name.toLowerCase().includes(term.text.toLowerCase())) {
        bucket.matchedTerms.add(term.text)
      }
    }
    buckets.set(row.asset_id, bucket)
  }
  return buckets
}

/** 按标签名召回。与文件名同理，全部走 LIKE、OR 连接。 */
export function recallTags(
  db: Db,
  terms: SearchTerm[],
  filter: AssetFilter,
): Map<number, RecallBucket> {
  if (terms.length === 0) return new Map()

  const { sql: filterSql, params: filterParams } = filterClauses(filter)
  const conditions = terms.map(() => "t.name LIKE ? ESCAPE '\\'").join(' OR ')
  const params = terms.map((term) => `%${escapeLikePattern(term.text)}%`)

  const rows = db
    .prepare(
      `SELECT at.asset_id, t.name
         FROM tags t
         JOIN asset_tags at ON at.tag_id = t.id
         JOIN assets a ON a.id = at.asset_id
        WHERE (${conditions})${filterSql}`,
    )
    .all(...params, ...filterParams) as Array<{ asset_id: number; name: string }>

  const buckets = new Map<number, RecallBucket>()
  for (const row of rows) {
    const bucket = buckets.get(row.asset_id) ?? {
      assetId: row.asset_id,
      matchedTexts: [],
      matchedTerms: new Set<string>(),
    }
    bucket.matchedTexts.push(row.name)
    for (const term of terms) {
      if (row.name.toLowerCase().includes(term.text.toLowerCase())) {
        bucket.matchedTerms.add(term.text)
      }
    }
    buckets.set(row.asset_id, bucket)
  }
  return buckets
}

interface SegmentRow {
  id: number
  asset_id: number
  source: string
  ordinal: number
  text: string
  start_ms: number | null
  end_ms: number | null
  frame_ms: number | null
  rank: number | null
}

/**
 * 正文召回 —— FTS 路径（≥3 字的词）。
 *
 * ## MATERIALIZED 不是可选优化，是必须的
 *
 * `MIN(bm25(fts_segments))` 直接抛
 * 「unable to use function bm25 in the requested context」——
 * bm25 只能在 FTS 表的扫描上下文里求值。而**普通子查询也不行**：
 * SQLite 会把子查询扁平化（flattening）合并进外层查询，
 * bm25 于是又落回聚合上下文，同样报错。
 *
 * 实测（spikes/search-tokenizer/probe-rank2.mjs）：
 *   普通子查询 + MIN      → 报错
 *   子查询 + 窗口函数      → 能跑，但一旦在同一层再加聚合就又报错
 *   WITH ... AS MATERIALIZED → 稳定可用
 *
 * 用 MATERIALIZED 而不是靠窗口函数「碰巧」阻止扁平化：后者是隐式依赖
 * 查询优化器的行为，换个 SQLite 版本就可能失效，而失效方式是**整个检索功能报错**。
 * recall.test.ts 里有一条测试专门钉住这个写法。
 */
export function recallSegmentsFts(
  db: Db,
  matchExpression: string,
  terms: SearchTerm[],
  filter: AssetFilter,
  segmentsPerAsset: number,
): SegmentRecall {
  const result = emptySegmentRecall()
  const { sql: filterSql, params: filterParams } = filterClauses(filter)
  const termTexts = terms.map((term) => term.text)

  const rows = db
    .prepare(
      `WITH hits AS MATERIALIZED (
         SELECT s.id, s.asset_id, s.source, s.ordinal, s.text,
                s.start_ms, s.end_ms, s.frame_ms,
                bm25(fts_segments) AS rank
           FROM fts_segments
           JOIN asset_text_segments s ON s.id = fts_segments.rowid
           JOIN assets a ON a.id = s.asset_id
          WHERE fts_segments MATCH ?${filterSql}
          LIMIT ?
       ),
       ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY rank ASC) AS n,
                COUNT(*)     OVER (PARTITION BY asset_id)                    AS total_hits
           FROM hits
       )
       SELECT id, asset_id, source, ordinal, text, start_ms, end_ms, frame_ms, rank, total_hits
         FROM ranked
        WHERE n <= ?
        ORDER BY rank ASC`,
    )
    .all(matchExpression, ...filterParams, MAX_SEGMENT_ROWS, segmentsPerAsset) as Array<
    SegmentRow & { total_hits: number }
  >

  for (const row of rows) {
    const list = result.segments.get(row.asset_id) ?? []
    list.push(toSegmentHit(row, termTexts))
    result.segments.set(row.asset_id, list)
    result.counts.set(row.asset_id, row.total_hits)

    // FTS 路径下 bm25 必然有值，这里判 null 只是为了让类型收窄——
    // 不写成断言是因为断言不会在真的为 null 时告诉我们
    const best = result.bestRanks.get(row.asset_id)
    if (row.rank !== null && (best === undefined || row.rank < best)) {
      result.bestRanks.set(row.asset_id, row.rank)
    }
  }
  return result
}

/**
 * 正文召回 —— LIKE 兜底路径（≤2 字的词）。
 *
 * 全表扫。实测 20 万段 24 ms，可以接受；这是为了不让「探店」「美食」
 * 这类最常用的两字词彻底搜不到正文而付出的代价，值得。
 *
 * 代价要说清楚：LIKE 没有相关度可言，`rank` 一律为 null。
 * 排序时这类命中会排在同档次的 FTS 命中之后（见 rank.ts）。
 */
export function recallSegmentsLike(
  db: Db,
  shortTerms: SearchTerm[],
  filter: AssetFilter,
  segmentsPerAsset: number,
): SegmentRecall {
  const result = emptySegmentRecall()
  if (shortTerms.length === 0) return result

  const { sql: filterSql, params: filterParams } = filterClauses(filter)
  const conditions = shortTerms.map(() => "s.text LIKE ? ESCAPE '\\'").join(' OR ')
  const params = shortTerms.map((term) => `%${escapeLikePattern(term.text)}%`)
  const termTexts = shortTerms.map((term) => term.text)

  const rows = db
    .prepare(
      `SELECT s.id, s.asset_id, s.source, s.ordinal, s.text, s.start_ms, s.end_ms, s.frame_ms
         FROM asset_text_segments s
         JOIN assets a ON a.id = s.asset_id
        WHERE (${conditions})${filterSql}
        ORDER BY s.asset_id ASC, s.ordinal ASC
        LIMIT ?`,
    )
    .all(...params, ...filterParams, MAX_SEGMENT_ROWS) as SegmentRow[]

  // 每个素材只保留前 segmentsPerAsset 条。计数仍按实际命中总数来，
  // 否则界面会显示「共 2 段」而其实有 50 段。
  const perAssetTaken = new Map<number, number>()
  for (const row of rows) {
    result.counts.set(row.asset_id, (result.counts.get(row.asset_id) ?? 0) + 1)

    const taken = perAssetTaken.get(row.asset_id) ?? 0
    if (taken >= segmentsPerAsset) continue
    perAssetTaken.set(row.asset_id, taken + 1)

    const list = result.segments.get(row.asset_id) ?? []
    list.push(toSegmentHit({ ...row, rank: null }, termTexts))
    result.segments.set(row.asset_id, list)
  }
  return result
}

/** 把三条路径的命中来源汇总到一处。 */
export function mergeSources(
  target: Map<number, { sources: Set<MatchSource>; terms: Set<string> }>,
  assetId: number,
  source: MatchSource,
  terms: Iterable<string>,
): void {
  const entry = target.get(assetId) ?? { sources: new Set<MatchSource>(), terms: new Set<string>() }
  entry.sources.add(source)
  for (const term of terms) entry.terms.add(term)
  target.set(assetId, entry)
}
