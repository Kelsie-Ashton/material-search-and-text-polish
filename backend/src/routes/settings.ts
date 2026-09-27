import { Router } from 'express'

import { probeCredentials } from '../credentials/probe.js'
import type { CredentialsStore } from '../credentials/store.js'
import type { Db } from '../db/index.js'
import { readSettings, updateSettings } from '../settings/preferences.js'
import { sendResult } from '../shared/http.js'
import { err, ok } from '../shared/result.js'

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 设置相关路由：凭证 + 应用偏好。
 *
 * 两类东西放同一个 router，是因为界面上它们同属「设置页」；
 * 但存储位置完全不同，请不要混为一谈：
 *
 * - **凭证**住 `data/credentials.json`，含明文密钥，**永远不落库**——
 *   数据库文件更容易被复制、被备份、被附在 issue 里。
 * - **偏好**住 `app_settings` 表，不含任何敏感信息，
 *   而且提取链路要频繁读它（每次落库前一次），放库里省一次文件 IO。
 *
 * store 由参数注入而不是直接 import 单例：测试必须能指向临时文件，
 * 绝不能碰用户真实的 data/credentials.json。
 */
export function createSettingsRouter(store: CredentialsStore, db?: Db): Router {
  const router = Router()

  /** 读取凭证状态。永远返回脱敏结果，明文不出这个模块。 */
  router.get('/credentials', (_req, res) => {
    sendResult(res, store.readStatus())
  })

  /** 保存凭证。请求体里的 apiKey 不会被记录、不会回显，只写进 data/credentials.json。 */
  router.put('/credentials', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>

    // apiKey 缺席表示「不修改已保存的 Key」，因此这里不做必填校验——
    // 是否真的缺 Key 由 store 结合已存内容判断（首次配置时缺了才报错）。
    sendResult(
      res,
      store.save({
        apiKey: readString(body['apiKey']),
        model: readString(body['model']),
        baseUrl: readString(body['baseUrl']),
      }),
    )
  })

  /**
   * 连通性测试。
   *
   * 测的是**已保存**的凭证，不是请求体里传来的——否则「测试通过」与
   * 「实际会用哪把钥匙」就可能不是同一件事，用户会很难理解为什么保存后仍然失败。
   */
  router.post('/credentials/test', async (_req, res) => {
    const stored = store.readRaw()
    if (!stored.ok) {
      sendResult(res, stored)
      return
    }
    if (stored.value === null) {
      sendResult(res, err('CREDENTIALS_NOT_CONFIGURED', '尚未填写 API Key，请先保存后再测试'))
      return
    }

    sendResult(res, await probeCredentials(stored.value))
  })

  /** 清除凭证。清除后润色功能停用，检索与提取不受影响。 */
  router.delete('/credentials', (_req, res) => {
    sendResult(res, store.clear())
  })

  /** 润色可用性。未配置不是错误，是降级状态，因此不走 Result。 */
  router.get('/polish-availability', (_req, res) => {
    res.json({ ok: true, value: store.getAvailability() })
  })

  // ---------- 应用偏好 ----------
  // 需要数据库，故单独判断。凭证那几条不依赖 db，缺了也照常工作——
  // 这是刻意的：凭证是「第一批」的交付内容，偏好是后来的，
  // 不该让早先能用的一组接口因为新表而整体消失。
  if (db) {
    const database = db

    /** 读取全部偏好。缺失或损坏的项已在 readSettings 里回落，这里不会失败。 */
    router.get('/preferences', (_req, res) => {
      res.json(ok(readSettings(database)))
    })

    /**
     * 更新偏好。请求体只要带 `textScript` 即可，未提供的字段保持不变。
     *
     * 返回**完整的**偏好对象而不是只回显改动项：设置页拿它整体刷新，
     * 省掉一次往返，也不会出现「界面上一半新一半旧」。
     */
    router.put('/preferences', (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      sendResult(res, updateSettings(database, { textScript: body['textScript'] }))
    })
  }

  return router
}
