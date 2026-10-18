//! 文件夹动态监听与变更同步。
//!
//! 使用 notify crate 的 RecommendedWatcher（Windows 走 ReadDirectoryChangesW）。
//! 视频文件新增/覆盖 → 入索引队列；删除 → 从库移除并播报；子目录被删 → 移除其下全部视频。
//! 监听只处理启动后的磁盘变更；初始已有文件由扫描流程负责。

use crate::db;
use crate::events::LibraryEvent;
use crate::frames_store;
use crate::indexer;
use crate::state::AppState;
use notify::event::{EventKind, RemoveKind};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static CHANGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static PENDING_CHANGES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn pending_changes() -> &'static Mutex<HashMap<String, u64>> {
    PENDING_CHANGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn watcher_settings(app: &AppHandle) -> db::AppSettings {
    let state = app.state::<AppState>();
    state
        .db
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|conn| db::get_settings(conn).ok()))
        .unwrap_or_else(db::default_settings)
}

fn forget_pending(path: &str) {
    let key = db::normalize_path(path).to_lowercase();
    if let Ok(mut pending) = pending_changes().lock() {
        pending.remove(&key);
    }
}

/// notify 在文件复制期间会连续发送 Create/Modify。只让最后一个事件在用户配置的
/// 稳定等待期后触发导入，避免对尚未写完的大文件反复 probe/hash。
fn schedule_import(app: &AppHandle, folder_id: i64, path: String) {
    let key = db::normalize_path(&path).to_lowercase();
    let ticket = CHANGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut pending) = pending_changes().lock() {
        pending.insert(key.clone(), ticket);
    }
    let wait_ms = watcher_settings(app).await_write_ms.clamp(0, 60_000) as u64;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(wait_ms));
        let is_latest = pending_changes()
            .lock()
            .ok()
            .and_then(|mut pending| {
                (pending.get(&key) == Some(&ticket)).then(|| pending.remove(&key))
            })
            .is_some();
        if is_latest && Path::new(&path).is_file() {
            indexer::import_files(app, vec![path], Some(folder_id));
        }
    });
}

/// 把当前启用的文件夹同步成实际的监听集合：启动新增、停止已停用/已移除的。
pub fn sync_all(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let folders = {
        let g = state.db.lock().map_err(|e| e.to_string())?;
        let c = g.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
        db::list_folders(c).map_err(|e| e.to_string())?
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
            set_folder_state(app, folder.id, "idle", Some("已暂停监听"));
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
        EventKind::Remove(RemoveKind::File) => {
            for path in &event.paths {
                let p = path.to_string_lossy().to_string();
                if indexer::is_video_file(&p) {
                    forget_pending(&p);
                    if watcher_settings(app).prune_on_delete {
                        remove_by_path(app, &p);
                    }
                }
            }
        }
        EventKind::Remove(RemoveKind::Folder) => {
            for path in &event.paths {
                let p = path.to_string_lossy().to_string();
                if watcher_settings(app).prune_on_delete {
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
    let removed = {
        let g = state.db.lock();
        match g {
            Ok(guard) => match guard.as_ref() {
                Some(c) => match db::find_by_path(c, &norm) {
                    Ok(Some(v)) => db::remove_video(c, v.id).ok().flatten(),
                    _ => None,
                },
                None => None,
            },
            Err(_) => None,
        }
    };
    if let Some(v) = removed {
        frames_store::remove_video(v.id);
        let _ = app.emit(
            "library_event",
            LibraryEvent::VideoRemoved {
                video_id: v.id,
                path: v.path.clone(),
            },
        );
    }
}

/// 移除某目录（含子目录）下的全部视频并逐个播报 video-removed。
fn remove_under(app: &AppHandle, dir: &str) {
    let norm = db::normalize_path(dir);
    let state = app.state::<AppState>();
    let ids = {
        let g = state.db.lock();
        match g {
            Ok(guard) => match guard.as_ref() {
                Some(c) => db::remove_videos_under(c, &norm).unwrap_or_default(),
                None => Vec::new(),
            },
            Err(_) => Vec::new(),
        }
    };
    for id in ids {
        frames_store::remove_video(id);
        let _ = app.emit(
            "library_event",
            LibraryEvent::VideoRemoved {
                video_id: id,
                path: String::new(),
            },
        );
    }
}

fn set_folder_state(app: &AppHandle, folder_id: i64, state_name: &str, message: Option<&str>) {
    let state = app.state::<AppState>();
    let g = state.db.lock();
    if let Ok(guard) = g {
        if let Some(c) = guard.as_ref() {
            let _ = db::update_folder_state(c, folder_id, state_name, message);
            if let Ok(Some(f)) = db::get_folder(c, folder_id) {
                let _ = app.emit(
                    "library_event",
                    LibraryEvent::FolderUpdated { folder: f },
                );
            }
        }
    }
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
