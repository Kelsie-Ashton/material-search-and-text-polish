import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '../db/index.js'
import { updateSettings } from '../settings/preferences.js'
import { createAsset, createDirectory, ftsRowIds } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import type { AudioInput } from './asr.js'
import { extractMediaText, isMediaKind, type MediaDeps } from './media.js'
import { listSegments } from './importer.js'
import { err, ok, type Result } from '../shared/result.js'

/**
 * 语音转写链路的测试。
 *
 * **跑这些用例不需要下载 238 MB 的模型，也不需要 ffmpeg。**
 * 整条链路的每个外部动作都能替换（`MediaDeps`），所以这里测的是**编排**：
 * 缓存判得对不对、时间轴有没有原样落库、没有音轨的视频会不会被误判成失败、
 * 失败有没有留下原因、临时文件有没有清掉。
 *
 * 模型本身转得准不准不在这里测——那要一次性的人工验证，放进每次都要跑的
 * 套件只会变成「换台机器就红，而红的不是我们的代码」。
 */

/** 真实 Whisper 出的就是繁体（见 chinese.ts 的实测记录），夹具照这个来。 */
const WHISPER_OUTPUT = {
  text: '今天我們來探店這家火鍋店 招牌菜是毛肚和鴨腸',
  segments: [
    { text: '今天我們來探店這家火鍋店', startMs: 0, endMs: 3200 },
    { text: '招牌菜是毛肚和鴨腸', startMs: 3200, endMs: 6100 },
  ],
  durationMs: 9700,
}

let db: Db
let tempRoot: string
/** 中间产物目录，与素材文件分开放——否则「临时文件清干净了没」根本断言不出来 */
let workDir: string
let directoryId: number

/** 记录调用情况的桩，用来断言「哪几步真的发生了」 */
interface Spy {
  probe: ReturnType<typeof vi.fn>
  extractAudio: ReturnType<typeof vi.fn>
  transcribe: ReturnType<typeof vi.fn>
  readWav: ReturnType<typeof vi.fn>
}

/**
 * 造一套桩依赖。
 *
 * 默认行为是「一个正常的视频」：有音轨、抽得出音频、转写出两段话。
 * 各用例只覆盖需要改的那一项。
 */
function makeDeps(overrides: Partial<MediaDeps> = {}): { deps: Partial<MediaDeps>; spy: Spy } {
  const spy: Spy = {
    probe: vi.fn(async () => ({ durationMs: 9700, hasAudio: true, hasVideo: true })),
    // 真的落一个 WAV 文件：readWav 是读文件，不落文件就测不出「读的是导出结果」
    extractAudio: vi.fn(async (_input: string, output: string): Promise<Result<void>> => {
      fs.writeFileSync(output, buildWav(16_000, 1))
      return ok(undefined)
    }),
    transcribe: vi.fn(async () => ok({ ...WHISPER_OUTPUT, engine: 'test' })),
    readWav: vi.fn((buffer: Buffer) => ({
      samples: new Float32Array(buffer.length / 2),
      sampleRate: 16_000,
      channels: 1,
    })),
  }

  return { deps: { ...spy, ...overrides } as Partial<MediaDeps>, spy }
}

/** 一个结构合法、时长约 1 秒的 16 位单声道 WAV */
function buildWav(sampleRate: number, seconds: number): Buffer {
  const samples = sampleRate * seconds
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // 单声道
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

/** 建一个素材记录并落一个真实文件（转写路径只读文件，内容无所谓） */
function mediaAsset(name = '探店.mp4', kind = 'video', ext = '.mp4') {
  const file = path.join(tempRoot, name)
  fs.writeFileSync(file, 'not really a video')
  return createAsset(db, directoryId, { fileName: name, path: file, ext, kind })
}

beforeEach(() => {
  db = createTestDb()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-extract-'))
  workDir = path.join(tempRoot, 'tmp')
  fs.mkdirSync(workDir)
  directoryId = createDirectory(db).id
})

afterEach(() => {
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('素材类型判定', () => {
  it('只有音频与视频走语音转写', () => {
    expect(isMediaKind('audio')).toBe(true)
    expect(isMediaKind('video')).toBe(true)
    // 图片走 OCR、字幕走直接解析，都不该落到这条链路上
    expect(isMediaKind('image')).toBe(false)
    expect(isMediaKind('text')).toBe(false)
  })
})

describe('转写链路', () => {
  it('每段文字都带上正确的起止时间', async () => {
    // 任务 5.4 的验收点。时间轴错了不会报错，只会让「点片段跳转」偏掉，
    // 用户要到用的时候才发现。
    const asset = mediaAsset()
    const { deps } = makeDeps()

    const result = await extractMediaText(db, asset.id, { deps, workDir })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.segmentCount).toBe(2)

    const items = listSegments(db, asset.id).items
    expect(items[0]?.startMs).toBe(0)
    expect(items[0]?.endMs).toBe(3200)
    expect(items[1]?.startMs).toBe(3200)
    expect(items[1]?.endMs).toBe(6100)
  })

  it('转写结果原文是繁体，入库时转成简体', async () => {
    // 落库才转——这一层不做字形判断（见 asr.test.ts 里的说明）。
    const asset = mediaAsset()
    const { deps } = makeDeps()

    await extractMediaText(db, asset.id, { deps, workDir })

    const items = listSegments(db, asset.id).items
    expect(items[0]?.text).toBe('今天我们来探店这家火锅店')
    expect(items[1]?.text).toBe('招牌菜是毛肚和鸭肠')
  })

  it('转成简体后能被简体关键词搜到，繁体搜不到', async () => {
    // 断言的是**索引**而不只是文本：落库的文本与 FTS 由触发器同步，
    // 只在读取时转换的话库和索引仍是繁体，搜索照样零结果。
    const asset = mediaAsset()
    const { deps } = makeDeps()

    await extractMediaText(db, asset.id, { deps, workDir })

    const segmentId = listSegments(db, asset.id).items[0]?.id ?? 0
    expect(ftsRowIds(db, '火锅店')).toContain(segmentId)
    expect(ftsRowIds(db, '火鍋店')).not.toContain(segmentId)
  })

  it('段落来源标为 audio，与字幕的 file 区分开', async () => {
    const asset = mediaAsset()
    const { deps } = makeDeps()

    await extractMediaText(db, asset.id, { deps, workDir })

    expect(listSegments(db, asset.id).items[0]?.source).toBe('audio')
  })

  it('偏好设为繁体时入库为繁体', async () => {
    updateSettings(db, { textScript: 'traditional' })
    const asset = mediaAsset()
    const { deps } = makeDeps()

    await extractMediaText(db, asset.id, { deps, workDir })

    expect(listSegments(db, asset.id).items[0]?.text).toBe('今天我們來探店這家火鍋店')
  })

  it('写回素材时长，详情页拿得到', async () => {
    const asset = mediaAsset()
    const { deps } = makeDeps()

    await extractMediaText(db, asset.id, { deps, workDir })

    const row = db.prepare('SELECT duration_ms FROM assets WHERE id = ?').get(asset.id) as {
      duration_ms: number | null
    }
    expect(row.duration_ms).toBe(9700)
  })

  it('素材状态变为已提取', async () => {
    const asset = mediaAsset()
    const { deps } = makeDeps()

    await extractMediaText(db, asset.id, { deps, workDir })

    const row = db
      .prepare('SELECT extract_status, extract_error, extracted_at FROM assets WHERE id = ?')
      .get(asset.id) as {
      extract_status: string
      extract_error: string | null
      extracted_at: number | null
    }
    expect(row.extract_status).toBe('done')
    expect(row.extract_error).toBeNull()
    expect(row.extracted_at).not.toBeNull()
  })

  it('引擎版本写进了运行记录，且带上模型与字形', async () => {
    // 缓存键就是这个字段。模型换了、字形改了，缓存都必须失效——
    // 少任何一项，用户改了设置重新提取会拿到旧结果而不报错。
    const asset = mediaAsset()
    const { deps } = makeDeps()

    await extractMediaText(db, asset.id, { deps, workDir })

    const run = db
      .prepare('SELECT engine_versions FROM extraction_runs WHERE asset_id = ?')
      .get(asset.id) as { engine_versions: string }

    expect(run.engine_versions).toContain('whisper:')
    expect(run.engine_versions).toContain('+simplified')
  })
})

describe('缓存', () => {
  it('文件没变时复用结果，不重新转写', async () => {
    // 转写是这个应用里最贵的一步（几十分钟 CPU），缓存命中必须真的省下来
    const asset = mediaAsset()
    const first = makeDeps()
    await extractMediaText(db, asset.id, { deps: first.deps, workDir })

    const second = makeDeps()
    const result = await extractMediaText(db, asset.id, { deps: second.deps, workDir })

    expect(result.ok && result.value.reused).toBe(true)
    expect(second.spy.transcribe).not.toHaveBeenCalled()
    // 连抽音轨都不该跑——否则每次点提取都要白等一次 ffmpeg
    expect(second.spy.extractAudio).not.toHaveBeenCalled()
  })

  it('文件变了就重新转写', async () => {
    const asset = mediaAsset()
    const first = makeDeps()
    await extractMediaText(db, asset.id, { deps: first.deps, workDir })

    db.prepare('UPDATE assets SET fingerprint = ? WHERE id = ?').run('fp-changed', asset.id)
    const second = makeDeps()
    const result = await extractMediaText(db, asset.id, { deps: second.deps, workDir })

    expect(result.ok && result.value.reused).toBe(false)
    expect(second.spy.transcribe).toHaveBeenCalledTimes(1)
  })

  it('改了字形偏好后重新提取，不被旧缓存挡住', async () => {
    const asset = mediaAsset()
    const first = makeDeps()
    await extractMediaText(db, asset.id, { deps: first.deps, workDir })

    updateSettings(db, { textScript: 'traditional' })
    const second = makeDeps()
    const result = await extractMediaText(db, asset.id, { deps: second.deps, workDir })

    expect(result.ok && result.value.reused).toBe(false)
    expect(listSegments(db, asset.id).items[0]?.text).toBe('今天我們來探店這家火鍋店')
  })

  it('重跑是替换而不是追加', async () => {
    const asset = mediaAsset()
    const first = makeDeps()
    await extractMediaText(db, asset.id, { deps: first.deps, workDir })

    db.prepare('UPDATE assets SET fingerprint = ? WHERE id = ?').run('fp-changed', asset.id)
    const second = makeDeps()
    await extractMediaText(db, asset.id, { deps: second.deps, workDir })

    expect(listSegments(db, asset.id).total).toBe(2)
  })
})

describe('没有音轨的视频', () => {
  it('算「已提取、文本为空」，不是失败', async () => {
    // 这条最容易做错：没有音轨时 ffmpeg 抽音轨会以非 0 退出，
    // 若把它当成失败，用户会看到一条本该只是「没内容」的素材被标红，
    // 还得去重试一个永远不会成功的东西。
    const asset = mediaAsset('无声.mp4')
    const { deps, spy } = makeDeps({
      probe: vi.fn(async () => ({ durationMs: 5000, hasAudio: false, hasVideo: true })),
    })

    const result = await extractMediaText(db, asset.id, { deps, workDir })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.hasAudio).toBe(false)
    expect(result.value.empty).toBe(true)
    expect(result.value.segmentCount).toBe(0)

    const row = db
      .prepare('SELECT extract_status, extract_error, duration_ms FROM assets WHERE id = ?')
      .get(asset.id) as { extract_status: string; extract_error: string | null; duration_ms: number | null }
    expect(row.extract_status).toBe('done')
    expect(row.extract_error).toBeNull()
    // 时长照旧记下来：没有声音不代表详情页不该显示它多长
    expect(row.duration_ms).toBe(5000)

    // 关键：不该白跑抽音轨与转写
    expect(spy.extractAudio).not.toHaveBeenCalled()
    expect(spy.transcribe).not.toHaveBeenCalled()
  })

  it('来源状态记为 skipped 并留下原因', async () => {
    const asset = mediaAsset('无声.mp4')
    const { deps } = makeDeps({
      probe: vi.fn(async () => ({ durationMs: 5000, hasAudio: false, hasVideo: true })),
    })

    await extractMediaText(db, asset.id, { deps, workDir })

    const row = db
      .prepare(
        `SELECT s.status, s.error_message FROM extraction_run_sources s
           JOIN extraction_runs r ON r.id = s.run_id
          WHERE r.asset_id = ? AND s.source = 'audio'`,
      )
      .get(asset.id) as { status: string; error_message: string | null } | undefined

    expect(row?.status).toBe('skipped')
    expect(row?.error_message).toContain('没有音轨')
  })

  it('缓存命中时仍如实回答「没有音轨」', async () => {
    // 光看「有没有段落」区分不出「没有音轨」与「有音轨但没转出字」，
    // 猜一个的话界面会把前者说成后者。
    const asset = mediaAsset('无声.mp4')
    const { deps } = makeDeps({
      probe: vi.fn(async () => ({ durationMs: 5000, hasAudio: false, hasVideo: true })),
    })
    await extractMediaText(db, asset.id, { deps, workDir })

    const second = await extractMediaText(db, asset.id, { deps: makeDeps().deps, workDir })

    expect(second.ok && second.value.reused).toBe(true)
    expect(second.ok && second.value.hasAudio).toBe(false)
    expect(second.ok && second.value.empty).toBe(true)
  })
})

describe('转写结果为空', () => {
  it('有音轨但一个字都没转出来时，仍是已提取、文本为空', async () => {
    const asset = mediaAsset()
    const { deps } = makeDeps({
      transcribe: vi.fn(async () => ok({ segments: [], text: '', durationMs: 3000, engine: 'test' })),
    })

    const result = await extractMediaText(db, asset.id, { deps, workDir })

    expect(result.ok && result.value.empty).toBe(true)
    expect(result.ok && result.value.hasAudio).toBe(true)
    expect(listSegments(db, asset.id).total).toBe(0)
  })
})

describe('失败路径', () => {
  it('媒体信息读不出来时标记失败并留下原因', async () => {
    const asset = mediaAsset('损坏.mp4')
    const { deps } = makeDeps({ probe: vi.fn(async () => null) })

    const result = await extractMediaText(db, asset.id, { deps, workDir })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_FAILED')

    const row = db
      .prepare('SELECT extract_status, extract_error FROM assets WHERE id = ?')
      .get(asset.id) as { extract_status: string; extract_error: string | null }
    expect(row.extract_status).toBe('failed')
    // 原因必须落库：用户看到失败后一定会问为什么，刷新页面那条原因不该消失
    expect(row.extract_error).toContain('损坏')
  })

  it('抽音轨失败时留下原因，且不落任何段落', async () => {
    const asset = mediaAsset()
    const { deps } = makeDeps({
      extractAudio: vi.fn(async () => err('EXTRACTION_FFMPEG_FAILED', 'ffmpeg 退出码 1')),
    })

    const result = await extractMediaText(db, asset.id, { deps, workDir })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_FFMPEG_FAILED')

    expect(listSegments(db, asset.id).total).toBe(0)
    const row = db.prepare('SELECT extract_error FROM assets WHERE id = ?').get(asset.id) as {
      extract_error: string | null
    }
    expect(row.extract_error).toContain('导出音轨失败')
  })

  it('模型加载失败时留下原因，并提示首次要下载', async () => {
    // 首次使用最常见的失败就是网络。提示里不写「要下载」，用户只会看到一句英文报错
    const asset = mediaAsset()
    const { deps } = makeDeps({
      transcribe: vi.fn(async () =>
        err('EXTRACTION_FAILED', '语音模型加载失败（首次使用需要联网下载约 238 MB）：fetch failed'),
      ),
    })

    const result = await extractMediaText(db, asset.id, { deps, workDir })

    expect(result.ok).toBe(false)
    const row = db.prepare('SELECT extract_error FROM assets WHERE id = ?').get(asset.id) as {
      extract_error: string | null
    }
    expect(row.extract_error).toContain('238 MB')
  })

  it('失败之后重试能成功，不会被上次的失败卡住', async () => {
    const asset = mediaAsset()
    const { deps } = makeDeps({ probe: vi.fn(async () => null) })
    await extractMediaText(db, asset.id, { deps, workDir })

    const retry = await extractMediaText(db, asset.id, { deps: makeDeps().deps, workDir })

    expect(retry.ok).toBe(true)
    const row = db
      .prepare('SELECT extract_status, extract_error FROM assets WHERE id = ?')
      .get(asset.id) as { extract_status: string; extract_error: string | null }
    expect(row.extract_status).toBe('done')
    expect(row.extract_error).toBeNull()
  })

  it('不存在的素材返回 ASSET_NOT_FOUND', async () => {
    const result = await extractMediaText(db, 9999, { deps: makeDeps().deps, workDir })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('图片不走语音转写', async () => {
    const asset = mediaAsset('图.png', 'image', '.png')

    const result = await extractMediaText(db, asset.id, { deps: makeDeps().deps, workDir })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_UNSUPPORTED_TYPE')
  })
})

describe('临时文件', () => {
  it('跑完清掉抽出来的音轨', async () => {
    // 一次两小时的视频会导出上百 MB 的 WAV。留着不管会慢慢吃掉用户的磁盘，
    // 而用户不会知道该去哪里找这些文件。
    const asset = mediaAsset()
    const { deps } = makeDeps()

    await extractMediaText(db, asset.id, { deps, workDir })

    expect(fs.readdirSync(workDir)).toEqual([])
  })

  it('失败时也清掉', async () => {
    const asset = mediaAsset()
    const { deps } = makeDeps({
      transcribe: vi.fn(async () => err('EXTRACTION_FAILED', '转写炸了')),
    })

    await extractMediaText(db, asset.id, { deps, workDir })

    expect(fs.readdirSync(workDir)).toEqual([])
  })

  it('读不出音频时的报错带上了系统原因', async () => {
    const asset = mediaAsset()
    const { deps } = makeDeps({
      readWav: vi.fn(() => {
        throw new Error('缺少 data 块')
      }),
    })

    const result = await extractMediaText(db, asset.id, { deps, workDir })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('缺少 data 块')
  })
})

describe('取消', () => {
  it('转写开始前取消，不碰数据库', async () => {
    const asset = mediaAsset()
    const { deps, spy } = makeDeps()

    const result = await extractMediaText(db, asset.id, {
      deps,
      workDir,
      isCancelled: () => true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_CANCELLED')

    // 用户按取消的意思是「当作没发生过」，而不是留一条失败记录让他之后去分辨
    expect(spy.transcribe).not.toHaveBeenCalled()
    const row = db
      .prepare('SELECT extract_status, extract_error FROM assets WHERE id = ?')
      .get(asset.id) as { extract_status: string; extract_error: string | null }
    expect(row.extract_status).toBe('none')
    expect(row.extract_error).toBeNull()
    expect(listSegments(db, asset.id).total).toBe(0)
  })

  it('抽音轨之后、转写之前取消，同样不碰数据库', async () => {
    // 真实的取消点在这里：用户在进度条上等了几秒才点的取消，
    // 那时音频已经导好了，但最贵的转写还没开始。
    const asset = mediaAsset()
    let cancelled = false
    const { deps, spy } = makeDeps({
      extractAudio: vi.fn(async (_input: string, output: string): Promise<Result<void>> => {
        fs.writeFileSync(output, buildWav(16_000, 1))
        cancelled = true // 抽完音轨这一刻用户点了取消
        return ok(undefined)
      }),
    })

    const result = await extractMediaText(db, asset.id, {
      deps,
      workDir,
      isCancelled: () => cancelled,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_CANCELLED')
    expect(spy.transcribe).not.toHaveBeenCalled()
    expect(fs.readdirSync(workDir)).toEqual([])

    // 与上一条同样要求「当作没发生过」。这次的取消发生在已经抽完音轨之后，
    // 是最容易顺手记一条失败记录的地方——辛苦了半程，留个痕看起来更「完整」，
    // 但用户要的是干净重来。
    const row = db
      .prepare('SELECT extract_status, extract_error FROM assets WHERE id = ?')
      .get(asset.id) as { extract_status: string; extract_error: string | null }
    expect(row.extract_status).toBe('none')
    expect(row.extract_error).toBeNull()
    expect(listSegments(db, asset.id).total).toBe(0)
  })
})

describe('调用顺序', () => {
  it('探测在最前，转写在抽音轨之后', async () => {
    // 顺序错了会白跑：先抽音轨再发现没有音轨，等于白白解码一遍整条音轨。
    const asset = mediaAsset()
    const order: string[] = []
    const { deps } = makeDeps({
      probe: vi.fn(async () => {
        order.push('probe')
        return { durationMs: 9700, hasAudio: true, hasVideo: true }
      }),
      extractAudio: vi.fn(async (_input: string, output: string): Promise<Result<void>> => {
        order.push('extractAudio')
        fs.writeFileSync(output, buildWav(16_000, 1))
        return ok(undefined)
      }),
      transcribe: vi.fn(async () => {
        order.push('transcribe')
        return ok({ ...WHISPER_OUTPUT, engine: 'test' })
      }),
    })

    await extractMediaText(db, asset.id, { deps, workDir })

    expect(order).toEqual(['probe', 'extractAudio', 'transcribe'])
  })

  it('把抽出来的音频按 16 kHz 交给转写', async () => {
    // 采样率错会让转写整段崩掉，而且**不报错**——只是结果变成一堆乱码
    const asset = mediaAsset()
    let received: AudioInput | null = null
    const { deps } = makeDeps({
      transcribe: vi.fn(async (audio: AudioInput) => {
        received = audio
        return ok({ ...WHISPER_OUTPUT, engine: 'test' })
      }),
    })

    await extractMediaText(db, asset.id, { deps, workDir })

    expect(received).not.toBeNull()
    expect(received!.sampleRate).toBe(16_000)
    expect(received!.samples.length).toBeGreaterThan(0)
  })
})
