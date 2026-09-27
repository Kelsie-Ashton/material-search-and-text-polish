import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { databaseFile } from '../config.js'

export type Db = Database.Database

/**
 * 每个连接都必须执行的 PRAGMA。
 *
 * 单独抽出来是为了让测试走**同一条**代码路径——这些设置漏掉任何一条
 * 都是静默失效，不会报错，只会让级联删除和外键约束形同虚设。
 */
export function applyPragmas(db: Db): void {
  // better-sqlite3 默认 foreign_keys = OFF。忘了开则所有 ON DELETE CASCADE
  // 静默失效：删掉目录行后，素材索引会全部残留成孤儿。
  db.pragma('foreign_keys = ON')
  // WAL 下读不阻塞写，是「串行任务队列 + 前端轮询进度」能同时工作的前提。
  db.pragma('journal_mode = WAL')
  // 扫描是分批提交的长任务，给其他写入留出等待窗口而不是立刻 SQLITE_BUSY。
  db.pragma('busy_timeout = 5000')
  // WAL 下 NORMAL 是安全性与吞吐的合理折中：崩溃不会损坏库，最多丢掉最后几笔事务。
  db.pragma('synchronous = NORMAL')
}

export function openDatabase(file: string = databaseFile): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  applyPragmas(db)
  return db
}

/**
 * 事务包装。
 *
 * 用 immediate 而不是默认的 deferred：在 WAL 下，一个先读后写的事务
 * 若以 deferred 开始，升级为写事务时可能遇到 SQLITE_BUSY 而**无法重试**
 * （拿到读锁后再升级是 SQLite 明确不推荐的模式）。immediate 一开始就拿写锁，
 * 配合 busy_timeout 会正常排队等待。
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate()
}
