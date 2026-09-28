import type { Db } from '../db/index.js'
import { findAsset, type TagRef } from '../library/assets.js'
import { err, ok, type Result } from '../shared/result.js'
import { extractKeywordCandidates, type KeywordCandidate } from './keywords.js'
import { linkTag, listAssetTags, normalizeTagName } from './service.js'

/**
 * 把提取出的文字归档为标签（任务 6.10）。
 *
 * ## 这条路径解决的到底是什么问题
 *
 * 正文命中是**隐式**的：它依赖「这个素材提取过文字」，而且是一堆散落在
 * 时间轴上的片段。标签是**显式**的：它写在素材上，一眼看得见，而且
 * 重新提取、换字形、删掉重来都不会把它弄丢。
 *
 * 归档做的就是这件事——把「这段素材里提过火锅店」这个**推论**，
 * 变成「这条素材就是火锅店」这个**事实**。
 *
 * ## 为什么候选要现场算，而不是存下来
 *
 * 算一次几毫秒，而存下来就要处理「正文变了候选还算不算数」这一整类问题。
 * 候选只是**建议**，本来也不需要稳定。
 */

/** 一次归档的结果。三个桶分开报，界面才好逐条说清楚。 */
export interface ArchiveSummary {
  /** 这次真的挂上的 */
  linked: TagRef[]
  /** 本来就已经挂着的——不是错误，但也不该说「已归档」 */
  alreadyLinked: TagRef[]
  /** 名字不合法的（空、超长）。丢掉它们比整批失败好 */
  invalid: string[]
}

/**
 * 从素材已提取的正文里挑候选关键词。
 *
 * **会把已经打过的标签剔掉**：候选列表里出现一个素材上已经挂着的标签，
 * 用户勾了、点了归档、什么也没发生——看起来就像功能坏了。
 * 过滤放在这里而不是界面里，是因为界面那份过滤迟早会与标签列表不同步。
 */
export function suggestKeywords(db: Db, assetId: number, limit?: number): Result<KeywordCandidate[]> {
  if (!findAsset(db, assetId)) {
    return err('ASSET_NOT_FOUND', `素材不存在（id=${assetId}）`, { id: assetId })
  }

  const rows = db
    .prepare('SELECT text FROM asset_text_segments WHERE asset_id = ? ORDER BY ordinal ASC')
    .all(assetId) as Array<{ text: string }>

  // 没有正文不是错误，是「还没提取过」——返回空列表，界面据此说清楚原因。
  // 报错的话，一个刚扫进来还没提取的素材点开详情就会看到一个红条。
  const text = rows.map((row) => row.text).join('\n')
  if (text === '') return ok([])

  const existing = new Set(listAssetTags(db, assetId).map((tag) => tag.name))
  const candidates = extractKeywordCandidates(text, limit).filter(
    (candidate) => !existing.has(candidate.word),
  )

  return ok(candidates)
}

/**
 * 把一批关键词归档成这个素材的标签。
 *
 * 名字不合法（空、超长）的**跳过而不是整批失败**：用户勾了六个候选，
 * 因为其中一个恰好撞上长度上限就全军覆没，是让人很难理解的失败方式。
 * 跳过的那几个会在 `invalid` 里报出来。
 *
 * 同一批里的重复项也去重——勾选框理论上不会给出重复，但这个函数是公开的，
 * 不该指望调用方替它保证。
 */
export function archiveKeywords(
  db: Db,
  assetId: number,
  keywords: readonly string[],
): Result<ArchiveSummary> {
  if (!findAsset(db, assetId)) {
    return err('ASSET_NOT_FOUND', `素材不存在（id=${assetId}）`, { id: assetId })
  }

  const summary: ArchiveSummary = { linked: [], alreadyLinked: [], invalid: [] }
  const seen = new Set<string>()

  for (const raw of keywords) {
    const name = normalizeTagName(raw)
    if (!name.ok) {
      summary.invalid.push(raw)
      continue
    }
    // 同一批里重复出现的，只处理第一次
    if (seen.has(name.value)) continue
    seen.add(name.value)

    // source 用 'extracted'：这条标签是从正文里提出来的，不是用户手打的。
    // 分开记下来，用户日后想清理「当初自动建议带出来的标签」时才有依据。
    const result = linkTag(db, assetId, name.value, { source: 'extracted' })
    if (!result.ok) {
      summary.invalid.push(raw)
      continue
    }

    if (result.value.alreadyLinked) summary.alreadyLinked.push(result.value.tag)
    else summary.linked.push(result.value.tag)
  }

  return ok(summary)
}
