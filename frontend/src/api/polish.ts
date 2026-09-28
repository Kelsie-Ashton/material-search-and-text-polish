import { apiGet, apiPost } from './client'

/**
 * 润色的接口封装（第二批）。
 *
 * 与提取那条路径的关键差别：**这里是同步的**。后端要十几秒到一分钟，
 * 但还在一次请求能承受的范围里，所以没有任务 id、不用轮询——
 * 这也是当前版本还没有「调用前取消」的原因（用户取消了也没用，请求已经发出去了）。
 */

interface Envelope<T> {
  ok: true
  value: T
}

async function unwrap<T>(promise: Promise<unknown>): Promise<T> {
  const payload = (await promise) as Envelope<T>
  return payload.value
}

/** 对应 backend/src/polish/results.ts 的 PolishedResult */
export interface PolishedResult {
  id: number
  assetId: number
  body: string
  model: string
  promptVersion: string
  /** 云端返回的用量。为 null 表示这次没拿到，不代表没花钱 */
  inputTokens: number | null
  outputTokens: number | null
  createdAt: number
}

export interface PolishFailure {
  code: string
  message: string
  createdAt: number
}

export interface PolishState {
  /** 当前生效的润色结果。null 表示还没有成功过 */
  result: PolishedResult | null
  /** 最近一次失败的原因。与 result 是两个独立的事实，要分开看 */
  lastFailure: PolishFailure | null
}

/** 读这个素材当前的润色结果与上次失败原因。不会发起云端调用，不花钱。 */
export function fetchPolish(assetId: number): Promise<PolishState> {
  return unwrap<PolishState>(apiGet(`/api/polish/assets/${assetId}`))
}

/**
 * 跑一次润色。
 *
 * **会发出一次真实的云端调用，产生费用**，所以调用点必须由用户明确点击触发，
 * 不能放在 useEffect 之类会自动跑的地方。
 *
 * 失败时抛 `ApiRequestError`，`code` 区分了失败类型——
 * `CREDENTIALS_NOT_CONFIGURED` 要引导去设置页，`CREDENTIALS_BILLING` 要去充值，
 * 两者给同一句「失败了」等于没说。
 */
export function runPolish(assetId: number): Promise<{ status: 'done'; result: PolishedResult }> {
  return unwrap<{ status: 'done'; result: PolishedResult }>(apiPost(`/api/polish/assets/${assetId}`))
}
