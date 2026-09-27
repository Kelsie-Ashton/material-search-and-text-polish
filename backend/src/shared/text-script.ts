/**
 * 文本字形：简体 / 繁体。
 *
 * 这是一个**用户偏好**（设置页的「默认文本保存方式」），同时又是提取落库时
 * 要用到的转换参数——两边都得认识它，所以放在 shared 里，
 * 而不是让 settings 反过来依赖 extraction。
 */

export const TEXT_SCRIPTS = ['simplified', 'traditional'] as const

export type TextScript = (typeof TEXT_SCRIPTS)[number]

/** 默认存简体。大陆用户的默认预期，也是检索能命中的前提。 */
export const DEFAULT_TEXT_SCRIPT: TextScript = 'simplified'

export function isTextScript(value: unknown): value is TextScript {
  return typeof value === 'string' && (TEXT_SCRIPTS as readonly string[]).includes(value)
}
