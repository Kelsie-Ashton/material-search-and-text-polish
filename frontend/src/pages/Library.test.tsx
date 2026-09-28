// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
/** 正在跑的提取任务，喂给列表那条 /api/jobs?type=extract&active=1 轮询 */
let activeJobs: unknown[]
/** 详情接口比列表多出来的字段，按素材 id 覆盖 */
let detailExtras: Record<number, Record<string, unknown>>
/** 发起提取的响应体 */
let extractionResponse: unknown
/** 取提取文本的响应体 */
let segmentsResponse: unknown
/** 润色可用性。默认「未配置」——这是最常见的初始状态 */
let polishAvailability: unknown
/** 读润色结果（GET）的响应体 */
let polishState: unknown
/** 发起润色（POST）的响应体，或 { status, error } 形式的失败 */
let polishResponse: unknown
let polishRequests: number

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
  activeJobs = []
  detailExtras = {}
  extractionResponse = { ok: true, value: { items: [], total: 0 } }
  segmentsResponse = { ok: true, value: { items: [], total: 0 } }
  polishAvailability = { ok: true, value: { available: false, reason: 'not_configured' } }
  polishState = { ok: true, value: { result: null, lastFailure: null } }
  polishResponse = { ok: true, value: { status: 'done', result: null } }
  polishRequests = 0

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

      // 素材列表上那条「提取进度」轮询。返回空数组就是「现在没有在跑的提取」。
      if (url.includes('/api/jobs?') && method === 'GET') {
        return json({ ok: true, value: { items: activeJobs } })
      }

      if (url.includes('/api/jobs/') && method === 'GET') {
        const next = jobQueue.shift()
        return json({ ok: true, value: next })
      }

      // 润色：可用性、读结果、发起。
      if (url.includes('/api/settings/polish-availability')) {
        return json(polishAvailability)
      }

      if (/\/api\/polish\/assets\/\d+$/.test(url) && method === 'GET') {
        return json(polishState)
      }

      if (/\/api\/polish\/assets\/\d+$/.test(url) && method === 'POST') {
        polishRequests += 1
        if (!('ok' in (polishResponse as Record<string, unknown>))) {
          const failure = polishResponse as { status: number; error: unknown }
          return json({ ok: false, error: failure.error }, failure.status)
        }
        // 成功后 GET 就该读得到这条结果——替身不跟着变的话，
        // 测的就是一个后端不会出现的状态
        polishState = { ok: true, value: { result: (polishResponse as { value: { result: unknown } }).value.result, lastFailure: null } }
        return json(polishResponse)
      }

      // 提取的两个端点。segments 要排在前面判断——它的路径是另一个的前缀。
      if (/\/api\/extraction\/assets\/\d+\/segments/.test(url) && method === 'GET') {
        return json(segmentsResponse)
      }

      const extractMatch = /\/api\/extraction\/assets\/(\d+)$/.exec(url)
      if (extractMatch && method === 'POST') {
        if (!('ok' in (extractionResponse as Record<string, unknown>))) {
          // 用 { status, error } 的形式指定一个失败响应
          const failure = extractionResponse as { status: number; error: unknown }
          return json({ ok: false, error: failure.error }, failure.status)
        }

        // 提取成功会让素材状态与段落数真的变掉，之后再读详情就该是新值。
        // 替身如果不跟着变，测的就是一个后端不会出现的状态。
        const value = (extractionResponse as { value?: Record<string, unknown> }).value
        if (value?.['mode'] === 'imported') {
          const id = Number(extractMatch[1])
          detailExtras[id] = {
            ...(detailExtras[id] ?? {}),
            extractStatus: 'done',
            segmentCount: value['segmentCount'],
          }
        }
        return json(extractionResponse)
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

      // 详情要在列表前面判断：前者是后者的路径前缀。
      const detailMatch = /\/api\/library\/assets\/(\d+)$/.exec(url)
      if (detailMatch && method === 'GET') {
        const id = Number(detailMatch[1])
        const found = assets.find((item) => (item as { id: number }).id === id)
        if (found === undefined) return json({ ok: false, error: { code: 'ASSET_NOT_FOUND', message: '素材不存在' } }, 404)
        return json({
          ok: true,
          value: {
            ...(found as Record<string, unknown>),
            fingerprint: 'a:1',
            durationMs: null,
            width: null,
            height: null,
            extractError: null,
            extractedAt: null,
            createdAt: Date.now(),
            segmentCount: 0,
            ...(detailExtras[id] ?? {}),
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

/**
 * 让素材库里有且仅有一条素材（id 固定为 42）。
 *
 * 详情面板要靠「列表里有这一行、点得开」才能测，所以每个用例都得先铺一份列表。
 */
function useAsset(overrides: {
  fileName: string
  ext: string
  kind: string
  /** 列表那一行显示的提取状态。默认「未提取」 */
  extractStatus?: string
}): void {
  assets = [
    {
      id: 42,
      directoryId: 1,
      path: `D:\\素材库\\${overrides.fileName}`,
      fileName: overrides.fileName,
      ext: overrides.ext,
      kind: overrides.kind,
      sizeBytes: 2048,
      mtimeMs: Date.now(),
      extractStatus: overrides.extractStatus ?? 'none',
      updatedAt: Date.now(),
      tags: [],
    },
  ]
  assetTotal = 1
}

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
    useAsset({ fileName: '探店.mp4', ext: '.mp4', kind: 'video' })
    detailExtras[42] = { durationMs: 61000 }

    const user = userEvent.setup()
    render(<LibraryPage />)

    await user.click(await screen.findByText('探店.mp4'))

    expect(await screen.findByText(/时长 1:01/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/还没有标签/)).toBeTruthy())
  })

  describe('提取入口', () => {
    it('视频：说清楚提取的是语音，画面上的字要等 OCR', async () => {
      useAsset({ fileName: '探店.mp4', ext: '.mp4', kind: 'video' })

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('探店.mp4'))

      // 番剧的台词常写在画面上，用户按「提取文字」却没拿到那些字，
      // 不提前说明就会被当成程序漏了。
      const button = await screen.findByRole('button', { name: '提取语音文字' })
      expect((button as HTMLButtonElement).disabled).toBe(false)
      expect(screen.getByText(/提取的是视频里的语音/)).toBeTruthy()
      expect(screen.getByText(/画面上的文字/)).toBeTruthy()
    })

    it('图片：按钮禁用并说明 OCR 暂不提供', async () => {
      useAsset({ fileName: '封面.png', ext: '.png', kind: 'image' })

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('封面.png'))

      // 禁用的按钮如果不说明原因，用户只会以为程序坏了
      const button = await screen.findByRole('button', { name: '识别图片文字' })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText(/OCR.*暂不提供/)).toBeTruthy()
    })

    it('字幕：导入后把带时间轴的文本显示出来', async () => {
      useAsset({ fileName: '第01话.ass', ext: '.ass', kind: 'text' })
      extractionResponse = {
        ok: true,
        value: { mode: 'imported', assetId: 42, status: 'done', segmentCount: 2, reused: false, empty: false },
      }
      segmentsResponse = {
        ok: true,
        value: {
          items: [
            { id: 1, source: 'file', ordinal: 0, text: '招牌菜是毛肚', startMs: 1000, endMs: 3000 },
            { id: 2, source: 'file', ordinal: 1, text: '鸭肠也要点', startMs: 3000, endMs: 5600 },
          ],
          total: 2,
        },
      }

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('第01话.ass'))

      await user.click(await screen.findByRole('button', { name: '导入字幕文字' }))

      expect(await screen.findByText(/已导入 2 段字幕文字/)).toBeTruthy()
      // 提取跑完了却看不到结果，等于没提取——时间轴与正文都要在
      expect(await screen.findByText('招牌菜是毛肚')).toBeTruthy()
      expect(screen.getByText('00:01')).toBeTruthy()
      expect(screen.getByText('00:03')).toBeTruthy()
      expect(await screen.findByText('鸭肠也要点')).toBeTruthy()
    })

    it('纯文本：按钮可用，点下去真的把文字导进来', async () => {
      useAsset({ fileName: '歌词.txt', ext: '.txt', kind: 'text' })
      extractionResponse = {
        ok: true,
        value: { mode: 'imported', assetId: 42, status: 'done', segmentCount: 2, reused: false, empty: false },
      }
      segmentsResponse = {
        ok: true,
        value: {
          items: [
            { id: 1, source: 'file', ordinal: 0, text: '第一句歌词', startMs: null, endMs: null },
            { id: 2, source: 'file', ordinal: 1, text: '第二句歌词', startMs: null, endMs: null },
          ],
          total: 2,
        },
      }

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('歌词.txt'))

      // 按钮上的字要说准：纯文本没有时间轴，说成「导入字幕文字」会让
      // 用户以为程序把歌词当字幕解析了。
      await user.click(await screen.findByRole('button', { name: '导入文本文字' }))

      expect(await screen.findByText(/已导入 2 段文本文字/)).toBeTruthy()
      // 没有时间轴的段落不该显示 00:00
      expect(await screen.findByText('第一句歌词')).toBeTruthy()
      expect(screen.queryByText('00:00')).toBeNull()
    })

    it('还不能直接读的文本格式：按钮禁用并说明原因', async () => {
      // config.ts 里 text 那一档现在都能导入了，这条走的是兜底分支——
      // 留着它是为了「加了扩展名却忘了接上」那天，界面上仍有一句说得通的话，
      // 而不是让用户对着一个点不动的按钮猜。
      useAsset({ fileName: '日志.log', ext: '.log', kind: 'text' })

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('日志.log'))

      const button = await screen.findByRole('button', { name: '提取文字' })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText(/还不能直接读进索引/)).toBeTruthy()
    })

    it('导入失败：把后端给的原因原样显示，不换成笼统的「操作失败」', async () => {
      // 这些原因（文件被删了、编码有问题、格式不认）用户都能自己处理，
      // 换成「操作失败」四个字，等于把唯一有用的线索扔了。
      useAsset({ fileName: '歌词.txt', ext: '.txt', kind: 'text' })
      extractionResponse = {
        status: 500,
        error: { code: 'EXTRACTION_FAILED', message: '无法读取文本文件：ENOENT: no such file or directory' },
      }

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('歌词.txt'))
      await user.click(await screen.findByRole('button', { name: '导入文本文字' }))

      expect(await screen.findByText(/无法读取文本文件/)).toBeTruthy()
    })

    it('音视频排队后，列表那一行会显示进度说明', async () => {
      useAsset({ fileName: '探店.mp4', ext: '.mp4', kind: 'video', extractStatus: 'running' })
      activeJobs = [
        {
          id: 9,
          type: 'extract',
          status: 'running',
          targetId: 42,
          progressCurrent: 0,
          progressTotal: 0,
          progressMessage: '正在转写语音',
          result: null,
          errorCode: null,
          errorMessage: null,
        },
      ]

      render(<LibraryPage />)

      // 200 行素材时，这一句是用户唯一能知道「它在动」的地方
      expect(await screen.findByText('正在转写语音')).toBeTruthy()
      // 只看表格里那一行。整个页面还有筛选下拉框，它的选项里也写着「提取中」，
      // 不圈定范围的话这条断言靠的是下拉框，跟提取状态没关系。
      expect(within(screen.getByRole('table')).getByText('提取中')).toBeTruthy()
    })

    // 这条要等真实的两秒轮询跑一轮，比默认的 5 秒用例超时还长，
    // 所以显式放宽——不是测试写慢了，是它测的东西本来就是「等一等会自己好」。
    it('提取跑完后列表自己刷新，不会永远停在「提取中」', { timeout: 15_000 }, async () => {
      useAsset({ fileName: '探店.mp4', ext: '.mp4', kind: 'video', extractStatus: 'running' })
      activeJobs = [
        {
          id: 9,
          type: 'extract',
          status: 'running',
          targetId: 42,
          progressCurrent: 0,
          progressTotal: 0,
          progressMessage: '正在转写语音',
          result: null,
          errorCode: null,
          errorMessage: null,
        },
      ]

      render(<LibraryPage />)
      expect(await screen.findByText('正在转写语音')).toBeTruthy()

      // 任务结束。库里的状态已经是「已提取」，但列表手里那份是**当时读回来的**，
      // 已经是旧的了——用户开着页面不动，那一行就会一直写着「提取中」。
      activeJobs = []
      assets = [{ ...(assets[0] as Record<string, unknown>), extractStatus: 'done' }]

      await waitFor(() => expect(within(screen.getByRole('table')).queryByText('提取中')).toBeNull(), {
        timeout: 6000,
      })
      expect(within(screen.getByRole('table')).getByText('已提取')).toBeTruthy()
    })
  })
  describe('润色入口', () => {
    /** 一条已经提取过文字的素材——润色的前提 */
    function usePolishedAsset(): void {
      useAsset({ fileName: '探店.mp4', ext: '.mp4', kind: 'video', extractStatus: 'done' })
      detailExtras[42] = { extractStatus: 'done', segmentCount: 3 }
      segmentsResponse = {
        ok: true,
        value: { items: [{ id: 1, source: 'audio', ordinal: 0, text: '今天我们来探店', startMs: 0, endMs: 3000 }], total: 1 },
      }
    }

    it('未配置凭证：按钮禁用，并指向设置页而不是笼统地说「不可用」', async () => {
      usePolishedAsset()

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('探店.mp4'))

      const button = await screen.findByRole('button', { name: '润色成文案' })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      // 「去设置页填 Key」是用户此刻唯一能做的事，
      // 说成「暂时不可用」他就只能干等
      expect(screen.getByText(/请先到设置页填写/)).toBeTruthy()
    })

    it('已配置但还没提取文字：按钮禁用，并说清要先提取', async () => {
      // 这条与上一条必须给不同的话：一个要去设置页，一个要先提取。
      // 两件事合起来说，用户会去做错的那一件。
      useAsset({ fileName: '探店.mp4', ext: '.mp4', kind: 'video' })
      polishAvailability = { ok: true, value: { available: true, model: 'claude-opus-5' } }

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('探店.mp4'))

      const button = await screen.findByRole('button', { name: '润色成文案' })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText(/先在上面提取一次/)).toBeTruthy()
    })

    it('已配置且有文字：点一下就能看到润色结果，与原文同屏对照', async () => {
      usePolishedAsset()
      polishAvailability = { ok: true, value: { available: true, model: 'claude-opus-5' } }
      polishResponse = {
        ok: true,
        value: {
          status: 'done',
          result: {
            id: 1,
            assetId: 42,
            body: '今天我们来探店这家火锅店。',
            model: 'claude-opus-5',
            promptVersion: 'polish-v1',
            inputTokens: 10,
            outputTokens: 20,
            createdAt: Date.now(),
          },
        },
      }

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('探店.mp4'))

      const button = await screen.findByRole('button', { name: '润色成文案' })
      expect((button as HTMLButtonElement).disabled).toBe(false)
      await user.click(button)

      // 润色结果与上面的「提取文本」同屏，两处各有各的标题，分得清哪个是原文
      expect(await screen.findByText('今天我们来探店这家火锅店。')).toBeTruthy()
      expect(screen.getByText(/这里是整理后的版本/)).toBeTruthy()
      expect(screen.getByText('文字提取')).toBeTruthy()
    })

    it('润色失败：把后端给的原因原样显示，并留下面板上的失败记录', async () => {
      // 凭证无效、额度不足、网络不通要做的事完全不同，
      // 换成一句笼统的「润色失败」等于把用户丢在原地
      usePolishedAsset()
      polishAvailability = { ok: true, value: { available: true, model: 'claude-opus-5' } }
      polishResponse = {
        status: 402,
        error: { code: 'CREDENTIALS_BILLING', message: '账户额度不足，请前往服务商后台充值' },
      }
      polishState = {
        ok: true,
        value: {
          result: null,
          lastFailure: {
            code: 'CREDENTIALS_BILLING',
            message: '账户额度不足，请前往服务商后台充值',
            createdAt: Date.now(),
          },
        },
      }

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('探店.mp4'))

      await user.click(await screen.findByRole('button', { name: '润色成文案' }))

      // 两处都要有：顶部那条是本次操作的即时反馈，面板里这条是**留得住的记录**
      // （刷新页面后仍在）。只留前者的话，用户一刷新就不知道刚才为什么没成。
      expect(await screen.findByText(/上次润色失败：账户额度不足/)).toBeTruthy()
      expect(screen.getByRole('status').textContent).toContain('账户额度不足')
    })

    it('未配置凭证时不会发出润色请求（不产生费用）', async () => {
      usePolishedAsset()

      const user = userEvent.setup()
      render(<LibraryPage />)
      await user.click(await screen.findByText('探店.mp4'))

      const button = await screen.findByRole('button', { name: '润色成文案' })
      await user.click(button)

      expect(polishRequests).toBe(0)
    })
  })
})
