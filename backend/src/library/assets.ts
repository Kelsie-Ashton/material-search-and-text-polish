import type { AssetKind } from '../config.js'
import type { Db } from '../db/index.js'
import { err, ok, type Result } from '../shared/result.js'

/** 提取状态。与 schema 中 assets.extract_status 的取值一一对应。 */
export type ExtractStatus = 'none' | 'pending' | 'running' | 'done' | 'partial' | 'failed'

export interface TagRef {
  id: number
  name: string
  color: string | null
}

export interface AssetSummary {
  id: number
  directoryId: number
  path: string
  fileName: string
  ext: string
  kind: AssetKind
  sizeBytes: number
  mtimeMs: number
  extractStatus: ExtractStatus
  updatedAt: number
  tags: TagRef[]
}

export interface AssetDetail extends AssetSummary {
  fingerprint: string
  durationMs: number | null
  width: number | null
  height: number | null
  extractError: string | null
  extractedAt: number | null
  createdAt: number
  /** 已提取的段落数。列表页不必查，详情页要显示「共 N 段」 */
  segmentCount: number
}

interface AssetRowShape {
  id: number
  directory_id: number
  path: string
  file_name: string
  ext: string
  kind: string
  size_bytes: number
  mtime_ms: number
  fingerprint: string
  duration_ms: number | null
  width: number | null
  height: number | null
  extract_status: string
  extract_error: string | null
  extracted_at: number | null
  created_at: number
  updated_at: number
}

function toSummary(row: AssetRowShape, tags: TagRef[]): AssetSummary {
  return {
    id: row.id,
    directoryId: row.directory_id,
    path: row.path,
    fileName: row.file_name,
    ext: row.ext,
    kind: row.kind as AssetKind,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    extractStatus: row.extract_status as ExtractStatus,
    updatedAt: row.updated_at,
    tags,
  }
}

/**
 * 批量取标签。
 *
 * 刻意用「一次查完再在内存里分组」而不是每条素材查一次：
 * 素材列表一页 50 条，逐条查就是 50 次往返。SQLite 是进程内的，
 * 单次往返很便宜，但 50 次也会累积成肉眼可见的延迟。
 */
function tagsByAsset(db: Db, assetIds: number[]): Map<number, TagRef[]> {
  const grouped = new Map<number, TagRef[]>()
  if (assetIds.length === 0) return grouped

  const placeholders = assetIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT at.asset_id, t.id, t.name, t.color
         FROM asset_tags at
         JOIN tags t ON t.id = at.tag_id
        WHERE at.asset_id IN (${placeholders})
        ORDER BY t.name ASC`,
    )
    .all(...assetIds) as Array<{ asset_id: number; id: number; name: string; color: string | null }>

  for (const row of rows) {
    const list = grouped.get(row.asset_id) ?? []
    list.push({ id: row.id, name: row.name, color: row.color })
    grouped.set(row.asset_id, list)
  }
  return grouped
}

export interface ListAssetsOptions {
  directoryId?: number | undefined
  kind?: AssetKind | undefined
  extractStatus?: ExtractStatus | undefined
  /** 文件名子串过滤，供素材库页的关键词框使用（检索页走的是另一条链路） */
  fileNameContains?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export interface ListAssetsResult {
  items: AssetSummary[]
  total: number
}

const DEFAULT_LIMIT = 50
/** 上限存在的意义是防止一次请求把整库拖进内存。 */
const MAX_LIMIT = 500

export function listAssets(db: Db, options: ListAssetsOptions = {}): ListAssetsResult {
  const clauses: string[] = []
  const params: unknown[] = []

  if (options.directoryId !== undefined) {
    clauses.push('directory_id = ?')
    params.push(options.directoryId)
  }
  if (options.kind !== undefined) {
    clauses.push('kind = ?')
    params.push(options.kind)
  }
  if (options.extractStatus !== undefined) {
    clauses.push('extract_status = ?')
    params.push(options.extractStatus)
  }
  if (options.fileNameContains) {
    // 这里的转义是必须的：文件名里的 % 和 _ 是 LIKE 的通配符，
    // 用户搜「100%」时不转义会变成「匹配任意字符」，返回一堆无关结果。
    const escaped = options.fileNameContains
      .replace(/[\\]/g, '\\\\')
      .replace(/[%_]/g, (m) => `\\${m}`)
    clauses.push("file_name LIKE ? ESCAPE '\\'")
    params.push(`%${escaped}%`)
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

  const counted = db.prepare(`SELECT COUNT(*) AS n FROM assets ${where}`).get(...params) as {
    n: number
  }

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(options.offset ?? 0, 0)

  const rows = db
    .prepare(`SELECT * FROM assets ${where} ORDER BY file_name ASC, id ASC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as AssetRowShape[]

  const tags = tagsByAsset(
    db,
    rows.map((r) => r.id),
  )

  return {
    items: rows.map((row) => toSummary(row, tags.get(row.id) ?? [])),
    total: counted.n,
  }
}

export function findAsset(db: Db, id: number): AssetDetail | null {
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRowShape | undefined
  if (!row) return null

  const counted = db
    .prepare('SELECT COUNT(*) AS n FROM asset_text_segments WHERE asset_id = ?')
    .get(id) as { n: number }

  return {
    ...toSummary(row, tagsByAsset(db, [id]).get(id) ?? []),
    fingerprint: row.fingerprint,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    extractError: row.extract_error,
    extractedAt: row.extracted_at,
    createdAt: row.created_at,
    segmentCount: counted.n,
  }
}

export function getAsset(db: Db, id: number): Result<AssetDetail> {
  const asset = findAsset(db, id)
  if (!asset) return err('ASSET_NOT_FOUND', `素材不存在（id=${id}）`, { id })
  return ok(asset)
}
