import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OFFICIAL_BASE_URL, createAnthropicClient } from './client.js'
import type { Credentials } from './store.js'

function credentials(overrides: Partial<Credentials> = {}): Credentials {
  return { apiKey: 'sk-ant-api03-FromSettings0000000000000000000000', model: 'claude-opus-5', ...overrides }
}

describe('SDK 客户端构造点', () => {
  const original = {
    baseUrl: process.env['ANTHROPIC_BASE_URL'],
    apiKey: process.env['ANTHROPIC_API_KEY'],
    authToken: process.env['ANTHROPIC_AUTH_TOKEN'],
  }

  beforeEach(() => {
    // 复现一台装过其他 AI 工具的机器：这些变量很常见，
    // 而 SDK 默认会读它们。
    process.env['ANTHROPIC_BASE_URL'] = 'https://some-other-gateway.invalid/anthropic'
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-FromEnvironment000000000000000000'
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'sk-ant-api03-FromAuthToken000000000000000000'
  })

  afterEach(() => {
    for (const [key, value] of [
      ['ANTHROPIC_BASE_URL', original.baseUrl],
      ['ANTHROPIC_API_KEY', original.apiKey],
      ['ANTHROPIC_AUTH_TOKEN', original.authToken],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('未配置代理时固定走官方地址，不被环境变量改写', () => {
    const client = createAnthropicClient(credentials())

    // 这条断言守的是一个隐私问题：设置页写着「留空则使用官方地址」，
    // 若这里被 ANTHROPIC_BASE_URL 改写，用户的素材正文就会在
    // 他毫不知情的情况下被发往另一个网关。
    expect(client.baseURL).toBe(OFFICIAL_BASE_URL)
  })

  it('用户填了代理地址时以填写值为准', () => {
    const client = createAnthropicClient(credentials({ baseUrl: 'https://my-proxy.example.com' }))

    expect(client.baseURL).toBe('https://my-proxy.example.com')
  })

  it('密钥只来自参数，不读环境变量', () => {
    const client = createAnthropicClient(credentials({ apiKey: 'sk-ant-api03-OnlyMine00000000000000000000000' }))

    // 「清除凭证即停用润色」要成立，密钥就必须只有一个来源。
    expect(client.apiKey).toBe('sk-ant-api03-OnlyMine00000000000000000000000')
  })
})
