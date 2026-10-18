//! 启动后轻量检查 GitHub Releases；失败静默，不参与自动下载或安装。

use crate::process_ext::CommandNoWindow;
use crate::{db, logger, state::AppState};
use base64::Engine;
use serde::Deserialize;
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Manager};

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

#[cfg(windows)]
fn fetch_latest() -> Option<UpdateInfo> {
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $h=@{{'User-Agent'='WhichVideo-UpdateCheck';'Accept'='application/vnd.github+json'}}; \
         Invoke-RestMethod -Uri '{}' -Headers $h -TimeoutSec 5 | \
         Select-Object tag_name,html_url | ConvertTo-Json -Compress",
        UPDATE_URL
    );
    let output = Command::new("powershell")
        .no_window()
        .args(["-NoProfile", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

#[cfg(not(windows))]
fn fetch_latest() -> Option<UpdateInfo> {
    None
}

#[cfg(windows)]
fn notify(info: &UpdateInfo, current: &str) {
    let payload = format!("{}\n{}\n{}", info.tag_name, current, info.html_url);
    let encoded = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')).Split([char]10); \
         $r=[System.Windows.Forms.MessageBox]::Show(\
           ('当前版本 '+$p[1]+'。新版本可能包含索引加速与问题修复。`n发布页：'+$p[2]), \
           ('发现新版本 '+$p[0]), 'YesNo', 'Information'); \
         if($r -eq 'Yes'){{Start-Process $p[2]}}",
        encoded
    );
    let _ = Command::new("powershell")
        .no_window()
        .args(["-NoProfile", "-STA", "-Command", &script])
        .status();
}

#[cfg(not(windows))]
fn notify(_info: &UpdateInfo, _current: &str) {}

fn check_once() {
    let current = env!("CARGO_PKG_VERSION");
    let Some(info) = fetch_latest() else {
        logger::log("版本检查：未获取到最新版本（网络不可用或限流），静默跳过");
        return;
    };
    if !is_newer_version(&info.tag_name, current) {
        logger::log(&format!("版本检查：已是最新（{current}）"));
        return;
    }
    logger::log(&format!(
        "发现新版本：{}（当前 {current}）",
        info.tag_name
    ));
    notify(&info, current);
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
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(3));
            check_once();
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
