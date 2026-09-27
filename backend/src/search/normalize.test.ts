import { describe, expect, it } from 'vitest'

import {
  escapeLikePattern,
  normalizeQuery,
  splitTerms,
  toFtsMatchExpression,
  warningsFor,
} from './normalize.js'

/**
 * 这些测试针对的都是**静默失效**——写错了不报错，只是搜不到东西。
 * 所以每条断言都对应一个实测出来的行为，不是想当然。
 */

function termsOf(raw: string) {
  const result = normalizeQuery(raw)
  if (!result.ok) throw new Error(`预期能归一，却失败了：${result.error.message}`)
  return result.value.terms
}

describe('切词', () => {
  it('按空白切分', () => {
    expect(splitTerms('探店 视频')).toEqual(['探店', '视频'])
  })

  it('全角空格也要切', () => {
    // 中文输入法下打出全角空格是常事。只切 ASCII 空格的话
    // 「探店　火锅」会变成一个词，什么都搜不到。
    expect(splitTerms('探店　火锅')).toEqual(['探店', '火锅'])
  })

  it('去掉零宽字符', () => {
    // 从网页复制关键词时经常带进来，肉眼看不见但会让匹配失败
    expect(splitTerms('探店​视频')).toEqual(['探店', '视频'])
  })

  it('连续空白不产生空词', () => {
    expect(splitTerms('  探店   视频  ')).toEqual(['探店', '视频'])
  })
})

describe('查询归一', () => {
  it('空输入被拒绝', () => {
    const result = normalizeQuery('   ')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SEARCH_QUERY_EMPTY')
  })

  it('超长输入被拒绝', () => {
    const result = normalizeQuery('啊'.repeat(201))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SEARCH_QUERY_TOO_LONG')
  })

  it('刚好到上限的输入被接受', () => {
    expect(normalizeQuery('啊'.repeat(200)).ok).toBe(true)
  })

  it('重复词按大小写不敏感去重', () => {
    // 不去重会让「命中词数」这个排序依据失真
    expect(termsOf('MP4 mp4 Mp4').map((t) => t.text)).toEqual(['MP4'])
  })

  it('emoji 按码点算长度，不按 UTF-16 单元', () => {
    // '👍' 的 .length 是 2，但它是 1 个字符。
    // 用错算法会让一个 emoji 就被当成「够长了」，交给 FTS 然后搜不到。
    const terms = termsOf('👍')
    expect(terms[0]?.length).toBe(1)
    expect(terms[0]?.path).toBe('like')
  })
})

describe('逐词分流', () => {
  it('3 字及以上走 FTS', () => {
    expect(termsOf('火锅店').map((t) => t.path)).toEqual(['fts'])
  })

  it('2 字及以下走 LIKE', () => {
    // trigram 对 <3 字符返回 0 行且不报错——这是本设计里最关键的一条
    expect(termsOf('探店 美食 剪辑').map((t) => t.path)).toEqual(['like', 'like', 'like'])
  })

  it('长短词混在一起时各自分流，而不是整串交给 FTS', () => {
    const terms = termsOf('剪辑师 探店')

    // 绝不能因为「剪辑师够长」就把整串交给 FTS：
    // 实测 `"剪辑师" AND "探店"` → 0 行，短词会把整个查询废掉
    expect(terms).toEqual([
      { text: '剪辑师', length: 3, path: 'fts' },
      { text: '探店', length: 2, path: 'like' },
    ])
  })

  it('刚好 3 个字符的词走 FTS', () => {
    expect(termsOf('abc')[0]?.path).toBe('fts')
    expect(termsOf('ab')[0]?.path).toBe('like')
  })
})

describe('FTS 表达式构造', () => {
  it('每个词用双引号包裹并 OR 连接', () => {
    // 用 OR 而非 AND：正文来自转写与 OCR，本身就带错字。
    // AND 之下一个词转写错了就整次检索归零；OR 让命中的部分仍能浮上来，
    // 精确性交给排序里的「命中词数」承担。
    expect(toFtsMatchExpression(termsOf('火锅店 剪辑师'))).toBe('"火锅店" OR "剪辑师"')
  })

  it('没有 FTS 词时返回 null，而不是空串', () => {
    // 空串会让 MATCH '' 变成语法错误——调用方必须据此跳过整条查询
    expect(toFtsMatchExpression(termsOf('探店'))).toBeNull()
  })

  it('词内的双引号翻倍，中和掉字符串边界', () => {
    // 裸的 美食"视频 抛 unterminated string
    expect(toFtsMatchExpression(termsOf('美食"视频'))).toBe('"美食""视频"')
  })

  it('操作符被引号中和，不会变成查询语法', () => {
    // 裸的 美食-视频 抛 `no such column: 视频`。
    // 注意这里每个词都 ≥3 字符，否则会走 LIKE 而测不到 FTS 表达式。
    expect(toFtsMatchExpression(termsOf('美食-视频'))).toBe('"美食-视频"')
    expect(toFtsMatchExpression(termsOf('NEAR(探店 视频)'))).toBe('"NEAR(探店" OR "视频)"')
    expect(toFtsMatchExpression(termsOf('abc*'))).toBe('"abc*"')
  })

  it('词内不残留空格', () => {
    // 实测 `" 火锅店 "` → 0 行。用户在输入框多打一个空格就搜不到。
    expect(toFtsMatchExpression(termsOf('  火锅店  '))).toBe('"火锅店"')
  })
})

describe('LIKE 转义', () => {
  it('% 与 _ 被转义成字面量', () => {
    // 不转义时搜「100%」会变成「100 + 任意字符」，把「1000纯棉」一起返回
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
  })

  it('反斜杠先于通配符转义', () => {
    // 顺序反了的话，% 转义时加进去的反斜杠会被二次转义
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%')
  })

  it('普通文本原样返回', () => {
    expect(escapeLikePattern('探店')).toBe('探店')
  })
})

describe('降级提示', () => {
  it('有短词时给出全表扫描的提示', () => {
    const warnings = warningsFor(termsOf('探店 火锅店'))

    expect(warnings.map((w) => w.code)).toContain('SHORT_TERM_LIKE_FALLBACK')
    expect(warnings[0]?.terms).toEqual(['探店'])
  })

  it('全部是短词时额外说明未使用分词索引', () => {
    const warnings = warningsFor(termsOf('探店 美食'))

    expect(warnings.map((w) => w.code)).toEqual(['SHORT_TERM_LIKE_FALLBACK', 'NO_FTS_TERMS'])
  })

  it('全是长词时没有任何警告', () => {
    expect(warningsFor(termsOf('火锅店 剪辑师'))).toEqual([])
  })
})
