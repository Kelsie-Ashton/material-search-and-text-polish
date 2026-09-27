import { describe, expect, it } from 'vitest'

import { decodeSubtitleText, isSubtitleExtension, parseSubtitle } from './subtitle.js'

/**
 * 字幕解析的测试。
 *
 * 重点不在「能解析一份标准文件」——那是这个模块最容易做对的部分。
 * 重点在**真实世界里的字幕**：对白里带逗号、带矢量绘图、编码是 GBK、
 * 列序不按标准来。这些情况解析错了**不会报错**，只会静默产出垃圾文本，
 * 而用户看到的是一份读不通的检索结果。
 */

describe('字幕扩展名判定', () => {
  it('认得四种字幕格式', () => {
    for (const ext of ['.srt', '.vtt', '.ass', '.ssa']) {
      expect(isSubtitleExtension(ext)).toBe(true)
    }
  })

  it('大小写不影响', () => {
    expect(isSubtitleExtension('.ASS')).toBe(true)
  })

  it('视频与图片不会被误判', () => {
    for (const ext of ['.mp4', '.jpg', '.txt', '.ass2']) {
      expect(isSubtitleExtension(ext)).toBe(false)
    }
  })
})

describe('SRT 解析', () => {
  it('取出文本与起止时间', () => {
    const cues = parseSubtitle(
      ['1', '00:00:01,000 --> 00:00:04,000', '今天我们来探店这家火锅店', ''].join('\n'),
      '.srt',
    )

    expect(cues).toEqual([
      { text: '今天我们来探店这家火锅店', startMs: 1000, endMs: 4000 },
    ])
  })

  it('两条之间漏了空行也能切开', () => {
    // 手工编辑过的字幕里很常见。若按「空行分块」解析，
    // 两条会被粘成一条，检索出来的片段就串行了。
    const cues = parseSubtitle(
      [
        '1',
        '00:00:01,000 --> 00:00:02,000',
        '第一句',
        '2',
        '00:00:03,000 --> 00:00:04,000',
        '第二句',
      ].join('\n'),
      '.srt',
    )

    expect(cues.map((c) => c.text)).toEqual(['第一句', '第二句'])
    expect(cues[1]?.startMs).toBe(3000)
  })

  it('漏了空行时，下一条的序号不会被算进上一条正文', () => {
    // 时间轴前的是序号行，没有空行分隔时它会落在上一条的正文里。
    // 不处理的话检索片段里会冒出一个莫名其妙的数字，用户完全无法解释。
    const cues = parseSubtitle(
      [
        '1',
        '00:00:01,000 --> 00:00:02,000',
        '第一句',
        '2',
        '00:00:03,000 --> 00:00:04,000',
        '第二句',
      ].join('\n'),
      '.srt',
    )

    expect(cues.map((c) => c.text)).toEqual(['第一句', '第二句'])
  })

  it('同一时间轴下的一行字幕折行被合并成一句', () => {
    const cues = parseSubtitle(
      ['1', '00:00:01,000 --> 00:00:02,000', '今天我们来', '探店这家火锅店', ''].join('\n'),
      '.srt',
    )

    // 折行是排版，不是语义分段——压成一行，检索片段才好读
    expect(cues).toEqual([{ text: '今天我们来 探店这家火锅店', startMs: 1000, endMs: 2000 }])
  })

  it('毫秒位少于三位时按左对齐补齐', () => {
    // `,5` 是 500ms 而不是 5ms。当成 5ms 会让时间轴整体错位。
    const cues = parseSubtitle(
      ['1', '00:00:01,5 --> 00:00:02,25', '短毫秒', ''].join('\n'),
      '.srt',
    )
    expect(cues[0]?.startMs).toBe(1500)
    expect(cues[0]?.endMs).toBe(2250)
  })

  it('容忍用点号当毫秒分隔符的 SRT', () => {
    const cues = parseSubtitle(
      ['1', '00:00:01.000 --> 00:00:04.000', '点号分隔', ''].join('\n'),
      '.srt',
    )
    expect(cues[0]?.startMs).toBe(1000)
  })

  it('去掉内联样式标签但保留文字', () => {
    const cues = parseSubtitle(
      ['1', '00:00:01,000 --> 00:00:02,000', '<i>斜体</i>与<font color="#fff">彩色</font>', ''].join(
        '\n',
      ),
      '.srt',
    )
    expect(cues[0]?.text).toBe('斜体与彩色')
  })

  it('空文件解析出空数组而不是抛错', () => {
    expect(parseSubtitle('', '.srt')).toEqual([])
  })

  it('完全没有时间轴的文件解析出空数组', () => {
    expect(parseSubtitle('这不是字幕\n只是一些普通文字', '.srt')).toEqual([])
  })
})

describe('VTT 解析', () => {
  it('跳过 WEBVTT 头、NOTE 块与 cue 标识行', () => {
    const cues = parseSubtitle(
      [
        'WEBVTT',
        '',
        'NOTE 这是一条注释',
        '注释的第二行',
        '',
        'cue-1',
        '00:00:01.000 --> 00:00:02.000',
        '真正的内容',
        '',
      ].join('\n'),
      '.vtt',
    )

    expect(cues).toEqual([{ text: '真正的内容', startMs: 1000, endMs: 2000 }])
  })

  it('剥离 <v 说话人> 标记并还原实体', () => {
    const cues = parseSubtitle(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:02.000',
        '<v 小明>火锅 &amp; 烧烤</v>',
        '',
      ].join('\n'),
      '.vtt',
    )

    expect(cues[0]?.text).toBe('火锅 & 烧烤')
  })
})

describe('ASS / SSA 解析', () => {
  const HEADER = [
    '[Script Info]',
    'Title: 测试',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Default,微软雅黑,48',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  function ass(...dialogueLines: string[]): string {
    return [...HEADER, ...dialogueLines].join('\n')
  }

  it('取出对白文本与起止时间', () => {
    const cues = parseSubtitle(
      ass('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,今天我们来探店'),
      '.ass',
    )

    // 厘秒：.50 → 500ms
    expect(cues).toEqual([{ text: '今天我们来探店', startMs: 1000, endMs: 4000 }])
  })

  it('对白里的半角逗号不会被切断', () => {
    // 最要命的一条：把整行按逗号切完再取最后一段，
    // 对白会被从逗号处腰斩，只剩后半句。
    //
    // 这里必须用**半角**逗号。全角「，」不会触发这个 bug，
    // 用它当夹具只会得到一条永远绿的假测试——英文台词、
    // 中英混排、以及「今天,我们来探店」这类写法都会踩到。
    const cues = parseSubtitle(
      ass('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,今天,我们来探店这家火锅店'),
      '.ass',
    )

    expect(cues[0]?.text).toBe('今天,我们来探店这家火锅店')
  })

  it('对白里连续两个半角逗号也不丢字', () => {
    const cues = parseSubtitle(
      ass('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,第一,第二,第三'),
      '.ass',
    )

    expect(cues[0]?.text).toBe('第一,第二,第三')
  })

  it('样式与定位标记被剥掉，只剩文字', () => {
    const cues = parseSubtitle(
      ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(960,540)\\an8\\c&HFFFFFF&}火锅店{\\r}',
      ),
      '.ass',
    )

    expect(cues[0]?.text).toBe('火锅店')
  })

  it('矢量绘图不会留下坐标数字', () => {
    // 动漫字幕的标题字与歌词特效大量用 {\\p1} 画图。
    // 只剥 {} 标签的话，中间那串坐标会原样混进正文，把检索结果污染成乱码。
    const cues = parseSubtitle(
      ass(
        'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}正式对白',
      ),
      '.ass',
    )

    expect(cues[0]?.text).toBe('正式对白')
  })

  it('\\N 硬换行变成空格而不是消失', () => {
    const cues = parseSubtitle(
      ass('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,上半句\\N下半句'),
      '.ass',
    )

    expect(cues[0]?.text).toBe('上半句 下半句')
  })

  it('以 Format 行为准，而不是硬编码第 10 列', () => {
    // 这份文件没有 Layer 列，且 Start/End 在第 1、2 位。
    // 若按标准位置去取，会把 End 当成 Start，时间轴整体错位。
    const text = [
      '[Events]',
      'Format: Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0:00:01.00,0:00:04.00,Default,,0,0,0,,列序不同',
    ].join('\n')

    const cues = parseSubtitle(text, '.ass')
    expect(cues).toEqual([{ text: '列序不同', startMs: 1000, endMs: 4000 }])
  })

  it('[V4+ Styles] 里的 Style 行不会被当成对白', () => {
    const cues = parseSubtitle(
      ass('Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,只有这一条'),
      '.ass',
    )

    expect(cues).toHaveLength(1)
    expect(cues[0]?.text).toBe('只有这一条')
  })

  it('SSA 的 Marked 列不影响解析', () => {
    const text = [
      '[Events]',
      'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: Marked=0,0:00:01.00,0:00:04.00,Default,,0,0,0,,老格式也能读',
    ].join('\n')

    expect(parseSubtitle(text, '.ssa')[0]?.text).toBe('老格式也能读')
  })

  it('没有 [Events] 段时解析出空数组', () => {
    expect(parseSubtitle('[Script Info]\nTitle: 空字幕', '.ass')).toEqual([])
  })
})

describe('编码嗅探', () => {
  it('UTF-8 正常读出', () => {
    expect(decodeSubtitleText(Buffer.from('火锅店', 'utf8'))).toBe('火锅店')
  })

  it('剥掉 UTF-8 BOM', () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('火锅店', 'utf8')])
    expect(decodeSubtitleText(buffer)).toBe('火锅店')
  })

  it('认出 UTF-16LE BOM', () => {
    // 显式拼出 FF FE 前缀，不在源码里塞一个看不见的 BOM 字符
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('火锅店', 'utf16le')])
    expect(decodeSubtitleText(buffer)).toBe('火锅店')
  })

  it('不是合法 UTF-8 时按 GBK 解', () => {
    // 字幕组生态里 GBK 字幕大量存在，早年尤其如此。
    // 直接按 UTF-8 读会整份变成乱码，而且**不报错**——
    // 用户只会看到一份读不懂的文本，然后以为程序坏了。
    // 0xBDF1 0xCCEC 正是 GBK 的「今天」。
    const buffer = Buffer.concat([
      Buffer.from('1\n00:00:01,000 --> 00:00:04,000\n', 'utf8'),
      Buffer.from([0xbd, 0xf1, 0xcc, 0xec]),
      Buffer.from('\n', 'utf8'),
    ])

    const cues = parseSubtitle(decodeSubtitleText(buffer), '.srt')
    expect(cues[0]?.text).toBe('今天')
  })

  it('合法 UTF-8 里出现替换字符也不会被误判成 GBK', () => {
    // 用 fatal:true 做判定而不是「检查有没有 U+FFFD」，就是为了这一条：
    // 那个字符是合法的 UTF-8，不该成为「这文件是 GBK」的理由。
    const text = '今天�好'
    expect(decodeSubtitleText(Buffer.from(text, 'utf8'))).toBe(text)
  })
})
