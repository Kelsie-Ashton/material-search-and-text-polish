import { describe, expect, it } from 'vitest'

import { SUPPORTED_EXTENSIONS } from './config.js'

/**
 * 素材分类的守卫测试。
 *
 * 这里断言的不是「配置写对了吗」，而是**一类东西不许出现**：
 * 「动漫 / 漫画 / 剧 / 游戏」这样的**题材**不得成为代码里的分类维度
 * （design.md 决策 11）。题材是用户的词汇，边界因人而异且会不断长出新词
 * ——纪录片、综艺、Vlog、播客、访谈……代码里穷举不完，列不全的枚举就是坏枚举。
 * 它已经有了正确的归宿：标签（住在数据库里，用户自建、可增删、参与检索）。
 *
 * 这套断言的用处在于：把文档里的一句承诺，变成改代码时会立刻撞上的墙。
 * 想往 SUPPORTED_EXTENSIONS 里塞一个 anime / game 键，这里会先红。
 */

/** 文件类型：回答「怎么读这个文件」，由文件本身决定，可以穷举 */
const FILE_KINDS = ['audio', 'image', 'text', 'video']

describe('受支持的素材扩展名', () => {
  it('只有文件类型，没有题材', () => {
    expect(Object.keys(SUPPORTED_EXTENSIONS).sort()).toEqual(FILE_KINDS)
  })

  it('每一项都是扩展名，而不是题材标签', () => {
    for (const [kind, extensions] of Object.entries(SUPPORTED_EXTENSIONS)) {
      for (const ext of extensions) {
        // 题材名（anime、动漫）既不会有点号开头，也不会长成扩展名的样子。
        // 这一条挡的是「把一个题材当作伪扩展名混进来」。
        expect(ext, `${kind} 下的 ${ext} 应当是以点开头的扩展名`).toMatch(/^\.[a-z0-9]+$/)
      }
    }
  })

  it('同一个扩展名不归属两个类型', () => {
    const all = Object.values(SUPPORTED_EXTENSIONS).flat()
    // 重复归属会让扫描结果取决于遍历顺序，这类 bug 极难从现象倒推回原因
    expect(new Set(all).size).toBe(all.length)
  })

  it('字幕文件归入 text —— 文字本就现成，走直接解析而非 OCR/ASR', () => {
    // 这四种文件的正文可以直接从文件里读出来，不需要任何识别引擎，
    // 也就不该被扔进需要下载模型的图片/音视频路径（design.md 决策 12）
    const subtitles: readonly string[] = SUPPORTED_EXTENSIONS.text
    for (const ext of ['.srt', '.vtt', '.ass', '.ssa']) {
      expect(subtitles).toContain(ext)
    }
  })
})
