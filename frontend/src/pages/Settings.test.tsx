// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SettingsPage from './Settings'

const REAL_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

interface MockState {
  configured: boolean
  maskedKey?: string
  model?: string
}

let state: MockState

/** 偏好设置的服务端状态。与凭证分开，模拟真实后端的两套存储。 */
let prefs: { textScript: string }

/** 置为 true 时偏好保存返回 500，用来验证失败回滚。 */
let failPrefSave: boolean

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

/**
 * 用假 fetch 模拟后端。
 *
 * 断言的是前端在**真实接口契约**下的行为——尤其是「未配置时润色入口禁用」
 * 与「密钥不以明文出现在页面上」这两条硬性要求。
 */
beforeEach(() => {
  state = { configured: false }
  prefs = { textScript: 'simplified' }
  failPrefSave = false

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {}

      if (url.endsWith('/api/settings/polish-availability')) {
        return json({
          ok: true,
          value: state.configured
            ? { available: true, model: state.model }
            : { available: false, reason: 'not_configured' },
        })
      }

      if (url.endsWith('/api/settings/preferences')) {
        if (method === 'PUT') {
          if (failPrefSave) {
            return json(
              { ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } },
              500,
            )
          }
          if (body['textScript'] !== 'simplified' && body['textScript'] !== 'traditional') {
            return json(
              {
                ok: false,
                error: {
                  code: 'VALIDATION_FAILED',
                  message: '「默认文本保存方式」只能是 simplified 或 traditional',
                },
              },
              400,
            )
          }
          prefs.textScript = body['textScript'] as string
        }
        return json({ ok: true, value: { ...prefs } })
      }

      if (url.endsWith('/api/settings/credentials/test')) {
        if (!state.configured) {
          return json(
            { ok: false, error: { code: 'CREDENTIALS_NOT_CONFIGURED', message: '尚未填写 API Key' } },
            409,
          )
        }
        return json({ ok: true, value: { model: state.model ?? 'claude-opus-5', inputTokens: 7 } })
      }

      if (url.endsWith('/api/settings/credentials')) {
        if (method === 'PUT') {
          if (body['apiKey'] === undefined && !state.configured) {
            return json(
              { ok: false, error: { code: 'VALIDATION_FAILED', message: '请填写 API Key' } },
              400,
            )
          }
          state = {
            configured: true,
            maskedKey: '****6789',
            model: (body['model'] as string) || state.model || 'claude-opus-5',
          }
          return json({ ok: true, value: state })
        }
        if (method === 'DELETE') {
          state = { configured: false }
          return json({ ok: true, value: { cleared: true } })
        }
        return json({ ok: true, value: state })
      }

      return json({ ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404)
    }),
  )
})

afterEach(() => {
  // 本项目没有开 vitest globals，testing-library 的自动清理不会注册，
  // 必须显式卸载——否则上一个用例的 DOM 会留在文档里造成重复匹配。
  cleanup()
  vi.unstubAllGlobals()
})

describe('未配置凭证时', () => {
  it('明示润色已停用，并说明其余功能不受影响', async () => {
    render(<SettingsPage />)

    expect(await screen.findByText(/尚未配置凭证/)).toBeTruthy()
    expect(screen.getByText(/素材检索与文字提取不依赖它/)).toBeTruthy()
  })

  it('测试与清除按钮都是禁用的', async () => {
    render(<SettingsPage />)
    await screen.findByText(/尚未配置凭证/)

    expect(screen.getByRole('button', { name: '测试连通性' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '清除凭证' }).hasAttribute('disabled')).toBe(true)
  })

  it('直接保存空 Key 会收到后端的校验提示', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await screen.findByText(/尚未配置凭证/)

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('请填写 API Key')).toBeTruthy()
  })
})

describe('填写并保存后', () => {
  it('回显只有末四位，页面上不出现完整密钥', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await screen.findByText(/尚未配置凭证/)

    await user.type(screen.getByLabelText(/API Key/), REAL_KEY)
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText(/已配置凭证/)).toBeTruthy()
    expect(screen.getByText('****6789')).toBeTruthy()

    // 这条是整个凭证设计的核心断言：渲染出来的 DOM 里不能有明文密钥。
    expect(document.body.innerHTML).not.toContain(REAL_KEY)
    expect(document.body.innerHTML).not.toContain(REAL_KEY.slice(0, 24))
  })

  it('输入框被清空，避免用户误以为密钥还留在页面上', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await screen.findByText(/尚未配置凭证/)

    const input = screen.getByLabelText(/API Key/) as HTMLInputElement
    await user.type(input, REAL_KEY)
    await user.click(screen.getByRole('button', { name: '保存' }))

    await screen.findByText(/已配置凭证/)
    expect((screen.getByLabelText(/API Key/) as HTMLInputElement).value).toBe('')
  })

  it('已配置后输入新 Key 但未保存时，禁止测试并说明原因', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await screen.findByText(/尚未配置凭证/)

    await user.type(screen.getByLabelText(/API Key/), REAL_KEY)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/已配置凭证/)

    // 输入一把新 Key 但不保存：此时测试测的仍是旧 Key，
    // 结果会与用户预期不符，所以要禁用并说明原因。
    await user.type(screen.getByLabelText(/API Key/), REAL_KEY)

    expect(screen.getByRole('button', { name: '测试连通性' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/未保存的改动/)).toBeTruthy()
  })

  it('保存后按钮解锁，测试得到成功提示', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await screen.findByText(/尚未配置凭证/)

    await user.type(screen.getByLabelText(/API Key/), REAL_KEY)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/已配置凭证/)

    const testButton = screen.getByRole('button', { name: '测试连通性' })
    await waitFor(() => expect(testButton.hasAttribute('disabled')).toBe(false))

    await user.click(testButton)
    expect(await screen.findByText(/连接正常/)).toBeTruthy()
    expect(screen.getByText(/未消耗生成额度/)).toBeTruthy()
  })
})

describe('清除凭证', () => {
  it('需要二次确认，确认后回到未配置状态', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await screen.findByText(/尚未配置凭证/)

    await user.type(screen.getByLabelText(/API Key/), REAL_KEY)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/已配置凭证/)

    await user.click(screen.getByRole('button', { name: '清除凭证' }))
    await user.click(await screen.findByRole('button', { name: '确认清除' }))

    expect(await screen.findByText(/尚未配置凭证/)).toBeTruthy()
    expect(screen.getByText(/已清除凭证/)).toBeTruthy()
  })

  it('可以取消，凭证保持不变', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await screen.findByText(/尚未配置凭证/)

    await user.type(screen.getByLabelText(/API Key/), REAL_KEY)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/已配置凭证/)

    await user.click(screen.getByRole('button', { name: '清除凭证' }))
    await user.click(await screen.findByRole('button', { name: '取消' }))

    expect(screen.getByText(/已配置凭证/)).toBeTruthy()
  })
})

describe('默认文本保存方式', () => {
  function scriptSelect(): HTMLSelectElement {
    return screen.getByLabelText(/默认文本保存方式/) as HTMLSelectElement
  }

  it('默认选中简体中文', async () => {
    render(<SettingsPage />)

    await waitFor(() => expect(scriptSelect().value).toBe('simplified'))
    // 选项文案是产品要求的一部分，钉住它免得被顺手改成英文枚举值
    expect(screen.getByRole('option', { name: '简体中文（默认）' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '繁体中文' })).toBeTruthy()
  })

  it('读取到繁体的偏好时选中繁体', async () => {
    prefs.textScript = 'traditional'
    render(<SettingsPage />)

    await waitFor(() => expect(scriptSelect().value).toBe('traditional'))
  })

  it('改选后立刻保存，无需再点保存按钮', async () => {
    const user = userEvent.setup()
    render(<SettingsPage />)
    await waitFor(() => expect(scriptSelect().value).toBe('simplified'))

    await user.selectOptions(scriptSelect(), 'traditional')

    // 断言到「服务端状态真的变了」，而不只是下拉框显示变了——
    // 只改本地 state 的话界面一模一样，重启后偏好就丢了。
    await waitFor(() => expect(prefs.textScript).toBe('traditional'))
    expect(scriptSelect().value).toBe('traditional')
  })

  it('保存失败时回滚显示，不留下「看着像改好了」的假象', async () => {
    const user = userEvent.setup()
    failPrefSave = true
    render(<SettingsPage />)
    await waitFor(() => expect(scriptSelect().value).toBe('simplified'))

    await user.selectOptions(scriptSelect(), 'traditional')

    // 下拉框必须弹回简体。停在一个没写进库的值上，用户会以为设置生效了，
    // 然后发现搜不到东西——这正是这个功能要解决的问题本身。
    expect(await screen.findByText(/服务器内部错误/)).toBeTruthy()
    expect(scriptSelect().value).toBe('simplified')
  })

  it('说明改动只影响之后提取的素材', async () => {
    render(<SettingsPage />)
    await waitFor(() => expect(scriptSelect().value).toBe('simplified'))

    // 文本是提取时就落库的，改设置**不会**回头重写已提取的内容。
    // 不说清楚的话，用户改完设置去搜旧素材，会以为这个设置没生效。
    expect(screen.getByText(/需要重新提取一次/)).toBeTruthy()
  })

  it('偏好读取失败不影响凭证区域', async () => {
    // 偏好读的是数据库、凭证读的是文件，一边坏掉不该拖垮整页。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/settings/preferences')) {
          return json({ ok: false, error: { code: 'INTERNAL', message: '数据库打不开' } }, 500)
        }
        if (url.endsWith('/api/settings/polish-availability')) {
          return json({ ok: true, value: { available: false, reason: 'not_configured' } })
        }
        if (url.endsWith('/api/settings/credentials')) {
          return json({ ok: true, value: { configured: false } })
        }
        return json({ ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404)
      }),
    )

    render(<SettingsPage />)

    expect(await screen.findByText('数据库打不开')).toBeTruthy()
    // 凭证区照常显示，而不是整页变成错误页
    expect(screen.getByText(/尚未配置凭证/)).toBeTruthy()
  })
})
