/**
 * 最小 WAV 读取（任务 5.4）。
 *
 * 只做一件事：把 ffmpeg 导出的 16 kHz 单声道 PCM WAV 变成浮点采样数组。
 * 刻意**不引入音频库**——我们只读自己刚用 ffmpeg 生成的文件，格式完全已知，
 * 而一个音频库要带上 mp3/flac/ogg 的解码器与一堆用不到的抽象。
 *
 * 但**不能假设文件一定合规**：ffmpeg 的参数由我们自己控制，可磁盘写满、
 * 进程被杀都可能在中间截断。所以这里逐块校验，宁可明确报错，
 * 也不要喂给模型一段长度对不上的数组——那样得到的是一份**看起来很正常的
 * 错乱转写**，比直接失败难查得多。
 */

export interface WavData {
  samples: Float32Array
  sampleRate: number
  channels: number
}

export class WavFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WavFormatError'
  }
}

export function readWav(buffer: Buffer): WavData {
  if (buffer.length < 12) throw new WavFormatError('文件太短，不是 WAV')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new WavFormatError('缺少 RIFF 标记')
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new WavFormatError('不是 WAVE 格式')

  // 按块遍历。**不能硬编码偏移**：ffmpeg 会在 fmt 与 data 之间插入
  // LIST/INFO 等元数据块，位置与长度都不固定。
  let offset = 12
  let format: { channels: number; sampleRate: number; bits: number } | null = null
  let data: Buffer | null = null

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8

    if (body + size > buffer.length) {
      // 最后一个块可能被截断（导出中断、磁盘写满）。
      // fmt 截断了就没法解——采样率与位深都不知道，硬猜会让整段音频音调错乱
      // 且**不报错**；data 截断了只是少听一点，收下已有的部分，转写照样能用。
      if (id === 'fmt ') throw new WavFormatError('fmt 块不完整，文件可能被截断')
      if (id === 'data') data = buffer.subarray(body)
      break
    }

    if (id === 'fmt ') {
      if (size < 16) throw new WavFormatError('fmt 块长度异常')
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size)
    }

    // 块长度为奇数时有一个填充字节，这是 RIFF 的规定
    offset = body + size + (size % 2)
  }

  if (!format) throw new WavFormatError('缺少 fmt 块')
  if (!data) throw new WavFormatError('缺少 data 块')
  if (format.bits !== 16) {
    throw new WavFormatError(`只支持 16 位 PCM，实际为 ${format.bits} 位`)
  }
  if (format.channels < 1) throw new WavFormatError('声道数异常')

  const total = Math.floor(data.length / 2)
  const samples = new Float32Array(total)
  for (let i = 0; i < total; i++) {
    // int16 → [-1, 1)。除以 32768 而不是 32767：后者会让 +1.0 越界。
    samples[i] = data.readInt16LE(i * 2) / 32768
  }

  return { samples, sampleRate: format.sampleRate, channels: format.channels }
}
