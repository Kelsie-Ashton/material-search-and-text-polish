import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCredentialsStore, type CredentialsStore } from '../credentials/store.js'
import type { Db } from '../db/index.js'
import type { LLMProvider, PolishOutput } from '../llm/provider.js'
import { ok, type Result } from '../shared/result.js'
import { createAsset, createDirectory, createSegment } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import { readCurrentPolish, readLastPolishFailure } from './results.js'
import { MAX_INPUT_CHARS, polishAsset } from './service.js'

/**
 * 单素材润色的测试（任务 6.5）。
 *
 * 替换掉的只有 provider（也就是「真的发出云端调用」那一步）。
 * 其余——读段落、拼正文、判上限、查凭证、落库、留失败原因——走的都是生产代码。
 *
 * 真实调用没法进测试套件：它要花用户的钱、要联网、结果还不确定。
 */

const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

let db: Db
let dir: string
let store: CredentialsStore
let directoryId: number

beforeEach(() => {
  db = createTestDb()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-svc-'))
  // 注入临时文件：绝不能让用例碰到用户真实的 data/credentials.json
  store = createCredentialsStore(path.join(dir, 'credentials.json'))
  directoryId = createDirectory(db).id
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 造一个素材，并给它配上提取好的正文（润色的前提） */
function assetWithText(texts: string[], name = '探店.mp4'): number {
  const assetId = createAsset(db, directoryId, { fileName: name }).id
  texts.forEach((text, index) => createSegment(db, assetId, text, { ordinal: index }))
  return assetId
}

/** 一个什么都不做的 provider 桩，行为由各用例覆盖 */
function stubProvider(polish: LLMProvider['polish']): { deps: { createProvider: () => LLMProvider } } {
  return {
    deps: {
      createProvider: () =>
        ({ polish, verifyCredential: vi.fn() }) as unknown as LLMProvider,
    },
  }
}

function stubSuccess(body = '整理好的文案'): {
  deps: { createProvider: () => LLMProvider }
  polishMock: ReturnType<typeof vi.fn>
} {
  const polishMock = vi.fn(
    async (): Promise<Result<PolishOutput>> =>
      ok({ body, model: 'claude-opus-5', inputTokens: 10, outputTokens: 20 }),
  )
  return { ...stubProvider(polishMock as unknown as LLMProvider['polish']), polishMock }
}

describe('单素材润色', () => {
  it('把提取出的正文交给模型，并把结果存下来', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText(['今天我们来探店', '这家火锅店很有名'])
    const { deps, polishMock } = stubSuccess()

    const result = await polishAsset(db, store, assetId, deps)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('done')
      expect(result.value.result.body).toBe('整理好的文案')
    }

    // 送过去的是**按段落顺序拼起来的全文**，不是某一段
    const sent = polishMock.mock.calls[0]?.[0] as { assetName: string; text: string }
    expect(sent.text).toBe('今天我们来探店\n这家火锅店很有名')
    expect(sent.assetName).toBe('探店.mp4')

    expect(readCurrentPolish(db, assetId)?.body).toBe('整理好的文案')
  })

  it('**不改动原始提取文本**，原文与结果各存各的', async () => {
    // 原文是检索的依据，也是用户对照的底本。一旦被润色结果覆盖，
    // 「模型改错了」就没有回退的余地了。
    store.save({ apiKey: KEY })
    const assetId = assetWithText(['原始的一句台词'])
    const { deps } = stubSuccess('改写过的一句台词')

    await polishAsset(db, store, assetId, deps)

    const rows = db
      .prepare('SELECT text FROM asset_text_segments WHERE asset_id = ?')
      .all(assetId) as Array<{ text: string }>
    expect(rows.map((r) => r.text)).toEqual(['原始的一句台词'])
    expect(readCurrentPolish(db, assetId)?.body).toBe('改写过的一句台词')
  })

  it('还没提取过文字时说清楚要先去提取，且不留失败记录', async () => {
    // 这不是失败，是「还没准备好」。留一条失败记录的话，用户提取完
    // 再回来会看到一条莫名其妙的旧错误。
    store.save({ apiKey: KEY })
    const assetId = createAsset(db, directoryId).id
    const { deps } = stubSuccess()

    const result = await polishAsset(db, store, assetId, deps)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_NO_CONTENT')
    expect(readLastPolishFailure(db, assetId)).toBeNull()
  })

  it('没配置凭证时不去调用，并指向设置页', async () => {
    const assetId = assetWithText(['正文'])
    const { deps, polishMock } = stubSuccess()

    const result = await polishAsset(db, store, assetId, deps)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CREDENTIALS_NOT_CONFIGURED')
      expect(result.error.message).toContain('设置页')
    }
    // 关键：一次请求都不该发出去——没配置凭证时更不该产生费用
    expect(polishMock).not.toHaveBeenCalled()
  })

  it('正文超长时明确拒绝，而不是截断了事', async () => {
    // 截断的结果看起来完整，用户会直接拿去用，直到发布才发现少了后半段。
    // 「这次不做」比「做了一半还不说」好得多。
    store.save({ apiKey: KEY })
    const assetId = assetWithText(['一'.repeat(MAX_INPUT_CHARS + 1)])
    const { deps, polishMock } = stubSuccess()

    const result = await polishAsset(db, store, assetId, deps)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('POLISH_INPUT_TOO_LARGE')
      expect(result.error.message).toContain('截断')
    }
    // 没有发出去，也就没花钱、没有失败记录
    expect(polishMock).not.toHaveBeenCalled()
    expect(readLastPolishFailure(db, assetId)).toBeNull()
  })

  it('刚好到上限的正文可以通过', async () => {
    // 边界要明确：上限是「最多这么多」，不是「必须小于」
    store.save({ apiKey: KEY })
    const assetId = assetWithText(['一'.repeat(MAX_INPUT_CHARS)])
    const { deps } = stubSuccess()

    const result = await polishAsset(db, store, assetId, deps)

    expect(result.ok).toBe(true)
  })

  it('模型调用失败时留痕，并把原因原样返回', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText(['正文'])
    const { deps } = stubProvider((async () => ({
      ok: false,
      error: Object.assign(new Error('无法连接到服务'), {
        code: 'CREDENTIALS_NETWORK',
        message: '无法连接到服务，请检查网络或代理设置',
        toJSON: () => ({}),
      }),
    })) as unknown as LLMProvider['polish'])

    const result = await polishAsset(db, store, assetId, deps)

    expect(result.ok).toBe(false)
    const failure = readLastPolishFailure(db, assetId)
    expect(failure?.code).toBe('CREDENTIALS_NETWORK')
    // 刷新页面后这条原因不该消失——用户看到失败后一定会问为什么
    expect(failure?.message).toContain('网络')
  })

  it('一次失败之后重试成功，结果正常落库', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText(['正文'])

    const failing = stubProvider((async () => ({
      ok: false,
      error: Object.assign(new Error('炸了'), {
        code: 'CREDENTIALS_UPSTREAM',
        message: '上游服务暂时不可用',
        toJSON: () => ({}),
      }),
    })) as unknown as LLMProvider['polish'])
    await polishAsset(db, store, assetId, failing.deps)
    expect(readCurrentPolish(db, assetId)).toBeNull()

    const { deps } = stubSuccess('这次成了')
    const retry = await polishAsset(db, store, assetId, deps)

    expect(retry.ok).toBe(true)
    expect(readCurrentPolish(db, assetId)?.body).toBe('这次成了')
  })

  it('素材不存在时返回 404 语义的错误', async () => {
    store.save({ apiKey: KEY })
    const { deps } = stubSuccess()

    const result = await polishAsset(db, store, 9999, deps)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('素材被删除后润色不会崩，而是如实报不存在', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText(['正文'])
    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId)
    const { deps } = stubSuccess()

    const result = await polishAsset(db, store, assetId, deps)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('记下输入的字符数与 token 用量，供计费提示用', async () => {
    store.save({ apiKey: KEY })
    const assetId = assetWithText(['一二三四五'])
    const { deps } = stubSuccess()

    await polishAsset(db, store, assetId, deps)

    const row = db
      .prepare('SELECT input_chars, input_tokens, output_tokens FROM polish_results LIMIT 1')
      .get() as { input_chars: number; input_tokens: number; output_tokens: number }
    expect(row.input_chars).toBe(5)
    expect(row.input_tokens).toBe(10)
    expect(row.output_tokens).toBe(20)
  })
})
