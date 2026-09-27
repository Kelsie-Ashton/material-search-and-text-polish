// tsc 只编译 .ts，不会把 schema.sql 带到 dist。
// 用 Node 脚本而不是 `cp`，因为 npm 在 Windows 上默认走 cmd.exe，没有 cp。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(here, '..', 'src')
const outDir = path.join(here, '..', 'dist')

function copyByExtension(dir, ext) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      copyByExtension(from, ext)
      continue
    }
    if (path.extname(entry.name) !== ext) continue

    const to = path.join(outDir, path.relative(srcDir, from))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    console.log(`已复制 ${path.relative(outDir, to)}`)
  }
}

copyByExtension(srcDir, '.sql')
