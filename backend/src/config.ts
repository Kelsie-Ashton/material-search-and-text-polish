import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根目录（由 backend/src 上溯两级） */
export const projectRoot = path.resolve(here, '..', '..')

/**
 * 读入仓库根目录下的 `.env`（如果存在）。
 *
 * `.env.example` 里写着「复制本文件为 .env 后按需填写」，
 * 所以这句话必须成真——否则用户照做之后发现设置根本没生效，
 * 而且不会有任何报错，只会觉得"这个配置项坏了"。
 *
 * 用 Node 自带的 `process.loadEnvFile`，不引入 dotenv：
 * Node 20.6+ 已经内置了这件事。
 *
 * 两条刻意的行为：
 * - **文件不存在时静默跳过**（首次运行就是这种情况），
 *   而不是抛错——没有 .env 是完全正常的状态。
 * - **已存在的环境变量优先**。`PORT=5310 npm run dev` 必须能覆盖
 *   .env 里的值，否则临时改端口就只能去改文件，而文件又可能被提交。
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.join(projectRoot, '.env'))
  } catch {
    // 没有 .env 是正常的，不是错误。
  }
}

loadDotEnv()

/** 运行时数据目录 —— 整目录已被 .gitignore 忽略，API Key 与索引都落在这里 */
export const dataDir = process.env['DATA_DIR']
  ? path.resolve(process.env['DATA_DIR'])
  : path.join(projectRoot, 'data')

/** 凭证文件：唯一存放用户 API Key 的地方 */
export const credentialsFile = path.join(dataDir, 'credentials.json')

/** SQLite 索引数据库 */
export const databaseFile = path.join(dataDir, 'index.db')

/** OCR 语言包与语音转写模型的缓存目录 */
export const modelsDir = path.join(dataDir, 'models')

/** 前端构建产物目录（生产模式下由后端托管） */
export const frontendDistDir = path.join(projectRoot, 'frontend', 'dist')

export const port = Number(process.env['PORT'] ?? 5174)

/**
 * 模型下载源。
 *
 * **默认官方源，不硬编码镜像。** 官方源在大多数网络下是正常且最快的，
 * 把镜像写死会拖慢所有人、还把供应链信任交给第三方。
 *
 * 但有些网络确实直连不了——本项目开发机上实测 huggingface.co 只有
 * 0.07 MB/s（388 MB 要 92 分钟），而 hf-mirror.com 有 2.88 MB/s。
 * 那种环境下用 `HF_ENDPOINT=https://hf-mirror.com` 覆盖即可。
 *
 * 注意 Transformers.js **不认 `HF_ENDPOINT` 这个环境变量**
 * （v4.3.0 实测），所以这个名字是**我们自己定的**，读到之后由
 * `extraction/asr.ts` 显式赋给 `env.remoteHost`。取这个名字是为了
 * 与 HuggingFace 生态的惯例一致，用户不必记一个新名字。
 */
export const hfEndpoint = process.env['HF_ENDPOINT'] ?? 'https://huggingface.co'

/**
 * 中文语音转写模型。
 *
 * **不是规划里最初写的那个。** 原定的
 * `onnx-community/whisper-small-chinese-2-ONNX` 在 Transformers.js 4.3.0 上
 * 直接跑不通：它的 ONNX 图要求一个 `cache_position` 输入，而库不提供，
 * 报 `Missing the following inputs: cache_position`。实测换成
 * `Xenova/whisper-small` 后正常（见 design.md 决策 2 的修订记录）。
 *
 * 做成可配置是因为模型迭代很快，换一个不该改代码。
 */
export const asrModel = process.env['ASR_MODEL'] ?? 'Xenova/whisper-small'

/**
 * 量化精度。`q8` 是体积与质量的折中点：
 * whisper-small 的 q8 约 238 MB（encoder 88 + decoder_merged 150），
 * q4f16 约 191 MB 但精度更低。
 */
export const asrDtype = process.env['ASR_DTYPE'] ?? 'q8'

/**
 * OCR 语言包。**必须是 `chi_sim`**——写成 `zho` 会加载失败。
 * 本变更只做中文，多语言列入未来规划。
 */
export const ocrLanguages = ['chi_sim']

/**
 * 服务必须仅绑定回环地址。
 * 本服务能读取用户本机任意已授权目录，绝不能暴露到局域网。
 */
export const host = '127.0.0.1'

/**
 * 受支持的素材扩展名 → 素材大类。
 *
 * 这张表描述的是**文件类型**（怎么读这个文件），不是**题材**（内容讲什么）。
 * 「动漫 / 漫画 / 剧 / 游戏」这类题材**不得**出现在本表或任何代码常量里：
 * 题材是用户自己的词汇，边界因人而异且会不断长出新词（纪录片、综艺、Vlog、
 * 播客、访谈……），代码里穷举不完，列不全的枚举就是坏枚举。它已经有了正确
 * 的归宿——**标签**（见 `tags/service.ts`），由用户自建、参与检索、跨素材复用。
 *
 * 这里有一层结构性保证：`AssetKind` 由本表的键推导，想新增一个题材键，
 * 就必须为它编出一组描述**文件类型**的扩展名——编不出来，就说明它不属于这里。
 */
export const SUPPORTED_EXTENSIONS = {
  video: ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v'],
  audio: ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma'],
  image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'],
  // 字幕文件的文字本就现成，只是包了一层时间轴与样式标记，不需要任何识别引擎。
  // 它们走「直接解析导入」而非 OCR/ASR——见 design.md 决策 12。
  text: ['.txt', '.md', '.markdown', '.srt', '.vtt', '.ass', '.ssa', '.json', '.csv'],
} as const

export type AssetKind = keyof typeof SUPPORTED_EXTENSIONS
