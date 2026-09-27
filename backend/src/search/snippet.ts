import type { SegmentHit, SnippetRange } from './types.js'

/**
 * 命中上下文片段。
 *
 * 为什么在应用层用字符级重算，而不是让 FTS5 生成 snippet()：
 *
 *  1. FTS5 的 `snippet()` 对 trigram 分词器给出的边界是**三元组**对齐的，
 *     截出来的片段常从半个词中间开始，中文看起来尤其别扭。
 *  2. 两字关键词走的是 LIKE 兜底，根本不经过 FTS，
 *     没有 snippet() 可用——两条召回路径得有一致的展示形态。
 *  3. 高亮交给前端做需要「命中区间」。FTS5 返回的是带标记的字符串，
 *     还得反向解析标记才能拿到区间，不如自己算一次利落。
 *
 * 全程在**码点数组**里运算，不在 UTF-16 下标里。用错下标空间会让
 * emoji 与部分汉字（代理对）上的区间错位，高亮就画歪了。
 */

/** 命中位置之前保留多少字符作为上下文 */
const CONTEXT_BEFORE = 24

/** 片段总长度上限（码点） */
const MAX_SNIPPET_LENGTH = 96

/** 命中位置之前至少要露出几个字，否则把窗口往前挪 */
const MIN_LEADING_CONTEXT = 6

function toCodePoints(text: string): string[] {
  return [...text]
}

/** 大小写不敏感的单次查找，返回起始下标或 -1。两者都在码点空间。 */
function indexOfFrom(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) return -1
  const limit = haystack.length - needle.length

  for (let i = Math.max(from, 0); i <= limit; i += 1) {
    let matched = true
    for (let j = 0; j < needle.length; j += 1) {
      // 转小写后再比：英文关键词大小写不敏感，
      // 中文不受影响（没有大小写概念）
      if (haystack[i + j]?.toLowerCase() !== needle[j]?.toLowerCase()) {
        matched = false
        break
      }
    }
    if (matched) return i
  }
  return -1
}

interface RawMatch {
  start: number
  end: number
}

/** 找出所有词在文本里的全部出现位置，按起点排序并合并重叠区间。 */
function findAllMatches(chars: string[], terms: string[]): RawMatch[] {
  const found: RawMatch[] = []

  for (const term of terms) {
    const needle = toCodePoints(term)
    let from = 0
    for (;;) {
      const at = indexOfFrom(chars, needle, from)
      if (at < 0) break
      found.push({ start: at, end: at + needle.length })
      // 从下一个字符继续，允许重叠匹配（「aa」在「aaa」里出现两次）
      from = at + 1
    }
  }

  found.sort((a, b) => a.start - b.start || a.end - b.end)

  // 合并重叠区间，否则前端拿到两个交叠的高亮会画出双重背景
  const merged: RawMatch[] = []
  for (const match of found) {
    const last = merged[merged.length - 1]
    if (last && match.start <= last.end) {
      last.end = Math.max(last.end, match.end)
      continue
    }
    merged.push({ ...match })
  }
  return merged
}

export interface SnippetResult {
  snippet: string
  highlights: SnippetRange[]
  truncated: { head: boolean; tail: boolean }
  /** 命中了哪几个词（用于「命中了哪些词」的展示） */
  matchedTerms: string[]
}

/**
 * 围绕第一个命中位置截取片段。
 *
 * 窗口起点会往前挪，保证命中词前面露出一点内容——直接从命中词开头
 * 截断的话，用户看到的是「火锅店，老板说…」，读不出上下文。
 */
export function buildSnippet(text: string, terms: string[]): SnippetResult {
  const chars = toCodePoints(text)
  const matches = findAllMatches(chars, terms)

  if (matches.length === 0) {
    // 调用方保证只在命中时才调用，走到这里说明匹配逻辑与召回逻辑不一致。
    // 不抛异常：宁可退化成「无高亮的开头片段」，也不能让整个检索请求失败。
    const head = chars.slice(0, MAX_SNIPPET_LENGTH).join('')
    return {
      snippet: head,
      highlights: [],
      truncated: { head: false, tail: chars.length > MAX_SNIPPET_LENGTH },
      matchedTerms: [],
    }
  }

  const first = matches[0] as RawMatch

  let start = Math.max(0, first.start - CONTEXT_BEFORE)
  // 命中词太靠前时，把窗口往后挪一点，保证前面有几个字
  if (first.start - start < MIN_LEADING_CONTEXT) {
    start = Math.max(0, first.start - MIN_LEADING_CONTEXT)
  }

  let end = Math.min(chars.length, start + MAX_SNIPPET_LENGTH)
  // 窗口装不下第一个命中词时，至少把它整个包含进来
  if (end < first.end) end = Math.min(chars.length, first.end)

  // 区间一律换算成 **UTF-16 下标**再交出去。
  //
  // 内部运算用的是码点下标（否则 emoji 会让高亮错位），但消费方拿到的是
  // 一个 JS 字符串，它唯一的自然索引方式就是 UTF-16。两者不是一回事：
  // '🎬🎬🎬探店火锅店' 里「火锅店」的码点起点是 5，UTF-16 起点是 8。
  // 交出去时若不换算，前端 `snippet.slice(start, end)` 会高亮到隔壁字符上。
  const highlights = matches
    .filter((match) => match.start >= start && match.end <= end)
    .map((match) => ({
      start: chars.slice(start, match.start).join('').length,
      end: chars.slice(start, match.end).join('').length,
    }))

  const matchedTerms = [
    ...new Set(
      matches
        .map((match) => chars.slice(match.start, match.end).join(''))
        .filter((hitText) =>
          terms.some((term) => term.toLowerCase() === hitText.toLowerCase()),
        ),
    ),
  ]

  return {
    snippet: chars.slice(start, end).join(''),
    highlights,
    truncated: { head: start > 0, tail: end < chars.length },
    matchedTerms,
  }
}

/** 数据库行 → SegmentHit。抽出来是为了让 recall 的三个查询共用同一段映射。 */
export function toSegmentHit(
  row: {
    id: number
    source: string
    ordinal: number
    text: string
    start_ms: number | null
    end_ms: number | null
    frame_ms: number | null
    rank: number | null
  },
  terms: string[],
): SegmentHit {
  const built = buildSnippet(row.text, terms)

  return {
    segmentId: row.id,
    source: row.source,
    ordinal: row.ordinal,
    startMs: row.start_ms,
    endMs: row.end_ms,
    frameMs: row.frame_ms,
    snippet: built.snippet,
    highlights: built.highlights,
    truncated: built.truncated,
    rank: row.rank,
  }
}
