import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { createTestDb } from '../test/temp-db.js'
import { search } from './index.js'
import { MAX_SEGMENTS_PER_ASSET } from './types.js'

/**
 * 检索的集成测试。
 *
 * 这里每一条断言都对应一个**静默失效**——写错了不报错，只是搜不到东西。
 * 所以测试的重点不是「正常路径能跑」，而是「长词短词混用、操作符注入、
 * 覆盖层级」这些容易悄悄坏掉的地方。
 */

interface Fixture {
  fileName: string
  /** 标签名 */
  tags?: string[]
  /** 正文段落 */
  segments?: string[]
}

describe('检索', () => {
  let db: Db

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  /** 造素材夹具。trigram 索引由 schema 里的触发器自动维护。 */
  function seed(fixtures: Fixture[]): void {
    const now = Date.now()
    db.prepare(
      `INSERT INTO directories (path, path_key, label, created_at) VALUES ('D:/m','d:/m','素材',?)`,
    ).run(now)
    const dirId = (db.prepare('SELECT id FROM directories').get() as { id: number }).id

    fixtures.forEach((fixture, index) => {
      const assetId = Number(
        db
          .prepare(
            `INSERT INTO assets (directory_id, path, path_key, file_name, ext, kind,
                                 size_bytes, mtime_ms, fingerprint, created_at, updated_at)
             VALUES (?, ?, ?, ?, '.mp4', 'video', 1, 1, '1:1', ?, ?)`,
          )
          .run(
            dirId,
            `D:/m/${fixture.fileName}`,
            `d:/m/${index}-${fixture.fileName}`,
            fixture.fileName,
            now,
            now,
          ).lastInsertRowid,
      )

      for (const [tagIndex, tag] of (fixture.tags ?? []).entries()) {
        db.prepare(
          `INSERT INTO tags (name, name_key, created_at) VALUES (?, ?, ?)
           ON CONFLICT(name_key) DO NOTHING`,
        ).run(tag, tag.toLowerCase(), now)
        const tagId = (
          db.prepare('SELECT id FROM tags WHERE name_key = ?').get(tag.toLowerCase()) as {
            id: number
          }
        ).id
        db.prepare(
          `INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, created_at) VALUES (?, ?, 'manual', ?)`,
        ).run(assetId, tagId, now)
        void tagIndex
      }

      for (const [ordinal, text] of (fixture.segments ?? []).entries()) {
        db.prepare(
          `INSERT INTO asset_text_segments (asset_id, source, ordinal, text, created_at)
           VALUES (?, 'audio', ?, ?, ?)`,
        ).run(assetId, ordinal, text, now)
      }
    })
  }

  function namesOf(raw: string): string[] {
    const result = search(db, raw)
    if (!result.ok) throw new Error(`检索失败：${result.error.message}`)
    return result.value.items.map((item) => item.asset.fileName)
  }

  function resultOf(raw: string) {
    const result = search(db, raw)
    if (!result.ok) throw new Error(`检索失败：${result.error.message}`)
    return result.value
  }

  describe('三路召回', () => {
    it('按文件名命中', () => {
      seed([{ fileName: '探店第三期.mp4' }, { fileName: '无关素材.mp4' }])

      expect(namesOf('探店')).toEqual(['探店第三期.mp4'])
    })

    it('按标签命中', () => {
      seed([{ fileName: 'a.mp4', tags: ['探店'] }, { fileName: 'b.mp4' }])

      const result = resultOf('探店')

      expect(result.items.map((i) => i.asset.fileName)).toEqual(['a.mp4'])
      expect(result.items[0]?.matchedIn).toEqual(['tag'])
      expect(result.items[0]?.matchedTags).toEqual(['探店'])
    })

    it('按正文命中，并带回上下文片段', () => {
      seed([{ fileName: 'a.mp4', segments: ['今天我们来探店这家火锅店，老板说锅底是祖传配方'] }])

      const hit = resultOf('火锅店').items[0]

      expect(hit?.matchedIn).toEqual(['segment'])
      expect(hit?.segments).toHaveLength(1)
      expect(hit?.segments[0]?.snippet).toContain('火锅店')
      expect(hit?.segments[0]?.highlights.length).toBeGreaterThan(0)
    })

    it('同一素材多来源命中时只出现一次，且来源被合并', () => {
      seed([
        {
          fileName: '探店视频.mp4',
          tags: ['探店'],
          segments: ['今天我们来探店这家店'],
        },
      ])

      const result = resultOf('探店')

      // 三条路径都命中，但结果只能有一条——否则用户会以为有三个素材
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.matchedIn).toEqual(['file_name', 'tag', 'segment'])
      expect(result.total).toBe(1)
    })
  })

  describe('长短词分流', () => {
    it('两字词也能搜到正文', () => {
      // 这是整个设计里最容易踩的坑：trigram 对 <3 字符返回 0 行且不报错。
      // 若没有 LIKE 兜底，下面这条断言会失败而不会有任何错误提示。
      seed([{ fileName: 'a.mp4', segments: ['今天我们来探店这家火锅店'] }])

      const hit = resultOf('探店').items[0]

      expect(hit?.matchedIn).toEqual(['segment'])
      expect(hit?.segments[0]?.snippet).toContain('探店')
    })

    it('三字及以上走 FTS，同样搜到正文', () => {
      seed([{ fileName: 'a.mp4', segments: ['今天我们来探店这家火锅店'] }])

      expect(resultOf('火锅店').items[0]?.matchedIn).toEqual(['segment'])
    })

    it('长短词混用时两边都生效，不会因短词废掉整个查询', () => {
      // 实测 `"剪辑师" AND "探店"` → 0 行。若把整串交给 FTS，
      // 下面这条会因为短词而被废掉，一条都搜不到。
      seed([
        { fileName: 'a.mp4', segments: ['剪辑师从素材里挑出转场效果，然后去探店拍素材'] },
        { fileName: 'b.mp4', segments: ['这里有火锅店但是没有那个职业'] },
      ])

      const result = resultOf('剪辑师 探店')

      // a 两个词都命中，b 一个都不命中
      expect(result.items.map((i) => i.asset.fileName)).toEqual(['a.mp4'])
    })

    it('短词与长词命中同一段时不重复展示', () => {
      seed([{ fileName: 'a.mp4', segments: ['剪辑师去探店拍摄火锅店'] }])

      const hit = resultOf('剪辑师 探店').items[0]

      // 同一条结果里出现两遍同一段文字会让用户以为有两段
      expect(hit?.segments).toHaveLength(1)
    })

    it('给出短词走兜底扫描的提示', () => {
      seed([{ fileName: 'a.mp4' }])

      const result = resultOf('探店 火锅店')

      expect(result.warnings.map((w) => w.code)).toContain('SHORT_TERM_LIKE_FALLBACK')
    })
  })

  describe('操作符与特殊字符注入', () => {
    it('含连字符的输入不抛 SQL 错误', () => {
      seed([{ fileName: 'a.mp4' }])

      // 裸的 美食-视频 会让 SQLite 抛 `no such column: 视频`。
      // 引号包裹后应当变成一次正常的（可能为空的）查询。
      expect(() => search(db, '美食-视频')).not.toThrow()
      expect(search(db, '美食-视频').ok).toBe(true)
    })

    it('含双引号的输入不抛 SQL 错误', () => {
      seed([{ fileName: 'a.mp4' }])

      // 裸的 美食"视频 抛 `unterminated string`
      expect(() => search(db, '美食"视频')).not.toThrow()
      expect(search(db, '美食"视频').ok).toBe(true)
    })

    it('FTS 操作符被当作普通文字', () => {
      seed([{ fileName: 'a.mp4', segments: ['NEAR 是一个检索操作符'] }])

      // 不转义的话 NEAR( 会被解析成查询语法，要么报错要么语义完全变了
      expect(() => search(db, 'NEAR(探店 视频)')).not.toThrow()
      expect(() => search(db, 'abc*')).not.toThrow()
      expect(() => search(db, 'a:b')).not.toThrow()
    })

    it('文件名里的 % 当字面量处理', () => {
      seed([{ fileName: '100%纯棉.mp4' }, { fileName: '1000纯棉.mp4' }])

      const result = resultOf('100%')

      expect(result.items.map((i) => i.asset.fileName)).toEqual(['100%纯棉.mp4'])
    })
  })

  describe('分档排序', () => {
    it('文件名精确匹配排在正文命中之前', () => {
      seed([
        { fileName: 'a.mp4', segments: ['这家火锅店很好吃'] }, // 仅正文
        { fileName: '火锅店.mp4' }, // 文件名正好是关键词
      ])

      expect(namesOf('火锅店')).toEqual(['火锅店.mp4', 'a.mp4'])
    })

    it('标签精确匹配排第三档之前', () => {
      seed([
        { fileName: 'a.mp4', segments: ['这家火锅店很好吃'] },
        { fileName: 'b.mp4', tags: ['火锅店'] },
      ])

      expect(namesOf('火锅店')).toEqual(['b.mp4', 'a.mp4'])
    })

    it('同档内命中词更多的靠前', () => {
      seed([
        { fileName: '只有一个词.mp4', segments: ['剪辑师'] },
        { fileName: '两个词都有.mp4', segments: ['剪辑师和转场效果'] },
      ])

      // 「两个词都有」命中 2 个词，更贴近用户的整体意图
      expect(namesOf('剪辑师 转场效果')).toEqual(['两个词都有.mp4', '只有一个词.mp4'])
    })

    it('同一批数据重复检索的顺序稳定', () => {
      // 不稳定的话分页会抖动，用户翻页会看到重复或漏项
      seed([
        { fileName: 'a.mp4', segments: ['火锅店'] },
        { fileName: 'b.mp4', segments: ['火锅店'] },
        { fileName: 'c.mp4', segments: ['火锅店'] },
      ])

      expect(namesOf('火锅店')).toEqual(namesOf('火锅店'))
    })
  })

  describe('筛选与分页', () => {
    it('按素材类型筛选', () => {
      seed([{ fileName: 'a.mp4' }, { fileName: 'b.mp3' }])
      db.prepare("UPDATE assets SET kind = 'audio' WHERE file_name = 'b.mp3'").run()

      const result = search(db, 'b', { kind: 'audio' })

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.items.map((i) => i.asset.fileName)).toEqual(['b.mp3'])
    })

    it('分页返回正确的总数与切片', () => {
      seed([{ fileName: '火锅店1.mp4' }, { fileName: '火锅店2.mp4' }, { fileName: '火锅店3.mp4' }])

      const first = search(db, '火锅店', { limit: 2 })
      const second = search(db, '火锅店', { limit: 2, offset: 2 })

      expect(first.ok && first.value.items).toHaveLength(2)
      expect(first.ok && first.value.total).toBe(3)
      expect(second.ok && second.value.items).toHaveLength(1)
    })

    it('无命中时返回空列表而不是错误', () => {
      seed([{ fileName: 'a.mp4' }])

      const result = resultOf('完全不存在的词')

      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })

    it('空关键词被拒绝', () => {
      const result = search(db, '   ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('SEARCH_QUERY_EMPTY')
    })
  })

  describe('正文片段', () => {
    it('带回命中的全部片段，供界面折叠与展开', () => {
      seed([
        {
          fileName: 'a.mp4',
          segments: ['火锅店第一段', '火锅店第二段', '火锅店第三段', '火锅店第四段'],
        },
      ])

      const hit = resultOf('火锅店').items[0]

      // 曾经这里只回 3 条，于是界面上的「展开全部」是个点不动的空按钮。
      // 「默认只显示 3 条」是前端折叠状态的取值，不是接口该做的减法。
      expect(hit?.segments).toHaveLength(4)
      // 按钮上的条数取自这里，计数不实按钮就在撒谎
      expect(hit?.segmentHitCount).toBe(4)
    })

    it('受上限截断时，计数照旧报真实总数', () => {
      seed([
        {
          fileName: 'a.mp4',
          segments: ['火锅店一', '火锅店二', '火锅店三', '火锅店四', '火锅店五'],
        },
      ])

      const result = search(db, '火锅店', { segmentsPerAsset: 2 })

      expect(result.ok).toBe(true)
      if (result.ok) {
        // 少带几段是为了别让一个素材吃光整页；界面据此如实说明「共 5 段」
        expect(result.value.items[0]?.segments).toHaveLength(2)
        expect(result.value.items[0]?.segmentHitCount).toBe(5)
      }
    })

    it('命中数超过召回上限时，计数与结果都不打折扣', () => {
      // 片段有全局上限（recall.ts 的 MAX_SEGMENT_ROWS = 2000，防止超大素材
      // 把内存吃光）。这条上限以前会同时坏掉两件事：
      //
      // 1. **计数**：总数是从被截断的那批行里数出来的，于是命中 2500 段的
      //    素材被报成「共 2000 段」。用户拿这个词回字幕里一对就发现对不上，
      //    从此连别的数字也不信了。
      // 2. **结果**：额度被 a 用光之后，b 一段都取不回来，而「一段都没取回来」
      //    在旧实现里就等于「没命中」——b 那张卡片直接消失。用户搜一个词，
      //    某个文件明明有几十处，列表里却连它都没有。这比数字差几条严重得多。
      //
      // 两条召回路径都要走一遍：长词走 FTS、短词走 LIKE，取行方式不同，
      // 但受同一个全局上限约束。
      const flooding = Array.from({ length: 2500 }, (_, i) => `第${i}段有火锅店`)
      seed([
        { fileName: 'a.mp4', segments: flooding },
        { fileName: 'b.mp4', segments: ['这里也有火锅店'] },
      ])

      for (const keyword of ['火锅店', '火锅']) {
        const items = resultOf(keyword).items
        const a = items.find((item) => item.asset.fileName === 'a.mp4')
        const b = items.find((item) => item.asset.fileName === 'b.mp4')

        expect(a?.segmentHitCount, `${keyword}：计数要如实`).toBe(2500)
        // 带回来的条数仍然受每素材上限约束——那是设计值，不是 bug
        expect(a?.segments, `${keyword}：每素材上限照旧`).toHaveLength(MAX_SEGMENTS_PER_ASSET)
        expect(b, `${keyword}：命中少的素材不能消失`).toBeDefined()
        expect(b?.segmentHitCount, `${keyword}：它的计数同样要如实`).toBe(1)
      }
    })
  })

  describe('索引与主表保持一致', () => {
    it('素材被删除后不会留下幽灵命中', () => {
      // external content 表不会自动清理索引。少了触发器的话，
      // 删掉素材后这里仍会搜到它，而用户点进去是一条不存在的记录。
      seed([{ fileName: 'a.mp4', segments: ['火锅店'] }])

      expect(namesOf('火锅店')).toEqual(['a.mp4'])

      db.prepare('DELETE FROM assets').run()

      expect(namesOf('火锅店')).toEqual([])
    })

    it('正文被修改后检索到的是新内容', () => {
      seed([{ fileName: 'a.mp4', segments: ['火锅店'] }])

      const segmentId = (
        db.prepare('SELECT id FROM asset_text_segments LIMIT 1').get() as { id: number }
      ).id
      db.prepare('UPDATE asset_text_segments SET text = ? WHERE id = ?').run('烧烤摊', segmentId)

      expect(namesOf('烧烤摊')).toEqual(['a.mp4'])
      expect(namesOf('火锅店')).toEqual([])
    })
  })
})
