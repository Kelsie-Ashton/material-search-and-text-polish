import { Router } from 'express'

import type { Db } from '../db/index.js'
import { importSubtitleText, listSegments } from '../extraction/importer.js'
import { SUBTITLE_EXTENSIONS, isSubtitleExtension } from '../extraction/subtitle.js'
import { findAsset } from '../library/assets.js'
import { sendResult } from '../shared/http.js'
import { err } from '../shared/result.js'

/**
 * 文字提取路由。
 *
 * 目前只实现了一条路径：**字幕文件的直接解析导入**。它不需要任何模型，
 * 因此可以先于语音转写与 OCR 交付（design.md 决策 12）。
 *
 * 其余类型的入口**保留且如实报错**，而不是不挂载：用户点了「提取文字」
 * 却拿到 404「接口不存在」，会以为是程序坏了；拿到一句「这个类型的提取
 * 需要本地识别引擎，下一批提供」才知道该等什么。
 */

/** 路径参数解析成正整数，失败返回 null。 */
function parseId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

export function createExtractionRouter(db: Db): Router {
  const router = Router()

  router.post('/assets/:id', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }

    const asset = findAsset(db, id)
    if (!asset) {
      sendResult(res, err('ASSET_NOT_FOUND', `素材不存在（id=${id}）`, { id }))
      return
    }

    // 提取按文件类型分派。字幕文件的文字本就现成，直接解析；
    // 其余类型要「认出」文字，需要本地识别引擎。
    if (isSubtitleExtension(asset.ext)) {
      sendResult(res, importSubtitleText(db, id))
      return
    }

    sendResult(
      res,
      err(
        'NOT_IMPLEMENTED',
        `${asset.ext} 的文字提取需要本地识别引擎（语音转写 / OCR），将在下一批功能中提供。` +
          `字幕文件（${SUBTITLE_EXTENSIONS.join(' / ')}）现在就可以直接导入。`,
        { ext: asset.ext, kind: asset.kind },
      ),
    )
  })

  router.get('/assets/:id/segments', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }

    // 先确认素材存在：否则拼错的 id 会得到「空文本列表」，
    // 与「这条素材确实还没提取过」无法区分。
    const asset = findAsset(db, id)
    if (!asset) {
      sendResult(res, err('ASSET_NOT_FOUND', `素材不存在（id=${id}）`, { id }))
      return
    }

    const limit = parseLimit(req.query['limit'])
    const offset = parseLimit(req.query['offset'])
    if (limit === null || offset === null) {
      sendResult(res, err('VALIDATION_FAILED', '分页参数不合法'), 400)
      return
    }

    res.json({ ok: true, value: listSegments(db, id, { limit, offset }) })
  })

  return router
}

/** limit / offset 都是「非负整数或省略」 */
function parseLimit(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return null
  return value
}
