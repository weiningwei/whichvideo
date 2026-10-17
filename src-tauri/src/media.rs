//! ffmpeg / ffprobe 定位与可定位播放器探测（镜像 Electron src/main/media.ts）。
//!
//! 仅含「探测」能力：工具路径解析、toolsReady、findSeekablePlayer。
//! 实际的抽帧/解码/探测命令由后续模块（M6 的 decodeFrameAt、M7 的 indexer）复用这里的 helpers。

use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Clone)]
#[allow(dead_code)]
pub struct ToolPaths {
    pub ffmpeg: String,
    pub ffprobe: String,
}

static TOOLS: OnceLock<Option<ToolPaths>> = OnceLock::new();

/// 读取一个注册表 REG_SZ 值；键不存在或类型不符返回 None。
#[cfg(windows)]
fn reg_query_string(key: &str, value_name: Option<&str>) -> Option<String> {
    let mut args = vec!["query".to_string(), key.to_string()];
    match value_name {
        Some(v) => {
            args.push("/v".to_string());
            args.push(v.to_string());
        }
        None => args.push("/ve".to_string()),
    }
    let out = std::process::Command::new("reg")
        .args(&args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let m = text.trim().lines().find_map(|line| {
        let m = line.trim().match_indices("REG_SZ").next()?;
        Some(line[m.0 + 6..].trim().to_string())
    })?;
    if m.is_empty() { None } else { Some(m) }
}

#[cfg(not(windows))]
fn reg_query_string(_key: &str, _value_name: Option<&str>) -> Option<String> {
    None
}

/// 在 PATH 中查找可执行文件（Windows 下尝试 .exe/.cmd/.bat 后缀）。
fn which(name: &str) -> Option<String> {
    let path_env = std::env::var("PATH").unwrap_or_default();
    let exts: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat", ""]
    } else {
        &[""]
    };
    for dir in path_env.split(if cfg!(windows) { ';' } else { ':' }) {
        if dir.is_empty() {
            continue;
        }
        for ext in exts {
            let candidate = PathBuf::from(dir).join(format!("{}{}", name, ext));
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// 候选目录：打包资源目录 resources/bin、环境变量、常见安装位置。
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(bin_dir) = std::env::var("WHICHVIDEO_BIN_DIR").ok() {
        dirs.push(PathBuf::from(bin_dir));
    }
    // 资源目录：exe 同级 resources/bin（Tauri 打包后）或开发期 resources/bin。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("resources").join("bin"));
            // 开发期 exe 在 target/.../，资源在仓库 src-tauri/resources/bin。
            if let Some(pp) = parent.parent() {
                dirs.push(pp.join("resources").join("bin"));
            }
        }
    }
    if cfg!(windows) {
        dirs.push(PathBuf::from("C:\\ffmpeg\\bin"));
        dirs.push(PathBuf::from("C:\\Program Files\\ffmpeg\\bin"));
        if let Some(local) = std::env::var("LOCALAPPDATA").ok() {
            dirs.push(PathBuf::from(local).join("Microsoft\\WinGet\\Links"));
        }
        if let Some(user) = std::env::var("USERPROFILE").ok() {
            dirs.push(PathBuf::from(user).join("scoop\\shims"));
        }
        if let Some(programdata) = std::env::var("ProgramData").ok() {
            dirs.push(PathBuf::from(programdata).join("chocolatey\\bin"));
        }
    }
    dirs
}

/// 解析 ffmpeg / ffprobe 路径；结果缓存（与 Electron 行为一致）。
pub fn resolve_tools() -> Option<&'static ToolPaths> {
    TOOLS
        .get_or_init(|| {
            let names = if cfg!(windows) {
                ("ffmpeg.exe", "ffprobe.exe")
            } else {
                ("ffmpeg", "ffprobe")
            };
            let dirs = candidate_dirs();
            let mut ffmpeg: Option<String> = std::env::var("WHICHVIDEO_FFMPEG")
                .ok()
                .filter(|p| PathBuf::from(p).exists());
            let mut ffprobe: Option<String> = std::env::var("WHICHVIDEO_FFPROBE")
                .ok()
                .filter(|p| PathBuf::from(p).exists());

            for dir in &dirs {
                if ffmpeg.is_none() {
                    let c = dir.join(names.0);
                    if c.exists() {
                        ffmpeg = Some(c.to_string_lossy().to_string());
                    }
                }
                if ffprobe.is_none() {
                    let c = dir.join(names.1);
                    if c.exists() {
                        ffprobe = Some(c.to_string_lossy().to_string());
                    }
                }
            }
            if ffmpeg.is_none() {
                ffmpeg = which(names.0);
            }
            if ffprobe.is_none() {
                ffprobe = which(names.1);
            }
            match (ffmpeg, ffprobe) {
                (Some(f), Some(p)) => Some(ToolPaths {
                    ffmpeg: f,
                    ffprobe: p,
                }),
                _ => None,
            }
        })
        .as_ref()
}

/// ffmpeg/ffprobe 是否可用。
pub fn tools_ready() -> bool {
    resolve_tools().is_some()
}

/// 支持「从指定时间点起播」的播放器。
#[allow(dead_code)]
pub struct SeekablePlayer {
    pub exe: String,
    pub name: String,
    pub args: fn(video_path: &str, start_seconds: f64) -> Vec<String>,
}

fn known_seekable() -> &'static [(&'static str, &'static str, fn(&str, f64) -> Vec<String>)] {
    &[
        (
            "mpv.exe",
            "mpv",
            |p: &str, s: f64| vec!["--start=".to_string() + &s.floor().to_string(), p.to_string()],
        ),
        (
            "potplayermini64.exe",
            "PotPlayer",
            |p: &str, s: f64| vec![p.to_string(), "/new".to_string(), "/seek=".to_string() + &s.floor().to_string()],
        ),
        (
            "potplayermini.exe",
            "PotPlayer",
            |p: &str, s: f64| vec![p.to_string(), "/new".to_string(), "/seek=".to_string() + &s.floor().to_string()],
        ),
        (
            "vlc.exe",
            "VLC",
            |p: &str, s: f64| vec!["--start-time=".to_string() + &s.floor().to_string(), p.to_string()],
        ),
    ]
}

fn basename(path: &str) -> String {
    let p = path.replace('\\', "/");
    p.rsplit('/').next().unwrap_or(path).to_lowercase()
}

/// 从文件关联命令模板解析 exe 路径（拒绝含未展开环境变量的模板）。
#[cfg(windows)]
fn exe_from_command_template(cmd: &str) -> Option<String> {
    let without_placeholders = cmd.replace("%1", "").replace("%*", "");
    // 仍含 % 说明存在未展开的环境变量（如 %SystemRoot%），放弃。
    if without_placeholders.contains('%') {
        return None;
    }
    let quoted = cmd.trim().strip_prefix('"').and_then(|rest| {
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    });
    let exe = quoted.unwrap_or_else(|| cmd.trim().split_whitespace().next().unwrap_or("").to_string());
    if exe.to_lowercase().ends_with(".exe") {
        Some(exe)
    } else {
        None
    }
}

/// 读系统对某扩展名的默认打开方式，命中受支持播放器则复用。
#[cfg(windows)]
fn player_from_default_association(video_ext: &str) -> Option<SeekablePlayer> {
    let ext = video_ext.trim_start_matches('.').to_lowercase();
    if ext.is_empty() {
        return None;
    }
    let prog_id = reg_query_string(
        &format!(
            "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.{}\\UserChoice",
            ext
        ),
        Some("ProgId"),
    )
    .or_else(|| reg_query_string(&format!("HKCR\\.{}", ext), None))?;
    let cmd = reg_query_string(&format!("HKCR\\{}\\shell\\open\\command", prog_id), None)?;
    let exe = exe_from_command_template(&cmd)?;
    let known = known_seekable()
        .iter()
        .find(|(name, _, _)| *name == basename(&exe))?;
    Some(SeekablePlayer {
        exe,
        name: known.1.to_string(),
        args: known.2,
    })
}

fn pick_existing(candidates: &[&str]) -> Option<String> {
    for c in candidates {
        if !c.is_empty() && PathBuf::from(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

fn find_potplayer_from_registry() -> Option<String> {
    let keys = [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer64bit",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer64bit",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer",
    ];
    for key in keys {
        for value in ["DisplayIcon", "InstallLocation"] {
            let out = std::process::Command::new("reg")
                .args(["query", key, "/v", value])
                .output()
                .ok()?;
            if !out.status.success() {
                continue;
            }
            let text = String::from_utf8_lossy(&out.stdout);
            let m = text.lines().find_map(|line| {
                let idx = line.trim().find("REG_SZ")?;
                Some(line.trim()[idx + 6..].trim().to_string())
            })?;
            let mut p = m;
            if value == "DisplayIcon" {
                // DisplayIcon 形如 "...PotPlayerMini64.exe,0"
                p = p.replace(",0", "");
            } else {
                p = PathBuf::from(&p)
                    .join("PotPlayerMini64.exe")
                    .to_string_lossy()
                    .to_string();
            }
            if PathBuf::from(&p).exists() {
                return Some(p);
            }
            let alt32 = p.replace("PotPlayerMini64.exe", "PotPlayerMini.exe");
            if PathBuf::from(&alt32).exists() {
                return Some(alt32);
            }
        }
    }
    None
}

/// 找一个支持时间点起播的本地播放器：默认关联 > PATH > 常见安装位置。
/// 都找不到返回 None（调用方退化为系统默认播放器）。
pub fn find_seekable_player(video_path: &str) -> Option<SeekablePlayer> {
    let ext = video_path
        .rsplit('.')
        .next()
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    #[cfg(windows)]
    {
        if let Some(p) = player_from_default_association(&ext) {
            return Some(p);
        }
    }

    if let Some(mpv) =
        which("mpv").or(pick_existing(&["C:\\Program Files\\mpv\\mpv.exe", "C:\\Program Files (x86)\\mpv\\mpv.exe"]))
    {
        return Some(SeekablePlayer {
            exe: mpv,
            name: "mpv".to_string(),
            args: known_seekable()[0].2,
        });
    }

    let potplayer = pick_existing(&[
        "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
        "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini.exe",
        "C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe",
    ])
    .or_else(find_potplayer_from_registry);
    if let Some(p) = potplayer {
        return Some(SeekablePlayer {
            exe: p,
            name: "PotPlayer".to_string(),
            args: known_seekable()[1].2,
        });
    }

    if let Some(vlc) = which("vlc").or(pick_existing(&[
        "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
        "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
    ])) {
        return Some(SeekablePlayer {
            exe: vlc,
            name: "VLC".to_string(),
            args: known_seekable()[3].2,
        });
    }

    None
}
