//! Rust 后端日志：GUI 子系统没有可见控制台，关键启动与索引消息必须落盘。

use crate::constants::MAX_LOG_BYTES;
use crate::paths;
use chrono::{DateTime, FixedOffset, Local};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());
static RECENT: LazyLock<Mutex<HashMap<String, RecentEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
const REPEAT_WINDOW: Duration = Duration::from_secs(30);

struct RecentEntry {
    last: Instant,
    suppressed: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Module {
    App,
    Library,
    Import,
    Indexer,
    Search,
    Media,
    Watcher,
    Frames,
    Update,
}

impl Module {
    fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Library => "library",
            Self::Import => "import",
            Self::Indexer => "indexer",
            Self::Search => "search",
            Self::Media => "media",
            Self::Watcher => "watcher",
            Self::Frames => "frames",
            Self::Update => "update",
        }
    }
}

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

fn sanitize(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

fn format_entry_at(level: Level, module: Module, event: &str, details: &str, at: DateTime<FixedOffset>) -> String {
    let event = sanitize(event);
    let details = sanitize(details);
    let suffix = if details.is_empty() { String::new() } else { format!(" | {details}") };
    format!(
        "[{}] [{}] [{}] {event}{suffix}",
        at.format("%Y-%m-%d %H:%M:%S%.3f %:z"),
        level.as_str(),
        module.as_str()
    )
}

pub fn write(level: Level, module: Module, event: &str, details: &str) {
    write_keyed(level, module, event, details, details);
}

fn record_repeat(recent: &mut HashMap<String, RecentEntry>, key: String, now: Instant) -> Option<u32> {
    if let Some(entry) = recent.get_mut(&key) {
        if now.duration_since(entry.last) < REPEAT_WINDOW {
            entry.suppressed = entry.suppressed.saturating_add(1);
            return None;
        }
        let suppressed = entry.suppressed;
        *entry = RecentEntry { last: now, suppressed: 0 };
        return Some(suppressed);
    }
    if recent.len() >= 2048 {
        recent.retain(|_, entry| now.duration_since(entry.last) < REPEAT_WINDOW);
    }
    recent.insert(key, RecentEntry { last: now, suppressed: 0 });
    Some(0)
}

fn write_keyed(level: Level, module: Module, event: &str, repeat_key: &str, details: &str) {
    let key = format!("{}\0{}\0{}\0{}", level.as_str(), module.as_str(), event, repeat_key);
    let suppressed = {
        let Ok(mut recent) = RECENT.lock() else { return };
        let Some(suppressed) = record_repeat(&mut recent, key, Instant::now()) else { return };
        suppressed
    };
    let details = if suppressed == 0 {
        details.to_string()
    } else if details.is_empty() {
        format!("repeated={suppressed}")
    } else {
        format!("{details} repeated={suppressed}")
    };
    let line = format_entry_at(level, module, event, &details, Local::now().fixed_offset());
    eprintln!("{line}");
    let Some(path) = LOG_FILE.get() else { return };
    let Ok(_guard) = LOG_LOCK.lock() else { return };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

pub fn info(module: Module, event: &str, details: &str) {
    write(Level::Info, module, event, details);
}

pub fn warn(module: Module, event: &str, details: &str) {
    write(Level::Warn, module, event, details);
}

pub fn warn_keyed(module: Module, event: &str, repeat_key: &str, details: &str) {
    write_keyed(Level::Warn, module, event, repeat_key, details);
}

pub fn error(module: Module, event: &str, details: &str) {
    write(Level::Error, module, event, details);
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        error(Module::App, "panic", &info.to_string());
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_have_stable_level_module_event_and_one_line_details() {
        let at = DateTime::parse_from_rfc3339("2026-10-21T15:51:36.900+08:00").unwrap();
        assert_eq!(
            format_entry_at(Level::Warn, Module::Import, "scan_failed", "folder=1\nerror=拒绝访问", at),
            "[2026-10-21 15:51:36.900 +08:00] [WARN] [import] scan_failed | folder=1 error=拒绝访问"
        );
    }

    #[test]
    fn identical_entries_are_suppressed_then_reported() {
        let mut recent = HashMap::new();
        let started = Instant::now();
        assert_eq!(record_repeat(&mut recent, "same".into(), started), Some(0));
        assert_eq!(record_repeat(&mut recent, "same".into(), started + Duration::from_secs(1)), None);
        assert_eq!(record_repeat(&mut recent, "same".into(), started + Duration::from_secs(31)), Some(1));
    }

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
