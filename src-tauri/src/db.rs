use base64::Engine;
use rusqlite::{params_from_iter, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::PathBuf;

/// 与 src/shared/types.ts 的 LibraryStats 对齐（serde rename 输出 camelCase）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub videos: i64,
    pub indexed_videos: i64,
    pub pending_videos: i64,
    pub failed_videos: i64,
    pub frames: i64,
    pub total_bytes: i64,
    pub folders: i64,
    pub watching: i64,
}

/// 与 src/shared/types.ts 的 WatchedFolder 对齐。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolder {
    pub id: i64,
    pub path: String,
    pub path_key: String,
    pub name: String,
    pub pinned: bool,
    pub enabled: bool,
    pub recursive: bool,
    pub watch_state: String,
    pub message: Option<String>,
    pub added_at: i64,
    pub last_scan_at: Option<i64>,
}

/// 复用现有 whichvideo.db 的 schema（与 src/main/db.ts 一致）。
/// 现有库已含这些表，CREATE TABLE IF NOT EXISTS 不会重复建。
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  duration REAL,
  width INTEGER,
  height INTEGER,
  video_codec TEXT,
  frame_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  added_at INTEGER NOT NULL,
  indexed_at INTEGER,
  folder_id INTEGER REFERENCES image_folders(id) ON DELETE SET NULL,
  thumbnail BLOB,
  processed_timestamps TEXT NOT NULL DEFAULT '[]',
  processed_ms INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT,
  sampling_override TEXT
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id);
CREATE INDEX IF NOT EXISTS idx_videos_name ON videos(name);
CREATE INDEX IF NOT EXISTS idx_videos_dir ON videos(dir);

CREATE TABLE IF NOT EXISTS frames (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  frame_index INTEGER NOT NULL,
  time_ms INTEGER NOT NULL,
  dhash BLOB NOT NULL,
  struct BLOB NOT NULL,
  color BLOB NOT NULL,
  spatial BLOB NOT NULL,
  PRIMARY KEY (video_id, frame_index)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS image_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  recursive INTEGER NOT NULL DEFAULT 1,
  watch_state TEXT NOT NULL DEFAULT 'idle',
  message TEXT,
  added_at INTEGER NOT NULL,
  last_scan_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// 数据目录判定（骨架简化版）：
/// 1) env WHICHVIDEO_DATA_DIR
/// 2) exe 同级 data/
/// 3) 当前目录 data/
/// 完整判定（便携启动器注入等）留待阶段 4。
pub fn data_dir() -> PathBuf {
    if let Ok(d) = env::var("WHICHVIDEO_DATA_DIR") {
        return PathBuf::from(d);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.join("data");
        }
    }
    PathBuf::from("data")
}

pub fn open_db() -> SqlResult<Connection> {
    let dir = data_dir();
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("whichvideo.db");
    let conn = Connection::open(path)?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    conn.execute_batch(SCHEMA)?;
    // 与 src/main/db.ts 迁移保持一致：补齐旧 Electron 库可能缺失的列（已有则 ALTER 报错，忽略）。
    for stmt in [
        "ALTER TABLE videos ADD COLUMN file_hash TEXT",
        "ALTER TABLE videos ADD COLUMN sampling_override TEXT",
    ] {
        let _ = conn.execute(stmt, []);
    }
    Ok(conn)
}

pub fn stats(conn: &Connection) -> SqlResult<LibraryStats> {
    let (videos, indexed, pending, failed, bytes): (
        i64,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        i64,
    ) = conn.query_row(
        "SELECT COUNT(*),
                SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status IN ('pending','indexing') THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
                COALESCE(SUM(size), 0)
         FROM videos",
        [],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    let frames: i64 = conn.query_row("SELECT COUNT(*) FROM frames", [], |row| row.get(0))?;
    let (folders, watching): (i64, Option<i64>) = conn.query_row(
        "SELECT COUNT(*), SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) FROM image_folders",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(LibraryStats {
        videos,
        indexed_videos: indexed.unwrap_or(0),
        pending_videos: pending.unwrap_or(0),
        failed_videos: failed.unwrap_or(0),
        frames,
        total_bytes: bytes,
        folders,
        watching: watching.unwrap_or(0),
    })
}

/// 路径规范化：统一成 Windows 反斜杠并去掉尾部反斜杠（镜像 types.ts::normalizePath）。
fn normalize_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_string()
}

/// 比较用 key（镜像 types.ts::pathKeyOf）。
fn path_key(p: &str) -> String {
    normalize_path(p).to_lowercase()
}

/// 当前毫秒时间戳（避免引入 chrono 依赖）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row_to_folder(row: &rusqlite::Row) -> rusqlite::Result<WatchedFolder> {
    Ok(WatchedFolder {
        id: row.get(0)?,
        path: row.get(1)?,
        path_key: row.get(2)?,
        name: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        enabled: row.get::<_, i64>(5)? != 0,
        recursive: row.get::<_, i64>(6)? != 0,
        watch_state: row.get(7)?,
        message: row.get(8)?,
        added_at: row.get(9)?,
        last_scan_at: row.get(10)?,
    })
}

pub fn list_folders(conn: &Connection) -> SqlResult<Vec<WatchedFolder>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, path_key, name, pinned, enabled, recursive, watch_state, message, added_at, last_scan_at
         FROM image_folders ORDER BY pinned DESC, added_at ASC",
    )?;
    let folders = stmt.query_map([], row_to_folder)?;
    let mut out = Vec::new();
    for f in folders {
        out.push(f?);
    }
    Ok(out)
}

pub fn get_folder(conn: &Connection, id: i64) -> SqlResult<Option<WatchedFolder>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, path_key, name, pinned, enabled, recursive, watch_state, message, added_at, last_scan_at
         FROM image_folders WHERE id = ?",
    )?;
    let mut rows = stmt.query_map([id], row_to_folder)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn find_folder_by_path(conn: &Connection, dir_path: &str) -> SqlResult<Option<WatchedFolder>> {
    let key = path_key(dir_path);
    let mut stmt = conn.prepare(
        "SELECT id, path, path_key, name, pinned, enabled, recursive, watch_state, message, added_at, last_scan_at
         FROM image_folders WHERE path_key = ?",
    )?;
    let mut rows = stmt.query_map([key], row_to_folder)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// 登记/更新一个被监听的文件夹，返回其记录。insert 与 update 等价（folderId
/// 注册用），与 Electron db.upsertFolder 语义一致。
pub fn insert_folder(
    conn: &Connection,
    dir_path: &str,
    pinned: bool,
    recursive: bool,
) -> SqlResult<WatchedFolder> {
    let normalized = normalize_path(dir_path);
    let key = path_key(&normalized);
    if let Some(existing) = find_folder_by_path(conn, &normalized)? {
        if pinned {
            conn.execute("UPDATE image_folders SET pinned = 1 WHERE id = ?", [existing.id])?;
        }
        return get_folder(conn, existing.id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows);
    }
    let name = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&normalized)
        .to_string();
    conn.execute(
        "INSERT INTO image_folders (path, path_key, name, pinned, enabled, recursive, watch_state, added_at)
         VALUES (?, ?, ?, ?, 1, ?, 'idle', ?)",
        rusqlite::params![
            normalized,
            key,
            name,
            if pinned { 1i64 } else { 0i64 },
            if recursive { 1i64 } else { 0i64 },
            now_ms()
        ],
    )?;
    let id = conn.last_insert_rowid();
    get_folder(conn, id)?.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
}

pub fn set_folder_enabled(conn: &Connection, id: i64, enabled: bool) -> SqlResult<bool> {
    let n = conn.execute(
        "UPDATE image_folders SET enabled = ? WHERE id = ?",
        rusqlite::params![if enabled { 1i64 } else { 0i64 }, id],
    )?;
    Ok(n > 0)
}

#[allow(dead_code)]
pub fn update_folder_state(
    conn: &Connection,
    id: i64,
    state: &str,
    message: Option<&str>,
) -> SqlResult<()> {
    conn.execute(
        "UPDATE image_folders SET watch_state = ?, message = ? WHERE id = ?",
        rusqlite::params![state, message, id],
    )?;
    Ok(())
}

#[allow(dead_code)]
pub fn mark_folder_scanned(conn: &Connection, id: i64) -> SqlResult<()> {
    conn.execute(
        "UPDATE image_folders SET last_scan_at = ? WHERE id = ?",
        rusqlite::params![now_ms(), id],
    )?;
    Ok(())
}

/// 删除文件夹记录（视频记录保留，folder_id 经 ON DELETE SET NULL 自动置空）。
pub fn remove_folder(conn: &Connection, id: i64) -> SqlResult<bool> {
    let n = conn.execute("DELETE FROM image_folders WHERE id = ?", [id])?;
    Ok(n > 0)
}

/* ------------------------------------------------------------------ */
/* 视频记录 / 查询 / 分页                                              */
/* ------------------------------------------------------------------ */

/// 与 src/shared/types.ts 的 VideoRecord 对齐（serde rename 输出 camelCase）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRecord {
    pub id: i64,
    pub path: String,
    pub path_key: String,
    pub name: String,
    pub dir: String,
    pub ext: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub video_codec: Option<String>,
    pub frame_count: i64,
    pub status: String,
    pub error: Option<String>,
    pub added_at: i64,
    pub indexed_at: Option<i64>,
    pub folder_id: Option<i64>,
    pub processed_timestamps: Vec<i64>,
    pub processed_ms: i64,
    pub sampling_override: Option<String>,
    pub file_hash: Option<String>,
}

/// 与 src/shared/types.ts 的 VideoPage 对齐。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPage {
    pub total: i64,
    pub items: Vec<VideoRecord>,
}

/// videos.list 的入参（对齐 VideoQuery）。由 Tauri 从 invoke 参数反序列化，全字段可选。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoQuery {
    pub keyword: Option<String>,
    pub folder_id: Option<i64>,
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub sort: Option<String>,
    pub order: Option<String>,
}

/// 与 src/shared/types.ts 的 FrameManifestEntry 对齐。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameManifestEntry {
    pub frame_index: i64,
    pub time_ms: i64,
}

/// 与 src/shared/types.ts 的 AppSettings 对齐。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub frames_per_video: i64,
    pub concurrency: i64,
    pub min_hash_score: f64,
    pub max_results: i64,
    pub await_write_ms: i64,
    pub prune_on_delete: bool,
    pub sampling_mode: String,
    pub update_check: bool,
    pub keep_frame_images: bool,
}

/// Rust 侧镜像 src/shared/types.ts 的 DEFAULT_SETTINGS（含 String 字段，故用函数而非 const）。
pub fn default_settings() -> AppSettings {
    AppSettings {
        frames_per_video: 240,
        concurrency: 2,
        min_hash_score: 0.6,
        max_results: 40,
        await_write_ms: 1500,
        prune_on_delete: true,
        sampling_mode: "uniform".to_string(),
        update_check: true,
        keep_frame_images: false,
    }
}

/// 列表/单条取视频时选取的列（刻意排除 thumbnail BLOB，避免列表被大字段拖慢）。
const VIDEO_COLUMNS: &str = "id, path, path_key, name, dir, ext, size, mtime_ms, duration, \
    width, height, video_codec, frame_count, status, error, added_at, indexed_at, folder_id, \
    processed_timestamps, processed_ms";

fn row_to_video(row: &rusqlite::Row) -> rusqlite::Result<VideoRecord> {
    let processed_timestamps: String = row.get("processed_timestamps")?;
    let processed_timestamps: Vec<i64> = serde_json::from_str(&processed_timestamps).unwrap_or_default();
    Ok(VideoRecord {
        id: row.get("id")?,
        path: row.get("path")?,
        path_key: row.get("path_key")?,
        name: row.get("name")?,
        dir: row.get("dir")?,
        ext: row.get("ext")?,
        size: row.get("size")?,
        mtime_ms: row.get("mtime_ms")?,
        duration: row.get::<_, Option<f64>>("duration")?,
        width: row.get::<_, Option<i64>>("width")?,
        height: row.get::<_, Option<i64>>("height")?,
        video_codec: row.get::<_, Option<String>>("video_codec")?,
        frame_count: row.get("frame_count")?,
        status: row.get("status")?,
        error: row.get::<_, Option<String>>("error")?,
        added_at: row.get("added_at")?,
        indexed_at: row.get::<_, Option<i64>>("indexed_at")?,
        folder_id: row.get::<_, Option<i64>>("folder_id")?,
        processed_timestamps,
        processed_ms: row.get("processed_ms")?,
        sampling_override: row.get::<_, Option<String>>("sampling_override")?,
        file_hash: row.get::<_, Option<String>>("file_hash")?,
    })
}

pub fn get_video(conn: &Connection, id: i64) -> SqlResult<Option<VideoRecord>> {
    let sql = format!("SELECT {} FROM videos WHERE id = ?", VIDEO_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map([id], row_to_video)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn list_videos(conn: &Connection, q: &VideoQuery) -> SqlResult<VideoPage> {
    let mut where_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(kw) = &q.keyword {
        if !kw.is_empty() {
            where_clauses.push("(name LIKE ? OR dir LIKE ?)".to_string());
            let like = format!("%{}%", kw);
            params.push(Box::new(like.clone()));
            params.push(Box::new(like));
        }
    }
    if let Some(folder_id) = q.folder_id {
        where_clauses.push("folder_id = ?".to_string());
        params.push(Box::new(folder_id));
    }
    if let Some(status) = &q.status {
        if status != "all" && !status.is_empty() {
            where_clauses.push("status = ?".to_string());
            params.push(Box::new(status.clone()));
        }
    }

    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };

    // 排序列白名单，杜绝注入；方向仅 ASC/DESC。
    let sort = match q.sort.as_deref() {
        Some("name") => "name",
        Some("size") => "size",
        Some("duration") => "COALESCE(duration, 0)",
        _ => "added_at",
    };
    let order = match q.order.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };
    let limit = q.limit.unwrap_or(200).clamp(1, 2000);
    let offset = q.offset.unwrap_or(0).max(0);

    let count_sql = format!("SELECT COUNT(*) FROM videos {}", where_sql);
    let total: i64 = conn.query_row(
        &count_sql,
        params_from_iter(params.iter().map(|b| b.as_ref())),
        |row| row.get(0),
    )?;

    let select_sql = format!(
        "SELECT {} FROM videos {} ORDER BY {} {} LIMIT ? OFFSET ?",
        VIDEO_COLUMNS, where_sql, sort, order
    );
    params.push(Box::new(limit));
    params.push(Box::new(offset));
    let mut stmt = conn.prepare(&select_sql)?;
    let mut rows = stmt.query_map(params_from_iter(params.iter().map(|b| b.as_ref())), row_to_video)?;
    let mut items = Vec::new();
    while let Some(r) = rows.next() {
        items.push(r?);
    }
    Ok(VideoPage { total, items })
}

pub fn get_thumbnail(conn: &Connection, video_id: i64) -> SqlResult<Option<String>> {
    let blob: Option<Vec<u8>> = conn.query_row(
        "SELECT thumbnail FROM videos WHERE id = ?",
        [video_id],
        |row| row.get(0),
    )?;
    Ok(blob.map(|b| {
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&b)
        )
    }))
}

pub fn list_frame_manifest(conn: &Connection, video_id: i64) -> SqlResult<Vec<FrameManifestEntry>> {
    let mut stmt = conn.prepare(
        "SELECT frame_index, time_ms FROM frames WHERE video_id = ? ORDER BY frame_index",
    )?;
    let rows = stmt.query_map([video_id], |row| {
        Ok(FrameManifestEntry {
            frame_index: row.get(0)?,
            time_ms: row.get(1)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_settings(conn: &Connection) -> SqlResult<AppSettings> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut s = default_settings();
    for r in rows {
        let (key, value) = r?;
        match key.as_str() {
            "framesPerVideo" => {
                if let Ok(v) = serde_json::from_str::<i64>(&value) {
                    s.frames_per_video = v;
                }
            }
            "concurrency" => {
                if let Ok(v) = serde_json::from_str::<i64>(&value) {
                    s.concurrency = v;
                }
            }
            "minHashScore" => {
                if let Ok(v) = serde_json::from_str::<f64>(&value) {
                    s.min_hash_score = v;
                }
            }
            "maxResults" => {
                if let Ok(v) = serde_json::from_str::<i64>(&value) {
                    s.max_results = v;
                }
            }
            "awaitWriteMs" => {
                if let Ok(v) = serde_json::from_str::<i64>(&value) {
                    s.await_write_ms = v;
                }
            }
            "pruneOnDelete" => {
                if let Ok(v) = serde_json::from_str::<bool>(&value) {
                    s.prune_on_delete = v;
                }
            }
            "samplingMode" => {
                if let Ok(v) = serde_json::from_str::<String>(&value) {
                    s.sampling_mode = v;
                }
            }
            "updateCheck" => {
                if let Ok(v) = serde_json::from_str::<bool>(&value) {
                    s.update_check = v;
                }
            }
            "keepFrameImages" => {
                if let Ok(v) = serde_json::from_str::<bool>(&value) {
                    s.keep_frame_images = v;
                }
            }
            _ => {}
        }
    }
    Ok(s)
}

/* ------------------------------------------------------------------ */
/* 索引器状态 / 数据目录信息                                          */
/* ------------------------------------------------------------------ */

/// 与 src/shared/types.ts 的 IndexerStatus 对齐。M7 接入真实索引器前先用闲置态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerStatus {
    pub running: bool,
    pub active: i64,
    pub queued: i64,
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub current_path: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
}

#[allow(dead_code)]
pub fn idle_indexer_status() -> IndexerStatus {
    IndexerStatus {
        running: false,
        active: 0,
        queued: 0,
        total: 0,
        done: 0,
        failed: 0,
        current_path: None,
        started_at: None,
        finished_at: None,
        last_error: None,
    }
}

/// 与 src/shared/types.ts 的 DataDirInfo 对齐。tools_ready 在 M5（媒体探测）补齐。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    pub dir: String,
    pub portable: bool,
    pub source: String,
    pub tools_ready: bool,
}

/// 解析数据目录并附带便携判定与工具可用性。
pub fn data_dir_info(tools_ready: bool) -> DataDirInfo {
    let dir = data_dir();
    let dir_str = dir.to_string_lossy().to_string();
    let (portable, source) = if std::env::var("WHICHVIDEO_DATA_DIR").is_ok() {
        (false, "env")
    } else {
        // exe 同级 data/ 存在 → 视为便携模式（数据随 exe 走）。
        let is_portable = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.join("data").exists()))
            .unwrap_or(false);
        (is_portable, "default")
    };
    DataDirInfo {
        dir: dir_str,
        portable,
        source: source.to_string(),
        tools_ready,
    }
}

/* ------------------------------------------------------------------ */
/* 设置写入 / 重置                                                    */
/* ------------------------------------------------------------------ */

/// library.updateSettings 的入参（全字段可选，camelCase 镜像 AppSettings）。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub frames_per_video: Option<i64>,
    pub concurrency: Option<i64>,
    pub min_hash_score: Option<f64>,
    pub max_results: Option<i64>,
    pub await_write_ms: Option<i64>,
    pub prune_on_delete: Option<bool>,
    pub sampling_mode: Option<String>,
    pub update_check: Option<bool>,
    pub keep_frame_images: Option<bool>,
}

pub fn update_settings(conn: &mut Connection, patch: &SettingsPatch) -> SqlResult<AppSettings> {
    let candidates: Vec<(String, Option<String>)> = vec![
        ("framesPerVideo".into(), patch.frames_per_video.map(|v| v.to_string())),
        ("concurrency".into(), patch.concurrency.map(|v| v.to_string())),
        ("minHashScore".into(), patch.min_hash_score.map(|v| v.to_string())),
        ("maxResults".into(), patch.max_results.map(|v| v.to_string())),
        ("awaitWriteMs".into(), patch.await_write_ms.map(|v| v.to_string())),
        ("pruneOnDelete".into(), patch.prune_on_delete.map(|v| v.to_string())),
        ("samplingMode".into(), patch.sampling_mode.clone()),
        ("updateCheck".into(), patch.update_check.map(|v| v.to_string())),
        ("keepFrameImages".into(), patch.keep_frame_images.map(|v| v.to_string())),
    ];
    let present: Vec<(String, String)> = candidates
        .into_iter()
        .filter_map(|(k, v)| v.map(|val| (k, val)))
        .collect();
    if !present.is_empty() {
        const UPSERT: &str = "INSERT INTO settings (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value";
        let tx = conn.transaction()?;
        for (k, v) in &present {
            tx.execute(UPSERT, rusqlite::params![k, v])?;
        }
        tx.commit()?;
    }
    get_settings(conn)
}

/// 重置索引库（清空视频/帧/文件夹，保留设置），对齐 Electron library_reset。
pub fn clear_all(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch("DELETE FROM frames; DELETE FROM videos; DELETE FROM image_folders;")?;
    Ok(())
}
