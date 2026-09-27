import fs from 'node:fs'
import path from 'node:path'

import type { Db } from '../db/index.js'
import { findAsset } from '../library/assets.js'
import { err, ok, type Result } from '../shared/result.js'
import { readTextScript } from '../settings/preferences.js'
import { asrDtype, asrModel, dataDir } from '../config.js'
import { type AudioInput, transcribeAudio, type TranscribeResult } from './asr.js'
import { extractAudio, probeMedia, type MediaInfo } from './ffmpeg.js'
import {
  countSegments,
  engineLabel,
  findCachedRun,
  markFailed,
  persistSegments,
  readRunSource,
} from './persist.js'
import { type WavData, readWav } from './wav.js'

/**
 * 音频与视频的语音转写链路（任务 5.4）。
 *
 * 四个阶段：**探测 → 抽音轨 → 转写 → 落库**。前两个靠 ffmpeg（自带二进制），
 * 第三个靠本地 Whisper 模型（首次下载约 238 MB），第四个是纯数据库操作。
 *
 * ## 为什么依赖要能注入
 *
 * 「转写」这一步在测试里是**不可用**的：跑一次要下载 238 MB 模型，慢到
 * 无法进测试套件，而它又恰恰是这条链路里最需要被覆盖的部分——时间轴有没有
 * 落对、繁体有没有转、没有音轨的视频会不会被误判成失败。所以整条链路的每个
 * 外部动作都留了一个可替换的入口（`MediaDeps`），测试用桩替身把编排逻辑
 * 完整跑一遍，模型本身的行为则用一次性的人工验证确认。
 *
 * ## 为什么不在这里做字形转换
 *
 * 「往简还是往繁转」是用户偏好，而偏好是**落库时**才读的（persist.ts）。
 * 这一层产出的段落保持模型的原样输出，不对字形做任何判断。
 */

/** 提取文本的来源标记，与 schema 里 `asset_text_segments.source` 对应 */
const SOURCE = 'audio'

/**
 * 引擎版本的基础部分。**模型名与量化精度都要进来**：
 * 换了模型（或换了 q8/q4）后转写结果必然不同，缓存必须失效。
 * 字形偏好由 `engineLabel()` 拼在后面。
 */
function engineBase(): string {
  return `whisper:${asrModel}:${asrDtype}`
}

/**
 * 可替换的外部动作。默认全部用真实实现；测试只替换需要的那几个。
 *
 * 用「部分覆盖」而不是要求传全套：测试通常只关心其中一步，
 * 强制传全套会让每个用例都塞满与它无关的桩。
 */
export interface MediaDeps {
  probe: (input: string) => Promise<MediaInfo | null>
  extractAudio: (input: string, output: string) => Promise<Result<void>>
  readWav: (buffer: Buffer) => WavData
  transcribe: (audio: AudioInput, options: { engineLabel: string }) => Promise<Result<TranscribeResult>>
}

const REAL_DEPS: MediaDeps = {
  probe: probeMedia,
  extractAudio,
  readWav,
  transcribe: transcribeAudio,
}

export interface ExtractMediaResult {
  assetId: number
  status: 'done'
  segmentCount: number
  /** true 表示命中指纹缓存，本次没有重新转写 */
  reused: boolean
  /** 没有内容可提取（无音轨），或转写结果为空 */
  empty: boolean
  /** 没有音轨时为 false，界面据此给出「这个素材没有声音」而不是「提取失败」 */
  hasAudio: boolean
  durationMs: number | null
}

/**
 * 链路上可被观察的阶段。
 *
 * 分四段而不是只报「正在提取」：转写要几十分钟，一句不变的提示
 * 在用户看来和卡死没有区别。各段耗时差着两三个数量级——
 * 探测与落库是毫秒级，抽音轨是几十秒，转写是几十分钟——
 * 用户看到「正在转写」才知道现在不该关掉它。
 */
export type ExtractPhase = 'probing' | 'extracting-audio' | 'transcribing' | 'persisting'

export interface ExtractMediaOptions {
  deps?: Partial<MediaDeps>
  /**
   * 协作式取消。**只在转写开始前检查。**
   *
   * 转写一旦跑完就不再中断：那是整条链路里唯一不可重来的昂贵步骤
   * （几十分钟 CPU），为了一个状态标签把它丢掉是对用户不利的。
   * 所以取消的语义是「还没开始重活就停」，而不是「随时丢掉已算出的结果」。
   */
  isCancelled?: () => boolean
  /** 阶段变化回调。任务队列用它把进度写进 jobs 表，供界面轮询。 */
  onPhase?: (phase: ExtractPhase) => void
  /** 中间产物（WAV）的落盘位置。测试指向临时目录，避免污染真实的 data/tmp。 */
  workDir?: string
}

/** 素材类型是否走语音转写。图片走 OCR（任务 5.1/5.2），字幕走直接解析。 */
export function isMediaKind(kind: string): boolean {
  return kind === 'audio' || kind === 'video'
}

/**
 * 取消**不写 extraction_runs，也不改素材状态**。
 *
 * 这是刻意的：用户按取消的意思是「当作没发生过」，而不是「给我留下一条
 * 失败记录，让我之后还要分清楚哪条失败是我自己取消的」。
 * 素材停在「未提取」，随时可以重新点一次。
 */
function cancelled(assetId: number): Result<never> {
  return err('EXTRACTION_CANCELLED', '已取消提取', { id: assetId })
}

export async function extractMediaText(
  db: Db,
  assetId: number,
  options: ExtractMediaOptions = {},
): Promise<Result<ExtractMediaResult>> {
  const asset = findAsset(db, assetId)
  if (!asset) return err('ASSET_NOT_FOUND', `素材不存在（id=${assetId}）`, { id: assetId })

  if (!isMediaKind(asset.kind)) {
    return err(
      'EXTRACTION_UNSUPPORTED_TYPE',
      `「${asset.ext}」不是音频或视频，语音转写不适用于它`,
      { ext: asset.ext, kind: asset.kind },
    )
  }

  const script = readTextScript(db)
  const label = engineLabel(engineBase(), script)

  // 缓存判定必须在任何实际动作之前——不然光是探测就已经白跑一趟 ffmpeg
  const cached = findCachedRun(db, asset, label)
  if (cached !== null) {
    const source = readRunSource(db, cached, SOURCE)
    return ok({
      assetId,
      status: 'done',
      segmentCount: source?.segmentCount ?? countSegments(db, assetId),
      reused: true,
      empty: (source?.segmentCount ?? 0) === 0,
      // 从上次的运行记录里读，而不是「有段落就说明有音轨」猜一个：
      // 没有音轨的视频也会留下一次成功的运行（来源状态 skipped），
      // 猜错会让界面把「这个素材没有声音」说成「转写没有结果」。
      hasAudio: source?.status !== 'skipped',
      durationMs: asset.durationMs,
    })
  }

  if (options.isCancelled?.() === true) {
    return cancelled(assetId)
  }

  const deps: MediaDeps = { ...REAL_DEPS, ...options.deps }

  // ---------- 探测：有没有音轨 ----------
  options.onPhase?.('probing')
  const info = await deps.probe(asset.path)
  if (info === null) {
    const message = '无法读取媒体信息，文件可能已损坏或格式不受支持'
    markFailed(db, asset, { label, source: SOURCE, code: 'EXTRACTION_FAILED', message })
    return err('EXTRACTION_FAILED', message, { id: assetId, path: asset.path })
  }

  if (!info.hasAudio) {
    // 「没有声音」不是失败：它不需要重试，界面也不该把它标成红色错误。
    // 素材照常标为「已提取」，只是文本为空（spec 5.8）。
    const segmentCount = persistSegments(db, asset, {
      source: SOURCE,
      label,
      script,
      segments: [],
      sourceSkippedReason: '该素材没有音轨',
      durationMs: info.durationMs,
    })
    return ok({
      assetId,
      status: 'done',
      segmentCount,
      reused: false,
      empty: true,
      hasAudio: false,
      durationMs: info.durationMs,
    })
  }

  if (options.isCancelled?.() === true) {
    return cancelled(assetId)
  }

  // ---------- 抽音轨 → 转写 → 落库 ----------
  // 中间产物落在 data/tmp 下（已被 .gitignore 覆盖），跑完无论成败都清掉。
  // 一次两小时的视频会导出上百 MB 的 WAV，留着不管会慢慢吃掉用户的磁盘。
  const workDir = options.workDir ?? path.join(dataDir, 'tmp')
  const wavPath = path.join(workDir, `extract-${assetId}-${Date.now()}.wav`)

  try {
    options.onPhase?.('extracting-audio')
    const audio = await deps.extractAudio(asset.path, wavPath)
    if (!audio.ok) {
      markFailed(db, asset, {
        label,
        source: SOURCE,
        code: audio.error.code,
        message: `导出音轨失败：${audio.error.message}`,
      })
      return audio
    }

    let wav: WavData
    try {
      wav = deps.readWav(fs.readFileSync(wavPath))
    } catch (cause) {
      const message = `读取导出的音轨失败：${cause instanceof Error ? cause.message : String(cause)}`
      markFailed(db, asset, { label, source: SOURCE, code: 'EXTRACTION_FAILED', message })
      return err('EXTRACTION_FAILED', message, { id: assetId })
    }

    // 转写开始前的最后一次检查。抽音轨本身也要花时间（长视频要几十秒），
    // 用户多半正是在进度条停在这一步时点的取消。此刻丢掉 WAV 只损失一次导出，
    // 而放过这一下，接下来几十分钟的转写就会照跑不误。
    if (options.isCancelled?.() === true) {
      return cancelled(assetId)
    }

    options.onPhase?.('transcribing')
    const transcription = await deps.transcribe(
      { samples: wav.samples, sampleRate: wav.sampleRate },
      { engineLabel: label },
    )
    if (!transcription.ok) {
      markFailed(db, asset, {
        label,
        source: SOURCE,
        code: transcription.error.code,
        message: transcription.error.message,
      })
      return transcription
    }

    const { segments } = transcription.value
    options.onPhase?.('persisting')
    const segmentCount = persistSegments(db, asset, {
      source: SOURCE,
      label,
      script,
      segments,
      // 时长优先用 WAV 算出来的：它是**实际送去转写的音频**的长度，
      // 与段落时间轴同一把尺子。容器头里的时长是另一把尺子，
      // 两者不一致时会让「点片段跳转」偏掉。
      durationMs: transcription.value.durationMs ?? info.durationMs,
    })

    return ok({
      assetId,
      status: 'done',
      segmentCount,
      reused: false,
      empty: segmentCount === 0,
      hasAudio: true,
      durationMs: transcription.value.durationMs ?? info.durationMs,
    })
  } finally {
    // 清理不能失败到把结果吞掉：文件删不掉（被杀毒软件占用、只读）是小事，
    // 让用户拿不到已经算好的转写结果是大事。
    try {
      fs.rmSync(wavPath, { force: true })
    } catch {
      // 忽略
    }
  }
}
