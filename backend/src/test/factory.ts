import type { Db } from '../db/index.js'

/**
 * 直接插入测试数据的工厂。
 *
 * 不走 service 层是刻意的：这些夹具服务于「数据库结构本身是否正确」的测试，
 * 若依赖尚未实现（或正在变动）的业务代码，测试就会因为无关的原因失败。
 */

export interface DirectoryRow {
  id: number
  path: string
  pathKey: string
}

export function createDirectory(
  db: Db,
  overrides: Partial<{ path: string; pathKey: string; label: string }> = {},
): DirectoryRow {
  const path = overrides.path ?? 'D:\\素材库\\美食'
  const pathKey = overrides.pathKey ?? path.toLowerCase()

  const info = db
    .prepare('INSERT INTO directories (path, path_key, label, created_at) VALUES (?, ?, ?, ?)')
    .run(path, pathKey, overrides.label ?? null, Date.now())

  return { id: Number(info.lastInsertRowid), path, pathKey }
}

export interface AssetRow {
  id: number
  path: string
  fileName: string
}

export function createAsset(
  db: Db,
  directoryId: number,
  overrides: Partial<{
    path: string
    fileName: string
    ext: string
    kind: string
    fingerprint: string
  }> = {},
): AssetRow {
  const fileName = overrides.fileName ?? '探店剪辑.mp4'
  const path = overrides.path ?? `D:\\素材库\\美食\\${fileName}`
  const now = Date.now()

  const info = db
    .prepare(
      `INSERT INTO assets (
         directory_id, path, path_key, file_name, ext, kind,
         size_bytes, mtime_ms, fingerprint, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      directoryId,
      path,
      path.toLowerCase(),
      fileName,
      overrides.ext ?? '.mp4',
      overrides.kind ?? 'video',
      1024,
      now,
      overrides.fingerprint ?? 'fp-0001',
      now,
      now,
    )

  return { id: Number(info.lastInsertRowid), path, fileName }
}

export interface SegmentRow {
  id: number
  text: string
}

export function createSegment(
  db: Db,
  assetId: number,
  text: string,
  overrides: Partial<{ source: string; ordinal: number; startMs: number; endMs: number }> = {},
): SegmentRow {
  const info = db
    .prepare(
      `INSERT INTO asset_text_segments
         (asset_id, source, ordinal, text, start_ms, end_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      assetId,
      overrides.source ?? 'audio',
      overrides.ordinal ?? 0,
      text,
      overrides.startMs ?? 0,
      overrides.endMs ?? 3000,
      Date.now(),
    )

  return { id: Number(info.lastInsertRowid), text }
}

export function countRows(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

/** 用 FTS5 的 phrase 查询取出命中的 rowid 列表。 */
export function ftsRowIds(db: Db, phrase: string): number[] {
  const rows = db
    .prepare('SELECT rowid FROM fts_segments WHERE fts_segments MATCH ? ORDER BY rowid')
    .all(`"${phrase}"`) as Array<{ rowid: number }>
  return rows.map((r) => r.rowid)
}
