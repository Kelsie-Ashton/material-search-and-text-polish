import fs from 'node:fs'

import { createApp } from './app.js'
import { dataDir, databaseFile, host, port } from './config.js'
import { openDatabase } from './db/index.js'
import { migrate } from './db/migrate.js'

fs.mkdirSync(dataDir, { recursive: true })

const db = openDatabase()
migrate(db)

const app = createApp()

const server = app.listen(port, host, () => {
  console.log(`后端已启动：http://${host}:${port}`)
  console.log(`数据目录：${dataDir}`)
  console.log(`索引数据库：${databaseFile}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在关闭服务…`)
    server.close(() => {
      db.close()
      process.exit(0)
    })
  })
}
