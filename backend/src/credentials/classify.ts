import Anthropic from '@anthropic-ai/sdk'

import { AppError } from '../shared/result.js'

/**
 * 把 Anthropic SDK 抛出的异常翻成项目错误码（任务 6.1）。
 *
 * **为什么要单独一个文件。** 这段逻辑原先长在 `probe.ts` 里，只有连通性测试用得上。
 * 润色功能要的是同一件事——请求失败时告诉用户「是 Key 不对、还是没钱了、
 * 还是网络不通」——但润色不该去 import 一个叫 probe 的模块。所以把它提出来，
 * 成为两个调用方共用的**唯一**一处失败分类。
 *
 * 这也是 6.1 说的「统一适配层」的实质：不是给 SDK 包一层壳就算数，
 * 而是**同一类失败在两条路径上必须得到同一个错误码**。否则设置页的
 * 「测试连通性」会说「凭证无效」，而润色会说「网络错误」，用户无从判断信谁。
 *
 * 用类型化异常类逐级 `instanceof`，不做字符串匹配——错误信息会随上游改动，
 * 而异常类名是稳定的契约。
 *
 * **顺序要紧**：`APIConnectionError` 是 `APIError` 的子类，必须先判断，
 * 否则网络故障会被归到「上游返回错误」这个宽泛分支里。
 */
export function classifyAnthropicError(cause: unknown, model: string): AppError {
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
  return new AppError('INTERNAL', '调用云端模型时遇到未预期的错误')
}
