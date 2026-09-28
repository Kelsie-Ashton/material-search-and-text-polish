import { describe, expect, it } from 'vitest'

import { createModelProgressReporter, toSegments, type ModelDownloadProgress } from './asr.js'

/**
 * 转写输出解析的测试。
 *
 * 为什么单独测这一层：跑通它**不需要下载 241 MB 的模型**，而把模型输出
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

/**
 * 模型下载进度的测试（任务 5.11）。
 *
 * 测的是那个**聚合函数**，不是真实下载——正是因为这个函数是纯的，
 * 5.11 才有可回归的验证。真实下载的行为不放进测试套件：
 * 它要联网、要 241 MB、还会因为上游改版而变，红了也不是我们的代码错了。
 *
 * 夹具按 Transformers.js `progress_callback` 的真实载荷写：
 * `{ status, file, loaded, total }`，`status` 有 initiate / download / progress / done。
 */
describe('模型下载进度聚合', () => {
  /** 收集所有进度事件 */
  function collect(): { events: ModelDownloadProgress[]; report: (event: unknown) => void } {
    const events: ModelDownloadProgress[] = []
    return { events, report: createModelProgressReporter((p) => events.push(p)) }
  }

  it('单文件按字节算出百分比', () => {
    const { events, report } = collect()

    report({ status: 'initiate', file: 'model.onnx', total: 1000 })
    report({ status: 'progress', file: 'model.onnx', loaded: 250, total: 1000 })
    report({ status: 'progress', file: 'model.onnx', loaded: 500, total: 1000 })

    expect(events.map((e) => e.percent)).toEqual([null, 25, 50])
    expect(events.at(-1)).toMatchObject({ phase: 'downloading', loaded: 500, total: 1000 })
  })

  it('initiate 报的是「正在准备」，此时还没有百分比', () => {
    const { events, report } = collect()

    report({ status: 'initiate', file: 'model.onnx', total: 1000 })

    // 建连与 DNS 可能沉默好几秒，这一句让界面不至于停在上一句话上不动
    expect(events[0]).toMatchObject({ phase: 'preparing', percent: null, loaded: 0 })
  })

  it('切到第二个文件时百分比不倒退', () => {
    // 这是这个函数存在的主要理由。一个模型由多个文件组成，
    // 只看当前文件的话，权重下完切到 tokenizer 时会从 100% 掉回 0%——
    // **一个会倒退的进度条看起来就像坏了**，用户会以为白下了。
    const { events, report } = collect()

    report({ status: 'progress', file: 'weights.onnx', loaded: 900, total: 1000 })
    report({ status: 'progress', file: 'tokenizer.json', loaded: 10, total: 5000 })

    const percents = events.map((e) => e.percent)
    expect(percents).toEqual([90, 90])
  })

  it('总量未知时不给百分比，而不是硬编一个 0%', () => {
    const { events, report } = collect()

    report({ status: 'progress', file: 'model.onnx', loaded: 500 })

    // 界面据此显示不确定进度条。给 0% 会让用户以为一点都没下
    expect(events.at(-1)?.percent).toBeNull()
    expect(events.at(-1)?.total).toBe(0)
  })

  it('文件下完但没报 loaded 时，用已知总量补齐', () => {
    // 不补的话，最后一个文件永远停在 99%，任务看起来差一点点就永远完不成
    const { events, report } = collect()

    report({ status: 'progress', file: 'model.onnx', loaded: 900, total: 1000 })
    report({ status: 'done', file: 'model.onnx' })

    expect(events.at(-1)?.percent).toBe(100)
    expect(events.at(-1)?.loaded).toBe(1000)
  })

  it('百分比不会超过 100', () => {
    const { events, report } = collect()

    // 上游报的 loaded 偶尔会略微超过它自己宣告的 total
    report({ status: 'progress', file: 'model.onnx', loaded: 1200, total: 1000 })

    expect(events.at(-1)?.percent).toBe(100)
  })

  it('认不出来的事件被忽略，不抛也不乱走进度', () => {
    // 上游加一个新状态不该让这里报错——它跑在转写链路里，
    // 抛出去会连这次提取一起毁掉
    const { events, report } = collect()

    for (const garbage of [null, undefined, 42, '字符串', {}, { status: 123 }]) {
      expect(() => report(garbage)).not.toThrow()
    }
    // ready 之类的状态不认识就忽略，不该产生事件
    report({ status: 'ready' })

    expect(events).toEqual([])
  })
})
