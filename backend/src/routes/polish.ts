import { Router } from 'express'

import type { CredentialsStore } from '../credentials/store.js'
import type { Db } from '../db/index.js'
import { findAsset } from '../library/assets.js'
import { polishAsset, type PolishDeps } from '../polish/service.js'
import { readCurrentPolish, readLastPolishFailure } from '../polish/results.js'
import { sendResult } from '../shared/http.js'
import { err } from '../shared/result.js'

/**
 * 润色路由（第二批：6.2 / 6.5 / 6.11）。
 *
 * ## 为什么这里是**同步**的，而提取是入队的
 *
 * 同样是「要花一会儿」的操作，两者的量级差一个数量级：转写一个视频是
 * **几分钟到几十分钟**，一次润色是**十几秒到一分钟**。前者挂在 HTTP 请求里
 * 必然超时（浏览器、代理、Node 都不答应）；后者虽然比普通接口慢，
 * 但还在一次请求能承受的范围里，而且用户此刻就盯着按钮等结果，
 * 让他再去轮询一个任务列表反而绕远。
 *
 * 代价是**做不了「调用前取消」**——请求已经发出去了。任务 6.9 要求
 * 「用户取消后不发起云端请求」，那时要把这条路径改成入队（`jobs.type`
 * 已经预留了 `polish`）。现在不改，是因为在没有取消入口之前，
 * 入队只会把「等结果」变成「等结果，但要刷两次页面」。
 */

/** 路径参数解析成正整数，失败返回 null。 */
function parseId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

export function createPolishRouter(
  db: Db,
  store: CredentialsStore,
  deps: PolishDeps = {},
): Router {
  const router = Router()

  /** 跑一次润色。会发出一次真实的云端调用，**产生费用**。 */
  router.post('/assets/:id', async (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }

    sendResult(res, await polishAsset(db, store, id, deps))
  })

  /**
   * 读这个素材当前的润色结果。
   *
   * 同时带上「上次失败的原因」：用户看到的是「没有结果」，
   * 但原因可能是「从没跑过」也可能是「跑过但失败了」——这两件事
   * 该给完全不同的提示，而只靠 `result: null` 分不出来。
   *
   * 素材不存在返回 404 而不是一个空结果：拼错的 id 拿到「没有润色结果」，
   * 会与「这条素材确实还没润色过」混为一谈（与提取那边的取舍一致）。
   */
  router.get('/assets/:id', (req, res) => {
    const id = parseId(req.params.id)
    if (id === null) {
      sendResult(res, err('VALIDATION_FAILED', '素材 id 不合法'), 400)
      return
    }

    if (!findAsset(db, id)) {
      sendResult(res, err('ASSET_NOT_FOUND', `素材不存在（id=${id}）`, { id }))
      return
    }

    res.json({
      ok: true,
      value: {
        result: readCurrentPolish(db, id),
        lastFailure: readLastPolishFailure(db, id),
      },
    })
  })

  return router
}
