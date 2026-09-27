/**
 * 凭证脱敏显示。
 *
 * 只保留末四位：足够让用户确认「填进去的是哪一把钥匙」，
 * 又不足以在截图、录屏或日志里泄露凭证本体。
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (trimmed.length === 0) return ''
  if (trimmed.length <= 4) return '****'
  return `****${trimmed.slice(-4)}`
}

/**
 * 判断一个字符串是否是脱敏后的形态。
 *
 * 用于拒绝「把显示的掩码当成真 Key 又存回去」这种操作——
 * 用户全选复制输入框内容再保存，是完全可能发生的事。
 */
export function looksMasked(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('****') || trimmed.includes('***')
}
