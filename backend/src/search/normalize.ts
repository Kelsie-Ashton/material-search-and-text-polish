import { err, ok, type Result } from '../shared/result.js'
import type { SearchTerm, SearchWarning } from './types.js'

/**
 * 关键词归一与分发。
 *
 * 这是检索层最该先写、也最容易写错的一块：它的每一条规则都对应
 * 一个**静默失效**的坑（实测见 spikes/search-tokenizer/probe-fts-query.mjs）。
 * 搞错了不会报错，只会搜不到东西。
 *
 * ## 三条实测出来的硬规则
 *
 * 1. **trigram 对 <3 字符的查询返回 0 行，且不报错。**
 *    「美食」「配音」「剪辑」这类最常用的两字词一旦交给 FTS，
 *    用户什么都搜不到。所以必须**逐词**判断长度，≥3 字走 FTS，≤2 字走 LIKE。
 *
 * 2. **绝不能因为「有一个词够长」就把整个查询交给 FTS。**
 *    实测 `"剪辑师" AND "探店"` → 0 行（短词把整个查询废掉）；
 *    而 `"剪辑师" 探店`（隐式 AND）→ 1 行，短词被**静默丢弃**，
 *    返回的是「只按长词搜」的结果。后一种更危险——它看起来是对的。
 *
 * 3. **词必须先 trim 再拼进 MATCH 表达式。**
 *    实测 `" 火锅店 "`（引号内含空格）→ 0 行。用户在输入框里
 *    多打一个空格就搜不到，而这类输入极其常见。
 *
 * ## 为什么用显式 OR，而不是 AND
 *
 * 语义上选择「任一关键词命中即召回」，再按**命中词数**排序。
 * 理由是这份语料的性质：正文来自语音转写与 OCR，本身就带错字
 * （实测中文 OCR 准确率约 70–85%，转写同样会错）。用 AND 的话，
 * 用户搜「探店 火锅」而转写把「火锅」写成了「火鍋」，
 * 结果就是**一条都搜不到**——一个词写错，整次检索归零。
 * OR 让命中的部分仍然能浮上来，再由排序把「两个词都命中」的排到前面。
 *
 * 这也是为什么排序的第一顺位是命中词数而不是相关度：
 * 它承担了 AND 原本承担的「精确性」职责，但代价是渐进的（排后面）
 * 而不是全有全无的（搜不到）。
 *
 * 另一个原因：显式的 `OR`/`AND` 关键字能避免 FTS5 隐式连接符的坑——
 * 实测空格连接时，短词会被**静默丢弃**，返回的是「只按长词搜」的结果，
 * 看起来完全正常。写明 OR 至少让意图留在代码里。
 *
 * （短词不会进这个表达式——上面的逐词分流已经把 ≤2 字的词分派出去了。
 * 分流出错时，短词混进来会让整个表达式返回 0 行或丢弃短词，
 * index.test.ts 里有测试钉住这两种情况都不会发生。）
 */

/** 查询串长度上限（码点）。远超正常关键词，只是为了避免把整段文章粘进来。 */
const MAX_QUERY_LENGTH = 200

/**
 * 长度下限：达到它可以交给 FTS。
 * 这个 3 来自 trigram 的定义——少于 3 个字符构不成一个三元组。
 */
const FTS_MIN_LENGTH = 3

/** 按码点算长度。用 `[...s].length` 而不是 `s.length`，否则 emoji 与部分汉字会被算成 2。 */
function codePointLength(text: string): number {
  return [...text].length
}

/**
 * 切词。
 *
 * 按空白切分，空白包含全角空格（U+3000）——中文输入法下打出全角空格
 * 是常事，只切 ASCII 空格会让「探店　火锅」变成一个词，什么都搜不到。
 * 同时去掉零宽字符：从网页复制关键词时经常带进来。
 */
const SEPARATORS = /[\s　​‌‍﻿]+/

export function splitTerms(raw: string): string[] {
  return raw
    .split(SEPARATORS)
    .map((term) => term.trim())
    .filter((term) => term !== '')
}

/**
 * 归一化整个查询串。
 *
 * 去重按**大小写不敏感**：用户搜「MP4 mp4」时不该当成两个词——
 * 那会让「命中词数」这个排序依据失真。
 */
export function normalizeQuery(raw: string): Result<{ terms: SearchTerm[] }> {
  const trimmed = raw.trim()

  if (trimmed === '') {
    return err('SEARCH_QUERY_EMPTY', '请输入关键词')
  }

  if (codePointLength(trimmed) > MAX_QUERY_LENGTH) {
    return err('SEARCH_QUERY_TOO_LONG', `关键词过长，请控制在 ${MAX_QUERY_LENGTH} 字以内`, {
      length: codePointLength(trimmed),
      max: MAX_QUERY_LENGTH,
    })
  }

  const seen = new Set<string>()
  const terms: SearchTerm[] = []

  for (const text of splitTerms(trimmed)) {
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const length = codePointLength(text)
    terms.push({ text, length, path: length >= FTS_MIN_LENGTH ? 'fts' : 'like' })
  }

  // 理论上不可能：trim 过且非空，splitTerms 至少产出一个词。
  // 留个兜底是因为「空词表」会让下游生成 `MATCH ''` 这种非法表达式。
  if (terms.length === 0) {
    return err('SEARCH_QUERY_EMPTY', '请输入关键词')
  }

  return ok({ terms })
}

/**
 * 拼 FTS 的 MATCH 表达式。
 *
 * 每个词用双引号包裹，词内的 `"` 翻倍。实测这样可以完全中和
 * `-` `*` `:` `(` `)` `NEAR` `AND` 等所有操作符：
 * 裸的 `美食-视频` 抛 `no such column: 视频`，裸的 `美食"视频` 抛
 * `unterminated string`；加了引号之后都变成正常的 0 行。
 *
 * 没有 FTS 词时返回 null——调用方必须据此**跳过整条 FTS 查询**，
 * 而不是传一个空表达式进去（`MATCH ''` 是语法错误）。
 */
export function toFtsMatchExpression(terms: SearchTerm[]): string | null {
  const ftsTerms = terms.filter((term) => term.path === 'fts')
  if (ftsTerms.length === 0) return null

  return ftsTerms.map((term) => `"${term.text.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * 转义 LIKE 的通配符。
 *
 * 不转义的话，用户搜「100%」会变成「100 + 任意字符」，
 * 把「1000纯棉」也一起返回。反斜杠必须**先**转义，
 * 否则后面加进去的转义反斜杠会被二次转义。
 */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\]/g, '\\\\').replace(/[%_]/g, (m) => `\\${m}`)
}

export function likeTermsOf(terms: SearchTerm[]): string[] {
  return terms.filter((term) => term.path === 'like').map((term) => term.text)
}

export function ftsTermsOf(terms: SearchTerm[]): string[] {
  return terms.filter((term) => term.path === 'fts').map((term) => term.text)
}

/**
 * 生成给用户看的警告。
 *
 * 这不是可有可无的装饰：两字关键词走的是全表 LIKE 兜底，
 * 与三字以上的精确索引路径在**结果形态**上确实不同
 * （LIKE 只能做子串包含，没有相关度、没有分词语义）。
 * 界面应当如实说明，而不是让用户以为两者是一回事。
 */
export function warningsFor(terms: SearchTerm[]): SearchWarning[] {
  const warnings: SearchWarning[] = []
  const short = likeTermsOf(terms)

  if (short.length > 0) {
    warnings.push({
      code: 'SHORT_TERM_LIKE_FALLBACK',
      message: `${short.join('、')} 不足 3 个字，已改用全库扫描匹配（中文分词索引无法处理 3 字以下的词）`,
      terms: short,
    })
  }

  if (ftsTermsOf(terms).length === 0) {
    warnings.push({
      code: 'NO_FTS_TERMS',
      message: '关键词都不足 3 个字，本次未使用正文分词索引，结果可能不如长关键词精确',
      terms: short,
    })
  }

  return warnings
}
