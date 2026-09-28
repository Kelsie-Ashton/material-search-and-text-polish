import { apiGet, apiPost } from './client'
import type { AssetDetail, ExtractStatus } from './library'

/**
 * 文字提取的接口封装。
 *
 * 后端按「要花多久」分成两条路径，**返回形状也不一样**：
 * 字幕是毫秒级的解析，同步给结果；音视频要跑语音模型，只给任务 id。
 * 响应里的 `mode` 就是这个分派结果，前端照它分支，不要靠
 * 「有没有 jobId 字段」去猜——猜法在形状变动时会静默认错。
 */

interface Envelope<T> {
  ok: true
  value: T
}

async function unwrap<T>(promise: Promise<unknown>): Promise<T> {
  const payload = (await promise) as Envelope<T>
  return payload.value
}

/** 对应 backend/src/extraction/importer.ts 的 ImportTextResult */
export interface ImportedExtraction {
  mode: 'imported'
  assetId: number
  status: 'done'
  /** 解析出的段落数。为 0 也是「已提取」，只是没有内容 */
  segmentCount: number
  /** true 表示命中指纹缓存，本次没有重新解析 */
  reused: boolean
  empty: boolean
}

/** 对应 backend/src/routes/extraction.ts 里入队那条路径的响应 */
export interface QueuedExtraction {
  mode: 'queued'
  jobId: number
  status: ExtractStatus
}

export type StartExtractionResult = ImportedExtraction | QueuedExtraction

/**
 * 发起提取。音视频只返回任务 id，进度要去 `api/jobs.ts` 轮询。
 *
 * 不可提取的类型（图片）会抛 `ApiRequestError`，`code` 为 `NOT_IMPLEMENTED`，
 * `message` 是一句能直接展示给用户的中文说明。
 */
export function startExtraction(assetId: number): Promise<StartExtractionResult> {
  return unwrap<StartExtractionResult>(apiPost(`/api/extraction/assets/${assetId}`))
}

/** 对应 backend/src/extraction/importer.ts 的 TextSegment */
export interface TextSegment {
  id: number
  /** 来源标记：`file` = 字幕解析，后续还会有 `asr` / `ocr` */
  source: string
  ordinal: number
  text: string
  startMs: number | null
  endMs: number | null
}

export interface ListSegmentsResult {
  items: TextSegment[]
  total: number
}

export function listSegments(
  assetId: number,
  options: { limit?: number; offset?: number } = {},
): Promise<ListSegmentsResult> {
  const search = new URLSearchParams()
  if (options.limit !== undefined) search.set('limit', String(options.limit))
  if (options.offset !== undefined) search.set('offset', String(options.offset))
  const qs = search.toString()
  const path = `/api/extraction/assets/${assetId}/segments`

  return unwrap<ListSegmentsResult>(apiGet(qs === '' ? path : `${path}?${qs}`))
}

/** 段落来源的中文名。未知来源如实回显，不要吞掉。 */
export const SOURCE_LABELS: Record<string, string> = {
  // 字幕与纯文本的 source 都是 `file`，所以这里不能写「字幕解析」——
  // 一份 .txt 歌词的段落会被标成字幕，用户会以为程序把它当字幕解析了。
  file: '文本解析',
  asr: '语音转写',
  ocr: '画面识别',
}

// ---------------------------------------------------------------- 能不能提取

export interface ExtractionPlan {
  /** 按钮文字 */
  label: string
  /** 现在能不能提取。false 时按钮禁用，并把 `hint` 显示出来 */
  available: boolean
  /** 给用户的一句话说明，`available` 为真时也可能有（比如提醒只转写语音） */
  hint: string
}

/**
 * 界面对「这条素材能不能提取、点了会发生什么」的判断。
 *
 * **这是展示层的判断，不是分派规则。** 真正的分派在
 * `backend/src/routes/extraction.ts`：本函数只决定按钮的文字与是否禁用，
 * 好让用户点之前就知道结果，而不是点完吃一个错误。
 *
 * 两处若哪天不一致，后果也仅仅是一句提示不准确——用户照样点得动，
 * 接口返回的消息照样会被显示出来。分派规则**只有后端那一份**。
 */
export function extractionPlan(asset: Pick<AssetDetail, 'kind' | 'ext'>): ExtractionPlan {
  if (asset.kind === 'video') {
    return {
      label: '提取语音文字',
      available: true,
      // 说清楚提取的是**声音**。画面上的字（尤其是番剧的硬字幕）要等 OCR，
      // 而 OCR 已按评估结论挂起——用户按「提取文字」却没拿到画面里的台词，
      // 不解释就会被当成程序漏了。
      hint: '提取的是视频里的语音。画面上的文字（硬字幕、漫画对白）需要图像识别，当前版本暂不提供。',
    }
  }

  if (asset.kind === 'audio') {
    return { label: '提取语音文字', available: true, hint: '把音频里的说话内容转写成带时间轴的文字。' }
  }

  if (asset.kind === 'image') {
    return {
      label: '识别图片文字',
      available: false,
      hint: '图片文字识别（OCR）需要本地识别引擎。当前版本暂不提供，已列入 README 的未来规划。',
    }
  }

  // 文本类素材都能直接读，不需要任何识别模型。两类只差有没有时间轴。
  if (SUBTITLE_EXTENSIONS.includes(asset.ext.toLowerCase())) {
    return {
      label: '导入字幕文字',
      available: true,
      hint: '字幕文件自带时间轴，直接解析即可，不需要任何识别模型。',
    }
  }

  if (PLAIN_TEXT_EXTENSIONS.includes(asset.ext.toLowerCase())) {
    return {
      label: '导入文本文字',
      available: true,
      hint: '按行读入、按行入库，没有时间轴。中文纯文本常见的 GBK 编码会自动识别。',
    }
  }

  return {
    label: '提取文字',
    available: false,
    hint: `「${asset.ext}」是文本文件，但目前还不能直接读进索引。`,
  }
}

/**
 * 这次导入读进来的是字幕还是文本，用来把提示语说准。
 *
 * 「已导入 12 段字幕文字」扣在一份 `.txt` 歌词上，用户会以为程序把它
 * 当字幕解析了——而歌词里确实一个字的时间轴都没有。
 */
export function importNoun(ext: string): string {
  return SUBTITLE_EXTENSIONS.includes(ext.toLowerCase()) ? '字幕' : '文本'
}

/**
 * 可直接解析的字幕扩展名、可直接读入的纯文本扩展名。
 *
 * 与 `backend/src/extraction/subtitle.ts`、`plaintext.ts` 各重复了一份。
 * 接受这份重复，是因为它们只用来决定**按钮上的字**：漏掉一个新格式的后果是
 * 「按钮写的是『提取文字』，点下去照样能导入」——难看，但不影响正确性。
 * 反过来，若要前端去问后端「这个扩展名算不算可直接导入」，就得多一个接口，
 * 而它回答的还是同一个问题。
 */
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa']
const PLAIN_TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.json', '.csv']

/** 时间轴显示：超过一小时才补上小时位，免得半小时的视频全是 `00:` 开头。 */
export function formatTimestamp(ms: number | null): string {
  if (ms === null) return ''
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
}
