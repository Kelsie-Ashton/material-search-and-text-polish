import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { countRows } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import { addDirectory, type DirectoryRecord } from './directories.js'
import { scanDirectory } from './scanner.js'

describe('素材扫描', () => {
  let db: Db
  let root: string
  let directory: DirectoryRecord

  beforeEach(() => {
    db = createTestDb()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mstp-scan-'))

    const added = addDirectory(db, { path: root })
    if (!added.ok) throw new Error(`测试前置失败：${added.error.message}`)
    directory = added.value
  })

  afterEach(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** 写一个文件，相对 root。返回绝对路径。 */
  function write(relative: string, content = 'x'): string {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    return full
  }

  function scan(scanId: number, options: Partial<Parameters<typeof scanDirectory>[2]> = {}) {
    return scanDirectory(db, directory, { scanId, ...options })
  }

  function assetPaths(): string[] {
    const rows = db
      .prepare('SELECT path FROM assets ORDER BY path')
      .all() as Array<{ path: string }>
    return rows.map((r) => r.path)
  }

  function assetByName(name: string): { id: number; fingerprint: string } | undefined {
    return db
      .prepare('SELECT id, fingerprint FROM assets WHERE file_name = ?')
      .get(name) as { id: number; fingerprint: string } | undefined
  }

  describe('类型过滤与递归', () => {
    it('索引受支持的文件，跳过不支持的类型', async () => {
      write('探店.mp4')
      write('配音.mp3')
      write('封面.png')
      write('字幕.srt')
      write('笔记.docx') // 不支持
      write('数据.xlsx') // 不支持
      write('没有扩展名') // 不支持

      const result = await scan(1)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.indexed).toBe(4)
      // 不支持的类型是「跳过」而不是「报错」——不该污染错误清单
      expect(result.value.errors).toEqual([])
      expect(assetPaths()).toHaveLength(4)

      // 但必须计数。这是用户唯一能得到的「为什么只索引了 4 个」的答案，
      // 静默跳过会让他以为程序坏了。
      expect(result.value.skippedUnsupported).toBe(3)
      expect(result.value.visited).toBe(7)
    })

    it('递归子目录', async () => {
      write('a.mp4')
      write('子目录/b.mp4')
      write('子目录/更深/c.mp4')

      const result = await scan(1)

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.indexed).toBe(3)
    })

    it('空目录扫描成功且计数为零', async () => {
      const result = await scan(1)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.indexed).toBe(0)
      expect(result.value.completedCleanly).toBe(true)
    })

    it('正确识别素材大类与元数据', async () => {
      write('探店.MP4', 'video-content') // 大写扩展名也要认

      await scan(1)

      const row = db
        .prepare('SELECT kind, ext, file_name, size_bytes FROM assets')
        .get() as { kind: string; ext: string; file_name: string; size_bytes: number }

      expect(row.kind).toBe('video')
      expect(row.ext).toBe('.mp4')
      expect(row.file_name).toBe('探店.MP4')
      expect(row.size_bytes).toBe('video-content'.length)
    })
  })

  describe('增量扫描', () => {
    it('首次全部新增，再次扫描全部未变', async () => {
      write('a.mp4')
      write('b.mp4')

      const first = await scan(1)
      const second = await scan(2)

      expect(first.ok && first.value.indexed).toBe(2)
      expect(second.ok && second.value.indexed).toBe(0)
      expect(second.ok && second.value.unchanged).toBe(2)
      // 未变化不等于没被看到——必须盖章，否则下一阶段会把它当已删除
      expect(second.ok && second.value.removed).toBe(0)
      expect(countRows(db, 'assets')).toBe(2)
    })

    it('新增文件被索引', async () => {
      write('a.mp4')
      await scan(1)

      write('b.mp4')
      const result = await scan(2)

      expect(result.ok && result.value.indexed).toBe(1)
      expect(result.ok && result.value.unchanged).toBe(1)
      expect(countRows(db, 'assets')).toBe(2)
    })

    it('修改过的文件被更新，指纹随之改变', async () => {
      const file = write('a.mp4', 'original')
      await scan(1)
      const before = assetByName('a.mp4')

      // 内容变长 → size 变 → 指纹变。mtime 分辨率不够时 size 兜底。
      fs.writeFileSync(file, 'changed-and-longer')
      const result = await scan(2)

      expect(result.ok && result.value.updated).toBe(1)
      expect(result.ok && result.value.indexed).toBe(0)

      const after = assetByName('a.mp4')
      expect(after?.fingerprint).not.toBe(before?.fingerprint)
      // 更新而不是重建，id 必须保持不变，否则已有关联的标签会丢
      expect(after?.id).toBe(before?.id)
      expect(countRows(db, 'assets')).toBe(1)
    })

    it('磁盘上已删除的文件，记录被清除', async () => {
      write('留下.mp4')
      const doomed = write('删掉.mp4')
      await scan(1)
      expect(countRows(db, 'assets')).toBe(2)

      fs.rmSync(doomed)
      const result = await scan(2)

      expect(result.ok && result.value.removed).toBe(1)
      expect(assetPaths().map((p) => path.basename(p))).toEqual(['留下.mp4'])
    })

    it('汇报完整跑完', async () => {
      write('a.mp4')
      const result = await scan(1)

      expect(result.ok && result.value.completedCleanly).toBe(true)
      expect(result.ok && result.value.cancelled).toBe(false)
    })
  })

  describe('中断语义', () => {
    it('中断时绝不执行清除阶段', async () => {
      // 这是扫描器最容易写错、后果又最严重的一条：
      // 中断时未访问到的文件还带着上一轮的旧批次号，
      // 一旦执行清除就会被当成「磁盘上已删除」而抹掉索引。
      write('a.mp4')
      write('b.mp4')
      const doomed = write('c.mp4')
      await scan(1)
      expect(countRows(db, 'assets')).toBe(3)

      // 磁盘上删掉 c，但模拟一次「刚开始就中断」的扫描
      fs.rmSync(doomed)
      const interrupted = await scan(2, { isCancelled: () => true })

      expect(interrupted.ok).toBe(true)
      if (!interrupted.ok) return
      expect(interrupted.value.cancelled).toBe(true)
      expect(interrupted.value.completedCleanly).toBe(false)
      // 一条都不能少：没有 sweeping，c 的记录应当原样保留
      expect(interrupted.value.removed).toBe(0)
      expect(countRows(db, 'assets')).toBe(3)

      // 再跑一次完整扫描，c 才被清除——证明上面的保留不是「永远删不掉」
      const complete = await scan(3)
      expect(complete.ok && complete.value.removed).toBe(1)
      expect(countRows(db, 'assets')).toBe(2)
    })

    it('中断后已完成部分的索引仍然可用', async () => {
      for (let i = 0; i < 40; i += 1) write(`批量-${String(i).padStart(2, '0')}.mp4`)

      // 每处理完一个批次就让出并触发进度回调，借它翻转取消标志
      let cancel = false
      const result = await scan(1, {
        batchSize: 5,
        isCancelled: () => cancel,
        onProgress: () => {
          cancel = true
        },
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.cancelled).toBe(true)
      // 已访问过的那批必须在库里，且处于可用状态（而不是留了半条记录）
      expect(result.value.indexed).toBeGreaterThan(0)
      expect(countRows(db, 'assets')).toBe(result.value.indexed)
      expect(assetPaths().length).toBeGreaterThan(0)
    })

    it('中断后重扫能补齐剩余文件', async () => {
      for (let i = 0; i < 40; i += 1) write(`批量-${String(i).padStart(2, '0')}.mp4`)

      let cancel = false
      await scan(1, {
        batchSize: 5,
        isCancelled: () => cancel,
        onProgress: () => {
          cancel = true
        },
      })

      const resumed = await scan(2)

      expect(resumed.ok).toBe(true)
      if (resumed.ok) {
        expect(resumed.value.cancelled).toBe(false)
        expect(countRows(db, 'assets')).toBe(40)
        // 已索引的那部分是「未变」，不是重新插入
        expect(resumed.value.unchanged).toBeGreaterThan(0)
      }
    })
  })

  describe('符号链接与错误处理', () => {
    it('跳过指向父目录的 junction，不会无限递归', async () => {
      write('子目录/a.mp4')
      write('b.mp4')

      let linked = false
      try {
        // junction 在 Windows 上不需要管理员权限，是测环路最方便的手段
        fs.symlinkSync(root, path.join(root, '子目录', '回环'), 'junction')
        linked = true
      } catch {
        linked = false
      }

      // 不静默跳过：若链接建不出来，这个测试就什么也没验证，
      // 而它会以「通过」的样子留在测试报告里，比没有还危险。
      expect(linked, 'junction 创建失败，本测试无法验证环路保护').toBe(true)

      const result = await scan(1)

      // 没有无限递归 = 这个 await 能返回；索引数应为 2（junction 不计入）
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.indexed).toBe(2)
      expect(assetPaths().map((p) => path.basename(p)).sort()).toEqual(['a.mp4', 'b.mp4'])
    })

    it('根目录已消失时给出明确原因，而不是安静地扫出零个文件', async () => {
      fs.rmSync(root, { recursive: true, force: true })

      const result = await scan(1)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('SCAN_DIRECTORY_MISSING')
      expect(result.error.message).toContain('无法访问')
    })

    it('目录记录被移除后扫描仍然报错而非崩溃', async () => {
      write('a.mp4')
      const missing = { ...directory, path: path.join(root, '并不存在') }

      const result = await scanDirectory(db, missing, { scanId: 1 })

      expect(result.ok).toBe(false)
    })
  })

  describe('不阻塞事件循环', () => {
    it('扫描期间定时器仍能触发（分批让出的验收）', async () => {
      // better-sqlite3 是同步的。若把整个扫描包进一个事务，
      // 进度查询接口会在扫描期间完全无法响应，界面进度条卡死。
      for (let i = 0; i < 200; i += 1) write(`批量-${String(i).padStart(3, '0')}.mp4`)

      const scanning = scan(1, { batchSize: 20 })
      // 先让扫描真正跑起来，再下定时器，避免测到「扫描启动前的空转」
      await new Promise((resolve) => setImmediate(resolve))

      let timerFiredWhileScanning = false
      let finished = false
      const timer = setTimeout(() => {
        if (!finished) timerFiredWhileScanning = true
      }, 0)

      const result = await scanning
      finished = true
      clearTimeout(timer)

      expect(result.ok && result.value.indexed).toBe(200)
      expect(timerFiredWhileScanning).toBe(true)
    })
  })

  describe('多目录隔离', () => {
    it('一个目录的扫描不会清除另一个目录的记录', async () => {
      const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstp-scan-other-'))
      try {
        const other = addDirectory(db, { path: otherRoot })
        if (!other.ok) throw new Error('前置失败')
        fs.writeFileSync(path.join(otherRoot, '别的.mp4'), 'x')

        write('我的.mp4')
        await scanDirectory(db, directory, { scanId: 1 })
        await scanDirectory(db, other.value, { scanId: 2 })

        expect(countRows(db, 'assets')).toBe(2)

        // 用同一个批次号再扫其中一个目录，另一个的记录不能被误删
        fs.writeFileSync(path.join(otherRoot, '别的2.mp4'), 'x')
        await scanDirectory(db, other.value, { scanId: 3 })

        expect(countRows(db, 'assets')).toBe(3)
      } finally {
        fs.rmSync(otherRoot, { recursive: true, force: true })
      }
    })
  })
})
