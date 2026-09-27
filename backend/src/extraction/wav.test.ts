import { describe, expect, it } from 'vitest'

import { WavFormatError, readWav } from './wav.js'

/**
 * WAV 读取的测试。
 *
 * 这是一段**只读自己生成的文件**的代码，所以它的风险不在"格式千奇百怪"，
 * 而在**文件被写坏**：磁盘写满、进程被杀、导出中断。
 * 关键断言因此都围绕「宁可明确报错，不要静默给出长度对不上的采样数组」——
 * 后者会喂给模型产生一份**看起来很正常的错乱转写**，比直接失败难查得多。
 */

/** 造一个 WAV。可插入额外的块，用来模拟 ffmpeg 写入的 LIST/INFO 元数据 */
function buildWav(
  samples: number[],
  options: { sampleRate?: number; bits?: number; channels?: number; extraChunk?: Buffer } = {},
): Buffer {
  const { sampleRate = 16000, bits = 16, channels = 1, extraChunk } = options
  const bytesPerSample = bits / 8
  const data = Buffer.alloc(samples.length * bytesPerSample)
  samples.forEach((s, i) => {
    // 夹到 int16 范围内：writeInt16LE 对 32768 会直接抛 ERR_OUT_OF_RANGE，
    // 而 [1] 这种"正好等于 1"的取值是测试里很自然的写法。
    if (bits === 16) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32768))), i * 2)
    else data.writeInt8(Math.max(-128, Math.min(127, Math.round(s * 127))), i)
  })

  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 8)
  fmt.writeUInt16LE(channels * bytesPerSample, 12)
  fmt.writeUInt16LE(bits, 14)

  const chunks = [chunk('fmt ', fmt), ...(extraChunk ? [extraChunk] : []), chunk('data', data)]
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(body.length + 4, 4)
  header.write('WAVE', 8, 'ascii')
  return Buffer.concat([header, body])
}

function chunk(id: string, body: Buffer): Buffer {
  // RIFF 规定块长度为奇数时补一个填充字节
  const padding = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  const head = Buffer.alloc(8)
  head.write(id, 0, 'ascii')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body, padding])
}

describe('WAV 读取', () => {
  it('读出采样与采样率', () => {
    const wav = readWav(buildWav([0, 0.5, -0.5, 1]))

    expect(wav.sampleRate).toBe(16000)
    expect(wav.channels).toBe(1)
    expect(wav.samples).toHaveLength(4)
    expect(wav.samples[0]).toBeCloseTo(0, 5)
    expect(wav.samples[1]).toBeCloseTo(0.5, 3)
    expect(wav.samples[2]).toBeCloseTo(-0.5, 3)
  })

  it('最小值 -32768 不会越界到 -1.0 以外', () => {
    // 除以 32767 而不是 32768 的话，最小的 int16 会算出 -1.00003，
    // 落在模型期望的 [-1,1] 之外。这一条钉住那个细节。
    const wav = readWav(buildWav([-1]))

    expect(wav.samples[0]).toBe(-1)
    expect(wav.samples[0]).toBeGreaterThanOrEqual(-1)
  })

  it('fmt 与 data 之间有其他块也能读', () => {
    // ffmpeg 会插入 LIST/INFO（含编码器、创建时间等）。
    // 硬编码偏移的写法在这里会读到垃圾数据。
    const extra = chunk('LIST', Buffer.from('INFOIART\x04\x00\x00\x00test', 'binary'))
    const wav = readWav(buildWav([0.25, 0.25], { extraChunk: extra }))

    expect(wav.samples).toHaveLength(2)
    expect(wav.samples[0]).toBeCloseTo(0.25, 3)
  })

  it('data 块被截断时用已有的部分，不报错', () => {
    // 导出中断在最后一个块上是最常见的情形。少听一点还能转写，
    // 直接失败则让整条链路白跑。
    const full = buildWav([0.5, 0.5, 0.5, 0.5])
    const truncated = full.subarray(0, full.length - 4)

    const wav = readWav(truncated)
    expect(wav.samples.length).toBeGreaterThan(0)
    expect(wav.samples.length).toBeLessThan(4)
  })

  it('fmt 块被截断时明确报错', () => {
    // 这条与上一条相反：fmt 不全就不知道采样率与位深，
    // 硬猜出来的采样率会让整段音频音调错乱且不报错。
    const full = buildWav([0.5])
    const fmtEnd = 12 + 8 + 16
    const truncated = full.subarray(0, 12 + 8 + 8) // 只留 fmt 的前 8 字节
    expect(fmtEnd).toBeGreaterThan(truncated.length)

    expect(() => readWav(truncated)).toThrow(WavFormatError)
  })

  it('不是 16 位 PCM 时明确报错', () => {
    // 8 位与 32 位浮点的解码方式完全不同，按 16 位硬读会得到噪声。
    expect(() => readWav(buildWav([0.5], { bits: 8 }))).toThrow(/16 位/)
  })

  it('不是 WAV 的文件明确报错', () => {
    expect(() => readWav(Buffer.from('这不是音频，只是一段文字'))).toThrow(WavFormatError)
    expect(() => readWav(Buffer.alloc(4))).toThrow(/太短/)
  })
})
