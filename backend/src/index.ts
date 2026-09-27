import fs from 'node:fs'

import { createApp } from './app.js'
import { dataDir, databaseFile, host, port } from './config.js'
import { openDatabase } from './db/index.js'
import { migrate } from './db/migrate.js'
import { reconcileAssetStatus, watchExtractJobs } from './extraction/asset-status.js'
import { registerJobHandlers } from './jobs/handlers.js'
import { createJobQueue } from './jobs/queue.js'

fs.mkdirSync(dataDir, { recursive: true })

const db = openDatabase()
migrate(db)

const jobQueue = createJobQueue(db)

// 提取任务一落定就把素材状态重新推导一次。挂在这里而不是处理器里，
// 是因为处理器结束的那一刻 job 行还是 running（见 asset-status.ts 的说明）。
watchExtractJobs(jobQueue, db)

// 顺序要紧：先注册处理器，再恢复上次残留的任务。
// 反过来的话，恢复出来的任务会在处理器就位之前被取走，
// 直接因为「没有注册处理器」而失败。
registerJobHandlers(jobQueue, db)

// 上次进程被强杀时留在 running 的任务，不重置就会永远卡住，
// 队列再也取不到它——一次崩溃就能让扫描功能永久失效。
const recovered = jobQueue.recoverInterrupted()
if (recovered > 0) {
  console.log(`已把 ${recovered} 个上次中断的任务放回队列`)
}

// 队列恢复了不算完：素材那一侧的 extract_status 是另一张表上的物化列，
// recoverInterrupted 管不到它。必须在这里再对一次账，否则上次被杀时正在跑的
// 素材会永远显示「提取中」而没有任何东西在跑，用户只能干等。
// 顺序也要紧：必须在 recoverInterrupted **之后**，否则被重置回 queued 的任务
// 会被当作活跃任务，把素材状态又推回「排队中」。
const reconciled = reconcileAssetStatus(db)
if (reconciled > 0) {
  console.log(`已修正 ${reconciled} 个素材的提取状态`)
}

// 恢复只改状态、不启动消费，所以这一句不能省：
// 少了它，上面恢复出来的任务会永远停在「排队中」。
jobQueue.start()

const app = createApp({ db, jobQueue })

const server = app.listen(port, host, () => {
  console.log(`后端已启动：http://${host}:${port}`)
  console.log(`数据目录：${dataDir}`)
  console.log(`索引数据库：${databaseFile}`)
})

/** 关闭时最多等多久让正在跑的任务收尾。超时就硬关——用户按了 Ctrl+C 就是想走。 */
const SHUTDOWN_GRACE_MS = 10_000

let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // 连按两次 Ctrl+C 是「别等了，立刻退」。不接住的话第二次会被默认行为杀掉，
    // 数据库没来得及关——虽然 SQLite 能恢复，但没必要赌。
    if (shuttingDown) {
      console.log('\n强制退出。')
      process.exit(1)
    }
    shuttingDown = true

    console.log(`\n收到 ${signal}，正在关闭服务…`)

    // 先停止接收新请求，再等队列空闲。反过来的话，
    // 等待期间进来的请求还能再入队，whenIdle 就永远等不到头。
    server.close(() => {
      // 这里不能立刻 close(db)：扫描可能正跑在一批提交之间，
      // 硬关会让这一批的进度的记录状态与磁盘不一致。
      const timeout = setTimeout(() => {
        console.warn(`等待任务收尾超过 ${SHUTDOWN_GRACE_MS / 1000} 秒，直接退出。`)
        db.close()
        process.exit(0)
      }, SHUTDOWN_GRACE_MS)

      void jobQueue.whenIdle().then(() => {
        clearTimeout(timeout)
        console.log('任务队列已空闲。')
        db.close()
        process.exit(0)
      })
    })
  })
}
