use crate::constants;
use crate::db;
use crate::events;
use crate::frames_store;
use crate::hash;
use crate::indexer;
use crate::logger;
use crate::media;
use crate::paths;
use crate::platform_open;
use crate::process_ext::CommandNoWindow;
use crate::search;
use crate::search_service::{
    build_query_vector, decode_data_url, fail_response, perform_search, prepare_query_image,
    ClipboardSearchResult, SearchResponse,
};
use crate::state::AppState;
use crate::watcher;
use base64::Engine;
use serde::Serialize;
use std::collections::HashSet;
use std::process::Command;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// 库统计：视频/帧/文件夹计数。复用现有 whichvideo.db。
///
/// 只读命令也走阻塞线程：Tauri 的同步命令在窗口主线程上执行，导入/索引正在
/// 写库时这条查询要等锁，等多久整窗就卡多久。
#[tauri::command]
pub async fn library_stats(app: AppHandle) -> Result<db::LibraryStats, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let guard = state.db()?;
            let conn = &*guard;
            db::stats(conn).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("library_stats", result)
}

/// 索引器实时状态（取自共享受保护的状态）。
#[tauri::command]
pub fn library_status(state: State<AppState>) -> Result<db::IndexerStatus, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let idx = state.indexer.lock().map_err(|e| e.to_string())?;
        Ok(idx.status())
    })();
    crate::error::command_result("library_status", result)
}

/// 监听文件夹列表（与统计/列表一样走阻塞线程，别占主线程等数据库锁）。
#[tauri::command]
pub async fn folders_list(app: AppHandle) -> Result<Vec<db::WatchedFolder>, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let guard = state.db()?;
            let conn = &*guard;
            db::list_folders(conn).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("folders_list", result)
}

/// 登记一个被监听的文件夹，并立即扫描其中已有的视频。
#[tauri::command]
pub async fn folders_add_path(
    app: AppHandle,
    dir_path: String,
) -> Result<db::WatchedFolder, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || add_folder_path_sync(&app, dir_path))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("folders_add_path", result)
}

/// 扫描目录并逐个探测、哈希文件，耗时可达分钟级，只能跑在阻塞线程。
fn add_folder_path_sync(app: &AppHandle, dir_path: String) -> Result<db::WatchedFolder, String> {
    let (_, folder_id) = indexer::import_folder(app.clone(), dir_path, true, true)?;
    watcher::sync_all(&app)?;
    let state = app.state::<AppState>();
    let guard = state.db()?;
    let conn = &*guard;
    db::get_folder(conn, folder_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "文件夹登记后无法读取".to_string())
}

/// 通过系统文件夹选择对话框登记监听目录（多选退化为逐个）。
#[tauri::command]
pub async fn folders_add_dialog(app: AppHandle) -> Result<Vec<db::WatchedFolder>, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || add_folders_from_dialog_sync(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("folders_add_dialog", result)
}

fn add_folders_from_dialog_sync(app: &AppHandle) -> Result<Vec<db::WatchedFolder>, String> {
    let Some(picked) = native_folder_dialog(app, "选择要加入资料库并持续监视的文件夹") else {
        return Ok(Vec::new());
    };
    let mut folders = Vec::new();
    for dir in picked {
        let (_, id) = indexer::import_folder(app.clone(), dir, true, true)?;
        let state = app.state::<AppState>();
        let g = state.db()?;
        let c = &*g;
        let folder = db::get_folder(c, id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "文件夹登记后无法读取".to_string())?;
        folders.push(folder);
    }
    watcher::sync_all(&app)?;
    logger::info(logger::Module::Import, "watched_folders_added", &format!("count={}", folders.len()));
    Ok(folders)
}

/// 从索引库移除文件夹及其关联视频；磁盘文件不受影响。
#[tauri::command]
pub async fn folders_remove(app: AppHandle, folder_id: i64) -> Result<(), crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || remove_folder_sync(&app, folder_id))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("folders_remove", result)
}

/// 删掉一个含几千个视频的文件夹要做几千次删除和帧目录清理，只能跑在阻塞线程。
/// 逐条广播 `VideoRemoved` 会把事件通道和列表打成事件风暴，而前端本来就在
/// `FolderRemoved` 之后 `refreshAll` 对齐，所以这里只发一条汇总事件。
fn remove_folder_sync(app: &AppHandle, folder_id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let guard = state.db()?;
    let conn = &*guard;
    let folder = db::get_folder(conn, folder_id).map_err(|e| e.to_string())?;
    // 停监听会去拿监听表的锁，先把数据库锁放掉，避免锁顺序反转。
    drop(guard);
    folder.ok_or("文件夹不存在")?;
    watcher::stop(app, folder_id)?;
    let ids = {
        let guard = state.db()?;
        let conn = &*guard;
        db::detach_folder_videos(conn, folder_id).map_err(|e| e.to_string())?
    };
    indexer::cancel_many(app, &ids);
    let stats = {
        let guard = state.db()?;
        let conn = &*guard;
        db::remove_video_ids(conn, &ids).map_err(|e| e.to_string())?;
        db::remove_folder(conn, folder_id).map_err(|e| e.to_string())?;
        db::stats(conn).map_err(|e| e.to_string())?
    };
    for id in &ids {
        frames_store::remove_video(*id);
    }
    // 只摘掉这批视频的帧，不为一整个文件夹重建常驻索引。
    state
        .search_index
        .lock()
        .map_err(|e| e.to_string())?
        .remove_videos(&ids);
    events::emit(app, events::LibraryEvent::FolderRemoved { folder_id });
    events::emit(app, events::LibraryEvent::Stats { stats });
    watcher::sync_all(app)?;
    Ok(())
}

/// 重新扫描文件夹（folderId 缺省则全部），返回聚合结果。
#[tauri::command]
pub async fn folders_rescan(
    app: AppHandle,
    folder_id: Option<i64>,
) -> Result<events::ImportResult, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || rescan_folders_sync(&app, folder_id))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("folders_rescan", result)
}

fn rescan_folders_sync(app: &AppHandle, folder_id: Option<i64>) -> Result<events::ImportResult, String> {
    let targets: Vec<db::WatchedFolder> = {
        let state = app.state::<AppState>();
        let g = state.db()?;
        let conn = &*g;
        match folder_id {
            Some(id) => db::get_folder(conn, id).map_err(|e| e.to_string())?.into_iter().collect(),
            None => db::list_folders(conn).map_err(|e| e.to_string())?,
        }
    };
    let mut total = events::ImportResult::default();
    for folder in &targets {
        if !std::path::Path::new(&folder.path).exists() {
            total.failed += 1;
            total.failures.push(events::ImportFailure {
                path: folder.path.clone(), reason: "目录不存在".to_string(), folder_id: Some(folder.id),
            });
            if total.first_error.is_none() { total.first_error = Some("目录不存在".to_string()); }
            let state = app.state::<AppState>();
            let g = state.db()?;
            let _ = db::update_folder_state(&g, folder.id, "missing", Some("目录不存在"));
            if let Ok(Some(f)) = db::get_folder(&g, folder.id) {
                events::emit(app, events::LibraryEvent::FolderUpdated { folder: f });
            }
            continue;
        }
        let (result, _) =
            indexer::import_folder(app.clone(), folder.path.clone(), folder.pinned, folder.recursive)?;
        total.added += result.added;
        total.duplicates += result.duplicates;
        total.skipped += result.skipped;
        total.failed += result.failed;
        total.scanned += result.scanned;
        total.folders += result.folders;
        if total.first_error.is_none() { total.first_error = result.first_error.clone(); }
        total.failures.extend(result.failures);
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
) -> Result<db::WatchedFolder, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let state = app.state::<AppState>();
        let guard = state.db()?;
        let conn = &*guard;
        db::set_folder_enabled(conn, folder_id, enabled).map_err(|e| e.to_string())?;
        let folder = db::get_folder(conn, folder_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "文件夹不存在".to_string())?;
        drop(guard);
        watcher::sync_all(&app)?;
        Ok(folder)
    })();
    crate::error::command_result("folders_set_enabled", result)
}

/// 单个视频记录。
#[tauri::command]
pub fn videos_get(state: State<AppState>, video_id: i64) -> Result<Option<db::VideoRecord>, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let guard = state.db()?;
        let conn = &*guard;
        db::get_video(conn, video_id).map_err(|e| e.to_string())
    })();
    crate::error::command_result("videos_get", result)
}

/// 删除视频记录（帧级联删除）。
#[tauri::command]
pub fn videos_remove(app: AppHandle, video_id: i64) -> Result<(), crate::error::AppError> {
    let result: Result<_, String> = (|| {
        indexer::cancel(&app, video_id);
        let state = app.state::<AppState>();
        let removed = {
            let guard = state.db()?;
            let conn = &*guard;
            db::remove_video(conn, video_id).map_err(|e| e.to_string())?
        };
        frames_store::remove_video(video_id);
        // 只摘掉这个视频的帧，不值得为一条删除重建整个常驻索引。
        state
            .search_index
            .lock()
            .map_err(|e| e.to_string())?
            .remove_video(video_id);
        if let Some(video) = removed {
            events::emit(
                &app,
                events::LibraryEvent::VideoRemoved {
                    video_id: video.id,
                    path: video.path,
                },
            );
        }
        Ok(())
    })();
    crate::error::command_result("videos_remove", result)
}

/// 批量移除视频（不删除磁盘文件）。
///
/// 逐条调用 `videos_remove` 时每个 id 都是一次 IPC + 一次帧目录删除 + 一条事件，
/// 几百个就会把窗口拖住；这里一次删完、一次摘除索引，前端在命令返回后整体刷新。
#[tauri::command]
pub async fn videos_remove_many(app: AppHandle, video_ids: Vec<i64>) -> Result<(), crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || remove_videos_sync(&app, video_ids))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("videos_remove_many", result)
}

fn remove_videos_sync(app: &AppHandle, video_ids: Vec<i64>) -> Result<(), String> {
    if video_ids.is_empty() {
        return Ok(());
    }
    indexer::cancel_many(app, &video_ids);
    let state = app.state::<AppState>();
    {
        let guard = state.db()?;
        let conn = &*guard;
        db::remove_video_ids(conn, &video_ids).map_err(|e| e.to_string())?;
    }
    for id in &video_ids {
        frames_store::remove_video(*id);
    }
    state
        .search_index
        .lock()
        .map_err(|e| e.to_string())?
        .remove_videos(&video_ids);
    Ok(())
}

/// 在资源管理器中定位文件。
#[tauri::command]
pub fn videos_reveal(state: State<AppState>, video_id: i64) -> Result<(), crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let guard = state.db()?;
        let conn = &*guard;
        let video = db::get_video(conn, video_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "视频不存在".to_string())?;
        platform_open::reveal(std::path::Path::new(&video.path))
    })();
    crate::error::command_result("videos_reveal", result)
}

/// 打开视频文件；带时间戳时优先用支持定位起播的播放器（mpv/PotPlayer/VLC）。
#[tauri::command]
pub fn videos_open(
    state: State<AppState>,
    video_id: i64,
    at_seconds: Option<f64>,
) -> Result<(), crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let guard = state.db()?;
        let conn = &*guard;
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
    })();
    crate::error::command_result("videos_open", result)
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
        let guard = state.db()?;
        let conn = &*guard;
        db::get_video(conn, video_id).map_err(|e| e.to_string())?
    };
    let Some(video) = video else { return Ok(None) };
    if let Some(hash) = video.file_hash {
        return Ok(Some(hash));
    }
    let hash = media::sha256_of_file(&video.path)?;
    let state = app.state::<AppState>();
    let guard = state.db()?;
    let conn = &*guard;
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
    // 启动后索引还在后台构建时，空索引会把每一对都判成「不相似」。
    if !app
        .state::<AppState>()
        .search_ready
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("正在加载索引，请稍候再试".to_string());
    }
    let threshold = min_score.filter(|v| v.is_finite() && *v > 0.0 && *v <= 1.0).unwrap_or(0.88);
    let identical_candidates = {
        let state = app.state::<AppState>();
        let guard = state.db()?;
        let conn = &*guard;
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
                events::emit(
                    app,
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
            let guard = state.db()?;
            let conn = &*guard;
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
                events::emit(
                    app,
                    events::LibraryEvent::DuplicateScanProgress { done, total },
                );
            }
        }
        if total == 0 {
            events::emit(
                app,
                events::LibraryEvent::DuplicateScanProgress { done: 0, total: 0 },
            );
        }
        rough
    };

    {
        let state = app.state::<AppState>();
        let guard = state.db()?;
        let conn = &*guard;
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
) -> Result<Vec<DuplicatePair>, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || find_duplicates_sync(&app, min_score))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("videos_find_duplicates", result)
}

/// 命中时间点预览：现场解码一帧 JPEG dataUrl。失败返回 null（调用方回退缩略图）。
///
/// 解码要走 ffmpeg，可能耗时数秒（网络盘更长），因此放到阻塞线程，并且只在
/// 取路径时短暂持有数据库锁；不能在解码期间占着全局连接。
#[tauri::command]
pub async fn videos_match_frame(
    app: AppHandle,
    video_id: i64,
    time_ms: i64,
) -> Result<Option<String>, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || match_frame_sync(&app, video_id, time_ms))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("videos_match_frame", result)
}

fn match_frame_sync(app: &AppHandle, video_id: i64, time_ms: i64) -> Result<Option<String>, String> {
    if time_ms < 0 {
        return Ok(None);
    }
    let path = {
        let state = app.state::<AppState>();
        let guard = state.db()?;
        let conn = &*guard;
        db::get_video(conn, video_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "视频不存在".to_string())?
            .path
    };
    Ok(media::decode_frame_at(&path, time_ms, crate::constants::EXTRACT_WIDTH))
}

/// 视频分页列表（支持 keyword/folderId/status 过滤、排序、分页）。
#[tauri::command]
pub async fn videos_list(app: AppHandle, query: db::VideoQuery) -> Result<db::VideoPage, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let guard = state.db()?;
            let conn = &*guard;
            db::list_videos(conn, &query).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("videos_list", result)
}

/// 视频缩略图（data:image/jpeg;base64,...），无则 null。
#[tauri::command]
pub fn videos_thumbnail(
    state: State<AppState>,
    video_id: i64,
) -> Result<Option<String>, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let guard = state.db()?;
        let conn = &*guard;
        db::get_thumbnail(conn, video_id).map_err(|e| e.to_string())
    })();
    crate::error::command_result("videos_thumbnail", result)
}

/// 视频全部索引帧清单（按帧序号升序）。
#[tauri::command]
pub fn videos_frame_manifest(
    state: State<AppState>,
    video_id: i64,
) -> Result<Vec<db::FrameManifestEntry>, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let guard = state.db()?;
        let conn = &*guard;
        db::list_frame_manifest(conn, video_id).map_err(|e| e.to_string())
    })();
    crate::error::command_result("videos_frame_manifest", result)
}

/// 单视频帧级进度（抽帧进行中实时回报）。
#[tauri::command]
pub fn videos_frame_progress(
    app: AppHandle,
    video_id: i64,
) -> Result<Option<events::FrameProgress>, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        Ok(indexer::get_frame_progress(&app, video_id))
    })();
    crate::error::command_result("videos_frame_progress", result)
}

/// 通过系统文件选择对话框导入视频文件，返回聚合结果。
#[tauri::command]
pub async fn videos_import(app: AppHandle) -> Result<events::ImportResult, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || import_videos_sync(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("videos_import", result)
}

/// 拖放的真实本地路径可混合文件与目录；目录默认只扫描一次，管理抽屉可明确选择持续监视。
#[tauri::command]
pub async fn videos_import_paths(
    app: AppHandle,
    paths: Vec<String>,
    watch_folders: bool,
) -> Result<events::ImportResult, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || import_paths_sync(&app, paths, watch_folders))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("videos_import_paths", result)
}

fn import_paths_sync(app: &AppHandle, paths: Vec<String>, watch_folders: bool) -> Result<events::ImportResult, String> {
    let mut result = events::ImportResult::default();
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut watching_added = false;
    for path in paths {
        let path = db::normalize_path(&path);
        if !seen.insert(db::path_key(&path)) { continue; }
        let entry = std::path::Path::new(&path);
        if entry.is_file() {
            files.push(path);
        } else if entry.is_dir() {
            let imported = if watch_folders {
                indexer::import_folder(app.clone(), path.clone(), true, true).map(|(result, _)| result)
            } else {
                indexer::import_folder_once(app.clone(), path.clone(), true)
            };
            match imported {
                Ok(imported) => {
                    result.added += imported.added;
                    result.duplicates += imported.duplicates;
                    result.skipped += imported.skipped;
                    result.failed += imported.failed;
                    result.scanned += imported.scanned;
                    result.folders += imported.folders.max(1);
                    if result.first_error.is_none() { result.first_error = imported.first_error; }
                    result.failures.extend(imported.failures);
                    watching_added |= watch_folders;
                }
                Err(error) => {
                    result.failed += 1;
                    if result.first_error.is_none() { result.first_error = Some(error.clone()); }
                    result.failures.push(events::ImportFailure { path, reason: error, folder_id: None });
                }
            }
        } else {
            result.failed += 1;
            if result.first_error.is_none() { result.first_error = Some("拖入的文件或文件夹不存在或无法读取".to_string()); }
            result.failures.push(events::ImportFailure { path, reason: "文件或文件夹不存在或无法读取".to_string(), folder_id: None });
        }
    }
    if !files.is_empty() {
        let imported = indexer::import_files(app.clone(), files, None);
        result.added += imported.added;
        result.duplicates += imported.duplicates;
        result.skipped += imported.skipped;
        result.failed += imported.failed;
        result.scanned += imported.scanned;
        if result.first_error.is_none() { result.first_error = imported.first_error; }
        result.failures.extend(imported.failures);
    }
    if watching_added { watcher::sync_all(app)?; }
    Ok(result)
}

/// 原生对话框与逐文件探测/哈希都是阻塞调用，不能在异步运行时线程上直接跑。
fn import_videos_sync(app: &AppHandle) -> Result<events::ImportResult, String> {
    let files = native_files_dialog(
        app,
        "选择视频文件（可多选）",
        "视频",
        constants::VIDEO_EXTENSIONS,
    );
    if files.is_empty() {
        return Ok(events::ImportResult::default());
    }
    let result = indexer::import_files(app.clone(), files, None);
    logger::info(
        logger::Module::Import,
        "files_completed",
        &format!("added={} duplicates={} skipped={} failed={}", result.added, result.duplicates, result.skipped, result.failed),
    );
    Ok(result)
}

/// 递归导入一个文件夹，但不把它登记为监听目录。
#[tauri::command]
pub async fn videos_import_folder_once(app: AppHandle) -> Result<events::ImportResult, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || import_folder_once_sync(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("videos_import_folder_once", result)
}

fn import_folder_once_sync(app: &AppHandle) -> Result<events::ImportResult, String> {
    let Some(mut dirs) = native_folder_dialog(app, "选择要一次性导入的文件夹（不会持续监视）") else {
        return Ok(events::ImportResult::default());
    };
    let Some(dir) = dirs.pop() else {
        return Ok(events::ImportResult::default());
    };
    let result = indexer::import_folder_once(app.clone(), dir, true)?;
    logger::info(
        logger::Module::Import,
        "folder_completed",
        &format!("scanned={} added={} duplicates={} skipped={} failed={}", result.scanned, result.added, result.duplicates, result.skipped, result.failed),
    );
    Ok(result)
}

/// 通过系统文件选择对话框选择要搜索的图片，返回归一化路径列表（不入库）。
#[tauri::command]
pub async fn videos_import_images(app: AppHandle) -> Result<Vec<String>, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || pick_search_images_sync(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("videos_import_images", result)
}

fn pick_search_images_sync(app: &AppHandle) -> Result<Vec<String>, String> {
    let files = native_files_dialog(
        app,
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
pub async fn videos_reindex(
    app: AppHandle,
    video_ids: Option<Vec<i64>>,
    mode: Option<String>,
) -> Result<events::ReindexResult, crate::error::AppError> {
    let result: Result<_, String> = async {
        // 整库重建要读一遍视频表再批量入队，别占着窗口主线程。
        let count = tauri::async_runtime::spawn_blocking(move || indexer::reindex(app, video_ids, mode))
            .await
            .map_err(|e| e.to_string())?;
        Ok(events::ReindexResult { count })
    }
    .await;
    crate::error::command_result("videos_reindex", result)
}

/// 同步文件夹监听（启动/停止各目录的磁盘监听以匹配启用状态）。
#[tauri::command]
pub fn watcher_sync(app: AppHandle) -> Result<(), crate::error::AppError> {
    let result: Result<_, String> = (|| {
        watcher::sync_all(&app)
    })();
    crate::error::command_result("watcher_sync", result)
}

/// 用户设置（合并默认值）。
#[tauri::command]
pub fn library_settings(state: State<AppState>) -> Result<db::AppSettings, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let guard = state.db()?;
        let conn = &*guard;
        db::get_settings(conn).map_err(|e| e.to_string())
    })();
    crate::error::command_result("library_settings", result)
}

/// 更新用户设置，返回合并后的完整设置。
#[tauri::command]
pub async fn library_update_settings(
    app: AppHandle,
    patch: db::SettingsPatch,
) -> Result<db::AppSettings, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || update_settings_sync(&app, patch))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("library_update_settings", result)
}

/// 关掉「保存索引帧图片」要递归删除整个 frames 目录（可能上百万个小文件），
/// 只能跑在阻塞线程，不能占着窗口主线程。
fn update_settings_sync(app: &AppHandle, patch: db::SettingsPatch) -> Result<db::AppSettings, String> {
    let state = app.state::<AppState>();
    let mut guard = state.db()?;
    let conn = &mut *guard;
    let previous = db::get_settings(conn).map_err(|e| e.to_string())?;
    let updated = db::update_settings(conn, &patch).map_err(|e| e.to_string())?;
    if let Some(mode) = patch.sampling_mode.as_deref() {
        if mode != previous.sampling_mode {
            db::migrate_sampling_on_global_change(conn, &previous.sampling_mode, mode)
                .map_err(|e| e.to_string())?;
        }
    }
    drop(guard);
    // 并发上限缓存进索引器，pump 不再每次入队都读一次设置。
    state
        .indexer
        .lock()
        .map_err(|e| e.to_string())?
        .concurrency = updated.concurrency.clamp(1, 8) as usize;
    // 先撤销后台任务的旧写入代次，再清理目录；之后旧任务无法重新创建帧图。
    frames_store::configure_enabled(updated.keep_frame_images);
    if patch.keep_frame_images == Some(false) && previous.keep_frame_images && frames_store::remove_all() {
        events::emit(
            app,
            events::LibraryEvent::Notice {
                level: "info".to_string(),
                message: "已清空全部索引帧图片".to_string(),
            },
        );
    }
    let _ = watcher::sync_all(app);
    events::emit(
        app,
        events::LibraryEvent::SettingsUpdated { settings: updated.clone() },
    );
    Ok(updated)
}

/// 重置索引库（清空视频/帧/文件夹，保留设置）。
#[tauri::command]
pub async fn library_reset(app: AppHandle) -> Result<(), crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || reset_library_sync(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("library_reset", result)
}

/// 清库要删掉 frames 下的全部目录，跑在阻塞线程；界面只显示一句「正在重置」。
fn reset_library_sync(app: &AppHandle) -> Result<(), String> {
    watcher::stop_all(app)?;
    indexer::cancel_all(app);
    let state = app.state::<AppState>();
    {
        let guard = state.db()?;
        let conn = &*guard;
        db::clear_all(conn).map_err(|e| e.to_string())?;
    }
    // watcher 析构前已进入回调的事件可能刚刚入队；清库后再收口一次。
    indexer::cancel_all(app);
    frames_store::remove_all();
    *state.search_index.lock().map_err(|e| e.to_string())? = search::FrameSearchIndex::new();
    Ok(())
}

/// 打开数据目录（db、logs、frames、session 都在这下面）。
#[tauri::command]
pub fn library_open_database_folder() -> Result<String, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let dir = paths::data_dir();
        let dir_str = dir.to_string_lossy().to_string();
        platform_open::open(&dir)?;
        Ok(dir_str)
    })();
    crate::error::command_result("library_open_database_folder", result)
}

#[tauri::command]
pub fn library_open_ffmpeg_download() -> Result<(), crate::error::AppError> {
    let result: Result<_, String> = (|| {
        platform_open::open_url("https://www.ffmpeg.org/download.html")
    })();
    crate::error::command_result("library_open_ffmpeg_download", result)
}

/// 导出可分享的本地诊断包；只包含脱敏后的运行状态与日志末尾，不含视频或路径清单。
#[tauri::command]
pub async fn library_export_diagnostics(app: AppHandle) -> Result<Option<String>, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || export_diagnostics_sync(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("library_export_diagnostics", result)
}

fn export_diagnostics_sync(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(path) = native_diagnostic_save_dialog(app) else {
        return Ok(None);
    };
    crate::diagnostics::write_archive(app, &path)?;
    if let Some(parent) = path.parent() {
        let _ = platform_open::open(parent);
    }
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 运行时数据目录信息（toolsReady 由媒体探测结果决定）。
#[tauri::command]
pub fn library_data_dir() -> Result<paths::DataDirInfo, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        Ok(paths::data_dir_info(media::tools_ready()))
    })();
    crate::error::command_result("library_data_dir", result)
}

/// FFmpeg/ffprobe 当前探测结果与来源。
#[tauri::command]
pub fn library_media_tools() -> Result<media::MediaToolsStatus, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        Ok(media::tools_status())
    })();
    crate::error::command_result("library_media_tools", result)
}

/// 重查当前环境中的 FFmpeg，并恢复此前因工具缺失而等待的索引任务。
#[tauri::command]
pub async fn library_refresh_media_tools(app: AppHandle) -> Result<media::MediaToolsStatus, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || {
            let was_ready = media::tools_ready();
            let status = media::refresh_tools();
            if !was_ready && status.ready {
                indexer::resume_pending(app);
            }
            Ok(status)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("library_refresh_media_tools", result)
}

/// 选择同时包含 ffmpeg 与 ffprobe 的目录，验证后持久化。
#[tauri::command]
pub async fn library_select_media_tools_dir(app: AppHandle) -> Result<media::MediaToolsStatus, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || select_media_tools_dir_sync(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("library_select_media_tools_dir", result)
}

fn select_media_tools_dir_sync(app: &AppHandle) -> Result<media::MediaToolsStatus, String> {
    let Some(mut dirs) = native_folder_dialog(app, "选择 FFmpeg 的 bin 目录") else {
        return Ok(media::tools_status());
    };
    let Some(dir) = dirs.pop() else {
        return Ok(media::tools_status());
    };
    let was_ready = media::tools_ready();
    let status = media::configure_dir(Some(dir.clone()))?;
    let state = app.state::<AppState>();
    let guard = state.db()?;
    let conn = &*guard;
    db::set_ffmpeg_dir(conn, Some(&dir)).map_err(|e| e.to_string())?;
    drop(guard);
    if !was_ready && status.ready {
        indexer::resume_pending(app.clone());
    }
    logger::info(logger::Module::Media, "tools_directory_set", &format!("dir={dir} source={}", status.source));
    Ok(status)
}

/// 清除手动目录并重新按环境变量 / PATH 自动检测。
#[tauri::command]
pub fn library_clear_media_tools_dir(state: State<AppState>) -> Result<media::MediaToolsStatus, crate::error::AppError> {
    let result: Result<_, String> = (|| {
        let guard = state.db()?;
        let conn = &*guard;
        db::set_ffmpeg_dir(conn, None).map_err(|e| e.to_string())?;
        let status = media::configure_dir(None)?;
        logger::info(logger::Module::Media, "tools_directory_cleared", &format!("source={}", status.source));
        Ok(status)
    })();
    crate::error::command_result("library_clear_media_tools_dir", result)
}

/* ================================================================== */
/* 图片检索：byPath / byDataUrl / byClipboard / byUrl                 */
/* ================================================================== */

/// 从文件检索。
#[tauri::command]
pub async fn search_path(app: AppHandle, file_path: String) -> Result<SearchResponse, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || search_path_sync(&app, file_path))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("search_path", result)
}

fn search_path_sync(app: &AppHandle, file_path: String) -> Result<SearchResponse, String> {
    let img = match image::open(&file_path) {
        Ok(i) => i,
        Err(e) => return Ok(fail_response("decode-failed", &format!("无法读取图片：{e}"))),
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Ok(v) => v,
        Err(e) => return Ok(fail_response("decode-failed", &e)),
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
pub async fn search_data_url(app: AppHandle, data_url: String) -> Result<SearchResponse, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || search_data_url_sync(&app, data_url))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("search_data_url", result)
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
        Ok(v) => v,
        Err(e) => return Ok(fail_response("decode-failed", &e)),
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
pub async fn search_clipboard(app: AppHandle) -> Result<Option<ClipboardSearchResult>, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || search_clipboard_sync(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("search_clipboard", result)
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
            data_url,
            response: fail_response("decode-failed", &format!("无法解码剪贴板图片：{e}")),
        })),
    };
    let (source_width, source_height) = (img.width(), img.height());
    let (buf, w, h) = match prepare_query_image(img) {
        Ok(v) => v,
        Err(e) => return Ok(Some(ClipboardSearchResult {
            data_url,
            response: fail_response("decode-failed", &e),
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
        data_url,
        response,
    }))
}

/// 从 http(s) 链接检索（图片直链或普通网页里解析出的主图）。失败时 error 字段说明原因。
#[tauri::command]
pub async fn search_url(app: AppHandle, url: String) -> Result<SearchResponse, crate::error::AppError> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || search_url_sync(&app, url))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    crate::error::command_result("search_url", result)
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
        Ok(v) => v,
        Err(e) => return Ok(fail_response("decode-failed", &e)),
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
    if filter_name == "视频" {
        dialog = dialog.add_filter("所有文件（由 FFmpeg 验证）", &["*"]);
    }
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
