use crate::db;
use crate::events;
use crate::framepack;
use crate::frames_store;
use crate::hash;
use crate::indexer;
use crate::logger;
use crate::media;
use crate::platform_open;
use crate::process_ext::CommandNoWindow;
use crate::search;
use crate::state::AppState;
use crate::watcher;
use base64::Engine;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// 库统计：视频/帧/文件夹计数。复用现有 whichvideo.db。
#[tauri::command]
pub fn library_stats(state: State<AppState>) -> Result<db::LibraryStats, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::stats(conn).map_err(|e| e.to_string())
}

/// 索引器实时状态（取自共享受保护的状态）。
#[tauri::command]
pub fn library_status(state: State<AppState>) -> Result<db::IndexerStatus, String> {
    let idx = state.indexer.lock().map_err(|e| e.to_string())?;
    Ok(idx.status())
}

/// 监听文件夹列表。
#[tauri::command]
pub fn folders_list(state: State<AppState>) -> Result<Vec<db::WatchedFolder>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::list_folders(conn).map_err(|e| e.to_string())
}

/// 登记一个被监听的文件夹，并立即扫描其中已有的视频。
#[tauri::command]
pub fn folders_add_path(
    app: AppHandle,
    dir_path: String,
) -> Result<db::WatchedFolder, String> {
    let (_, folder_id) = indexer::import_folder(app.clone(), dir_path, true, true)?;
    watcher::sync_all(&app)?;
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::get_folder(conn, folder_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "文件夹登记后无法读取".to_string())
}

/// 通过系统文件夹选择对话框登记监听目录（多选退化为逐个）。
#[tauri::command]
pub async fn folders_add_dialog(app: AppHandle) -> Result<Vec<db::WatchedFolder>, String> {
    let Some(picked) = native_folder_dialog(&app, "选择要加入资料库并持续监视的文件夹") else {
        logger::log("[import] 监视文件夹选择已取消");
        return Ok(Vec::new());
    };
    logger::log(&format!("[import] 已选择 {} 个监视文件夹", picked.len()));
    let mut folders = Vec::new();
    for dir in picked {
        let (_, id) = indexer::import_folder(app.clone(), dir, true, true)?;
        let state = app.state::<AppState>();
        let g = state.db.lock().map_err(|e| e.to_string())?;
        let c = g.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        let folder = db::get_folder(c, id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "文件夹登记后无法读取".to_string())?;
        folders.push(folder);
    }
    watcher::sync_all(&app)?;
    logger::log(&format!("[import] 已登记 {} 个监视文件夹", folders.len()));
    Ok(folders)
}

/// 从索引库移除文件夹及其关联视频；磁盘文件不受影响。
#[tauri::command]
pub fn folders_remove(app: AppHandle, folder_id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::get_folder(conn, folder_id)
        .map_err(|e| e.to_string())?
        .ok_or("文件夹不存在")?;
    drop(guard);
    watcher::stop(&app, folder_id)?;
    let videos = {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("数据库未初始化")?;
        db::folder_video_paths(conn, folder_id).map_err(|e| e.to_string())?
    };
    for (id, _) in &videos { indexer::cancel(&app, *id); }
    let (rebuilt, stats) = {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("数据库未初始化")?;
        for (id, _) in &videos { db::remove_video(conn, *id).map_err(|e| e.to_string())?; }
        db::remove_folder(conn, folder_id).map_err(|e| e.to_string())?;
        (search::FrameSearchIndex::rebuild_from_db(conn), db::stats(conn).map_err(|e| e.to_string())?)
    };
    for (id, path) in videos {
        frames_store::remove_video(id);
        let _ = app.emit("library_event", events::LibraryEvent::VideoRemoved { video_id: id, path });
    }
    *state.search_index.lock().map_err(|e| e.to_string())? = rebuilt;
    let _ = app.emit("library_event", events::LibraryEvent::FolderRemoved { folder_id });
    let _ = app.emit("library_event", events::LibraryEvent::Stats { stats });
    watcher::sync_all(&app)?;
    Ok(())
}

/// 重新扫描文件夹（folderId 缺省则全部），返回聚合结果。
#[tauri::command]
pub fn folders_rescan(
    app: AppHandle,
    folder_id: Option<i64>,
) -> Result<events::ImportResult, String> {
    let targets: Vec<db::WatchedFolder> = {
        let state = app.state::<AppState>();
        let g = state.db.lock().map_err(|e| e.to_string())?;
        let conn = g.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        match folder_id {
            Some(id) => db::get_folder(conn, id).map_err(|e| e.to_string())?.into_iter().collect(),
            None => db::list_folders(conn).map_err(|e| e.to_string())?,
        }
    };
    let mut total = events::ImportResult::default();
    for folder in &targets {
        if !std::path::Path::new(&folder.path).exists() {
            let state = app.state::<AppState>();
            let g = state.db.lock().map_err(|e| e.to_string())?;
            if let Some(c) = g.as_ref() {
                let _ = db::update_folder_state(c, folder.id, "missing", Some("目录不存在"));
                if let Ok(Some(f)) = db::get_folder(c, folder.id) {
                    let _ = app.emit("library_event", events::LibraryEvent::FolderUpdated { folder: f });
                }
            }
            continue;
        }
        let (result, _) =
            indexer::import_folder(app.clone(), folder.path.clone(), folder.pinned, folder.recursive)?;
        total.added += result.added;
        total.duplicates += result.duplicates;
        total.skipped += result.skipped;
        total.scanned += result.scanned;
        total.folders += result.folders;
    }
    watcher::sync_all(&app)?;
    Ok(total)
}

/// 启用/停用文件夹监听，返回更新后的记录。
#[tauri::command]
pub fn folders_set_enabled(
    app: AppHandle,
    folder_id: i64,
    enabled: bool,
) -> Result<db::WatchedFolder, String> {
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::set_folder_enabled(conn, folder_id, enabled).map_err(|e| e.to_string())?;
    let folder = db::get_folder(conn, folder_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "文件夹不存在".to_string())?;
    drop(guard);
    watcher::sync_all(&app)?;
    Ok(folder)
}

/// 单个视频记录。
#[tauri::command]
pub fn videos_get(state: State<AppState>, video_id: i64) -> Result<Option<db::VideoRecord>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::get_video(conn, video_id).map_err(|e| e.to_string())
}

/// 删除视频记录（帧级联删除）。
#[tauri::command]
pub fn videos_remove(app: AppHandle, video_id: i64) -> Result<(), String> {
    indexer::cancel(&app, video_id);
    let state = app.state::<AppState>();
    let (removed, rebuilt) = {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "数据库未初始化".to_string())?;
        let removed = db::remove_video(conn, video_id).map_err(|e| e.to_string())?;
        let rebuilt = search::FrameSearchIndex::rebuild_from_db(conn);
        (removed, rebuilt)
    };
    frames_store::remove_video(video_id);
    *state.search_index.lock().map_err(|e| e.to_string())? = rebuilt;
    if let Some(video) = removed {
        let _ = app.emit(
            "library_event",
            events::LibraryEvent::VideoRemoved {
                video_id: video.id,
                path: video.path,
            },
        );
    }
    Ok(())
}

/// 在资源管理器中定位文件。
#[tauri::command]
pub fn videos_reveal(state: State<AppState>, video_id: i64) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let video = db::get_video(conn, video_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "视频不存在".to_string())?;
    platform_open::reveal(std::path::Path::new(&video.path))
}

/// 打开视频文件；带时间戳时优先用支持定位起播的播放器（mpv/PotPlayer/VLC）。
#[tauri::command]
pub fn videos_open(
    state: State<AppState>,
    video_id: i64,
    at_seconds: Option<f64>,
) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let video = db::get_video(conn, video_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "视频不存在".to_string())?;
    if let Some(t) = at_seconds {
        if t > 0.0 {
            if let Some(player) = media::find_seekable_player(&video.path) {
                let args = (player.args)(&video.path, t);
                return Command::new(&player.exe).no_window().args(&args).spawn()
                    .map(|_| ()).map_err(|e| e.to_string());
            }
        }
    }
    platform_open::open(std::path::Path::new(&video.path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePair {
    pub video_a: db::VideoRecord,
    pub video_b: db::VideoRecord,
    pub score: f64,
    pub hash_score: f64,
    pub color_score: f64,
    pub time_seconds: f64,
    pub identical_file: bool,
}

struct RoughDuplicateHit {
    id_a: i64,
    id_b: i64,
    hash_score: f64,
    color_score: f64,
    time_seconds: f64,
    score: f64,
}

fn pair_key(a: i64, b: i64) -> (i64, i64) {
    if a < b { (a, b) } else { (b, a) }
}

fn ensure_file_hash(app: &AppHandle, video_id: i64) -> Result<Option<String>, String> {
    let video = {
        let state = app.state::<AppState>();
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        db::get_video(conn, video_id).map_err(|e| e.to_string())?
    };
    let Some(video) = video else { return Ok(None) };
    if let Some(hash) = video.file_hash {
        return Ok(Some(hash));
    }
    let hash = media::sha256_of_file(&video.path)?;
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
    db::set_file_hash(conn, video_id, &hash).map_err(|e| e.to_string())?;
    Ok(Some(hash))
}

fn duplicate_coverage_score(average: f64, coverage: f64) -> f64 {
    average * (0.5 + 0.5 * coverage)
}

fn duplicate_meets_threshold(score: f64, threshold: f64) -> bool {
    score >= threshold
}

fn find_duplicates_sync(app: &AppHandle, min_score: Option<f64>) -> Result<Vec<DuplicatePair>, String> {
    let threshold = min_score.filter(|v| v.is_finite() && *v > 0.0 && *v <= 1.0).unwrap_or(0.88);
    let identical_candidates = {
        let state = app.state::<AppState>();
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        db::find_identical_file_pairs(conn).map_err(|e| e.to_string())?
    };
    let mut pairs = Vec::new();
    let mut seen = HashSet::new();

    for (id_a, id_b) in identical_candidates {
        let hashes = ensure_file_hash(app, id_a).and_then(|a| {
            ensure_file_hash(app, id_b).map(|b| (a, b))
        });
        let (hash_a, hash_b) = match hashes {
            Ok(value) => value,
            Err(error) => {
                let _ = app.emit(
                    "library_event",
                    events::LibraryEvent::Notice {
                        level: "warn".to_string(),
                        message: format!("文件指纹计算失败：{error}"),
                    },
                );
                continue;
            }
        };
        if hash_a.is_none() || hash_a != hash_b {
            continue;
        }
        let key = pair_key(id_a, id_b);
        seen.insert(key);
        let videos = {
            let state = app.state::<AppState>();
            let guard = state.db.lock().map_err(|e| e.to_string())?;
            let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
            (
                db::get_video(conn, id_a).map_err(|e| e.to_string())?,
                db::get_video(conn, id_b).map_err(|e| e.to_string())?,
            )
        };
        if let (Some(video_a), Some(video_b)) = videos {
            pairs.push(DuplicatePair {
                video_a,
                video_b,
                score: 1.0,
                hash_score: 1.0,
                color_score: 1.0,
                time_seconds: 0.0,
                identical_file: true,
            });
        }
    }

    let rough_hits = {
        let state = app.state::<AppState>();
        let index = state.search_index.lock().map_err(|e| e.to_string())?;
        let ids = index.list_video_ids();
        let total = ids.len() as i64;
        let mut rough = Vec::new();
        for (position, id) in ids.into_iter().enumerate() {
            if let Some(vector) = index.video_query_vector(id) {
                let (results, _) = index.search(
                    &vector,
                    &search::SearchOptions { min_hash_score: threshold, max_results: 8 },
                );
                if let Some(hit) = results.into_iter().find(|result| result.video_id != id) {
                    let key = pair_key(id, hit.video_id);
                    if !seen.contains(&key) {
                        let vectors = index.video_frame_vectors(id, 8);
                        let mut matched = 0usize;
                        let mut sum = 0.0;
                        for frame in &vectors {
                            let (deep, _) = index.search(
                                frame,
                                &search::SearchOptions { min_hash_score: threshold, max_results: 50 },
                            );
                            if let Some(to_b) = deep.into_iter().find(|item| item.video_id == hit.video_id) {
                                matched += 1;
                                sum += to_b.score;
                            }
                        }
                        let coverage = if vectors.is_empty() { 0.0 } else { matched as f64 / vectors.len() as f64 };
                        let average = if matched == 0 { 0.0 } else { sum / matched as f64 };
                        let score = duplicate_coverage_score(average, coverage);
                        if duplicate_meets_threshold(score, threshold) {
                            seen.insert(key);
                            rough.push(RoughDuplicateHit {
                                id_a: id,
                                id_b: hit.video_id,
                                hash_score: hit.hash_score,
                                color_score: hit.color_score,
                                time_seconds: hit.time_seconds,
                                score,
                            });
                        }
                    }
                }
            }
            let done = position as i64 + 1;
            if done % 16 == 0 || done == total {
                let _ = app.emit(
                    "library_event",
                    events::LibraryEvent::DuplicateScanProgress { done, total },
                );
            }
        }
        if total == 0 {
            let _ = app.emit(
                "library_event",
                events::LibraryEvent::DuplicateScanProgress { done: 0, total: 0 },
            );
        }
        rough
    };

    {
        let state = app.state::<AppState>();
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        for hit in rough_hits {
            if let (Some(video_a), Some(video_b)) = (
                db::get_video(conn, hit.id_a).map_err(|e| e.to_string())?,
                db::get_video(conn, hit.id_b).map_err(|e| e.to_string())?,
            ) {
                pairs.push(DuplicatePair {
                    video_a,
                    video_b,
                    score: hit.score,
                    hash_score: hit.hash_score,
                    color_score: hit.color_score,
                    time_seconds: hit.time_seconds,
                    identical_file: false,
                });
            }
        }
    }
    pairs.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(pairs)
}

/// 库内查重：先以 size/duration + SHA-256 确认 bit 级副本，再以帧覆盖率筛相似视频。
#[tauri::command]
pub async fn videos_find_duplicates(
    app: AppHandle,
    min_score: Option<f64>,
) -> Result<Vec<DuplicatePair>, String> {
    tauri::async_runtime::spawn_blocking(move || find_duplicates_sync(&app, min_score))
        .await
        .map_err(|e| e.to_string())?
}

/// 命中时间点预览：现场解码一帧 JPEG dataUrl。失败返回 null（调用方回退缩略图）。
#[tauri::command]
pub fn videos_match_frame(
    state: State<AppState>,
    video_id: i64,
    time_ms: i64,
) -> Result<Option<String>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let video = db::get_video(conn, video_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "视频不存在".to_string())?;
    if time_ms < 0 {
        return Ok(None);
    }
    Ok(media::decode_frame_at(&video.path, time_ms, crate::constants::EXTRACT_WIDTH))
}

/// 视频分页列表（支持 keyword/folderId/status 过滤、排序、分页）。
#[tauri::command]
pub fn videos_list(state: State<AppState>, query: db::VideoQuery) -> Result<db::VideoPage, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::list_videos(conn, &query).map_err(|e| e.to_string())
}

/// 视频缩略图（data:image/jpeg;base64,...），无则 null。
#[tauri::command]
pub fn videos_thumbnail(
    state: State<AppState>,
    video_id: i64,
) -> Result<Option<String>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::get_thumbnail(conn, video_id).map_err(|e| e.to_string())
}

/// 视频全部索引帧清单（按帧序号升序）。
#[tauri::command]
pub fn videos_frame_manifest(
    state: State<AppState>,
    video_id: i64,
) -> Result<Vec<db::FrameManifestEntry>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::list_frame_manifest(conn, video_id).map_err(|e| e.to_string())
}

/// 单视频帧级进度（抽帧进行中实时回报）。
#[tauri::command]
pub fn videos_frame_progress(
    app: AppHandle,
    video_id: i64,
) -> Result<Option<events::FrameProgress>, String> {
    Ok(indexer::get_frame_progress(&app, video_id))
}

/// 通过系统文件选择对话框导入视频文件，返回聚合结果。
#[tauri::command]
pub async fn videos_import(app: AppHandle) -> Result<events::ImportResult, String> {
    let files = native_files_dialog(
        &app,
        "选择视频文件（可多选）",
        "视频",
        &["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "mpg", "mpeg", "rmvb", "3gp"],
    );
    if files.is_empty() {
        logger::log("[import] 视频文件选择已取消");
        return Ok(events::ImportResult::default());
    }
    logger::log(&format!("[import] 已选择 {} 个视频文件", files.len()));
    let result = indexer::import_files(app, files, None);
    logger::log(&format!(
        "[import] 视频文件导入完成：新增 {}，已存在 {}，跳过 {}",
        result.added, result.duplicates, result.skipped
    ));
    Ok(result)
}

/// 递归导入一个文件夹，但不把它登记为监听目录。
#[tauri::command]
pub async fn videos_import_folder_once(app: AppHandle) -> Result<events::ImportResult, String> {
    let Some(mut dirs) = native_folder_dialog(&app, "选择要一次性导入的文件夹（不会持续监视）") else {
        logger::log("[import] 一次性文件夹选择已取消");
        return Ok(events::ImportResult::default());
    };
    let Some(dir) = dirs.pop() else {
        return Ok(events::ImportResult::default());
    };
    logger::log(&format!("[import] 一次性导入文件夹：{dir}"));
    let result = indexer::import_folder_once(app, dir, true)?;
    logger::log(&format!(
        "[import] 文件夹导入完成：扫描 {}，新增 {}，已存在 {}，跳过 {}",
        result.scanned, result.added, result.duplicates, result.skipped
    ));
    Ok(result)
}

/// 通过系统文件选择对话框选择要搜索的图片，返回归一化路径列表（不入库）。
#[tauri::command]
pub async fn videos_import_images(app: AppHandle) -> Result<Vec<String>, String> {
    let files = native_files_dialog(
        &app,
        "选择要搜索的图片",
        "图片",
        &["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif"],
    );
    Ok(files
        .into_iter()
        .map(|f| db::normalize_path(&f))
        .collect())
}

/// 重建索引：按各视频当前记录的模式重抽（mode 仅指定时写入覆盖）。返回待处理视频数。
#[tauri::command]
pub fn videos_reindex(
    app: AppHandle,
    video_ids: Option<Vec<i64>>,
    mode: Option<String>,
) -> Result<i64, String> {
    Ok(indexer::reindex(app, video_ids, mode))
}

/// 同步文件夹监听（启动/停止各目录的磁盘监听以匹配启用状态）。
#[tauri::command]
pub fn watcher_sync(app: AppHandle) -> Result<(), String> {
    watcher::sync_all(&app)
}

/// 用户设置（合并默认值）。
#[tauri::command]
pub fn library_settings(state: State<AppState>) -> Result<db::AppSettings, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    db::get_settings(conn).map_err(|e| e.to_string())
}

/// 更新用户设置，返回合并后的完整设置。
#[tauri::command]
pub fn library_update_settings(app: AppHandle, patch: db::SettingsPatch) -> Result<db::AppSettings, String> {
    let state = app.state::<AppState>();
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "数据库未初始化".to_string())?;
    let previous = db::get_settings(conn).map_err(|e| e.to_string())?;
    let updated = db::update_settings(conn, &patch).map_err(|e| e.to_string())?;
    if let Some(mode) = patch.sampling_mode.as_deref() {
        if mode != previous.sampling_mode {
            db::migrate_sampling_on_global_change(conn, &previous.sampling_mode, mode)
                .map_err(|e| e.to_string())?;
        }
    }
    drop(guard);
    if patch.keep_frame_images == Some(false) && previous.keep_frame_images && frames_store::remove_all() {
        let _ = app.emit(
            "library_event",
            events::LibraryEvent::Notice {
                level: "info".to_string(),
                message: "已清空全部索引帧图片".to_string(),
            },
        );
    }
    let _ = watcher::sync_all(&app);
    let _ = app.emit(
        "library_event",
        events::LibraryEvent::SettingsUpdated { settings: updated.clone() },
    );
    Ok(updated)
}

/// 重置索引库（清空视频/帧/文件夹，保留设置）。
#[tauri::command]
pub fn library_reset(app: AppHandle) -> Result<(), String> {
    watcher::stop_all(&app)?;
    indexer::cancel_all(&app);
    let state = app.state::<AppState>();
    {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "数据库未初始化".to_string())?;
        db::clear_all(conn).map_err(|e| e.to_string())?;
    }
    // watcher 析构前已进入回调的事件可能刚刚入队；清库后再收口一次。
    indexer::cancel_all(&app);
    frames_store::remove_all();
    *state.search_index.lock().map_err(|e| e.to_string())? = search::FrameSearchIndex::new();
    Ok(())
}

/// 打开数据目录（含 whichvideo.db）。
#[tauri::command]
pub fn library_open_database_folder() -> Result<String, String> {
    let dir = db::data_dir();
    let dir_str = dir.to_string_lossy().to_string();
    platform_open::open(&dir)?;
    Ok(dir_str)
}

/// 导出可分享的本地诊断包；只包含脱敏后的运行状态与日志末尾，不含视频或路径清单。
#[tauri::command]
pub fn library_export_diagnostics(app: AppHandle) -> Result<Option<String>, String> {
    let Some(path) = native_diagnostic_save_dialog(&app) else {
        return Ok(None);
    };
    crate::diagnostics::write_archive(&app, &path)?;
    if let Some(parent) = path.parent() {
        let _ = platform_open::open(parent);
    }
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 运行时数据目录信息（toolsReady 由媒体探测结果决定）。
#[tauri::command]
pub fn library_data_dir() -> Result<db::DataDirInfo, String> {
    Ok(db::data_dir_info(media::tools_ready()))
}

/// FFmpeg/ffprobe 当前探测结果与来源。
#[tauri::command]
pub fn library_media_tools() -> Result<media::MediaToolsStatus, String> {
    Ok(media::tools_status())
}

/// 选择同时包含 ffmpeg 与 ffprobe 的目录，验证后持久化。
#[tauri::command]
pub async fn library_select_media_tools_dir(app: AppHandle) -> Result<media::MediaToolsStatus, String> {
    let Some(mut dirs) = native_folder_dialog(&app, "选择 FFmpeg 的 bin 目录") else {
        return Ok(media::tools_status());
    };
    let Some(dir) = dirs.pop() else {
        return Ok(media::tools_status());
    };
    let status = media::configure_dir(Some(dir.clone()))?;
    let state = app.state::<AppState>();
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
    db::set_ffmpeg_dir(conn, Some(&dir)).map_err(|e| e.to_string())?;
    logger::log(&format!("FFmpeg 目录已设置：{dir}（source={}）", status.source));
    Ok(status)
}

/// 清除手动目录并重新按环境变量 / PATH 自动检测。
#[tauri::command]
pub fn library_clear_media_tools_dir(state: State<AppState>) -> Result<media::MediaToolsStatus, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
    db::set_ffmpeg_dir(conn, None).map_err(|e| e.to_string())?;
    let status = media::configure_dir(None)?;
    logger::log(&format!("FFmpeg 手动目录已清除（source={}）", status.source));
    Ok(status)
}

/* ================================================================== */
/* 图片检索：byPath / byDataUrl / byClipboard / byUrl                 */
/* ================================================================== */

const RERANK_TOP_K: usize = 8;
const RERANK_WEIGHT: f64 = 0.3;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    width: u32,
    height: u32,
    color_score_hint: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    video: db::VideoRecord,
    score: f64,
    hash_score: f64,
    color_score: f64,
    time_seconds: f64,
    frame_index: i64,
    hash_distance: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    query: SearchQuery,
    match_count: usize,
    compared_frames: usize,
    elapsed_ms: i64,
    found: bool,
    matches: Vec<SearchMatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    query_image_url: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSearchResult {
    data_url: Option<String>,
    response: SearchResponse,
}

fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// 统一的失败响应，四条检索入口共用同一结构。
fn fail_response(code: &str, message: &str) -> SearchResponse {
    SearchResponse {
        query: SearchQuery {
            width: 0,
            height: 0,
            color_score_hint: 0.0,
        },
        match_count: 0,
        compared_frames: 0,
        elapsed_ms: 0,
        found: false,
        matches: Vec::new(),
        error: Some(message.to_string()),
        error_code: Some(code.to_string()),
        query_image_url: None,
    }
}

/// 把一张已解码的图归一化到 EXTRACT_WIDTH 宽、偶数高（与索引帧路径完全对称），
/// 返回 RGB24 像素缓冲。查询图若保留原尺寸（尤其小图），toGray 盒式重采样与
/// 直方图抽样都会和索引侧错开；放大到 320 不引入新信息，但让双方走完全相同的重采样路径。
fn prepare_query_image(img: image::DynamicImage) -> Option<(Vec<u8>, u32, u32)> {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return None;
    }
    let tw = crate::constants::EXTRACT_WIDTH;
    let th = ((2.0 * (h as f64 * tw as f64 / (2.0 * w as f64)).round()) as u32).max(2);
    let resized = img.resize_exact(tw, th, image::imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();
    let (rw, rh) = (rgb.width(), rgb.height());
    Some((rgb.into_raw(), rw, rh))
}

/// 由归一化后的 RGB24 缓冲计算查询向量。
fn build_query_vector(buf: &[u8], w: u32, h: u32) -> search::QueryVector {
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: buf,
    };
    let sig = hash::compute_signature(&ild);
    let color = framepack::quantize_color(&sig.color);
    let colorfulness = framepack::quantized_colorfulness(&color);
    search::QueryVector {
        dhash: sig.dhash,
        struct_hash: sig.struct_hash,
        color,
        spatial: sig.spatial,
        colorfulness,
    }
}

/// data URL → 解码字节（仅支持 base64 形态）。
fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
    let comma = data_url.find(',')?;
    let meta = &data_url[..comma];
    if !meta.contains("base64") {
        return None;
    }
    let b64 = &data_url[comma + 1..];
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// 二阶段验证重排：对粗召回的前 RERANK_TOP_K 个命中解码其命中帧，做像素级 SSIM，
/// 与粗打分凸组合后重排。解码失败（文件已删/时间点越界）保持原分数不惩罚。
fn rerank_matches(
    videos: &HashMap<i64, db::VideoRecord>,
    qild: &hash::ImageDataLike,
    hits: &mut [search::IndexedHit],
) -> HashMap<i64, media::RawFrame> {
    let mut decoded = HashMap::new();
    if hits.len() <= 1 {
        return decoded;
    }
    let head_len = hits.len().min(RERANK_TOP_K);
    for hit in hits.iter_mut().take(head_len) {
        let (vid, t, old_score) = (hit.video_id, hit.time_seconds, hit.score);
        let video = match videos.get(&vid) {
            Some(v) => v,
            None => continue,
        };
        let frames = match media::extract_and_hash_frames(
            &video.path,
            &[t],
            video.duration,
            video.width,
            video.height,
            true,
        ) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let frame = match frames.into_iter().next() {
            Some(f) => f,
            None => continue,
        };
        let fild = hash::ImageDataLike {
            width: frame.width,
            height: frame.height,
            channels: 3,
            order: hash::ChannelOrder::Rgb,
            data: &frame.rgb,
        };
        let ssim = hash::ssim_similarity(qild, &fild, 48, 48);
        let new_score = old_score * (1.0 - RERANK_WEIGHT) + ssim * RERANK_WEIGHT;
        hit.score = new_score;
        decoded.insert(vid, frame);
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    decoded
}

fn refinement_decode_times(candidates: &[f64], cached_center: bool) -> &[f64] {
    if cached_center { &candidates[1..] } else { candidates }
}

fn refinement_center_matches_hit(candidates: &[f64], hit_time: f64) -> bool {
    candidates.first().is_some_and(|time| (time - hit_time).abs() < 0.001)
}

fn score_refinement_frame(qv: &search::QueryVector, frame: &media::RawFrame) -> f64 {
    let ild = hash::ImageDataLike {
        width: frame.width,
        height: frame.height,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &frame.rgb,
    };
    search::score_raw_frame(qv, &ild)
}

/// 命中时间精修：粗召回命中的是采样帧，显示时间 = 该采样帧的时间，与截图帧天然差半个
/// 采样间隔以内。围绕命中时间按局部采样密度并行补采候选帧（逐点 seek），用与粗召回
/// 相同的打分公式选最优；优于命中点自身才改写 timeSeconds。
fn refine_hit_time(
    qv: &search::QueryVector,
    video: &db::VideoRecord,
    hit: &mut search::IndexedHit,
    cached_center: Option<&media::RawFrame>,
) {
    let candidates = search::refine_candidate_times(video.duration, video.frame_count as usize, hit.time_seconds);
    if candidates.len() <= 1 {
        return;
    }
    let cached_center = cached_center.filter(|_| refinement_center_matches_hit(&candidates, hit.time_seconds));
    let decode_times = refinement_decode_times(&candidates, cached_center.is_some());
    let frames = match media::extract_and_hash_frames(
        &video.path,
        decode_times,
        video.duration,
        video.width,
        video.height,
        true,
    ) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut best_score = cached_center.map(|frame| score_refinement_frame(qv, frame)).unwrap_or(-1.0);
    let mut best_time = cached_center.map(|_| candidates[0]);
    for (fr, t) in frames.iter().zip(decode_times.iter()) {
        let score = score_refinement_frame(qv, fr);
        if score > best_score {
            best_score = score;
            best_time = Some(*t);
        }
    }
    if let Some(bt) = best_time {
        if (bt - hit.time_seconds).abs() > 0.01 {
            hit.time_seconds = round2(bt);
        }
    }
}

/// 检索编排：重建索引 → 粗召回 → SSIM 重排 → 命中时间精修 → 构造响应。
fn perform_search(
    state: &AppState,
    qv: &search::QueryVector,
    qild: &hash::ImageDataLike,
    qw: u32,
    qh: u32,
) -> Result<SearchResponse, String> {
    let started = std::time::SystemTime::now();
    let settings = {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "数据库未初始化".to_string())?;
        db::get_settings(conn).unwrap_or_else(|_| db::default_settings())
    };
    let candidate_limit = (settings.max_results as usize).max(RERANK_TOP_K);

    let (mut results, compared) = {
        let index = state.search_index.lock().map_err(|e| e.to_string())?;
        index.search(
            qv,
            &search::SearchOptions {
                min_hash_score: settings.min_hash_score,
                max_results: candidate_limit,
            },
        )
    };

    // 后续重排/精修会多次启动 FFmpeg，先把候选视频快照出来，绝不能在这些
    // 外部进程运行期间持有全局 SQLite 互斥锁。
    let videos: HashMap<i64, db::VideoRecord> = {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "数据库未初始化".to_string())?;
        results
            .iter()
            .filter_map(|hit| {
                db::get_video(conn, hit.video_id)
                    .ok()
                    .flatten()
                    .map(|video| (video.id, video))
            })
            .collect()
    };

    let decoded = rerank_matches(&videos, qild, &mut results);

    // 命中时间精修：只对最佳命中做（补采 2×4+1 帧逐点 seek），把显示时间从
    // 「最近采样帧」对准到「真实截图帧」。
    if let Some(top) = results.first_mut() {
        if let Some(video) = videos.get(&top.video_id) {
            refine_hit_time(qv, video, top, decoded.get(&top.video_id));
        }
    }

    let matches: Vec<SearchMatch> = results
        .iter()
        .take(settings.max_results as usize)
        .filter_map(|hit| {
            let video = videos.get(&hit.video_id)?.clone();
            Some(SearchMatch {
                video,
                score: round4(hit.score),
                hash_score: round4(hit.hash_score),
                color_score: round4(hit.color_score),
                time_seconds: round2(hit.time_seconds),
                frame_index: hit.frame_index as i64,
                hash_distance: hit.hash_distance as i64,
            })
        })
        .collect();

    let color_hint = matches.first().map(|m| m.color_score).unwrap_or(0.0);
    let elapsed = started
        .elapsed()
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    Ok(SearchResponse {
        query: SearchQuery {
            width: qw,
            height: qh,
            color_score_hint: color_hint,
        },
        match_count: matches.len(),
        compared_frames: compared,
        elapsed_ms: elapsed,
        found: !matches.is_empty(),
        matches,
        error: None,
        error_code: None,
        query_image_url: None,
    })
}

/// 从文件检索。
#[tauri::command]
pub async fn search_path(app: AppHandle, file_path: String) -> Result<SearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || search_path_sync(&app, file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn search_path_sync(app: &AppHandle, file_path: String) -> Result<SearchResponse, String> {
    let img = match image::open(&file_path) {
        Ok(i) => i,
        Err(e) => return Ok(fail_response("decode-failed", &format!("无法读取图片：{e}"))),
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Some(v) => v,
        None => return Ok(fail_response("decode-failed", "图片无法转成位图")),
    };
    let qv = build_query_vector(&buf, w, h);
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &buf,
    };
    let state = app.state::<AppState>();
    perform_search(
        state.inner(),
        &qv,
        &ild,
        source_width,
        source_height,
    )
}

/// 从 data URL 检索（拖入/粘贴的 base64 图片）。
#[tauri::command]
pub async fn search_data_url(app: AppHandle, data_url: String) -> Result<SearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || search_data_url_sync(&app, data_url))
        .await
        .map_err(|e| e.to_string())?
}

fn search_data_url_sync(app: &AppHandle, data_url: String) -> Result<SearchResponse, String> {
    let bytes = match decode_data_url(&data_url) {
        Some(b) => b,
        None => return Ok(fail_response("decode-failed", "无法解析图片数据")),
    };
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(e) => return Ok(fail_response("decode-failed", &format!("无法解码图片：{e}"))),
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Some(v) => v,
        None => return Ok(fail_response("decode-failed", "图片无法转成位图")),
    };
    let qv = build_query_vector(&buf, w, h);
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &buf,
    };
    let state = app.state::<AppState>();
    perform_search(
        state.inner(),
        &qv,
        &ild,
        source_width,
        source_height,
    )
}

/// 从系统剪贴板检索。剪贴板无图片时返回 null（调用方据此显示空态）。
#[tauri::command]
pub async fn search_clipboard(app: AppHandle) -> Result<Option<ClipboardSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_clipboard_sync(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn search_clipboard_sync(app: &AppHandle) -> Result<Option<ClipboardSearchResult>, String> {
    let png = match read_clipboard_image_png(app) {
        Some(p) => p,
        None => return Ok(None),
    };
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    let img = match image::load_from_memory(&png) {
        Ok(i) => i,
        Err(e) => return Ok(Some(ClipboardSearchResult {
            data_url: Some(data_url),
            response: fail_response("decode-failed", &format!("无法解码剪贴板图片：{e}")),
        })),
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Some(v) => v,
        None => return Ok(Some(ClipboardSearchResult {
            data_url: Some(data_url),
            response: fail_response("decode-failed", "剪贴板图片无法转成位图"),
        })),
    };
    let qv = build_query_vector(&buf, w, h);
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &buf,
    };
    let state = app.state::<AppState>();
    let response = perform_search(
        state.inner(),
        &qv,
        &ild,
        source_width,
        source_height,
    )?;
    Ok(Some(ClipboardSearchResult {
        data_url: Some(data_url),
        response,
    }))
}

/// 从 http(s) 链接检索（图片直链或普通网页里解析出的主图）。失败时 error 字段说明原因。
#[tauri::command]
pub async fn search_url(app: AppHandle, url: String) -> Result<SearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || search_url_sync(&app, url))
        .await
        .map_err(|e| e.to_string())?
}

fn search_url_sync(app: &AppHandle, url: String) -> Result<SearchResponse, String> {
    let (bytes, final_url) = match fetch_image_from_url(&url) {
        Ok(v) => v,
        Err((code, msg)) => return Ok(fail_response(&code, &msg)),
    };
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(e) => {
            return Ok(fail_response(
                "decode-failed",
                &format!("图片已下载但无法解码：{e}"),
            ))
        }
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Some(v) => v,
        None => return Ok(fail_response("decode-failed", "下载的图片无法转成位图")),
    };
    let qv = build_query_vector(&buf, w, h);
    let ild = hash::ImageDataLike {
        width: w,
        height: h,
        channels: 3,
        order: hash::ChannelOrder::Rgb,
        data: &buf,
    };
    let state = app.state::<AppState>();
    let mut response = perform_search(
        state.inner(),
        &qv,
        &ild,
        source_width,
        source_height,
    )?;
    response.query_image_url = Some(final_url);
    Ok(response)
}

/* ================================================================== */
/* 系统对话框                                                          */
/* ================================================================== */

/// 使用 Tauri 原生对话框并绑定主窗口。PowerShell + CREATE_NO_WINDOW 在便携版里
/// 会出现选择器未显示/未置前、最终返回空结果的问题。
fn native_files_dialog(app: &AppHandle, title: &str, filter_name: &str, exts: &[&str]) -> Vec<String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(filter_name, exts);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .map(|path| db::normalize_path(&path.to_string_lossy()))
        .collect()
}

fn native_folder_dialog(app: &AppHandle, title: &str) -> Option<Vec<String>> {
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let path = dialog.blocking_pick_folder()?.into_path().ok()?;
    Some(vec![db::normalize_path(&path.to_string_lossy())])
}

fn native_diagnostic_save_dialog(app: &AppHandle) -> Option<std::path::PathBuf> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("导出诊断包")
        .set_file_name(diagnostic_file_name(db::now_ms()))
        .add_filter("ZIP 诊断包", &["zip"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.blocking_save_file()?.into_path().ok()
}

/// 诊断包按 UTC 时间命名：跨平台稳定、按字典序即可得到时间顺序。
fn diagnostic_file_name(timestamp_ms: i64) -> String {
    let seconds = timestamp_ms.div_euclid(1000);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date_from_unix_days(seconds.div_euclid(86_400));
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("whichvideo-diagnostics-{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z.zip")
}

/// 公历换算，基准为 Unix epoch；避免仅为文件名引入时间库依赖。
fn civil_date_from_unix_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

/* ================================================================== */
/* 跨平台剪贴板与网络图片取图                                           */
/* ================================================================== */

/// 读取系统剪贴板里的图片，编码为 PNG。无图片返回 None。
fn read_clipboard_image_png(app: &AppHandle) -> Option<Vec<u8>> {
    // 插件读取必须在工作线程中运行；search_clipboard 已通过 spawn_blocking 隔离。
    let clipboard = app.clipboard().read_image().ok()?;
    let rgba = image::RgbaImage::from_raw(
        clipboard.width(), clipboard.height(), clipboard.rgba().to_vec()
    )?;
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(png.into_inner())
}

/// 从 http(s) 链接取图：直链直接下载；普通网页依次尝试 og:image / twitter:image /
/// image_src / 首个 <img>。成功返回 (图片字节, 最终取图地址)；失败返回 (错误码, 文案)。
/// 所有平台都使用同一个有超时和大小限制的实现。
fn fetch_image_from_url(url: &str) -> Result<(Vec<u8>, String), (String, String)> {
    crate::url_image::fetch(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_pair_key_is_order_independent() {
        assert_eq!(pair_key(7, 3), (3, 7));
        assert_eq!(pair_key(3, 7), (3, 7));
    }

    #[test]
    fn duplicate_coverage_score_must_pass_final_threshold() {
        let threshold = 0.88;
        let average = 1.0;
        let low_coverage = duplicate_coverage_score(average, 0.5);
        let full_coverage = duplicate_coverage_score(average, 1.0);
        assert!(!duplicate_meets_threshold(low_coverage, threshold));
        assert!(duplicate_meets_threshold(full_coverage, threshold));
    }

    #[test]
    fn query_image_is_resized_to_exact_ffmpeg_dimensions() {
        let image = image::DynamicImage::new_rgb8(1000, 333);
        let (pixels, width, height) = prepare_query_image(image).unwrap();
        assert_eq!((width, height), (crate::constants::EXTRACT_WIDTH, 106));
        assert_eq!(pixels.len(), width as usize * height as usize * 3);
    }

    #[test]
    fn refinement_reuses_a_reranked_center_frame() {
        let candidates = [10.0, 9.5, 10.5];
        assert_eq!(refinement_decode_times(&candidates, true), &[9.5, 10.5]);
        assert_eq!(refinement_decode_times(&candidates, false), &candidates);
        assert!(refinement_center_matches_hit(&candidates, 10.0));
        assert!(!refinement_center_matches_hit(&candidates, 12.0));
    }

    #[test]
    fn url_search_rejects_empty_and_non_http_inputs_before_fetching() {
        assert_eq!(fetch_image_from_url("  ").unwrap_err().0, "invalid-input");
        assert_eq!(
            fetch_image_from_url("file:///C:/secret.png").unwrap_err().0,
            "unsupported-protocol"
        );
    }

    #[test]
    fn diagnostic_filename_is_readable_and_chronological() {
        assert_eq!(diagnostic_file_name(0), "whichvideo-diagnostics-19700101T000000Z.zip");
        assert_eq!(diagnostic_file_name(1_735_689_599_000), "whichvideo-diagnostics-20241231T235959Z.zip");
    }
}
