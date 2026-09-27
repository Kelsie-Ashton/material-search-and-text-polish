export interface ApiErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** 后端返回的结构化错误，已按错误码分类 */
export class ApiRequestError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiRequestError'
    this.code = body.code
    this.details = body.details
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  } catch (cause) {
    throw new ApiRequestError({
      code: 'NETWORK_ERROR',
      message: '无法连接到本地服务，请确认后端已启动',
    })
  }

  const payload: unknown = await res.json().catch(() => null)

  if (!res.ok) {
    const body = payload as { error?: ApiErrorBody } | null
    throw new ApiRequestError(
      body?.error ?? { code: `HTTP_${res.status}`, message: `请求失败（${res.status}）` },
    )
  }

  return payload as T
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) })
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

/** 把任意异常转成面向用户的中文提示 */
export function toUserMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  if (err instanceof Error) return err.message
  return '发生未知错误'
}
