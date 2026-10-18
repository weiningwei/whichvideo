//! 本地诊断包：只导出运行环境、汇总状态和脱敏后的日志，不包含视频、缩略图或路径清单。

use crate::db;
use crate::logger;
use crate::media;
use crate::state::AppState;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::Path;
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const LOG_TAIL_BYTES: usize = 64 * 1024;
const LOG_TAIL_LINES: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticReport {
    schema_version: u8,
    generated_at_ms: i64,
    app: AppInfo,
    runtime: RuntimeInfo,
    data_directory_source: String,
    library: LibraryInfo,
    indexer: IndexerInfo,
    media_tools: MediaToolsInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    os: &'static str,
    architecture: &'static str,
    family: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryInfo {
    database_available: bool,
    stats: Option<db::LibraryStats>,
    settings: Option<db::AppSettings>,
    folders: FolderSummary,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct FolderSummary {
    total: usize,
    enabled: usize,
    recursive: usize,
    states: BTreeMap<String, usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexerInfo {
    running: bool,
    active: i64,
    queued: i64,
    total: i64,
    done: i64,
    failed: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaToolsInfo {
    ready: bool,
    source: String,
}

/// 写入可安全分享的 ZIP 诊断包。调用方负责让用户选择目标文件。
pub fn write_archive(app: &AppHandle, output: &Path) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (database_available, stats, settings, folders) = {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(conn) => (
                true,
                db::stats(conn).ok(),
                db::get_settings(conn).ok(),
                db::list_folders(conn).unwrap_or_default(),
            ),
            None => (false, None, None, Vec::new()),
        }
    };
    let folder_summary = summarize_folders(&folders);
    let indexer = {
        let indexer = state.indexer.lock().map_err(|e| e.to_string())?.status();
        IndexerInfo {
            running: indexer.running,
            active: indexer.active,
            queued: indexer.queued,
            total: indexer.total,
            done: indexer.done,
            failed: indexer.failed,
            started_at: indexer.started_at,
            finished_at: indexer.finished_at,
            last_error: indexer.last_error.map(|error| redact_text(&error)),
        }
    };
    let tools = media::tools_status();
    let data_dir = db::data_dir_info(tools.ready);
    let report = DiagnosticReport {
        schema_version: 1,
        generated_at_ms: db::now_ms(),
        app: AppInfo {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
        },
        runtime: RuntimeInfo {
            os: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            family: std::env::consts::FAMILY,
        },
        data_directory_source: data_dir.source,
        library: LibraryInfo {
            database_available,
            stats,
            settings,
            folders: folder_summary,
        },
        indexer,
        media_tools: MediaToolsInfo {
            ready: tools.ready,
            source: tools.source,
        },
    };
    let report_json = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
    let log_tail = read_redacted_log_tail();

    write_zip(output, &report_json, &log_tail)
}

fn write_zip(output: &Path, report_json: &[u8], log_tail: &str) -> Result<(), String> {
    let file = File::create(output).map_err(|e| format!("无法创建诊断包：{e}"))?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    archive
        .start_file("report.json", options)
        .map_err(|e| format!("无法写入诊断报告：{e}"))?;
    archive
        .write_all(report_json)
        .map_err(|e| format!("无法写入诊断报告：{e}"))?;
    if !log_tail.is_empty() {
        archive
            .start_file("whichvideo.log.txt", options)
            .map_err(|e| format!("无法写入诊断日志：{e}"))?;
        archive
            .write_all(log_tail.as_bytes())
            .map_err(|e| format!("无法写入诊断日志：{e}"))?;
    }
    archive
        .finish()
        .map_err(|e| format!("无法完成诊断包：{e}"))?;
    Ok(())
}

fn summarize_folders(folders: &[db::WatchedFolder]) -> FolderSummary {
    let mut summary = FolderSummary {
        total: folders.len(),
        ..Default::default()
    };
    for folder in folders {
        summary.enabled += usize::from(folder.enabled);
        summary.recursive += usize::from(folder.recursive);
        *summary.states.entry(folder.watch_state.clone()).or_default() += 1;
    }
    summary
}

fn read_redacted_log_tail() -> String {
    let Some(path) = logger::path() else {
        return String::new();
    };
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len() as usize) else {
        return String::new();
    };
    let skip = size.saturating_sub(LOG_TAIL_BYTES);
    if skip > 0 && file.seek(std::io::SeekFrom::Start(skip as u64)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    text.lines()
        .rev()
        .take(LOG_TAIL_LINES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(redact_text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// 日志中可能有导入文件、工具或数据目录的绝对路径；宁可隐藏整行，也不冒险保留带空格的路径片段。
fn redact_text(text: &str) -> String {
    if text_contains_path(text) {
        "[路径已隐藏]".to_string()
    } else {
        text.to_string()
    }
}

fn text_contains_path(text: &str) -> bool {
    text.contains(":\\") || text.contains("\\\\") || text.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_windows_unc_and_unix_paths_from_logs() {
        for text in [
            "失败：C:\\My Videos\\sample.mp4",
            "失败：\\\\server\\share\\clip.mkv",
            "失败：/home/user/movie.mov",
        ] {
            assert_eq!(redact_text(text), "[路径已隐藏]");
        }
    }

    #[test]
    fn diagnostic_zip_contains_report_and_redacted_log() {
        let path = std::env::temp_dir().join(format!("whichvideo-diagnostics-{}.zip", db::now_ms()));
        write_zip(&path, br#"{"schemaVersion":1}"#, "[路径已隐藏]").unwrap();
        let file = File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut report = String::new();
        archive.by_name("report.json").unwrap().read_to_string(&mut report).unwrap();
        assert_eq!(report, r#"{"schemaVersion":1}"#);
        let mut log = String::new();
        archive
            .by_name("whichvideo.log.txt")
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert_eq!(log, "[路径已隐藏]");
        std::fs::remove_file(path).unwrap();
    }
}
