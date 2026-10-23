//! 本地诊断包：只导出白名单中的运行环境与汇总状态，不读取日志、视频或路径清单。

use crate::db;
use crate::media;
use crate::paths;
use crate::state::AppState;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

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
    has_last_error: bool,
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
        let conn = state.db()?;
        (
            true,
            db::stats(&conn).ok(),
            db::get_settings(&conn).ok(),
            db::list_folders(&conn).unwrap_or_default(),
        )
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
            has_last_error: indexer.last_error.is_some(),
        }
    };
    let tools = media::tools_status();
    let data_dir = paths::data_dir_info(tools.ready);
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
    write_zip(output, &report_json)
}

fn write_zip(output: &Path, report_json: &[u8]) -> Result<(), String> {
    let file = File::create(output).map_err(|e| format!("无法创建诊断包：{e}"))?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    archive
        .start_file("report.json", options)
        .map_err(|e| format!("无法写入诊断报告：{e}"))?;
    archive
        .write_all(report_json)
        .map_err(|e| format!("无法写入诊断报告：{e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn diagnostic_zip_contains_only_report() {
        let path = std::env::temp_dir().join(format!("whichvideo-diagnostics-{}.zip", db::now_ms()));
        write_zip(&path, br#"{"schemaVersion":1}"#).unwrap();
        let file = File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut report = String::new();
        archive.by_name("report.json").unwrap().read_to_string(&mut report).unwrap();
        assert_eq!(report, r#"{"schemaVersion":1}"#);
        assert!(archive.by_name("whichvideo.log.txt").is_err());
        std::fs::remove_file(path).unwrap();
    }
}
