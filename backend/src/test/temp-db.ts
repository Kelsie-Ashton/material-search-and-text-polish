import Database from 'better-sqlite3'

import { applyPragmas, type Db } from '../db/index.js'
import { migrate } from '../db/migrate.js'

/**
 * 内存库 + 与生产**完全相同**的 PRAGMA 与结构。
 *
 * 刻意不复用 openDatabase()：那个函数会 mkdir 和落盘。
 * 但 PRAGMA 与迁移这两步必须走同一条代码路径——测试要验证的正是它们。
 */
export function createTestDb(): Db {
  const db = new Database(':memory:')
  applyPragmas(db)
  migrate(db)
  return db
}
