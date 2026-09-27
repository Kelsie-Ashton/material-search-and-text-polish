import { useCallback, useEffect, useState } from 'react'

import { toUserMessage } from '../api/client'
import { type JobRecord, cancelJob, getJob } from '../api/jobs'
import {
  type AssetSummary,
  type DirectoryRecord,
  type ExtractStatus,
  KIND_LABELS,
  STATUS_LABELS,
  type ScanSummary,
  addDirectory,
  formatBytes,
  formatTime,
  listAssets,
  listDirectories,
  removeDirectory,
  startScan,
} from '../api/library'
import AssetDetailPanel from '../components/AssetDetailPanel'

/**
 * 素材库页面（任务 3.7 + 3.9）。
 *
 * 这一页承担的责任比看上去多：它是用户**唯一**能把磁盘上的素材
 * 变成索引的入口，所以「加目录 → 扫描 → 看到素材」这条链路里
 * 每一步失败或空结果，都必须有话说。没有解释的空列表会被当成故障。
 */

type Notice = { kind: 'ok' | 'error' | 'info'; text: string }

const PAGE_SIZE = 50

const KIND_OPTIONS: Array<{ value: AssetSummary['kind'] | ''; label: string }> = [
  { value: '', label: '全部类型' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'image', label: '图片' },
  { value: 'text', label: '文本' },
]

const STATUS_OPTIONS: Array<{ value: ExtractStatus | ''; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'none', label: '未提取' },
  { value: 'pending', label: '排队中' },
  { value: 'running', label: '提取中' },
  { value: 'done', label: '已提取' },
  { value: 'partial', label: '部分提取' },
  { value: 'failed', label: '提取失败' },
]

/** 扫描任务的 result 是 unknown，这里按形状收窄，而不是硬断言。 */
function asScanSummary(result: unknown): ScanSummary | null {
  if (typeof result !== 'object' || result === null) return null
  const candidate = result as Partial<ScanSummary>
  if (typeof candidate.completedCleanly !== 'boolean') return null
  if (typeof candidate.indexed !== 'number') return null
  return candidate as ScanSummary
}

/** 轮询间隔。扫描是分批提交的，800ms 足以让进度看起来是连续的。 */
const POLL_INTERVAL_MS = 800

export default function LibraryPage() {
  const [directories, setDirectories] = useState<DirectoryRecord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [newPath, setNewPath] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  /** 当前正在跟踪的扫描任务。非空时以 800ms 轮询。 */
  const [job, setJob] = useState<JobRecord | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState<number | null>(null)

  const [assets, setAssets] = useState<AssetSummary[]>([])
  const [assetTotal, setAssetTotal] = useState(0)
  const [assetOffset, setAssetOffset] = useState(0)
  const [filterKind, setFilterKind] = useState<AssetSummary['kind'] | ''>('')
  const [filterStatus, setFilterStatus] = useState<ExtractStatus | ''>('')
  const [filterDirectory, setFilterDirectory] = useState<number | ''>('')
  const [filterQuery, setFilterQuery] = useState('')
  const [assetsLoading, setAssetsLoading] = useState(false)

  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null)

  const reloadDirectories = useCallback(async () => {
    try {
      setDirectories(await listDirectories())
      setLoadError(null)
    } catch (err) {
      setLoadError(toUserMessage(err))
    }
  }, [])

  const reloadAssets = useCallback(async () => {
    setAssetsLoading(true)
    try {
      const result = await listAssets({
        // 空串表示「不筛选」，与后端的约定一致；这里不传出去
        ...(filterKind === '' ? {} : { kind: filterKind }),
        ...(filterStatus === '' ? {} : { status: filterStatus }),
        ...(filterDirectory === '' ? {} : { directoryId: filterDirectory }),
        ...(filterQuery.trim() === '' ? {} : { q: filterQuery.trim() }),
        limit: PAGE_SIZE,
        offset: assetOffset,
      })
      setAssets(result.items)
      setAssetTotal(result.total)
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setAssetsLoading(false)
    }
  }, [filterKind, filterStatus, filterDirectory, filterQuery, assetOffset])

  useEffect(() => {
    void reloadDirectories()
  }, [reloadDirectories])

  useEffect(() => {
    void reloadAssets()
  }, [reloadAssets])

  /**
   * 改筛选条件时一并把页码归零。
   *
   * 两件事必须在**同一次**状态更新里做完：分两次的话，先发出去的
   * 那一轮请求会带着新条件 + 旧页码，用户会先看到一屏「这一页没有数据」，
   * 再被下一轮结果替换掉。而且留在第 3 页看到空列表，最容易被误读成
   * 「没搜到」——其实只是那一页没有。
   */
  function updateFilter(apply: () => void) {
    apply()
    setAssetOffset(0)
  }

  // ---------------------------------------------------------- 扫描轮询

  useEffect(() => {
    if (job === null) return

    // 终态：停止轮询，刷新两处数据，并把扫描结果讲清楚
    if (job.status !== 'queued' && job.status !== 'running') {
      setJob(null)
      void reloadDirectories()
      void reloadAssets()

      const summary = asScanSummary(job.result)
      if (job.status === 'failed') {
        setNotice({ kind: 'error', text: job.errorMessage ?? '扫描失败' })
      } else if (job.status === 'canceled') {
        setNotice({
          kind: 'info',
          // 被取消时**绝不能**说「扫描完成」。已扫到的部分留在索引里，
          // 但清理阶段没跑，索引可能还留着磁盘上已删掉的文件。
          text: '扫描已取消。已扫到的素材保留在索引中，但本次没有清理已删除的文件。',
        })
      } else if (summary !== null) {
        setNotice({ kind: summary.completedCleanly ? 'ok' : 'info', text: describeScan(summary) })
      } else {
        setNotice({ kind: 'ok', text: '扫描已完成。' })
      }
      return
    }

    // 自身重排的轮询：每次拿到新状态后重新起一个定时器，
    // 而不是 setInterval——后者在上一次请求还没回来时会叠发。
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          setJob(await getJob(job.id))
        } catch (err) {
          // 轮询失败不把进度条抹掉：任务可能还在跑，界面上留着
          // 上一次的进度比空着更有用。
          setNotice({ kind: 'error', text: `读取扫描进度失败：${toUserMessage(err)}` })
        }
      })()
    }, POLL_INTERVAL_MS)

    return () => window.clearTimeout(timer)
  }, [job, reloadDirectories, reloadAssets])

  // ---------------------------------------------------------- 操作

  async function handleAddDirectory() {
    const path = newPath.trim()
    if (path === '') return

    setBusy(true)
    setNotice(null)
    try {
      const created = await addDirectory(path, newLabel.trim() || undefined)
      setNewPath('')
      setNewLabel('')
      await reloadDirectories()
      setNotice({
        kind: 'ok',
        text: `已添加「${created.label ?? created.path}」。点「扫描」把它里面的素材建进索引。`,
      })
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  async function handleScan(directoryId: number) {
    setBusy(true)
    setNotice(null)
    try {
      setJob(await startScan(directoryId))
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    if (job === null) return
    try {
      const { outcome } = await cancelJob(job.id)
      setNotice({
        kind: 'info',
        text:
          outcome === 'canceled-immediately'
            ? '已取消排队中的扫描。'
            : '已请求取消。扫描会在当前这一步结束后停下，可能还要几秒。',
      })
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    }
  }

  async function handleRemoveDirectory(id: number) {
    setBusy(true)
    setNotice(null)
    try {
      const summary = await removeDirectory(id)
      setConfirmingRemove(null)
      if (filterDirectory === id) setFilterDirectory('')
      setSelectedAssetId(null)
      await reloadDirectories()
      await reloadAssets()
      // 这句是整个产品最重要的一句承诺，要说清楚而不是含糊带过
      setNotice({
        kind: 'ok',
        text: `已从索引中移除「${summary.path}」及其 ${summary.removedAssets} 条素材记录。磁盘上的原始文件一个都没有动。`,
      })
    } catch (err) {
      setNotice({ kind: 'error', text: toUserMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------- 渲染

  if (loadError !== null) {
    return (
      <section className="page">
        <h2 className="page-title">素材库</h2>
        <div className="notice notice-error">{loadError}</div>
        <button type="button" onClick={() => void reloadDirectories()}>
          重试
        </button>
      </section>
    )
  }

  const scanning = job !== null && (job.status === 'queued' || job.status === 'running')
  const hasFilter =
    filterKind !== '' || filterStatus !== '' || filterDirectory !== '' || filterQuery.trim() !== ''

  return (
    <section className="page">
      <h2 className="page-title">素材库</h2>
      <p className="page-desc">
        添加存放素材的本地目录，扫描后即可在检索页用关键词找到它们。
        扫描只读文件，不会修改或删除你的任何素材。
      </p>

      {/* ---------------------------------------------- 目录 */}
      <div className="panel">
        <h3 className="panel-title">素材目录</h3>

        {directories === null ? (
          <p className="field-hint">正在读取…</p>
        ) : directories.length === 0 ? (
          <p className="field-hint">
            还没有添加任何目录。在下面填入一个本地文件夹的完整路径，例如
            <code>D:\素材库</code>。
          </p>
        ) : (
          <ul className="dir-list">
            {directories.map((dir) => (
              <li key={dir.id} className="dir-item">
                <div className="dir-info">
                  <div className="dir-name">{dir.label ?? dir.path}</div>
                  <div className="dir-path" title={dir.path}>
                    {dir.path}
                  </div>
                  <div className="field-hint">
                    上次扫描：{formatTime(dir.lastScannedAt)}
                  </div>
                </div>

                <div className="dir-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy || scanning}
                    title={scanning ? '已有扫描在进行中' : undefined}
                    onClick={() => void handleScan(dir.id)}
                  >
                    扫描
                  </button>

                  {confirmingRemove === dir.id ? (
                    <>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={busy}
                        onClick={() => void handleRemoveDirectory(dir.id)}
                      >
                        确认移除
                      </button>
                      <button type="button" disabled={busy} onClick={() => setConfirmingRemove(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={busy}
                      onClick={() => setConfirmingRemove(dir.id)}
                    >
                      移除
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* 移除是不可逆的操作，确认文案必须把「删什么、不删什么」写全 */}
        {confirmingRemove !== null ? (
          <div className="notice notice-info">
            移除后，该目录下的素材会从索引里消失，检索不到。
            <strong>磁盘上的文件和文件夹不会被删除</strong>
            ，随时可以重新添加回来。
          </div>
        ) : null}

        <form
          className="dir-form"
          onSubmit={(event) => {
            event.preventDefault()
            void handleAddDirectory()
          }}
        >
          <input
            type="text"
            value={newPath}
            placeholder="目录完整路径，例如 D:\素材库"
            spellCheck={false}
            onChange={(event) => setNewPath(event.target.value)}
          />
          <input
            type="text"
            value={newLabel}
            placeholder="备注名（可选）"
            spellCheck={false}
            onChange={(event) => setNewLabel(event.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={busy || newPath.trim() === ''}>
            添加目录
          </button>
        </form>
      </div>

      {/* ---------------------------------------------- 扫描进度 */}
      {job !== null ? (
        <div className="panel">
          <h3 className="panel-title">扫描进度</h3>
          <ScanProgress job={job} />
          {scanning ? (
            <div className="actions">
              <button type="button" className="btn-danger" onClick={() => void handleCancel()}>
                取消扫描
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------- 素材列表 */}
      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title">素材</h3>
          <span className="field-hint">
            {assetsLoading ? '加载中…' : `共 ${assetTotal} 条`}
          </span>
        </div>

        <div className="filters">
          <input
            type="text"
            value={filterQuery}
            placeholder="按文件名筛选"
            spellCheck={false}
            onChange={(event) => updateFilter(() => setFilterQuery(event.target.value))}
          />
          <select
            value={filterKind}
            onChange={(event) =>
              updateFilter(() => setFilterKind(event.target.value as AssetSummary['kind'] | ''))
            }
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(event) =>
              updateFilter(() => setFilterStatus(event.target.value as ExtractStatus | ''))
            }
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {directories !== null && directories.length > 1 ? (
            <select
              value={filterDirectory === '' ? '' : String(filterDirectory)}
              onChange={(event) =>
                updateFilter(() =>
                  setFilterDirectory(event.target.value === '' ? '' : Number(event.target.value)),
                )
              }
            >
              <option value="">全部目录</option>
              {directories.map((dir) => (
                <option key={dir.id} value={String(dir.id)}>
                  {dir.label ?? dir.path}
                </option>
              ))}
            </select>
          ) : null}

          {/* 筛选条件必须能一眼看清、一键清掉——
              否则用户会以为「素材库怎么空了」 */}
          {hasFilter ? (
            <button
              type="button"
              onClick={() =>
                updateFilter(() => {
                  setFilterKind('')
                  setFilterStatus('')
                  setFilterDirectory('')
                  setFilterQuery('')
                })
              }
            >
              清除筛选
            </button>
          ) : null}
        </div>

        {assets.length === 0 ? (
          // 空列表有三种完全不同的原因，混成一句「暂无数据」用户就没法行动了。
          <p className="field-hint">
            {directories !== null && directories.length === 0
              ? '还没有素材。先在上面添加一个本地目录，然后点「扫描」。'
              : hasFilter
                ? '没有符合当前筛选条件的素材。'
                : assetTotal === 0
                  ? '这个目录里还没有素材。点「扫描」把里面的文件建进索引，或者确认目录里确实有视频、音频、图片或文本文件。'
                  : '这一页没有数据。'}
          </p>
        ) : (
          <table className="asset-table">
            <thead>
              <tr>
                <th>文件名</th>
                <th>类型</th>
                <th>大小</th>
                <th>提取状态</th>
                <th>标签</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr
                  key={asset.id}
                  className={selectedAssetId === asset.id ? 'is-selected' : undefined}
                  onClick={() => setSelectedAssetId(asset.id)}
                >
                  <td className="path-cell" title={asset.path}>
                    {asset.fileName}
                  </td>
                  <td>{KIND_LABELS[asset.kind]}</td>
                  <td>{formatBytes(asset.sizeBytes)}</td>
                  <td>
                    <span className={`badge badge-${asset.extractStatus}`}>
                      {STATUS_LABELS[asset.extractStatus]}
                    </span>
                  </td>
                  <td>
                    {asset.tags.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      asset.tags.map((tag) => (
                        <span key={tag.id} className="tag-chip tag-chip-static">
                          {tag.name}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {assetTotal > PAGE_SIZE ? (
          <div className="actions">
            <button
              type="button"
              disabled={assetOffset === 0 || assetsLoading}
              onClick={() => setAssetOffset(Math.max(assetOffset - PAGE_SIZE, 0))}
            >
              上一页
            </button>
            <span className="field-hint">
              第 {Math.floor(assetOffset / PAGE_SIZE) + 1} 页 ・ 共{' '}
              {Math.max(Math.ceil(assetTotal / PAGE_SIZE), 1)} 页
            </span>
            <button
              type="button"
              disabled={assetOffset + PAGE_SIZE >= assetTotal || assetsLoading}
              onClick={() => setAssetOffset(assetOffset + PAGE_SIZE)}
            >
              下一页
            </button>
          </div>
        ) : null}
      </div>

      {notice ? (
        <div className={`notice notice-${notice.kind}`} role="status">
          {notice.text}
        </div>
      ) : null}

      {selectedAssetId !== null ? (
        <AssetDetailPanel
          assetId={selectedAssetId}
          onClose={() => setSelectedAssetId(null)}
          onTagsChanged={() => void reloadAssets()}
        />
      ) : null}
    </section>
  )
}

/**
 * 扫描结果的一句话总结。
 *
 * 「跳过了 N 个不支持的文件」这句不是可有可无的：用户看着自己 500 个文件的
 * 文件夹，索引里只有 80 个，唯一能解释这件事的就是这个计数。
 * 少了它，程序在他眼里就是坏的。
 */
function describeScan(summary: ScanSummary): string {
  const parts = [
    `扫描完成：发现 ${summary.visited} 个文件`,
    `新增 ${summary.indexed}`,
    `更新 ${summary.updated}`,
    `未变化 ${summary.unchanged}`,
  ]
  if (summary.removed > 0) parts.push(`移除 ${summary.removed} 条已不存在的记录`)
  if (summary.skippedUnsupported > 0) parts.push(`跳过 ${summary.skippedUnsupported} 个不支持的文件`)

  let text = `${parts.join('，')}。`
  if (!summary.completedCleanly) {
    text += ' 本次没有跑完清理阶段，索引中可能还留着已被删除的文件。'
  }
  if (summary.errors.length > 0) {
    text += ` 有 ${summary.errors.length} 个文件读取失败，已跳过。`
  }
  return text
}

function ScanProgress({ job }: { job: JobRecord }) {
  const percent =
    job.progressTotal > 0
      ? Math.min(Math.round((job.progressCurrent / job.progressTotal) * 100), 100)
      : null

  return (
    <div className="scan-progress">
      <div className="scan-line">
        <span className={`badge badge-job-${job.status}`}>{describeJobStatus(job.status)}</span>
        <span className="field-hint">{job.progressMessage ?? '正在准备…'}</span>
      </div>

      <div className="progress-track">
        <div
          className={`progress-fill${percent === null ? ' is-indeterminate' : ''}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>

      {percent !== null ? (
        <div className="field-hint">
          {job.progressCurrent} / {job.progressTotal}（{percent}%）
        </div>
      ) : null}
    </div>
  )
}

function describeJobStatus(status: JobRecord['status']): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '进行中'
    case 'succeeded':
      return '已完成'
    case 'failed':
      return '失败'
    case 'canceled':
      return '已取消'
  }
}
