/**
 * 探针：用**真实中文语音**验证转写质量。
 *
 * 为什么不用正弦波：合成音里没有人声，模型只会产生幻觉，
 * 那样的"成功"什么都证明不了。这里读一段由 Windows 中文 TTS
 * 合成的语音，原文已知，可以直接比对。
 *
 * 用法：node spikes/whisper-download/transcribe.mjs <模型> <dtype> <wav路径> [已知原文]
 */
import fs from 'node:fs'

import { env, pipeline } from '@huggingface/transformers'

const [model, dtype, wavPath, expected] = process.argv.slice(2)

env.cacheDir = new URL('../../data/models', import.meta.url).pathname.replace(/^\//, '')
env.remoteHost = process.env.HF_ENDPOINT ?? 'https://hf-mirror.com'

/** 读 16 位 PCM 单声道 WAV 的采样数据。只支持 ffmpeg 导出的那种标准头。 */
function readWav(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件')
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, body + size)
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块')
  if (fmt.bits !== 16) throw new Error(`只支持 16 位 PCM，实际 ${fmt.bits} 位`)

  const samples = new Float32Array(data.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels }
}

const started = Date.now()
const say = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`)

say(`模型 ${model}  dtype=${dtype}`)
const transcriber = await pipeline('automatic-speech-recognition', model, { dtype })
say('模型就绪')

const { samples, sampleRate, channels } = readWav(wavPath)
say(`音频 ${(samples.length / sampleRate).toFixed(1)}s  ${sampleRate}Hz  ${channels} 声道`)
if (sampleRate !== 16000) say(`⚠ 采样率不是 16k，Whisper 期望 16k`)

const t0 = Date.now()
const out = await transcriber(samples, { language: 'chinese', task: 'transcribe' })
const secs = (Date.now() - t0) / 1000
const audioSecs = samples.length / sampleRate

say(`转写耗时 ${secs.toFixed(1)}s（音频 ${audioSecs.toFixed(1)}s，实时率 ${(audioSecs / secs).toFixed(1)}x）`)
console.log('\n实际输出：', out.text)
if (expected) console.log('期望原文：', expected)
