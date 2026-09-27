import fs from 'node:fs'
import path from 'node:path'

import express, { type ErrorRequestHandler, Router } from 'express'

import { frontendDistDir } from './config.js'
import { type CredentialsStore, credentialsStore } from './credentials/store.js'
import type { Db } from './db/index.js'
import type { JobQueue } from './jobs/queue.js'
import { createExtractionRouter } from './routes/extraction.js'
import { createLibraryRouter } from './routes/library.js'
import { createSearchRouter } from './routes/search.js'
import { createSettingsRouter } from './routes/settings.js'

export interface AppOptions {
  /**
   * 凭证存储。默认用指向 data/credentials.json 的单例；
   * 测试注入临时文件，避免碰到用户真实的凭证。
   */
  credentialsStore?: CredentialsStore
  /** 索引数据库。与 jobQueue 同时提供时才会挂载素材库路由。 */
  db?: Db
  jobQueue?: JobQueue
}

/**
 * 组装 Express 应用。
 * 与监听分离，便于测试中直接使用 app 而不占用端口。
 */
export function createApp(options: AppOptions = {}) {
  const app = express()

  app.use(express.json({ limit: '1mb' }))

  // ---------- API ----------
  const api = Router()

  api.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'material-search-and-text-polish',
      time: Date.now(),
    })
  })

  // 凭证路由不需要 db；偏好路由需要，因此 db 可缺省（见 settings.ts 里的说明）
  api.use(
    '/settings',
    createSettingsRouter(options.credentialsStore ?? credentialsStore, options.db),
  )

  // 素材库路由依赖数据库与任务队列。二者缺一就不挂载——
  // 但这不是「可选功能」：真实入口 index.ts 一定会传，
  // app.test.ts 里有一条测试专门断言传了之后路由确实存在，
  // 免得哪天忘了接线却一路静默跑到线上。
  if (options.db && options.jobQueue) {
    api.use('/library', createLibraryRouter(options.db, options.jobQueue))
  }

  // 检索只读数据库，不需要任务队列，故单独判断
  if (options.db) {
    api.use('/search', createSearchRouter(options.db))
  }

  // 提取需要队列，但不是硬依赖：字幕解析是毫秒级的同步操作，没有队列也能用；
  // 只有音视频转写才要求队列（它跑几分钟，不可能挂在一次请求里）。
  // 所以队列可选传入，缺失时那一条路径如实报「未启用」（extraction.ts 里有说明）
  if (options.db) {
    api.use('/extraction', createExtractionRouter(options.db, options.jobQueue))
  }

  // 后续路由（polish）在此挂载

  app.use('/api', api)

  // 未匹配的 /api 请求必须返回 JSON 404，
  // 不能落到下面的 SPA 回退——否则前端会拿到一份 HTML 却按 JSON 解析。
  app.use('/api', (_req, res) => {
    res.status(404).json({
      ok: false,
      error: { code: 'NOT_FOUND', message: '接口不存在' },
    })
  })

  // ---------- 前端静态资源 + SPA 回退 ----------
  // 开发态由 Vite dev server 提供页面，dist 尚不存在，这段整体跳过。
  if (fs.existsSync(frontendDistDir)) {
    app.use(express.static(frontendDistDir))

    app.use((req, res, next) => {
      // 只接管「浏览器导航」请求：GET/HEAD 且接受 HTML。
      // 其余（如遗留的资源请求）交回后续处理，避免把 404 也伪装成 200 页面。
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      if (!req.accepts('html')) return next()
      res.sendFile(path.join(frontendDistDir, 'index.html'))
    })
  }

  // 兜底错误处理：只处理「不该发生」的编程错误。
  // 可预期的业务失败一律通过 Result 返回，不走这里。
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error('[unhandled error]', err)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: '服务器内部错误' },
    })
  }
  app.use(errorHandler)

  return app
}
