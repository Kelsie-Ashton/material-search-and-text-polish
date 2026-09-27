import { describe, expect, it } from 'vitest'

import { buildSnippet } from './snippet.js'

/** 把片段按高亮区间切成 [前, 高亮, 后] 便于断言，避免手数下标。 */
function highlightedParts(text: string, terms: string[]): string[] {
  const { snippet, highlights } = buildSnippet(text, terms)
  return highlights.map((h) => snippet.slice(h.start, h.end))
}

describe('命中上下文片段', () => {
  it('命中在片段中间时，前面留有上下文', () => {
    const text = '今天我们来探店这家火锅店，老板说他们家的麻辣锅底是祖传配方'
    const { snippet, highlights, truncated } = buildSnippet(text, ['火锅店'])

    // 直接从命中词开头截断的话，用户看到「火锅店，老板说…」读不出上下文
    expect(snippet).toContain('火锅店')
    expect(highlights).toHaveLength(1)
    expect(truncated).toEqual({ head: false, tail: false })
  })

  it('高亮区间精确套住命中词', () => {
    expect(highlightedParts('今天我们来探店这家火锅店，老板说', ['火锅店'])).toEqual(['火锅店'])
  })

  it('同一段里多个命中词都被高亮', () => {
    const text = '探店这家火锅店，火锅店的麻辣锅底很好'
    expect(highlightedParts(text, ['火锅店', '探店'])).toEqual(['探店', '火锅店', '火锅店'])
  })

  it('长文本从中间截断，并标明截断方向', () => {
    const text = '前'.repeat(200) + '火锅店' + '后'.repeat(200)
    const { snippet, truncated } = buildSnippet(text, ['火锅店'])

    expect(snippet.length).toBeLessThanOrEqual(96)
    expect(snippet).toContain('火锅店')
    // 界面上要显示省略号，所以必须知道是哪边被截了
    expect(truncated).toEqual({ head: true, tail: true })
  })

  it('命中在开头时不标记 head 截断', () => {
    const text = '火锅店' + '后'.repeat(200)
    const { truncated } = buildSnippet(text, ['火锅店'])

    expect(truncated.head).toBe(false)
    expect(truncated.tail).toBe(true)
  })

  it('命中在结尾时不标记 tail 截断', () => {
    const text = '前'.repeat(200) + '火锅店'
    const { truncated } = buildSnippet(text, ['火锅店'])

    expect(truncated.head).toBe(true)
    expect(truncated.tail).toBe(false)
  })

  it('短文本整段返回，不截断', () => {
    const text = '探店火锅店'
    const { snippet, truncated } = buildSnippet(text, ['火锅店'])

    expect(snippet).toBe(text)
    expect(truncated).toEqual({ head: false, tail: false })
  })

  it('英文关键词大小写不敏感', () => {
    expect(highlightedParts('素材文件名 Demo.MP4 结尾', ['mp4'])).toEqual(['MP4'])
  })

  it('重叠命中被合并，避免画出双重高亮', () => {
    // 「aa」在「aaa」里匹配两次，区间重叠。
    // 不合并的话前端会拿到两个交叠区间，高亮叠成一层深色
    const { highlights } = buildSnippet('aaa', ['aa'])

    expect(highlights).toEqual([{ start: 0, end: 3 }])
  })

  it('emoji 与代理对上的下标不错位', () => {
    // 用 UTF-16 下标算的话，一个 emoji 占 2 个下标，后面的高亮全歪
    const text = '🎬🎬🎬探店火锅店很好吃'
    const parts = highlightedParts(text, ['火锅店'])

    expect(parts).toEqual(['火锅店'])
  })

  it('一个词都没命中时退化为开头片段，而不是抛异常', () => {
    // 这是「匹配逻辑与召回逻辑不一致」的信号，但不该让整个检索请求失败
    const text = '完全不相干的内容'.repeat(20)
    const { snippet, highlights, truncated } = buildSnippet(text, ['火锅店'])

    expect(highlights).toEqual([])
    expect(snippet.length).toBeLessThanOrEqual(96)
    expect(truncated.tail).toBe(true)
  })

  it('命中词在窗口边缘时也完整包含', () => {
    // 窗口起点算完之后可能把命中词切掉一半，必须往外扩
    const text = '字'.repeat(30) + '火锅店' + '字'.repeat(200)
    const parts = highlightedParts(text, ['火锅店'])

    expect(parts).toEqual(['火锅店'])
  })
})
