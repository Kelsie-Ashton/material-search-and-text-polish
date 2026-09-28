import { Router } from 'express'

import type { Db } from '../db/index.js'
import { syncAssetExtractStatus } from '../extraction/asset-status.js'
import {
  DIRECT_IMPORT_EXTENSIONS,
  canImportDirectly,
  importTextFile,
  listSegments,
} from '../extraction/importer.js'
import { isMediaKind } from '../extraction/media.js'
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

    // 提取按文件类型分派。文本类素材（字幕与纯文本）的文字本就现成，
    // 读出来即可；音视频要「认出」文字，得跑本地语音模型，因此入队。
    //
    // 两条路径的**返回形状不同**（一条同步给结果，一条只给任务 id），
    // 而调用方必须能分辨自己拿到的是哪一种。所以两条各自带上 `mode`，
    // 让这个分派结果写在响应里，而不是让前端靠「有没有 jobId 字段」去猜——
    // 那种猜法在形状变动时会静默认错，而这正是本文件开头那两条路径的核心区别。
    if (canImportDirectly(asset.ext)) {
      const imported = importTextFile(db, id)
      sendResult(res, imported.ok ? ok({ mode: 'imported' as const, ...imported.value }) : imported)
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

      // 立刻把素材推进到「提取中」（spec：界面立即返回并将状态置为提取中）。
      // 同步推导会读到刚入队的任务，所以这里不需要另一套赋值逻辑。
      // 不这样做的话，素材在 worker 取到它之前一直显示「未提取」——
      // 排在长队列后面时，用户点完提取看不到任何反应，只能反复点。
      const status = syncAssetExtractStatus(db, id)

      // 202 而不是 200：活儿还没干完，返回的只是「受理了」。
      // 用 200 会让调用方以为拿到的就是提取结果。
      sendResult(res, ok({ mode: 'queued' as const, jobId: job.value.id, status }), 202)
      return
    }

    // 「图片」与「没能直接读取的文本」要走两条不同的说辞，不能共用一句话。
    //
    // 图片确实需要识别引擎（OCR），而 OCR 已按评估结论挂起（见 README 的未来规划）。
    //
    // 但文本文件说它「需要识别引擎」是错的——用户会以为程序连读个 txt
    // 都要下模型，然后往完全错误的方向排查。
    //
    // 这条 `kind === 'text'` 分支现在其实走不到：config.ts 里 text 那一档的
    // 扩展名与 DIRECT_IMPORT_EXTENSIONS 完全一致，扫描器认作文本的都能直接导入
    // （有一条测试钉住这个不变量）。留着它是为了「往 config 里加了扩展名、
    // 却忘了在 importer 里接上」这种情况仍有一个说得通的回答。
    const message =
      asset.kind === 'text'
        ? `「${asset.ext}」是文本文件，但目前还不能直接读进索引。` +
          `可以读取的是：${DIRECT_IMPORT_EXTENSIONS.join(' / ')}。`
        : `「${asset.ext}」的文字提取需要本地识别引擎（OCR），` +
          `当前版本暂不提供。现在可以直接导入的是文本与字幕` +
          `（${DIRECT_IMPORT_EXTENSIONS.join(' / ')}），音频与视频可以走语音转写。`

    sendResult(res, err('NOT_IMPLEMENTED', message, { ext: asset.ext, kind: asset.kind }))
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
