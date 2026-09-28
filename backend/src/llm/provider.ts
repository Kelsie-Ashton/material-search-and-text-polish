import type Anthropic from '@anthropic-ai/sdk'

import { classifyAnthropicError } from '../credentials/classify.js'
import { createAnthropicClient } from '../credentials/client.js'
import type { Credentials } from '../credentials/store.js'
import { AppError, ok, type Result } from '../shared/result.js'
import { buildPolishInput, SYSTEM_PROMPT } from './prompt.js'

/**
 * 云端大模型的适配层（任务 6.1）。
 *
 * 存在的意义是让**业务代码不认识 Anthropic**。`polish/service.ts` 只调
 * `provider.polish()`，不知道背后是哪个厂商、用哪个 SDK、错误码怎么映射——
 * 所以换服务商、加一个兼容层、或者测试里塞一个桩替身，都不用动业务逻辑。
 *
 * ## 为什么两个方法放在一起
 *
 * `polish` 与 `verifyCredential` 共用同一份凭证、同一套失败分类。分开写的话，
 * 「凭证无效」在设置页说一套、在润色时说另一套，用户无从判断该信谁。
 *
 * ## 关于 thinking 参数：**刻意不传**
 *
 * 当前几代 Claude 模型的思考默认行为各不相同（有的默认思考、有的默认不思考），
 * 而本项目的**模型名是用户自己填的**（设置页那个输入框）。写死任何一种
 * 配置都会在用户换成别的模型时炸出 400。所以这里把 `thinking` 整个省掉，
 * 让每个模型用它自己的默认值——这个取舍换来的是「换模型名不会突然报错」。
 */

/** 单次润色的超时。用户在等一个按钮，但不能让他等十分钟。 */
const POLISH_TIMEOUT_MS = 120_000

/**
 * 输出上限。
 *
 * 润色的输出通常**不比输入长**（整理＝去水词 + 补标点），所以 16000 足够。
 * 不设更高是有意的：这个值同时也是「一次请求最多花多少钱」的上限，
 * 而这是用户自己掏的钱。
 */
const POLISH_MAX_TOKENS = 16_000

export interface PolishInput {
  /** 素材名，用于让模型知道自己在处理什么（也会写进结果来源） */
  assetName: string
  /** 提取出来的正文 */
  text: string
}

export interface PolishOutput {
  body: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
}

export interface VerifyResult {
  model: string
  inputTokens: number
}

/** 适配层对业务暴露的全部能力 */
export interface LLMProvider {
  polish(input: PolishInput): Promise<Result<PolishOutput>>
  verifyCredential(): Promise<Result<VerifyResult>>
}

/**
 * 可替换的底层动作，默认是真实实现。
 *
 * 与 `MediaDeps` 同一个套路：**测试替换掉的只有「真的发出网络请求」这一步**，
 * 其余（拼提示词、读响应、映射错误码、落库）走的都是生产代码。
 */
export interface ProviderDeps {
  createClient: (credentials: Credentials) => Anthropic
}

const REAL_DEPS: ProviderDeps = {
  createClient: (credentials) => createAnthropicClient(credentials),
}

/**
 * 从 SDK 的响应里取出正文。
 *
 * **不能假设 `content[0]` 是文本块。** 模型的输出里可能先有思考块，
 * 也可能只有思考块而没有任何文本。取错了会把一段空的或不是正文的东西
 * 当成润色结果存进库里——而它看起来完全像一次成功。
 */
export function extractText(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

export function createAnthropicProvider(
  credentials: Credentials,
  deps: ProviderDeps = REAL_DEPS,
): LLMProvider {
  // 客户端在这里建一次就够。它不持有连接，只是配置的容器。
  const client = deps.createClient(credentials)

  return {
    async polish(input) {
      let response: Anthropic.Message
      try {
        response = await client.messages.create(
          {
            model: credentials.model,
            max_tokens: POLISH_MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: buildPolishInput(input) }],
          },
          { timeout: POLISH_TIMEOUT_MS, maxRetries: 0 },
        )
      } catch (cause) {
        return { ok: false, error: classifyAnthropicError(cause, credentials.model) }
      }

      // 被安全策略拒答。上游返回的是 HTTP 200，只是 stop_reason 不同——
      // 不单独判断的话，会走到下面「取不到正文」那条分支，报成一句含糊的
      // 「模型没有返回内容」，用户完全不知道发生了什么。
      if (response.stop_reason === 'refusal') {
        return {
          ok: false,
          error: new AppError(
            'CREDENTIALS_UPSTREAM',
            '模型拒绝处理这段内容（可能触发了服务方的安全策略）。可以换一段素材再试。',
            { category: response.stop_details?.category ?? null },
          ),
        }
      }

      // 撞到输出上限 = 结果**被截断了**。这必须当成失败，不能把半段文案
      // 当成完整结果存起来：用户拿去用了才会发现少了后半截，
      // 而那时已经无从知道是哪一步丢的。
      if (response.stop_reason === 'max_tokens') {
        return {
          ok: false,
          error: new AppError(
            'POLISH_INPUT_TOO_LARGE',
            '这段素材太长，润色结果超出了单次输出的上限。请换一段更短的素材，或先删掉一些段落。',
          ),
        }
      }

      const body = extractText(response.content)
      if (body === '') {
        return {
          ok: false,
          error: new AppError('CREDENTIALS_UPSTREAM', '模型没有返回任何内容，请稍后再试'),
        }
      }

      return ok({
        body,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      })
    },

    async verifyCredential() {
      // 用 countTokens 而不是真的生成一段文本：同样要过鉴权与配额校验，
      // 却不产生任何生成 token，所以用户点几次「测试」都不会花钱。
      try {
        const result = await client.messages.countTokens(
          {
            model: credentials.model,
            messages: [{ role: 'user', content: '连通性测试' }],
          },
          { timeout: 15_000, maxRetries: 0 },
        )
        return ok({ model: credentials.model, inputTokens: result.input_tokens })
      } catch (cause) {
        return { ok: false, error: classifyAnthropicError(cause, credentials.model) }
      }
    },
  }
}
