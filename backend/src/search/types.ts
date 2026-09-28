import type { AssetKind } from '../config.js'
import type { AssetSummary, ExtractStatus } from '../library/assets.js'

/**
 * 检索的 DTO 契约。
 *
 * 单独一个文件，是为了让前端可以照着它先写界面——
 * 检索页的 UI 不必等后端实现完才能动工。
 */

/** 一条结果是从哪儿命中的。同一素材可以从多处命中，此时合并为一条结果。 */
export type MatchSource = 'file_name' | 'tag' | 'segment'

export const MATCH_SOURCE_LABELS: Record<MatchSource, string> = {
  file_name: '文件名',
  tag: '标签',
  segment: '正文',
}

/** 关键词被分流到哪条召回路径。 */
export type RecallPath = 'fts' | 'like'

export interface SearchTerm {
  /** 归一化之后的词（已 trim） */
  text: string
  /** 码点长度，决定走哪条路径 */
  length: number
  path: RecallPath
}

export interface SearchWarning {
  code: 'SHORT_TERM_LIKE_FALLBACK' | 'NO_FTS_TERMS'
  message: string
  /** 触发这个警告的词 */
  terms: string[]
}

export interface SnippetRange {
  start: number
  end: number
}

export interface SegmentHit {
  segmentId: number
  source: string
  ordinal: number
  startMs: number | null
  endMs: number | null
  frameMs: number | null
  /** 截取后的上下文片段，不是整段原文 */
  snippet: string
  /**
   * 片段内命中的区间，供前端高亮。
   *
   * 下标是**相对 snippet 的 UTF-16 偏移**，也就是 JS 字符串的常规下标——
   * 直接 `snippet.slice(h.start, h.end)` 即可。不要按「字符数」去理解它：
   * emoji 这类代理对在 UTF-16 里占 2 个下标。
   */
  highlights: SnippetRange[]
  /** 片段是否被截断过（前面或后面还有内容） */
  truncated: { head: boolean; tail: boolean }
  /** 该段在 FTS 里的 bm25 分数；纯 LIKE 命中的段为 null */
  rank: number | null
}

export interface SearchHit {
  asset: AssetSummary
  /** 命中来源，去重后按 file_name → tag → segment 顺序 */
  matchedIn: MatchSource[]
  /** 命中的文件名（只有 file_name 命中时非空；用于展示「命中了哪个词」） */
  matchedNames: string[]
  /** 命中的标签名 */
  matchedTags: string[]
  /**
   * 正文命中片段。
   *
   * **这里是该素材命中的全部片段**，不再只给前几条——界面上「展开全部」
   * 要用的就是它。默认折叠显示几条纯属**界面的事**（见前端
   * api/search.ts 的 COLLAPSED_SEGMENT_COUNT），接口这一层不替用户做减法：
   * 只给三条的话，「展开全部」就成了一个点不动的空按钮。
   * 唯一的上限是 MAX_SEGMENTS_PER_ASSET，那是防内存的兜底，不是展示条数。
   */
  segments: SegmentHit[]
  /**
   * 正文命中总段数。
   *
   * 正常情况下就等于 segments.length；只有单素材命中数超过
   * MAX_SEGMENTS_PER_ASSET 时才会更大，此时界面要如实说明
   * 「共 N 段，只带了 M 段」，不能让用户以为已经看全了。
   */
  segmentHitCount: number
  /** 排序档次，越小越靠前。见 rank.ts */
  tier: number
  /** 命中的关键词去重后的列表，供界面显示「命中了哪些词」 */
  matchedTerms: string[]
}

export interface SearchResult {
  items: SearchHit[]
  /** 去重后的素材总数（可能大于 items.length） */
  total: number
  /** 实际参与召回的词及其分流结果，界面据此如实说明「你的词是怎么被搜的」 */
  terms: SearchTerm[]
  warnings: SearchWarning[]
}

export interface SearchOptions {
  kind?: AssetKind | undefined
  extractStatus?: ExtractStatus | undefined
  directoryId?: number | undefined
  /**
   * 每个素材最多带回几条正文片段。
   *
   * 默认 MAX_SEGMENTS_PER_ASSET。这是**兜底上限**（防超大素材吃光内存），
   * 不是展示条数——展示几条由前端折叠/展开决定，所以这里给得很宽。
   */
  segmentsPerAsset?: number | undefined
  limit?: number | undefined
  offset?: number | undefined
}

/**
 * 单个素材最多带回多少条正文片段。
 *
 * 为什么有上限却不设成 3：接口要把命中的片段**全给前端**，否则
 * 「展开全部」无从展开。那为什么还要有上限：`recall.ts` 的
 * MAX_SEGMENT_ROWS 是**全局**兜底，一个命中 2000 段的素材仍能独占整页，
 * 把后面所有素材挤出结果。100 段对「展开全部」早已远超任何人会读的量。
 */
export const MAX_SEGMENTS_PER_ASSET = 100
export const DEFAULT_SEARCH_LIMIT = 30
export const MAX_SEARCH_LIMIT = 200
