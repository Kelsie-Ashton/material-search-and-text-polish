import type { Db } from '../db/index.js'
import { inTransaction } from '../db/index.js'
import type { TagRef } from '../library/assets.js'
import { err, ok, type Result } from '../shared/result.js'

/**
 * 标签服务。
 *
 * 标签是这份素材库的**长期资产**：检索靠它命中、润色靠它归档。
 * 因此判重不能只靠界面上的 Set，必须落到数据库里——
 * 用户在不同时间、不同素材上重复输同一个标签是必然行为。
 *
 * ## 判重键而不是判重名
 *
 * `tags` 表上 `name_key` 唯一，`name` 只是展示用的那一个写法。
 * 二者分离的原因：
 *
 * - 中文标签的「同一个」不只是字面相同。全角「ＡＢ」与半角「AB」、
 *   前后带空格的「 美食 」与「美食」，用户眼里都是同一个标签。
 *   所以 name_key 走 NFKC + 折叠空白 + 转小写。
 * - 反过来，展示名必须保留用户第一次输入的样子（NFKC 会改写字符，
 *   拿它当展示名会让「ＡＢ」在界面上变成「AB」，用户会以为存错了）。
 *
 * 于是「第一次怎么写，以后就怎么显示；判重始终按归一化的键」。
 *
 * ## 孤儿标签不自动删除
 *
 * 从素材上移除最后一个标签后，`tags` 里的那一行**留着**。
 * 理由是这个列表同时充当词汇表（供补全与筛选），静默丢掉用户
 * 攒下来的标签比留几条没人用的更烦人。真要清理，
 * `pruneOrphanTags()` 是一个显式的、由用户发起的操作。
 */

/** 标签名长度上限（码点）。够长，但挡住把整段文案当标签粘进来。 */
const MAX_TAG_NAME_LENGTH = 50

/** 标签来源。与 schema 中 asset_tags.source 的取值一一对应。 */
export type TagSource = 'manual' | 'polished' | 'extracted'

export interface TagWithUsage extends TagRef {
  /** 挂了几个素材。0 表示这是个孤儿标签（见文件头）。 */
  usageCount: number
}

export interface LinkTagResult {
  tag: TagRef
  /**
   * 这个素材之前就挂了这个标签。
   *
   * 这是**正常业务结果，不是错误**：用户重复点「添加」是必然发生的，
   * 返回 Err 会让调用点被迫用异常表达一件根本不异常的事。
   */
  alreadyLinked: boolean
  /** 标签是本次新建的；false 表示复用了库里已有的同名标签 */
  tagCreated: boolean
}

/**
 * 归一化为判重键。
 *
 * NFKC 会把全角字母数字折成半角、把兼容汉字折成标准汉字——
 * 对「这两个写法是不是同一个标签」来说正是想要的。
 * 折叠空白是因为标签名里的连续空格多半是手滑，不是语义。
 */
function tagKeyOf(displayName: string): string {
  return displayName.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function codePointLength(text: string): number {
  return [...text].length
}

/**
 * 校验并归一化用户输入的标签名，返回**展示用**的那个写法。
 *
 * 展示名只做两件不改变含义的事：去掉首尾空白、把内部连续空白折成一个空格。
 * 不做 NFKC——那会悄悄改写用户输入的字符（见文件头）。
 */
export function normalizeTagName(raw: string): Result<string> {
  const collapsed = raw.replace(/\s+/g, ' ').trim()

  if (collapsed === '') {
    return err('TAG_NAME_INVALID', '标签名不能为空')
  }
  if (codePointLength(collapsed) > MAX_TAG_NAME_LENGTH) {
    return err('TAG_NAME_INVALID', `标签名过长，请控制在 ${MAX_TAG_NAME_LENGTH} 字以内`, {
      length: codePointLength(collapsed),
      max: MAX_TAG_NAME_LENGTH,
    })
  }

  return ok(collapsed)
}

interface TagRow {
  id: number
  name: string
  color: string | null
}

function toRef(row: TagRow): TagRef {
  return { id: row.id, name: row.name, color: row.color }
}

function findByNameKey(db: Db, nameKey: string): TagRow | undefined {
  return db.prepare('SELECT id, name, color FROM tags WHERE name_key = ?').get(nameKey) as
    | TagRow
    | undefined
}

/**
 * 找到或新建标签。
 *
 * 用 `ON CONFLICT DO NOTHING` + 回查而不是「先 SELECT 再 INSERT」：
 * 后者在两步之间有窗口期，虽然本项目是单进程，但扫描任务与用户操作
 * 都可能在写库，把唯一性交给数据库约束比靠应用层时序可靠。
 */
function ensureTag(
  db: Db,
  displayName: string,
  color: string | null,
): { tag: TagRow; created: boolean } {
  const nameKey = tagKeyOf(displayName)

  const inserted = db
    .prepare(
      `INSERT INTO tags (name, name_key, color, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name_key) DO NOTHING`,
    )
    .run(displayName, nameKey, color, Date.now())

  const row = findByNameKey(db, nameKey)
  // 插入成功却回查不到，只可能是并发删掉了这行——不属于本项目会出现的状态。
  // 真发生了就该炸，而不是返回一个 undefined 让调用方猜。
  if (!row) {
    throw new Error(`标签写入后回查失败：${nameKey}`)
  }

  // 注意颜色只在**新建**时写入。已有标签保留它原本的颜色，
  // 不因为这次带了个不同颜色就被改掉——否则同一个标签的样式
  // 会随最后操作它的那个素材而变。
  return { tag: row, created: inserted.changes > 0 }
}

export interface LinkTagOptions {
  source?: TagSource | undefined
  color?: string | null | undefined
}

/**
 * 给素材挂标签，标签不存在则先建。
 *
 * 整件事在一个事务里：只建了标签却没挂上（或反过来）会留下
 * 一条零使用的孤儿行，用户下次看到它会以为程序坏了。
 */
export function linkTag(
  db: Db,
  assetId: number,
  rawName: string,
  options: LinkTagOptions = {},
): Result<LinkTagResult> {
  const name = normalizeTagName(rawName)
  if (!name.ok) return name

  // 素材不存在时就别建标签了。否则一次拼错 id 的请求会在库里
  // 留下一个永远挂不上任何东西的标签。
  const asset = db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId) as
    | { id: number }
    | undefined
  if (!asset) {
    return err('ASSET_NOT_FOUND', `素材不存在（id=${assetId}）`, { id: assetId })
  }

  const outcome = inTransaction(db, () => {
    const { tag, created } = ensureTag(db, name.value, options.color ?? null)
    const linked = db
      .prepare(
        `INSERT INTO asset_tags (asset_id, tag_id, source, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(asset_id, tag_id) DO NOTHING`,
      )
      .run(assetId, tag.id, options.source ?? 'manual', Date.now())

    return { tag, tagCreated: created, alreadyLinked: linked.changes === 0 }
  })

  return ok({
    tag: toRef(outcome.tag),
    alreadyLinked: outcome.alreadyLinked,
    tagCreated: outcome.tagCreated,
  })
}

/**
 * 摘掉素材上的一个标签。
 *
 * 「本来就没挂」返回 Ok({removed:false}) 而不是错误——用户对着一个
 * 已经摘掉的标签再点一次删除，界面不该弹红字。标签本身**不删**
 * （见文件头：孤儿标签留给用户显式清理）。
 */
export function unlinkTag(db: Db, assetId: number, tagId: number): Result<{ removed: boolean }> {
  const asset = db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId) as
    | { id: number }
    | undefined
  if (!asset) {
    return err('ASSET_NOT_FOUND', `素材不存在（id=${assetId}）`, { id: assetId })
  }

  const result = db
    .prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?')
    .run(assetId, tagId)

  return ok({ removed: result.changes > 0 })
}

/** 某个素材的标签，按名称排序。 */
export function listAssetTags(db: Db, assetId: number): TagRef[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.color
         FROM asset_tags at
         JOIN tags t ON t.id = at.tag_id
        WHERE at.asset_id = ?
        ORDER BY t.name ASC`,
    )
    .all(assetId) as TagRow[]
  return rows.map(toRef)
}

/**
 * 全库标签及其使用次数。
 *
 * 带上 usageCount 而不是只回标签名，是为了让界面能如实显示
 * 「0 次使用」——孤儿标签是设计上允许存在的状态，
 * 藏着它反而让用户对不上账。
 */
export function listTags(db: Db): TagWithUsage[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.color, COUNT(at.asset_id) AS usage_count
         FROM tags t
         LEFT JOIN asset_tags at ON at.tag_id = t.id
        GROUP BY t.id
        ORDER BY t.name ASC`,
    )
    .all() as Array<TagRow & { usage_count: number }>

  return rows.map((row) => ({ ...toRef(row), usageCount: row.usage_count }))
}

/**
 * 删除没有任何素材使用的标签。
 *
 * 刻意是显式操作而不是「摘掉最后一个链接时顺手删」：
 * 后者会让用户攒下来的词汇表在不知情的情况下缩水，
 * 而词汇表正是补全与筛选的数据来源。
 */
export function pruneOrphanTags(db: Db): { removed: number } {
  const result = db
    .prepare('DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM asset_tags WHERE tag_id = tags.id)')
    .run()
  return { removed: result.changes }
}
