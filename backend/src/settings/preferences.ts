import type { Db } from '../db/index.js'
import { err, ok, type Result } from '../shared/result.js'
import { DEFAULT_TEXT_SCRIPT, isTextScript, type TextScript } from '../shared/text-script.js'

/**
 * 应用偏好设置（`app_settings` 键值表）。
 *
 * 目前只有一项：**默认文本保存方式**（简体 / 繁体）。
 * 它决定提取出的文字以哪种字形落库，也就直接决定了用户能不能搜到——
 * 库里存繁体而用户搜简体，trigram 全文索引是按字符匹配的，两边对不上就是零结果。
 *
 * 三条刻意的设计：
 *
 * 1. **读取永不失败。** 表里没有这一行（首次运行）、值被手工改坏、
 *    或存的是未来版本才认识的值——一律**回落到默认值**，而不是报错。
 *    一个偏好读不出来就让整个提取链路失败，代价完全不成比例。
 * 2. **写入做校验。** 与读取相反：进来的值必须是已知的两种之一，
 *    否则明确拒绝。写坏的值会在之后每一次提取里悄悄生效。
 * 3. **值以字符串存。** 这张表是通用键值表，不该为某一项引入 JSON。
 *    需要结构化时再单独讨论，现在这样反而更好读、能直接用 SQL 改。
 */

/** 键名常量。散落的字符串字面量是拼写错误的温床。 */
const KEY_TEXT_SCRIPT = 'text_script'

export interface AppSettings {
  textScript: TextScript
}

const DEFAULTS: AppSettings = { textScript: DEFAULT_TEXT_SCRIPT }

/**
 * 读出全部偏好。缺失或损坏的项各自回落到默认值。
 */
export function readSettings(db: Db): AppSettings {
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{
    key: string
    value: string
  }>

  const stored = new Map(rows.map((row) => [row.key, row.value]))
  const raw = stored.get(KEY_TEXT_SCRIPT)

  return {
    // 注意这里是 isTextScript 而不是 `raw ?? default`：
    // 表里存了一个无法识别的值时也要回落，不能原样返回。
    textScript: isTextScript(raw) ? raw : DEFAULTS.textScript,
  }
}

/**
 * 提取落库前读这一项。
 *
 * 单独开一个函数是为了让调用方不必知道键名，也便于**将来给读取加缓存**时
 * 只改一处——目前每次提取读一次 SQLite，是微秒级，不值得缓存。
 */
export function readTextScript(db: Db): TextScript {
  return readSettings(db).textScript
}

export interface SettingsPatch {
  textScript?: unknown
}

/**
 * 更新偏好。未提供的字段保持不变。
 *
 * 返回更新后的**完整**设置，而不是只回显改动的那一项：
 * 设置页拿它整体刷新，省掉一次往返，也不会出现「界面上一半新一半旧」。
 */
export function updateSettings(db: Db, patch: SettingsPatch): Result<AppSettings> {
  const updates: Array<[string, string]> = []

  if (patch.textScript !== undefined) {
    if (!isTextScript(patch.textScript)) {
      // 明确拒绝而不是静默忽略：静默忽略会让用户以为保存成功了，
      // 然后在下次提取时发现字形根本没变。
      return err('VALIDATION_FAILED', '「默认文本保存方式」只能是 simplified 或 traditional', {
        field: 'textScript',
        received: patch.textScript,
      })
    }
    updates.push([KEY_TEXT_SCRIPT, patch.textScript])
  }

  const now = Date.now()
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  for (const [key, value] of updates) upsert.run(key, value, now)

  return ok(readSettings(db))
}
