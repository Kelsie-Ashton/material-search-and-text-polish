import { useState } from 'react'

import { toUserMessage } from '../api/client'
import {
  type AssetSummary,
  type ExtractStatus,
  KIND_LABELS,
  STATUS_LABELS,
  formatBytes,
} from '../api/library'
import {
  MATCH_SOURCE_LABELS,
  type SearchHit,
  type SearchResult,
  type SegmentHit,
  formatTimestamp,
  search,
  splitSnippet,
} from '../api/search'

/**
 * 检索页（任务 4.5 + 4.6）。
 *
 * 这一页最需要小心的地方不是「搜索框 + 列表」，而是**把检索的局限
 * 如实讲出来**：两字关键词走的是全库扫描而不是分词索引，
 * 正文检索依赖已经提取过的文字。用户看不到这些，就会把
 * 「搜不到」当成「没有」——而这两件事的应对方式完全不同。
 */

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
  { value: 'done', label: '已提取' },
  { value: 'partial', label: '部分提取' },
  { value: 'failed', label: '提取失败' },
]

export default function SearchPage() {
  const [input, setInput] = useState('')
  const [kind, setKind] = useState<AssetSummary['kind'] | ''>('')
  const [status, setStatus] = useState<ExtractStatus | ''>('')

  const [result, setResult] = useState<SearchResult | null>(null)
  const [searchedFor, setSearchedFor] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const hasFilter = kind !== '' || status !== ''

  async function runSearch(rawQuery: string, nextKind = kind, nextStatus = status) {
    const query = rawQuery.trim()
    if (query === '') {
      // 空白输入不该发出去换来一个 400——用户要的是一句「请输入关键词」，
      // 而不是一次失败的请求。
      setHint('请输入关键词后再检索。')
      return
    }

    setLoading(true)
    setError(null)
    setHint(null)
    try {
      const next = await search({
        q: query,
        ...(nextKind === '' ? {} : { kind: nextKind }),
        ...(nextStatus === '' ? {} : { status: nextStatus }),
      })
      setResult(next)
      setSearchedFor(query)
    } catch (err) {
      setError(toUserMessage(err))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  function resetFilters() {
    setKind('')
    setStatus('')
    if (result !== null) void runSearch(searchedFor, '', '')
  }

  return (
    <section className="page">
      <h2 className="page-title">检索</h2>
      <p className="page-desc">
        输入关键词，在本地素材库中检索文件名、标签与已提取的正文。
      </p>

      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault()
          void runSearch(input)
        }}
      >
        <input
          type="search"
          value={input}
          placeholder="输入关键词，多个词用空格分开"
          spellCheck={false}
          autoFocus
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? '检索中…' : '检索'}
        </button>
      </form>

      <div className="filters">
        <select
          value={kind}
          onChange={(event) => {
            const next = event.target.value as AssetSummary['kind'] | ''
            setKind(next)
            if (result !== null) void runSearch(searchedFor, next, status)
          }}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={status}
          onChange={(event) => {
            const next = event.target.value as ExtractStatus | ''
            setStatus(next)
            if (result !== null) void runSearch(searchedFor, kind, next)
          }}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {hasFilter ? (
          <button type="button" onClick={resetFilters}>
            清除筛选
          </button>
        ) : null}
      </div>

      {hint !== null ? <div className="notice notice-info">{hint}</div> : null}
      {error !== null ? <div className="notice notice-error">{error}</div> : null}

      {result !== null ? (
        <>
          {/*
            这些提示不是装饰：两字关键词走的是全库扫描而不是分词索引，
            结果形态确实不同。不说明的话，用户会以为两种搜索是一回事。
          */}
          {result.warnings.length > 0 ? (
            <div className="notice notice-info">
              {result.warnings.map((warning) => (
                <div key={warning.code}>{warning.message}</div>
              ))}
            </div>
          ) : null}

          {result.items.length === 0 ? (
            <EmptyState query={searchedFor} hasFilter={hasFilter} />
          ) : (
            <>
              <div className="result-summary">
                找到 {result.total} 条素材
                {result.total > result.items.length
                  ? `（当前显示前 ${result.items.length} 条）`
                  : ''}
                ，关键词：
                {result.terms.map((term) => (
                  <span key={term.text} className="term-chip" title={pathHint(term.path)}>
                    {term.text}
                  </span>
                ))}
              </div>

              <ul className="result-list">
                {result.items.map((hit) => (
                  <ResultCard key={hit.asset.id} hit={hit} />
                ))}
              </ul>
            </>
          )}
        </>
      ) : null}

      <div className="callout">
        <strong>关于检索范围</strong>
        <ul>
          <li>文件名与标签始终参与检索，不受长度限制。</li>
          <li>
            <strong>正文检索依赖已提取的文字。</strong>
            还没有做过文字提取的素材，其视频语音或图片文字是搜不到的——
            搜不到不等于素材里没有。
          </li>
          <li>
            不足 3 个字的词（如「美食」「剪辑」）无法使用正文分词索引，
            会改用全库扫描匹配，结果可能不如长关键词精确。
          </li>
        </ul>
      </div>
    </section>
  )
}

function pathHint(path: 'fts' | 'like'): string {
  return path === 'fts' ? '这个词走了正文分词索引' : '这个词不足 3 个字，走了全库扫描匹配'
}

function EmptyState({ query, hasFilter }: { query: string; hasFilter: boolean }) {
  return (
    <div className="placeholder">
      <p>没有找到与「{query}」相关的素材。</p>
      <p className="placeholder-hint">
        {hasFilter
          ? '当前有类型或状态筛选，可以点「清除筛选」后再试一次。'
          : '如果这个词可能出现在视频语音或图片里，需要先对素材执行文字提取，之后才能被搜到。'}
      </p>
    </div>
  )
}

function ResultCard({ hit }: { hit: SearchHit }) {
  const { asset } = hit

  return (
    <li className="result-card">
      <div className="result-head">
        <div className="result-name" title={asset.path}>
          {asset.fileName}
        </div>
        <div className="result-meta">
          <span className="badge">{KIND_LABELS[asset.kind]}</span>
          <span className={`badge badge-${asset.extractStatus}`}>
            {STATUS_LABELS[asset.extractStatus]}
          </span>
          <span className="muted">{formatBytes(asset.sizeBytes)}</span>
        </div>
      </div>

      <div className="result-sources">
        <span className="muted">命中：</span>
        {hit.matchedIn.map((source) => (
          <span key={source} className="badge badge-source">
            {MATCH_SOURCE_LABELS[source]}
          </span>
        ))}
        {hit.matchedTerms.length > 0 ? (
          <span className="muted">・{hit.matchedTerms.join('、')}</span>
        ) : null}
      </div>

      {hit.matchedNames.length > 0 ? (
        <div className="field-hint">文件名命中：{hit.matchedNames.join('、')}</div>
      ) : null}

      {hit.matchedTags.length > 0 ? (
        <div className="tag-row">
          {hit.matchedTags.map((name) => (
            <span key={name} className="tag-chip tag-chip-static">
              {name}
            </span>
          ))}
        </div>
      ) : null}

      {hit.segments.map((segment) => (
        <Snippet key={segment.segmentId} segment={segment} />
      ))}

      {hit.segmentHitCount > hit.segments.length ? (
        <div className="field-hint">
          正文共命中 {hit.segmentHitCount} 段，这里显示最相关的 {hit.segments.length} 段。
        </div>
      ) : null}
    </li>
  )
}

function Snippet({ segment }: { segment: SegmentHit }) {
  const pieces = splitSnippet(segment.snippet, segment.highlights)
  const at = formatTimestamp(segment.startMs)

  return (
    <blockquote className="snippet">
      {at !== null ? <span className="snippet-time">{at}</span> : null}
      {segment.truncated.head ? <span className="muted">…</span> : null}
      {pieces.map((piece, index) =>
        piece.hit ? (
          // 下标是相对 snippet 的 UTF-16 偏移，由后端算好；
          // 前端只负责把它切成段渲染，不再自己找位置
          <mark key={index}>{piece.text}</mark>
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
      {segment.truncated.tail ? <span className="muted">…</span> : null}
    </blockquote>
  )
}
