import { describe, expect, it } from 'vitest'

import { statusFor } from './http.js'
import { AppError, err, ok, unwrap } from './result.js'

/** 形似真实密钥的样本，用于验证擦除确实生效。 */
const FAKE_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

describe('AppError 的脱敏是构造责任', () => {
  it('错误信息里的密钥被擦除', () => {
    const error = new AppError('CREDENTIALS_INVALID', `上游拒绝了密钥 ${FAKE_KEY}`)

    expect(error.message).not.toContain(FAKE_KEY)
    expect(error.message).toContain('sk-ant-***')
  })

  it('details 里的密钥被递归擦除', () => {
    const error = new AppError('CREDENTIALS_INVALID', '调用失败', {
      request: { headers: { 'x-api-key': FAKE_KEY } },
      attempts: [FAKE_KEY, '普通文本'],
      note: `Bearer ${FAKE_KEY}`,
    })

    // 这条断言是整个安全约束的兜底：无论调用点多粗心地把凭证塞进 details，
    // 序列化出去的结果里都不能出现它。
    const serialized = JSON.stringify(error.toJSON())
    expect(serialized).not.toContain(FAKE_KEY)
    expect(serialized).toContain('普通文本')
  })

  it('正常中文文案不会被误伤', () => {
    const error = new AppError('EXTRACTION_FAILED', '视频转写失败：音轨为空，请检查素材')

    expect(error.message).toBe('视频转写失败：音轨为空，请检查素材')
  })

  it('toJSON 在有 details 时才带该字段', () => {
    expect(new AppError('NOT_FOUND', '找不到').toJSON()).toEqual({
      code: 'NOT_FOUND',
      message: '找不到',
    })
    expect(new AppError('NOT_FOUND', '找不到', { id: 7 }).toJSON()).toEqual({
      code: 'NOT_FOUND',
      message: '找不到',
      details: { id: 7 },
    })
  })
})

describe('Result 契约', () => {
  it('ok / err 产出可辨识联合', () => {
    const success = ok({ total: 3 })
    expect(success.ok).toBe(true)
    if (success.ok) expect(success.value.total).toBe(3)

    const failure = err('SEARCH_QUERY_EMPTY', '请输入关键词')
    expect(failure.ok).toBe(false)
    if (!failure.ok) expect(failure.error.code).toBe('SEARCH_QUERY_EMPTY')
  })

  it('unwrap 只在成功时返回值', () => {
    expect(unwrap(ok(42))).toBe(42)
    expect(() => unwrap(err('INTERNAL', '炸了'))).toThrow(/unwrap/)
  })
})

describe('错误码到 HTTP 状态码的映射', () => {
  it('业务语义正确落到状态码', () => {
    expect(statusFor('CREDENTIALS_INVALID')).toBe(401)
    expect(statusFor('CREDENTIALS_NOT_CONFIGURED')).toBe(409)
    expect(statusFor('CREDENTIALS_RATE_LIMITED')).toBe(429)
    expect(statusFor('DIRECTORY_DUPLICATE')).toBe(409)
    expect(statusFor('EXTRACTION_UNSUPPORTED_TYPE')).toBe(422)
    expect(statusFor('EXTRACTION_ENGINE_UNAVAILABLE')).toBe(503)
    expect(statusFor('NOT_FOUND')).toBe(404)
  })
})
