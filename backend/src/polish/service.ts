import type { CredentialsStore, Credentials } from '../credentials/store.js'
import type { Db } from '../db/index.js'
import { createAnthropicProvider, type LLMProvider } from '../llm/provider.js'
import { PROMPT_VERSION } from '../llm/prompt.js'
import { findAsset } from '../library/assets.js'
import { AppError, err, ok, type Result } from '../shared/result.js'
import {
  readCurrentPolish,
  savePolishFailure,
  savePolishedResult,
  type PolishedResult,
} from './results.js'

/**
 * 单素材润色（任务 6.5）。
 *
 * ## 它不做的事
 *
 * **不改动提取出来的原文。** 润色结果单独存一张表，原文留在
 * `asset_text_segments` 里一个字节都不动。这条不是洁癖：原文是检索的依据，
 * 也是用户对照的底本；一旦被覆盖，「模型改错了」就没有回退的余地了。
 *
 * ## 输入上限：宁可不做，也不静默截断
 *
 * 超长就明确拒绝（`POLISH_INPUT_TOO_LARGE`），**不做截断**。
 * 截断的后果是用户拿到一段看起来完整、实际少了后半截的文案，
 * 而他会直接拿去用——直到发布出去才发现。这比「这次没做」严重得多。
 *
 * 当前上限按最保守的模型留的余量（见 `MAX_INPUT_CHARS`），
 * 所以绝大多数素材根本碰不到它：一集 24 分钟的番剧字幕约 8000 字，
 * 一部长片约 3 万字。
 */

/**
 * 单次送进模型的输入上限（字符）。
 *
 * 取 12 万是有意的保守值：本项目的**模型名由用户自己填**，
 * 而各家、各代的上下文窗口差别很大。按最小的那档（约 20 万 token）
 * 留出足够余量，就能保证「换个模型名也不会突然因为超长而失败」。
 *
 * 真要做超长素材（比如几小时的直播录像），正确做法是分段汇总再合并，
 * 而不是把这个数字调大——那只是把失败推给用户看不见的地方。
 */
export const MAX_INPUT_CHARS = 120_000

export interface PolishDone {
  status: 'done'
  result: PolishedResult
}

export interface PolishDeps {
  /** 替换 provider 的构造。测试用它注入桩替身，从而不发出任何网络请求。 */
  createProvider?: (credentials: Credentials) => LLMProvider
}

/** 读出这个素材提取过的全部正文，按段落顺序拼起来。 */
function readAssetText(db: Db, assetId: number): { text: string; chars: number } {
  const rows = db
    .prepare(
      `SELECT text FROM asset_text_segments WHERE asset_id = ? ORDER BY ordinal ASC`,
    )
    .all(assetId) as Array<{ text: string }>

  const text = rows.map((row) => row.text).join('\n')
  return { text, chars: text.length }
}

/**
 * 对一个素材跑一次润色，并把结果落库。
 *
 * 失败一律**留痕**（`savePolishFailure`）后返回 `Err`——用户点的是要花钱的按钮，
 * 「失败了但不知道为什么」在这条路径上格外不能接受。
 */
export async function polishAsset(
  db: Db,
  store: CredentialsStore,
  assetId: number,
  deps: PolishDeps = {},
): Promise<Result<PolishDone>> {
  const asset = findAsset(db, assetId)
  if (!asset) {
    return err('ASSET_NOT_FOUND', `素材不存在（id=${assetId}）`, { id: assetId })
  }

  const { text, chars } = readAssetText(db, assetId)
  if (text === '') {
    // 这不是「失败」，是「还没准备好」。所以不留失败记录——
    // 留了的话，用户之后提取完再回来看，会看到一条莫名其妙的旧错误。
    return err(
      'EXTRACTION_NO_CONTENT',
      '这个素材还没有提取出文字，先提取一次再来润色。',
      { id: assetId },
    )
  }

  if (chars > MAX_INPUT_CHARS) {
    return err(
      'POLISH_INPUT_TOO_LARGE',
      `这个素材的正文有 ${chars} 字，超过了单次润色的上限（${MAX_INPUT_CHARS} 字）。` +
        `为了避免结果被截断，这次没有提交——请换一段更短的素材，或先删掉一些段落。`,
      { chars, limit: MAX_INPUT_CHARS },
    )
  }

  const availability = store.getAvailability()
  if (!availability.available) {
    return err(
      'CREDENTIALS_NOT_CONFIGURED',
      '还没有配置 API Key，润色功能暂不可用。请到设置页填写。',
      { reason: availability.reason },
    )
  }

  const credentials = store.readRaw()
  if (!credentials.ok) return credentials
  if (credentials.value === null) {
    // getAvailability 说可用、readRaw 却说没有——理论上到不了这里。
    // 但不写这一句的话，下面就得对 value 做非空断言，把「理论上」变成运行时的赌注。
    return err('CREDENTIALS_NOT_CONFIGURED', '还没有配置 API Key，润色功能暂不可用。')
  }

  const createProvider = deps.createProvider ?? ((creds) => createAnthropicProvider(creds))
  const provider = createProvider(credentials.value)

  const polished = await provider.polish({ assetName: asset.fileName, text })

  if (!polished.ok) {
    savePolishFailure(db, {
      assetId,
      model: credentials.value.model,
      promptVersion: PROMPT_VERSION,
      inputChars: chars,
      code: polished.error.code,
      message: polished.error.message,
    })
    return polished
  }

  const id = savePolishedResult(db, {
    assetId,
    body: polished.value.body,
    model: polished.value.model,
    promptVersion: PROMPT_VERSION,
    inputChars: chars,
    inputTokens: polished.value.inputTokens,
    outputTokens: polished.value.outputTokens,
  })

  const saved = readCurrentPolish(db, assetId)
  if (saved === null) {
    // 刚写完就读不到，只能是编程错误（比如唯一索引的谓词被改动过）。
    // 与其返回一个 id 让调用方再查一次然后拿到 null，不如在这里说清楚。
    throw new AppError('INTERNAL', '润色结果写入后读不回来', { id, assetId })
  }

  return ok({ status: 'done', result: saved })
}
