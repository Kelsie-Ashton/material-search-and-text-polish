import { redactText, redactValue } from './redact.js'

/**
 * 全项目错误码的唯一真相。
 *
 * 新增错误码时，`shared/http.ts` 的 `STATUS_BY_CODE` 会因为
 * `Record<ErrorCode, number>` 而编译失败——这是刻意的，
 * 强制每个错误码都必须明确自己的 HTTP 语义。
 */
export type ErrorCode =
  // 通用
  | 'INTERNAL'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'NOT_IMPLEMENTED'
  // 凭证
  | 'CREDENTIALS_NOT_CONFIGURED'
  | 'CREDENTIALS_INVALID'
  | 'CREDENTIALS_FORBIDDEN'
  | 'CREDENTIALS_MODEL_NOT_FOUND'
  | 'CREDENTIALS_RATE_LIMITED'
  | 'CREDENTIALS_BILLING'
  | 'CREDENTIALS_NETWORK'
  | 'CREDENTIALS_UPSTREAM'
  | 'CREDENTIALS_STORE_CORRUPT'
  | 'CREDENTIALS_STORE_WRITE_FAILED'
  // 素材库
  | 'DIRECTORY_NOT_FOUND'
  | 'DIRECTORY_DUPLICATE'
  | 'DIRECTORY_NOT_DIRECTORY'
  | 'DIRECTORY_UNREADABLE'
  | 'ASSET_NOT_FOUND'
  // 扫描
  | 'SCAN_ALREADY_RUNNING'
  | 'SCAN_DIRECTORY_MISSING'
  // 标签
  | 'TAG_NAME_INVALID'
  | 'TAG_NOT_FOUND'
  // 检索
  | 'SEARCH_QUERY_EMPTY'
  | 'SEARCH_QUERY_TOO_LONG'
  // 提取
  | 'EXTRACTION_UNSUPPORTED_TYPE'
  | 'EXTRACTION_ENGINE_UNAVAILABLE'
  | 'EXTRACTION_FFMPEG_FAILED'
  | 'EXTRACTION_NO_CONTENT'
  | 'EXTRACTION_CANCELLED'
  | 'EXTRACTION_FAILED'
  // 任务
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_CANCELLABLE'
  // 润色
  | 'POLISH_INPUT_TOO_LARGE'

export interface AppErrorShape {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

/**
 * 业务错误的值对象。
 *
 * 刻意**不继承 Error**：本项目的可预期失败一律通过 `Result` 返回，
 * 而不是抛出。不继承 Error 就没有 stack、也就没有「顺手 throw 一下」的诱惑。
 * 只有「不该发生」的编程错误才 throw，由全局 error middleware 兜底。
 */
export class AppError {
  readonly code: ErrorCode
  readonly message: string
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    this.code = code
    // 擦除是构造责任，不指望每个调用点自觉。
    this.message = redactText(message)
    this.details = details
      ? (redactValue(details) as Record<string, unknown>)
      : undefined
  }

  toJSON(): AppErrorShape {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message }
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T = never>(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Result<T> {
  return { ok: false, error: new AppError(code, message, details) }
}

/** 成功时取出值，失败时抛出——仅供「已经确认成功」的调用点使用，不要用于分支判断。 */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`对失败的 Result 调用了 unwrap：${result.error.code}`)
  }
  return result.value
}
