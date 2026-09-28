import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCredentialsStore, credentialsStore } from './store.js'

const REAL_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'))
  file = path.join(dir, 'credentials.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('文件不存在（首次运行的正常状态）', () => {
  it('读取明文返回 null，而不是报错', () => {
    const store = createCredentialsStore(file)
    const result = store.readRaw()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeNull()
  })

  it('状态是「未配置」，且读取行为不会创建文件', () => {
    const store = createCredentialsStore(file)

    expect(store.readStatus()).toEqual({ ok: true, value: { configured: false } })
    expect(store.getAvailability()).toEqual({ available: false, reason: 'not_configured' })
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('正常读写', () => {
  it('保存后能读到明文，状态里只有末四位', () => {
    const store = createCredentialsStore(file)

    const saved = store.save({ apiKey: REAL_KEY })
    expect(saved.ok).toBe(true)
    if (saved.ok) {
      expect(saved.value.configured).toBe(true)
      expect(saved.value.maskedKey).toBe('****6789')
      expect(saved.value.model).toBe('claude-opus-5')
    }

    const raw = store.readRaw()
    expect(raw.ok).toBe(true)
    if (raw.ok) expect(raw.value?.apiKey).toBe(REAL_KEY)

    const status = store.readStatus()
    expect(status.ok).toBe(true)
    if (status.ok) {
      // 这一条是脱敏的核心断言：状态对象里除了末四位，不能出现密钥的任何其他部分
      const serialized = JSON.stringify(status.value)
      expect(serialized).not.toContain(REAL_KEY)
      expect(serialized).not.toContain(REAL_KEY.slice(0, 20))
    }
  })

  it('前后空白会被裁掉 —— 粘贴时常带上换行', () => {
    const store = createCredentialsStore(file)
    store.save({ apiKey: `  ${REAL_KEY}\n` })

    const raw = store.readRaw()
    if (raw.ok) expect(raw.value?.apiKey).toBe(REAL_KEY)
  })

  it('可以保存自定义模型与 baseUrl', () => {
    const store = createCredentialsStore(file)
    store.save({ apiKey: REAL_KEY, model: 'claude-sonnet-5', baseUrl: 'https://proxy.example.com' })

    const raw = store.readRaw()
    if (raw.ok) {
      expect(raw.value?.model).toBe('claude-sonnet-5')
      expect(raw.value?.baseUrl).toBe('https://proxy.example.com')
    }
  })

  it('重复保存会覆盖，且可用性变为 true', () => {
    const store = createCredentialsStore(file)
    store.save({ apiKey: REAL_KEY })
    store.save({ apiKey: 'sk-ant-api03-Second0000000000000000000000000000' })

    const raw = store.readRaw()
    if (raw.ok) expect(raw.value?.apiKey).toBe('sk-ant-api03-Second0000000000000000000000000000')

    expect(store.getAvailability()).toEqual({ available: true, model: 'claude-opus-5' })
    // 临时文件不应残留
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('清除后文件消失，回到未配置', () => {
    const store = createCredentialsStore(file)
    store.save({ apiKey: REAL_KEY })

    expect(store.clear()).toEqual({ ok: true, value: { cleared: true } })
    expect(fs.existsSync(file)).toBe(false)
    expect(store.getAvailability()).toEqual({ available: false, reason: 'not_configured' })

    // 对不存在的文件再清一次不是错误
    expect(store.clear()).toEqual({ ok: true, value: { cleared: false } })
  })
})

describe('文件损坏', () => {
  it('非法 JSON 返回 CREDENTIALS_STORE_CORRUPT，并原样保留文件', () => {
    const broken = '{ 这不是 JSON'
    fs.writeFileSync(file, broken, 'utf8')
    const store = createCredentialsStore(file)

    const status = store.readStatus()
    expect(status.ok).toBe(false)
    if (!status.ok) {
      expect(status.error.code).toBe('CREDENTIALS_STORE_CORRUPT')
      // 错误信息里不能夹带文件内容——它可能包含用户手改过的一半密钥
      expect(status.error.message).not.toContain('这不是 JSON')
    }

    // 关键：不得静默清空。一次写坏就永久丢失用户的 Key，是不可接受的语义。
    expect(fs.readFileSync(file, 'utf8')).toBe(broken)
    expect(store.getAvailability()).toEqual({ available: false, reason: 'store_corrupt' })
  })

  it('合法 JSON 但缺少 apiKey 同样视为损坏且保留文件', () => {
    const content = JSON.stringify({ version: 1, model: 'claude-opus-5' }, null, 2)
    fs.writeFileSync(file, content, 'utf8')
    const store = createCredentialsStore(file)

    const result = store.readStatus()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CREDENTIALS_STORE_CORRUPT')
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
  })

  it('不给新 Key 时不会覆盖损坏的文件', () => {
    fs.writeFileSync(file, '{ 坏掉的内容', 'utf8')
    const store = createCredentialsStore(file)

    const result = store.save({ model: 'claude-sonnet-5' })
    expect(result.ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ 坏掉的内容')
  })

  it('提供新 Key 时可以从损坏状态自救', () => {
    fs.writeFileSync(file, '{ 坏掉的内容', 'utf8')
    const store = createCredentialsStore(file)

    // 这是唯一的自救路径：没有它，用户会被一个坏文件永久挡在门外。
    expect(store.save({ apiKey: REAL_KEY }).ok).toBe(true)
    expect(store.getAvailability()).toEqual({ available: true, model: 'claude-opus-5' })
  })
})

describe('不重填 Key 也能改其他设置', () => {
  it('省略 apiKey 时保留原密钥，只更新模型与代理地址', () => {
    const store = createCredentialsStore(file)
    store.save({ apiKey: REAL_KEY })

    store.save({ model: 'claude-sonnet-5', baseUrl: 'https://proxy.example.com' })

    const raw = store.readRaw()
    if (raw.ok) {
      expect(raw.value?.apiKey).toBe(REAL_KEY)
      expect(raw.value?.model).toBe('claude-sonnet-5')
      expect(raw.value?.baseUrl).toBe('https://proxy.example.com')
    }
  })

  it('显式传空 baseUrl 可以清除代理地址', () => {
    const store = createCredentialsStore(file)
    store.save({ apiKey: REAL_KEY, baseUrl: 'https://proxy.example.com' })
    store.save({ baseUrl: '' })

    const raw = store.readRaw()
    if (raw.ok) expect(raw.value?.baseUrl).toBeUndefined()
  })

  it('尚无任何凭证时省略 apiKey 会报错', () => {
    const store = createCredentialsStore(file)
    const result = store.save({ model: 'claude-sonnet-5' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('输入校验', () => {
  it('空 Key 被拒绝', () => {
    const store = createCredentialsStore(file)
    const result = store.save({ apiKey: '   ' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('把脱敏后的显示值当成 Key 存回去会被挡下', () => {
    const store = createCredentialsStore(file)

    // 用户全选复制输入框里的掩码再保存，是完全可能发生的事。
    const result = store.save({ apiKey: '****6789' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('脱敏函数', () => {
  it('保留末四位，短 Key 全部隐藏', () => {
    const store = createCredentialsStore(file)
    store.save({ apiKey: 'abcd' })

    const raw = store.readRaw()
    if (raw.ok) expect(raw.value?.apiKey).toBe('abcd')

    const status = store.readStatus()
    if (status.ok) expect(status.value.maskedKey).toBe('****')
  })
})

/**
 * 测试套件的护栏本身。
 *
 * 这条测的是「护栏还在」——一个静默失效的护栏比没有护栏更糟：
 * 它会让人以为自己被保护着。
 */
describe('真实单例在测试里的护栏', () => {
  it('一被用到就抛错，而不是去读用户真实的 data/credentials.json', () => {
    // 这条护栏是踩出来的：一个忘了注入 credentialsStore 的测试
    // 读着真实密钥、向真实地址发出了**真实且要花钱**的请求，
    // 而且断言在本机「通过」、在干净环境必然失败。
    expect(() => credentialsStore.readRaw()).toThrow(/不能碰真实的凭证存储/)
    expect(() => credentialsStore.getAvailability()).toThrow(/不能碰真实的凭证存储/)
  })

  it('报错信息里给出正确的写法', () => {
    // 只报「不许用」而不说该怎么办，下一个人只会把护栏删掉
    expect(() => credentialsStore.save({ apiKey: 'x' })).toThrow(/createCredentialsStore/)
  })
})
