import { describe, expect, it } from 'vitest'

import { isPlainTextExtension, parsePlainText } from './plaintext.js'

/**
 * 纯文本解析的测试。
 *
 * 这个模块做的事看着简单——按行切开——但切开的方式直接决定**能搜到什么**。
 * 所以重点在几处会让词消失或让段落变得没法读的边界：
 * CRLF、缩进、空行、以及整份文件只有一行的情况。
 */

describe('纯文本扩展名判定', () => {
  it('认得常见的几种纯文本格式', () => {
    for (const ext of ['.txt', '.md', '.markdown', '.json', '.csv']) {
      expect(isPlainTextExtension(ext)).toBe(true)
    }
  })

  it('大小写不影响', () => {
    expect(isPlainTextExtension('.TXT')).toBe(true)
  })

  it('字幕与音视频不会被误判成纯文本', () => {
    // 字幕有自己的解析器（要取时间轴），走错这条会把时间码当成正文。
    for (const ext of ['.srt', '.ass', '.vtt', '.ssa', '.mp4', '.jpg']) {
      expect(isPlainTextExtension(ext)).toBe(false)
    }
  })
})

describe('纯文本解析', () => {
  it('一行一个段落', () => {
    expect(parsePlainText('第一句\n第二句\n第三句').map((s) => s.text)).toEqual([
      '第一句',
      '第二句',
      '第三句',
    ])
  })

  it('没有时间轴，时间一律是 null', () => {
    // null 而不是 0：0 会被界面显示成 00:00，让人以为这行字出现在开头，
    // 而纯文本文件里根本没有「哪儿」这回事。
    expect(parsePlainText('随便一行')[0]).toEqual({ text: '随便一行', startMs: null, endMs: null })
  })

  it('丢空行，也丢行首行尾的空白', () => {
    // 空行是排版。收进索引只会多出一堆搜不出东西的空段落，
    // 还会把「命中 40 段」里的 40 撑得虚高。
    const text = '第一句\r\n\r\n   \r\n\t第二句  \r\n'
    expect(parsePlainText(text).map((s) => s.text)).toEqual(['第一句', '第二句'])
  })

  it('CRLF 与 LF 混用也能切开', () => {
    // Windows 上导出的 .txt 常见 CRLF。不处理的话行尾会留一个 \r，
    // 段落看起来没问题，但按行匹配时就多了一个看不见的字符。
    expect(parsePlainText('甲\r\n乙\n丙\r丁').map((s) => s.text)).toEqual(['甲', '乙', '丙', '丁'])
  })

  it('空文件解析成空数组而不是抛错', () => {
    expect(parsePlainText('')).toEqual([])
    expect(parsePlainText('\n\n\n')).toEqual([])
  })

  it('超长的一行会在空白处断开，不把词劈开', () => {
    // 压成一行的 JSON、被编辑器「合并为一行」的导出文件都会走到这里。
    // 不切的话会写出一个几十万字的段落：索引要为它建 trigram，
    // 检索结果里也会摊开一整篇。
    const line = 'lorem ipsum dolor '.repeat(300).trim() // 约 5400 字，超过 2000 的上限
    const segments = parsePlainText(line)

    expect(segments.length).toBeGreaterThan(1)
    const words = new Set(['lorem', 'ipsum', 'dolor'])
    for (const segment of segments) {
      expect(segment.text.length).toBeLessThanOrEqual(2000)
      // 断在空格上，所以每段拆开都只该是完整的词——
      // 出现 'dol' 这种被劈掉一半的，那个词就再也搜不到了
      for (const word of segment.text.split(' ')) expect(words.has(word)).toBe(true)
    }
    // 断开归断开，一个字都不能丢
    expect(segments.map((s) => s.text).join(' ')).toBe(line)
  })

  it('超长且没有空白时硬切，但一个字都不丢', () => {
    // 中文连续文本没有空格可断——这是会切断词的，但没有更好的办法：
    // 不让它断，就得让整个文件变成一个段落。既然要断，至少要保证不丢字。
    const line = '探'.repeat(5000)
    const segments = parsePlainText(line)

    expect(segments.length).toBeGreaterThan(1)
    expect(segments.map((s) => s.text).join('')).toBe(line)
  })

  it('恰好等于上限的行不会被切开', () => {
    // 边界：切分条件是「超过」，不是「达到」。差一位就多出一个段落，
    // 而这种错在真实文件里几乎不会显形，只会偶尔多出一条重复的结果。
    const line = 'a'.repeat(2000)
    expect(parsePlainText(line)).toHaveLength(1)
  })

  it('JSON 的语法符号会留在文本里 —— 这是按纯文本读的必然结果', () => {
    // 不是解析错误，也不打算修：真要结构化解析 JSON（比如带时间轴的
    // Whisper 输出），得先确定认哪几种方言，那是另一件事。
    // 这条测试把这个已知行为钉住，免得日后有人把它当成 bug 顺手「修」掉。
    expect(parsePlainText('{\n  "text": "今天我们来探店"\n}').map((s) => s.text)).toEqual([
      '{',
      '"text": "今天我们来探店"',
      '}',
    ])
  })
})
