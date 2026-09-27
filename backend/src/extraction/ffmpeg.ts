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
      // 同时也把完整 stderr 放进 details：`probeDurationMs` 靠非 0 退出
      // 这条路径拿文件头，它需要的是被摘掉的更早那几行。
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
 * 从 ffmpeg 的 stderr 里读时长。
 *
 * 不是为了省一次调用而"顺手解析"——`ffmpeg-static` **只带 ffmpeg，
 * 不带 ffprobe**，所以没有第二个选择。格式是稳定的：
 * `  Duration: 00:00:09.70, start: ...`
 */
const DURATION = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{1,3})/

export function parseDurationMs(stderr: string): number | null {
  const m = DURATION.exec(stderr)
  if (!m) return null
  const [, h, min, s, frac] = m
  return (
    Number(h) * 3_600_000 +
    Number(min) * 60_000 +
    Number(s) * 1_000 +
    Number(frac!.padEnd(3, '0').slice(0, 3))
  )
}

/** 读素材时长。失败返回 null——时长只用于展示与进度估算，不值得让整条链路失败。 */
export async function probeDurationMs(input: string): Promise<number | null> {
  // 故意不给输出参数：ffmpeg 会先打印文件头（含 Duration），随后因为
  // 「没有指定输出文件」以非 0 退出。**这正是想要的**——只读文件头，
  // 不去解码整条音轨。给个 -f null - 的话，两小时的视频就要解码两小时
  // 才能拿到一个本来在第一秒就知道的数字。
  const result = await run(['-hide_banner', '-i', input])
  if (result.ok) return parseDurationMs(result.value)
  // 非 0 退出是这条路径的常态，所以不能把 stderr 丢掉。
  return parseDurationMs(result.error.details?.['stderr'] as string | undefined ?? '')
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
