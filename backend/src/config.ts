import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根目录（由 backend/src 上溯两级） */
export const projectRoot = path.resolve(here, '..', '..')

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
 * 服务必须仅绑定回环地址。
 * 本服务能读取用户本机任意已授权目录，绝不能暴露到局域网。
 */
export const host = '127.0.0.1'

/** 受支持的素材扩展名 → 素材大类 */
export const SUPPORTED_EXTENSIONS = {
  video: ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v'],
  audio: ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma'],
  image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'],
  text: ['.txt', '.md', '.markdown', '.srt', '.vtt', '.json', '.csv'],
} as const

export type AssetKind = keyof typeof SUPPORTED_EXTENSIONS
