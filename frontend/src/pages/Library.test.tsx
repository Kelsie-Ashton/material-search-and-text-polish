// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LibraryPage from './Library'

/**
 * 素材库页面的测试。
 *
 * 重点不在「按钮能点」，而在**空状态与危险操作的话术**：
 * 这一页是用户唯一能把磁盘素材变成索引的入口，
 * 说不清楚就会让他以为程序坏了，或者以为点了「移除」文件没了。
 */

interface MockDirectory {
  id: number
  path: string
  label: string | null
  lastScannedAt: number | null
}

interface MockJob {
  id: number
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  progressCurrent: number
  progressTotal: number
  progressMessage: string | null
  result: unknown
  errorMessage: string | null
}

let directories: MockDirectory[]
/** 每次 GET /jobs/:id 依次弹出的响应，模拟「轮询到任务结束」 */
let jobQueue: MockJob[]
let assets: unknown[]
let assetTotal: number
let scanRequests: number
let deletedDirectoryIds: number[]

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  directories = []
  jobQueue = []
  assets = []
  assetTotal = 0
  scanRequests = 0
  deletedDirectoryIds = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.includes('/api/library/directories') && method === 'GET') {
        return json({ ok: true, value: { items: directories } })
      }

      if (url.endsWith('/api/library/directories') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { path: string; label?: string }
        const created: MockDirectory = {
          id: directories.length + 1,
          path: body.path,
          label: body.label ?? null,
          lastScannedAt: null,
        }
        directories = [...directories, created]
        return json({ ok: true, value: created }, 201)
      }

      if (url.endsWith('/scan') && method === 'POST') {
        scanRequests += 1
        return json(
          {
            ok: true,
            value: { id: 7, type: 'scan', status: 'queued', targetId: 1, progressCurrent: 0, progressTotal: 0, progressMessage: null, result: null, errorMessage: null },
          },
          202,
        )
      }

      if (url.includes('/api/jobs/') && method === 'GET') {
        const next = jobQueue.shift()
        return json({ ok: true, value: next })
      }

      const deleteMatch = /\/api\/library\/directories\/(\d+)$/.exec(url)
      if (deleteMatch && method === 'DELETE') {
        const id = Number(deleteMatch[1])
        deletedDirectoryIds.push(id)
        const removed = directories.find((dir) => dir.id === id)
        directories = directories.filter((dir) => dir.id !== id)
        return json({
          ok: true,
          value: {
            id,
            path: removed?.path ?? '',
            removedAssets: 12,
            filesUntouched: true,
          },
        })
      }

      if (url.includes('/api/library/assets')) {
        return json({ ok: true, value: { items: assets, total: assetTotal } })
      }

      throw new Error(`测试没有为这个请求准备响应：${method} ${url}`)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('素材库页面', () => {
  it('一条目录都没有时，说清楚下一步该做什么', async () => {
    render(<LibraryPage />)

    expect(
      await screen.findByText(/还没有添加任何目录。在下面填入一个本地文件夹的完整路径/),
    ).toBeTruthy()
    // 空列表有两种原因，这是「还没开始」的那种，文案要说的是「怎么做」
    expect(screen.getByText(/还没有素材。先在上面添加一个本地目录/)).toBeTruthy()
  })

  it('添加目录后出现在列表里，并提示该扫描了', async () => {
    const user = userEvent.setup()
    render(<LibraryPage />)
    await screen.findByText(/还没有添加任何目录/)

    await user.type(screen.getByPlaceholderText(/目录完整路径/), 'D:\\素材库')
    await user.click(screen.getByRole('button', { name: '添加目录' }))

    expect(await screen.findByText(/已添加/)).toBeTruthy()
    // 目录名与路径都会显示这个字符串（没有备注名时二者相同），
    // 所以这里断言「出现了」而不是「只出现一次」
    expect(await screen.findAllByText('D:\\素材库')).not.toHaveLength(0)
  })

  it('移除目录前必须说明磁盘文件不会被删', async () => {
    directories = [{ id: 1, path: 'D:\\素材库', label: '素材', lastScannedAt: null }]
    const user = userEvent.setup()
    render(<LibraryPage />)
    await screen.findByText('素材')

    await user.click(screen.getByRole('button', { name: '移除' }))

    // 这条文案是整个产品最重要的承诺，必须在动手之前就写清楚
    expect(screen.getByText(/磁盘上的文件和文件夹不会被删除/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '确认移除' }))

    expect(await screen.findByText(/磁盘上的原始文件一个都没有动/)).toBeTruthy()
    expect(deletedDirectoryIds).toEqual([1])
  })

  it('扫描结束后如实汇报跳过了多少不支持的文件', async () => {
    directories = [{ id: 1, path: 'D:\\素材库', label: '素材', lastScannedAt: null }]
    jobQueue = [
      {
        id: 7,
        status: 'running',
        progressCurrent: 3,
        progressTotal: 10,
        progressMessage: '已扫描 3 个文件',
        result: null,
        errorMessage: null,
      },
      {
        id: 7,
        status: 'succeeded',
        progressCurrent: 10,
        progressTotal: 10,
        progressMessage: '完成',
        result: {
          visited: 10,
          indexed: 4,
          updated: 0,
          unchanged: 0,
          skippedUnsupported: 6,
          removed: 0,
          completedCleanly: true,
          cancelled: false,
          errors: [],
        },
        errorMessage: null,
      },
    ]

    const user = userEvent.setup()
    render(<LibraryPage />)
    await screen.findByText('素材')

    await user.click(screen.getByRole('button', { name: '扫描' }))

    // 用户看着 10 个文件、索引里只有 4 个，唯一能解释这件事的就是这个计数
    expect(await screen.findByText(/跳过 6 个不支持的文件/, {}, { timeout: 3000 })).toBeTruthy()
    expect(scanRequests).toBe(1)
  })

  it('扫描被取消时绝不说「已完成」', async () => {
    directories = [{ id: 1, path: 'D:\\素材库', label: '素材', lastScannedAt: null }]
    jobQueue = [
      {
        id: 7,
        status: 'canceled',
        progressCurrent: 3,
        progressTotal: 10,
        progressMessage: '',
        result: null,
        errorMessage: null,
      },
    ]

    const user = userEvent.setup()
    render(<LibraryPage />)
    await screen.findByText('素材')

    await user.click(screen.getByRole('button', { name: '扫描' }))

    const notice = await screen.findByText(/扫描已取消/, {}, { timeout: 3000 })
    // 已扫到的部分留在索引里，但清理阶段没跑——索引可能还留着
    // 磁盘上已删掉的文件。说「完成」就是在骗用户。
    expect(notice.textContent).not.toContain('完成')
    expect(notice.textContent).toContain('没有清理已删除的文件')
  })

  it('扫描没跑完清理阶段时会额外提示', async () => {
    directories = [{ id: 1, path: 'D:\\素材库', label: '素材', lastScannedAt: null }]
    jobQueue = [
      {
        id: 7,
        status: 'succeeded',
        progressCurrent: 5,
        progressTotal: 5,
        progressMessage: '',
        result: {
          visited: 5,
          indexed: 5,
          updated: 0,
          unchanged: 0,
          skippedUnsupported: 0,
          removed: 0,
          completedCleanly: false,
          cancelled: false,
          errors: [],
        },
        errorMessage: null,
      },
    ]

    const user = userEvent.setup()
    render(<LibraryPage />)
    await screen.findByText('素材')
    await user.click(screen.getByRole('button', { name: '扫描' }))

    expect(
      await screen.findByText(/本次没有跑完清理阶段/, {}, { timeout: 3000 }),
    ).toBeTruthy()
  })

  it('素材列表点击后打开详情面板', async () => {
    assets = [
      {
        id: 42,
        directoryId: 1,
        path: 'D:\\素材库\\探店.mp4',
        fileName: '探店.mp4',
        ext: '.mp4',
        kind: 'video',
        sizeBytes: 2048,
        mtimeMs: Date.now(),
        extractStatus: 'none',
        updatedAt: Date.now(),
        tags: [],
      },
    ]
    assetTotal = 1

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/library/directories')) {
          return json({ ok: true, value: { items: directories } })
        }
        if (url.endsWith('/api/library/assets/42')) {
          return json({
            ok: true,
            value: {
              ...(assets[0] as Record<string, unknown>),
              fingerprint: 'a:1',
              durationMs: 61000,
              width: null,
              height: null,
              extractError: null,
              extractedAt: null,
              createdAt: Date.now(),
              segmentCount: 0,
            },
          })
        }
        if (url.includes('/api/library/assets')) {
          return json({ ok: true, value: { items: assets, total: assetTotal } })
        }
        throw new Error(`测试没有为这个请求准备响应：${url}`)
      }),
    )

    const user = userEvent.setup()
    render(<LibraryPage />)

    await user.click(await screen.findByText('探店.mp4'))

    // 「未提取」必须解释一句，否则用户会以为自己操作错了
    expect(await screen.findByText(/这条素材还没有提取过文字/)).toBeTruthy()
    expect(screen.getByText(/时长 1:01/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/还没有标签/)).toBeTruthy())
  })
})
