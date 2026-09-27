import { describe, expect, it } from 'vitest'

import { toSegments } from './asr.js'

/**
 * 转写输出解析的测试。
 *
 * 为什么单独测这一层：跑通它**不需要下载 238 MB 的模型**，而把模型输出
 * 解析错（时间轴错位、空段落混进结果）恰恰是这里最容易出的问题。
 * 模型本身的行为用一次性的人工验证去确认，不放进每次都要跑的测试套件——
 * 否则换台机器、没网、模型改版都会让测试红，而红的还不是我们的代码。
 *
 * 夹具照 Transformers.js 的 `return_timestamps: true` 真实返回结构写：
 * `{ text, chunks: [{ timestamp: [起, 止], text }] }`，时间单位是**秒**。
 *
 * **注意夹具保留繁体。** 这一层刻意不做繁简转换——往哪个方向转是用户偏好，
 * 由落库那一刻统一处理（persist.ts）。若哪天有人"顺手"在这里加回转换，
 * 下面的断言会红：它们断言的是**模型输出的原样**。
 */

describe('转写输出解析', () => {
  it('取出每段文字与起止时间（秒转毫秒）', () => {
    const segments = toSegments({
      text: '今天我們來探店',
      chunks: [
        { timestamp: [0, 2.5], text: ' 今天我們來探店' },
        { timestamp: [2.5, 6], text: ' 這家火鍋店' },
      ],
    })

    expect(segments).toEqual([
      { text: '今天我們來探店', startMs: 0, endMs: 2500 },
      { text: '這家火鍋店', startMs: 2500, endMs: 6000 },
    ])
  })

  it('原样保留模型输出的字形，不擅自转换', () => {
    // 这一层不认识「用户偏好」，任何方向的转换在这里都是错的：
    // 用户选繁体时，这里先转简、落库再转繁，是一次多余的往返，
    // 而简↔繁并非逐字可逆，还可能改坏原文。
    const segments = toSegments({
      chunks: [{ timestamp: [0, 1], text: '鴨腸和消費' }],
    })

    expect(segments[0]?.text).toBe('鴨腸和消費')
  })

  it('时间戳缺失时保留段落、时间为空', () => {
    // `timestamp` 可能是 [null, null]。**不能因此丢掉文字**——
    // 文字才是用户要的东西，时间只是附加。
    const segments = toSegments({ chunks: [{ timestamp: [null, null], text: '  有字无时间  ' }] })

    expect(segments).toEqual([{ text: '有字无时间', startMs: null, endMs: null }])
  })

  it('时间戳字段整个缺失也不崩', () => {
    const segments = toSegments({ chunks: [{ text: '没有 timestamp 字段' }] })

    expect(segments).toEqual([{ text: '没有 timestamp 字段', startMs: null, endMs: null }])
  })

  it('丢弃空白段落', () => {
    // 模型在静音处经常吐出空串或纯空格。留着会让界面出现一排空行，
    // 检索片段也可能命中一个没有内容的段落。
    const segments = toSegments({
      chunks: [
        { timestamp: [0, 1], text: '   ' },
        { timestamp: [1, 2], text: '正式内容' },
        { timestamp: [2, 3], text: '' },
      ],
    })

    expect(segments).toEqual([{ text: '正式内容', startMs: 1000, endMs: 2000 }])
  })

  it('没有 chunks 时退回整段文本', () => {
    // 短音频（不到一个窗口）时可能只给 text 不给 chunks。
    // 这时不能返回空数组——那等于把用户的内容丢掉了。
    const segments = toSegments({ text: '  短音頻的整段文字  ' })

    expect(segments).toEqual([{ text: '短音頻的整段文字', startMs: null, endMs: null }])
  })

  it('空输出得到空数组而不是一个空段落', () => {
    expect(toSegments({ text: '' })).toEqual([])
    expect(toSegments({ text: '   ' })).toEqual([])
    expect(toSegments({ chunks: [] })).toEqual([])
  })

  it('结构完全不对时不抛异常', () => {
    // 上游换了返回结构时，宁可得到空结果，也不要让整个提取任务崩掉——
    // 崩掉会连已经转写好的其他来源一起丢掉。
    for (const garbage of [null, undefined, '不是对象', 42, { chunks: '不是数组' }]) {
      expect(() => toSegments(garbage)).not.toThrow()
    }
    expect(toSegments(null)).toEqual([])
  })
})
