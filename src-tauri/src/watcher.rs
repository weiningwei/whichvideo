//! 文件夹动态监听与变更同步。
//!
//! 使用 notify crate 的 RecommendedWatcher（Windows 走 ReadDirectoryChangesW）。
//! 视频文件新增/覆盖 → 入索引队列；删除 → 从库移除并播报；子目录被删 → 移除其下全部视频。
//! 监听只处理启动后的磁盘变更；初始已有文件由扫描流程负责。

use crate::db;
use crate::events::{self, LibraryEvent};
use crate::frames_store;
use crate::indexer;
use crate::logger;
use crate::state::AppState;
use notify::event::EventKind;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// 等待稳定后再导入的文件（key = path_key）。同一路径的新事件覆盖旧条目，
/// 天然实现 debounce。
struct PendingImport {
    folder_id: i64,
    path: String,
    due: Instant,
}

static PENDING_CHANGES: OnceLock<Mutex<HashMap<String, PendingImport>>> = OnceLock::new();
/// 调度线程是否在跑；与 pending_changes 的插入/清空在同一把锁内检查，
/// 避免「检查为空 → 新事件入队 → 线程退出」丢掉最后一次唤醒。
static SCHEDULER_RUNNING: AtomicBool = AtomicBool::new(false);

fn pending_changes() -> &'static Mutex<HashMap<String, PendingImport>> {
    PENDING_CHANGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn watcher_settings(app: &AppHandle) -> db::AppSettings {
    let state = app.state::<AppState>();
    state
        .db()
        .ok()
        .and_then(|conn| db::get_settings(&conn).ok())
        .unwrap_or_else(db::default_settings)
}

fn forget_pending(path: &str) {
    let key = db::path_key(path);
    if let Ok(mut pending) = pending_changes().lock() {
        pending.remove(&key);
    }
}

/// notify 在文件复制期间会连续发送 Create/Modify。只让最后一个事件在用户配置的
/// 稳定等待期后触发导入，避免对尚未写完的大文件反复 probe/hash。
///
/// 调度由一个常驻线程按 100ms 扫描到期条目，而不是每个事件起一个线程——
/// 复制大目录时事件可达数百条。
fn schedule_import(app: &AppHandle, folder_id: i64, path: String) {
    let wait_ms = watcher_settings(app).await_write_ms.clamp(0, 60_000) as u64;
    let item = PendingImport {
        folder_id,
        path,
        due: Instant::now() + Duration::from_millis(wait_ms),
    };
    let key = db::path_key(&item.path);
    let mut pending = match pending_changes().lock() {
        Ok(pending) => pending,
        Err(_) => return,
    };
    pending.insert(key, item);
    let start = !SCHEDULER_RUNNING.swap(true, Ordering::SeqCst);
    drop(pending);
    if start {
        let app = app.clone();
        std::thread::spawn(move || drain_pending_imports(app));
    }
}

/// 唯一的调度线程：每 100ms 取走到期条目后导入，队列清空即退出。
fn drain_pending_imports(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_millis(100));
        let due: Vec<PendingImport> = {
            let Ok(mut pending) = pending_changes().lock() else { return };
            let now = Instant::now();
            let keys: Vec<String> = pending
                .iter()
                .filter(|(_, item)| item.due <= now)
                .map(|(key, _)| key.clone())
                .collect();
            keys.into_iter()
                .filter_map(|key| pending.remove(&key))
                .collect()
        };
        for item in due {
            if Path::new(&item.path).is_file() {
                let root = {
                    let state = app.state::<AppState>();
                    state.db().ok().and_then(|conn|
                        db::get_folder(&conn, item.folder_id).ok().flatten()
                        .map(|folder| folder.path))
                };
                if root.as_deref().is_some_and(|root| indexer::is_playlist_part(&item.path, root)) {
                    continue;
                }
                indexer::import_files(app.clone(), vec![item.path], Some(item.folder_id));
            }
        }
        // 标记退出与判空必须在同一把锁内完成，否则会漏掉刚入队的条目。
        let exit = {
            let Ok(pending) = pending_changes().lock() else { return };
            if pending.is_empty() {
                SCHEDULER_RUNNING.store(false, Ordering::SeqCst);
                true
            } else {
                false
            }
        };
        if exit {
            return;
        }
    }
}

/// 把当前启用的文件夹同步成实际的监听集合：启动新增、停止已停用/已移除的。
pub fn sync_all(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let folders = {
        let conn = state.db()?;
        db::list_folders(&conn).map_err(|e| e.to_string())?
    };

    // 停止已不需要的监听（移除 map 项即让 watcher 析构停止）。
    {
        let mut map = state.watcher.lock().map_err(|e| e.to_string())?;
        let wanted: std::collections::HashSet<i64> =
            folders.iter().filter(|f| f.enabled).map(|f| f.id).collect();
        let to_stop: Vec<i64> = map
            .keys()
            .cloned()
            .filter(|id| !wanted.contains(id))
            .collect();
        for id in to_stop {
            map.remove(&id);
        }
    }

    for folder in &folders {
        if !folder.enabled {
            if folder.pinned {
                set_folder_state(app, folder.id, "idle", Some("已暂停监听"));
            }
            continue;
        }
        let need_start = {
            let map = state.watcher.lock().map_err(|e| e.to_string())?;
            map.get(&folder.id).is_none()
        };
        if need_start {
            let _ = start(app, folder.id, &folder.path, folder.recursive);
        }
    }
    Ok(())
}

/// 启动单个目录的监听，返回是否成功建立。
fn start(app: &AppHandle, folder_id: i64, path: &str, recursive: bool) -> Result<(), String> {
    if !Path::new(path).exists() {
        set_folder_state(app, folder_id, "missing", Some("目录不存在"));
        return Ok(());
    }
    let app2 = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                handle_event(&app2, folder_id, event);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("监听启动失败：{e}"))?;
    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    watcher
        .watch(Path::new(path), mode)
        .map_err(|e| format!("监听目录失败：{e}"))?;
    {
        let state = app.state::<AppState>();
        let mut map = state.watcher.lock().map_err(|e| e.to_string())?;
        map.insert(folder_id, watcher);
    }
    set_folder_state(app, folder_id, "watching", None);
    Ok(())
}

/// 事件分发：新增/修改 → 入队；删除文件 → 移除；删除目录 → 移除其下全部视频。
fn handle_event(app: &AppHandle, folder_id: i64, event: Event) {
    match event.kind {
        EventKind::Create(_) | EventKind::Modify(_) => {
            for path in &event.paths {
                let p = path.to_string_lossy().to_string();
                if indexer::is_video_file(&p) {
                    let norm = db::normalize_path(&p);
                    schedule_import(app, folder_id, norm);
                }
            }
        }
        EventKind::Remove(_) => {
            if !watcher_settings(app).prune_on_delete {
                return;
            }
            for path in &event.paths {
                let p = path.to_string_lossy().to_string();
                forget_pending(&p);
                if indexer::is_video_file(&p) {
                    remove_by_path(app, &p);
                } else {
                    remove_under(app, &p);
                }
            }
        }
        _ => {}
    }
}

/// 按路径移除单个视频并播报 video-removed。
fn remove_by_path(app: &AppHandle, path: &str) {
    let norm = db::normalize_path(path);
    let state = app.state::<AppState>();
    let existing = {
        let conn = match state.db() {
            Ok(conn) => conn,
            Err(error) => {
                logger::error(logger::Module::Watcher, "database_unavailable", &format!("operation=remove_by_path error={error}"));
                return;
            }
        };
        db::find_by_path(&conn, &norm).ok().flatten()
    };
    let Some(existing) = existing else { return };
    indexer::cancel(app, existing.id);
    let removed = {
        let conn = match state.db() {
            Ok(conn) => conn,
            Err(error) => {
                logger::error(logger::Module::Watcher, "database_unavailable", &format!("operation=remove_by_path error={error}"));
                return;
            }
        };
        db::remove_video(&conn, existing.id).ok().flatten()
    };
    if let Some(v) = removed {
        frames_store::remove_video(v.id);
        events::emit(
            app,
            LibraryEvent::VideoRemoved {
                video_id: v.id,
                path: v.path.clone(),
            },
        );
        if let Ok(mut index) = state.search_index.lock() {
            index.remove_video(v.id);
        }
        indexer::broadcast_stats_now(app);
    }
}

/// 移除某目录（含子目录）下的全部视频并逐个播报 video-removed。
fn remove_under(app: &AppHandle, dir: &str) {
    let norm = db::normalize_path(dir);
    let state = app.state::<AppState>();
    // 删除前先取出 id 与路径：事件里的 path 供界面提示用，删完就查不到了。
    let videos: Vec<(i64, String)> = {
        let conn = match state.db() {
            Ok(conn) => conn,
            Err(error) => {
                logger::error(logger::Module::Watcher, "database_unavailable", &format!("operation=remove_under error={error}"));
                return;
            }
        };
        db::video_ids_under(&conn, &norm)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| {
                db::get_video(&conn, id)
                    .ok()
                    .flatten()
                    .map(|video| (video.id, video.path))
            })
            .collect()
    };
    for (id, _) in &videos {
        indexer::cancel(app, *id);
    }
    {
        let ids: Vec<i64> = videos.iter().map(|(id, _)| *id).collect();
        if let Ok(conn) = state.db() {
            let _ = db::remove_video_ids(&conn, &ids);
        }
    }
    for (id, path) in &videos {
        frames_store::remove_video(*id);
        events::emit(
            app,
            LibraryEvent::VideoRemoved {
                video_id: *id,
                path: path.clone(),
            },
        );
    }
    if !videos.is_empty() {
        state.rebuild_search_index();
        indexer::broadcast_stats_now(app);
    }
}

fn set_folder_state(app: &AppHandle, folder_id: i64, state_name: &str, message: Option<&str>) {
    let state = app.state::<AppState>();
    if let Ok(conn) = state.db() {
        let _ = db::update_folder_state(&conn, folder_id, state_name, message);
        if let Ok(Some(f)) = db::get_folder(&conn, folder_id) {
            events::emit(
                app,
                LibraryEvent::FolderUpdated { folder: f },
            );
        }
    };
}

/// 停止单个目录监听。
pub fn stop(app: &AppHandle, folder_id: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut map = state.watcher.lock().map_err(|e| e.to_string())?;
    map.remove(&folder_id);
    Ok(())
}

/// 停止全部监听（应用退出或重置索引库时调用）。
#[allow(dead_code)]
pub fn stop_all(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut map = state.watcher.lock().map_err(|e| e.to_string())?;
    map.clear();
    Ok(())
}

/// 给 AppState 用：监听句柄集合（移除即停止）。
pub type WatcherMap = HashMap<i64, RecommendedWatcher>;
