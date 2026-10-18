use base64::Engine;
use crate::framepack;
use rusqlite::{params_from_iter, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 与 src/shared/types.ts 的 LibraryStats 对齐（serde rename 输出 camelCase）。
#[derive(Serialize, Clone)]
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
#[derive(Serialize, Clone)]
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

/// whichvideo.db 的当前 schema。
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataDirResolution {
    pub dir: PathBuf,
    pub source: &'static str,
}

static DATA_DIR: OnceLock<DataDirResolution> = OnceLock::new();

fn clean_env(value: Option<String>) -> Option<PathBuf> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 数据目录固定在程序目录；环境变量仅作为显式覆盖入口。
pub fn resolve_data_dir(env_dir: Option<String>, exe_dir: &Path) -> DataDirResolution {
    if let Some(candidate) = clean_env(env_dir) {
        return DataDirResolution {
            dir: candidate,
            source: "env",
        };
    }
    DataDirResolution {
        dir: exe_dir.join("data"),
        source: "install",
    }
}

fn copy_tree_missing(source: &Path, target: &Path) -> io::Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree_missing(&from, &to)?;
        } else if !to.exists() {
            fs::copy(from, to)?;
        }
    }
    Ok(())
}

fn migrate_legacy_data(target: &Path, legacy: &Path) {
    if target == legacy {
        return;
    }
    for name in ["whichvideo.db", "whichvideo.db-wal", "whichvideo.db-shm"] {
        let from = legacy.join(name);
        let to = target.join(name);
        if from.exists() && !to.exists() {
            let _ = fs::copy(from, to);
        }
    }
    let _ = copy_tree_missing(&legacy.join("frames"), &target.join("frames"));
}

/// 在 Tauri setup 阶段调用一次，之后所有模块共享同一个最终目录。
/// legacy_dir 只用于把旧版本数据库迁入程序目录，不会成为运行时回退位置。
pub fn initialize_data_dir(legacy_dir: PathBuf) -> io::Result<DataDirResolution> {
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let resolution = resolve_data_dir(env::var("WHICHVIDEO_DATA_DIR").ok(), &exe_dir);
    fs::create_dir_all(&resolution.dir)?;
    migrate_legacy_data(&resolution.dir, &legacy_dir);
    let _ = DATA_DIR.set(resolution.clone());
    Ok(resolution)
}

pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .map(|r| r.dir.clone())
        .unwrap_or_else(|| PathBuf::from("data"))
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
    // 兼容早期数据库：补齐可能缺失的列（已有则 ALTER 报错并忽略）。
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
pub fn normalize_path(p: &str) -> String {
    let normalized = p.replace('/', "\\");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3
        && bytes[1] == b':'
        && bytes[2..].iter().all(|byte| *byte == b'\\')
    {
        return normalized[..3].to_string();
    }
    normalized.trim_end_matches('\\').to_string()
}

/// 比较用 key（镜像 types.ts::pathKeyOf）。
fn path_key(p: &str) -> String {
    normalize_path(p).to_lowercase()
}

/// 当前毫秒时间戳（避免引入 chrono 依赖）。
pub fn now_ms() -> i64 {
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
/// 注册用），保持幂等更新语义。
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
#[derive(Serialize, Clone)]
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
#[derive(Serialize, Clone, Default)]
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
    processed_timestamps, processed_ms, sampling_override, file_hash";

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

/// size 与时长一致的视频对只是 bit 级副本候选，调用方还须以 SHA-256 确认。
pub fn find_identical_file_pairs(conn: &Connection) -> SqlResult<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, b.id FROM videos a JOIN videos b
         ON a.id < b.id AND a.size = b.size AND ABS(a.duration - b.duration) < 0.5",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

pub fn set_file_hash(conn: &Connection, id: i64, hash: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE videos SET file_hash = ? WHERE id = ?",
        rusqlite::params![hash, id],
    )?;
    Ok(())
}

/// 删除视频记录（frames 经 ON DELETE CASCADE 一并删除）。返回删除前的记录，
/// 便于上层广播事件。若不存在返回 None。
pub fn remove_video(conn: &Connection, id: i64) -> SqlResult<Option<VideoRecord>> {
    let video = get_video(conn, id)?;
    if video.is_none() {
        return Ok(None);
    }
    conn.execute("DELETE FROM videos WHERE id = ?", [id])?;
    Ok(video)
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

/// FFmpeg 手动目录单独保存在 settings 表；它属于运行环境配置，不参与索引参数广播。
pub fn get_ffmpeg_dir(conn: &Connection) -> SqlResult<Option<String>> {
    match conn.query_row(
        "SELECT value FROM settings WHERE key = 'ffmpegDir'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn set_ffmpeg_dir(conn: &Connection, dir: Option<&str>) -> SqlResult<()> {
    match dir.filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ffmpegDir', ?) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [value],
            )?;
        }
        None => {
            conn.execute("DELETE FROM settings WHERE key = 'ffmpegDir'", [])?;
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 索引器状态 / 数据目录信息                                          */
/* ------------------------------------------------------------------ */

/// 与 src/shared/types.ts 的 IndexerStatus 对齐。M7 接入真实索引器前先用闲置态。
#[derive(Serialize, Clone)]
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

/// 与 src/shared/types.ts 的 DataDirInfo 对齐。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    pub dir: String,
    pub source: String,
    pub tools_ready: bool,
}

/// 解析数据目录并附带便携判定与工具可用性。
pub fn data_dir_info(tools_ready: bool) -> DataDirInfo {
    let resolution = DATA_DIR.get().cloned().unwrap_or(DataDirResolution {
        dir: data_dir(),
        source: "install",
    });
    DataDirInfo {
        dir: resolution.dir.to_string_lossy().to_string(),
        source: resolution.source.to_string(),
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

/// 重置索引库：清空视频、帧和文件夹，保留用户设置。
pub fn clear_all(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch("DELETE FROM frames; DELETE FROM videos; DELETE FROM image_folders;")?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 索引器写入                                                          */
/* ------------------------------------------------------------------ */

/// 单帧指纹落库形态（与 frames 表列一一对应）。dhash 以 i64 存储（BLOB 亲和列可容纳整数）。
pub struct NewFrame {
    pub dhash: i64,
    pub struct_hash: Vec<u8>,
    pub color: Vec<u8>,
    pub spatial: Vec<u8>,
    pub frame_index: i64,
    pub time_ms: i64,
}

/// upsertVideo 的输入（仅含索引器会写/改的字段）。
pub struct UpsertVideoInput {
    pub path: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub video_codec: Option<String>,
    pub folder_id: Option<i64>,
    pub file_hash: Option<String>,
}

/// 按路径注册/更新一个视频，返回 (记录, 是否新建, 是否内容变化)。
/// changed=true 的既有视频会被重新入队索引。镜像 db.upsertVideo。
pub fn upsert_video(
    conn: &Connection,
    input: &UpsertVideoInput,
) -> SqlResult<(VideoRecord, bool, bool)> {
    let normalized = normalize_path(&input.path);
    let key = path_key(&normalized);
    let (name, dir, ext) = split_path(&normalized);

    if let Some(existing) = find_folder_video_by_key(conn, &key)? {
        // 既有：比较关键字段判断是否变化（内容变化 → 重抽）
        let changed = existing.size != input.size
            || (existing.mtime_ms - input.mtime_ms).abs() > 1000
            || existing.duration != input.duration
            || existing.width != input.width
            || existing.height != input.height
            || existing.video_codec != input.video_codec
            || (existing.file_hash.is_none() && input.file_hash.is_some());
        conn.execute(
            "UPDATE videos SET size=?, mtime_ms=?, duration=?, width=?, height=?, video_codec=?, \
             folder_id=?, file_hash=? WHERE id=?",
            rusqlite::params![
                input.size,
                input.mtime_ms,
                input.duration,
                input.width,
                input.height,
                input.video_codec,
                input.folder_id,
                input.file_hash,
                existing.id
            ],
        )?;
        let refreshed = get_video(conn, existing.id)?.unwrap_or(existing);
        Ok((refreshed, false, changed))
    } else {
        conn.execute(
            "INSERT INTO videos (path, path_key, name, dir, ext, size, mtime_ms, duration, width, \
             height, video_codec, status, added_at, folder_id, file_hash, processed_timestamps, \
             processed_ms, frame_count) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, '[]', 0, 0)",
            rusqlite::params![
                normalized,
                key,
                name,
                dir,
                ext,
                input.size,
                input.mtime_ms,
                input.duration,
                input.width,
                input.height,
                input.video_codec,
                now_ms(),
                input.folder_id,
                input.file_hash
            ],
        )?;
        let id = conn.last_insert_rowid();
        let rec = get_video(conn, id)?.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
        Ok((rec, true, true))
    }
}

fn split_path(p: &str) -> (String, String, String) {
    let path = std::path::Path::new(p);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let dir = path
        .parent()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();
    (name, dir, ext)
}

fn find_folder_video_by_key(conn: &Connection, key: &str) -> SqlResult<Option<VideoRecord>> {
    let sql = format!("SELECT {} FROM videos WHERE path_key = ?", VIDEO_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map([key], row_to_video)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// 按路径查视频（pathKeyOf 规范化后比对）。
pub fn find_by_path(conn: &Connection, path: &str) -> SqlResult<Option<VideoRecord>> {
    let key = path_key(&normalize_path(path));
    find_folder_video_by_key(conn, &key)
}

/// 设置视频状态（indexing/ready/failed/pending），可选写入错误信息。
pub fn set_video_status(conn: &Connection, id: i64, status: &str, error: Option<&str>) -> SqlResult<()> {
    conn.execute(
        "UPDATE videos SET status = ?, error = ? WHERE id = ?",
        rusqlite::params![status, error, id],
    )?;
    Ok(())
}

/// 固化采样模式覆盖（sampling_override）。
pub fn set_sampling_override(conn: &mut Connection, ids: &[i64], mode: &str) -> SqlResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for &id in ids {
        tx.execute(
            "UPDATE videos SET sampling_override = ? WHERE id = ?",
            rusqlite::params![mode, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 全局采样模式变化时，只迁移仍跟随旧全局值的视频；显式覆盖到其他模式的不动。
pub fn migrate_sampling_on_global_change(
    conn: &Connection,
    old_mode: &str,
    new_mode: &str,
) -> SqlResult<usize> {
    conn.execute(
        "UPDATE videos SET sampling_override = ? WHERE sampling_override = ?",
        rusqlite::params![new_mode, old_mode],
    )
}

/// 清空若干视频的帧（重建索引前调用）。
pub fn clear_frames(conn: &Connection, ids: &[i64]) -> SqlResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "DELETE FROM frames WHERE video_id IN ({})",
        placeholders.join(",")
    );
    let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

/// 写入已处理的时间点索引（断点续传）。
pub fn update_processed_timestamps(conn: &Connection, id: i64, ts: &[i64]) -> SqlResult<()> {
    let json = serde_json::to_string(ts).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "UPDATE videos SET processed_timestamps = ? WHERE id = ?",
        rusqlite::params![json, id],
    )?;
    Ok(())
}

/// 累加已处理耗时（断点续传跨会话累计）。
pub fn add_processed_ms(conn: &Connection, id: i64, ms: i64) -> SqlResult<()> {
    conn.execute(
        "UPDATE videos SET processed_ms = processed_ms + ? WHERE id = ?",
        rusqlite::params![ms, id],
    )?;
    Ok(())
}

/// 标记索引完成：状态 ready + indexed_at + 帧数 + 缩略图。
pub fn set_ready_with_thumbnail(
    conn: &Connection,
    id: i64,
    thumbnail: Option<&[u8]>,
) -> SqlResult<()> {
    let frames: i64 = conn.query_row(
        "SELECT COUNT(*) FROM frames WHERE video_id = ?",
        [id],
        |row| row.get(0),
    )?;
    conn.execute(
        "UPDATE videos SET status = 'ready', indexed_at = ?, frame_count = ?, thumbnail = ? WHERE id = ?",
        rusqlite::params![now_ms(), frames, thumbnail, id],
    )?;
    Ok(())
}

/// 列出待处理视频（pending / indexing），启动恢复时用。
#[allow(dead_code)]
pub fn list_pending_videos(conn: &Connection) -> SqlResult<Vec<VideoRecord>> {
    let sql = format!(
        "SELECT {} FROM videos WHERE status IN ('pending','indexing') ORDER BY added_at ASC",
        VIDEO_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_video)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 增量写入一批帧指纹。
pub fn upsert_frames_incremental(conn: &mut Connection, video_id: i64, frames: &[NewFrame]) -> SqlResult<()> {
    if frames.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for f in frames {
        tx.execute(
            "INSERT OR REPLACE INTO frames (video_id, frame_index, time_ms, dhash, struct, color, spatial) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                video_id,
                f.frame_index,
                f.time_ms,
                f.dhash,
                f.struct_hash,
                f.color,
                f.spatial
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 搜索层所需的内存帧矩阵：256 字节/帧的紧凑缓冲 + 每帧对应的 video_id。
/// 顺序与帧在库中的 (video_id, frame_index) 一致，FrameSearchIndex 直接按偏移寻址。
pub struct FrameMatrix {
    pub buffer: Vec<u8>,
    pub video_ids: Vec<i64>,
}

/// 全量读出所有帧指纹，拼成常驻内存缓冲。
///
/// dhash 在库中按 i64 存储（与 NewFrame.dhash 一致），读出后按小端 8 字节写回缓冲，
/// 与索引侧 ffmpeg scale=w=320:h=-2 的 rgb24 帧哈希路径完全对称。struct/color/spatial
/// 为 BLOB，按各自长度拷贝（不足按 0 填充，防御性）。
pub fn load_frame_matrix(conn: &Connection) -> SqlResult<FrameMatrix> {
    let mut stmt = conn.prepare(
        "SELECT video_id, dhash, struct, color, spatial, frame_index, time_ms \
         FROM frames ORDER BY video_id, frame_index",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,              // video_id
            row.get::<_, i64>(1)?,              // dhash (i64)
            row.get::<_, Vec<u8>>(2)?,          // struct (BLOB 128)
            row.get::<_, Vec<u8>>(3)?,          // color (BLOB 64)
            row.get::<_, Vec<u8>>(4)?,          // spatial (BLOB 48)
            row.get::<_, i64>(5)?,              // frame_index
            row.get::<_, i64>(6)?,              // time_ms
        ))
    })?;
    let mut buffer = Vec::new();
    let mut video_ids = Vec::new();
    for r in rows {
        let (vid, dhash, st, col, sp, fi, tm) = r?;
        let off = buffer.len();
        buffer.resize(off + framepack::FRAME_STRIDE, 0u8);
        buffer[off + framepack::DHASH_OFFSET..off + framepack::DHASH_OFFSET + 8]
            .copy_from_slice(&dhash.to_le_bytes());
        let sl = st.len().min(framepack::STRUCT_BYTES);
        buffer[off + framepack::STRUCT_OFFSET..off + framepack::STRUCT_OFFSET + sl]
            .copy_from_slice(&st[..sl]);
        let cl = col.len().min(framepack::COLOR_BYTES);
        buffer[off + framepack::COLOR_OFFSET..off + framepack::COLOR_OFFSET + cl]
            .copy_from_slice(&col[..cl]);
        let spl = sp.len().min(framepack::SPATIAL_BYTES);
        buffer[off + framepack::SPATIAL_OFFSET..off + framepack::SPATIAL_OFFSET + spl]
            .copy_from_slice(&sp[..spl]);
        buffer[off + framepack::META_OFFSET..off + framepack::META_OFFSET + 4]
            .copy_from_slice(&(fi as u32).to_le_bytes());
        buffer[off + framepack::META_OFFSET + 4..off + framepack::META_OFFSET + 8]
            .copy_from_slice(&(tm as u32).to_le_bytes());
        video_ids.push(vid);
    }
    Ok(FrameMatrix { buffer, video_ids })
}

fn path_is_under(path: &str, directory: &str) -> bool {
    path.strip_prefix(directory).is_some_and(|suffix| {
        if directory.ends_with('\\') {
            !suffix.is_empty()
        } else {
            suffix.starts_with('\\')
        }
    })
}

/// 列出某目录（含子目录）下的视频 id。路径边界在 Rust 中判断，避免 SQL LIKE
/// 把 `C:\Media2` 误当作 `C:\Media` 的子目录，也避免反斜杠转义歧义。
pub fn video_ids_under(conn: &Connection, dir: &str) -> SqlResult<Vec<i64>> {
    let key = path_key(dir);
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id, path_key FROM videos ORDER BY id")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
        let mut v = Vec::new();
        for r in rows {
            let (id, video_path) = r?;
            if path_is_under(&video_path, &key) {
                v.push(id);
            }
        }
        v
    };
    Ok(ids)
}

pub fn remove_video_ids(conn: &Connection, ids: &[i64]) -> SqlResult<()> {
    if !ids.is_empty() {
        let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
        let sql = format!("DELETE FROM videos WHERE id IN ({})", placeholders.join(","));
        let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        conn.execute(&sql, params.as_slice())?;
    }
    Ok(())
}

/// 删除某目录（含子目录）下的所有视频，返回被删 id 列表（frames 级联删除）。
#[allow(dead_code)]
pub fn remove_videos_under(conn: &Connection, dir: &str) -> SqlResult<Vec<i64>> {
    let ids = video_ids_under(conn, dir)?;
    remove_video_ids(conn, &ids)?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_is_always_next_to_executable_unless_explicitly_overridden() {
        let exe = Path::new("D:\\WhichVideo");

        let env_choice = resolve_data_dir(Some(" E:\\LibraryData ".to_string()), exe);
        assert_eq!(env_choice.dir, PathBuf::from("E:\\LibraryData"));
        assert_eq!(env_choice.source, "env");

        let installed = resolve_data_dir(None, exe);
        assert_eq!(installed.dir, exe.join("data"));
        assert_eq!(installed.source, "install");
    }

    #[test]
    fn path_normalization_preserves_windows_drive_roots() {
        assert_eq!(normalize_path("C:\\"), "C:\\");
        assert_eq!(normalize_path("D:////"), "D:\\");
        assert_eq!(normalize_path("C:\\Media\\\\"), "C:\\Media");
    }

    #[test]
    fn removing_a_directory_does_not_remove_similarly_prefixed_siblings() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (id, path) in [
            (1_i64, "C:\\Media\\a.mp4"),
            (2, "C:\\Media2\\b.mp4"),
            (3, "C:\\Media\\Sub\\c.mp4"),
        ] {
            let input = UpsertVideoInput {
                path: path.to_string(),
                size: 1,
                mtime_ms: 1,
                duration: Some(1.0),
                width: Some(1),
                height: Some(1),
                video_codec: None,
                folder_id: None,
                file_hash: None,
            };
            let (video, _, _) = upsert_video(&conn, &input).unwrap();
            assert_eq!(video.id, id);
        }

        assert_eq!(remove_videos_under(&conn, "C:\\Media").unwrap(), vec![1, 3]);
        assert!(get_video(&conn, 1).unwrap().is_none());
        assert!(get_video(&conn, 3).unwrap().is_none());
        assert!(get_video(&conn, 2).unwrap().is_some());
    }

    #[test]
    fn legacy_database_and_frames_are_copied_without_overwriting_new_data() {
        let root = env::temp_dir().join(format!(
            "whichvideo-data-migration-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let legacy = root.join("legacy");
        let target = root.join("install").join("data");
        fs::create_dir_all(legacy.join("frames").join("7")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("whichvideo.db"), b"legacy-db").unwrap();
        fs::write(legacy.join("frames").join("7").join("0.jpg"), b"jpeg").unwrap();

        migrate_legacy_data(&target, &legacy);
        assert_eq!(fs::read(target.join("whichvideo.db")).unwrap(), b"legacy-db");
        assert_eq!(
            fs::read(target.join("frames").join("7").join("0.jpg")).unwrap(),
            b"jpeg"
        );

        fs::write(target.join("whichvideo.db"), b"new-db").unwrap();
        migrate_legacy_data(&target, &legacy);
        assert_eq!(fs::read(target.join("whichvideo.db")).unwrap(), b"new-db");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_candidates_require_matching_size_and_near_duration() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (id, size, duration) in [
            (1_i64, 100_i64, 10.0_f64),
            (2, 100, 10.4),
            (3, 100, 10.6),
            (4, 101, 10.0),
        ] {
            conn.execute(
                "INSERT INTO videos
                 (id, path, path_key, name, dir, ext, size, mtime_ms, duration, added_at)
                 VALUES (?, ?, ?, ?, ?, '.mp4', ?, 0, ?, 0)",
                rusqlite::params![
                    id,
                    format!("C:\\\\{id}.mp4"),
                    format!("c:\\\\{id}.mp4"),
                    format!("{id}.mp4"),
                    "C:\\",
                    size,
                    duration,
                ],
            )
            .unwrap();
        }

        assert_eq!(find_identical_file_pairs(&conn).unwrap(), vec![(1, 2), (2, 3)]);
        set_file_hash(&conn, 1, "abc123").unwrap();
        conn.execute(
            "UPDATE videos SET sampling_override = 'uniform' WHERE id IN (1, 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE videos SET sampling_override = 'scene' WHERE id = 3",
            [],
        )
        .unwrap();
        assert_eq!(
            migrate_sampling_on_global_change(&conn, "uniform", "scene").unwrap(),
            2
        );
        let video = get_video(&conn, 1).unwrap().unwrap();
        assert_eq!(video.file_hash.as_deref(), Some("abc123"));
        assert_eq!(video.sampling_override.as_deref(), Some("scene"));
    }

    #[test]
    fn frame_matrix_keeps_each_frame_in_its_own_stride() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE frames (
                video_id INTEGER NOT NULL,
                frame_index INTEGER NOT NULL,
                time_ms INTEGER NOT NULL,
                dhash INTEGER NOT NULL,
                struct BLOB NOT NULL,
                color BLOB NOT NULL,
                spatial BLOB NOT NULL
            );",
        )
        .unwrap();

        for (video_id, frame_index, time_ms, marker) in
            [(11_i64, 3_i64, 1250_i64, 0x11_u8), (22, 7, 9876, 0x22)]
        {
            conn.execute(
                "INSERT INTO frames
                 (video_id, frame_index, time_ms, dhash, struct, color, spatial)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    video_id,
                    frame_index,
                    time_ms,
                    marker as i64,
                    vec![marker; framepack::STRUCT_BYTES],
                    vec![marker; framepack::COLOR_BYTES],
                    vec![marker; framepack::SPATIAL_BYTES],
                ],
            )
            .unwrap();
        }

        let matrix = load_frame_matrix(&conn).unwrap();
        assert_eq!(matrix.video_ids, vec![11, 22]);
        assert_eq!(matrix.buffer.len(), 2 * framepack::FRAME_STRIDE);

        for (index, marker, frame_index, time_ms) in
            [(0_usize, 0x11_u8, 3_u32, 1250_u32), (1, 0x22, 7, 9876)]
        {
            let off = index * framepack::FRAME_STRIDE;
            assert_eq!(
                &matrix.buffer[off + framepack::STRUCT_OFFSET
                    ..off + framepack::STRUCT_OFFSET + framepack::STRUCT_BYTES],
                vec![marker; framepack::STRUCT_BYTES]
            );
            assert_eq!(
                &matrix.buffer[off + framepack::COLOR_OFFSET
                    ..off + framepack::COLOR_OFFSET + framepack::COLOR_BYTES],
                vec![marker; framepack::COLOR_BYTES]
            );
            assert_eq!(
                &matrix.buffer[off + framepack::SPATIAL_OFFSET
                    ..off + framepack::SPATIAL_OFFSET + framepack::SPATIAL_BYTES],
                vec![marker; framepack::SPATIAL_BYTES]
            );
            assert_eq!(
                u32::from_le_bytes(
                    matrix.buffer[off + framepack::META_OFFSET
                        ..off + framepack::META_OFFSET + 4]
                        .try_into()
                        .unwrap()
                ),
                frame_index
            );
            assert_eq!(
                u32::from_le_bytes(
                    matrix.buffer[off + framepack::META_OFFSET + 4
                        ..off + framepack::META_OFFSET + 8]
                        .try_into()
                        .unwrap()
                ),
                time_ms
            );
        }
    }
}
