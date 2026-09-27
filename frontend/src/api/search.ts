import { apiGet } from './client'
import type { AssetSummary, ExtractStatus } from './library'

/**
 * 检索接口。
 *
 * 类型与 backend/src/search/types.ts 一一对应，同样刻意重写一遍而不是
 * 跨包 import（见 api/library.ts 的说明）。**这里有一处尤其不能凭直觉改**：
 * `SegmentHit.highlights` 的下标是相对 snippet 的 **UTF-16 偏移**，
 * 也就是 JS 字符串的常规下标。别按「字符数」理解它——emoji 占 2 个下标。
 */

/** 一条结果是从哪儿命中的 */
export type MatchSource = 'file_name' | 'tag' | 'segment'

export const MATCH_SOURCE_LABELS: Record<MatchSource, string> = {
  file_name: '文件名',
  tag: '标签',
  segment: '正文',
}

export interface SearchTerm {
  text: string
  length: number
  path: 'fts' | 'like'
}

export interface SearchWarning {
  code: 'SHORT_TERM_LIKE_FALLBACK' | 'NO_FTS_TERMS'
  message: string
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
  snippet: string
  /** 相对 snippet 的 UTF-16 偏移，可直接用于 slice */
  highlights: SnippetRange[]
  truncated: { head: boolean; tail: boolean }
  rank: number | null
}

export interface SearchHit {
  asset: AssetSummary
  matchedIn: MatchSource[]
  matchedNames: string[]
  matchedTags: string[]
  segments: SegmentHit[]
  segmentHitCount: number
  tier: number
  matchedTerms: string[]
}

export interface SearchResult {
  items: SearchHit[]
  /** 去重后的素材总数（可能大于 items.length） */
  total: number
  terms: SearchTerm[]
  warnings: SearchWarning[]
}

export interface SearchQuery {
  q: string
  kind?: AssetSummary['kind'] | undefined
  status?: ExtractStatus | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export function search(query: SearchQuery): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query.q })
  if (query.kind) params.set('kind', query.kind)
  if (query.status) params.set('status', query.status)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))

  return apiGet<{ ok: true; value: SearchResult }>(`/api/search?${params.toString()}`).then(
    (payload) => payload.value,
  )
}

/**
 * 把命中区间合并成互不重叠的若干段。
 *
 * 后端是按**每个关键词**分别报命中区间的，用户搜「火锅 锅店」时
 * 两个区间会在同一段文字上重叠。直接按顺序切片会切出负长度的片段，
 * 渲染出重复或错位的文字。合并是渲染前的必要一步，不是优化。
 */
export function mergeRanges(ranges: SnippetRange[]): SnippetRange[] {
  if (ranges.length === 0) return []

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: SnippetRange[] = [{ ...(sorted[0] as SnippetRange) }]

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1] as SnippetRange
    if (range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }

  return merged
}

export interface SnippetPiece {
  text: string
  /** 这段是不是命中的关键词 */
  hit: boolean
}

/** 把 snippet 按合并后的高亮区间切成若干段，供界面逐段渲染。 */
export function splitSnippet(snippet: string, highlights: SnippetRange[]): SnippetPiece[] {
  const merged = mergeRanges(highlights)
  if (merged.length === 0) return [{ text: snippet, hit: false }]

  const pieces: SnippetPiece[] = []
  let cursor = 0

  for (const range of merged) {
    if (range.start > cursor) {
      pieces.push({ text: snippet.slice(cursor, range.start), hit: false })
    }
    pieces.push({ text: snippet.slice(range.start, range.end), hit: true })
    cursor = range.end
  }

  if (cursor < snippet.length) {
    pieces.push({ text: snippet.slice(cursor), hit: false })
  }

  return pieces.filter((piece) => piece.text !== '')
}

/** 把毫秒时间轴格式化成 mm:ss，供正文片段标注「这句话出现在视频的哪一秒」。 */
export function formatTimestamp(ms: number | null): string | null {
  if (ms === null) return null
  const total = Math.max(Math.round(ms / 1000), 0)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
