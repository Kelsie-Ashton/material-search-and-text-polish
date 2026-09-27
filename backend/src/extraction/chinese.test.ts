import { describe, expect, it } from 'vitest'

import { toSimplified } from './chinese.js'

/**
 * 繁简转换的测试。
 *
 * 用例取自**真实转写结果**，不是编的：下面第一条就是 Whisper 对
 * 「今天我们来探店这家火锅店，招牌菜是毛肚和鸭肠，人均消费八十元左右。」
 * 这段普通话的实际输出。用真实输出做夹具，才能守住"用户拿到的东西"。
 */

describe('繁体转简体', () => {
  it('把真实的转写输出转成简体', () => {
    const fromWhisper = '今天我們來探店這家火鍋店招牌菜是毛賭和鴨腸人均消費80元左右'

    const result = toSimplified(fromWhisper)

    // 逐字断言，不用正则——「消」「费」这类字里，有的在繁简中同形
    // （消），把它们塞进同一个字符类会写出永远失败的断言。
    expect(result).toContain('我们')
    expect(result).toContain('这')
    expect(result).toContain('消费')
    expect(result).not.toContain('們')
    expect(result).not.toContain('這')
    expect(result).not.toContain('鴨')
    expect(result).not.toContain('腸')
    // 注意「毛賭 → 毛赌」不在此列：那是模型的识别错误（应为"毛肚"），
    // 繁简转换不该、也不可能修好它。混在一起断言会掩盖真正的转换问题。
    expect(result).toContain('毛赌')
  })

  it('只换字形，不替换用词', () => {
    // 这是**刻意的**：转写场景下说话人说的就是"开启"，我们不该替他改成"打开"。
    // opencc-js 的 twp 配置会做词汇映射（会输出"请打开软件"），这里明确不要它。
    expect(toSimplified('請開啟軟體')).toBe('请开启软体')
    expect(toSimplified('搭計程車去機場')).toBe('搭计程车去机场')
  })

  it('已是简体时原样返回', () => {
    const simplified = '今天我们来探店这家火锅店'
    expect(toSimplified(simplified)).toBe(simplified)
  })

  it('英文与数字不受影响', () => {
    // 转写结果里常混着数字与英文，转换器不该碰它们
    expect(toSimplified('人均消費 80 元左右 OK')).toBe('人均消费 80 元左右 OK')
  })

  it('空串与纯标点不报错', () => {
    expect(toSimplified('')).toBe('')
    expect(toSimplified('，。！？')).toBe('，。！？')
  })
})
