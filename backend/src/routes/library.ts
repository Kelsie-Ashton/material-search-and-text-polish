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

  router.get('/jobs/:id', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '任务 id 不合法'), 400)
      return
    }
    sendResult(res, queue.get(id))
  })

  router.post('/jobs/:id/cancel', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '任务 id 不合法'), 400)
      return
    }

    const outcome = queue.cancel(id)
    if (!outcome.ok) {
      sendResult(res, outcome)
      return
    }

    // 用 202 而不是 200：'will-stop-at-checkpoint' 意味着工作还在继续，
    // 界面必须继续轮询，而不是立刻把进度条抹掉。
    res.status(202).json({ ok: true, value: { outcome: outcome.value } })
  })

  router.get('/jobs', (req, res) => {
    const type = req.query['type']
    if (type !== undefined && type !== 'scan' && type !== 'extract' && type !== 'polish') {
      sendResult(res, err('VALIDATION_FAILED', '任务类型不合法'), 400)
      return
    }

    const items = queue.list({
      type: type as 'scan' | 'extract' | 'polish' | undefined,
      activeOnly: req.query['activeOnly'] === 'true',
    })
    res.json({ ok: true, value: { items } })
  })

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
