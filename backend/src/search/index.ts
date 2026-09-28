import type { Db } from '../db/index.js'
import { summariesByIds, type AssetSummary } from '../library/assets.js'
import { ok, type Result } from '../shared/result.js'
import { normalizeQuery, toFtsMatchExpression, warningsFor } from './normalize.js'
import {
  emptySegmentRecall,
  mergeSegmentRecalls,
  recallFileNames,
  recallSegmentsFts,
  recallSegmentsLike,
  recallTags,
  type AssetFilter,
  type RecallBucket,
  type SegmentRecall,
} from './recall.js'
import { rankHits, sortedSources, type RankInput } from './rank.js'
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEGMENTS_PER_ASSET,
  type MatchSource,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
} from './types.js'

/**
 * 检索的唯一入口。
 *
 * 流程刻意分成「召回 → 合并 → 排序 → 分页 → 取详情」五步，而不是
 * 让 SQL 一次查完。原因是三条召回路径的**分数不可比**（bm25 是负数、
 * LIKE 压根没有分数），只有拿回内存里才能按可解释的档次排序。
 * 代价是命中的素材数受内存限制，所以每步都设了上限。
 *
 * 分页放在排序**之后**、取详情**之前**：素材可能有几万条命中，
 * 但用户一次只看 30 条，没必要为不展示的结果构造片段、读元数据。
 */

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_SEARCH_LIMIT
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SEARCH_LIMIT
  return Math.min(Math.floor(raw), MAX_SEARCH_LIMIT)
}

/** 把三条召回路径的结果汇总成待排序的候选。 */
function collectCandidates(
  fileNames: Map<number, RecallBucket>,
  tags: Map<number, RecallBucket>,
  segments: SegmentRecall,
): RankInput[] {
  const candidates = new Map<number, RankInput>()

  const ensure = (assetId: number): RankInput => {
    const existing = candidates.get(assetId)
    if (existing) return existing
    const created: RankInput = {
      assetId,
      names: [],
      tags: [],
      segments: [],
      segmentCount: 0,
      bestRank: undefined,
      terms: new Set<string>(),
      sources: new Set<MatchSource>(),
    }
    candidates.set(assetId, created)
    return created
  }

  for (const bucket of fileNames.values()) {
    const entry = ensure(bucket.assetId)
    entry.names.push(...bucket.matchedTexts)
    entry.sources.add('file_name')
    for (const term of bucket.matchedTerms) entry.terms.add(term)
  }

  for (const bucket of tags.values()) {
    const entry = ensure(bucket.assetId)
    entry.tags.push(...bucket.matchedTexts)
    entry.sources.add('tag')
    for (const term of bucket.matchedTerms) entry.terms.add(term)
  }

  for (const [assetId, hits] of segments.segments) {
    const entry = ensure(assetId)
    entry.segments.push(...hits)
    entry.sources.add('segment')
    entry.segmentCount = Math.max(entry.segmentCount, segments.counts.get(assetId) ?? hits.length)

    const rank = segments.bestRanks.get(assetId)
    if (rank !== undefined) {
      entry.bestRank = entry.bestRank === undefined ? rank : Math.min(entry.bestRank, rank)
    }
  }

  // 只遍历 segments 是不够的。片段有全局上限（recall.ts 的 MAX_SEGMENT_ROWS），
  // 命中集中在少数素材时，它们的额度会把上限用光，后面的素材**一段都取不回来**。
  // 那些素材不会出现在 segments 里，于是整条结果消失：用户搜一个词，
  // 某个文件明明命中了几十段，列表里连它的卡片都没有——比数字差几条严重得多。
  //
  // 计数是准的（见 countHitsByAsset），所以从计数里把它们补上。
  // 它们以「命中数正确、片段为空」的形态出现，界面据此如实说明。
  for (const [assetId, count] of segments.counts) {
    const entry = ensure(assetId)
    entry.sources.add('segment')
    entry.segmentCount = Math.max(entry.segmentCount, count)
  }

  return [...candidates.values()]
}

export function search(db: Db, rawQuery: string, options: SearchOptions = {}): Result<SearchResult> {
  const normalized = normalizeQuery(rawQuery)
  if (!normalized.ok) return normalized

  const { terms } = normalized.value
  const filter: AssetFilter = {
    kind: options.kind,
    extractStatus: options.extractStatus,
    directoryId: options.directoryId,
  }
  // 召回时就按「上限」而不是「展示条数」来取：折叠显示三条是前端的事，
  // 后端只给三条的话，用户在界面上点「展开全部」会没有任何东西可展开。
  const segmentsPerAsset = options.segmentsPerAsset ?? MAX_SEGMENTS_PER_ASSET

  const fileNames = recallFileNames(db, terms, filter)
  const tags = recallTags(db, terms, filter)

  // 正文的两条路径**互不替代**：长词走 FTS，短词走 LIKE 兜底。
  // 只走其中一条，会漏掉另一半关键词的命中。
  const matchExpression = toFtsMatchExpression(terms)
  const ftsRecall =
    matchExpression === null
      ? emptySegmentRecall()
      : recallSegmentsFts(db, matchExpression, terms, filter, segmentsPerAsset)

  const shortTerms = terms.filter((term) => term.path === 'like')
  const likeRecall = recallSegmentsLike(db, shortTerms, filter, segmentsPerAsset)

  const ranked = rankHits(collectCandidates(fileNames, tags, mergeSegmentRecalls(ftsRecall, likeRecall)))

  const limit = clampLimit(options.limit)
  const offset = Math.max(options.offset ?? 0, 0)
  const page = ranked.slice(offset, offset + limit)

  const summaries = summariesByIds(
    db,
    page.map((hit) => hit.assetId),
  )

  const items: SearchHit[] = []
  for (const hit of page) {
    // 素材可能在召回与取详情之间被删掉（另一处正在扫描，或用户移除了目录）。
    // 跳过而不是报错：少显示一条，好过整个检索失败。
    const asset: AssetSummary | undefined = summaries.get(hit.assetId)
    if (!asset) continue

    items.push({
      asset,
      matchedIn: sortedSources(hit.sources),
      matchedNames: [...new Set(hit.names)],
      matchedTags: [...new Set(hit.tags)],
      // 这里仍然要切一刀：FTS 与 LIKE 两条路径各自带回了 segmentsPerAsset 条，
      // 合并去重后可能接近两倍（同一段被两条路径命中时才会更少）。
      segments: hit.segments.slice(0, segmentsPerAsset),
      segmentHitCount: hit.segmentCount,
      tier: hit.tier,
      matchedTerms: [...hit.terms],
    })
  }

  return ok({
    items,
    total: ranked.length,
    terms,
    warnings: warningsFor(terms),
  })
}

export { normalizeQuery, toFtsMatchExpression }
export type { SearchResult, SearchHit, SearchOptions }
