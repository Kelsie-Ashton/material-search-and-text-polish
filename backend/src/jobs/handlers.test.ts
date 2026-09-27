import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { Db } from '../db/index.js'
import type { AudioInput, TranscribeResult } from '../extraction/asr.js'
import { listSegments } from '../extraction/importer.js'
import type { MediaDeps } from '../extraction/media.js'
import { createAsset, createDirectory } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import { err, ok, type Result } from '../shared/result.js'
import { registerJobHandlers } from './handlers.js'
import { createJobQueue, type JobQueue } from './queue.js'

/**
 * 提取任务处理器的测试 —— **整条链路的端到端验证**（任务 5.4）。
 *
 * 这里跑的是真实的东西：真的队列、真的任务表、真的分派、真的落库。
 * 唯一被替换掉的是模型本身（238 MB，见 media.test.ts 的说明）。
 * 于是「入队 → 取出 → 分派 → 转写 → 落库 → 状态流转」这条链路
 * 每一次提交都被完整走一遍，而不是只测了其中一段就当作整条通了。
 */

const TRANSCRIPT: TranscribeResult = {
  text: '今天我們來探店這家火鍋店 招牌菜是毛肚和鴨腸',
  segments: [
    { text: '今天我們來探店這家火鍋店', startMs: 0, endMs: 3200 },
    { text: '招牌菜是毛肚和鴨腸', startMs: 3200, endMs: 6100 },
  ],
  durationMs: 9700,
  engine: 'test',
}

/** 转写桩的签名。写成具名类型是为了能断言调用参数，同时仍满足 MediaDeps */
type TranscribeFn = (
  audio: AudioInput,
  options: { engineLabel: string },
) => Promise<Result<TranscribeResult>>

let db: Db
let queue: JobQueue
let tempRoot: string
let workDir: string
let directoryId: number
let transcribe: Mock<TranscribeFn>

/** 默认桩：一个正常的有声视频，转写出两段带时间轴的文字 */
function stubMedia(overrides: Partial<MediaDeps> = {}): Partial<MediaDeps> {
  return {
    probe: vi.fn(async () => ({ durationMs: 9700, hasAudio: true, hasVideo: true })),
    extractAudio: vi.fn(async (_input: string, output: string): Promise<Result<void>> => {
      fs.writeFileSync(output, Buffer.alloc(64))
      return ok(undefined)
    }),
    readWav: vi.fn(() => ({ samples: new Float32Array(1600), sampleRate: 16_000, channels: 1 })),
    transcribe,
    ...overrides,
  }
}

/** 建一个素材记录，并在临时目录里落一个真实文件 */
function mediaAsset(name = '探店.mp4', kind = 'video', ext = '.mp4') {
  const file = path.join(tempRoot, name)
  fs.writeFileSync(file, 'not really a video')
  return createAsset(db, directoryId, { fileName: name, path: file, ext, kind })
}

beforeEach(() => {
  db = createTestDb()
  queue = createJobQueue(db)
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handlers-'))
  workDir = path.join(tempRoot, 'tmp')
  fs.mkdirSync(workDir)
  directoryId = createDirectory(db).id
  transcribe = vi.fn(async (): Promise<Result<TranscribeResult>> => ok(TRANSCRIPT))
})

afterEach(() => {
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

/** 起一条完整的链路：注册处理器 → 入队 → 等它跑完 */
async function runExtract(assetId: number, deps: Partial<MediaDeps> = stubMedia()) {
  registerJobHandlers(queue, db, { media: deps, workDir })
  const job = queue.enqueue('extract', assetId)
  expect(job.ok).toBe(true)
  await queue.whenIdle()
  return job.ok ? job.value.id : 0
}

describe('提取链路端到端', () => {
  it('从入队到可检索：每段文字都带着正确的起止时间落库', async () => {
    // 任务 5.4 的验收点。这也是唯一一条把"入队"和"每段文字的起止时间"
    // 放在一起验证的用例——两边各自测过，不代表接起来还对。
    const asset = mediaAsset()

    await runExtract(asset.id)

    const segments = listSegments(db, asset.id).items
    expect(segments).toHaveLength(2)
    expect(segments[0]?.text).toBe('今天我们来探店这家火锅店')
    expect(segments[0]?.startMs).toBe(0)
    expect(segments[0]?.endMs).toBe(3200)
    expect(segments[1]?.startMs).toBe(3200)
    expect(segments[1]?.endMs).toBe(6100)
  })

  it('任务以成功结束，并如实报出提取了多少段', async () => {
    const asset = mediaAsset()

    const jobId = await runExtract(asset.id)

    const job = queue.get(jobId)
    expect(job.ok).toBe(true)
    if (!job.ok) return
    expect(job.value.status).toBe('succeeded')
    expect(job.value.result).toMatchObject({ segmentCount: 2, empty: false, hasAudio: true })
  })

  it('素材状态流转到已提取', async () => {
    const asset = mediaAsset()

    await runExtract(asset.id)

    const row = db
      .prepare('SELECT extract_status, extract_error, duration_ms FROM assets WHERE id = ?')
      .get(asset.id) as { extract_status: string; extract_error: string | null; duration_ms: number | null }
    expect(row.extract_status).toBe('done')
    expect(row.extract_error).toBeNull()
    expect(row.duration_ms).toBe(9700)
  })

  it('提取出来的文字立刻能被搜到', async () => {
    // 「链路真的通了」的最终判据：不是段落躺在库里，而是**搜得到**。
    // 这同时验证了落库那一步的繁简转换与 FTS 触发器（转换若漏了，
    // 简体查询就命中不了繁体原文）。
    const asset = mediaAsset()

    await runExtract(asset.id)

    const hits = db
      .prepare('SELECT rowid FROM fts_segments WHERE fts_segments MATCH ?')
      .all('"火锅店"') as Array<{ rowid: number }>
    expect(hits.length).toBeGreaterThan(0)
  })

  it('无声视频：任务成功、文本为空，且说明原因是「没有音轨」', async () => {
    // 任务失败和「没东西可提取」是两件事。前者要重试，后者重试一万次
    // 也一样——把它做成失败，用户会一直点重试。
    const asset = mediaAsset('无声.mp4')
    const deps = stubMedia({
      probe: vi.fn(async () => ({ durationMs: 5000, hasAudio: false, hasVideo: true })),
    })

    const jobId = await runExtract(asset.id, deps)

    const job = queue.get(jobId)
    expect(job.ok && job.value.status).toBe('succeeded')
    expect(job.ok && job.value.result).toMatchObject({
      empty: true,
      hasAudio: false,
      message: expect.stringContaining('没有音轨') as unknown as string,
    })
    expect(listSegments(db, asset.id).total).toBe(0)
  })

  it('转写失败时任务标记失败，原因落库而不是只留在这次请求里', async () => {
    const asset = mediaAsset()
    const deps = stubMedia({
      transcribe: vi.fn(async () => err('EXTRACTION_FAILED', '语音模型加载失败：fetch failed')),
    })

    const jobId = await runExtract(asset.id, deps)

    const job = queue.get(jobId)
    expect(job.ok && job.value.status).toBe('failed')

    const row = db
      .prepare('SELECT extract_status, extract_error FROM assets WHERE id = ?')
      .get(asset.id) as { extract_status: string; extract_error: string | null }
    expect(row.extract_status).toBe('failed')
    // 刷新页面后这条原因不该消失——用户看到失败后一定会问为什么
    expect(row.extract_error).toContain('fetch failed')
  })

  it('图片不进转写：如实拒绝而不是硬跑一遍', async () => {
    // 分派错了会走到「没有音轨」那条路，把一个图片素材悄悄标成「已提取、
    // 文本为空」——用户会以为 OCR 跑过且什么都没认出来。
    const asset = mediaAsset('封面.png', 'image', '.png')

    const jobId = await runExtract(asset.id)

    const job = queue.get(jobId)
    expect(job.ok && job.value.status).toBe('failed')
    expect(job.ok && job.value.errorCode).toBe('EXTRACTION_UNSUPPORTED_TYPE')
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('字幕进了队列也照常解析，不会被当成「不是音频或视频」', async () => {
    // 路由那边字幕是同步走的，所以这条路径平时不会有人走。但「队列里的提取」
    // 与「路由里的提取」必须是同一套规矩，否则将来接入批量重提时，
    // 字幕会凭空多出一个它从未有过的失败方式。
    const file = path.join(tempRoot, '探店.srt')
    fs.writeFileSync(
      file,
      ['1', '00:00:01,000 --> 00:00:04,000', '今天我们来探店这家火锅店', ''].join('\r\n'),
    )
    const asset = createAsset(db, directoryId, {
      fileName: '探店.srt',
      path: file,
      ext: '.srt',
      kind: 'text',
    })

    const jobId = await runExtract(asset.id)

    const job = queue.get(jobId)
    expect(job.ok && job.value.status).toBe('succeeded')
    expect(listSegments(db, asset.id).items[0]?.text).toBe('今天我们来探店这家火锅店')
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('素材已被删除时给出可读的失败，而不是崩溃', async () => {
    registerJobHandlers(queue, db, { media: stubMedia(), workDir })
    const job = queue.enqueue('extract', 9999)
    await queue.whenIdle()

    expect(job.ok).toBe(true)
    const record = job.ok ? queue.get(job.value.id) : null
    expect(record?.ok && record.value.status).toBe('failed')
    expect(record?.ok && record.value.errorCode).toBe('ASSET_NOT_FOUND')
  })

  it('缺目标 id 的任务被拒绝，而不是去猜一个素材', async () => {
    registerJobHandlers(queue, db, { media: stubMedia(), workDir })
    const job = queue.enqueue('extract', null)
    await queue.whenIdle()

    expect(job.ok).toBe(true)
    const record = job.ok ? queue.get(job.value.id) : null
    expect(record?.ok && record.value.errorCode).toBe('VALIDATION_FAILED')
  })

  it('一次跑完后临时音轨被清掉', async () => {
    const asset = mediaAsset()

    await runExtract(asset.id)

    expect(fs.readdirSync(workDir)).toEqual([])
  })

  it('转写拿到的是 16 kHz 音频，且带上了引擎版本', async () => {
    // 采样率错了不会报错，只会让转写结果变成乱码——最难查的那类问题
    const asset = mediaAsset()
    let audio: AudioInput | null = null
    let engineLabel = ''
    const deps = stubMedia({
      transcribe: vi.fn(async (input: AudioInput, options: { engineLabel: string }) => {
        audio = input
        engineLabel = options.engineLabel
        return ok(TRANSCRIPT)
      }),
    })

    await runExtract(asset.id, deps)

    expect(audio).not.toBeNull()
    expect(audio!.sampleRate).toBe(16_000)
    expect(engineLabel).toContain('whisper:')
  })

  it('重跑同一个素材不会把段落越堆越多', async () => {
    // 替换而非追加。堆起来的话，检索里同一句话会出现两次。
    const asset = mediaAsset()
    await runExtract(asset.id)

    db.prepare('UPDATE assets SET fingerprint = ? WHERE id = ?').run('fp-changed', asset.id)
    await runExtract(asset.id)

    expect(listSegments(db, asset.id).total).toBe(2)
  })
})
