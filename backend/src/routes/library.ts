import { Router } from 'express'

import { SUPPORTED_EXTENSIONS, type AssetKind } from '../config.js'
import type { Db } from '../db/index.js'
import type { JobQueue } from '../jobs/queue.js'
import { getAsset, listAssets, type ExtractStatus } from '../library/assets.js'
import {
  addDirectory,
  getDirectory,
  listDirectories,
  removeDirectory,
} from '../library/directories.js'
import { sendResult } from '../shared/http.js'
import { err } from '../shared/result.js'
import { archiveKeywords, suggestKeywords } from '../tags/archive.js'
import {
  linkTag,
  listAssetTags,
  listTags,
  pruneOrphanTags,
  unlinkTag,
} from '../tags/service.js'

/**
 * 素材库路由。
 *
 * 路由层只做两件事：**校验参数形状**、**把结果写成 HTTP**。
 * 任何业务判断（目录存不存在、能不能扫）都在 library/ 里，
 * 那里可以直接被单测调用，不必起 HTTP 服务。
 */

const VALID_KINDS = Object.keys(SUPPORTED_EXTENSIONS) as AssetKind[]

const VALID_EXTRACT_STATUSES: ExtractStatus[] = [
  'none',
  'pending',
  'running',
  'done',
  'partial',
  'failed',
]

/** 路径参数解析成正整数，失败返回 null。 */
function parseId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

/** 可选的枚举型查询参数：空串视作「不筛选」。 */
function parseEnum<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined | null {
  if (raw === undefined || raw === '') return undefined
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) return null
  return raw as T
}

function parseCount(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

export function createLibraryRouter(db: Db, queue: JobQueue): Router {
  const router = Router()

  // ------------------------------------------------------------ 目录

  router.get('/directories', (_req, res) => {
    res.json({ ok: true, value: { items: listDirectories(db) } })
  })

  router.post('/directories', (req, res) => {
    const body = req.body as { path?: unknown; label?: unknown } | undefined
    if (typeof body?.path !== 'string') {
      sendResult(res, err('VALIDATION_FAILED', '请提供素材目录的路径（path）'), 400)
      return
    }

    const result = addDirectory(db, {
      path: body.path,
      label: typeof body.label === 'string' ? body.label : undefined,
    })
    sendResult(res, result, result.ok ? 201 : 200)
  })

  router.get('/directories/:id', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '目录 id 不合法'), 400)
      return
    }
    sendResult(res, getDirectory(db, id))
  })

  router.delete('/directories/:id', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '目录 id 不合法'), 400)
      return
    }
    // 只清索引，磁盘文件不动。响应里的 filesUntouched 就是这个承诺的可验证形式。
    sendResult(res, removeDirectory(db, id))
  })

  // ------------------------------------------------------------ 扫描任务

  router.post('/directories/:id/scan', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '目录 id 不合法'), 400)
      return
    }

    const directory = getDirectory(db, id)
    if (!directory.ok) {
      sendResult(res, directory)
      return
    }

    // 目录存在性已经确认过了，这里只是入队。
    // 重复点「扫描」由 jobs 表上的部分唯一索引挡住，返回 SCAN_ALREADY_RUNNING。
    const job = queue.enqueue('scan', id)
    sendResult(res, job, 202)
  })

  // 任务的读取与取消**不在这里**：`/api/jobs` 是它们唯一的家。
  // 扫描刚开始做的时候这里曾有一套 /jobs、/jobs/:id、/jobs/:id/cancel，
  // 提取做起来后又需要一套更全的（按素材筛、取消时把任务一起回给前端），
  // 于是同一件事有了两套形状不同的接口——这类重复迟早会漂移成
  // 「扫描的进度查得到、提取的查不到」这种没人能一眼看懂的 bug。
  // 保留目录下面那个 startScan，是因为它天然属于目录（POST /directories/:id/scan）。

  // ------------------------------------------------------------ 素材

  router.get('/assets', (req, res) => {
    const kind = parseEnum(req.query['kind'], VALID_KINDS)
    if (kind === null) {
      sendResult(res, err('VALIDATION_FAILED', `素材类型不合法，可选：${VALID_KINDS.join('、')}`), 400)
      return
    }

    const extractStatus = parseEnum(req.query['status'], VALID_EXTRACT_STATUSES)
    if (extractStatus === null) {
      sendResult(res, err('VALIDATION_FAILED', '提取状态不合法'), 400)
      return
    }

    const directoryId = parseCount(req.query['directoryId'])
    const limit = parseCount(req.query['limit'])
    const offset = parseCount(req.query['offset'])
    if (directoryId === null || limit === null || offset === null) {
      sendResult(res, err('VALIDATION_FAILED', '分页或目录参数不合法'), 400)
      return
    }

    const fileNameContains =
      typeof req.query['q'] === 'string' && req.query['q'].trim() !== ''
        ? req.query['q'].trim()
        : undefined

    const result = listAssets(db, { directoryId, kind, extractStatus, fileNameContains, limit, offset })
    // 空结果不是错误——列表页刚添加目录时就是空的
    res.json({ ok: true, value: result })
  })

  router.get('/assets/:id', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }
    sendResult(res, getAsset(db, id))
  })

  // ------------------------------------------------------------ 标签

  router.get('/tags', (_req, res) => {
    res.json({ ok: true, value: { items: listTags(db) } })
  })

  // 注意这条必须排在 /tags/:id 之前——本项目暂时没有那条路由，
  // 但 Express 是**按注册顺序**匹配的，日后加 /tags/:id 时要记得挪。
  router.delete('/tags/orphans', (_req, res) => {
    res.json({ ok: true, value: pruneOrphanTags(db) })
  })

  router.get('/assets/:id/tags', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }

    // 先确认素材存在：不然一个拼错的 id 会得到「空标签列表」，
    // 与「这个素材确实没有标签」无法区分。
    const asset = getAsset(db, id)
    if (!asset.ok) {
      sendResult(res, asset)
      return
    }
    res.json({ ok: true, value: { items: listAssetTags(db, id) } })
  })

  /**
   * 候选关键词（任务 6.10）。从这条素材已提取的正文里挑，**不联网**。
   *
   * 已经挂过的标签会被剔掉——候选里出现一个已经挂着的标签，用户勾了、
   * 点了归档、什么也没发生，看起来就像功能坏了。
   */
  router.get('/assets/:id/tag-candidates', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }

    const result = suggestKeywords(db, id)
    if (!result.ok) {
      sendResult(res, result)
      return
    }
    res.json({ ok: true, value: { items: result.value } })
  })

  /**
   * 把一批关键词归档成标签。
   *
   * 与上面那条「挂一个标签」的接口分开，不只是为了少发几次请求：
   * 归档是**一次操作**，用户点一下、得到一个总结（挂上了几个、几个已经有
   * 了、几个名字不合法）。逐条调用的话，界面只能自己拼这个总结，
   * 而拼错了没人会发现。
   */
  router.post('/assets/:id/tags/archive', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }

    const body = req.body as { keywords?: unknown } | undefined
    if (!Array.isArray(body?.keywords)) {
      sendResult(res, err('VALIDATION_FAILED', '请提供要归档的关键词（keywords 数组）'), 400)
      return
    }
    // 只收字符串。混进数字或对象就让 normalizeTagName 去处理的话，
    // 它会一路把非字符串当成「名字不合法」，用户看到的是「有 1 个没归档」
    // 而不是「你发的请求有问题」——后者才是实情。
    const keywords = body.keywords.filter((item): item is string => typeof item === 'string')
    if (keywords.length !== body.keywords.length) {
      sendResult(res, err('VALIDATION_FAILED', '关键词必须是字符串'), 400)
      return
    }

    sendResult(res, archiveKeywords(db, id, keywords))
  })

  router.post('/assets/:id/tags', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }

    const body = req.body as { name?: unknown; color?: unknown; source?: unknown } | undefined
    if (typeof body?.name !== 'string') {
      sendResult(res, err('TAG_NAME_INVALID', '请提供标签名（name）'), 400)
      return
    }

    const source = parseEnum(body.source, ['manual', 'polished', 'extracted'] as const)
    if (source === null) {
      sendResult(res, err('VALIDATION_FAILED', '标签来源不合法'), 400)
      return
    }

    const result = linkTag(db, id, body.name, {
      source,
      color: typeof body.color === 'string' ? body.color : null,
    })

    // 201 表示真的新建了链接；已经挂过则回 200——
    // 界面据此决定要不要提示「已存在」，而不是靠猜。
    const created = result.ok && !result.value.alreadyLinked
    sendResult(res, result, created ? 201 : 200)
  })

  router.delete('/assets/:id/tags/:tagId', (req, res) => {
    const id = parseId(req.params.id)
    const tagId = parseId(req.params.tagId)
    if (id === null || tagId === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材或标签 id 不合法'), 400)
      return
    }
    sendResult(res, unlinkTag(db, id, tagId))
  })

  return router
}
