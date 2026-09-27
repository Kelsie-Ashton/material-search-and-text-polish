import { apiDelete, apiGet, apiPost } from './client'
import type { JobRecord } from './jobs'

/**
 * 素材库的接口封装。
 *
 * 这里**刻意重写一遍**后端的类型，而不是从 backend/ 里 import：
 * 两个包各自独立编译，跨包相对导入会破坏 Vite 的构建与 TS 的 rootDir 约定。
 * 代价是类型可能漂移——所以下面的注释里逐条标了后端对应的文件，
 * 改后端 DTO 时照着找回来。真正的防线是后端路由的测试，
 * 它们钉住了每个字段的实际 JSON 形状。
 */

interface Envelope<T> {
  ok: true
  value: T
}

async function unwrap<T>(promise: Promise<unknown>): Promise<T> {
  const payload = (await promise) as Envelope<T>
  return payload.value
}

/** 对应 backend/src/library/directories.ts 的 DirectoryRecord */
export interface DirectoryRecord {
  id: number
  path: string
  pathKey: string
  label: string | null
  enabled: boolean
  createdAt: number
  lastScannedAt: number | null
}

/** 对应 backend/src/library/directories.ts 的 RemoveDirectorySummary */
export interface RemoveDirectorySummary {
  id: number
  path: string
  removedAssets: number
  /** 恒定 true。写出来是为了让调用方无法假装它删了磁盘文件。 */
  filesUntouched: true
}

/** 对应 backend/src/library/scanner.ts 的 ScanSummary */
export interface ScanSummary {
  visited: number
  indexed: number
  updated: number
  unchanged: number
  skippedUnsupported: number
  removed: number
  completedCleanly: boolean
  cancelled: boolean
  errors: Array<{ path: string; message: string }>
}

export type CancelOutcome = 'canceled-immediately' | 'will-stop-at-checkpoint'

/** 对应 backend/src/library/assets.ts 的 TagRef */
export interface TagRef {
  id: number
  name: string
  color: string | null
}

/** 对应 backend/src/tags/service.ts 的 TagWithUsage */
export interface TagWithUsage extends TagRef {
  usageCount: number
}

/** 对应 backend/src/library/assets.ts 的 AssetSummary */
export interface AssetSummary {
  id: number
  directoryId: number
  path: string
  fileName: string
  ext: string
  kind: 'video' | 'audio' | 'image' | 'text'
  sizeBytes: number
  mtimeMs: number
  extractStatus: ExtractStatus
  updatedAt: number
  tags: TagRef[]
}

/** 对应 backend/src/library/assets.ts 的 AssetDetail */
export interface AssetDetail extends AssetSummary {
  fingerprint: string
  durationMs: number | null
  width: number | null
  height: number | null
  extractError: string | null
  extractedAt: number | null
  createdAt: number
  segmentCount: number
}

/** 与后端 assets.extract_status 的取值一一对应 */
export type ExtractStatus = 'none' | 'pending' | 'running' | 'done' | 'partial' | 'failed'

/** 素材类型的中文名。界面各处共用，避免同一状态在不同页面写成不同措辞。 */
export const KIND_LABELS: Record<AssetSummary['kind'], string> = {
  video: '视频',
  audio: '音频',
  image: '图片',
  text: '文本',
}

/**
 * 提取状态的中文名。
 *
 * 「未提取」而不是「无」：用户看到「无」不知道是「没有文字」还是
 * 「还没试过」，这两件事的含义完全不同。
 */
export const STATUS_LABELS: Record<ExtractStatus, string> = {
  none: '未提取',
  pending: '排队中',
  running: '提取中',
  done: '已提取',
  partial: '部分提取',
  failed: '提取失败',
}

export interface ListAssetsResult {
  items: AssetSummary[]
  total: number
}

export interface ListAssetsQuery {
  directoryId?: number | undefined
  kind?: AssetSummary['kind'] | undefined
  status?: ExtractStatus | undefined
  q?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}

/** 把查询参数拼成 URL，跳过空值——后端把空串当作「不筛选」，但没必要发出去。 */
function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query === '' ? path : `${path}?${query}`
}

// ---------------------------------------------------------------- 目录

export function listDirectories(): Promise<DirectoryRecord[]> {
  return unwrap<{ items: DirectoryRecord[] }>(apiGet('/api/library/directories')).then(
    (value) => value.items,
  )
}

export function addDirectory(path: string, label?: string): Promise<DirectoryRecord> {
  return unwrap<DirectoryRecord>(
    apiPost('/api/library/directories', label ? { path, label } : { path }),
  )
}

export function removeDirectory(id: number): Promise<RemoveDirectorySummary> {
  return unwrap<RemoveDirectorySummary>(apiDelete(`/api/library/directories/${id}`))
}

// ---------------------------------------------------------------- 扫描

/**
 * 触发扫描。返回的是任务记录本身——扫描**不是一个请求就跑完的**，
 * 它被丢进队列，进度要去 `api/jobs.ts` 里轮询。
 *
 * 这条留在素材库模块里，是因为它挂在目录下面（`/directories/:id/scan`）：
 * 「扫这个目录」天然属于目录的操作。其余任务的读取与取消都在 `api/jobs.ts`。
 */
export function startScan(directoryId: number): Promise<JobRecord> {
  return unwrap<JobRecord>(apiPost(`/api/library/directories/${directoryId}/scan`))
}

// ---------------------------------------------------------------- 素材

export function listAssets(query: ListAssetsQuery = {}): Promise<ListAssetsResult> {
  return unwrap<ListAssetsResult>(
    apiGet(
      withQuery('/api/library/assets', {
        directoryId: query.directoryId,
        kind: query.kind,
        status: query.status,
        q: query.q,
        limit: query.limit,
        offset: query.offset,
      }),
    ),
  )
}

export function getAsset(id: number): Promise<AssetDetail> {
  return unwrap<AssetDetail>(apiGet(`/api/library/assets/${id}`))
}

// ---------------------------------------------------------------- 标签

export function listTags(): Promise<TagWithUsage[]> {
  return unwrap<{ items: TagWithUsage[] }>(apiGet('/api/library/tags')).then((value) => value.items)
}

export interface LinkTagResult {
  tag: TagRef
  /** 这个素材之前就挂了这个标签——正常结果，不是错误 */
  alreadyLinked: boolean
  tagCreated: boolean
}

export function linkTag(
  assetId: number,
  name: string,
  source?: 'manual' | 'polished' | 'extracted',
): Promise<LinkTagResult> {
  return unwrap<LinkTagResult>(
    apiPost(`/api/library/assets/${assetId}/tags`, source ? { name, source } : { name }),
  )
}

export function unlinkTag(assetId: number, tagId: number): Promise<{ removed: boolean }> {
  return unwrap<{ removed: boolean }>(apiDelete(`/api/library/assets/${assetId}/tags/${tagId}`))
}

// ---------------------------------------------------------------- 格式化

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function formatTime(ms: number | null): string {
  if (ms === null) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
