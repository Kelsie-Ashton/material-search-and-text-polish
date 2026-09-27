import { Router } from 'express'

import { SUPPORTED_EXTENSIONS, type AssetKind } from '../config.js'
import type { Db } from '../db/index.js'
import type { ExtractStatus } from '../library/assets.js'
import { search } from '../search/index.js'
import { sendResult } from '../shared/http.js'
import { err } from '../shared/result.js'

/**
 * 检索路由。
 *
 * 与其他路由一样，这里只做参数校验与结果写回。
 * 「短词走兜底」「多来源合并」这些判断全在 search/ 里——
 * 那些逻辑要被单测直接调用，不该藏在 HTTP 层后面。
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

export function createSearchRouter(db: Db): Router {
  const router = Router()

  router.get('/', (req, res) => {
    // 关键词可以来自 q，也允许直接 POST 体验更长的输入；
    // 这里只支持 GET，是因为检索是幂等的读操作，用 GET 才能被缓存与分享。
    const raw = req.query['q']
    if (raw !== undefined && typeof raw !== 'string') {
      sendResult(res, err('VALIDATION_FAILED', '关键词参数格式不正确'), 400)
      return
    }

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

    // 空关键词由 search() 拒绝并返回 SEARCH_QUERY_EMPTY，
    // 在这里不重复判断——错误码到状态码的映射只有 shared/http.ts 一处。
    const result = search(db, raw ?? '', { kind, extractStatus, directoryId, limit, offset })
    sendResult(res, result)
  })

  return router
}
