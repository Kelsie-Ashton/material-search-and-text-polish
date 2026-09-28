// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mergeRanges, splitSnippet } from '../api/search'
import SearchPage from './Search'

/**
 * 检索页的测试。
 *
 * 断言集中在两件容易做错的事上：**高亮不能错位**，
 * 以及**「搜不到」不能被说成「没有」**。
 */

let response: unknown
let responseStatus: number
let requestedUrls: string[]

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    directoryId: 1,
    path: 'D:\\素材库\\探店.mp4',
    fileName: '探店.mp4',
    ext: '.mp4',
    kind: 'video',
    sizeBytes: 2048,
    mtimeMs: 0,
    extractStatus: 'done',
    updatedAt: 0,
    tags: [],
    ...overrides,
  }
}

function hit(overrides: Record<string, unknown> = {}) {
  return {
    asset: asset(),
    matchedIn: ['segment'],
    matchedNames: [],
    matchedTags: [],
    segments: [],
    segmentHitCount: 0,
    tier: 2,
    matchedTerms: ['火锅店'],
    ...overrides,
  }
}

beforeEach(() => {
  response = { ok: true, value: { items: [], total: 0, terms: [], warnings: [] } }
  responseStatus = 200
  requestedUrls = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input))
      return json(response, responseStatus)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('检索页', () => {
  it('空白输入被拦住并提示，而不是发一次注定失败的请求', async () => {
    const user = userEvent.setup()
    render(<SearchPage />)

    await user.type(screen.getByRole('searchbox'), '   ')
    await user.click(screen.getByRole('button', { name: '检索' }))

    expect(await screen.findByText('请输入关键词后再检索。')).toBeTruthy()
    expect(requestedUrls).toEqual([])
  })

  it('展示命中来源、关键词与正文片段', async () => {
    response = {
      ok: true,
      value: {
        items: [
          hit({
            matchedIn: ['file_name', 'segment'],
            matchedNames: ['探店.mp4'],
            matchedTags: ['美食'],
            segmentHitCount: 1,
            segments: [
              {
                segmentId: 9,
                source: 'audio',
                ordinal: 0,
                startMs: 61000,
                endMs: 64000,
                frameMs: null,
                snippet: '今天我们来探店这家火锅店',
                highlights: [{ start: 6, end: 8 }],
                truncated: { head: false, tail: false },
                rank: -1.5,
              },
            ],
          }),
        ],
        total: 1,
        terms: [{ text: '探店', length: 2, path: 'like' }],
        warnings: [
          {
            code: 'SHORT_TERM_LIKE_FALLBACK',
            message: '探店 不足 3 个字，已改用全库扫描匹配',
            terms: ['探店'],
          },
        ],
      },
    }

    const user = userEvent.setup()
    render(<SearchPage />)
    await user.type(screen.getByRole('searchbox'), '探店')
    await user.click(screen.getByRole('button', { name: '检索' }))

    expect(await screen.findByText('探店.mp4')).toBeTruthy()
    expect(screen.getByText('文件名')).toBeTruthy()
    expect(screen.getByText('正文')).toBeTruthy()
    expect(screen.getByText('美食')).toBeTruthy()
    // 时间轴让用户知道这句话出现在视频的哪一秒
    expect(screen.getByText('1:01')).toBeTruthy()
    // 两字关键词的降级必须如实说明，不能让用户以为它与长词是一回事
    expect(screen.getByText(/不足 3 个字，已改用全库扫描匹配/)).toBeTruthy()
    // 只有一段，没有可展开的东西，此时不该凭空多出一个按钮
    expect(screen.queryByRole('button', { name: /展开全部/ })).toBeNull()
  })

  it('默认只显示最相关的三段，展开铺开全部，收起再还原', async () => {
    // 后端会把命中的片段全带回来（见 backend/src/search/index.test.ts），
    // 前端只决定一次显示几条——所以这里发的请求数不会因为展开而变化。
    const segments = [0, 1, 2, 3, 4].map((index) => ({
      segmentId: index + 1,
      source: 'audio',
      ordinal: index,
      startMs: null,
      endMs: null,
      frameMs: null,
      snippet: `第${index}段里有火锅店`,
      highlights: [{ start: 5, end: 8 }],
      truncated: { head: false, tail: false },
      rank: -1,
    }))

    response = {
      ok: true,
      value: {
        items: [hit({ segments, segmentHitCount: segments.length })],
        total: 1,
        terms: [],
        warnings: [],
      },
    }

    const user = userEvent.setup()
    render(<SearchPage />)
    await user.type(screen.getByRole('searchbox'), '火锅店')
    await user.click(screen.getByRole('button', { name: '检索' }))

    // 折叠状态：只有前三段进了 DOM，后两段一个字都不该渲染
    await screen.findByText('第0段里有')
    expect(screen.getByText('第2段里有')).toBeTruthy()
    expect(screen.queryByText('第3段里有')).toBeNull()
    expect(screen.queryByText('第4段里有')).toBeNull()

    // 命中总数写在按钮上：点之前就知道展开会多看到多少，不必先点开数一遍
    await user.click(screen.getByRole('button', { name: '展开全部 5 段' }))

    expect(screen.getByText('第4段里有')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '展开全部 5 段' })).toBeNull()

    // 收起回到「只看三段」，而不是留在展开态
    await user.click(screen.getByRole('button', { name: '收起' }))

    expect(screen.queryByText('第4段里有')).toBeNull()
    expect(screen.getByText('第0段里有')).toBeTruthy()
  })

  it('展开/收起不额外发请求，只是切换本地状态', async () => {
    const segments = [0, 1, 2, 3].map((index) => ({
      segmentId: index + 1,
      source: 'audio',
      ordinal: index,
      startMs: null,
      endMs: null,
      frameMs: null,
      snippet: `第${index}段里有火锅店`,
      highlights: [],
      truncated: { head: false, tail: false },
      rank: -1,
    }))

    response = {
      ok: true,
      value: {
        items: [hit({ segments, segmentHitCount: segments.length })],
        total: 1,
        terms: [],
        warnings: [],
      },
    }

    const user = userEvent.setup()
    render(<SearchPage />)
    await user.type(screen.getByRole('searchbox'), '火锅店')
    await user.click(screen.getByRole('button', { name: '检索' }))
    await screen.findByText('第0段里有火锅店')

    const before = requestedUrls.length

    await user.click(screen.getByRole('button', { name: '展开全部 4 段' }))
    await user.click(screen.getByRole('button', { name: '收起' }))

    // 片段早就在手里了，展开是纯展示选择，不该再换一次网络往返
    expect(requestedUrls).toHaveLength(before)
  })

  it('高亮只包住命中的词，不吞掉相邻字符', () => {
    // 下标是相对 snippet 的 UTF-16 偏移。emoji 占 2 个下标，
    // 若把它当成「字符数」来切片，高亮就会错位到隔壁字符上。
    const snippet = '👍探店火锅店'
    const pieces = splitSnippet(snippet, [{ start: 2, end: 4 }])

    expect(pieces).toEqual([
      { text: '👍', hit: false },
      { text: '探店', hit: true },
      { text: '火锅店', hit: false },
    ])
  })

  it('重叠的命中区间被合并，不重复渲染文字', () => {
    // 用户搜「火锅 锅店」时两个区间会重叠。不合并的话
    // 切片会切出负长度片段，渲染出重复或错位的文字。
    expect(
      mergeRanges([
        { start: 4, end: 8 },
        { start: 6, end: 10 },
      ]),
    ).toEqual([{ start: 4, end: 10 }])

    // 「今天探店火锅店真好吃」的下标：今0 天1 探2 店3 火4 锅5 店6 真7 …
    // [2,6) 与 [4,8) 合并成 [2,8)，即「探店火锅店真」。
    const pieces = splitSnippet('今天探店火锅店真好吃', [
      { start: 2, end: 6 },
      { start: 4, end: 8 },
    ])
    expect(pieces.map((piece) => piece.text).join('')).toBe('今天探店火锅店真好吃')
    expect(pieces.find((piece) => piece.hit)?.text).toBe('探店火锅店真')
  })

  it('无命中时提示「搜不到不等于没有」，并指向文字提取', async () => {
    const user = userEvent.setup()
    render(<SearchPage />)
    await user.type(screen.getByRole('searchbox'), '火锅店')
    await user.click(screen.getByRole('button', { name: '检索' }))

    expect(await screen.findByText(/没有找到与「火锅店」相关的素材/)).toBeTruthy()
    // 这句是这一页最重要的一句：正文检索依赖已提取的文字，
    // 把「搜不到」当成「没有」会让用户丢掉素材
    expect(screen.getByText(/需要先对素材执行文字提取/)).toBeTruthy()
  })

  it('筛选条件可见、可清除', async () => {
    response = {
      ok: true,
      value: { items: [hit()], total: 1, terms: [], warnings: [] },
    }
    const user = userEvent.setup()
    render(<SearchPage />)

    // 没有筛选时不该出现「清除筛选」，否则用户会以为有什么被筛掉了
    expect(screen.queryByRole('button', { name: '清除筛选' })).toBeNull()

    await user.type(screen.getByRole('searchbox'), '火锅店')
    await user.click(screen.getByRole('button', { name: '检索' }))
    await screen.findByText('探店.mp4')

    await user.selectOptions(screen.getByDisplayValue('全部类型'), 'video')

    const clear = await screen.findByRole('button', { name: '清除筛选' })
    expect(requestedUrls[requestedUrls.length - 1]).toContain('kind=video')

    await user.click(clear)
    expect(screen.queryByRole('button', { name: '清除筛选' })).toBeNull()
    // 清除后重新检索，不能再带着 kind
    expect(requestedUrls[requestedUrls.length - 1]).not.toContain('kind=')
  })

  it('后端报错时显示可读的中文提示', async () => {
    responseStatus = 500
    response = { ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } }

    const user = userEvent.setup()
    render(<SearchPage />)
    await user.type(screen.getByRole('searchbox'), '火锅店')
    await user.click(screen.getByRole('button', { name: '检索' }))

    expect(await screen.findByText('服务器内部错误')).toBeTruthy()
  })
})
