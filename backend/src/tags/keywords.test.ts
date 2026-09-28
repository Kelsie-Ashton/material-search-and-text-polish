import { describe, expect, it } from 'vitest'

import { extractKeywordCandidates } from './keywords.js'

/**
 * 候选关键词的测试（任务 6.10）。
 *
 * 这是个纯函数，所以能整段整段地喂真实形状的文本进去。**这里的构造都要
 * 像真字幕**：词反复出现、左右邻字五花八门、中间夹标点——不像真字幕的话，
 * 测过的是「这个函数在干净输入上不崩」，而它真正会出错的地方全在脏输入上。
 *
 * 几条断言直接抄自实测：高达那部剧场版里「阿姆罗」被拆成「阿姆」+「姆罗」，
 * 而「啊啊」排进了前七。这两个都是真跑出来的，不是想象的边界情况。
 */

/** 造一段正文：`word` 反复出现，且左右邻字都在变——这正是真词的样子 */
function repeat(word: string, times: number): string {
  const left = '的了是在和有人这那就都也很'
  const right = '啊吧呢吗呀哦嗯哈嘛哇'
  return Array.from(
    { length: times },
    (_, i) => `${left[i % left.length]}${word}${right[(i * 3) % right.length]}`,
  ).join('\n')
}

function words(text: string, limit?: number): string[] {
  return extractKeywordCandidates(text, limit).map((candidate) => candidate.word)
}

describe('候选关键词', () => {
  it('反复出现的词被挑出来', () => {
    expect(words(repeat('火锅店', 10))).toContain('火锅店')
  })

  it('只出现一两次的片段不挑——那多半是巧合', () => {
    expect(words('今天我们去了火锅店，然后就回家了')).toEqual([])
  })

  it('正文为空或太短时返回空数组，而不是报错', () => {
    // 「没什么可建议的」是正常结果。返回空数组，界面据此说一句说明即可；
    // 报错的话，每个刚扫进来还没提取的素材点开详情都会看到一个红条。
    expect(words('')).toEqual([])
    expect(words('短')).toEqual([])
    expect(words('。，！？')).toEqual([])
  })

  it('**砍掉长词的碎片**——实测：阿姆罗被拆成阿姆 + 姆罗', () => {
    // 这是三条统计规则全都拦不住的情况：名字后面接的字花样很多，
    // 两半各自的左右邻居都够杂，看起来完全像两个独立的词。
    // 判据只能靠「更长的那个也存在」。
    const text = repeat('阿姆罗', 12)
    const found = words(text)

    expect(found).toContain('阿姆罗')
    expect(found).not.toContain('阿姆')
    expect(found).not.toContain('姆罗')
  })

  it('碎片比长词明显更常见时，碎片是独立的词，要留下', () => {
    // 容差不能大到无脑砍短词：「火锅」在正文里既有「火锅」也有「火锅店」时，
    // 它的频次会明显高于「火锅店」，那它就是独立的词。
    const text = `${repeat('火锅', 20)}\n${repeat('火锅店', 5)}`
    const found = words(text)

    expect(found).toContain('火锅')
  })

  it('**同一个字重复的片段不挑**——实测：「啊啊」排进了前七', () => {
    // 语气词在字幕里频次极高、邻居也杂，统计规则全都放行，
    // 但它们不是词。实测里它还把真正有信息量的词挤掉了一个。
    expect(words(repeat('啊啊', 20))).not.toContain('啊啊')
    expect(words(repeat('嗯嗯', 20))).not.toContain('嗯嗯')
  })

  it('虚词与「虚词 + 结构助词」的碎片不挑', () => {
    // 它们统计上完全像词，但没人会拿「的话」去搜素材。
    // 这份名单是**可以读、可以改的**，而调参调出来的边界没人看得懂。
    expect(words(repeat('就是', 20))).not.toContain('就是')
    expect(words(repeat('的话', 20))).not.toContain('的话')
    expect(words(repeat('我们', 20))).not.toContain('我们')
  })

  it('拉丁词与数字不参与——它们本来就有词边界', () => {
    // 「the」「2024」这类不需要靠统计去猜边界，混进来只会污染候选
    expect(words(repeat('hello', 20))).toEqual([])
    expect(words(repeat('2024', 20))).toEqual([])
  })

  it('不跨越标点拼词', () => {
    // 「会说」+「话」中间隔着标点时不该被当成一个片段。
    // 跨标点的片段不是词，算进来只会污染频次。
    const text = Array.from({ length: 10 }, () => '他说，话就到这里。').join('\n')
    expect(words(text)).not.toContain('说话')
  })

  it('按频次从高到低排', () => {
    const text = `${repeat('火锅店', 20)}\n${repeat('烤肉店', 6)}`

    const candidates = extractKeywordCandidates(text)

    const hotpot = candidates.findIndex((c) => c.word === '火锅店')
    const bbq = candidates.findIndex((c) => c.word === '烤肉店')
    expect(hotpot).toBeGreaterThanOrEqual(0)
    expect(bbq).toBeGreaterThan(hotpot)
  })

  it('频次如实报出来，供用户判断这个词有没有代表性', () => {
    const candidate = extractKeywordCandidates(repeat('火锅店', 9)).find(
      (c) => c.word === '火锅店',
    )

    expect(candidate?.frequency).toBe(9)
  })

  it('不超过数量上限', () => {
    // 界面上是一排勾选框。给二十个只会让人一个都不勾。
    //
    // 夹具必须是**纯汉字且互不为子串**的若干个词——用「词条1号」那种带数字的
    // 只会切出一堆两字残片，测出来的是夹具的问题而不是上限的问题。
    const pool = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳'
    const text = Array.from({ length: 30 }, (_, i) =>
      repeat(`${pool[i]}${pool[(i + 7) % pool.length]}店`, 5),
    ).join('\n')

    expect(extractKeywordCandidates(text, 5)).toHaveLength(5)
  })

  it('长文本也能跑完，不会卡住', () => {
    // 逐段拼接后是一部长片的量级。这个函数在每次打开详情面板时都会跑。
    const text = repeat('机动战士', 2000)

    expect(extractKeywordCandidates(text).length).toBeGreaterThan(0)
  })
})
