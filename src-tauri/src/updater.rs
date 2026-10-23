//! 启动后轻量检查 GitHub Releases；失败静默，不参与自动下载或安装。

use crate::constants::{UPDATE_CHECK_DELAY, UPDATE_CHECK_TIMEOUT};
use crate::{db, logger, platform_open, state::AppState};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const UPDATE_URL: &str = "https://api.github.com/repos/weiningwei/whichvideo/releases/latest";

#[derive(Deserialize)]
struct UpdateInfo {
    tag_name: String,
    html_url: String,
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().unwrap_or(0)
        })
        .collect()
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let a = version_parts(latest);
    let b = version_parts(current);
    for index in 0..a.len().max(b.len()) {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

fn fetch_latest() -> Option<UpdateInfo> {
    reqwest::blocking::Client::builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .user_agent("WhichVideo-UpdateCheck")
        .build().ok()?
        .get(UPDATE_URL).send().ok()?
        .error_for_status().ok()?
        .json().ok()
}

fn notify(app: &AppHandle, info: &UpdateInfo, current: &str) {
    let selected = app.dialog()
        .message(format!("当前版本 {current}，新版本 {}。\n是否打开发布页？", info.tag_name))
        .title(format!("发现新版本 {}", info.tag_name))
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    if selected {
        let _ = platform_open::open_url(&info.html_url);
    }
}

fn check_once(app: &AppHandle) {
    let current = env!("CARGO_PKG_VERSION");
    let Some(info) = fetch_latest() else {
        return;
    };
    if !is_newer_version(&info.tag_name, current) {
        return;
    }
    logger::info(
        logger::Module::Update,
        "new_version",
        &format!("current={current} latest={}", info.tag_name),
    );
    notify(app, &info, current);
}

pub fn start_if_enabled(app: &AppHandle) {
    let enabled = {
        let state = app.state::<AppState>();
        let Ok(guard) = state.db.lock() else { return };
        let Some(conn) = guard.as_ref() else { return };
        db::get_settings(conn)
            .map(|settings| settings.update_check)
            .unwrap_or(false)
    };
    if enabled {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(UPDATE_CHECK_DELAY);
            check_once(&app);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_version_comparison_handles_prefixes_and_components() {
        assert!(is_newer_version("v2.10.0", "2.9.9"));
        assert!(is_newer_version("1.0.1", "v1.0"));
        assert!(!is_newer_version("v1.2.0", "1.2"));
        assert!(!is_newer_version("broken", "0.0.0"));
    }
}
