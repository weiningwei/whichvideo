#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod constants;
mod db;
mod events;
mod framepack;
mod hash;
mod indexer;
mod logger;
mod media;
mod sampling;
mod search;
mod state;
mod watcher;

use state::AppState;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let app_default = app.path().app_data_dir()?;
            #[cfg(windows)]
            let default_dir = std::env::var_os("APPDATA")
                .map(std::path::PathBuf::from)
                .map(|p| p.join("WhichVideo"))
                .unwrap_or(app_default);
            #[cfg(not(windows))]
            let default_dir = app_default;
            let resolution = db::initialize_data_dir(default_dir, !cfg!(debug_assertions))?;
            let log_path = logger::init(&resolution.dir);
            logger::install_panic_hook();
            logger::log(&format!(
                "数据目录：{}（portable={} source={}）",
                resolution.dir.display(),
                resolution.portable,
                resolution.source
            ));
            logger::log(&format!("日志文件：{}", log_path.display()));
            app.manage(AppState::new());
            if let Err(error) = watcher::sync_all(app.handle()) {
                logger::log(&format!("[WARN] 恢复文件夹监听失败：{error}"));
            }
            indexer::resume_pending(app.handle().clone());
            logger::log("启动生命周期初始化完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library_stats,
            commands::library_status,
            commands::library_settings,
            commands::library_update_settings,
            commands::library_open_database_folder,
            commands::library_data_dir,
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
            commands::videos_reveal,
            commands::videos_open,
            commands::videos_match_frame,
            commands::videos_frame_progress,
            commands::folders_rescan,
            commands::folders_add_dialog,
            commands::videos_import,
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
