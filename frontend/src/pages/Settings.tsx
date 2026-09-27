import { useCallback, useEffect, useState } from 'react'

import { toUserMessage } from '../api/client'
import {
  type CredentialsStatus,
  type PolishAvailability,
  clearCredentials,
  getCredentials,
  getPolishAvailability,
  saveCredentials,
  testCredentials,
} from '../api/settings'

type Notice = { kind: 'ok' | 'error' | 'info'; text: string }
type Busy = null | 'save' | 'test' | 'clear'

export default function SettingsPage() {
  const [status, setStatus] = useState<CredentialsStatus | null>(null)
  const [availability, setAvailability] = useState<PolishAvailability | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')

  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [nextStatus, nextAvailability] = await Promise.all([
        getCredentials(),
        getPolishAvailability(),
      ])
      setStatus(nextStatus)
      setAvailability(nextAvailability)
      setModel(nextStatus.model ?? '')
      setBaseUrl(nextStatus.baseUrl ?? '')
      setLoadError(null)
    } catch (err) {
      setLoadError(toUserMessage(err))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 测试测的是**已保存**的凭证。输入框里有未保存的 Key 时，测试结果会与
  // 用户的预期不符，所以直接禁用并说明原因，而不是让他去猜。
  const hasUnsavedKey = apiKey.trim().length > 0
  const configured = status?.configured ?? false

  async function handleSave() {
    setBusy('save')
    setNotice(null)
    try {
      const trimmedKey = apiKey.trim()
      const saved = await saveCredentials({
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
        model: model.trim(),
        baseUrl: baseUrl.trim(),
      })

      setStatus(saved)
      setApiKey('')
      setModel(saved.model ?? '')
      setBaseUrl(saved.baseUrl ?? '')
      setAvailability(await getPolishAvailability())
      setNotice({ kind: 'ok', text: '已保存。密钥只存放在本机，不会进入代码仓库。' })
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  async function handleTest() {
    setBusy('test')
    setNotice(null)
    try {
      const result = await testCredentials()
      setNotice({
        kind: 'ok',
        text: `连接正常，模型「${result.model}」可用。本次测试未消耗生成额度。`,
      })
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  async function handleClear() {
    setBusy('clear')
    setNotice(null)
    try {
      await clearCredentials()
      setConfirmingClear(false)
      setApiKey('')
      await reload()
      setNotice({
        kind: 'info',
        text: '已清除凭证，润色功能已停用；检索与文字提取不受影响。',
      })
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  if (loadError !== null) {
    return (
      <section className="page">
        <h2 className="page-title">设置</h2>
        <div className="notice notice-error">{loadError}</div>
        <button type="button" onClick={() => void reload()}>
          重试
        </button>
      </section>
    )
  }

  if (status === null) {
    return (
      <section className="page">
        <h2 className="page-title">设置</h2>
        <p className="page-desc">正在读取本机凭证…</p>
      </section>
    )
  }

  return (
    <section className="page">
      <h2 className="page-title">设置</h2>
      <p className="page-desc">
        润色功能需要一把你自己的云端模型 API Key。密钥只保存在本机，不会进入代码仓库。
      </p>

      <div className={`status-card ${configured ? 'is-ok' : 'is-off'}`}>
        {configured ? (
          <>
            <div className="status-line">
              <span className="status-dot" /> 已配置凭证
            </div>
            <div className="status-detail">
              当前密钥 <code>{status.maskedKey}</code> ・ 模型 <code>{status.model}</code>
              {status.baseUrl ? (
                <>
                  {' '}
                  ・ 代理 <code>{status.baseUrl}</code>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="status-line">
              <span className="status-dot" /> 尚未配置凭证 —— 润色功能已停用
            </div>
            <div className="status-detail">
              {availability?.available === false && availability.reason === 'store_corrupt'
                ? '凭证文件已损坏，需要重新填写一把 Key 才能恢复。'
                : '素材检索与文字提取不依赖它，可以照常使用。'}
            </div>
          </>
        )}
      </div>

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <label className="field">
          <span className="field-label">API Key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={configured ? `已保存 ${status.maskedKey}（留空则不修改）` : '粘贴你的 API Key'}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <span className="field-hint">
            只写进本机的 <code>data/credentials.json</code>，该目录已被 .gitignore 忽略。
          </span>
        </label>

        <label className="field">
          <span className="field-label">模型</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={model}
            placeholder="claude-opus-5"
            onChange={(event) => setModel(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">代理地址（可选）</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            placeholder="留空则使用官方地址"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>

        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy !== null}>
            {busy === 'save' ? '保存中…' : '保存'}
          </button>

          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={busy !== null || !configured || hasUnsavedKey}
            title={
              hasUnsavedKey
                ? '输入框里有未保存的 Key，请先保存'
                : !configured
                  ? '请先填写并保存 API Key'
                  : undefined
            }
          >
            {busy === 'test' ? '测试中…' : '测试连通性'}
          </button>

          {confirmingClear ? (
            <>
              <button
                type="button"
                className="btn-danger"
                disabled={busy !== null}
                onClick={() => void handleClear()}
              >
                {busy === 'clear' ? '清除中…' : '确认清除'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirmingClear(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-danger"
              disabled={busy !== null || !configured}
              onClick={() => setConfirmingClear(true)}
            >
              清除凭证
            </button>
          )}
        </div>

        {hasUnsavedKey && configured ? (
          <p className="field-hint">输入框里有未保存的改动，保存后才能测试。</p>
        ) : null}
      </form>

      {notice ? (
        <div className={`notice notice-${notice.kind}`} role="status">
          {notice.text}
        </div>
      ) : null}

      <div className="callout">
        <strong>关于密钥安全</strong>
        <ul>
          <li>密钥不存在于任何源码或构建产物中，只能由你在此页面填写。</li>
          <li>
            存放目录 <code>data/</code> 已被 <code>.gitignore</code> 忽略，不会提交到 GitHub。
          </li>
          <li>
            未填写时，润色按钮会被禁用并提示原因；检索与文字提取不受影响。
          </li>
        </ul>
      </div>
    </section>
  )
}
