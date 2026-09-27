import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { countRows } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import type { Db } from '../db/index.js'
import { addDirectory, findDirectory, listDirectories, removeDirectory } from './directories.js'
import { createAsset } from '../test/factory.js'

/**
 * 这些测试**使用真实的临时目录**而不是 mock 掉 fs。
 * 因为本模块的核心风险恰恰在于它与真实文件系统的交互：
 * 路径规范化在 Windows 上的行为、statSync 对符号链接的处理、
 * 以及「移除目录不删文件」这条承诺——mock 掉 fs 就把这些全测没了。
 */
describe('素材目录管理', () => {
  let db: Db
  let root: string

  beforeEach(() => {
    db = createTestDb()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mstp-dir-'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function makeDir(...segments: string[]): string {
    const target = path.join(root, ...segments)
    fs.mkdirSync(target, { recursive: true })
    return target
  }

  describe('添加目录', () => {
    it('成功添加并回填路径与标签', () => {
      const target = makeDir('美食素材')
      const result = addDirectory(db, { path: target })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.path).toBe(target)
      expect(result.value.label).toBe('美食素材')
      expect(result.value.enabled).toBe(true)
      expect(findDirectory(db, result.value.id)).not.toBeNull()
    })

    it('重复添加同一路径被拒绝', () => {
      const target = makeDir('美食素材')
      expect(addDirectory(db, { path: target }).ok).toBe(true)

      const second = addDirectory(db, { path: target })

      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.error.code).toBe('DIRECTORY_DUPLICATE')
      // 提示里要带上已有的那条，用户才知道自己什么时候加过
      expect(second.error.message).toContain(target)
    })

    it('同一目录的不同写法都会被认出来，不会产生第二份记录', () => {
      const target = makeDir('美食素材')
      expect(addDirectory(db, { path: target }).ok).toBe(true)

      // 尾部分隔符、正斜杠、当前目录段、大小写变化
      const variants = [
        `${target}${path.sep}`,
        target.replace(/\\/g, '/'),
        path.join(target, '.'),
        target.toUpperCase(),
      ]

      for (const variant of variants) {
        const result = addDirectory(db, { path: variant })
        expect(result.ok, `写法「${variant}」本应被识别为重复`).toBe(false)
      }

      expect(countRows(db, 'directories')).toBe(1)
    })

    it('路径不存在时给出可读原因', () => {
      const result = addDirectory(db, { path: path.join(root, '并不存在的目录') })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('DIRECTORY_NOT_FOUND')
      expect(result.error.message).toContain('不存在')
    })

    it('指向文件而非目录时明确拒绝', () => {
      const file = path.join(root, '素材.mp4')
      fs.writeFileSync(file, 'x')

      const result = addDirectory(db, { path: file })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('DIRECTORY_NOT_DIRECTORY')
    })

    it('空路径被拒绝', () => {
      for (const bad of ['', '   ']) {
        const result = addDirectory(db, { path: bad })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.code).toBe('DIRECTORY_NOT_FOUND')
      }
      expect(countRows(db, 'directories')).toBe(0)
    })

    it('可以自定义标签', () => {
      const target = makeDir('a', 'b', 'c')
      const result = addDirectory(db, { path: target, label: '我的素材' })

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.label).toBe('我的素材')
    })
  })

  describe('移除目录', () => {
    it('只清索引，磁盘上的文件一个都不能少', () => {
      // 这是整个模块最重要的一条承诺。
      const target = makeDir('美食素材')
      const video = path.join(target, '探店.mp4')
      const nested = path.join(target, '子目录', '火锅.png')
      fs.mkdirSync(path.dirname(nested), { recursive: true })
      fs.writeFileSync(video, 'video-bytes')
      fs.writeFileSync(nested, 'image-bytes')

      const added = addDirectory(db, { path: target })
      expect(added.ok).toBe(true)
      if (!added.ok) return

      const removed = removeDirectory(db, added.value.id)

      expect(removed.ok).toBe(true)
      if (removed.ok) expect(removed.value.filesUntouched).toBe(true)

      // 数据库里干干净净
      expect(countRows(db, 'directories')).toBe(0)
      // 磁盘上原封不动
      expect(fs.existsSync(video)).toBe(true)
      expect(fs.existsSync(nested)).toBe(true)
      expect(fs.readFileSync(video, 'utf8')).toBe('video-bytes')
    })

    it('级联清除素材记录并如实报告数量', () => {
      const target = makeDir('美食素材')
      const added = addDirectory(db, { path: target })
      if (!added.ok) throw new Error('前置失败')

      createAsset(db, added.value.id, { fileName: 'a.mp4' })
      createAsset(db, added.value.id, { fileName: 'b.mp4' })
      expect(countRows(db, 'assets')).toBe(2)

      const removed = removeDirectory(db, added.value.id)

      expect(removed.ok).toBe(true)
      if (removed.ok) expect(removed.value.removedAssets).toBe(2)
      expect(countRows(db, 'assets')).toBe(0)
    })

    it('移除不存在的目录返回 NOT_FOUND', () => {
      const result = removeDirectory(db, 999)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('DIRECTORY_NOT_FOUND')
    })

    it('移除后可以重新添加同一目录', () => {
      const target = makeDir('美食素材')
      const first = addDirectory(db, { path: target })
      if (!first.ok) throw new Error('前置失败')

      removeDirectory(db, first.value.id)

      // 唯一索引上那条记录已经消失，不该再拦着
      expect(addDirectory(db, { path: target }).ok).toBe(true)
    })
  })

  describe('列出目录', () => {
    it('按添加顺序返回', () => {
      const a = makeDir('甲')
      const b = makeDir('乙')
      addDirectory(db, { path: a })
      addDirectory(db, { path: b })

      const list = listDirectories(db)

      expect(list.map((d) => d.path)).toEqual([a, b])
    })

    it('空库返回空数组而非报错', () => {
      expect(listDirectories(db)).toEqual([])
    })

    it('enabled 与 lastScannedAt 如实映射', () => {
      const target = makeDir('美食素材')
      addDirectory(db, { path: target })

      const [record] = listDirectories(db)

      expect(record?.enabled).toBe(true)
      expect(record?.lastScannedAt).toBeNull()
    })
  })
})
