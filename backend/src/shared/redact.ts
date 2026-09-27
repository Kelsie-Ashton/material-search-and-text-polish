/**
 * 敏感信息擦除。
 *
 * 这里只处理「长得像密钥」的字符串，不做通用脱敏，以免误伤正常中文文案。
 * 目标是兜底：任何凭证一旦被塞进错误信息或日志，也必须以掩码形式出现。
 */

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Anthropic 密钥
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***'],
  // 其他 sk- 前缀密钥（OpenAI 风格等），阈值取高一些避免误伤普通词
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  // 常见请求头
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer ***'],
  [/x-api-key["'\s:]*[A-Za-z0-9._~+/=-]{16,}/gi, 'x-api-key: ***'],
  [/api[_-]?key["'\s:=]+[A-Za-z0-9._~+/=-]{16,}/gi, 'api_key=***'],
]

/** 擦除自由文本中的密钥。 */
export function redactText(input: string): string {
  let out = input
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * 递归擦除任意值中的密钥，用于错误 details 这类结构化附加信息。
 * 超过 depth 层直接截断，避免循环引用导致栈溢出。
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[层级过深已截断]'
  if (typeof value === 'string') return redactText(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1))
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactValue(item, depth + 1)
    }
    return out
  }

  return value
}
