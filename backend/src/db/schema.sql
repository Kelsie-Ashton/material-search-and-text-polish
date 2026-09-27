-- =====================================================================
-- 关键词素材检索与文字提取润色工具 —— 索引库结构
--
-- 本文件一次建全所有表（含第二批才实现的提取与润色表）。
-- CREATE TABLE 是免费的，而预留结构能让 ON DELETE CASCADE 链一次性
-- 验证正确——事后补表会破坏已有数据的级联路径。
--
-- 注意：PRAGMA foreign_keys 不在这里设置。它在事务内是空操作，
-- 必须由 db/index.ts 在每个连接建立时显式打开。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 迁移版本
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------
-- 素材目录配置
--   path_key 是归一化后的路径，用于「同一目录不重复添加」；
--   唯一约束放在数据库层，因为这个不变量不能只靠应用代码自觉。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS directories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  path            TEXT    NOT NULL,
  path_key        TEXT    NOT NULL UNIQUE,
  label           TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  last_scanned_at INTEGER
);

-- ---------------------------------------------------------------------
-- 素材元数据
--   fingerprint: size + mtime 的哈希，既是增量扫描的依据，
--                也是「提取结果缓存是否还有效」的依据。
--   extract_status 是物化的冗余列（列表页每行都要展示与筛选），
--                必须与 jobs 的更新同事务，并在启动时用
--                reconcileAssetStatus() 对账。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  directory_id       INTEGER NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
  path               TEXT    NOT NULL,
  path_key           TEXT    NOT NULL UNIQUE,
  file_name          TEXT    NOT NULL,
  ext                TEXT    NOT NULL,
  kind               TEXT    NOT NULL,   -- video / audio / image / text
  size_bytes         INTEGER NOT NULL,
  mtime_ms           INTEGER NOT NULL,
  fingerprint        TEXT    NOT NULL,
  duration_ms        INTEGER,
  width              INTEGER,
  height             INTEGER,
  -- none / pending / running / done / partial / failed
  extract_status     TEXT    NOT NULL DEFAULT 'none',
  extract_error      TEXT,
  extracted_at       INTEGER,
  -- 增量扫描第一阶段写入，第二阶段据此判定删除；被中断时绝不执行第二阶段
  last_seen_scan_id  INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_directory      ON assets(directory_id);
CREATE INDEX IF NOT EXISTS idx_assets_kind           ON assets(kind);
CREATE INDEX IF NOT EXISTS idx_assets_extract_status ON assets(extract_status);
CREATE INDEX IF NOT EXISTS idx_assets_last_seen      ON assets(directory_id, last_seen_scan_id);

-- ---------------------------------------------------------------------
-- 标签
--   name_key 唯一 + 关联表复合主键 → 数据库级去重，应用层不必先查后插。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  name_key   TEXT    NOT NULL UNIQUE,
  color      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  source     TEXT    NOT NULL DEFAULT 'manual',  -- manual / polished / extracted
  created_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);

-- ---------------------------------------------------------------------
-- 归档笔记
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  title      TEXT,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asset_notes_asset ON asset_notes(asset_id);

-- ---------------------------------------------------------------------
-- 提取尝试
--   「提取状态」「提取尝试」「任务调度」是三张表：
--     状态是素材的属性（1:1，落在 assets.extract_status）
--     尝试是一次执行的结果（1:N，重试产生多条，指纹缓存靠它）
--     任务是调度（排队/进度/取消，落在 jobs）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extraction_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id        INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  fingerprint     TEXT    NOT NULL,
  status          TEXT    NOT NULL,  -- running / succeeded / partial / failed
  engine_versions TEXT,              -- JSON：记录引擎与模型版本，便于判断缓存是否过期
  error_code      TEXT,
  error_message   TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_asset ON extraction_runs(asset_id);
CREATE INDEX IF NOT EXISTS idx_runs_cache ON extraction_runs(asset_id, fingerprint, status);

-- 一次提取内按来源分项成败：画面 OCR 失败不应连累语音转写
CREATE TABLE IF NOT EXISTS extraction_run_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  source        TEXT    NOT NULL,  -- audio / frame / image / file
  status        TEXT    NOT NULL,  -- succeeded / failed / skipped
  segment_count INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT,
  error_message TEXT,
  UNIQUE (run_id, source)
);

-- ---------------------------------------------------------------------
-- 提取文本的唯一真相来源
--   行粒度 = 段落，而不是「一个素材一行 JSON」。
--   检索命中后必须知道命中的是哪一段、什么时间点；
--   JSON 列会让每次检索都要读入并解析整份文档，仅为显示一行上下文。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_text_segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  -- 运行记录被删（如清理历史）不应带走文本，故 SET NULL 而非 CASCADE
  run_id     INTEGER REFERENCES extraction_runs(id) ON DELETE SET NULL,
  source     TEXT    NOT NULL,  -- audio / frame / image / file
  ordinal    INTEGER NOT NULL,  -- 段落顺序
  text       TEXT    NOT NULL,
  start_ms   INTEGER,           -- 语音段落起止
  end_ms     INTEGER,
  frame_ms   INTEGER,           -- 画面段落对应的视频时间点
  bbox       TEXT,              -- JSON [x, y, w, h]
  confidence REAL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_asset   ON asset_text_segments(asset_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_segments_run     ON asset_text_segments(run_id);

-- ---------------------------------------------------------------------
-- 润色产物
--
-- primary_asset_id 是为「软覆盖」的部分唯一索引而存在的冗余列：
--   单素材润色 → 指向该素材，由部分唯一索引保证「每个素材只有一条 current 成功结果」
--   合并笔记   → 为 NULL，不受该索引约束
-- 写成纯多对多（只靠 polish_sources）就无法用索引表达这个不变量。
--
-- 保留历史（追加新行 + 旧行 is_current=0）而不是原地 UPDATE：
-- 这样一次网络抖动不会毁掉上次的结果，误操作可回滚，也能对比不同模型输出。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS polish_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  primary_asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
  title           TEXT,
  body            TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  prompt_version  TEXT    NOT NULL,
  style           TEXT,
  status          TEXT    NOT NULL,  -- succeeded / failed
  error_code      TEXT,
  error_message   TEXT,
  input_chars     INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  is_current      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_polish_primary ON polish_results(primary_asset_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_polish_current
  ON polish_results(primary_asset_id)
  WHERE is_current = 1 AND status = 'succeeded' AND primary_asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS polish_sources (
  polish_result_id INTEGER NOT NULL REFERENCES polish_results(id) ON DELETE CASCADE,
  asset_id         INTEGER NOT NULL REFERENCES assets(id)          ON DELETE CASCADE,
  ordinal          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (polish_result_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_polish_sources_asset ON polish_sources(asset_id);

-- ---------------------------------------------------------------------
-- 任务调度
--   target_id 语义随 type 变化：scan → directories.id，extract → assets.id，
--   polish → assets.id（合并笔记则为 NULL）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT    NOT NULL,  -- scan / extract / polish
  status           TEXT    NOT NULL,  -- queued / running / succeeded / failed / canceled
  target_id        INTEGER,
  payload          TEXT,              -- JSON
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total   INTEGER NOT NULL DEFAULT 0,
  progress_message TEXT,
  -- 只置标志，真正停止由 handler 在检查点响应
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result           TEXT,              -- JSON
  error_code       TEXT,
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);

-- 防重复入队：重复点「扫描」是必然发生的用户行为，在数据库层挡住。
-- 启动时还需把残留的 running 重置为 queued，否则一次崩溃就让队列永久卡死。
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_scan
  ON jobs(target_id) WHERE type = 'scan'    AND status IN ('queued', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_extract
  ON jobs(target_id) WHERE type = 'extract' AND status IN ('queued', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_polish
  ON jobs(target_id) WHERE type = 'polish'  AND status IN ('queued', 'running');

-- ---------------------------------------------------------------------
-- 应用配置（键值）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =====================================================================
-- 全文索引
--
-- 三个硬限制（实测）：
--   1. tokenize='trigram' 只索引字符三元组，查询串 < 3 字符必然空结果，
--      且多词查询中只要有一个短词，整个查询就废掉。
--      因此检索必须逐词分流：≥3 字走 FTS，≤2 字只走 LIKE。
--   2. 未转义的用户输入会直接抛 SQL 错误（`美食-视频`、`美食"视频`），
--      必须逐词双引号包裹并把内部 `"` 翻倍。
--   3. bm25 的 rank 是负数，越小越相关，聚合时用 MIN(rank)。
--
-- detail 必须是 full：detail=none/column 下 phrase 查询直接报错，
-- 而只省下约 4% 空间，不划算。
--
-- content= 使用 external content 模式：索引不重复存原文，
-- 把总占用从约 6.8x 降到约 5.4x。代价是索引不会自动跟随主表变化，
-- 必须靠下面的触发器同步。
-- =====================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS fts_segments USING fts5(
  text,
  content = 'asset_text_segments',
  content_rowid = 'id',
  tokenize = 'trigram',
  detail = 'full'
);

-- external content 表不会在主表行删除时自动清理索引。
-- 实测：删行后 MATCH 仍返回该 rowid，产生指向不存在素材的幽灵条目，
-- 用户会看到点不开的结果，且极难排查。
--
-- 用触发器而不是应用层写入：应用层方案必须在每个删除/更新点精确重放旧字段值，
-- 漏掉任何一处（级联删除路径、迁移脚本、手工修数据）就出错。
-- 触发器把这个不变量交给数据库，无法绕过。
--
-- 注意删除指令的特殊列名是 FTS 表**自身的名字**，不是字面量 'fts'。
CREATE TRIGGER IF NOT EXISTS trg_segments_ai AFTER INSERT ON asset_text_segments BEGIN
  INSERT INTO fts_segments(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_segments_ad AFTER DELETE ON asset_text_segments BEGIN
  INSERT INTO fts_segments(fts_segments, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_segments_au AFTER UPDATE ON asset_text_segments BEGIN
  INSERT INTO fts_segments(fts_segments, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO fts_segments(rowid, text) VALUES (new.id, new.text);
END;
