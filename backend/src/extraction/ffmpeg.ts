import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import ffmpegStatic from 'ffmpeg-static'

import { err, ok, type Result } from '../shared/result.js'

/**
 * ffmpeg 封装（任务 5.4 / 5.5 的前置）。
 *
 * **为什么直接 spawn 而不用 `fluent-ffmpeg`。** 那个包安装时就会打印
 * deprecated（已停止维护），而我们需要的只是「拼参数、跑命令、读 stderr」
 * 这一件事。为它引入一个不再维护的依赖，等于为三十行代码接手一个
 * 长期的升级包袱。直接 spawn 的所有行为都在这里，可读、可测、可控。
 *
 * **不落中间文件的调用方要注意**：这里的每个函数都会真的写磁盘。
 * 输出一律走调用方指定的临时路径，由调用方负责清理——本模块不删文件
 * （与其他模块一致：绝不碰用户的素材文件，中间产物也只由创建者清理）。
 */

/**
 * `ffmpeg-static` 在安装时下载对应平台的二进制。
 *
 * 这里为什么要绕一下：它是 CJS 包，`module.exports` **直接就是路径字符串**
 * （见它的 index.js），运行时 default 导入拿到的正是它；但它的 `.d.ts` 写的是
 * `export default`，在 NodeNext 下会被当成 CJS 命名空间，于是**类型与运行时
 * 对不上**。实测确认过运行时确实是 string。
 *
 * 所以显式收敛一次，而不是用一个 `as` 把类型断言压下去——顺便保留了判空：
 * 不支持的平台（它的 index.js 会返回 null）与裁剪过的安装都可能没有二进制。
 */
const ffmpegModule: unknown = ffmpegStatic

export const ffmpegPath: string | null = typeof ffmpegModule === 'string' ? ffmpegModule : null

export class FfmpegUnavailableError extends Error {
  constructor() {
    super('ffmpeg 不可用：ffmpeg-static 未提供当前平台的二进制')
    this.name = 'FfmpegUnavailableError'
  }
}

interface RunOptions {
  /** 超时（毫秒）。转写类任务可能跑很久，默认给足。 */
  timeoutMs?: number
}

/** 跑一次 ffmpeg，返回 stderr（ffmpeg 把几乎所有信息都写在这里）。 */
function run(args: string[], options: RunOptions = {}): Promise<Result<string>> {
  const { timeoutMs = 30 * 60 * 1000 } = options

  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve(err('EXTRACTION_FAILED', new FfmpegUnavailableError().message))
      return
    }

    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve(err('EXTRACTION_FAILED', `ffmpeg 执行超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)

    child.stderr.on('data', (chunk: Buffer) => {
      // 只留尾部：ffmpeg 在长任务上会刷出大量进度行
      stderr += chunk.toString()
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024)
    })

    child.on('error', (cause) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(err('EXTRACTION_FAILED', `无法启动 ffmpeg：${cause.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve(ok(stderr))
        return
      }
      // ffmpeg 的报错信息全在 stderr 末尾几行，摘出来给用户看。
      // 同时也把完整 stderr 放进 details：`probeMedia` 靠非 0 退出
      // 这条路径拿文件头（不带输出参数时 ffmpeg 必然非 0 退出），
      // 它需要的正是被摘掉的更早那几行。
      const tail = stderr.trim().split('\n').slice(-3).join(' ').trim()
      resolve(
        err('EXTRACTION_FAILED', `ffmpeg 退出码 ${code}${tail ? `：${tail}` : ''}`, {
          exitCode: code,
          stderr,
        }),
      )
    })
  })
}

/**
 * 从 ffmpeg 的 stderr 里读时长与流信息。
 *
 * 不是为了省一次调用而"顺手解析"——`ffmpeg-static` **只带 ffmpeg，
 * 不带 ffprobe**，所以没有第二个选择。格式是稳定的：
 *
 *     Duration: 00:00:09.70, start: 0.000000, bitrate: 46 kb/s
 *     Stream #0:0[0x1](und): Video: h264 (...), 320x240, 10 fps
 *     Stream #0:1(und): Audio: aac (LC), 44100 Hz, stereo, fltp
 *
 * 流的写法有若干变体（`#0:0`、`#0:0:1`、带 `[0x1]` 与 `(und)` 后缀），
 * 所以匹配写成宽松的：行首是 `Stream #`、中间随便、后面是 `: Audio:`。
 */
const DURATION = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{1,3})/

const STREAM_LINE = /^\s*Stream #\d+:\d+.*?:\s*(Audio|Video|Subtitle)\s*:/gm

export interface MediaInfo {
  durationMs: number | null
  hasAudio: boolean
  hasVideo: boolean
}

export function parseMediaInfo(stderr: string): MediaInfo {
  const m = DURATION.exec(stderr)
  const durationMs = m
    ? Number(m[1]) * 3_600_000 +
      Number(m[2]) * 60_000 +
      Number(m[3]) * 1_000 +
      Number(m[4]!.padEnd(3, '0').slice(0, 3))
    : null

  // 用 matchAll 而不是 test：一个文件可能有多条流，`hasAudio` 要看全部。
  // 只测第一条会漏掉「视频流在前、音频流在后」这个最常见的排列。
  let hasAudio = false
  let hasVideo = false
  for (const match of stderr.matchAll(STREAM_LINE)) {
    if (match[1] === 'Audio') hasAudio = true
    if (match[1] === 'Video') hasVideo = true
  }

  return { durationMs, hasAudio, hasVideo }
}

/**
 * 读素材的时长与流的构成。
 *
 * 只在文件头里读，不解码——给个 `-f null -` 的话，两小时的视频就要解码
 * 两小时，才能拿到一个本来在第一秒就知道的数字。
 *
 * **`hasAudio` 是这条链路的前提判断。** 没有音轨的视频去抽音轨，ffmpeg 会
 * 以非 0 退出。若把它当成「提取失败」，用户会看到一条本该是「这个视频没有
 * 声音，已提取、文本为空」的素材被标成红色错误，还得去重试一个永远不会
 * 成功的东西。先问一句「有没有音轨」，这件事就从"解析报错文本"变成了
 * 一个明确的分支。
 *
 * 探测本身失败（文件损坏、编码不支持）返回 null——此时调用方按失败处理，
 * 因为那确实需要重试。
 */
export async function probeMedia(input: string): Promise<MediaInfo | null> {
  // 故意不给输出参数：ffmpeg 会先打印文件头，随后因为「没有指定输出文件」
  // 以非 0 退出。**这正是想要的**——所以我们两条路径都要看。
  const result = await run(['-hide_banner', '-i', input])
  const stderr = result.ok
    ? result.value
    : ((result.error.details?.['stderr'] as string | undefined) ?? '')

  const info = parseMediaInfo(stderr)
  // 连时长和流一个都没解析出来，说明这压根不是媒体文件，
  // 而不是「一个没有音轨的媒体文件」。
  if (info.durationMs === null && !info.hasAudio && !info.hasVideo) return null
  return info
}

/**
 * 导出 16 kHz 单声道 WAV —— Whisper 的输入规格。
 *
 * 这三个参数都不是可选的优化：模型按 16 kHz 训练，采样率不对会得到
 * 音调错乱的音频，转写结果会整段崩掉且**不报错**。
 */
export async function extractAudio(input: string, output: string): Promise<Result<void>> {
  const result = await run([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vn', // 丢掉视频流
    '-acodec',
    'pcm_s16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    output,
  ])

  if (!result.ok) return result
  if (!fs.existsSync(output)) {
    return err('EXTRACTION_FAILED', '音频导出后文件不存在，可能是这个素材没有音轨')
  }
  return ok(undefined)
}

export interface FrameOptions {
  /** 抽帧间隔（秒）。默认 10 秒一张。 */
  intervalSeconds?: number
  /** 最多抽多少张。防止长视频抽出成千上万张图把 OCR 拖垮。 */
  maxFrames?: number
}

/**
 * 按固定间隔抽帧，供画面 OCR 使用。
 *
 * `-vf fps=1/N` 是「每 N 秒一帧」的简写。抽帧数量必须有上限：
 * 一个两小时的视频按 10 秒抽也有 720 张，逐张 OCR 会让用户以为程序卡死。
 */
export async function extractFrames(
  input: string,
  outputDir: string,
  options: FrameOptions = {},
): Promise<Result<string[]>> {
  const { intervalSeconds = 10, maxFrames = 60 } = options

  fs.mkdirSync(outputDir, { recursive: true })
  const pattern = path.join(outputDir, 'frame-%04d.jpg')

  const result = await run([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vf',
    `fps=1/${intervalSeconds},scale=1280:-2`, // 缩到 1280 宽：OCR 更快，精度基本不变
    '-frames:v',
    String(maxFrames),
    '-q:v',
    '3',
    pattern,
  ])

  if (!result.ok) return result

  const frames = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith('frame-') && f.endsWith('.jpg'))
    .sort()
    .map((f) => path.join(outputDir, f))

  return ok(frames)
}
