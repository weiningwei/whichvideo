use rusqlite::{Connection, Result as SqlResult};
use serde::Serialize;
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
  processed_ms INTEGER NOT NULL DEFAULT 0
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
    conn.exec_batch(SCHEMA)?;
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

pub fn list_folders(conn: &Connection) -> SqlResult<Vec<WatchedFolder>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, path_key, name, pinned, enabled, recursive, watch_state, message, added_at, last_scan_at
         FROM image_folders ORDER BY pinned DESC, added_at ASC",
    )?;
    let folders = stmt.query_map([], |row| {
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
    })?;
    let mut out = Vec::new();
    for f in folders {
        out.push(f?);
    }
    Ok(out)
}
