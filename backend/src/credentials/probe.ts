import { createAnthropicProvider } from '../llm/provider.js'
import type { Result } from '../shared/result.js'
import type { Credentials } from './store.js'

export interface ProbeSuccess {
  model: string
  inputTokens: number
}

/**
 * 凭证连通性测试。
 *
 * **实现只有一份**：真正的调用与失败分类都在 `llm/provider.ts` 里
 * （`verifyCredential`）——因为润色要的是同一件事，两条路径必须给出
 * 同一个错误码，否则设置页说「凭证无效」而润色说「网络错误」，用户无从判断信谁。
 *
 * 这个函数保留下来，只是为了让调用点读起来是「测试连通性」而不是
 * 「建一个 provider 然后调它的第二个方法」。
 */
export async function probeCredentials(credentials: Credentials): Promise<Result<ProbeSuccess>> {
  // 用 countTokens 而不是真的生成一段文本：同样要经过鉴权与配额校验，
  // 却**不产生任何生成 token**，因此用户点几次「测试」都不会花钱。
  return createAnthropicProvider(credentials).verifyCredential()
}
