import Anthropic from '@anthropic-ai/sdk'

import type { Credentials } from './store.js'

export const OFFICIAL_BASE_URL = 'https://api.anthropic.com'

export interface ClientOptions {
  timeout?: number
  maxRetries?: number
}

/**
 * 构造 Anthropic SDK 客户端。全项目唯一构造点。
 *
 * 这里有两个**必须显式传**的参数，不能依赖 SDK 默认值：
 *
 * 1. `baseURL`：SDK 默认会读环境变量 `ANTHROPIC_BASE_URL`。开发机上装了
 *    其他工具时这个变量很常见，结果是设置页明明显示「留空则使用官方地址」，
 *    请求却去了另一个网关——用户无从察觉自己的素材正文被发到了哪里。
 *    显式传入让「页面上写的」与「实际发生的」保持一致。
 *
 * 2. `apiKey`：同理，SDK 会回退读 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`。
 *    本项目要求密钥有唯一来源（设置界面），否则「清除凭证即停用润色」
 *    这个行为会变得不可靠。
 *
 * 密钥由参数注入、**不在模块顶层读取**，避免被打进构建产物。
 */
export function createAnthropicClient(
  credentials: Credentials,
  options: ClientOptions = {},
): Anthropic {
  return new Anthropic({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl ?? OFFICIAL_BASE_URL,
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  })
}
