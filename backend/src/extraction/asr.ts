import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

import { asrDtype, asrModel, hfEndpoint, modelsDir } from '../config.js'
import { err, ok, type Result } from '../shared/result.js'

/**
 * 中文语音转写（任务 5.3 / 5.4）。
 *
 * 引擎是 Transformers.js（纯 WASM/ONNX，**不需要 Python、不需要编译工具链**），
 * 选型理由见 design.md 决策 2。
 *
 * 三件在真实环境里踩过的事，都在这里处理掉：
 *
 * 1. **模型源必须可配。** Transformers.js 默认从 huggingface.co 拉模型，
 *    而有些网络直连它极慢（本项目开发机实测 0.07 MB/s，388 MB 要 92 分钟）。
 *    它**不认 `HF_ENDPOINT` 环境变量**（v4.3.0 实测），所以这里显式赋给
 *    `env.remoteHost`。
 * 2. **输出是繁体。** 必须转换，且 `initial_prompt` 偏置无效——见 chinese.ts。
 *    但转换**不在本模块做**：往哪个方向转是用户偏好，这里拿不到也不该拿到。
 *    本模块只管「把模型输出解析成段落」，转换在落库那一刻统一发生（persist.ts）。
 * 3. **模型加载很慢（首次含下载），绝不能每个素材加载一次。** 这里做进程内
 *    单例，且**把并发加载合并成同一个 Promise**：用户连点两次或队列并发时，
 *    否则会同时加载两份模型，内存直接翻倍。
 */

/** 时间轴片段：与字幕解析产出的结构一致，落库时走同一条路径 */
export interface TranscriptSegment {
  text: string
  startMs: number | null
  endMs: number | null
}

export interface TranscribeResult {
  segments: TranscriptSegment[]
  /** 整段文本，便于调用方直接展示 */
  text: string
  /** 音频时长（毫秒），拿不到时为 null */
  durationMs: number | null
  /** 实际使用的模型，落库进 engine_versions 用 */
  engine: string
}

/**
 * 单例持有的两种状态。
 *
 * `loading` 存的是 Promise 而不是「加载中」的布尔量：并发的第二个调用者
 * 直接等同一个 Promise，而不是自己再加载一份。
 */
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null
let loaded: AutomaticSpeechRecognitionPipeline | null = null

/** 是否已经配置过远端与缓存目录。`env` 是全局单例，配一次就够。 */
let envConfigured = false

function configureEnv(): void {
  if (envConfigured) return
  env.remoteHost = hfEndpoint
  env.cacheDir = modelsDir
  envConfigured = true
}

/** 仅供测试：重置单例与配置标记 */
export function resetAsrForTest(): void {
  loading = null
  loaded = null
  envConfigured = false
}

/**
 * 取得（必要时加载）转写管线。
 *
 * 失败时**清掉缓存的 Promise**，否则一次网络故障会被永久记住，
 * 用户重试时拿到的是同一个已失败的 Promise，看起来像「重试没用」。
 */
export async function getTranscriber(): Promise<Result<AutomaticSpeechRecognitionPipeline>> {
  if (loaded) return ok(loaded)

  if (!loading) {
    configureEnv()
    loading = pipeline('automatic-speech-recognition', asrModel, { dtype: asrDtype as 'q8' })
      .then((p) => {
        loaded = p
        return p
      })
      .catch((cause: unknown) => {
        loading = null // 让下一次调用能真正重试
        throw cause
      })
  }

  try {
    return ok(await loading)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    // 首次使用要下模型，所以「加载失败」最常见的两种原因是网络与磁盘。
    // 提示里必须说清这一点，否则用户只会看到一句英文报错。
    return err(
      'EXTRACTION_FAILED',
      `语音模型加载失败（首次使用需要联网下载约 238 MB）：${message}`,
      { model: asrModel, endpoint: hfEndpoint },
    )
  }
}

/** 模型是否已就绪（未加载过则为 false，不代表不可用） */
export function isTranscriberReady(): boolean {
  return loaded !== null
}

/** 浮点采样数据 + 采样率，由调用方从 WAV 读出 */
export interface AudioInput {
  samples: Float32Array
  sampleRate: number
}

/**
 * 转写一段音频。
 *
 * `return_timestamps: true` 让 Whisper 同时给出每段文字的起止时间——
 * 这正是 spec 要求的「每段文字附带正确的起止时间」，也是「点开片段
 * 跳到对应画面」这个后续功能的基础。
 *
 * `chunk_length_s` / `stride_length_s` 处理长音频：Whisper 的窗口是 30 秒，
 * 不切块直接喂长音频会截断或报错。stride 留 5 秒重叠，避免在切点
 * 处把一个词劈成两半。
 */
export async function transcribeAudio(
  audio: AudioInput,
  options: { engineLabel: string },
): Promise<Result<TranscribeResult>> {
  if (audio.samples.length === 0) {
    // 空音频不是错误：视频没有音轨是常见情况，交给调用方走「已提取、文本为空」
    return ok({ segments: [], text: '', durationMs: null, engine: options.engineLabel })
  }

  const transcriber = await getTranscriber()
  if (!transcriber.ok) return transcriber

  const durationMs =
    audio.sampleRate > 0 ? Math.round((audio.samples.length / audio.sampleRate) * 1000) : null

  try {
    const output = await transcriber.value(audio.samples, {
      language: 'chinese',
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    })

    const segments = toSegments(output)
    return ok({
      segments,
      text: segments.map((s) => s.text).join(' '),
      durationMs,
      engine: options.engineLabel,
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return err('EXTRACTION_FAILED', `语音转写失败：${message}`, { model: asrModel })
  }
}

/**
 * 把 Transformers.js 的输出整理成我们的段落结构。
 *
 * 它的返回类型在有无 chunks 时不同，且 `timestamp` 可能是 `[null, null]`，
 * 所以这里逐字段防御——**不要相信模型一定给得出时间**。
 *
 * **本函数不做繁简转换。** 它一度在这里调 `toSimplified`，现在不了：
 * 字形是**用户偏好**（设置页可选简或繁），而这里拿不到偏好，也不该拿到。
 * 转换统一发生在落库那一刻（persist.ts）——那是唯一的写入点。
 * 留在这里的后果是双向的：用户选繁体时，这里先转简、落库再转繁，
 * 一次多余的往返；而简↔繁并非逐字可逆，还可能改坏原文。
 *
 * 导出是为了能直接测：跑通它不需要下载 238 MB 的模型，
 * 而把模型输出解析错（时间轴错位、空段落混进结果）恰恰是这里最容易出的问题。
 */
export function toSegments(output: unknown): TranscriptSegment[] {
  // 上游换返回结构（或干脆返回 null）时，宁可得到空结果也不要抛——
  // 抛出去会连这次提取里**已经转写好的其他来源**一起丢掉。
  if (typeof output !== 'object' || output === null) return []
  const result = output as { text?: unknown; chunks?: unknown }

  const chunks = Array.isArray(result.chunks) ? result.chunks : []
  if (chunks.length === 0) {
    // 短音频（不到一个窗口）可能只给 text 不给 chunks。
    // 这时不能返回空数组——那等于把用户的内容丢掉了。
    const text = asText(result.text).trim()
    return text === '' ? [] : [{ text, startMs: null, endMs: null }]
  }

  const segments: TranscriptSegment[] = []
  for (const raw of chunks) {
    if (typeof raw !== 'object' || raw === null) continue
    const chunk = raw as { text?: unknown; timestamp?: unknown }

    // 静音处模型经常吐出空串或纯空格。留着会让界面出现一排空行，
    // 检索片段也可能命中一个没有内容的段落。
    const text = asText(chunk.text).trim()
    if (text === '') continue

    // `timestamp` 可能是 [null, null]，也可能整个字段缺失。
    // 时间缺失**不能导致丢字**：文字才是用户要的，时间只是附加。
    const stamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : []
    segments.push({
      text,
      startMs: secondsToMs(stamp[0]),
      endMs: secondsToMs(stamp[1]),
    })
  }
  return segments
}

/** 只接受字符串，其余一律当空。模型偶尔会给出非字符串的 text。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function secondsToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null
}
