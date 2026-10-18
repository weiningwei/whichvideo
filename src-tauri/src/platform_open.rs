//! Native file manager and default-application integration.

use crate::process_ext::CommandNoWindow;
use std::path::Path;
use std::process::Command;

pub fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let mut command = {
        let mut cmd = Command::new("explorer.exe");
        cmd.arg(format!("/select,\"{}\"", path.display()));
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg("-R").arg(path);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path.parent().unwrap_or(path));
        cmd
    };
    command
        .no_window()
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn open(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");
    command
        .no_window()
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn open_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("只允许打开 HTTPS 发布页".to_string());
    }
    #[cfg(windows)]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");
    command
        .no_window()
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
