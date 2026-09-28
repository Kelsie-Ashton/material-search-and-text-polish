import { inTransaction, type Db } from '../db/index.js'

/**
 * 润色结果的读写（任务 6.5）。
 *
 * ## 「当前结果」为什么靠一个部分唯一索引来保证
 *
 * 表里保留历史（追加新行、把旧行 `is_current` 置 0），而不是原地 UPDATE。
 * 这样一次网络抖动或一次误操作都不会毁掉上次的结果，也能对比不同模型/提示词的输出。
 *
 * 但「历史」与「当前」并存，就得有人保证**每个素材只有一条 current**。
 * 这件事交给数据库自己：`idx_polish_current` 是一个带条件的唯一索引
 * （`WHERE is_current = 1 AND status = 'succeeded' AND primary_asset_id IS NOT NULL`）。
 * 应用层写错顺序会直接报错，而不是静默留下两条「当前结果」——
 * 那种错不会有人发现，直到用户发现界面上显示的内容每次都不一样。
 *
 * ## 删掉的段落怎么办
 *
 * 润色结果**不随提取结果变化**。重新提取素材会把旧段落删掉换成新的，
 * 但已经产生的润色结果仍然指向它的来源素材（`polish_sources`），
 * 不指向具体段落。这是有意的：用户拿到的是一段文案，不是一个段落的副本。
 */

export interface PolishedResult {
  id: number
  assetId: number
  body: string
  model: string
  promptVersion: string
  inputTokens: number | null
  outputTokens: number | null
  createdAt: number
}

export interface SavePolishInput {
  assetId: number
  body: string
  model: string
  promptVersion: string
  inputChars: number
  inputTokens: number | null
  outputTokens: number | null
}

/**
 * 写入一次成功的润色结果，并把它设为该素材的当前结果。
 *
 * 两件事必须在**同一个事务**里：把旧的 current 置 0、插入新的 current。
 * 分开做的话，中间那一刻是「这个素材没有当前结果」——而此时若有另一个请求
 * 读它，用户会看到润色结果凭空消失；反过来若是先插后改，则有一刻存在两条
 * current，唯一索引会直接拒绝（这倒是好事，但会把一次正常操作变成 500）。
 */
export function savePolishedResult(db: Db, input: SavePolishInput): number {
  const now = Date.now()

  return inTransaction(db, () => {
    // 先让位，再插入。顺序反了会被部分唯一索引挡下。
    db.prepare(
      `UPDATE polish_results SET is_current = 0
        WHERE primary_asset_id = ? AND is_current = 1`,
    ).run(input.assetId)

    const inserted = db
      .prepare(
        `INSERT INTO polish_results
           (primary_asset_id, body, model, prompt_version, status,
            input_chars, input_tokens, output_tokens, is_current, created_at)
         VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, 1, ?)`,
      )
      .run(
        input.assetId,
        input.body,
        input.model,
        input.promptVersion,
        input.inputChars,
        input.inputTokens,
        input.outputTokens,
        now,
      )

    const id = Number(inserted.lastInsertRowid)

    db.prepare(
      `INSERT INTO polish_sources (polish_result_id, asset_id, ordinal) VALUES (?, ?, 0)`,
    ).run(id, input.assetId)

    return id
  })
}

export interface SavePolishFailureInput {
  assetId: number
  model: string
  promptVersion: string
  inputChars: number
  code: string
  message: string
}

/**
 * 记下一次失败的润色。
 *
 * **失败的尝试也要留一行**，理由和提取那边一样：用户看到「失败了」之后
 * 一定会问为什么，而原因如果只留在这次 HTTP 响应里，刷新一次页面就没了。
 *
 * 它永远不会成为 current（部分唯一索引要求 `status = 'succeeded'`），
 * 所以**不会被误当成可用结果**，也**不会顶掉上一次真正成功的结果**——
 * 用户花过钱拿到的那段文案不该因为一次网络抖动而消失。
 */
export function savePolishFailure(db: Db, input: SavePolishFailureInput): number {
  const inserted = db
    .prepare(
      `INSERT INTO polish_results
         (primary_asset_id, body, model, prompt_version, status,
          error_code, error_message, input_chars, is_current, created_at)
       VALUES (?, '', ?, ?, 'failed', ?, ?, ?, 0, ?)`,
    )
    .run(
      input.assetId,
      input.model,
      input.promptVersion,
      input.code,
      input.message,
      input.inputChars,
      Date.now(),
    )

  return Number(inserted.lastInsertRowid)
}

/** 读某个素材**当前**那条成功的润色结果。没有就是 null——不是错误。 */
export function readCurrentPolish(db: Db, assetId: number): PolishedResult | null {
  const row = db
    .prepare(
      `SELECT id, primary_asset_id AS assetId, body, model, prompt_version AS promptVersion,
              input_tokens AS inputTokens, output_tokens AS outputTokens, created_at AS createdAt
         FROM polish_results
        WHERE primary_asset_id = ? AND is_current = 1 AND status = 'succeeded'
        LIMIT 1`,
    )
    .get(assetId) as Omit<PolishedResult, 'id'> & { id: number } | undefined

  return row ?? null
}

/** 最近一次失败的原因。用来在界面上说清「上次为什么没成」。 */
export function readLastPolishFailure(
  db: Db,
  assetId: number,
): { code: string; message: string; createdAt: number } | null {
  const row = db
    .prepare(
      `SELECT error_code AS code, error_message AS message, created_at AS createdAt
         FROM polish_results
        WHERE primary_asset_id = ? AND status = 'failed'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(assetId) as { code: string | null; message: string | null; createdAt: number } | undefined

  if (!row) return null
  return { code: row.code ?? 'UNKNOWN', message: row.message ?? '', createdAt: row.createdAt }
}
