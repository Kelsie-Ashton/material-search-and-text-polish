import { apiDelete, apiGet, apiPost, apiPut } from './client'

/** 后端所有成功响应都包在 { ok: true, value } 里，这里统一拆掉信封。 */
interface Envelope<T> {
  ok: true
  value: T
}

async function unwrap<T>(promise: Promise<unknown>): Promise<T> {
  const payload = (await promise) as Envelope<T>
  return payload.value
}

/** 凭证状态。永远不含明文——后端只回显末四位。 */
export interface CredentialsStatus {
  configured: boolean
  maskedKey?: string
  model?: string
  baseUrl?: string
  updatedAt?: number
}

export interface CredentialsInput {
  /** 省略表示不修改已保存的 Key */
  apiKey?: string
  model?: string
  /** 传空字符串表示清除代理地址 */
  baseUrl?: string
}

/** 润色可用性。「未配置」是降级状态，不是错误。 */
export type PolishAvailability =
  | { available: true; model: string }
  | { available: false; reason: 'not_configured' | 'store_corrupt' }

export interface ProbeResult {
  model: string
  inputTokens: number
}

export function getCredentials(): Promise<CredentialsStatus> {
  return unwrap<CredentialsStatus>(apiGet('/api/settings/credentials'))
}

export function saveCredentials(input: CredentialsInput): Promise<CredentialsStatus> {
  return unwrap<CredentialsStatus>(apiPut('/api/settings/credentials', input))
}

export function testCredentials(): Promise<ProbeResult> {
  return unwrap<ProbeResult>(apiPost('/api/settings/credentials/test'))
}

export function clearCredentials(): Promise<{ cleared: boolean }> {
  return unwrap<{ cleared: boolean }>(apiDelete('/api/settings/credentials'))
}

export function getPolishAvailability(): Promise<PolishAvailability> {
  return unwrap<PolishAvailability>(apiGet('/api/settings/polish-availability'))
}
