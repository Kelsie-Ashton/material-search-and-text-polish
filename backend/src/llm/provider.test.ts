import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { Credentials } from '../credentials/store.js'
import { createAnthropicProvider, extractText, type ProviderDeps } from './provider.js'

/**
 * 适配层的测试（任务 6.1 / 6.5）。
 *
 * **全程没有任何网络请求**：`ProviderDeps.createClient` 被换成一个假的客户端，
 * 于是「发请求」这一步被替换，而拼提示词、读响应、映射错误码这些**真正会写错**
 * 的部分走的都是生产代码。
 *
 * 这也是这条路径唯一可行的测法：真实调用要花用户的钱，而且结果不确定，
 * 放进每次都要跑的测试套件里既贵又不稳定。
 */

const CREDENTIALS: Credentials = { apiKey: 'sk-ant-test', model: 'claude-opus-5' }

/** 造一个假的 SDK 客户端，并把它收到的请求参数记下来供断言。 */
function fakeClient(overrides: {
  create?: (params: unknown) => Promise<unknown>
  countTokens?: (params: unknown) => Promise<unknown>
}): { deps: ProviderDeps; createMock: ReturnType<typeof vi.fn> } {
  const createMock = vi.fn(overrides.create ?? (async () => response({ text: '整理好的文案' })))
  const countTokensMock = vi.fn(overrides.countTokens ?? (async () => ({ input_tokens: 12 })))

  const deps: ProviderDeps = {
    createClient: () =>
      ({ messages: { create: createMock, countTokens: countTokensMock } }) as unknown as Anthropic,
  }

  return { deps, createMock }
}

/** 造一个形状正确的 SDK 响应。默认是一条普通的成功回复。 */
function response(overrides: {
  blocks?: unknown[]
  text?: string
  stopReason?: string
  stopDetails?: unknown
  model?: string
  inputTokens?: number
  outputTokens?: number
}): Record<string, unknown> {
  const blocks =
    overrides.blocks ?? (overrides.text === undefined ? [] : [{ type: 'text', text: overrides.text }])

  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: overrides.model ?? 'claude-opus-5-20260101',
    content: blocks,
    stop_reason: overrides.stopReason ?? 'end_turn',
    stop_sequence: null,
    stop_details: overrides.stopDetails ?? null,
    usage: {
      input_tokens: overrides.inputTokens ?? 100,
      output_tokens: overrides.outputTokens ?? 200,
    },
  }
}

describe('取出模型返回的正文', () => {
  it('跳过思考块，只取文本块', () => {
    // 当前几代模型的输出里可能先有 thinking 块。假设 content[0] 是文本
    // 会把一段空的或不是正文的东西当成润色结果——而它看起来完全像一次成功。
    const text = extractText([
      { type: 'thinking', thinking: '用户想要一段文案……' },
      { type: 'text', text: '整理好的文案' },
    ] as unknown as Anthropic.ContentBlock[])

    expect(text).toBe('整理好的文案')
  })

  it('多个文本块拼起来', () => {
    const text = extractText([
      { type: 'text', text: '前半段。' },
      { type: 'text', text: '后半段。' },
    ] as unknown as Anthropic.ContentBlock[])

    expect(text).toBe('前半段。后半段。')
  })

  it('只有思考块时得到空串', () => {
    const text = extractText([
      { type: 'thinking', thinking: '想了一堆但没说话' },
    ] as unknown as Anthropic.ContentBlock[])

    expect(text).toBe('')
  })

  it('没有内容块时得到空串而不是抛异常', () => {
    expect(extractText([])).toBe('')
  })
})

describe('润色调用', () => {
  it('成功时返回正文、模型与 token 用量', async () => {
    const { deps } = fakeClient({
      create: async () =>
        response({
          text: '今天我们来探店这家火锅店。',
          model: 'claude-opus-5',
          inputTokens: 321,
          outputTokens: 654,
        }),
    })

    const result = await createAnthropicProvider(CREDENTIALS, deps).polish({
      assetName: '探店.mp4',
      text: '今天我们来探店这家火锅店',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.body).toBe('今天我们来探店这家火锅店。')
      expect(result.value.model).toBe('claude-opus-5')
      // token 用量要带回来：用户为它付钱，界面要能把花销说出来
      expect(result.value.inputTokens).toBe(321)
      expect(result.value.outputTokens).toBe(654)
    }
  })

  it('素材名写进提示词，模型知道自己在处理什么', async () => {
    const { deps, createMock } = fakeClient({})

    await createAnthropicProvider(CREDENTIALS, deps).polish({
      assetName: '深夜食堂 第三集.mp4',
      text: '正文',
    })

    const params = createMock.mock.calls[0]?.[0] as { messages: Array<{ content: string }> }
    expect(params.messages[0]?.content).toContain('深夜食堂 第三集.mp4')
    expect(params.messages[0]?.content).toContain('正文')
  })

  it('**不传 thinking 参数**，让每个模型用它自己的默认值', async () => {
    // 项目的模型名由用户自己填。写死任何一种 thinking 配置，
    // 都会在用户换成别的模型时炸出 400——而换模型名本来是个无害操作。
    const { deps, createMock } = fakeClient({})

    await createAnthropicProvider(CREDENTIALS, deps).polish({ assetName: 'a.mp4', text: '正文' })

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(params).not.toHaveProperty('thinking')
    expect(params['model']).toBe('claude-opus-5')
  })

  it('被拒答时给出可操作的说明，而不是「没有返回内容」', async () => {
    // 拒答返回的是 HTTP 200，只有 stop_reason 不同。不单独判断的话，
    // 会掉进「模型没返回内容」那条分支，用户完全不知道发生了什么。
    const { deps } = fakeClient({
      create: async () => response({ blocks: [], stopReason: 'refusal', text: undefined }),
    })

    const result = await createAnthropicProvider(CREDENTIALS, deps).polish({
      assetName: 'a.mp4',
      text: '正文',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('拒绝')
    }
  })

  it('撞到输出上限时报「太长」而不是把半截文案当成功', async () => {
    // 截断的结果看起来是完整的，用户会直接拿去用——直到发布出去
    // 才发现少了后半段，而那时已经无从知道是哪一步丢的。
    const { deps } = fakeClient({
      create: async () => response({ text: '被截断的半截文', stopReason: 'max_tokens' }),
    })

    const result = await createAnthropicProvider(CREDENTIALS, deps).polish({
      assetName: 'a.mp4',
      text: '正文',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('POLISH_INPUT_TOO_LARGE')
  })

  it('模型返回空内容时当作失败，不存一条空结果', async () => {
    const { deps } = fakeClient({ create: async () => response({ text: '   ' }) })

    const result = await createAnthropicProvider(CREDENTIALS, deps).polish({
      assetName: 'a.mp4',
      text: '正文',
    })

    expect(result.ok).toBe(false)
  })

  it('SDK 异常被翻成项目错误码，而不是漏出去变成 500', async () => {
    const cases: Array<{ error: unknown; code: string }> = [
      {
        error: new Anthropic.AuthenticationError(401, undefined, 'invalid api key', new Headers()),
        code: 'CREDENTIALS_INVALID',
      },
      {
        error: new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers()),
        code: 'CREDENTIALS_RATE_LIMITED',
      },
      {
        error: new Anthropic.APIConnectionError({ message: 'fetch failed' }),
        code: 'CREDENTIALS_NETWORK',
      },
    ]

    for (const { error, code } of cases) {
      const { deps } = fakeClient({
        create: async () => {
          throw error
        },
      })

      const result = await createAnthropicProvider(CREDENTIALS, deps).polish({
        assetName: 'a.mp4',
        text: '正文',
      })

      expect(result.ok, code).toBe(false)
      if (!result.ok) expect(result.error.code, code).toBe(code)
    }
  })

  it('模型名不存在时指向模型名这一项，而不是笼统报网络错误', async () => {
    // 用户是在设置页手填模型名的，写错是常事。报「网络错误」会让他
    // 去查网络，而真正该改的是那一个字段。
    const { deps } = fakeClient({
      create: async () => {
        throw new Anthropic.NotFoundError(404, undefined, 'model not found', new Headers())
      },
    })

    const result = await createAnthropicProvider(CREDENTIALS, deps).polish({
      assetName: 'a.mp4',
      text: '正文',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CREDENTIALS_MODEL_NOT_FOUND')
      expect(result.error.message).toContain('claude-opus-5')
    }
  })
})

describe('连通性测试', () => {
  it('成功时带回模型名与输入 token 数', async () => {
    const { deps } = fakeClient({ countTokens: async () => ({ input_tokens: 7 }) })

    const result = await createAnthropicProvider(CREDENTIALS, deps).verifyCredential()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.model).toBe('claude-opus-5')
      expect(result.value.inputTokens).toBe(7)
    }
  })

  it('失败分类与润色**完全一致**', async () => {
    // 两条路径给出不同的错误码，设置页会说「凭证无效」而润色说「网络错误」，
    // 用户无从判断该信谁。这是把分类提到 credentials/classify.ts 的全部理由。
    const { deps } = fakeClient({
      countTokens: async () => {
        throw new Anthropic.AuthenticationError(401, undefined, 'invalid api key', new Headers())
      },
    })

    const result = await createAnthropicProvider(CREDENTIALS, deps).verifyCredential()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CREDENTIALS_INVALID')
  })
})
