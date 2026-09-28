import type { Response } from 'express'

import { type AppError, type ErrorCode, type Result } from './result.js'

/**
 * 错误码 → HTTP 状态码。
 *
 * 全项目**只有这一处**做这个映射。业务代码只负责挑选语义正确的错误码，
 * 不再各自决定状态码，否则同一个 `DIRECTORY_NOT_FOUND`
 * 会在不同路由里返回 404 和 400 两种结果。
 */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INTERNAL: 500,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  NOT_IMPLEMENTED: 501,
  // 403 而不是 400：请求本身是合法的，只是不该来自这里
  REQUEST_NOT_LOCAL: 403,

  // 凭证类：语义上都是「上游不让我们干活」，逐个区分是为了让 UI 给出准确指引
  CREDENTIALS_NOT_CONFIGURED: 409,
  CREDENTIALS_INVALID: 401,
  CREDENTIALS_FORBIDDEN: 403,
  CREDENTIALS_MODEL_NOT_FOUND: 404,
  CREDENTIALS_RATE_LIMITED: 429,
  CREDENTIALS_BILLING: 402,
  CREDENTIALS_NETWORK: 503,
  CREDENTIALS_UPSTREAM: 502,
  CREDENTIALS_STORE_CORRUPT: 500,
  CREDENTIALS_STORE_WRITE_FAILED: 500,

  DIRECTORY_NOT_FOUND: 404,
  DIRECTORY_DUPLICATE: 409,
  DIRECTORY_NOT_DIRECTORY: 400,
  DIRECTORY_UNREADABLE: 422,
  ASSET_NOT_FOUND: 404,

  SCAN_ALREADY_RUNNING: 409,
  SCAN_DIRECTORY_MISSING: 422,

  TAG_NAME_INVALID: 400,
  TAG_NOT_FOUND: 404,

  SEARCH_QUERY_EMPTY: 400,
  SEARCH_QUERY_TOO_LONG: 400,

  EXTRACTION_UNSUPPORTED_TYPE: 422,
  EXTRACTION_ENGINE_UNAVAILABLE: 503,
  EXTRACTION_FFMPEG_FAILED: 500,
  EXTRACTION_NO_CONTENT: 422,
  // 409 而不是 500：用户主动停止不是服务端出错，
  // 用一个 5xx 会让日志里出现一条查不出原因的「服务端错误」。
  EXTRACTION_CANCELLED: 409,
  EXTRACTION_FAILED: 500,

  JOB_NOT_FOUND: 404,
  JOB_NOT_CANCELLABLE: 409,

  POLISH_INPUT_TOO_LARGE: 413,
}

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code]
}

/** 把 `Result` 写成 HTTP 响应。所有路由都用它，不各自拼 JSON 形状。 */
export function sendResult<T>(
  res: Response,
  result: Result<T>,
  successStatus = 200,
): void {
  if (result.ok) {
    res.status(successStatus).json({ ok: true, value: result.value })
    return
  }
  sendError(res, result.error)
}

export function sendError(res: Response, error: AppError): void {
  res.status(statusFor(error.code)).json({ ok: false, error: error.toJSON() })
}
