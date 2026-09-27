/**
 * 字幕文件解析（任务 5.14）。
 *
 * 字幕文件是「文字已经现成」的素材：内容本就是纯文本，只是包了一层
 * 时间轴与样式标记。**对它跑 OCR/ASR 是既慢又差的重复劳动**——识别结果
 * 不可能比原文件更准，还要多下载几十 MB 模型。所以这批文件走直接解析，
 * 不需要任何识别引擎（design.md 决策 12）。
 *
 * 本模块是**纯函数**：不读文件、不碰数据库、不认识 Asset。
 * 编码嗅探与落库在 `importer.ts`，那里才接触 IO。
 *
 * 关于语言：本模块**不关心**字幕是中文、日文还是英文。直接解析不「识别」
 * 任何东西，只是把文件里已有的字读出来——所以日文字幕照常可用。
 * 「仅中文」的限制只落在语音转写与 OCR 上。
 */

/** 走「直接解析」而非识别引擎的字幕扩展名 */
export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'] as const

export function isSubtitleExtension(ext: string): boolean {
  return (SUBTITLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

/** 一条字幕。时间可能缺失（极少数变体没有时间轴），故为可空。 */
export interface SubtitleCue {
  text: string
  startMs: number | null
  endMs: number | null
}

/**
 * SRT 与 VTT 的时间轴：`00:00:01,000 --> 00:00:04,000`。
 *
 * 毫秒分隔符同时接受 `,`（SRT 规范）和 `.`（VTT 规范，以及大量实际写成
 * 点号的 SRT）。这不是「宽容」，是这两类文件在真实世界里本就混用。
 * 小时位允许 1–3 位：VTT 规范是 2 位，但手写文件里常见 1 位。
 */
const CUE_TIME =
  /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/

/**
 * ASS/SSA 的时间轴：`0:00:01.00`（末位是**厘秒**，不是毫秒）。
 * 用 `[,.]` 是因为部分工具导出时写成逗号。
 */
const ASS_TIME = /(\d+):(\d{2}):(\d{2})[.,](\d{1,2})/

/** `00:00:01,500` 这样的分量折算成毫秒；末位不足三位时按左对齐补齐。 */
function toMs(hours: string, minutes: string, seconds: string, fraction: string): number {
  // `,5` 是 500ms 不是 5ms：小数位是左对齐的。
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3))
  return (
    Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + millis
  )
}

/** ASS 的厘秒：`0:00:01.50` → 1500ms */
function assToMs(hours: string, minutes: string, seconds: string, centis: string): number {
  const ms = Number(centis.padEnd(2, '0').slice(0, 2)) * 10
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + ms
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

/**
 * 洗掉字幕里的**标记**，只留给人看的文字。
 *
 * 顺序要紧：先处理矢量绘图，再剥 `{}` 标签。反过来的话，
 * `{\p1}m 0 0 l 100 0{\p0}` 这种绘图指令会留下一串坐标数字混进正文。
 */
function cleanCueText(raw: string): string {
  return raw
    // ASS 矢量绘图：{\p1} 开始、{\p0} 结束，中间是坐标而不是文字。
    // 动漫字幕的标题字、歌词特效大量使用，不处理会污染检索结果。
    .replace(/\{\\p[1-9]\d*\}([\s\S]*?)(?=\{\\p0\}|$)/g, '')
    // ASS 覆盖标签：{\pos(..)} {\an8} {\k20} {\c&H..&} 等等，一律丢弃
    .replace(/\{[^}]*\}/g, '')
    // ASS 硬换行 \N、软换行 \n、不换行空格 \h
    .replace(/\\[Nnh]/g, ' ')
    // VTT 内联标签：<v Speaker> <i> <c.class> <00:00:01.000>
    .replace(/<[^>]*>/g, '')
    // 实体
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    // 字幕里的换行只是排版折行，不是语义分段，压成一行让检索片段更好读
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * SRT / VTT 的通用解析：以「时间轴行」为一条字幕的起点。
 *
 * 刻意**不用「空行分块」**做主轴。块解析在两种常见情形下会出错：
 * 字幕正文里含空行、以及两条字幕之间漏了空行。以时间轴行为锚点，
 * 这两种情况都能正确切分。
 */
function parseTimedCues(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let startMs: number | null = null
  let endMs: number | null = null
  /** 当前这条字幕已经收集到的正文行 */
  let pending: string[] = []
  /** 是否处在一条字幕之内。时间轴之前的一切都不是正文。 */
  let inCue = false

  const flush = (): void => {
    // 丢掉末尾的「下一条字幕的序号」。当两条字幕之间**漏了空行**时，
    // SRT 的序号行会落进上一条的正文里，检索片段就多出一个莫名其妙的数字。
    // 保留至少一行，免得把「整条字幕只有一个数字」也清空。
    const last = pending[pending.length - 1]
    if (pending.length > 1 && last !== undefined && /^\d+$/.test(last.trim())) {
      pending.pop()
    }

    const text = cleanCueText(pending.join('\n'))
    if (text !== '') cues.push({ text, startMs, endMs })

    pending = []
    startMs = null
    endMs = null
    inCue = false
  }

  for (const line of content.split(/\r?\n/)) {
    // VTT 的 NOTE / STYLE / REGION 块不是字幕，且可能跨多行
    if (/^\s*(NOTE|STYLE|REGION)\b/.test(line)) {
      flush()
      continue
    }

    const match = CUE_TIME.exec(line)
    if (match) {
      flush()
      startMs = toMs(match[1]!, match[2]!, match[3]!, match[4]!)
      endMs = toMs(match[5]!, match[6]!, match[7]!, match[8]!)
      inCue = true
      continue
    }

    // WEBVTT 头、SRT 序号行、VTT 的 cue 标识行都落在这里被丢掉：
    // 它们都在时间轴之前（或已被 flush 结束），而正文只在 inCue 期间收集。
    if (!inCue) continue

    if (line.trim() === '') {
      flush()
      continue
    }
    pending.push(line)
  }
  flush()

  return cues
}

/**
 * ASS / SSA 解析。
 *
 * 关键点：**以 `[Events]` 段的 `Format:` 行决定 `Text` 是第几个字段**，
 * 而不是硬编码「第 10 个」。Format 行就是这个格式的自描述，
 * 硬编码在遇到非标准导出的字幕时会静默错位。
 *
 * 取 Text 时也**不能把整行按逗号全切开再取最后一段**——对白里本身
 * 就可能含逗号（「今天，我们来探店」），那样会把对白切碎。
 * 正确做法是按字段数切，让最后一个字段吃掉剩余全部内容。
 */
function parseAssCues(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let inEvents = false

  // 标准 ASS 的列序。`[Events]` 段的 Format 行会覆盖它——那一行才是权威。
  let textIndex = 9
  let startIndex = 1
  let endIndex = 2

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      inEvents = section[1]!.trim().toLowerCase() === 'events'
      continue
    }
    if (!inEvents) continue

    const format = /^Format\s*:\s*(.+)$/i.exec(line)
    if (format) {
      const columns = format[1]!.split(',').map((c) => c.trim().toLowerCase())
      const text = columns.indexOf('text')
      const start = columns.indexOf('start')
      const end = columns.indexOf('end')
      if (text >= 0) textIndex = text
      if (start >= 0) startIndex = start
      if (end >= 0) endIndex = end
      continue
    }

    const dialogue = /^Dialogue\s*:\s*(.*)$/i.exec(line)
    if (!dialogue) continue

    // 按字段数切分，最后一个字段吃掉剩余内容（对白里可能有逗号）
    const fields = dialogue[1]!.split(',')
    const text = fields.slice(textIndex).join(',')

    const start = ASS_TIME.exec(fields[startIndex] ?? '')
    const end = ASS_TIME.exec(fields[endIndex] ?? '')

    const cleaned = cleanCueText(text)
    if (cleaned === '') continue

    cues.push({
      text: cleaned,
      startMs: start ? assToMs(start[1]!, start[2]!, start[3]!, start[4]!) : null,
      endMs: end ? assToMs(end[1]!, end[2]!, end[3]!, end[4]!) : null,
    })
  }

  return cues
}

/**
 * 把字幕文件的字节解成文本。
 *
 * 这件事必须做对，因为**中文字幕的编码在真实世界里是分裂的**：
 * 字幕组生态里 UTF-8 与 GBK/GB18030 都大量存在，早年尤其偏 GBK。
 * 直接按 UTF-8 读会把整份字幕变成乱码，而且**不会报错**——
 * 用户只会看到一份看不懂的文本，然后以为程序坏了。
 *
 * 判定顺序：BOM 优先（最可靠）→ 严格 UTF-8 解码 → 落到 GBK。
 * 用 `fatal: true` 而不是检查替换字符：后者会把「恰好含有 U+FFFD 的
 * 合法 UTF-8 文本」误判成 GBK。
 */
export function decodeSubtitleText(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    // 不是合法 UTF-8。中文老字幕最可能是 GBK，而它是 Node 内置支持的编码。
    try {
      return new TextDecoder('gbk').decode(buffer)
    } catch {
      // 运行环境没带这张编码表时，退回带替换字符的 UTF-8：
      // 至少让其余部分可读，好过整份文件读不出来。
      return buffer.toString('utf8')
    }
  }
}

/**
 * 按扩展名把字幕文件解析成有序字幕条目。
 *
 * **解析不出任何条目时返回空数组，而不是报错。** 这与 spec 里
 * 「字幕文件不含有效字幕条目 → 已提取、文本为空、给出提示」一致：
 * 一个空文件和一个格式损坏的文件，对用户来说是同一件事——里面没有可用的字。
 * 返回空数组让调用方走同一条既有路径，而不是多出一个只有这里会用的错误分支。
 */
export function parseSubtitle(content: string, ext: string): SubtitleCue[] {
  switch (ext.toLowerCase()) {
    case '.srt':
    case '.vtt':
      return parseTimedCues(content)
    case '.ass':
    case '.ssa':
      return parseAssCues(content)
    default:
      return []
  }
}
