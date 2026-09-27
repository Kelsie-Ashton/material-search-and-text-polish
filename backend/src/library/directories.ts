import fs from 'node:fs'
import path from 'node:path'

import { inTransaction, type Db } from '../db/index.js'
import { fileNameOf, normalizePathKey } from '../shared/paths.js'
import { err, ok, type Result } from '../shared/result.js'

/**
 * 素材目录的增删查。
 *
 * ============ 本文件禁止 import 任何文件删除 API ============
 * 不得出现 `fs.rm` / `fs.unlink` / `fs.rmdir` / `fs.rmSync` /
 * `fs.promises.rm` / `fs.promises.unlink`。
 *
 * 「移除目录」在本系统中**只清除索引，绝不触碰磁盘上的原始文件**。
 * 用户的素材是他自己的资产，一个检索工具的误操作不该毁掉它。
 *
 * 这条约束由 eslint.config.mjs 里的 no-restricted-imports /
 * no-restricted-syntax 在 `npm run lint` 时强制，比代码评审可靠——
 * 评审会漏，而人是会顺手加一行 `fs.rmSync` 的。
 *
 * 已知边界（别把它当万能）：选择器匹配的是标识符 `fs` 与具名导入。
 * 若有人写 `import * as fsp from 'node:fs'` 再用 `fsp.rmSync`，规则不会响。
 * 它挡的是「顺手加一行」这类事故，不是处心积虑的绕过——
 * 后者只能靠评审。
 * ==========================================================
 */

export interface DirectoryRecord {
  id: number
  path: string
  pathKey: string
  label: string | null
  enabled: boolean
  createdAt: number
  lastScannedAt: number | null
}

interface DirectoryRowShape {
  id: number
  path: string
  path_key: string
  label: string | null
  enabled: number
  created_at: number
  last_scanned_at: number | null
}

function toRecord(row: DirectoryRowShape): DirectoryRecord {
  return {
    id: row.id,
    path: row.path,
    pathKey: row.path_key,
    label: row.label,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastScannedAt: row.last_scanned_at,
  }
}

export function listDirectories(db: Db): DirectoryRecord[] {
  const rows = db
    .prepare('SELECT * FROM directories ORDER BY created_at ASC, id ASC')
    .all() as DirectoryRowShape[]
  return rows.map(toRecord)
}

export function findDirectory(db: Db, id: number): DirectoryRecord | null {
  const row = db.prepare('SELECT * FROM directories WHERE id = ?').get(id) as
    | DirectoryRowShape
    | undefined
  return row ? toRecord(row) : null
}

export function getDirectory(db: Db, id: number): Result<DirectoryRecord> {
  const record = findDirectory(db, id)
  if (!record) {
    return err('DIRECTORY_NOT_FOUND', `素材目录不存在（id=${id}）`, { id })
  }
  return ok(record)
}

/**
 * 校验一个路径可以作为素材目录。
 *
 * 四种失败都要给出**可读的原因**而不是笼统的「添加失败」：
 * 用户输入的是他自己机器上的路径，他需要知道是打错了、
 * 选成了文件、还是没有权限。
 */
function inspectDirectory(target: string): Result<{ resolved: string; pathKey: string }> {
  let stats: fs.Stats
  try {
    stats = fs.statSync(target)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return err('DIRECTORY_NOT_FOUND', `路径不存在：${target}`, { path: target })
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return err('DIRECTORY_UNREADABLE', `没有访问该路径的权限：${target}`, { path: target })
    }
    // 路径过长、含非法字符等都归到这里，附上原始错误码便于排查
    return err('DIRECTORY_UNREADABLE', `无法访问该路径：${target}`, { path: target, cause: code })
  }

  if (!stats.isDirectory()) {
    return err('DIRECTORY_NOT_DIRECTORY', `这是一个文件，不是目录：${target}`, { path: target })
  }

  try {
    fs.accessSync(target, fs.constants.R_OK)
  } catch {
    return err('DIRECTORY_UNREADABLE', `目录不可读：${target}`, { path: target })
  }

  if (normalizePathKey(target) === '') {
    return err('DIRECTORY_NOT_FOUND', '目录路径不能为空')
  }

  return ok({ resolved: path.resolve(target), pathKey: normalizePathKey(target) })
}

function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    String((cause as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  )
}

export interface AddDirectoryInput {
  path: string
  label?: string | undefined
}

export function addDirectory(db: Db, input: AddDirectoryInput): Result<DirectoryRecord> {
  const raw = (input.path ?? '').trim()
  if (raw === '') {
    return err('DIRECTORY_NOT_FOUND', '请填写素材目录的完整路径')
  }

  const inspected = inspectDirectory(raw)
  if (!inspected.ok) return inspected

  const { resolved, pathKey } = inspected.value

  // 先查一次是为了给出「已经添加过了」这种友好提示；
  // 真正的防重复靠下面的唯一索引——两步之间可能有并发请求。
  const existing = db
    .prepare('SELECT * FROM directories WHERE path_key = ?')
    .get(pathKey) as DirectoryRowShape | undefined
  if (existing) {
    return err('DIRECTORY_DUPLICATE', `该目录已经添加过了：${existing.path}`, {
      id: existing.id,
      path: existing.path,
    })
  }

  const label = input.label?.trim() || fileNameOf(resolved) || resolved
  const now = Date.now()

  try {
    const info = db
      .prepare(
        'INSERT INTO directories (path, path_key, label, enabled, created_at) VALUES (?, ?, ?, 1, ?)',
      )
      .run(resolved, pathKey, label, now)

    return ok({
      id: Number(info.lastInsertRowid),
      path: resolved,
      pathKey,
      label,
      enabled: true,
      createdAt: now,
      lastScannedAt: null,
    })
  } catch (cause) {
    // 唯一索引兜住了竞态：两个请求同时通过了上面的查询
    if (isUniqueViolation(cause)) {
      return err('DIRECTORY_DUPLICATE', `该目录已经添加过了：${resolved}`, { path: resolved })
    }
    throw cause
  }
}

export interface RemoveDirectorySummary {
  id: number
  path: string
  /** 一并从索引中移除的素材条数，用于如实告诉用户「移除了什么」 */
  removedAssets: number
  /** 磁盘上的文件一个都没动——恒定 true，写出来是为了让调用方无法假装它删了文件 */
  filesUntouched: true
}

/**
 * 移除目录：只删索引。
 *
 * 素材、标签关联、提取文本、润色结果全部由外键 ON DELETE CASCADE 带走，
 * FTS 索引由 external content 的 AFTER DELETE 触发器清理。
 * 这一条语句就是全部实现——前提是 PRAGMA foreign_keys 已开
 * （better-sqlite3 默认关闭，见 db/index.ts）。
 */
export function removeDirectory(db: Db, id: number): Result<RemoveDirectorySummary> {
  const record = findDirectory(db, id)
  if (!record) {
    return err('DIRECTORY_NOT_FOUND', `素材目录不存在（id=${id}）`, { id })
  }

  const summary = inTransaction(db, () => {
    const counted = db
      .prepare('SELECT COUNT(*) AS n FROM assets WHERE directory_id = ?')
      .get(id) as { n: number }

    db.prepare('DELETE FROM directories WHERE id = ?').run(id)

    return { id, path: record.path, removedAssets: counted.n, filesUntouched: true as const }
  })

  return ok(summary)
}

/** 扫描完成后记录时间，供界面显示「上次扫描于…」。 */
export function markDirectoryScanned(db: Db, id: number, at: number = Date.now()): void {
  db.prepare('UPDATE directories SET last_scanned_at = ? WHERE id = ?').run(at, id)
}
