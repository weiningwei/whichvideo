//! 数据目录与其中全部落盘路径的唯一来源。
//!
//! 所有模块只通过这里拼接路径，避免文件名散落在各模块。布局（程序同级
//! `data`，`WHICHVIDEO_DATA_DIR` 可覆盖根目录）：
//!
//! ```text
//! data/
//! ├─ db/whichvideo.db        索引库（SQLite，运行时另有 -wal / -shm）
//! ├─ logs/whichvideo.log     运行日志（超过上限轮转为 .1）
//! ├─ frames/<id>/<ms>.jpg    索引帧图（开启「保留索引帧」时才有）
//! └─ session/                WebView 用户数据（Windows WebView2 / Linux WebKitGTK）
//! ```

use serde::Serialize;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 索引库文件名。
pub const DB_FILE: &str = "whichvideo.db";
/// 日志文件名（轮转后为 .1）。
pub const LOG_FILE: &str = "whichvideo.log";

const DB_DIR: &str = "db";
const LOGS_DIR: &str = "logs";
const FRAMES_DIR: &str = "frames";
const SESSION_DIR: &str = "session";

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

fn installation_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    if let Some(app_image) = env::var_os("APPIMAGE") {
        if let Some(parent) = Path::new(&app_image).parent() {
            return parent.to_path_buf();
        }
    }
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    if exe_dir.file_name().is_some_and(|name| name == "MacOS")
        && exe_dir.parent().and_then(Path::file_name).is_some_and(|name| name == "Contents")
    {
        if let Some(parent) = exe_dir.parent().and_then(Path::parent).and_then(Path::parent) {
            return parent.to_path_buf();
        }
    }
    exe_dir
}

/// 在 Tauri setup 阶段调用一次，之后所有模块共享同一个最终目录。
/// 只使用程序同级 data 目录或 WHICHVIDEO_DATA_DIR 覆盖，不回退用户目录。
pub fn initialize() -> io::Result<DataDirResolution> {
    let exe_dir = installation_dir();
    let resolution = resolve_data_dir(env::var("WHICHVIDEO_DATA_DIR").ok(), &exe_dir);
    fs::create_dir_all(&resolution.dir)?;
    let _ = DATA_DIR.set(resolution.clone());
    Ok(resolution)
}

/// 数据根目录。
pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .map(|r| r.dir.clone())
        .unwrap_or_else(|| PathBuf::from("data"))
}

/// 当前解析结果；尚未初始化时按安装位置给出。
pub fn resolution() -> DataDirResolution {
    DATA_DIR.get().cloned().unwrap_or_else(|| DataDirResolution {
        dir: data_dir(),
        source: "install",
    })
}

/// 索引库目录（SQLite 的 -wal / -shm 也落在同一层）。
pub fn db_dir() -> PathBuf {
    data_dir().join(DB_DIR)
}

/// 索引库文件。
pub fn db_path() -> PathBuf {
    db_dir().join(DB_FILE)
}

/// 日志目录。
pub fn logs_dir() -> PathBuf {
    data_dir().join(LOGS_DIR)
}

/// 当前日志文件。
pub fn log_path() -> PathBuf {
    logs_dir().join(LOG_FILE)
}

/// 索引帧图根目录。
pub fn frames_dir() -> PathBuf {
    data_dir().join(FRAMES_DIR)
}

/// 单个视频的帧图目录。
pub fn video_frames_dir(video_id: i64) -> PathBuf {
    frames_dir().join(video_id.to_string())
}

/// WebView 用户数据目录。
pub fn webview_dir() -> PathBuf {
    data_dir().join(SESSION_DIR)
}

/// 与 src/shared/types.ts 的 DataDirInfo 对齐。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    pub dir: String,
    pub source: String,
    pub tools_ready: bool,
}

/// 解析数据目录并附带工具可用性（library_data_dir 命令与诊断包共用）。
pub fn data_dir_info(tools_ready: bool) -> DataDirInfo {
    let resolution = resolution();
    DataDirInfo {
        dir: resolution.dir.to_string_lossy().to_string(),
        source: resolution.source.to_string(),
        tools_ready,
    }
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
}
