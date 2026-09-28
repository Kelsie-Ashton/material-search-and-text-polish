import type { ExtractedSegment } from './persist.js'

/**
 * 纯文本文件的直接导入。
 *
 * `.txt` / `.md` / `.json` / `.csv` 这些文件**内容本身就是文字**，
 * 与字幕文件一样不需要任何识别引擎——读出来就行（design.md 决策 12）。
 * 它们与字幕的唯一区别是**没有时间轴**，所以段落的时间一律为 null，
 * 界面上也就不显示时间码。
 *
 * ## 编码与字幕共用一套判定
 *
 * 中文纯文本在真实世界里大量是 GBK（早年尤其如此），按 UTF-8 硬读会把
 * 整篇变成乱码，而且**不报错**——用户只会看到一份读不懂的文本，然后以为
 * 程序坏了。判定顺序（BOM → 严格 UTF-8 → GBK 兜底）已经在
 * `decodeSubtitleText` 里写过一遍，这里**不重复实现**，由调用方复用同一个
 * 函数。所以本模块与 `subtitle.ts` 一样是纯函数：收字符串，吐段落，
 * 不读文件、不碰数据库。
 *
 * ## 为什么按行切段，而不是整篇一段
 *
 * 检索结果是按段落展示的。整篇当成一段的话，用户命中之后界面上摊开的是
 * 整篇文章，还得自己去找词在哪个位置。按行切，命中的那一行就是片段本身——
 * 这也是 `.txt` 歌词、`.csv` 表格、逐行导出的 `.json` 最自然的切法。
 *
 * 代价要说清楚：**JSON 的语法符号会留在文本里**（`"text": "今天我们来探店",`
 * 会成为一个段落）。这是「按纯文本读」的必然结果，不是解析错误，词照样搜得到。
 * 要把 JSON 结构化解析（比如带时间轴的 Whisper 输出）是另一件事，
 * 不在当前版本内——那需要先确定认哪几种 JSON 方言。
 */

/** 可直接按纯文本读入的扩展名。与 config.ts 的 text 类扩展名保持一致。 */
export const PLAIN_TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.json', '.csv'] as const

export function isPlainTextExtension(ext: string): boolean {
  return (PLAIN_TEXT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

/**
 * 单个段落的长度上限（码点数）。
 *
 * 正常文本文件的行远达不到这个长度，它只为一种情况存在：**压成一行的文件**。
 * 压缩过的 JSON、被编辑器「合并为一行」的导出文件都可能整份只有一行，
 * 不切开的话会写出一个几十万字的段落——全文索引要为它建 trigram，
 * 而检索结果里也会摊开一整篇。
 *
 * 2000 这个数是个取舍：长到不会把正常的句子切断，短到一段撑不起索引。
 */
const MAX_SEGMENT_CHARS = 2000

/**
 * 在超长行里找一个尽量不破坏词的断点。
 *
 * 从窗口末尾往回找空白：`Hello world` 这类文本断在空格上，两个词都完整。
 * 找不到空白（中文连续文本、压缩过的 JSON）就只能硬切——
 * **这是会切断词的**，但没有更好的办法：不让它断，就得让整个文件变成一个
 * 段落。两害相权，硬切只影响「单行超过 2000 字」这种极端输入，
 * 而不断的话普通输入也会受影响。
 */
function splitLongLine(line: string): string[] {
  const chars = [...line]
  if (chars.length <= MAX_SEGMENT_CHARS) return [line]

  const chunks: string[] = []
  let start = 0
  while (start < chars.length) {
    let end = Math.min(start + MAX_SEGMENT_CHARS, chars.length)

    if (end < chars.length) {
      // 往回最多找 20% 的窗口，够容纳一个被切断的长词
      const floor = Math.max(start + 1, end - Math.floor(MAX_SEGMENT_CHARS * 0.2))
      for (let i = end; i > floor; i--) {
        if (/\s/.test(chars[i - 1] ?? '')) {
          end = i
          break
        }
      }
    }

    const chunk = chars.slice(start, end).join('').trim()
    if (chunk !== '') chunks.push(chunk)
    start = end
  }
  return chunks
}

/**
 * 把纯文本文件的内容切成段落。
 *
 * 空行直接丢掉：那是排版用的，收进索引只会多出一堆搜不出东西的空段落。
 * 每行去首尾空白——行首的缩进与行尾的 `\r`（CRLF）都不是内容。
 */
export function parsePlainText(content: string): ExtractedSegment[] {
  const segments: ExtractedSegment[] = []

  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    for (const chunk of splitLongLine(line)) {
      // 没有时间轴。null 而不是 0：0 会被界面显示成 00:00，
      // 让人以为这行文本出现在开头，而实际上我们根本不知道它在哪儿。
      segments.push({ text: chunk, startMs: null, endMs: null })
    }
  }

  return segments
}
