#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod state;

use state::AppState;

fn main() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::library_stats,
            commands::folders_list
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
