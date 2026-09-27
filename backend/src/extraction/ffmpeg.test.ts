import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ffmpegPath, parseMediaInfo, probeMedia } from './ffmpeg.js'

/**
 * ffmpeg 输出解析的测试。
 *
 * 上半部分是**真实捕获的 stderr 原文**（本机 ffmpeg-static 二进制实跑所得），
 * 不是照着"我以为的格式"编出来的字符串。这很关键：这个解析器的全部价值在于
 * 咬住一个外部工具的输出格式，而格式里的 `[0x1](und)`、`Stream #0:1` 这类细节
 * 恰恰是凭记忆写会写错的地方——写错了的测试只会证明解析器符合我的想象。
 *
 * 下半部分用真实二进制现造素材再探测一遍，覆盖"格式解析对了，但调用方式错了"
 * 这类只在端到端才暴露的问题（比如不带输出参数时 ffmpeg 必然非 0 退出，
 * 文件头只有走错误分支才拿得到）。
 */

/** 音频文件，只有一个音频流（本机实跑 `ffmpeg -i withaudio.wav` 的输出） */
const AUDIO_ONLY_STDERR = `[aist#0:0/pcm_s16le @ 0000027fad255180] Guessed Channel Layout: mono
Input #0, wav, from 'C:/Users/Xyun/AppData/Local/Temp/ffprobe-sample/withaudio.wav':
  Metadata:
    encoder         : Lavf60.16.100
  Duration: 00:00:02.00, bitrate: 256 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 16000 Hz, 1 channels, s16, 256 kb/s
At least one output file must be specified
`

/** 只有画面、没有声音的视频。这正是「无音轨」分支的真实输入 */
const VIDEO_ONLY_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:/Users/Xyun/AppData/Local/Temp/ffprobe-sample/novideoaudio.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf60.16.100
  Duration: 00:00:02.00, start: 0.000000, bitrate: 46 kb/s
  Stream #0:0[0x1](und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p(progressive), 320x240 [SAR 1:1 DAR 4:3], 42 kb/s, 10 fps, 10 tbr, 10240 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
      encoder         : Lavc60.31.102 libx264
At least one output file must be specified
`

/**
 * 画面在前、声音在后的常见排列。
 *
 * **这条用例是 `matchAll` 的守门人。** 若把实现写成「只看第一条流」，
 * 这里会得出 `hasAudio: false`——而这个视频明明有声音。后果不是报错，
 * 而是把一段有声视频当成「没有音轨，文本为空」悄悄跳过，
 * 用户永远不知道自己的视频其实可以转写。
 */
const VIDEO_AND_AUDIO_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:/Users/Xyun/AppData/Local/Temp/ffprobe-sample/both.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf60.16.100
  Duration: 00:00:02.00, start: 0.000000, bitrate: 102 kb/s
  Stream #0:0[0x1](und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p(progressive), 320x240 [SAR 1:1 DAR 4:3], 42 kb/s, 10 fps, 10 tbr, 10240 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
      encoder         : Lavc60.31.102 libx264
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 16000 Hz, mono, fltp, 50 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
      vendor_id       : [0][0][0][0]
At least one output file must be specified
`

describe('解析 ffmpeg 的流信息', () => {
  it('纯音频：有声音、没画面', () => {
    expect(parseMediaInfo(AUDIO_ONLY_STDERR)).toEqual({
      durationMs: 2000,
      hasAudio: true,
      hasVideo: false,
    })
  })

  it('纯画面：没声音、有画面', () => {
    // 「没有音轨」这个分支的全部依据。判错了用户会看到一条假失败。
    expect(parseMediaInfo(VIDEO_ONLY_STDERR)).toEqual({
      durationMs: 2000,
      hasAudio: false,
      hasVideo: true,
    })
  })

  it('画面在前声音在后时，两个都要认出来', () => {
    expect(parseMediaInfo(VIDEO_AND_AUDIO_STDERR)).toEqual({
      durationMs: 2000,
      hasAudio: true,
      hasVideo: true,
    })
  })

  it('读不懂的输出不报错，只如实说「什么都没读到」', () => {
    // probeMedia 靠这个结果判定「这不是媒体文件」。若这里抛异常，
    // 用户拖一个 .txt 进来会看到崩溃，而不是一句「格式不受支持」。
    expect(parseMediaInfo('随便一段文字，没有 ffmpeg 的输出')).toEqual({
      durationMs: null,
      hasAudio: false,
      hasVideo: false,
    })
  })

  it('空输入不炸', () => {
    expect(parseMediaInfo('')).toEqual({ durationMs: null, hasAudio: false, hasVideo: false })
  })
})

describe('解析时长', () => {
  const withDuration = (d: string) => `  Duration: ${d}, start: 0.000000, bitrate: 46 kb/s\n`

  it('秒与毫秒', () => {
    expect(parseMediaInfo(withDuration('00:00:09.70')).durationMs).toBe(9700)
  })

  it('小时与分钟都算进去', () => {
    // 两小时的素材算成 2 分 0 秒的话，详情页会显示一个荒谬的数字，
    // 而「点片段跳转」也会整体偏掉——错得安静且难查。
    expect(parseMediaInfo(withDuration('02:13:05.25')).durationMs).toBe(7_985_250)
  })

  it('小数位不足三位时按毫秒补齐，不是按百分秒', () => {
    // ffmpeg 有时打印 `.5`（一位）而不是 `.500`。直接 Number 会把 0.5 秒
    // 当成 5 毫秒——差 100 倍。
    expect(parseMediaInfo(withDuration('00:00:01.5')).durationMs).toBe(1500)
  })

  it('没有 Duration 行时是 null，不是 0', () => {
    // 0 会被当成「一个长度为零的素材」，而 null 表示「不知道」。
    // 下游据此决定要不要覆盖已存的时长，混淆二者会抹掉正确的值。
    const withoutDuration = VIDEO_ONLY_STDERR.split('\n')
      .filter((line) => !line.includes('Duration:'))
      .join('\n')

    // 只摘掉时长行，流信息都还在——这样断言的就是"缺时长"这一件事
    const info = parseMediaInfo(withoutDuration)
    expect(info.durationMs).toBeNull()
    expect(info.hasVideo).toBe(true)
  })
})

/**
 * 用真实二进制跑一遍。
 *
 * 素材在测试里现造（`lavfi` 合成），不往仓库里塞二进制夹具：
 * 夹具的格式会随 ffmpeg 版本变，而现造永远和当前安装的二进制匹配。
 */
const describeReal = ffmpegPath === null ? describe.skip : describe

describeReal('真实二进制', () => {
  let dir: string

  /** 用 ffmpeg 合成一个小素材 */
  async function synth(args: string[], output: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-y', ...args, output], {
        windowsHide: true,
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`合成素材失败（退出码 ${code}）：${stderr}`))
      })
    })
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-probe-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('有声视频：探测出时长、画面与声音', async () => {
    const file = path.join(dir, '有声音.mp4')
    await synth(
      ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest'],
      file,
    )

    const info = await probeMedia(file)

    expect(info).not.toBeNull()
    expect(info!.hasAudio).toBe(true)
    expect(info!.hasVideo).toBe(true)
    expect(info!.durationMs).toBeGreaterThan(0)
  })

  it('无声视频：探测得出来，且明确报告没有音轨', async () => {
    // 这条是整条链路的前提：探测必须**成功**并说「没有音轨」，
    // 而不是失败。否则 media.ts 会走 markFailed 分支，
    // 把一个正常的无声视频标成红色错误。
    const file = path.join(dir, '无声音.mp4')
    await synth(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1'], file)

    const info = await probeMedia(file)

    expect(info).not.toBeNull()
    expect(info!.hasAudio).toBe(false)
    expect(info!.hasVideo).toBe(true)
  })

  it('纯音频文件', async () => {
    const file = path.join(dir, '音频.wav')
    await synth(['-f', 'lavfi', '-i', 'sine=d=1'], file)

    const info = await probeMedia(file)

    expect(info!.hasAudio).toBe(true)
    expect(info!.hasVideo).toBe(false)
  })

  it('不是媒体文件时返回 null，而不是一个全是 false 的对象', async () => {
    // 二者的区别是有意义的：null 表示「这压根不是媒体，重试也没用」，
    // 而 hasAudio:false 表示「这是媒体，只是没有声音」。
    const file = path.join(dir, '笔记.txt')
    fs.writeFileSync(file, '这是一份纯文本，不是媒体文件。')

    expect(await probeMedia(file)).toBeNull()
  })

  it('文件不存在时也不抛异常', async () => {
    // 素材在扫描之后被用户从磁盘上删掉是完全正常的。这条路必须返回
    // 一个可处理的失败，而不是把异常抛到任务队列里。
    expect(await probeMedia(path.join(dir, '不存在.mp4'))).toBeNull()
  })
})
