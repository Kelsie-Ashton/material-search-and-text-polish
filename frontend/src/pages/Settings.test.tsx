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
