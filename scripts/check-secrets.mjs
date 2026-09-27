#!/usr/bin/env node
/**
 * 提交前的密钥泄漏扫描。
 *
 * 用 Node 而不是 grep，有两个原因：
 *   1. Windows 上 grep 不保证存在，而本项目明确面向 Windows 用户；
 *   2. 需要排除测试文件——那里的假密钥是**故意**写的，
 *      用一条 `grep -r "sk-ant-"` 只会每次都报一堆假警报，
 *      而一个总在报警的检查等于没有检查。
 *
 * 检查两件事：
 *   - 源码里出现真实形态的 Anthropic 密钥（排除 *.test.ts / *.test.tsx）
 *   - 凭证文件与索引库误入版本库
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Anthropic 的密钥前缀；后面跟够长的字符才当作真命中，避免误伤文档里的占位符 */
const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{20,}/g

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite'])
/** 测试文件里的密钥全是刻意构造的夹具，扫它们只会淹没真信号 */
const isTestFile = (name) => /\.test\.tsx?$/.test(name) || /\.spec\.tsx?$/.test(name)

const findings = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    if (isTestFile(entry.name)) continue
    if (!/\.(ts|tsx|js|mjs|cjs|json|md|ya?ml)$/.test(entry.name)) continue

    const file = path.join(dir, entry.name)
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(KEY_PATTERN)) {
      const line = text.slice(0, match.index).split('\n').length
      findings.push(`${path.relative(ROOT, file)}:${line}  出现疑似真实密钥 ${match[0].slice(0, 12)}…`)
    }
  }
}

walk(ROOT)

// 凭证文件与索引库绝不能被 git 跟踪。用 git 自己判断，
// 而不是重新实现一遍 .gitignore 的语义。
try {
  const tracked = execFileSync('git', ['ls-files', 'data/'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  for (const file of tracked) {
    findings.push(`${file}  已被 git 跟踪——凭证与索引绝不能进版本库`)
  }
} catch {
  // 不在 git 仓库里（例如解压了一份源码）就跳过这一项
}

if (findings.length > 0) {
  console.error('发现 %d 处问题：\n', findings.length)
  for (const f of findings) console.error('  ' + f)
  console.error('\n若这是误报（例如文档里的示例密钥），请调整 scripts/check-secrets.mjs 的判定。')
  process.exit(1)
}

console.log('密钥扫描通过：源码中无真实密钥，data/ 未被跟踪。')
