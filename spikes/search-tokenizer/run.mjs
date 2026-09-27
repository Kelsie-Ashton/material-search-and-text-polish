// 中文检索方案对比实验。
//
// 要回答两个问题：
//   1. 占用体积 —— 各方案的索引开销是原文的几倍
//   2. 能不能搜到 —— 对「用户真的会这样搜」的中文查询，各方案的召回率
//
// 用法：node run.mjs [--segments=100000]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Jieba } from '@node-rs/jieba'
// 必须带 .js 扩展名：exports map 里没有无扩展名的子路径，
// Node 的 ESM 解析器不会替你补（后端接入时同样要注意）。
import { dict } from '@node-rs/jieba/dict.js'
import Database from 'better-sqlite3'

import { QUERIES, buildCorpus } from './corpus.mjs'

const jieba = Jieba.withDict(dict)

const outDir = path.join(os.tmpdir(), 'spike-search-tokenizer')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  }),
)
const SEGMENT_COUNT = Number(args.segments ?? 100000)

const now = () => Number(process.hrtime.bigint()) / 1e6
const mb = (bytes) => bytes / 1024 / 1024

/** FTS5 短语查询转义：内部双引号翻倍。 */
const phrase = (value) => `"${String(value).replace(/"/g, '""')}"`

const isMeaningful = (token) => /[\p{L}\p{N}]/u.test(token)

const cutTokens = (text) => jieba.cut(text, false).filter(isMeaningful)
const cutSearchTokens = (text) => jieba.cutForSearch(text, false).filter(isMeaningful)

// ---------------------------------------------------------------- 语料

const segmentLabel = SEGMENT_COUNT.toLocaleString('en-US')
console.log(`生成语料：${segmentLabel} 段…`)
const corpusStart = now()
const { segments, groundTruth, totalChars } = buildCorpus({ segmentCount: SEGMENT_COUNT })
const corpusMs = now() - corpusStart // 立刻取，不让后面的字符串格式化混进计时
console.log(
  `  完成：${totalChars.toLocaleString('en-US')} 字，平均 ${(totalChars / SEGMENT_COUNT).toFixed(1)} 字/段，用时 ${(corpusMs / 1000).toFixed(2)}s\n`,
)

console.log('各查询在语料中的真实命中数（子串精确匹配，作为召回率分母）：')
for (const { term } of QUERIES) {
  console.log(`  ${term.padEnd(6)} ${String(groundTruth.get(term).size).padStart(7)}`)
}
console.log()

// ---------------------------------------------------------------- 建库

const TRIGGER_SQL = (table, ftsCol, srcCol) => `
  CREATE TRIGGER ${table}_ai AFTER INSERT ON seg BEGIN
    INSERT INTO ${table}(rowid, ${ftsCol}) VALUES (new.id, new.${srcCol});
  END;
  CREATE TRIGGER ${table}_ad AFTER DELETE ON seg BEGIN
    INSERT INTO ${table}(${table}, rowid, ${ftsCol}) VALUES ('delete', old.id, old.${srcCol});
  END;
  CREATE TRIGGER ${table}_au AFTER UPDATE ON seg BEGIN
    INSERT INTO ${table}(${table}, rowid, ${ftsCol}) VALUES ('delete', old.id, old.${srcCol});
    INSERT INTO ${table}(rowid, ${ftsCol}) VALUES (new.id, new.${srcCol});
  END;
`

/**
 * 建一个库：可选建若干 FTS 虚表与触发器，并用给定的索引文本填充。
 * withFts=false 时只建主表，用来量出「同样的主表但不建索引」的基准体积。
 *
 * ftsTables 里每项是 { name, column, tokenize }。双表方案会传两项，
 * 触发器各写一组——这正是双表方案真正的代价所在。
 */
function buildDatabase({ file, useSegColumn, indexText, ftsTables = [], withFts }) {
  const db = new Database(file)
  db.pragma('journal_mode = OFF') // 实验只关心最终体积，不需要 WAL 的副本
  db.pragma('synchronous = OFF')

  db.exec(
    useSegColumn
      ? 'CREATE TABLE seg (id INTEGER PRIMARY KEY, text TEXT NOT NULL, text_seg TEXT NOT NULL)'
      : 'CREATE TABLE seg (id INTEGER PRIMARY KEY, text TEXT NOT NULL)',
  )

  for (const fts of withFts ? ftsTables : []) {
    const options = fts.tokenize === 'trigram' ? ", detail='full'" : ''
    db.exec(
      `CREATE VIRTUAL TABLE ${fts.name} USING fts5(${fts.column}, content='seg', content_rowid='id', tokenize='${fts.tokenize}'${options})`,
    )
    db.exec(TRIGGER_SQL(fts.name, fts.column, fts.column))
  }

  const insert = useSegColumn
    ? db.prepare('INSERT INTO seg (id, text, text_seg) VALUES (?, ?, ?)')
    : db.prepare('INSERT INTO seg (id, text) VALUES (?, ?)')

  const started = now()
  db.transaction(() => {
    for (let i = 0; i < segments.length; i += 1) {
      const text = segments[i]
      // useSegColumn 但没给 indexText 时按原文入库——
      // 这用来量「同样的主表、不建 FTS」的基准体积。
      if (useSegColumn) insert.run(i + 1, text, indexText ? indexText(text) : text)
      else insert.run(i + 1, text)
    }
  })()
  const buildMs = now() - started

  db.exec('VACUUM')
  db.close()

  return { buildMs, bytes: fs.statSync(file).size }
}

// ---------------------------------------------------------------- 方案定义

// 每个方案给定「一组」查询表达式，结果取并集。
// 单表方案只有一条；双表方案有两条——这正是它能互补盲区的原因。

const CONFIGS = [
  {
    key: 'trigram',
    baselineKey: 'raw',
    label: 'trigram（当前设计）',
    note: '任意子串，但两字查询失效',
    useSegColumn: false,
    withFts: true,
    ftsTables: [{ name: 'fts', column: 'text', tokenize: 'trigram' }],
    indexText: null,
    queries: (term) => [phrase(term)],
  },
  {
    key: 'unicode61-raw',
    baselineKey: 'raw',
    label: 'unicode61 原文（基线）',
    note: '未分词，中文整段算一个词',
    useSegColumn: false,
    withFts: true,
    ftsTables: [{ name: 'fts', column: 'text', tokenize: 'unicode61' }],
    indexText: null,
    queries: (term) => [phrase(term)],
  },
  {
    key: 'jieba-cut',
    baselineKey: 'cut',
    label: 'jieba 分词 + 原文查询',
    note: '分词建索引，查询串直接丢进去（常见误用）',
    useSegColumn: true,
    withFts: true,
    ftsTables: [{ name: 'fts', column: 'text_seg', tokenize: 'unicode61' }],
    indexText: (text) => cutTokens(text).join(' '),
    queries: (term) => [phrase(term)],
  },
  {
    key: 'jieba-cut-phrase',
    baselineKey: 'cut',
    label: 'jieba 分词 + 短语查询',
    note: '查询也分词，用短语约束相邻',
    useSegColumn: true,
    withFts: true,
    ftsTables: [{ name: 'fts', column: 'text_seg', tokenize: 'unicode61' }],
    indexText: (text) => cutTokens(text).join(' '),
    queries: (term) => [phrase(cutTokens(term).join(' '))],
  },
  {
    key: 'jieba-search-phrase',
    baselineKey: 'search',
    label: 'jieba cutForSearch + 短语',
    note: '索引更细，长词会额外吐出子词',
    useSegColumn: true,
    withFts: true,
    ftsTables: [{ name: 'fts', column: 'text_seg', tokenize: 'unicode61' }],
    indexText: (text) => cutSearchTokens(text).join(' '),
    queries: (term) => [phrase(cutSearchTokens(term).join(' '))],
  },
  {
    key: 'dual',
    baselineKey: 'search',
    label: '双表：trigram ∪ jieba',
    note: '两套索引分别查询后取并集，盲区互补',
    useSegColumn: true,
    withFts: true,
    ftsTables: [
      { name: 'fts_tri', column: 'text', tokenize: 'trigram' },
      { name: 'fts_seg', column: 'text_seg', tokenize: 'unicode61' },
    ],
    indexText: (text) => cutSearchTokens(text).join(' '),
    queries: (term) => [`"${term.replace(/"/g, '""')}"`, phrase(cutSearchTokens(term).join(' '))],
  },
]

// ---------------------------------------------------------------- 基准体积

// 只有原文、什么都没有的库 —— 用来回答「原文本身占多少」
const rawOnly = buildDatabase({
  file: path.join(outDir, 'baseline-raw.db'),
  useSegColumn: false,
  indexText: null,
  ftsTables: [],
  withFts: false,
})
console.log(`原文单独入库：${mb(rawOnly.bytes).toFixed(1)} MB\n`)

// 每个方案要对比的基准是「同样的主表内容、但不建 FTS」，
// 否则会把「分词后文本变长了」算进索引开销里。
// 索引文本相同的方案共用一份基准，所以按 baselineKey 去重。
const BASELINES = {
  raw: { useSegColumn: false, indexText: null },
  cut: { useSegColumn: true, indexText: (text) => cutTokens(text).join(' ') },
  search: { useSegColumn: true, indexText: (text) => cutSearchTokens(text).join(' ') },
}

const baselineBytes = new Map([['raw', rawOnly.bytes]])
function baselineFor(key) {
  if (!baselineBytes.has(key)) {
    const spec = BASELINES[key]
    baselineBytes.set(
      key,
      buildDatabase({
        file: path.join(outDir, `baseline-${key}.db`),
        useSegColumn: spec.useSegColumn,
        indexText: spec.indexText,
        ftsTables: [],
        withFts: false,
      }).bytes,
    )
  }
  return baselineBytes.get(key)
}

// ---------------------------------------------------------------- LIKE 兜底代价

// 「两字查询走 LIKE 全表扫」这个兜底方案的可行性，取决于扫一遍正文要多久。
// 它没有索引可用，只能全表扫，所以耗时随素材量线性增长——
// 这条数据决定 trigram 方案在第 N 天还能不能用。
{
  const db = new Database(path.join(outDir, 'baseline-raw.db'), { readonly: true })
  const scan = db.prepare('SELECT COUNT(*) AS n FROM seg WHERE text LIKE ?')
  console.log('正文 LIKE 全表扫（无索引，两字查询的兜底手段）：')
  for (const term of ['美食', '探店', '剪辑']) {
    const timings = []
    let n = 0
    for (let i = 0; i < 5; i += 1) {
      const t0 = now()
      n = scan.get(`%${term}%`).n
      timings.push(now() - t0)
    }
    timings.sort((a, b) => a - b)
    console.log(`  ${term}  命中 ${String(n).padStart(6)} 条  ${timings[2].toFixed(1)}ms`)
  }
  db.close()
  console.log()
}

// ---------------------------------------------------------------- 跑各方案

const results = []

for (const config of CONFIGS) {
  const dbPath = path.join(outDir, `${config.key}.db`)
  const built = buildDatabase({
    file: dbPath,
    useSegColumn: config.useSegColumn,
    indexText: config.indexText,
    ftsTables: config.ftsTables,
    withFts: config.withFts,
  })
  const baselineBytes = baselineFor(config.baselineKey)

  const db = new Database(dbPath, { readonly: true })
  const statements = config.ftsTables.map((table) =>
    db.prepare(`SELECT rowid FROM ${table.name} WHERE ${table.name} MATCH ?`),
  )

  const perQuery = []
  for (const { term } of QUERIES) {
    // 表达式与 FTS 表一一对应：单表方案一条，双表方案两条
    const expressions = config.queries(term)

    let found = new Set()
    let error = null
    const timings = []
    try {
      for (let i = 0; i < 5; i += 1) {
        const t0 = now()
        found = new Set()
        for (let s = 0; s < statements.length; s += 1) {
          for (const row of statements[s].all(expressions[s])) found.add(row.rowid - 1)
        }
        timings.push(now() - t0)
      }
    } catch (cause) {
      error = cause.message
    }

    const expected = groundTruth.get(term)
    let hit = 0
    for (const id of expected) if (found.has(id)) hit += 1

    timings.sort((a, b) => a - b)
    perQuery.push({
      term,
      expression: expressions.join(' ∪ '),
      expected: expected.size,
      returned: found.size,
      hit,
      recall: expected.size === 0 ? 1 : hit / expected.size,
      medianMs: timings[Math.floor(timings.length / 2)] ?? 0,
      error,
    })
  }

  db.close()

  results.push({
    ...config,
    buildMs: built.buildMs,
    totalBytes: built.bytes,
    baselineBytes,
    overheadBytes: built.bytes - baselineBytes,
    perQuery,
  })

  console.log(`已跑完 ${config.label}`)
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${'='.repeat(78)}\n一、占用体积（语料 ${totalChars.toLocaleString('en-US')} 字）\n${'='.repeat(78)}`)
console.log(
  ['方案', '总大小', '主表基准', '索引净开销', '倍数'].map((h, i) => h.padEnd([26, 11, 11, 12, 8][i])).join(''),
)
console.log('-'.repeat(78))
for (const r of results) {
  const ratio = (r.totalBytes / r.baselineBytes).toFixed(2)
  console.log(
    [
      r.label.padEnd(26),
      `${mb(r.totalBytes).toFixed(1)} MB`.padEnd(11),
      `${mb(r.baselineBytes).toFixed(1)} MB`.padEnd(11),
      `${mb(r.overheadBytes).toFixed(1)} MB`.padEnd(12),
      `${ratio}x`.padEnd(8),
    ].join(''),
  )
}

console.log(`\n${'='.repeat(78)}\n二、能不能搜到（召回率 = 命中数 / 语料中真实命中数）\n${'='.repeat(78)}`)
const header = ['查询', '真实数', ...results.map((r) => r.label.slice(0, 12))]
console.log(header.map((h, i) => h.padEnd(i === 0 ? 10 : i === 1 ? 10 : 14)).join(''))
console.log('-'.repeat(10 + 10 + results.length * 14))
for (const { term } of QUERIES) {
  const row = [term.padEnd(10), String(groundTruth.get(term).size).padEnd(10)]
  for (const r of results) {
    const q = r.perQuery.find((x) => x.term === term)
    row.push(q.error ? '报错'.padEnd(14) : `${(q.recall * 100).toFixed(1)}%`.padEnd(14))
  }
  console.log(row.join(''))
}

console.log(`\n${'='.repeat(78)}\n三、查询串与耗时\n${'='.repeat(78)}`)
for (const r of results) {
  console.log(`\n${r.label}`)
  for (const q of r.perQuery) {
    console.log(`  ${q.term.padEnd(6)} MATCH ${q.expression.padEnd(24)} 返回 ${String(q.returned).padStart(7)} 条  ${q.medianMs.toFixed(1)}ms`)
  }
}

console.log(`\n${'='.repeat(78)}\n四、建索引耗时\n${'='.repeat(78)}`)
for (const r of results) {
  console.log(`  ${r.label.padEnd(26)} ${(r.buildMs / 1000).toFixed(1)}s`)
}

fs.writeFileSync(
  path.join(outDir, 'results.json'),
  JSON.stringify(
    { segmentCount: SEGMENT_COUNT, totalChars, rawOnlyBytes: rawOnly.bytes, baselineBytes: [...baselineBytes], results },
    null,
    2,
  ),
)
console.log(`\n明细已写入 ${path.join(outDir, 'results.json')}`)
