import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { search } from '../search/index.js'
import { createAsset, createDirectory, createSegment } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import { archiveKeywords, suggestKeywords } from './archive.js'
import { linkTag } from './service.js'

/**
 * 归档为标签的测试（任务 6.10）。
 *
 * 这一组的核心断言只有一条：**归档之后，那个词能搜到这条素材**。
 * 其余都是围绕它的边界——重复归档、名字不合法、还没提取过文字。
 */

let db: Db
let directoryId: number

beforeEach(() => {
  db = createTestDb()
  directoryId = createDirectory(db).id
})

afterEach(() => {
  db.close()
})

/** 造一条已经提取过文字的素材。正文要**够长且词有变化**，否则挑不出候选。 */
function assetWithText(fileName = '探店.mp4'): number {
  const assetId = createAsset(db, directoryId, { fileName }).id
  const left = '的了是在和有人这那就都也很'
  const right = '啊吧呢吗呀哦嗯哈嘛哇'
  Array.from({ length: 10 }, (_, i) => `${left[i % left.length]}火锅店${right[i % right.length]}`).forEach(
    (text, index) => createSegment(db, assetId, text, { ordinal: index }),
  )
  return assetId
}

describe('候选关键词', () => {
  it('从已提取的正文里挑出候选', () => {
    const assetId = assetWithText()

    const result = suggestKeywords(db, assetId)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.map((c) => c.word)).toContain('火锅店')
    }
  })

  it('还没提取过文字时返回空列表，而不是报错', () => {
    // 一个刚扫进来、还没提取的素材点开详情，不该看到一个红条
    const assetId = createAsset(db, directoryId).id

    const result = suggestKeywords(db, assetId)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual([])
  })

  it('**已经把已打过的标签剔掉**', () => {
    // 候选里出现一个已经挂着的标签，用户勾了、点了归档、什么也没发生——
    // 看起来就像功能坏了。过滤放在这里而不是界面里，是因为界面那份
    // 迟早会与标签列表不同步。
    const assetId = assetWithText()
    linkTag(db, assetId, '火锅店')

    const result = suggestKeywords(db, assetId)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.map((c) => c.word)).not.toContain('火锅店')
  })

  it('素材不存在时如实报错', () => {
    const result = suggestKeywords(db, 9999)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ASSET_NOT_FOUND')
  })
})

describe('归档关键词', () => {
  it('**归档之后，那个词能搜到这条素材**', () => {
    // 这就是 6.10 的验收点，也是这整块功能存在的理由。
    //
    // 造一条**没有正文**的素材：这样「搜得到」只可能来自标签，
    // 不可能来自正文命中——否则这条用例会在正文召回也生效时
    // 悄悄变成一句废话。
    const assetId = createAsset(db, directoryId, { fileName: '无关的名字.mp4' }).id

    const before = search(db, '火锅店')
    expect(before.ok && before.value.items).toHaveLength(0)

    const archived = archiveKeywords(db, assetId, ['火锅店'])
    expect(archived.ok).toBe(true)

    const after = search(db, '火锅店')
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect(after.value.items.map((i) => i.asset.fileName)).toEqual(['无关的名字.mp4'])
      // 而且命中的**来源**是标签，不是文件名或正文——这就是「归档」的语义
      expect(after.value.items[0]?.matchedIn).toContain('tag')
    }
  })

  it('归档的标签来源标成 extracted，与手打的区分开', () => {
    // 用户日后想清理「当初自动建议带出来的标签」时，得有依据
    const assetId = assetWithText()

    archiveKeywords(db, assetId, ['火锅店'])

    const row = db
      .prepare('SELECT source FROM asset_tags WHERE asset_id = ?')
      .get(assetId) as { source: string }
    expect(row.source).toBe('extracted')
  })

  it('一次归档多个，并如实分成「新挂上」与「本来就有」两桶', () => {
    const assetId = assetWithText()
    linkTag(db, assetId, '探店')

    const result = archiveKeywords(db, assetId, ['火锅店', '探店', '毛肚'])

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.linked.map((t) => t.name).sort()).toEqual(['毛肚', '火锅店'])
      // 「本来就有」不是错误，但也不该说成「已归档」——
      // 界面上这两句话不一样
      expect(result.value.alreadyLinked.map((t) => t.name)).toEqual(['探店'])
      expect(result.value.invalid).toEqual([])
    }
  })

  it('同一批里的重复项只处理一次', () => {
    // 勾选框理论上不会给出重复，但这个函数是公开的，
    // 不该指望调用方替它保证
    const assetId = assetWithText()

    const result = archiveKeywords(db, assetId, ['火锅店', '火锅店', ' 火锅店 '])

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.linked).toHaveLength(1)
  })

  it('名字不合法的跳过而不是整批失败', () => {
    // 用户勾了六个候选，因为其中一个撞上长度上限就全军覆没，
    // 是让人很难理解的失败方式
    const assetId = assetWithText()

    const result = archiveKeywords(db, assetId, ['火锅店', '', '一'.repeat(200)])

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.linked.map((t) => t.name)).toEqual(['火锅店'])
      expect(result.value.invalid).toHaveLength(2)
    }
  })

  it('空数组是合法的：什么都没勾就点归档', () => {
    const assetId = assetWithText()

    const result = archiveKeywords(db, assetId, [])

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ linked: [], alreadyLinked: [], invalid: [] })
    }
  })

  it('素材不存在时如实报错，且不留下孤儿标签', () => {
    // 拼错 id 的请求在库里留下一个永远挂不上任何东西的标签，
    // 用户下次在标签列表里看到它会以为程序坏了
    const result = archiveKeywords(db, 9999, ['火锅店'])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ASSET_NOT_FOUND')

    const row = db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }
    expect(row.n).toBe(0)
  })

  it('大小写与全角差异不会造出两个标签', () => {
    // 与手打标签走的是同一套归一（NFKC + 折叠空白 + 转小写）
    const assetId = assetWithText()

    const result = archiveKeywords(db, assetId, ['MP4', 'ｍｐ４', 'mp4'])

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.linked).toHaveLength(1)
  })
})
