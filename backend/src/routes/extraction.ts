import { Router } from 'express'

import type { Db } from '../db/index.js'
import { importSubtitleText, listSegments } from '../extraction/importer.js'
import { isMediaKind } from '../extraction/media.js'
import { SUBTITLE_EXTENSIONS, isSubtitleExtension } from '../extraction/subtitle.js'
import { findAsset } from '../library/assets.js'
import type { JobQueue } from '../jobs/queue.js'
import { sendResult } from '../shared/http.js'
import { err, ok } from '../shared/result.js'

/**
 * 文字提取路由。
 *
 * 两条路径，**按「要花多久」分派**：
 *
 * 1. **字幕文件**——读一个文本文件解析，毫秒级，**同步返回结果**。
 *    为它套一层任务队列只会让用户多点几次刷新。
 * 2. **音频 / 视频**——要抽音轨再跑语音模型，几分钟到几十分钟，**入队**。
 *    HTTP 请求挂不了那么久（浏览器、代理、Node 的默认超时都不同意），
 *    所以这里只返回任务 id，进度与结果由任务接口查（任务轮询接口见任务 5.7）。
 *
 * 图片仍如实报「未实现」而不是不挂载：用户点了「提取文字」却拿到 404
 * 「接口不存在」，会以为是程序坏了；拿到一句「这个类型的提取需要本地识别
 * 引擎，下一批提供」才知道该等什么（design.md 决策 12）。
 */

/** 路径参数解析成正整数，失败返回 null。 */
function parseId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

export function createExtractionRouter(db: Db, queue?: JobQueue): Router {
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
    // 音视频要「认出」文字，得跑本地语音模型，因此入队。
    if (isSubtitleExtension(asset.ext)) {
      sendResult(res, importSubtitleText(db, id))
      return
    }

    if (isMediaKind(asset.kind)) {
      if (!queue) {
        // 队列没接上（例如某个测试只关心别的路由）。如实说清楚，
        // 而不是退回同步执行——那会让一次请求挂上几十分钟。
        sendResult(res, err('NOT_IMPLEMENTED', '提取任务队列未启用'), 501)
        return
      }

      const job = queue.enqueue('extract', id)
      if (!job.ok) {
        sendResult(res, job)
        return
      }
      // 202 而不是 200：活儿还没干完，返回的只是「受理了」。
      // 用 200 会让调用方以为拿到的就是提取结果。
      sendResult(res, ok({ jobId: job.value.id }), 202)
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
