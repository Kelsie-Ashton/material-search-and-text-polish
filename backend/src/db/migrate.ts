import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Db } from './index.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * schema.sql 由构建脚本复制到 dist 下，与 migrate.js 同目录。
 * 开发态（tsx 直接跑 src）与生产态（node dist）路径因此一致。
 */
const schemaPath = path.join(here, 'schema.sql')

/** 当前结构版本。每次改动 schema.sql 都要 +1。 */
export const SCHEMA_VERSION = 1

/**
 * 幂等地把索引库升到 SCHEMA_VERSION。
 *
 * 整体在一个事务里执行：SQLite 的 DDL 是事务性的，中途失败会完整回滚，
 * 不会留下「建了一半的表」这种需要人工清理的状态。
 */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number | null } | undefined
  const current = row?.version ?? 0

  if (current >= SCHEMA_VERSION) return
  if (current !== 0) {
    // 目前只有版本 1，尚无增量迁移脚本。真到需要时再引入按版本号分发的机制。
    throw new Error(`索引库版本为 ${current}，但只支持从 0 直接建到 ${SCHEMA_VERSION}`)
  }

  const sql = fs.readFileSync(schemaPath, 'utf8')

  db.exec('BEGIN')
  try {
    db.exec(sql)
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      Date.now(),
    )
    db.exec('COMMIT')
  } catch (cause) {
    db.exec('ROLLBACK')
    throw cause
  }
}
