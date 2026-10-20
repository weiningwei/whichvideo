//! Rust 后端日志：GUI 子系统没有可见控制台，关键启动与索引消息必须落盘。

use crate::constants::MAX_LOG_BYTES;
use crate::paths;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn rotate_if_needed(path: &Path, max_bytes: u64) {
    let oversized = fs::metadata(path)
        .map(|m| m.len() > max_bytes)
        .unwrap_or(false);
    if oversized {
        let backup = PathBuf::from(format!("{}.1", path.display()));
        let _ = fs::remove_file(&backup);
        if fs::rename(path, &backup).is_err() && fs::copy(path, &backup).is_ok() {
            let _ = fs::remove_file(path);
        }
    }
}

pub fn init() -> PathBuf {
    let dir = paths::logs_dir();
    let _ = fs::create_dir_all(&dir);
    let path = paths::log_path();
    rotate_if_needed(&path, MAX_LOG_BYTES);
    let _ = LOG_FILE.set(path.clone());
    path
}

fn stamped(message: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("[{millis}] {message}")
}

pub fn log(message: &str) {
    let line = stamped(message);
    eprintln!("{line}");
    let Some(path) = LOG_FILE.get() else { return };
    let Ok(_guard) = LOG_LOCK.lock() else { return };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log(&format!("[PANIC] {info}"));
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_log_rotates_once() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("whichvideo-log-test-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("whichvideo.log");
        fs::write(&path, b"123456").unwrap();
        rotate_if_needed(&path, 4);
        assert!(!path.exists());
        assert_eq!(fs::read(dir.join("whichvideo.log.1")).unwrap(), b"123456");
        let _ = fs::remove_dir_all(dir);
    }
}
