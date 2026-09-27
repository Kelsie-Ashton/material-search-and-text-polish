import type { MatchSource, SegmentHit } from './types.js'

/**
 * 合并去重与分档排序。
 *
 * ## 分档，而不是给一个总分
 *
 * 三条召回路径的分数**本来就不可比**：bm25 是负的小数（越小越相关），
 * LIKE 压根没有分数，标签匹配的「强度」也没有数值含义。硬凑成一个加权总分，
 * 权重要靠猜，而且用户永远无法解释「为什么这条排在那条前面」。
 *
 * 分档则完全可解释，且每条结果都能对用户说清理由：
 *   第 0 档「文件名或标签正好就是这个词」——最精确，用户找的大概率就是这个
 *   第 1 档「文件名或标签里含这个词」
 *   第 2 档「只有正文里出现过」
 *
 * 同档之内再按「命中词数 → 相关度 → 名称」排序。
 */

/** 档次越小越靠前 */
export const TIER_EXACT_NAME = 0
export const TIER_PARTIAL_NAME = 1
export const TIER_BODY_ONLY = 2

export interface RankInput {
  assetId: number
  /** 命中的文件名 */
  names: string[]
  /** 命中的标签名 */
  tags: string[]
  /** 正文命中片段（已含高亮） */
  segments: SegmentHit[]
  /** 正文命中的总段数，可能大于 segments.length */
  segmentCount: number
  /** FTS 的最小 bm25；纯 LIKE 命中时为 undefined */
  bestRank: number | undefined
  /** 所有命中的关键词 */
  terms: Set<string>
  /** 命中的来源 */
  sources: Set<MatchSource>
}

export interface RankedHit extends RankInput {
  tier: number
  /** 命中的关键词数量，同档内多者靠前 */
  matchedTermCount: number
}

/**
 * 判定档次。
 *
 * 只看名称与标签：正文命中再准也不算「精确匹配」——
 * 正文里出现某个词，远不如「文件名就叫这个」来得确定。
 */
function tierOf(input: RankInput, terms: Set<string>): number {
  const lowered = [...terms].map((term) => term.toLowerCase())
  const texts = [...input.names, ...input.tags]

  // 第 0 档：文件名或标签**正好等于**某个关键词
  if (texts.some((text) => lowered.includes(text.toLowerCase()))) return TIER_EXACT_NAME

  // 第 1 档：文件名或标签里含有某个关键词（召回时已保证包含，故非空即命中）
  if (texts.length > 0) return TIER_PARTIAL_NAME

  return TIER_BODY_ONLY
}

export function rankHits(inputs: RankInput[]): RankedHit[] {
  const ranked = inputs.map((input) => ({
    ...input,
    tier: tierOf(input, input.terms),
    matchedTermCount: input.terms.size,
  }))

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier

    // 命中的词更多，说明更贴近用户的整体意图
    if (a.matchedTermCount !== b.matchedTermCount) {
      return b.matchedTermCount - a.matchedTermCount
    }

    // bm25 是负数，越小越相关。有 rank 的排在没 rank 的前面——
    // 没 rank 意味着它只被 LIKE 兜底捞到，相关度无从谈起。
    const rankA = a.bestRank
    const rankB = b.bestRank
    if (rankA !== undefined && rankB !== undefined && rankA !== rankB) return rankA - rankB
    if (rankA !== undefined && rankB === undefined) return -1
    if (rankA === undefined && rankB !== undefined) return 1

    // 最后用 id 兜底，保证同一批数据每次排序结果一致。
    // 少了这一步，分页时同档次的结果顺序会抖动，用户翻页会看到重复或漏项。
    return a.assetId - b.assetId
  })

  return ranked
}

/** 来源按固定顺序输出，界面上的「命中：文件名、标签」才不会时而这样时而那样。 */
const SOURCE_ORDER: MatchSource[] = ['file_name', 'tag', 'segment']

export function sortedSources(sources: Set<MatchSource>): MatchSource[] {
  return SOURCE_ORDER.filter((source) => sources.has(source))
}
