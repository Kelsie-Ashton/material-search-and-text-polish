import { Router } from 'express'

import { probeCredentials } from '../credentials/probe.js'
import type { CredentialsStore } from '../credentials/store.js'
import { sendResult } from '../shared/http.js'
import { err } from '../shared/result.js'

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 凭证相关路由。
 *
 * store 由参数注入而不是直接 import 单例：测试必须能指向临时文件，
 * 绝不能碰用户真实的 data/credentials.json。
 */
export function createSettingsRouter(store: CredentialsStore): Router {
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

  return router
}
