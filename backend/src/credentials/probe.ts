import Anthropic from '@anthropic-ai/sdk'

import { AppError, ok, type Result } from '../shared/result.js'
import { createAnthropicClient } from './client.js'
import type { Credentials } from './store.js'

export interface ProbeSuccess {
  model: string
  inputTokens: number
}

/** 连通性测试的超时。用户点了按钮在等，不能让他对着转圈等十分钟。 */
const PROBE_TIMEOUT_MS = 15_000

/**
 * 把 SDK 异常翻译成项目错误码。
 *
 * 用类型化异常类逐级 instanceof，不做字符串匹配——错误信息会随上游改动，
 * 而异常类名是稳定的契约。
 *
 * 顺序要紧：APIConnectionError 是 APIError 的子类，必须先判断，
 * 否则网络故障会被归到「上游返回错误」这个宽泛分支里。
 */
function classify(cause: unknown, model: string): AppError {
  if (cause instanceof Anthropic.AuthenticationError) {
    return new AppError('CREDENTIALS_INVALID', 'API Key 无效或已被撤销，请在设置页重新填写')
  }
  if (cause instanceof Anthropic.PermissionDeniedError) {
    // 403 在实际使用中既可能是「Key 不对」也可能是「没有该模型权限」，
    // 上游不区分，这里也不假装能区分——给出两条可操作的排查方向。
    return new AppError(
      'CREDENTIALS_FORBIDDEN',
      '调用被拒绝：请核对 API Key 是否完整有效，以及该账号是否有权访问这个模型',
    )
  }
  if (cause instanceof Anthropic.NotFoundError) {
    return new AppError('CREDENTIALS_MODEL_NOT_FOUND', `模型「${model}」不可用，请检查模型名`, {
      model,
    })
  }
  if (cause instanceof Anthropic.RateLimitError) {
    return new AppError('CREDENTIALS_RATE_LIMITED', '请求过于频繁，请稍后再试')
  }
  // 必须先于 APIError —— 它是 APIError 的子类
  if (cause instanceof Anthropic.APIConnectionError) {
    return new AppError('CREDENTIALS_NETWORK', '无法连接到服务，请检查网络或代理设置')
  }
  if (cause instanceof Anthropic.APIError) {
    if (cause.type === 'billing_error' || cause.status === 402) {
      return new AppError('CREDENTIALS_BILLING', '账户额度不足，请前往服务商后台充值')
    }
    if (typeof cause.status === 'number' && cause.status >= 500) {
      return new AppError('CREDENTIALS_UPSTREAM', '上游服务暂时不可用，请稍后再试')
    }
    return new AppError('CREDENTIALS_UPSTREAM', `调用失败（HTTP ${cause.status ?? '未知'}）`)
  }

  // 走到这里说明是「不该发生」的编程错误，交给全局兜底
  return new AppError('INTERNAL', '连通性测试遇到未预期的错误')
}

/**
 * 连通性测试。
 *
 * 用 countTokens 而不是真的生成一段文本：
 * 它同样要经过鉴权与配额校验，却**不产生任何生成 token**，
 * 因此用户点几次「测试」都不会花钱，也不会因为模型思考而变慢。
 */
export async function probeCredentials(credentials: Credentials): Promise<Result<ProbeSuccess>> {
  const client = createAnthropicClient(credentials, {
    timeout: PROBE_TIMEOUT_MS,
    // 这是用户手动点的按钮，失败要立刻反馈，不要默默重试拖长等待。
    maxRetries: 0,
  })

  try {
    const result = await client.messages.countTokens({
      model: credentials.model,
      messages: [{ role: 'user', content: '连通性测试' }],
    })

    return ok({ model: credentials.model, inputTokens: result.input_tokens })
  } catch (cause) {
    return { ok: false, error: classify(cause, credentials.model) }
  }
}
