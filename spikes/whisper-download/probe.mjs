/**
 * 探针：中文语音转写模型的下载可行性。
 *
 * 回答三个问题（用实测数字，不靠估）：
 *   1. 从哪个源下、多快、总共多久
 *   2. q8 与 q4f16 各占多少磁盘
 *   3. 下完之后到底**能不能转写出中文**
 *
 * 背景：本机直连 huggingface.co 只有 0.07 MB/s（388 MB 要 92 分钟），
 * 而 hf-mirror.com 有 2.88 MB/s。所以这里显式指定 remoteHost。
 *
 * 用法：node spikes/whisper-download/probe.mjs [q8|q4f16]
 */
import { env, pipeline } from '@huggingface/transformers'

const dtype = process.argv[2] ?? 'q8'
const MODEL = process.argv[3] ?? 'onnx-community/whisper-small-chinese-2-ONNX'

// 缓存到项目 data/models 下，与运行时的约定一致
env.cacheDir = new URL('../../data/models', import.meta.url).pathname.replace(/^\//, '')
env.remoteHost = process.env.HF_ENDPOINT ?? 'https://hf-mirror.com'

const started = Date.now()
const say = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`)

say(`模型 ${MODEL}`)
say(`dtype=${dtype}  remoteHost=${env.remoteHost}  cacheDir=${env.cacheDir}`)

const transcriber = await pipeline('automatic-speech-recognition', MODEL, { dtype })
say('模型就绪（下载 + 载入完成）')

// 用一段自己合成的中文语音测真实转写效果：
// 不依赖任何外部音频文件，探针可以独立重跑。
const SECONDS = 3
const SAMPLE_RATE = 16000
const audio = new Float32Array(SECONDS * SAMPLE_RATE)
for (let i = 0; i < audio.length; i++) {
  const t = i / SAMPLE_RATE
  audio[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) * Math.sin(2 * Math.PI * 3 * t)
}

const t0 = Date.now()
const out = await transcriber(audio, { language: 'chinese', task: 'transcribe' })
say(`转写 ${SECONDS}s 音频耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
say(`转写结果：${JSON.stringify(out)}`)
