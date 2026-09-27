import { useCallback, useEffect, useState } from 'react'

import { toUserMessage } from '../api/client'
import {
  type AssetDetail,
  KIND_LABELS,
  STATUS_LABELS,
  formatBytes,
  formatTime,
  getAsset,
  linkTag,
  unlinkTag,
} from '../api/library'

/**
 * 素材详情面板（任务 3.9）。
 *
 * 这里要如实回答用户的两个问题：「这条素材是什么」以及
 * 「它的文字提取到哪一步了」。第二个问题的答案在提取阶段才会有内容，
 * 所以「未提取」是一个**正常且需要解释**的状态，不能只显示一个「—」
 * 让用户以为坏了——第一批不实现提取，用户看到的就是这个状态。
 */

interface Props {
  assetId: number
  onClose: () => void
  /** 标签增删后通知外面刷新列表，否则列表里的标签会与详情对不上 */
  onTagsChanged?: () => void
}

export default function AssetDetailPanel({ assetId, onClose, onTagsChanged }: Props) {
  const [detail, setDetail] = useState<AssetDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)

  const [newTag, setNewTag] = useState('')
  const [tagBusy, setTagBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setDetail(await getAsset(assetId))
      setLoadError(null)
    } catch (err) {
      setLoadError(toUserMessage(err))
    }
  }, [assetId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleAddTag() {
    const name = newTag.trim()
    if (name === '') return

    setTagBusy(true)
    setNotice(null)
    try {
      const result = await linkTag(assetId, name)
      setNewTag('')
      await reload()
      onTagsChanged?.()

      // 「已经挂过」是正常结果而不是错误，但值得说一句——
      // 否则用户会以为按钮没反应。
      setNotice(
        result.alreadyLinked
          ? { kind: 'info', text: `这条素材已经有「${result.tag.name}」标签了` }
          : { kind: 'ok', text: `已添加标签「${result.tag.name}」` },
      )
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setTagBusy(false)
    }
  }

  async function handleRemoveTag(tagId: number, name: string) {
    setTagBusy(true)
    setNotice(null)
    try {
      await unlinkTag(assetId, tagId)
      await reload()
      onTagsChanged?.()
      setNotice({ kind: 'ok', text: `已移除标签「${name}」` })
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setTagBusy(false)
    }
  }

  if (loadError !== null) {
    return (
      <aside className="detail-panel">
        <div className="detail-head">
          <h3 className="detail-title">素材详情</h3>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="notice notice-error">{loadError}</div>
      </aside>
    )
  }

  if (detail === null) {
    return (
      <aside className="detail-panel">
        <div className="detail-head">
          <h3 className="detail-title">素材详情</h3>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="page-desc">正在读取…</p>
      </aside>
    )
  }

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <h3 className="detail-title" title={detail.fileName}>
          {detail.fileName}
        </h3>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>

      <dl className="detail-list">
        <dt>类型</dt>
        <dd>
          {KIND_LABELS[detail.kind]} <span className="muted">（{detail.ext}）</span>
        </dd>

        <dt>提取状态</dt>
        <dd>
          <span className={`badge badge-${detail.extractStatus}`}>
            {STATUS_LABELS[detail.extractStatus]}
          </span>
          {detail.segmentCount > 0 ? (
            <span className="muted"> ・ {detail.segmentCount} 段文本</span>
          ) : null}
        </dd>

        <dt>大小</dt>
        <dd>
          {formatBytes(detail.sizeBytes)}
          {detail.durationMs !== null ? (
            <span className="muted"> ・ 时长 {formatDuration(detail.durationMs)}</span>
          ) : null}
          {detail.width !== null && detail.height !== null ? (
            <span className="muted">
              {' '}
              ・ {detail.width}×{detail.height}
            </span>
          ) : null}
        </dd>

        <dt>修改时间</dt>
        <dd>{formatTime(detail.mtimeMs)}</dd>

        <dt>完整路径</dt>
        <dd className="path-cell">{detail.path}</dd>
      </dl>

      {/*
        「未提取」必须解释一句。第一批还没有提取功能，用户点开详情
        只看到一个状态标签会以为是自己操作错了。这里如实说明它由谁负责，
        而不是含糊地写「暂无数据」。
      */}
      {detail.extractStatus === 'none' ? (
        <div className="notice notice-info">
          这条素材还没有提取过文字。文字提取在下一批功能中提供，
          提取后这里会显示带时间轴的文本。
        </div>
      ) : null}

      {detail.extractError !== null ? (
        <div className="notice notice-error">上次提取失败：{detail.extractError}</div>
      ) : null}

      <div className="detail-section">
        <h4 className="detail-subtitle">标签</h4>

        {detail.tags.length === 0 ? (
          <p className="field-hint">还没有标签。标签会参与关键词检索，也会出现在检索结果里。</p>
        ) : (
          <div className="tag-row">
            {detail.tags.map((tag) => (
              <span key={tag.id} className="tag-chip">
                {tag.name}
                <button
                  type="button"
                  className="tag-remove"
                  disabled={tagBusy}
                  title={`移除标签「${tag.name}」`}
                  onClick={() => void handleRemoveTag(tag.id, tag.name)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <form
          className="tag-form"
          onSubmit={(event) => {
            event.preventDefault()
            void handleAddTag()
          }}
        >
          <input
            type="text"
            value={newTag}
            placeholder="输入标签名后回车"
            spellCheck={false}
            onChange={(event) => setNewTag(event.target.value)}
          />
          <button type="submit" disabled={tagBusy || newTag.trim() === ''}>
            添加
          </button>
        </form>
      </div>

      {notice ? (
        <div className={`notice notice-${notice.kind}`} role="status">
          {notice.text}
        </div>
      ) : null}
    </aside>
  )
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
