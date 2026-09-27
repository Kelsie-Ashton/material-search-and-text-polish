import * as OpenCC from 'opencc-js'

import type { TextScript } from '../shared/text-script.js'

/**
 * 繁简字形转换（任务 5.4）。
 *
 * **为什么必须有这一步。** Whisper 的中文输出**默认就是繁体**：
 * 实测一段「今天我们来探店这家火锅店」的普通话语音，转写结果是
 * 「今天我們來探店這家火鍋店」——字符级完全正确，但对大陆用户来说
 * 是错的，而且**搜不到**：用户输入简体关键词，库里存的是繁体，
 * 全文索引按字符三元组匹配，两边对不上就是零结果。
 *
 * 试过、并且**没用**的办法：给 Whisper 传 `initial_prompt` 偏置。
 * 实测 `'以下是普通话的句子。'` 与 `'以下是普通话的句子，请使用简体中文转写。'`
 * 两种提示下，输出与不传时**逐字相同**，全是繁体。所以偏置这条路
 * 在这代模型上不通，必须做后处理转换。
 *
 * **只换字形，不换词——两个方向都刻意避开 `twp`。**
 *
 * opencc-js 的 `twp` 配置会做词汇映射，实测把「請開啟軟體」整句改写成
 * 「请打开软件」——开启变打开、软体变软件。对**转写**场景这是错的：
 * 说话人说的就是「开启」，我们只该换字形，不该替他改词。
 * 简体方向同理，`cn → tw` 把「软件」转成「軟件」而不是台湾用词「軟體」。
 *
 * 而且 Whisper 输出的通常**只是大陆用词的繁体字形**，不是台湾用词：
 * 实测样本「…人均消費80元左右」里的「消費」本就是大陆说法。
 * 对它套词汇映射属于过度改写。
 *
 * （这段结论是实测得来的。先前这里写的是"tw→cn 带词汇映射"，
 * 那个说法**是错的**——`tw → cn` 只做字符级转换。已改正。）
 *
 * 转换是**幂等且往返稳定**的，实测：简→繁→简 与 繁→繁、简→简 都不变。
 * 所以重复提取不会让文字逐次漂移。
 */

const toSimplifiedConverter = OpenCC.Converter({ from: 'tw', to: 'cn' })
const toTraditionalConverter = OpenCC.Converter({ from: 'cn', to: 'tw' })

export function toSimplified(text: string): string {
  return toSimplifiedConverter(text)
}

export function toTraditional(text: string): string {
  return toTraditionalConverter(text)
}

/**
 * 按用户偏好转换字形。
 *
 * 提取落库前统一走这一处——**不要在各调用点自己判断该转哪个方向**：
 * 那样每加一条提取路径就多一处可能漏掉的分支。
 */
export function convertScript(text: string, script: TextScript): string {
  return script === 'traditional' ? toTraditional(text) : toSimplified(text)
}
