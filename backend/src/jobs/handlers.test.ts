import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { Db } from '../db/index.js'
import type { AudioInput, ModelDownloadProgress, TranscribeResult } from '../extraction/asr.js'
import { syncAssetExtractStatus, watchExtractJobs } from '../extraction/asset-status.js'
import { listSegments } from '../extraction/importer.js'
import type { MediaDeps } from '../extraction/media.js'
import { search } from '../search/index.js'
import { createAsset, createDirectory } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import { err, ok, type Result } from '../shared/result.js'
import { registerJobHandlers } from './handlers.js'
import { createJobQueue, type JobQueue } from './queue.js'

/**
 * 提取任务处理器的测试 —— **整条链路的端到端验证**（任务 5.4）。
 *
 * 这里跑的是真实的东西：真的队列、真的任务表、真的分派、真的落库。
 * 唯一被替换掉的是模型本身（241 MB，见 media.test.ts 的说明）。
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

/** 转写时传给引擎的选项。具名是为了让桩能直接标注参数类型 */
interface TranscribeOptions {
  engineLabel: string
  onModelProgress?: (progress: ModelDownloadProgress) => void
}

/** 转写桩的签名。写成具名类型是为了能断言调用参数，同时仍满足 MediaDeps */
type TranscribeFn = (
  audio: AudioInput,
  options: TranscribeOptions,
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

/**
 * 把队列接成生产里的样子：注册处理器 + 挂上素材状态同步。
 *
 * 两件事必须一起做。只注册处理器的话，素材状态就只剩 persist.ts 那一条路
 * 能改——而「取消」「类型不支持」「任务压根没跑起来」这些路径根本不经过
 * persist，它们的归位全靠落定回调。少挂一个，测试就会在一片绿里
 * 放过一个「素材永远停在提取中」的缺陷。
 */
function wire(deps: Partial<MediaDeps> = stubMedia()) {
  registerJobHandlers(queue, db, { media: deps, workDir })
  watchExtractJobs(queue, db)
}

/** 起一条完整的链路：接线 → 入队 → 等它跑完 */
async function runExtract(assetId: number, deps: Partial<MediaDeps> = stubMedia()) {
  wire(deps)
  const job = queue.enqueue('extract', assetId)
  expect(job.ok).toBe(true)
  await queue.whenIdle()
  return job.ok ? job.value.id : 0
}

/** 读一个素材的提取状态与失败原因 */
function assetRow(id: number) {
  return db.prepare('SELECT extract_status, extract_error FROM assets WHERE id = ?').get(id) as {
    extract_status: string
    extract_error: string | null
  }
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

/**
 * 串行与轮询——任务 5.7 的验收点。
 *
 * 「同时提交多个素材」是必然发生的用法：用户选中一批素材一起点提取。
 * 要验证的是两件事：它们**一个接一个**跑（不会两个转写同时抢 CPU），
 * 以及每个素材在跑的时候，界面都能轮询到**它自己**的那条进度。
 */
describe('模型下载引导与降级（任务 5.11）', () => {
  /**
   * 读最近一条 extract 任务的进度。
   *
   * 必须在**转写桩内部**调（此刻任务还是 running）。等 `whenIdle()` 之后再读
   * 拿到的是被终态覆盖后的值，而那正是这条用例要避开的：它验证的是
   * **下载过程中**用户看得见什么。
   */
  function runningProgress() {
    return db
      .prepare(
        `SELECT progress_current AS current, progress_total AS total, progress_message AS message
         FROM jobs WHERE type = 'extract' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { current: number; total: number; message: string | null }
  }

  it('首次下载模型时，界面上是「在下载」而不是一句不动的「正在转写」', async () => {
    // 这是 5.11 的核心。241 MB 的下载原本对外完全隐形：用户点了提取之后，
    // 界面上只有一句「正在转写语音」挂着一小时。他无从判断程序是在干活、
    // 还是在算、还是已经死了，于是多半会在中途关掉窗口——而**那次下载的成果
    // 一点都不会留下**，下次还得从头再来一遍。这是整条链路上最容易劝退人的地方。
    const seen: Array<{ current: number; total: number; message: string | null }> = []

    const asset = mediaAsset()
    await runExtract(
      asset.id,
      stubMedia({
        transcribe: vi.fn(async (_audio: AudioInput, options: TranscribeOptions) => {
          options.onModelProgress?.({
            phase: 'preparing',
            loaded: 0,
            total: 0,
            percent: null,
            file: '',
          })
          seen.push(runningProgress())

          options.onModelProgress?.({
            phase: 'downloading',
            loaded: 60_000_000,
            total: 241_000_000,
            percent: 25,
            file: 'model.onnx',
          })
          seen.push(runningProgress())

          return ok(TRANSCRIPT)
        }) as unknown as Mock<TranscribeFn>,
      }),
    )

    // 第一句：告诉用户「下载这件事开始了」，且总量未知时给不确定进度条，
    // 而不是一个假的 0%——0% 会让人以为一个字节都没动
    expect(seen[0]?.message).toContain('首次使用需下载语音模型')
    expect(seen[0]?.message).toContain('正在准备')
    expect(seen[0]?.total).toBe(0)

    // 第二句：进度条要动起来。下载是整条链路上**唯一**算得出「还剩多久」的一步，
    // 算得出来就该算出来
    expect(seen[1]?.message).toContain('首次使用需下载语音模型')
    expect(seen[1]?.message).toContain('已下载 57')
    expect(seen[1]?.message).toContain('241 MB')
    expect(seen[1]?.current).toBe(25)
    expect(seen[1]?.total).toBe(100)

    // 「只需一次」不能省：不说的话用户会以为每次提取都要重下 241 MB，
    // 于是直接放弃这个功能
    expect(seen[1]?.message).toContain('只需一次')
  })

  it('模型下载失败时：任务失败、原因里给出下一步，而检索不受影响', async () => {
    // 5.11 的验收点：「下载失败或断网时应用仍可启动并**仅提供元数据与文件名检索**」。
    // 前两件事这里验，后一件——模型没下来、检索照样按文件名命中——是重点。
    const asset = mediaAsset('深夜食堂探店.mp4')

    const jobId = await runExtract(
      asset.id,
      stubMedia({
        transcribe: vi.fn(async () =>
          err(
            'EXTRACTION_FAILED',
            '语音模型加载失败（首次使用需要联网下载约 241 MB，之后不再下载）：fetch failed\n' +
              '若怀疑是网络问题，可在 .env 里加一行 HF_ENDPOINT=https://hf-mirror.com 后重启再试。\n' +
              '字幕与纯文本的导入不依赖模型，不受影响。',
          ),
        ) as unknown as Mock<TranscribeFn>,
      }),
    )

    // 原因里必须写清**下一步怎么办**。只报一句英文 fetch failed，用户最容易
    // 得出的结论是「这软件坏了」，而真实原因多半只有一个：直连官方源不通。
    const job = queue.get(jobId)
    expect(job.ok && job.value.status).toBe('failed')
    expect(job.ok && job.value.errorMessage).toContain('hf-mirror.com')
    expect(assetRow(asset.id).extract_error).toContain('241 MB')

    // 关键：模型没下来，检索仍然工作，只是范围退到文件名与标签。
    // 这就是「降级」的全部含意——少一个功能，不是少一个能用的应用。
    const result = search(db, '探店')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.items.map((i) => i.asset.fileName)).toEqual(['深夜食堂探店.mp4'])
      // 正文一段都没有：那次转写根本没跑成，不该凭空多出内容来
      expect(result.value.items[0]?.matchedIn).toEqual(['file_name'])
    }
  })
})

describe('串行执行与进度轮询', () => {
  it('同时提交多个素材时按序执行，且各自轮询得到自己的进度', async () => {
    const names = ['一.mp4', '二.mp4', '三.mp4']
    const assets = names.map((name) => mediaAsset(name))

    const probed: string[] = []
    /** 每次转写时从任务表里读到的「界面此刻会看到的那一行」 */
    const observed: Array<{ targetId: number | null; message: string | null }> = []
    let inFlight = 0
    let maxInFlight = 0

    wire(
      stubMedia({
        probe: vi.fn(async (input: string) => {
          probed.push(path.basename(input))
          return { durationMs: 9700, hasAudio: true, hasVideo: true }
        }),
        transcribe: vi.fn(async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)

          // 这就是前端那一秒一次轮询拿到的内容。查「正在跑的那一条」而不是
          // 按 id 查，是因为串行保证此刻有且只有一条在跑——而这一条应当
          // 属于当前这个素材，进度文案也该是转写这一步。
          observed.push(
            db
              .prepare(
                "SELECT target_id AS targetId, progress_message AS message FROM jobs WHERE status = 'running'",
              )
              .get() as { targetId: number | null; message: string | null },
          )

          // 让出事件循环：真有并发的话，第二个转写会在这里挤进来
          await new Promise((resolve) => setTimeout(resolve, 1))
          inFlight -= 1
          return ok(TRANSCRIPT)
        }),
      }),
    )

    for (const asset of assets) queue.enqueue('extract', asset.id)
    await queue.whenIdle()

    // 按提交顺序，一个接一个
    expect(probed).toEqual(names)
    expect(maxInFlight).toBe(1)

    // 三条进度各自属于三个素材，谁也不串到谁身上
    expect(observed.map((entry) => entry.targetId)).toEqual(assets.map((asset) => asset.id))
    expect(observed.every((entry) => entry.message?.includes('转写'))).toBe(true)

    // 每个素材拿到的是自己的文本，没有互相覆盖
    for (const asset of assets) {
      expect(listSegments(db, asset.id).total).toBe(2)
    }
  })

  it('第一条炸掉之后，第二条照跑（任务 5.9 的缺口）', async () => {
    // **这是 5.9 一直缺的那条用例。** 它的验收点写着「单个素材失败不影响
    // 队列中其他素材」，而在此之前，这件事只由 `queue.ts` 里
    // `finish(job.id, 'failed')` 之后继续取下一条的实现保证——没有任何一条用例
    // 真的让一条任务在队列中间失败过。实现保证和测试保证是两回事：
    // 前者会在某次重构里悄悄消失，而且**消失时不会有任何东西变红**。
    //
    // 为什么这条值得单独测：串行队列是「一次只取一条」，所以失败处理写错
    // （异常逃逸出循环、失败的那条被反复重取、`whenIdle` 永远等不到头）
    // 的后果都不是「一条失败」，而是**后面全部卡死**。用户看到的是一整批
    // 素材再也没动静，而他会先去怀疑那些素材有问题。
    //
    // 用**抛异常**而不是返回 `err()` 来制造失败：`catch` 分支（queue.ts:261）
    // 是这条承诺真正的实现点，而它恰恰是最不容易被走到、也最容易被删掉的一段。
    const failing = mediaAsset('会失败的.mp4')
    const healthy = mediaAsset('正常的.mp4')

    wire()
    // 第一次调用炸掉（属于第一条任务），之后恢复——第二条必须拿到正常的引擎
    transcribe.mockImplementationOnce(async () => {
      throw new Error('转写引擎炸了')
    })

    const first = queue.enqueue('extract', failing.id)
    const second = queue.enqueue('extract', healthy.id)
    expect(first.ok && second.ok).toBe(true)

    await queue.whenIdle()

    // 第一条失败，且异常被接住、记成了可读的原因
    const firstJob = queue.get(first.ok ? first.value.id : 0)
    expect(firstJob.ok && firstJob.value.status).toBe('failed')
    expect(firstJob.ok && firstJob.value.errorMessage).toContain('转写引擎炸了')

    // 素材回到**未提取**，而不是「提取失败」。
    //
    // 这不是漏写：抛异常按本项目的约定是「不该发生的编程错误」，它不经过
    // persist.ts，也就没有留下 extraction_runs 记录；而 asset-status.ts:57
    // 明确把「没有运行记录」一律归为「未提取、随时可以再点一次」——
    // 与「被取消」「类型不支持」同一个归宿。
    //
    // 好处是它**不会留下一条假的失败记录**，用户重试即可，素材也不会卡在中间态。
    // 代价是此刻只有任务列表里有这条原因，素材那一行看不出来。这条取舍是有意
    // 写死的，所以在这里钉住它——哪天有人改了推导函数，这条会红。
    expect(assetRow(failing.id).extract_status).toBe('none')

    // 第二条**照常跑完**——这是整条用例的重点
    const secondJob = queue.get(second.ok ? second.value.id : 0)
    expect(secondJob.ok && secondJob.value.status).toBe('succeeded')
    expect(assetRow(healthy.id).extract_status).toBe('done')
    expect(listSegments(db, healthy.id).total).toBe(2)
  })
})

/**
 * 任务落定之后的素材状态归位。
 *
 * 这一组全部针对**不经过 persist.ts 的结束方式**：取消、类型不支持、
 * 素材已被删。persist 会在自己的事务里顺手把终态写上，所以这些路径
 * 恰恰是它管不到的——而它们又都会先把素材推到「提取中」，
 * 一旦没人负责收尾，素材就永远停在中间态，不报错、也不会自己好。
 */
describe('素材状态随任务落定归位', () => {
  /** 取某个素材当前活跃任务的 id。用于「任务已经跑起来、但入队函数还没返回」的场合。 */
  function activeJobId(assetId: number): number | undefined {
    return queue.list({ type: 'extract', targetId: assetId, activeOnly: true })[0]?.id
  }

  it('排队中被取消，素材回到未提取而不是卡在排队中', async () => {
    // 一条真正排在队里的任务：它前面那条把队列占住不放。串行队列下
    // 「第二个素材排着队」是最常见的状态，而对它的取消完全不经过处理器——
    // 队列必须是那个负责收尾的人。
    const first = mediaAsset('第一个.mp4')
    const second = mediaAsset('第二个.mp4')

    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    wire(
      stubMedia({
        transcribe: vi.fn(async () => {
          await gate
          return ok(TRANSCRIPT)
        }),
      }),
    )

    queue.enqueue('extract', first.id)
    const queued = queue.enqueue('extract', second.id)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return

    // 路由入队后会把素材推成「排队中」，这里照做，才能验证取消能把它拉回来
    expect(syncAssetExtractStatus(db, second.id)).toBe('pending')

    expect(queue.cancel(queued.value.id)).toMatchObject({
      ok: true,
      value: 'canceled-immediately',
    })
    expect(assetRow(second.id).extract_status).toBe('none')

    release()
    await queue.whenIdle()
  })

  it('跑到一半被取消，素材不会永远停在提取中', async () => {
    const asset = mediaAsset()

    // 在探测阶段点取消，正好落在「抽音轨之前」那个检查点上。
    // 不能靠 enqueue 的返回值拿任务 id——入队里的 kick 会同步把处理器推到
    // 第一个 await，等 enqueue 返回时任务早就跑起来了。
    wire(
      stubMedia({
        probe: vi.fn(async () => {
          const running = activeJobId(asset.id)
          if (running !== undefined) queue.cancel(running)
          return { durationMs: 9700, hasAudio: true, hasVideo: true }
        }),
      }),
    )

    const job = queue.enqueue('extract', asset.id)
    expect(job.ok).toBe(true)
    if (!job.ok) return
    await queue.whenIdle()

    const record = queue.get(job.value.id)
    expect(record.ok && record.value.status).toBe('canceled')
    // 中间态没人收尾的话，这里会是 'running' —— 没有任务在跑，界面却一直转圈
    expect(assetRow(asset.id).extract_status).toBe('none')
    // 取消是「当作没发生过」，不该留下需要用户分辨的失败原因
    expect(assetRow(asset.id).extract_error).toBeNull()
  })

  it('已有文本的素材重新提取时立刻显示「提取中」，而不是停在「已提取」', async () => {
    // 判据顺序的回归测试：推导状态必须**先看有没有活跃任务，再看上次的结果**。
    // 反过来的话，重提一个已提取过的素材时，界面在整个转写期间都显示「已提取」——
    // 用户点完按钮看不到任何变化，只会以为没生效，然后反复点。
    const asset = mediaAsset()
    await runExtract(asset.id)
    expect(assetRow(asset.id).extract_status).toBe('done')

    // 指纹变了才会真跑一遍；否则会命中缓存直接返回，压根没有「提取中」这一段
    db.prepare('UPDATE assets SET fingerprint = ? WHERE id = ?').run('fp-changed', asset.id)

    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // 再 wire 一次只是把处理器换成带闸门的那个；重复挂上的落定回调是幂等的
    wire(
      stubMedia({
        transcribe: vi.fn(async () => {
          await gate
          return ok(TRANSCRIPT)
        }),
      }),
    )

    const job = queue.enqueue('extract', asset.id)
    expect(job.ok).toBe(true)
    if (!job.ok) return

    // 排队中与运行中都算「提取中」，具体是哪个取决于 worker 是否已经取走它——
    // 两者对用户是同一件事。这里真正要钉死的是「不再是 done」。
    expect(['pending', 'running']).toContain(assetRow(asset.id).extract_status)

    release()
    await queue.whenIdle()
    expect(assetRow(asset.id).extract_status).toBe('done')
  })

  it('类型不支持的失败不把素材留在中间态，也不写运行记录', async () => {
    const asset = mediaAsset('封面.png', 'image', '.png')

    await runExtract(asset.id)

    // 失败原因在任务里（用户从任务列表能看到），素材本身则如实停在「未提取」：
    // 它确实一个字都没提取出来
    expect(assetRow(asset.id).extract_status).toBe('none')
    expect(assetRow(asset.id).extract_error).toBeNull()
  })
})
