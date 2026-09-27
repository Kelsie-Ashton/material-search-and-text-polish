import fs from 'node:fs'

import { createApp } from './app.js'
import { dataDir, host, port } from './config.js'

fs.mkdirSync(dataDir, { recursive: true })

const app = createApp()

const server = app.listen(port, host, () => {
  console.log(`后端已启动：http://${host}:${port}`)
  console.log(`数据目录：${dataDir}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在关闭服务…`)
    server.close(() => process.exit(0))
  })
}
