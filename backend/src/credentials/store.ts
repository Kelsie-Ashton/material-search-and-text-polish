import fs from 'node:fs'
import path from 'node:path'

import { credentialsFile } from '../config.js'
import { err, ok, type Result } from '../shared/result.js'
import { looksMasked, maskApiKey } from './mask.js'

/** 默认模型。用户可在设置界面改成其他可用模型。 */
export const DEFAULT_MODEL = 'claude-opus-5'

const STORE_VERSION = 1

export interface Credentials {
  apiKey: string
  model: string
  baseUrl?: string
}

export interface CredentialsInput {
  /**
   * 省略表示「不修改已保存的 Key」。
   *
   * 这是必需的语义，不是便利功能：设置页只回显末四位，用户拿不到原 Key，
   * 所以「只想换个模型」这件事不能以重新粘贴密钥为前提。
   */
  apiKey?: string
  model?: string
  baseUrl?: string
}

/** 对外暴露的凭证状态，永远不含明文。 */
export interface CredentialsStatus {
  configured: boolean
  maskedKey?: string
  model?: string
  baseUrl?: string
  updatedAt?: number
}

/** 润色功能的可用性。「未配置」是最常见的初始状态，不是错误。 */
export type CredentialsAvailability =
  | { available: true; model: string }
  | { available: false; reason: 'not_configured' | 'store_corrupt' }

interface StoreFile {
  version: number
  apiKey: string
  model: string
  baseUrl?: string
  updatedAt: number
}

export interface CredentialsStore {
  /** 读取明文凭证。**唯一**接触密钥明文的地方。 */
  readRaw(): Result<Credentials | null>
  /** 读取脱敏状态，供 UI 回显。 */
  readStatus(): Result<CredentialsStatus>
  save(input: CredentialsInput): Result<CredentialsStatus>
  clear(): Result<{ cleared: boolean }>
  getAvailability(): CredentialsAvailability
}

function parseStoreFile(raw: string): Result<StoreFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return err('CREDENTIALS_STORE_CORRUPT', '凭证文件不是合法的 JSON，已保留原文件未做改动')
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err('CREDENTIALS_STORE_CORRUPT', '凭证文件结构不正确，已保留原文件未做改动')
  }

  const record = parsed as Record<string, unknown>
  const apiKey = record['apiKey']
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return err('CREDENTIALS_STORE_CORRUPT', '凭证文件缺少可用的 apiKey，已保留原文件未做改动')
  }

  const model = record['model']
  const baseUrl = record['baseUrl']
  const updatedAt = record['updatedAt']

  return ok({
    version: typeof record['version'] === 'number' ? record['version'] : STORE_VERSION,
    apiKey: apiKey.trim(),
    model: typeof model === 'string' && model.trim().length > 0 ? model.trim() : DEFAULT_MODEL,
    ...(typeof baseUrl === 'string' && baseUrl.trim().length > 0
      ? { baseUrl: baseUrl.trim() }
      : {}),
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  })
}

export function createCredentialsStore(file: string = credentialsFile): CredentialsStore {
  function read(): Result<StoreFile | null> {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (cause) {
      // 文件不存在是正常状态（首次运行），不是错误。
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(null)
      return err('CREDENTIALS_STORE_CORRUPT', '无法读取凭证文件', {
        reason: (cause as NodeJS.ErrnoException).code ?? 'unknown',
      })
    }

    return parseStoreFile(raw)
  }

  return {
    readRaw() {
      const result = read()
      if (!result.ok) return result
      if (result.value === null) return ok(null)

      const { apiKey, model, baseUrl } = result.value
      return ok({ apiKey, model, ...(baseUrl ? { baseUrl } : {}) })
    },

    readStatus() {
      const result = read()
      if (!result.ok) return result
      if (result.value === null) return ok({ configured: false })

      const stored = result.value
      return ok({
        configured: true,
        maskedKey: maskApiKey(stored.apiKey),
        model: stored.model,
        ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
        updatedAt: stored.updatedAt,
      })
    },

    save(input) {
      const provided = input.apiKey?.trim()

      if (provided !== undefined && provided.length === 0) {
        return err('VALIDATION_FAILED', 'API Key 不能为空')
      }
      // 用户全选复制输入框里的掩码再保存，是完全可能发生的事。
      if (provided !== undefined && looksMasked(provided)) {
        return err('VALIDATION_FAILED', '这看起来是脱敏后的显示值，请粘贴完整的 API Key')
      }

      const existing = read()
      // 存储损坏时，只要用户明确提供了新 Key 就允许覆盖——这是唯一的自救路径，
      // 否则用户会被一个坏文件永久挡在门外。没提供则报错，因为无从「保留」。
      if (!existing.ok && provided === undefined) return existing

      const stored = existing.ok ? existing.value : null

      const apiKey = provided ?? stored?.apiKey
      if (apiKey === undefined) {
        return err('VALIDATION_FAILED', '请填写 API Key')
      }

      const model = input.model === undefined ? stored?.model ?? DEFAULT_MODEL : input.model.trim() || DEFAULT_MODEL
      const baseUrl =
        input.baseUrl === undefined ? stored?.baseUrl : input.baseUrl.trim() || undefined

      const payload: StoreFile = {
        version: STORE_VERSION,
        apiKey,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        updatedAt: Date.now(),
      }

      // 先写临时文件再改名：写到一半崩溃不会留下半个 JSON，
      // 也就不会出现「用户的 Key 被自己的一次保存弄丢」。
      const tempFile = `${file}.tmp`
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        fs.renameSync(tempFile, file)
      } catch (cause) {
        try {
          fs.rmSync(tempFile, { force: true })
        } catch {
          // 清理临时文件失败不影响主流程
        }
        return err('CREDENTIALS_STORE_WRITE_FAILED', '无法写入凭证文件，请检查数据目录权限', {
          reason: (cause as NodeJS.ErrnoException).code ?? 'unknown',
        })
      }

      return ok({
        configured: true,
        maskedKey: maskApiKey(apiKey),
        model,
        ...(baseUrl ? { baseUrl } : {}),
        updatedAt: payload.updatedAt,
      })
    },

    clear() {
      const existed = fs.existsSync(file)
      try {
        fs.rmSync(file, { force: true })
      } catch (cause) {
        return err('CREDENTIALS_STORE_WRITE_FAILED', '无法删除凭证文件', {
          reason: (cause as NodeJS.ErrnoException).code ?? 'unknown',
        })
      }
      return ok({ cleared: existed })
    },

    getAvailability() {
      const result = read()
      if (!result.ok) return { available: false, reason: 'store_corrupt' }
      if (result.value === null) return { available: false, reason: 'not_configured' }
      return { available: true, model: result.value.model }
    },
  }
}

/**
 * 生产用的单例。
 *
 * 注意 mode 0o600 在 Windows 上基本无效——真实的保护来自
 * .gitignore（不把 data/ 提交）与用户目录自身的 ACL。
 * README 里会如实说明，不假装这是强隔离。
 */
export const credentialsStore = createCredentialsStore()

/**
 * 给测试套件加一道闸：**真实单例在测试里一被用到就抛错。**
 *
 * 为什么要有它。测试里写 `createApp({ db })` 而忘了注入 `credentialsStore` 时，
 * 落到的是上面那个指向用户真实 `data/credentials.json` 的单例。于是测试会
 * 读着真实密钥、向真实地址发出**真实且要花钱**的请求，而结果依赖本机
 * 恰好配着什么——在开发机上「通过」，在干净环境必然失败。
 *
 * 加「畸形请求体」那组用例时就这么踩了一次：`POST /api/settings/credentials/test`
 * 返回了 200，因为本机存着可用凭证，请求真的发出去并且成功了。
 *
 * **闸装在这里而不是 createApp 里，是为了精确。** 装在 createApp 里的话，
 * 每个 `createApp({ db })` 都得注入一个它根本用不到的存储，纯属仪式；
 * 而真正危险的动作只有一个——**碰真实凭证**。所以拦的是这个动作本身。
 *
 * 用 `process.env['VITEST']` 而不是 NODE_ENV：vitest 一定会设前者，
 * 而后者常被别的脚本改来改去。
 */
if (process.env['VITEST'] !== undefined) {
  for (const method of ['readRaw', 'readStatus', 'save', 'clear', 'getAvailability'] as const) {
    Object.defineProperty(credentialsStore, method, {
      value: () => {
        throw new Error(
          `测试不能碰真实的凭证存储（调用了 credentialsStore.${method}）。` +
            `请注入一个临时文件：createApp({ credentialsStore: createCredentialsStore(tmpFile) })。`,
        )
      },
    })
  }
}
