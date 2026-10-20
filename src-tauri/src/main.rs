#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod constants;
mod db;
mod diagnostics;
mod events;
mod framepack;
mod frames_store;
mod hash;
mod indexer;
mod logger;
mod media;
mod paths;
mod platform_open;
mod process_ext;
mod sampling;
mod search;
mod state;
mod updater;
mod url_image;
mod watcher;

use state::AppState;
use tauri::Manager;

/// 启动早期还没有窗口和日志，release 又没有控制台：必须弹原生提示，
/// 否则数据目录不可写时用户只会看到「双击没反应」。
fn show_startup_error(app: &tauri::AppHandle, message: &str) {
    use tauri_plugin_dialog::DialogExt;
    eprintln!("[FATAL] {message}");
    let _ = app
        .dialog()
        .message(message)
        .title("WhichVideo 无法启动")
        .blocking_show();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let resolution = match paths::initialize() {
                Ok(resolution) => resolution,
                Err(error) => {
                    show_startup_error(
                        app.handle(),
                        &format!(
                            "数据目录不可用：{error}\n\n请把程序放到当前用户可写的位置，或用 WHICHVIDEO_DATA_DIR 指定一个可写目录。"
                        ),
                    );
                    std::process::exit(1);
                }
            };
            let log_path = logger::init();
            logger::install_panic_hook();
            logger::log(&format!(
                "数据目录：{}（source={}）",
                resolution.dir.display(),
                resolution.source
            ));
            logger::log(&format!("日志文件：{}", log_path.display()));
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .ok_or_else(|| "缺少主窗口配置".to_string())?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                .data_directory(paths::webview_dir())
                .build()?;
            let state = match AppState::try_new() {
                Ok(state) => state,
                Err(error) => {
                    show_startup_error(
                        app.handle(),
                        &format!(
                            "{error}\n\n请先退出程序，把 {} 移走后再试（这样会丢失索引，但不会删除视频文件）。",
                            paths::db_path().display()
                        ),
                    );
                    std::process::exit(1);
                }
            };
            app.manage(state);
            if let Err(error) = watcher::sync_all(app.handle()) {
                logger::log(&format!("[WARN] 恢复文件夹监听失败：{error}"));
            }
            indexer::resume_pending(app.handle().clone());
            updater::start_if_enabled(app.handle());
            logger::log("启动生命周期初始化完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library_stats,
            commands::library_status,
            commands::library_settings,
            commands::library_update_settings,
            commands::library_open_database_folder,
            commands::library_export_diagnostics,
            commands::library_data_dir,
            commands::library_media_tools,
            commands::library_select_media_tools_dir,
            commands::library_clear_media_tools_dir,
            commands::library_reset,
            commands::folders_list,
            commands::folders_add_path,
            commands::folders_remove,
            commands::folders_set_enabled,
            commands::videos_get,
            commands::videos_list,
            commands::videos_thumbnail,
            commands::videos_frame_manifest,
            commands::videos_remove,
            commands::videos_remove_many,
            commands::videos_reveal,
            commands::videos_open,
            commands::videos_match_frame,
            commands::videos_frame_progress,
            commands::folders_rescan,
            commands::folders_add_dialog,
            commands::videos_import,
            commands::videos_import_folder_once,
            commands::videos_import_images,
            commands::videos_reindex,
            commands::videos_find_duplicates,
            commands::watcher_sync,
            commands::search_path,
            commands::search_data_url,
            commands::search_clipboard,
            commands::search_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = watcher::stop_all(app);
                logger::log("应用退出，文件夹监听已停止");
            }
        });
}
