use base64::Engine;
use crate::constants::DB_BUSY_TIMEOUT;
use crate::framepack;
use crate::paths;
use rusqlite::{params_from_iter, Connection, Error as SqlError, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::fs;

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

pub fn open_db() -> SqlResult<Connection> {
    let _ = fs::create_dir_all(paths::db_dir());
    let conn = Connection::open(paths::db_path())?;
    configure_connection(&conn)?;
    conn.execute_batch(SCHEMA)?;
    // 旧版按每视频帧数封顶；新计划只使用时间间隔，清理失效设置。
    conn.execute("DELETE FROM settings WHERE key = 'framesPerVideo'", [])?;
    // 兼容早期数据库：补齐可能缺失的列（已有则 ALTER 报错并忽略）。
    for stmt in [
        "ALTER TABLE videos ADD COLUMN file_hash TEXT",
        "ALTER TABLE videos ADD COLUMN sampling_override TEXT",
    ] {
        let _ = conn.execute(stmt, []);
    }
    let reconciled: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'folder_ownership_v1')",
        [], |row| row.get(0),
    )?;
    if !reconciled {
        reconcile_folder_ownership(&conn)?;
        conn.execute("INSERT INTO settings (key, value) VALUES ('folder_ownership_v1', 'done')", [])?;
    }
    Ok(conn)
}

/// 每个 SQLite 连接都必须有相同的事务约束。配置失败时宁可让启动明确报错，
/// 也不要静默退回到可能损坏关联数据或频繁报 `database is locked` 的默认设置。
fn configure_connection(conn: &Connection) -> SqlResult<()> {
    conn.busy_timeout(DB_BUSY_TIMEOUT)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
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

/// 路径规范化：保留当前系统的原生分隔符与根目录。
pub fn normalize_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let normalized = p.replace('/', "\\");
        let bytes = normalized.as_bytes();
        if bytes.len() >= 3 && bytes[1] == b':' && bytes[2..].iter().all(|b| *b == b'\\') {
            return normalized[..3].to_string();
        }
        normalized.trim_end_matches('\\').to_string()
    }
    #[cfg(not(windows))]
    {
        if p.bytes().all(|b| b == b'/') && !p.is_empty() {
            return "/".to_string();
        }
        p.trim_end_matches('/').to_string()
    }
}

/// 比较用 key（镜像 types.ts::pathKeyOf）。
pub(crate) fn path_key(p: &str) -> String {
    let normalized = normalize_path(p);
    if cfg!(windows) { normalized.to_lowercase() } else { normalized }
}

/// 一个视频只归属路径上最具体的已导入目录；路径分隔符防止 Media2 匹配 Media。
fn closest_folder(conn: &Connection, video_path: &str, excluded_id: Option<i64>) -> SqlResult<Option<i64>> {
    let key = path_key(video_path);
    let separator = if cfg!(windows) { "\\" } else { "/" };
    let mut stmt = conn.prepare(
        "SELECT id FROM image_folders
         WHERE (?3 IS NULL OR id != ?3)
           AND substr(?1, 1, length(path_key)) = path_key
           AND (substr(path_key, -1) = ?2 OR substr(?1, length(path_key) + 1, 1) = ?2)
         ORDER BY length(path_key) DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![key, separator, excluded_id])?;
    rows.next()?.map(|row| row.get(0)).transpose()
}

/// 修复旧版本导入父目录时覆盖子目录归属的记录，不改变单独导入的视频。
fn reconcile_folder_ownership(conn: &Connection) -> SqlResult<()> {
    let mut stmt = conn.prepare("SELECT id, path, folder_id FROM videos WHERE folder_id IS NOT NULL")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))?;
    for row in rows {
        let (id, path, folder_id) = row?;
        if let Some(closest) = closest_folder(conn, &path, None)? {
            if closest != folder_id {
                conn.execute("UPDATE videos SET folder_id = ? WHERE id = ?", rusqlite::params![closest, id])?;
            }
        }
    }
    Ok(())
}

/// 当前 Unix 毫秒时间戳，用于数据库字段。
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
        if pinned && !existing.pinned {
            conn.execute("UPDATE image_folders SET pinned = 1, enabled = 1 WHERE id = ?", [existing.id])?;
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

/// 一次性导入也保留目录身份，但不启动文件监视。已有监视目录保持原设置。
pub fn insert_imported_folder(conn: &Connection, dir_path: &str, recursive: bool) -> SqlResult<WatchedFolder> {
    if let Some(existing) = find_folder_by_path(conn, dir_path)? {
        return Ok(existing);
    }
    let folder = insert_folder(conn, dir_path, false, recursive)?;
    set_folder_enabled(conn, folder.id, false)?;
    get_folder(conn, folder.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
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

/// 删除文件夹前列出其关联视频；不按路径猜测，避免误删单独导入的文件。
pub fn folder_video_paths(conn: &Connection, folder_id: i64) -> SqlResult<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, path FROM videos WHERE folder_id = ? ORDER BY id")?;
    let rows = stmt.query_map([folder_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// 移除导入目录时，把仍被其他导入目录覆盖的视频转给最具体的剩余目录。
/// 返回真正需要从库中删除的视频；磁盘文件始终不受影响。
pub fn detach_folder_videos(conn: &Connection, folder_id: i64) -> SqlResult<Vec<i64>> {
    let mut removed = Vec::new();
    for (id, path) in folder_video_paths(conn, folder_id)? {
        if let Some(other_id) = closest_folder(conn, &path, Some(folder_id))? {
            conn.execute("UPDATE videos SET folder_id = ? WHERE id = ?", rusqlite::params![other_id, id])?;
        } else {
            removed.push(id);
        }
    }
    Ok(removed)
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
    pub uniform_interval_seconds: i64,
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
        uniform_interval_seconds: 15,
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
        Some("duration") => "duration",
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

    let order_by = if q.sort.as_deref() == Some("duration") {
        format!("duration IS NULL ASC, duration {order}, id {order}")
    } else {
        format!("{sort} {order}, id {order}")
    };
    let select_sql = format!(
        "SELECT {} FROM videos {} ORDER BY {} LIMIT ? OFFSET ?",
        VIDEO_COLUMNS, where_sql, order_by
    );
    params.push(Box::new(limit));
    params.push(Box::new(offset));
    let mut stmt = conn.prepare(&select_sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter().map(|b| b.as_ref())), row_to_video)?;
    let mut items = Vec::new();
    for r in rows {
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
            "uniformIntervalSeconds" => {
                if let Ok(v) = serde_json::from_str::<i64>(&value) {
                    s.uniform_interval_seconds = v;
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
    clamp_settings(&mut s);
    Ok(s)
}

/// 把设置收敛到安全范围。界面本来就有上下限，但后端不能依赖调用方：
/// 非法时间间隔转 usize 会导致过密采样，并发数过大则会拉起同样多的索引线程。
fn clamp_settings(s: &mut AppSettings) {
    s.uniform_interval_seconds = s.uniform_interval_seconds.clamp(1, 3600);
    s.concurrency = s.concurrency.clamp(1, 8);
    s.min_hash_score = if s.min_hash_score.is_finite() {
        s.min_hash_score.clamp(0.0, 1.0)
    } else {
        default_settings().min_hash_score
    };
    s.max_results = s.max_results.clamp(1, 200);
    s.await_write_ms = s.await_write_ms.clamp(0, 60_000);
    if s.sampling_mode != "scene" {
        s.sampling_mode = "uniform".to_string();
    }
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

/* ------------------------------------------------------------------ */
/* 设置写入 / 重置                                                    */
/* ------------------------------------------------------------------ */

/// library.updateSettings 的入参（全字段可选，camelCase 镜像 AppSettings）。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub uniform_interval_seconds: Option<i64>,
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
    // 写入前先收敛到安全范围，避免非 UI 调用方写入过密采样或上千并发。
    let default_score = default_settings().min_hash_score;
    let candidates: Vec<(String, Option<String>)> = vec![
        (
            "uniformIntervalSeconds".into(),
            patch.uniform_interval_seconds.map(|v| v.clamp(1, 3600).to_string()),
        ),
        (
            "concurrency".into(),
            patch.concurrency.map(|v| v.clamp(1, 8).to_string()),
        ),
        (
            "minHashScore".into(),
            patch.min_hash_score.map(|v| {
                if v.is_finite() {
                    v.clamp(0.0, 1.0)
                } else {
                    default_score
                }
                .to_string()
            }),
        ),
        (
            "maxResults".into(),
            patch.max_results.map(|v| v.clamp(1, 200).to_string()),
        ),
        (
            "awaitWriteMs".into(),
            patch.await_write_ms.map(|v| v.clamp(0, 60_000).to_string()),
        ),
        ("pruneOnDelete".into(), patch.prune_on_delete.map(|v| v.to_string())),
        (
            "samplingMode".into(),
            patch.sampling_mode.as_deref().map(|mode| {
                if mode == "scene" { "scene" } else { "uniform" }.to_string()
            }),
        ),
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
    let folder_id = if input.folder_id.is_some() {
        closest_folder(conn, &normalized, None)?.or(input.folder_id)
    } else {
        None
    };

    if let Some(existing) = find_folder_video_by_key(conn, &key)? {
        // 既有：比较关键字段判断是否变化（内容变化 → 重抽）
        let changed = existing.size != input.size
            || existing.mtime_ms != input.mtime_ms
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
                folder_id.or(existing.folder_id),
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
                folder_id,
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

/// 批量置为 pending。重建索引/启动恢复一次入队几千个视频时，逐条 UPDATE
/// 会让每次写都要拿一次写锁；这里按 SQLite 的参数上限分块，一条 SQL 改一批。
pub fn set_videos_status_pending(conn: &Connection, ids: &[i64]) -> SqlResult<()> {
    for chunk in ids.chunks(500) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
        let sql = format!(
            "UPDATE videos SET status = 'pending', error = NULL WHERE id IN ({})",
            placeholders.join(",")
        );
        let params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        conn.execute(&sql, params.as_slice())?;
    }
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

/// 原子清除一个视频的帧和续传元数据，避免崩溃后旧时间点指向空帧表。
pub fn reset_frame_index_progress(conn: &mut Connection, video_id: i64) -> SqlResult<usize> {
    let tx = conn.transaction()?;
    let removed = tx.execute("DELETE FROM frames WHERE video_id = ?", [video_id])?;
    tx.execute(
        "UPDATE videos SET processed_timestamps = '[]', frame_count = 0 WHERE id = ?",
        [video_id],
    )?;
    tx.commit()?;
    Ok(removed)
}

/// 旧版本可能已写入续传时间点却没有对应帧；只在帧索引形成完整前缀时允许续传。
pub fn frame_prefix_is_complete(conn: &Connection, video_id: i64, prefix_len: usize) -> SqlResult<bool> {
    if prefix_len == 0 {
        return Ok(true);
    }
    let (count, first, last): (i64, Option<i64>, Option<i64>) = conn.query_row(
        "SELECT COUNT(*), MIN(frame_index), MAX(frame_index) FROM frames WHERE video_id = ?",
        [video_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(count == prefix_len as i64 && first == Some(0) && last == Some(prefix_len as i64 - 1))
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
    let updated = conn.execute(
        "UPDATE videos SET status = 'ready', indexed_at = ?, frame_count = ?, thumbnail = ? WHERE id = ?",
        rusqlite::params![now_ms(), frames, thumbnail, id],
    )?;
    if updated != 1 {
        return Err(SqlError::QueryReturnedNoRows);
    }
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

/// 一批帧指纹和对应续传进度必须同时落库，写入失败时一起回滚。
pub fn commit_frame_batch(
    conn: &mut Connection,
    video_id: i64,
    frames: &[NewFrame],
    processed_timestamps: &[i64],
    elapsed_ms: i64,
) -> SqlResult<()> {
    let processed_json = serde_json::to_string(processed_timestamps)
        .map_err(|error| SqlError::ToSqlConversionFailure(Box::new(error)))?;
    let tx = conn.transaction()?;
    {
        let mut insert = tx.prepare_cached(
            "INSERT OR REPLACE INTO frames (video_id, frame_index, time_ms, dhash, struct, color, spatial) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )?;
        for f in frames {
            insert.execute(rusqlite::params![
                video_id,
                f.frame_index,
                f.time_ms,
                f.dhash,
                f.struct_hash,
                f.color,
                f.spatial
            ])?;
        }
    }
    let updated = tx.execute(
        "UPDATE videos SET processed_timestamps = ?, processed_ms = processed_ms + ?, status = 'indexing', error = NULL WHERE id = ?",
        rusqlite::params![processed_json, elapsed_ms, video_id],
    )?;
    if updated != 1 {
        return Err(SqlError::QueryReturnedNoRows);
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
    load_frame_matrix_query(
        conn,
        "SELECT video_id, dhash, struct, color, spatial, frame_index, time_ms \
         FROM frames ORDER BY video_id, frame_index",
        [],
    )
}

/// 只读出一个视频的帧指纹，供索引完成后的内存索引增量更新使用。
pub fn load_video_frame_matrix(conn: &Connection, video_id: i64) -> SqlResult<FrameMatrix> {
    load_frame_matrix_query(
        conn,
        "SELECT video_id, dhash, struct, color, spatial, frame_index, time_ms \
         FROM frames WHERE video_id = ? ORDER BY frame_index",
        [video_id],
    )
}

fn load_frame_matrix_query<P>(conn: &Connection, sql: &str, params: P) -> SqlResult<FrameMatrix>
where
    P: rusqlite::Params,
{
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |row| {
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
        let separator = std::path::MAIN_SEPARATOR;
        if directory.ends_with(separator) {
            !suffix.is_empty()
        } else {
            suffix.starts_with(separator)
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
    fn duration_sort_keeps_unknown_lengths_last_in_both_directions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (id, duration) in [(1, None), (2, Some(10.0)), (3, Some(10.0)), (4, Some(20.0))] {
            conn.execute(
                "INSERT INTO videos (id, path, path_key, name, dir, ext, duration, added_at) \
                 VALUES (?1, ?2, ?2, ?2, 'library', 'mp4', ?3, 1)",
                rusqlite::params![id, format!("video{id}"), duration],
            )
            .unwrap();
        }

        for (order, expected) in [("asc", [2, 3, 4, 1]), ("desc", [4, 3, 2, 1])] {
            let query = VideoQuery {
                sort: Some("duration".into()),
                order: Some(order.into()),
                ..Default::default()
            };
            let ids: Vec<i64> = list_videos(&conn, &query)
                .unwrap()
                .items
                .into_iter()
                .map(|video| video.id)
                .collect();
            assert_eq!(ids, expected);
        }
    }

    #[test]
    fn database_connection_configuration_enforces_constraints_and_waits_for_locks() {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        let foreign_keys: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        let busy_timeout: i64 = conn
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        assert_eq!(busy_timeout, 5_000);
    }

    #[test]
    fn settings_are_clamped_to_safe_ranges() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let patch = SettingsPatch {
            uniform_interval_seconds: Some(-5),
            concurrency: Some(1_000),
            min_hash_score: Some(2.5),
            max_results: Some(100_000),
            await_write_ms: Some(-1),
            sampling_mode: Some("bogus".to_string()),
            ..Default::default()
        };
        let settings = update_settings(&mut conn, &patch).unwrap();
        assert_eq!(settings.uniform_interval_seconds, 1);
        assert_eq!(settings.concurrency, 8);
        assert_eq!(settings.min_hash_score, 1.0);
        assert_eq!(settings.max_results, 200);
        assert_eq!(settings.await_write_ms, 0);
        assert_eq!(settings.sampling_mode, "uniform");
    }

    #[test]
    fn resetting_frame_progress_clears_frames_and_resume_markers_together() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, processed_timestamps TEXT, frame_count INTEGER);\
             CREATE TABLE frames (video_id INTEGER, frame_index INTEGER);\
             INSERT INTO videos VALUES (1, '[1000]', 1);\
             INSERT INTO frames VALUES (1, 0);",
        ).unwrap();
        assert_eq!(reset_frame_index_progress(&mut conn, 1).unwrap(), 1);
        let (processed, count): (String, i64) = conn.query_row(
            "SELECT processed_timestamps, frame_count FROM videos WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        let frames: i64 = conn.query_row("SELECT COUNT(*) FROM frames WHERE video_id = 1", [], |row| row.get(0)).unwrap();
        assert_eq!((processed.as_str(), count, frames), ("[]", 0, 0));
        assert_eq!(reset_frame_index_progress(&mut conn, 1).unwrap(), 0);
    }

    #[test]
    fn failed_frame_batch_keeps_previous_frames_and_resume_progress() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE videos (id INTEGER PRIMARY KEY, processed_timestamps TEXT, processed_ms INTEGER, status TEXT, error TEXT);\
             CREATE TABLE frames (video_id INTEGER, frame_index INTEGER, time_ms INTEGER, dhash INTEGER, struct BLOB, color BLOB, spatial BLOB);\
             INSERT INTO videos VALUES (1, '[]', 0, 'pending', NULL);",
        ).unwrap();
        let frame = |frame_index, time_ms| NewFrame {
            dhash: 1,
            struct_hash: vec![2],
            color: vec![3],
            spatial: vec![4],
            frame_index,
            time_ms,
        };
        commit_frame_batch(&mut conn, 1, &[frame(0, 1000)], &[1000], 10).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_progress BEFORE UPDATE OF processed_timestamps ON videos \
             BEGIN SELECT RAISE(ABORT, 'progress write failed'); END;",
        ).unwrap();
        assert!(commit_frame_batch(&mut conn, 1, &[frame(1, 2000)], &[1000, 2000], 20).is_err());
        let (progress, elapsed, status): (String, i64, String) = conn.query_row(
            "SELECT processed_timestamps, processed_ms, status FROM videos WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        let indices: Vec<i64> = conn.prepare("SELECT frame_index FROM frames ORDER BY frame_index")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<SqlResult<_>>()
            .unwrap();
        assert_eq!((progress.as_str(), elapsed, status.as_str()), ("[1000]", 10, "indexing"));
        assert_eq!(indices, vec![0]);
        assert!(frame_prefix_is_complete(&conn, 1, 1).unwrap());
        assert!(!frame_prefix_is_complete(&conn, 1, 2).unwrap());
        conn.execute_batch("INSERT INTO frames VALUES (1, 2, 3000, 1, X'00', X'00', X'00');").unwrap();
        assert!(!frame_prefix_is_complete(&conn, 1, 1).unwrap());
    }

    #[test]
    fn interrupted_index_reopens_with_committed_prefix_and_finishes() {
        let root = std::env::temp_dir().join(format!(
            "whichvideo-index-restart-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("library.db");
        let frame = |frame_index, time_ms| NewFrame {
            dhash: frame_index + 1,
            struct_hash: vec![2; 128],
            color: vec![3; 48],
            spatial: vec![4; 64],
            frame_index,
            time_ms,
        };
        let id = {
            let mut conn = Connection::open(&path).unwrap();
            configure_connection(&conn).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            let (video, _, _) = upsert_video(&conn, &UpsertVideoInput {
                path: root.join("video.mp4").to_string_lossy().into_owned(),
                size: 100, mtime_ms: 1, duration: Some(3.0),
                width: Some(320), height: Some(180), video_codec: Some("mpeg4".into()),
                folder_id: None, file_hash: None,
            }).unwrap();
            commit_frame_batch(&mut conn, video.id, &[frame(0, 1000)], &[1000], 10).unwrap();
            video.id
        };
        {
            let mut conn = Connection::open(&path).unwrap();
            configure_connection(&conn).unwrap();
            let pending = list_pending_videos(&conn).unwrap();
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].id, id);
            assert_eq!(pending[0].processed_timestamps, vec![1000]);
            assert!(frame_prefix_is_complete(&conn, id, 1).unwrap());
            commit_frame_batch(&mut conn, id, &[frame(1, 2000)], &[1000, 2000], 20).unwrap();
            set_ready_with_thumbnail(&conn, id, None).unwrap();
            assert!(list_pending_videos(&conn).unwrap().is_empty());
            let video = get_video(&conn, id).unwrap().unwrap();
            assert_eq!(video.status, "ready");
            assert_eq!(video.frame_count, 2);
            assert_eq!(video.processed_timestamps, vec![1000, 2000]);
            let matrix = load_video_frame_matrix(&conn, id).unwrap();
            assert_eq!(matrix.video_ids, vec![id, id]);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn path_normalization_preserves_windows_drive_roots() {
        assert_eq!(normalize_path("C:\\"), "C:\\");
        assert_eq!(normalize_path("D:////"), "D:\\");
        assert_eq!(normalize_path("C:\\Media\\\\"), "C:\\Media");
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_paths_keep_case_and_root() {
        assert_eq!(normalize_path("///"), "/");
        assert_eq!(normalize_path("/Media/Films///"), "/Media/Films");
        assert_ne!(path_key("/Media/Film.mp4"), path_key("/media/Film.mp4"));
        assert!(path_is_under("/Media/Films/a.mp4", "/Media"));
        assert!(!path_is_under("/Media2/a.mp4", "/Media"));
    }

    #[test]
    fn one_time_folder_is_recorded_without_watching_and_can_be_promoted() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let imported = insert_imported_folder(&conn, "C:\\Media", true).unwrap();
        assert!(!imported.pinned);
        assert!(!imported.enabled);
        assert_eq!(insert_imported_folder(&conn, "C:\\Media", true).unwrap().id, imported.id);

        let watched = insert_folder(&conn, "C:\\Media", true, true).unwrap();
        assert_eq!(watched.id, imported.id);
        assert!(watched.pinned && watched.enabled);
        set_folder_enabled(&conn, watched.id, false).unwrap();
        // 手动重扫不得把用户暂停的监听重新打开。
        assert!(!insert_folder(&conn, "C:\\Media", true, true).unwrap().enabled);
    }

    #[test]
    fn folder_removal_targets_only_linked_videos() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let folder = insert_imported_folder(&conn, "C:\\Media", true).unwrap();
        for (path, folder_id) in [
            ("C:\\Media\\linked.mp4", Some(folder.id)),
            ("C:\\Media\\direct.mp4", None),
        ] {
            upsert_video(&conn, &UpsertVideoInput {
                path: path.to_string(), size: 1, mtime_ms: 1,
                duration: Some(1.0), width: Some(1), height: Some(1),
                video_codec: None, folder_id, file_hash: None,
            }).unwrap();
        }
        let linked = folder_video_paths(&conn, folder.id).unwrap();
        assert_eq!(linked.len(), 1);
        assert!(linked[0].1.ends_with("linked.mp4"));
    }

    #[test]
    fn overlapping_imports_keep_the_nearest_folder_and_transfer_on_removal() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let (parent_path, child_path, other_path) = if cfg!(windows) {
            ("C:\\Media", "C:\\Media\\Series\\A", "C:\\Media2")
        } else {
            ("/Media", "/Media/Series/A", "/Media2")
        };
        let child = insert_imported_folder(&conn, child_path, true).unwrap();
        let separator = if cfg!(windows) { "\\" } else { "/" };
        let path = format!("{child_path}{separator}episode.mp4");
        let input = |folder_id| UpsertVideoInput {
            path: path.clone(), size: 1, mtime_ms: 1, duration: Some(1.0),
            width: None, height: None, video_codec: None, folder_id, file_hash: None,
        };
        let (original, _, _) = upsert_video(&conn, &input(Some(child.id))).unwrap();
        let parent = insert_imported_folder(&conn, parent_path, true).unwrap();
        let (reimported, created, changed) = upsert_video(&conn, &input(Some(parent.id))).unwrap();
        assert_eq!(reimported.id, original.id);
        assert!(!created && !changed);
        assert_eq!(reimported.folder_id, Some(child.id));
        assert!(detach_folder_videos(&conn, parent.id).unwrap().is_empty());

        let other = insert_imported_folder(&conn, other_path, true).unwrap();
        assert_eq!(closest_folder(&conn, &path, Some(child.id)).unwrap(), Some(parent.id));
        assert_ne!(closest_folder(&conn, &path, None).unwrap(), Some(other.id));
        assert!(detach_folder_videos(&conn, child.id).unwrap().is_empty());
        assert_eq!(get_video(&conn, original.id).unwrap().unwrap().folder_id, Some(parent.id));
        remove_folder(&conn, child.id).unwrap();
        assert_eq!(detach_folder_videos(&conn, parent.id).unwrap(), vec![original.id]);
    }

    #[test]
    fn reimport_detects_subsecond_file_changes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let path = if cfg!(windows) { "C:\\Media\\clip.mp4" } else { "/Media/clip.mp4" };
        let mut input = UpsertVideoInput {
            path: path.to_string(), size: 100, mtime_ms: 1_000,
            duration: Some(10.0), width: Some(1920), height: Some(1080),
            video_codec: Some("h264".to_string()), folder_id: None, file_hash: None,
        };
        let (_, created, changed) = upsert_video(&conn, &input).unwrap();
        assert!(created && changed);
        input.mtime_ms += 250;
        let (_, created, changed) = upsert_video(&conn, &input).unwrap();
        assert!(!created && changed);
    }

    #[test]
    fn existing_overlapping_folders_recover_video_ownership() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let (parent_path, child_path, separator) = if cfg!(windows) {
            ("C:\\Media", "C:\\Media\\Series", "\\")
        } else {
            ("/Media", "/Media/Series", "/")
        };
        let parent = insert_imported_folder(&conn, parent_path, true).unwrap();
        let child = insert_imported_folder(&conn, child_path, true).unwrap();
        let path = format!("{child_path}{separator}episode.mp4");
        let (video, _, _) = upsert_video(&conn, &UpsertVideoInput {
            path, size: 1, mtime_ms: 1, duration: None, width: None,
            height: None, video_codec: None, folder_id: Some(child.id), file_hash: None,
        }).unwrap();
        // 模拟旧版数据库中被父目录重新扫描覆盖的归属。
        conn.execute("UPDATE videos SET folder_id = ? WHERE id = ?", rusqlite::params![parent.id, video.id]).unwrap();
        reconcile_folder_ownership(&conn).unwrap();
        assert_eq!(get_video(&conn, video.id).unwrap().unwrap().folder_id, Some(child.id));
    }

    #[cfg(windows)]
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

    #[cfg(not(windows))]
    #[test]
    fn removing_unix_directory_respects_case_and_boundaries() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for path in ["/Media/a.mp4", "/Media2/b.mp4", "/media/c.mp4", "/Media/Sub/d.mp4"] {
            upsert_video(&conn, &UpsertVideoInput {
                path: path.to_string(), size: 1, mtime_ms: 1, duration: None,
                width: None, height: None, video_codec: None, folder_id: None, file_hash: None,
            }).unwrap();
        }
        assert_eq!(remove_videos_under(&conn, "/Media").unwrap(), vec![1, 4]);
        assert_eq!(normalize_path("/Media/a\\b.mp4"), "/Media/a\\b.mp4");
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

        let one_video = load_video_frame_matrix(&conn, 22).unwrap();
        assert_eq!(one_video.video_ids, vec![22]);
        assert_eq!(one_video.buffer.len(), framepack::FRAME_STRIDE);

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
