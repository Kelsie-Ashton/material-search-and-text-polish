import { useCallback, useEffect, useState } from 'react'

import { toUserMessage } from '../api/client'
import {
  type TextSegment,
  SOURCE_LABELS,
  extractionPlan,
  formatTimestamp,
  importNoun,
  listSegments,
  startExtraction,
} from '../api/extraction'
import { type JobRecord, getJob } from '../api/jobs'
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
 * 素材详情面板（任务 3.9 + 5.12）。
 *
 * 这里要如实回答用户的三个问题：「这条素材是什么」「它的文字提取到哪一步了」
 * 「提取出来的文字长什么样」。第三个问题是这一页存在的理由——
 * 提取跑完了却看不到结果，等于没提取。
 *
 * 「未提取」是一个**正常且需要解释**的状态，不能只显示一个「—」
 * 让用户以为坏了。同理，图片与纯文本现在提不了，也要说清楚为什么、什么时候有。
 */

interface Props {
  assetId: number
  onClose: () => void
  /** 标签增删后通知外面刷新列表，否则列表里的标签会与详情对不上 */
  onTagsChanged?: () => void
  /**
   * 提取的开始与结束都要通知外面刷新列表。
   *
   * 开始也要：后端在入队那一刻就把素材推成了「排队中」，列表上那一行
   * 立刻就该变。等结束再刷的话，用户点了提取却看到那一行还写着「未提取」，
   * 只会以为没点上，然后再点一次。
   */
  onExtractionChanged?: () => void
}

/** 轮询间隔。与素材库页一致：转写是分阶段上报的，800ms 足以让进度看起来连续。 */
const POLL_INTERVAL_MS = 800

type Notice = { kind: 'ok' | 'error' | 'info'; text: string }

export default function AssetDetailPanel({
  assetId,
  onClose,
  onTagsChanged,
  onExtractionChanged,
}: Props) {
  const [detail, setDetail] = useState<AssetDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const [newTag, setNewTag] = useState('')
  const [tagBusy, setTagBusy] = useState(false)

  /** 正在跟踪的提取任务。非空时以 800ms 轮询。 */
  const [extractJob, setExtractJob] = useState<JobRecord | null>(null)
  const [extractBusy, setExtractBusy] = useState(false)

  const [segments, setSegments] = useState<TextSegment[] | null>(null)
  const [segmentTotal, setSegmentTotal] = useState(0)

  const reload = useCallback(async () => {
    try {
      setDetail(await getAsset(assetId))
      setLoadError(null)
    } catch (err) {
      setLoadError(toUserMessage(err))
    }
  }, [assetId])

  const reloadSegments = useCallback(async () => {
    try {
      const result = await listSegments(assetId)
      setSegments(result.items)
      setSegmentTotal(result.total)
    } catch (err) {
      // 读不到文本不该让整个面板变成错误页——上面那些元信息仍然有用
      setSegments([])
      setNotice({ kind: 'error', text: `读取提取文本失败：${toUserMessage(err)}` })
    }
  }, [assetId])

  useEffect(() => {
    void reload()
  }, [reload])

  // 详情里说了「已有 N 段文本」却拿不出来，是最让人困惑的一种空。
  // 只要那边报了有内容，这边就去取。
  useEffect(() => {
    if (detail === null) return
    if (detail.segmentCount === 0) {
      setSegments(null)
      setSegmentTotal(0)
      return
    }
    void reloadSegments()
  }, [detail, reloadSegments])

  // ---------------------------------------------------------- 提取轮询

  useEffect(() => {
    if (extractJob === null) return

    // 终态：停止轮询，把详情与文本都重新读一遍，并把结果讲清楚
    if (extractJob.status !== 'queued' && extractJob.status !== 'running') {
      setExtractJob(null)
      void reload()
      void reloadSegments()
      onExtractionChanged?.()

      if (extractJob.status === 'failed') {
        setNotice({ kind: 'error', text: extractJob.errorMessage ?? '提取失败' })
      } else if (extractJob.status === 'canceled') {
        // 被取消时**绝不能**说「提取完成」。已经转写出来的部分留在索引里，
        // 但后半段没有——用户按「完成」去找后面的内容会找不到。
        setNotice({
          kind: 'info',
          text: '提取已取消。已经识别出来的部分保留在索引里，后面的内容没有提取。',
        })
      } else {
        setNotice({ kind: 'ok', text: '提取完成。' })
      }
      return
    }

    // 自身重排的轮询：每次拿到新状态后重新起一个定时器，而不是 setInterval——
    // 后者在上一次请求还没回来时会叠发。
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          setExtractJob(await getJob(extractJob.id))
        } catch (err) {
          // 轮询失败不把进度抹掉：任务可能还在跑，留着上一次的进度
          // 比空着更有用。
          setNotice({ kind: 'error', text: `读取提取进度失败：${toUserMessage(err)}` })
        }
      })()
    }, POLL_INTERVAL_MS)

    return () => window.clearTimeout(timer)
  }, [extractJob, reload, reloadSegments, onExtractionChanged])

  // ---------------------------------------------------------- 操作

  async function handleExtract() {
    setExtractBusy(true)
    setNotice(null)
    try {
      const result = await startExtraction(assetId)

      if (result.mode === 'imported') {
        // 同步完成的那条路（字幕与纯文本）：结果已经在了，直接读回来
        await reload()
        await reloadSegments()
        onExtractionChanged?.()

        // 读进来的是字幕还是纯文本，提示语要说准——同一句
        // 「已导入 N 段字幕文字」扣在一份 .txt 歌词上会让人以为
        // 程序把它当字幕解析了，而歌词里一个字的时间轴都没有。
        const noun = detail ? importNoun(detail.ext) : '文本'

        if (result.empty) {
          // 「已提取、无内容」不是失败——前者不需要重试，后者需要。
          // 说清楚是文件里本来就没有文字，而不是程序没干活。
          setNotice({
            kind: 'info',
            text: '已读取这个文件，但没有读出任何文字内容。可能是空文件，或格式不被识别。',
          })
        } else if (result.reused) {
          setNotice({
            kind: 'info',
            text: `这条素材的提取结果已经是最新的（${result.segmentCount} 段），直接复用了上次的结果。`,
          })
        } else {
          setNotice({ kind: 'ok', text: `已导入 ${result.segmentCount} 段${noun}文字。` })
        }
        return
      }

      // 入队的那条路（音视频）：拿到任务 id，交给上面的轮询去跟
      setExtractJob(await getJob(result.jobId))
      onExtractionChanged?.()
      setNotice({
        kind: 'info',
        text: '已提交提取任务。转写要跑一段时间，可以留在这里看进度，也可以先去做别的。',
      })
    } catch (err) {
      // 图片与纯文本走到这里。后端那句话已经写清楚了原因，
      // 直接展示，不要替换成笼统的「操作失败」。
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setExtractBusy(false)
    }
  }

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

  const plan = extractionPlan(detail)
  const extractRunning = extractJob !== null

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

      {/* ---------------------------------------------------------- 提取 */}

      <div className="detail-section">
        <h4 className="detail-subtitle">文字提取</h4>

        <div className="extract-action">
          <button
            type="button"
            disabled={!plan.available || extractBusy || extractRunning}
            title={plan.available ? undefined : plan.hint}
            onClick={() => void handleExtract()}
          >
            {extractBusy || extractRunning ? '提取中…' : plan.label}
          </button>
          {detail.extractedAt !== null ? (
            <span className="muted">上次提取：{formatTime(detail.extractedAt)}</span>
          ) : null}
        </div>

        {/* 说清楚点了会发生什么、以及现在为什么点不了。
            禁用的按钮如果不说原因，用户只会以为程序坏了。 */}
        <p className="field-hint">{plan.hint}</p>

        {extractRunning && extractJob !== null ? (
          <div className="scan-progress">
            <div className="progress-track">
              <div
                className={
                  extractJob.progressTotal > 0 ? 'progress-fill' : 'progress-fill is-indeterminate'
                }
                /*
                  总数为 0 表示「不知道还剩多少」（转写事前算不出总量），
                  这时画一条呼吸条，而不是拿 0 去做除数、卡在 0% 像死了一样。
                */
                style={
                  extractJob.progressTotal > 0
                    ? {
                        width: `${Math.round(
                          (extractJob.progressCurrent / extractJob.progressTotal) * 100,
                        )}%`,
                      }
                    : undefined
                }
              />
            </div>
            <div className="scan-line">
              <span className="muted">
                {extractJob.progressMessage ?? '正在提取…'}
                {extractJob.progressTotal > 0
                  ? `（${extractJob.progressCurrent}/${extractJob.progressTotal}）`
                  : ''}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* 提取失败的原因要留在面板上，不能只在通知里闪一下就没了 */}
      {detail.extractError !== null ? (
        <div className="notice notice-error">上次提取失败：{detail.extractError}</div>
      ) : null}

      {/* ---------------------------------------------------------- 结果文本 */}

      {segments !== null && segments.length > 0 ? (
        <div className="detail-section">
          <h4 className="detail-subtitle">
            提取文本
            <span className="muted">
              {' '}
              {segmentTotal} 段
              {segmentTotal > segments.length ? `（显示前 ${segments.length} 段）` : ''}
            </span>
          </h4>

          <ol className="segment-list">
            {segments.map((segment) => (
              <li key={segment.id} className="segment-row">
                {segment.startMs !== null ? (
                  <span className="segment-time" title={sourceTitle(segment)}>
                    {formatTimestamp(segment.startMs)}
                  </span>
                ) : null}
                <span className="segment-text">{segment.text}</span>
              </li>
            ))}
          </ol>

          {segmentTotal > segments.length ? (
            <p className="field-hint">
              只显示了前 {segments.length} 段。完整文本已经进了索引，用关键词就能搜到后面的内容。
            </p>
          ) : null}
        </div>
      ) : null}

      {/* 提取状态说「已提取」但一段文本都没有——这必须解释，
          否则用户会以为文本没被存下来。 */}
      {detail.extractStatus === 'done' && detail.segmentCount === 0 ? (
        <div className="notice notice-info">
          这条素材已经提取过，但没有识别出任何文字。视频里没有人说话、音频是纯音乐，
          都会是这个结果——它不代表提取失败。
        </div>
      ) : null}

      {/* 还没提取过、而且现在也提不了（图片等）：说清楚什么时候会有 */}
      {detail.extractStatus === 'none' && !plan.available ? (
        <div className="notice notice-info">
          这条素材现在还不能提取。能直接提取的是：字幕文件（不需要模型）、音频与视频（本地语音转写）。
        </div>
      ) : null}

      {/* ---------------------------------------------------------- 标签 */}

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

/** 段落的来源。混了转写与字幕时，这行小字是唯一能分辨二者的地方。 */
function sourceTitle(segment: TextSegment): string {
  const label = SOURCE_LABELS[segment.source] ?? segment.source
  if (segment.endMs === null) return label
  return `${label} ・ ${formatTimestamp(segment.startMs)}–${formatTimestamp(segment.endMs)}`
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
