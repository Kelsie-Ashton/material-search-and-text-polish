import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { createAsset, createDirectory, countRows } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import { linkTag, listAssetTags, listTags, normalizeTagName, pruneOrphanTags, unlinkTag } from './service.js'

describe('标签服务', () => {
  let db: Db
  let assetId: number
  let otherAssetId: number

  beforeEach(() => {
    db = createTestDb()
    const dir = createDirectory(db)
    assetId = createAsset(db, dir.id).id
    otherAssetId = createAsset(db, dir.id, { fileName: '火锅.mp4' }).id
  })

  afterEach(() => {
    db.close()
  })

  describe('名称归一', () => {
    it('去掉首尾空白', () => {
      const result = normalizeTagName('  美食  ')
      expect(result.ok && result.value).toBe('美食')
    })

    it('内部连续空白折成一个空格', () => {
      const result = normalizeTagName('美食   视频')
      expect(result.ok && result.value).toBe('美食 视频')
    })

    it('空名字被拒绝', () => {
      const result = normalizeTagName('   ')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('TAG_NAME_INVALID')
    })

    it('超长名字被拒绝', () => {
      const result = normalizeTagName('啊'.repeat(51))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('TAG_NAME_INVALID')
    })

    it('改写展示名时不丢字符', () => {
      // 展示名只做「去空白」这件不改变含义的事。
      // 若在这里做 NFKC，全角「ＭＰ４」会被悄悄改成「MP4」，
      // 用户会以为程序存错了自己输入的东西——所以归一化只用于判重键。
      const result = normalizeTagName('ＭＰ４')
      expect(result.ok && result.value).toBe('ＭＰ４')
    })
  })

  describe('挂标签', () => {
    it('新建并挂上', () => {
      const result = linkTag(db, assetId, '美食')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.tag.name).toBe('美食')
      expect(result.value.tagCreated).toBe(true)
      expect(result.value.alreadyLinked).toBe(false)
      expect(listAssetTags(db, assetId).map((t) => t.name)).toEqual(['美食'])
    })

    it('重复挂同一个标签不产生重复记录，且如实说明', () => {
      linkTag(db, assetId, '美食')
      const again = linkTag(db, assetId, '美食')

      expect(again.ok).toBe(true)
      if (!again.ok) return
      // 这是正常结果不是错误——用户重复点「添加」是必然行为，
      // 用 Err 表达会让调用方被迫为一件不异常的事写异常分支。
      expect(again.value.alreadyLinked).toBe(true)
      expect(again.value.tagCreated).toBe(false)
      expect(countRows(db, 'tags')).toBe(1)
      expect(countRows(db, 'asset_tags')).toBe(1)
    })

    it('同名标签在不同素材间复用同一行', () => {
      linkTag(db, assetId, '美食')
      const second = linkTag(db, otherAssetId, '美食')

      expect(second.ok && second.value.tagCreated).toBe(false)
      expect(countRows(db, 'tags')).toBe(1)
      expect(countRows(db, 'asset_tags')).toBe(2)
    })

    it('判重不受大小写与全半角影响', () => {
      // 用户不会记得自己上次写的是 MP4 还是 mp4，
      // 更不会知道全角的 ＭＰ４ 在库里应该算同一个。
      linkTag(db, assetId, 'MP4')
      linkTag(db, assetId, 'mp4')
      linkTag(db, assetId, 'ＭＰ４')

      expect(countRows(db, 'tags')).toBe(1)
      expect(countRows(db, 'asset_tags')).toBe(1)
    })

    it('判重不受首尾空白影响', () => {
      linkTag(db, assetId, '美食')
      const again = linkTag(db, assetId, ' 美食 ')

      expect(again.ok && again.value.alreadyLinked).toBe(true)
      expect(countRows(db, 'tags')).toBe(1)
    })

    it('保留第一次输入的写法作为展示名', () => {
      linkTag(db, assetId, 'MP4')
      linkTag(db, otherAssetId, 'mp4')

      const tags = listTags(db)
      expect(tags).toHaveLength(1)
      // 判重按归一化的键，展示按第一次的写法——
      // 否则同一个标签会在不同素材上显示成不同样子。
      expect(tags[0]?.name).toBe('MP4')
    })

    it('重名标签不覆盖已有颜色', () => {
      // 否则标签的样式会随「最后操作它的那个素材」而变
      linkTag(db, assetId, '美食', { color: '#ff0000' })
      linkTag(db, otherAssetId, '美食', { color: '#00ff00' })

      expect(listTags(db)[0]?.color).toBe('#ff0000')
    })

    it('素材不存在时不建标签', () => {
      const result = linkTag(db, 99999, '美食')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('ASSET_NOT_FOUND')
      // 一次拼错 id 的请求不该在库里留下永远挂不上东西的标签
      expect(countRows(db, 'tags')).toBe(0)
    })

    it('标签名非法时不写任何东西', () => {
      const result = linkTag(db, assetId, '   ')

      expect(result.ok).toBe(false)
      expect(countRows(db, 'tags')).toBe(0)
      expect(countRows(db, 'asset_tags')).toBe(0)
    })

    it('记录来源', () => {
      linkTag(db, assetId, '美食', { source: 'extracted' })

      const row = db.prepare('SELECT source FROM asset_tags').get() as { source: string }
      expect(row.source).toBe('extracted')
    })
  })

  describe('摘标签', () => {
    it('摘掉已挂的标签', () => {
      const linked = linkTag(db, assetId, '美食')
      if (!linked.ok) throw new Error('夹具挂标签失败')

      const result = unlinkTag(db, assetId, linked.value.tag.id)

      expect(result.ok && result.value.removed).toBe(true)
      expect(listAssetTags(db, assetId)).toEqual([])
    })

    it('摘掉本来就没挂的标签不算错误', () => {
      const linked = linkTag(db, assetId, '美食')
      if (!linked.ok) throw new Error('夹具挂标签失败')
      unlinkTag(db, assetId, linked.value.tag.id)

      // 用户对着一个已经摘掉的标签再点一次删除，界面不该弹红字
      const again = unlinkTag(db, assetId, linked.value.tag.id)
      expect(again.ok && again.value.removed).toBe(false)
    })

    it('摘标签不删标签本身', () => {
      // 标签列表同时充当词汇表，静默缩水比留几条没人用的更烦人
      const linked = linkTag(db, assetId, '美食')
      if (!linked.ok) throw new Error('夹具挂标签失败')
      unlinkTag(db, assetId, linked.value.tag.id)

      expect(listTags(db)).toHaveLength(1)
      expect(listTags(db)[0]?.usageCount).toBe(0)
    })

    it('只摘指定素材的链接', () => {
      const first = linkTag(db, assetId, '美食')
      linkTag(db, otherAssetId, '美食')
      if (!first.ok) throw new Error('夹具挂标签失败')

      unlinkTag(db, assetId, first.value.tag.id)

      expect(listAssetTags(db, assetId)).toEqual([])
      expect(listAssetTags(db, otherAssetId)).toHaveLength(1)
    })

    it('素材不存在时返回 ASSET_NOT_FOUND', () => {
      const result = unlinkTag(db, 99999, 1)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('ASSET_NOT_FOUND')
    })
  })

  describe('标签列表', () => {
    it('统计使用次数', () => {
      linkTag(db, assetId, '美食')
      linkTag(db, otherAssetId, '美食')
      linkTag(db, assetId, '剪辑')

      const tags = listTags(db)
      const byName = new Map(tags.map((t) => [t.name, t.usageCount]))
      expect(byName.get('美食')).toBe(2)
      expect(byName.get('剪辑')).toBe(1)
    })

    it('孤儿标签留在列表里且次数为 0', () => {
      // 藏着它会让用户对不上账：他明明建过这个标签
      const linked = linkTag(db, assetId, '美食')
      if (!linked.ok) throw new Error('夹具挂标签失败')
      unlinkTag(db, assetId, linked.value.tag.id)

      const tags = listTags(db)
      expect(tags.map((t) => t.name)).toEqual(['美食'])
      expect(tags[0]?.usageCount).toBe(0)
    })

    it('清理孤儿标签是显式操作', () => {
      linkTag(db, assetId, '美食')
      const orphan = linkTag(db, assetId, '临时')
      if (!orphan.ok) throw new Error('夹具挂标签失败')
      unlinkTag(db, assetId, orphan.value.tag.id)

      expect(pruneOrphanTags(db).removed).toBe(1)
      expect(listTags(db).map((t) => t.name)).toEqual(['美食'])
    })
  })

  describe('级联', () => {
    it('删素材后链接消失，标签本身留下', () => {
      linkTag(db, assetId, '美食')

      db.prepare('DELETE FROM assets WHERE id = ?').run(assetId)

      expect(countRows(db, 'asset_tags')).toBe(0)
      expect(countRows(db, 'tags')).toBe(1)
    })
  })
})
