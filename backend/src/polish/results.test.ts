import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { createAsset, createDirectory } from '../test/factory.js'
import { createTestDb } from '../test/temp-db.js'
import {
  readCurrentPolish,
  readLastPolishFailure,
  savePolishFailure,
  savePolishedResult,
} from './results.js'

/**
 * 润色结果读写的测试（任务 6.5）。
 *
 * 这里的重点全在**「当前结果」这个不变量上**：表里同时留着历史，
 * 而界面上只能显示一条。写错了顺序不会报任何错，只会让用户某天发现
 * 「同一段文案，刷新一下就变成另一段了」。
 */

describe('润色结果读写', () => {
  let db: Db
  let directoryId: number
  let assetId: number

  beforeEach(() => {
    db = createTestDb()
    directoryId = createDirectory(db).id
    assetId = createAsset(db, directoryId).id
  })

  afterEach(() => {
    db.close()
  })

  function save(body: string, overrides: Partial<{ model: string }> = {}): number {
    return savePolishedResult(db, {
      assetId,
      body,
      model: overrides.model ?? 'claude-opus-5',
      promptVersion: 'polish-v1',
      inputChars: 100,
      inputTokens: 50,
      outputTokens: 80,
    })
  }

  it('写入后能读回来', () => {
    save('整理好的文案')

    const current = readCurrentPolish(db, assetId)

    expect(current?.body).toBe('整理好的文案')
    expect(current?.assetId).toBe(assetId)
    expect(current?.promptVersion).toBe('polish-v1')
    expect(current?.outputTokens).toBe(80)
  })

  it('没润色过时返回 null，而不是报错', () => {
    // 「还没润色过」是最常见的初始状态，不是错误。
    // 把它当错误处理，界面就得在正常路径上处理一次异常。
    expect(readCurrentPolish(db, assetId)).toBeNull()
  })

  it('重新润色后，新的成为当前结果，旧的仍留在表里', () => {
    save('第一版')
    save('第二版')

    expect(readCurrentPolish(db, assetId)?.body).toBe('第二版')

    // 历史必须留着：一次误操作不该毁掉上次花钱拿到的结果，
    // 不同模型/提示词的输出也才有得比
    const all = db.prepare('SELECT body, is_current FROM polish_results ORDER BY id').all() as Array<{
      body: string
      is_current: number
    }>
    expect(all).toEqual([
      { body: '第一版', is_current: 0 },
      { body: '第二版', is_current: 1 },
    ])
  })

  it('任何时刻都只有一条当前结果', () => {
    // 这是数据库层面的不变量，由部分唯一索引兜底。
    // 这条用例断言的是「我们的写入顺序不会去撞它」——
    // 先插后改会让索引拒绝（一次正常操作变成 500），所以必须先改后插。
    for (const body of ['一', '二', '三', '四']) save(body)

    const row = db
      .prepare('SELECT COUNT(*) AS n FROM polish_results WHERE is_current = 1')
      .get() as { n: number }
    expect(row.n).toBe(1)
  })

  it('失败的记录不会被当成可用结果', () => {
    savePolishFailure(db, {
      assetId,
      model: 'claude-opus-5',
      promptVersion: 'polish-v1',
      inputChars: 100,
      code: 'CREDENTIALS_NETWORK',
      message: '无法连接到服务',
    })

    expect(readCurrentPolish(db, assetId)).toBeNull()

    const all = db.prepare('SELECT status, is_current FROM polish_results').all() as Array<{
      status: string
      is_current: number
    }>
    expect(all).toEqual([{ status: 'failed', is_current: 0 }])
  })

  it('失败不会顶掉上一次成功的结果', () => {
    // 用户花过钱拿到的那段文案，不该因为一次网络抖动就消失。
    // 这是把失败行写成 is_current = 0 的全部理由。
    save('来之不易的文案')

    savePolishFailure(db, {
      assetId,
      model: 'claude-opus-5',
      promptVersion: 'polish-v1',
      inputChars: 100,
      code: 'CREDENTIALS_NETWORK',
      message: '无法连接到服务',
    })

    expect(readCurrentPolish(db, assetId)?.body).toBe('来之不易的文案')
  })

  it('失败的原因留得下来，供界面说明「上次为什么没成」', () => {
    savePolishFailure(db, {
      assetId,
      model: 'claude-opus-5',
      promptVersion: 'polish-v1',
      inputChars: 100,
      code: 'CREDENTIALS_BILLING',
      message: '账户额度不足',
    })

    const failure = readLastPolishFailure(db, assetId)

    expect(failure?.code).toBe('CREDENTIALS_BILLING')
    expect(failure?.message).toBe('账户额度不足')
  })

  it('失败原因取的是最近一次', () => {
    for (const code of ['CREDENTIALS_NETWORK', 'CREDENTIALS_BILLING']) {
      savePolishFailure(db, {
        assetId,
        model: 'claude-opus-5',
        promptVersion: 'polish-v1',
        inputChars: 1,
        code,
        message: code,
      })
    }

    expect(readLastPolishFailure(db, assetId)?.code).toBe('CREDENTIALS_BILLING')
  })

  it('没有失败过时返回 null', () => {
    expect(readLastPolishFailure(db, assetId)).toBeNull()
  })

  it('写入来源素材，供「这份文案是从哪来的」回溯', () => {
    const id = save('文案')

    const source = db
      .prepare('SELECT asset_id, ordinal FROM polish_sources WHERE polish_result_id = ?')
      .get(id) as { asset_id: number; ordinal: number }

    expect(source.asset_id).toBe(assetId)
  })

  it('每个素材的结果互不干扰', () => {
    const other = createAsset(db, directoryId, { fileName: '另一条.mp4' }).id

    save('这条的文案')
    savePolishedResult(db, {
      assetId: other,
      body: '另一条的文案',
      model: 'claude-opus-5',
      promptVersion: 'polish-v1',
      inputChars: 10,
      inputTokens: 5,
      outputTokens: 5,
    })

    // 部分唯一索引是「按素材」唯一的，不是全局唯一——
    // 写成全局的话，第二条素材润色时会把第一条的 current 顶掉
    expect(readCurrentPolish(db, assetId)?.body).toBe('这条的文案')
    expect(readCurrentPolish(db, other)?.body).toBe('另一条的文案')
  })

  it('素材被删除时结果跟着走，不留孤儿', () => {
    save('文案')
    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId)

    expect(readCurrentPolish(db, assetId)).toBeNull()
    const row = db.prepare('SELECT COUNT(*) AS n FROM polish_results').get() as { n: number }
    expect(row.n).toBe(0)
  })
})
