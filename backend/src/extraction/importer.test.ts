import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { createAsset, createDirectory, ftsRowIds } from '../test/factory.js'
import { updateSettings } from '../settings/preferences.js'
import { createTestDb } from '../test/temp-db.js'
import { importSubtitleText, listSegments } from './importer.js'

/**
 * 字幕导入的测试。
 *
 * 这里验证的是**从磁盘上的一个真实文件，到能被检索命中的段落**这条完整链路。
 * 重点在几件容易做错、且做错了不会报错的事：
 * 重复导入会积累重复文本、失败不留原因、以及正文没进全文索引。
 */

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  '今天我们来探店这家火锅店',
  '',
  '2',
  '00:00:05,000 --> 00:00:08,000',
  '招牌菜是毛肚和鸭肠',
  '',
].join('\r\n')

let db: Db
let workDir: string
let directoryId: number

/** 在临时目录里落一个真实文件，返回它的路径 */
function writeFile(name: string, content: string | Buffer): string {
  const file = path.join(workDir, name)
  fs.writeFileSync(file, content)
  return file
}

function subtitleAsset(name: string, ext: string, options: { sizeBytes?: number } = {}) {
  const file = writeFile(name, SRT)
  return createAsset(db, directoryId, {
    fileName: name,
    path: file,
    ext,
    kind: 'text',
    ...(options.sizeBytes !== undefined ? { sizeBytes: options.sizeBytes } : {}),
  })
}

beforeEach(() => {
  db = createTestDb()
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-import-'))
  directoryId = createDirectory(db).id
})

afterEach(() => {
  db.close()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('字幕导入', () => {
  it('把字幕解析成带时间轴的段落落库', () => {
    const asset = subtitleAsset('探店.srt', '.srt')

    const result = importSubtitleText(db, asset.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.segmentCount).toBe(2)
    expect(result.value.status).toBe('done')
    expect(result.value.empty).toBe(false)
    expect(result.value.reused).toBe(false)

    const segments = listSegments(db, asset.id)
    expect(segments.total).toBe(2)
    expect(segments.items[0]?.text).toBe('今天我们来探店这家火锅店')
    expect(segments.items[0]?.startMs).toBe(1000)
    expect(segments.items[1]?.text).toBe('招牌菜是毛肚和鸭肠')
  })

  it('导入后素材状态变为已提取', () => {
    const asset = subtitleAsset('探店.srt', '.srt')
    importSubtitleText(db, asset.id)

    const row = db
      .prepare('SELECT extract_status, extracted_at, extract_error FROM assets WHERE id = ?')
      .get(asset.id) as {
      extract_status: string
      extracted_at: number | null
      extract_error: string | null
    }

    expect(row.extract_status).toBe('done')
    expect(row.extracted_at).not.toBeNull()
    expect(row.extract_error).toBeNull()
  })

  it('段落直接进全文索引，无需额外步骤', () => {
    // 段落 → FTS 的同步由 asset_text_segments 上的触发器完成。
    // 这条断言的意义是：**导入完就能搜到**，不需要任何后续批量建索引动作。
    const asset = subtitleAsset('探店.srt', '.srt')
    importSubtitleText(db, asset.id)

    const rows = listSegments(db, asset.id)
    const hitIds = ftsRowIds(db, '火锅店')
    expect(hitIds).toContain(rows.items[0]?.id)
  })

  it('重复导入是替换而不是追加', () => {
    // 追加的话，改过字幕再导一次会得到新旧两份文本，
    // 检索时同一句话出现两次，用户会以为索引坏了。
    const asset = subtitleAsset('探店.srt', '.srt')
    importSubtitleText(db, asset.id)
    importSubtitleText(db, asset.id)

    expect(listSegments(db, asset.id).total).toBe(2)
  })

  it('文件没变时命中缓存，不重新解析', () => {
    const asset = subtitleAsset('探店.srt', '.srt')
    importSubtitleText(db, asset.id)

    const second = importSubtitleText(db, asset.id)

    expect(second.ok && second.value.reused).toBe(true)
    expect(second.ok && second.value.segmentCount).toBe(2)
  })

  it('文件变了就不再命中缓存', () => {
    const asset = subtitleAsset('探店.srt', '.srt')
    importSubtitleText(db, asset.id)

    // 模拟重新扫描后指纹更新
    db.prepare('UPDATE assets SET fingerprint = ? WHERE id = ?').run('fp-changed', asset.id)

    const second = importSubtitleText(db, asset.id)
    expect(second.ok && second.value.reused).toBe(false)
  })

  it('解析不出任何字幕条目时仍然算已提取，只是文本为空', () => {
    const file = writeFile('空.srt', '这不是一份字幕')
    const asset = createAsset(db, directoryId, {
      fileName: '空.srt',
      path: file,
      ext: '.srt',
      kind: 'text',
    })

    const result = importSubtitleText(db, asset.id)

    expect(result.ok && result.value.empty).toBe(true)
    expect(result.ok && result.value.status).toBe('done')

    const row = db.prepare('SELECT extract_status FROM assets WHERE id = ?').get(asset.id) as {
      extract_status: string
    }
    // 「已提取、但没有内容」与「提取失败」是两件事：
    // 前者不需要重试，后者需要。状态必须能区分。
    expect(row.extract_status).toBe('done')
  })

  it('不是字幕类型时明确拒绝，并说明哪些格式可用', () => {
    const asset = createAsset(db, directoryId, { fileName: '视频.mp4', ext: '.mp4' })

    const result = importSubtitleText(db, asset.id)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('EXTRACTION_UNSUPPORTED_TYPE')
    expect(result.error.message).toContain('.ass')
  })

  it('素材不存在时返回 ASSET_NOT_FOUND', () => {
    const result = importSubtitleText(db, 9999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('读不到文件时标记失败并留下原因', () => {
    // 索引里有、磁盘上没了——这是真实会发生的情况（用户手工删了文件）。
    const asset = createAsset(db, directoryId, {
      fileName: '不在了.srt',
      path: path.join(workDir, '不在了.srt'),
      ext: '.srt',
      kind: 'text',
    })

    const result = importSubtitleText(db, asset.id)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_FAILED')

    const row = db
      .prepare('SELECT extract_status, extract_error FROM assets WHERE id = ?')
      .get(asset.id) as { extract_status: string; extract_error: string | null }

    expect(row.extract_status).toBe('failed')
    // 原因必须落库：用户看到「提取失败」后一定会问「为什么」
    expect(row.extract_error).toContain('无法读取')
  })

  it('失败会留下一条 extraction_runs 记录', () => {
    const asset = createAsset(db, directoryId, {
      fileName: '不在了.srt',
      path: path.join(workDir, '不在了.srt'),
      ext: '.srt',
      kind: 'text',
    })
    importSubtitleText(db, asset.id)

    const run = db
      .prepare('SELECT status, error_code FROM extraction_runs WHERE asset_id = ?')
      .get(asset.id) as { status: string; error_code: string } | undefined

    expect(run?.status).toBe('failed')
    expect(run?.error_code).toBe('EXTRACTION_FAILED')
  })

  it('过大的文件被拒绝而不是读进内存', () => {
    const asset = subtitleAsset('超大.srt', '.srt', { sizeBytes: 32 * 1024 * 1024 })

    const result = importSubtitleText(db, asset.id)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_FAILED')
  })

  it('GBK 编码的字幕不会变成乱码', () => {
    // 这是中文老字幕最常见的坑：按 UTF-8 读不乱码才怪，
    // 而且**不会报错**，用户只会看到一份读不懂的文本。
    const buffer = Buffer.concat([
      Buffer.from('1\r\n00:00:01,000 --> 00:00:04,000\r\n', 'utf8'),
      Buffer.from([0xbd, 0xf1, 0xcc, 0xec]), // GBK 的「今天」
      Buffer.from('\r\n', 'utf8'),
    ])
    const file = writeFile('gbk.srt', buffer)
    const asset = createAsset(db, directoryId, {
      fileName: 'gbk.srt',
      path: file,
      ext: '.srt',
      kind: 'text',
    })

    importSubtitleText(db, asset.id)

    expect(listSegments(db, asset.id).items[0]?.text).toBe('今天')
  })

  it('日文字幕照常导入 —— 直接解析不识别语言', () => {
    // 「仅中文」的限制只落在语音转写与 OCR 上。
    // 字幕文件的文字是现成的，读出来就行，与语言无关。
    const file = writeFile(
      'anime.ass',
      [
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(960,540)}おかえりなさい',
      ].join('\n'),
    )
    const asset = createAsset(db, directoryId, {
      fileName: 'anime.ass',
      path: file,
      ext: '.ass',
      kind: 'text',
    })

    const result = importSubtitleText(db, asset.id)

    expect(result.ok && result.value.segmentCount).toBe(1)
    expect(listSegments(db, asset.id).items[0]?.text).toBe('おかえりなさい')
  })

  it('删除素材会一并带走段落与全文索引', () => {
    const asset = subtitleAsset('探店.srt', '.srt')
    importSubtitleText(db, asset.id)
    const segmentId = listSegments(db, asset.id).items[0]?.id ?? 0

    db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id)

    expect(listSegments(db, asset.id).total).toBe(0)
    // 级联删除必须触发 FTS 的 AFTER DELETE 触发器，否则会留下
    // 指向不存在段落的幽灵条目——用户会看到点不开的搜索结果。
    expect(ftsRowIds(db, '火锅店')).not.toContain(segmentId)
  })
})

describe('按偏好转换字形后再落库', () => {
  const TRADITIONAL_SRT = [
    '1',
    '00:00:01,000 --> 00:00:04,000',
    '今天我們來探店這家火鍋店',
    '',
    '2',
    '00:00:05,000 --> 00:00:08,000',
    '招牌菜是毛肚和鴨腸',
    '',
  ].join('\r\n')

  function traditionalSubtitle(name = '繁体.srt') {
    const file = writeFile(name, TRADITIONAL_SRT)
    return createAsset(db, directoryId, {
      fileName: name,
      path: file,
      ext: '.srt',
      kind: 'text',
    })
  }

  it('默认把繁体字幕转成简体入库', () => {
    // 这是用户实际遇到的问题：网上下的字幕、以及 Whisper 的转写输出
    // 都默认是繁体，而检索按字符匹配——库里存繁体、用户搜简体就是零结果，
    // 而且**不报错**，用户只会以为「这个素材没提到过」。
    const asset = traditionalSubtitle()

    importSubtitleText(db, asset.id)

    const items = listSegments(db, asset.id).items
    expect(items[0]?.text).toBe('今天我们来探店这家火锅店')
    expect(items[1]?.text).toBe('招牌菜是毛肚和鸭肠')
  })

  it('转成简体后能用简体关键词搜到', () => {
    // 上一条断言的是文本，这一条断言的是**索引**。
    // 落库的文本与 FTS 里的内容由触发器同步，两处必须都是转换后的字——
    // 若只在读取时转换，库和索引仍是繁体，搜索照样搜不到。
    const asset = traditionalSubtitle()
    importSubtitleText(db, asset.id)

    const segmentId = listSegments(db, asset.id).items[0]?.id ?? 0
    expect(ftsRowIds(db, '火锅店')).toContain(segmentId)
    expect(ftsRowIds(db, '火鍋店')).not.toContain(segmentId)
  })

  it('偏好设为繁体时，简体字幕会被转成繁体入库', () => {
    // 反过来也要成立，而且起点得是**简体**字幕——
    // 用繁体字幕做夹具的话，「转成繁体」和「原样不动」的结果一模一样，
    // 这条测试就永远是绿的，测不出东西。
    updateSettings(db, { textScript: 'traditional' })
    const asset = subtitleAsset('简体.srt', '.srt')

    importSubtitleText(db, asset.id)

    const items = listSegments(db, asset.id).items
    expect(items[0]?.text).toBe('今天我們來探店這家火鍋店')
    expect(items[1]?.text).toBe('招牌菜是毛肚和鴨腸')
  })

  it('改了偏好后再导入会重新解析，而不是复用旧字形', () => {
    // 最隐蔽的坑：文本落库时就定了，缓存又只看「文件指纹 + 引擎版本」。
    // 引擎版本里若不带上字形，用户把偏好从简体改成繁体再点提取，
    // 只会命中旧缓存拿到简体——**设置改了却毫无反应**，还不报错。
    const asset = traditionalSubtitle()
    importSubtitleText(db, asset.id)
    expect(listSegments(db, asset.id).items[0]?.text).toBe('今天我们来探店这家火锅店')

    updateSettings(db, { textScript: 'traditional' })
    const second = importSubtitleText(db, asset.id)

    expect(second.ok && second.value.reused).toBe(false)
    expect(listSegments(db, asset.id).items[0]?.text).toBe('今天我們來探店這家火鍋店')
  })

  it('偏好没变时缓存照常命中', () => {
    // 上一条容易改过头——把所有情况都判成缓存失效，白跑一遍解析。
    // 这里钉住：只有偏好真的变了才失效。
    const asset = traditionalSubtitle()
    importSubtitleText(db, asset.id)

    const second = importSubtitleText(db, asset.id)
    expect(second.ok && second.value.reused).toBe(true)
  })

  it('字形偏好写进了 extraction_runs 的引擎版本', () => {
    // 缓存键是这个字段，所以它必须真的带上字形；
    // 只断言「重新解析了」的话，万一缓存判定被别的原因改坏，
    // 这条线索就丢了。
    const asset = traditionalSubtitle()
    updateSettings(db, { textScript: 'traditional' })
    importSubtitleText(db, asset.id)

    const run = db
      .prepare('SELECT engine_versions FROM extraction_runs WHERE asset_id = ?')
      .get(asset.id) as { engine_versions: string } | undefined

    expect(run?.engine_versions).toBe('subtitle-v1+traditional')
  })

  it('转换是幂等的，缩略字幕重复导入不会逐次漂移', () => {
    // 简→简、繁→繁都必须不变。否则每提取一次文字就变一点，
    // 用户会看到文本在自己的眼前慢慢变样。
    const asset = subtitleAsset('简体.srt', '.srt')
    importSubtitleText(db, asset.id)
    const first = listSegments(db, asset.id).items[0]?.text

    db.prepare('UPDATE assets SET fingerprint = ? WHERE id = ?').run('fp-changed', asset.id)
    importSubtitleText(db, asset.id)

    expect(listSegments(db, asset.id).items[0]?.text).toBe(first)
  })

  it('不转换非中文内容', () => {
    // 英文字幕里一个繁简字符都没有，转换器不该碰它。
    const file = writeFile(
      'en.srt',
      ['1', '00:00:01,000 --> 00:00:04,000', 'Welcome to my channel', ''].join('\r\n'),
    )
    const asset = createAsset(db, directoryId, {
      fileName: 'en.srt',
      path: file,
      ext: '.srt',
      kind: 'text',
    })

    importSubtitleText(db, asset.id)

    expect(listSegments(db, asset.id).items[0]?.text).toBe('Welcome to my channel')
  })
})

describe('段落读取', () => {
  it('分页参数生效', () => {
    const asset = subtitleAsset('探店.srt', '.srt')
    importSubtitleText(db, asset.id)

    const page = listSegments(db, asset.id, { limit: 1, offset: 1 })
    expect(page.total).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.text).toBe('招牌菜是毛肚和鸭肠')
  })
})
