//! ffmpeg / ffprobe 定位、媒体探测、抽帧与播放器能力检查。
//!
//! 仅含「探测」能力：工具路径解析、toolsReady、findSeekablePlayer。
//! 实际的抽帧/解码/探测命令由后续模块（M6 的 decodeFrameAt、M7 的 indexer）复用这里的 helpers。

use crate::constants::{
    FFMPEG_TIMEOUT, FFPROBE_TIMEOUT, MEDIA_POLL_INTERVAL, MEDIA_PROBE_TIMEOUT, SCENE_POLL_INTERVAL,
};
use crate::process_ext::CommandNoWindow;
use crate::sampling::should_use_full_scan;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
#[allow(dead_code)]
pub struct ToolPaths {
    pub ffmpeg: String,
    pub ffprobe: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaToolsStatus {
    pub ready: bool,
    pub source: String,
    pub directory: Option<String>,
    pub configured_directory: Option<String>,
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub message: String,
}

impl Default for MediaToolsStatus {
    fn default() -> Self {
        Self {
            ready: false,
            source: "missing".to_string(),
            directory: None,
            configured_directory: None,
            ffmpeg: None,
            ffprobe: None,
            message: "未找到 FFmpeg。请安装 FFmpeg，或手动选择包含 ffmpeg 和 ffprobe 的 bin 目录。".to_string(),
        }
    }
}

#[derive(Default)]
struct ToolState {
    configured_dir: Option<PathBuf>,
    tools: Option<ToolPaths>,
    status: MediaToolsStatus,
    resolved: bool,
}

static TOOL_STATE: OnceLock<RwLock<ToolState>> = OnceLock::new();

fn tool_state() -> &'static RwLock<ToolState> {
    TOOL_STATE.get_or_init(|| RwLock::new(ToolState::default()))
}

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
        .no_window()
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

fn tool_names() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("ffmpeg.exe", "ffprobe.exe")
    } else {
        ("ffmpeg", "ffprobe")
    }
}

fn paths_in_dir(dir: &std::path::Path) -> Option<ToolPaths> {
    let names = tool_names();
    let ffmpeg = dir.join(names.0);
    let ffprobe = dir.join(names.1);
    if ffmpeg.is_file() && ffprobe.is_file() {
        Some(ToolPaths {
            ffmpeg: ffmpeg.to_string_lossy().to_string(),
            ffprobe: ffprobe.to_string_lossy().to_string(),
        })
    } else {
        None
    }
}

/// PATH 按目录顺序逐个检查，只有同一目录中的完整工具对才会入选。
fn tools_in_path(path_env: &std::ffi::OsStr, usable: impl Fn(&ToolPaths) -> bool) -> Option<ToolPaths> {
    std::env::split_paths(path_env)
        .filter_map(|dir| paths_in_dir(&dir))
        .find(|tools| usable(tools))
}

fn tools_are_usable(tools: &ToolPaths) -> bool {
    let args = ["-version".to_string()];
    [&tools.ffmpeg, &tools.ffprobe].into_iter().all(|path| {
        run_media_command(path, &args, "媒体工具探测", MEDIA_PROBE_TIMEOUT)
            .is_ok_and(|output| output.success)
    })
}

fn status_for(tools: ToolPaths, source: &str, message: &str) -> (Option<ToolPaths>, MediaToolsStatus) {
    let directory = PathBuf::from(&tools.ffmpeg)
        .parent()
        .map(|p| p.to_string_lossy().to_string());
    let status = MediaToolsStatus {
        ready: true,
        source: source.to_string(),
        directory,
        configured_directory: None,
        ffmpeg: Some(tools.ffmpeg.clone()),
        ffprobe: Some(tools.ffprobe.clone()),
        message: message.to_string(),
    };
    (Some(tools), status)
}

fn detect_tools(configured_dir: Option<&std::path::Path>) -> (Option<ToolPaths>, MediaToolsStatus) {
    // 有效的显式环境变量优先；无效时继续尝试手动目录和 PATH，但把原因带到最终提示。
    let mut environment_error: Option<String> = None;
    let mut configured_error: Option<MediaToolsStatus> = None;
    let env_ffmpeg = std::env::var("WHICHVIDEO_FFMPEG").ok().filter(|s| !s.trim().is_empty());
    let env_ffprobe = std::env::var("WHICHVIDEO_FFPROBE").ok().filter(|s| !s.trim().is_empty());
    if env_ffmpeg.is_some() || env_ffprobe.is_some() {
        if let (Some(ffmpeg), Some(ffprobe)) = (env_ffmpeg, env_ffprobe) {
            let tools = ToolPaths { ffmpeg, ffprobe };
            if PathBuf::from(&tools.ffmpeg).is_file()
                && PathBuf::from(&tools.ffprobe).is_file()
                && tools_are_usable(&tools)
            {
                return status_for(tools, "environment", "使用环境变量指定的 FFmpeg");
            }
        }
        environment_error = Some("环境变量 WHICHVIDEO_FFMPEG / WHICHVIDEO_FFPROBE 无效；请同时指定两个有效的可执行文件。".to_string());
    }

    if let Ok(dir) = std::env::var("WHICHVIDEO_BIN_DIR") {
        if let Some(tools) = paths_in_dir(std::path::Path::new(&dir)) {
            if tools_are_usable(&tools) {
                return status_for(tools, "environment", "使用 WHICHVIDEO_BIN_DIR 指定的 FFmpeg");
            }
        }
        environment_error = Some(format!("WHICHVIDEO_BIN_DIR 中未同时找到 ffmpeg 和 ffprobe：{dir}"));
    }

    if let Some(dir) = configured_dir {
        if let Some(tools) = paths_in_dir(dir) {
            if tools_are_usable(&tools) {
                return status_for(tools, "configured", "使用手动设置的 FFmpeg 目录");
            }
        }
        configured_error = Some(MediaToolsStatus {
            source: "configured".to_string(),
            directory: Some(dir.to_string_lossy().to_string()),
            message: "已设置目录中的 ffmpeg / ffprobe 缺失或无法运行，请重新选择。".to_string(),
            ..Default::default()
        });
    }

    if let Some(tools) = std::env::var_os("PATH").and_then(|path| tools_in_path(&path, tools_are_usable)) {
        return status_for(tools, "path", "使用系统 PATH 中的 FFmpeg");
    }

    // Finder 启动的 macOS GUI 应用通常不继承 shell 的 Homebrew PATH。
    #[cfg(target_os = "macos")]
    for directory in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if let Some(tools) = paths_in_dir(std::path::Path::new(directory)) {
            if tools_are_usable(&tools) {
                return status_for(tools, "system", "使用常见安装位置中的 FFmpeg");
            }
        }
    }

    // 开发与测试环境允许复用仓库 resources/bin；release 包不会走此分支，也不再携带它们。
    #[cfg(debug_assertions)]
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for ancestor in parent.ancestors().take(6) {
                if let Some(tools) = paths_in_dir(&ancestor.join("resources").join("bin")) {
                    if tools_are_usable(&tools) {
                        return status_for(tools, "development", "使用开发仓库 resources/bin 中的 FFmpeg");
                    }
                }
            }
        }
    }

    if let Some(status) = configured_error {
        return (None, status);
    }
    let mut status = MediaToolsStatus::default();
    if let Some(message) = environment_error {
        status.message = message;
    }
    (None, status)
}

fn refresh_locked(state: &mut ToolState) {
    let (tools, mut status) = detect_tools(state.configured_dir.as_deref());
    status.configured_directory = state.configured_dir.as_ref().map(|dir| dir.to_string_lossy().into_owned());
    state.tools = tools;
    state.status = status;
    state.resolved = true;
}

/// 数据库打开后载入用户选择的目录，并完成启动探测。
pub fn initialize(configured_dir: Option<String>) {
    let mut state = tool_state().write().unwrap_or_else(|e| e.into_inner());
    state.configured_dir = configured_dir.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    refresh_locked(&mut state);
}

/// 设置或清除手动目录。设置目录时必须同时包含 ffmpeg 与 ffprobe。
pub fn configure_dir(configured_dir: Option<String>) -> Result<MediaToolsStatus, String> {
    let requested = configured_dir.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    if let Some(dir) = requested.as_deref() {
        let Some(tools) = paths_in_dir(dir) else {
            let (ffmpeg, ffprobe) = tool_names();
            return Err(format!("所选目录中未同时找到 {ffmpeg} 和 {ffprobe}，请选择 FFmpeg 的 bin 目录。"));
        };
        if !tools_are_usable(&tools) {
            return Err("所选目录中的 ffmpeg 或 ffprobe 无法运行，请检查文件版本和系统权限。".to_string());
        }
    }
    let mut state = tool_state().write().map_err(|e| e.to_string())?;
    state.configured_dir = requested;
    refresh_locked(&mut state);
    Ok(state.status.clone())
}

pub fn tools_status() -> MediaToolsStatus {
    let mut state = tool_state().write().unwrap_or_else(|e| e.into_inner());
    if !state.resolved {
        refresh_locked(&mut state);
    }
    state.status.clone()
}

/// 用户修改 PATH 或安装媒体工具后，显式清除本进程的探测缓存。
pub fn refresh_tools() -> MediaToolsStatus {
    let mut state = tool_state().write().unwrap_or_else(|e| e.into_inner());
    refresh_locked(&mut state);
    state.status.clone()
}

/// 解析 ffmpeg / ffprobe 路径并缓存结果。
pub fn resolve_tools() -> Option<ToolPaths> {
    let mut state = tool_state().write().unwrap_or_else(|e| e.into_inner());
    if !state.resolved {
        refresh_locked(&mut state);
    }
    state.tools.clone()
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

type SeekableDefinition = (&'static str, &'static str, fn(&str, f64) -> Vec<String>);

fn known_seekable() -> &'static [SeekableDefinition] {
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
    let exe = quoted.unwrap_or_else(|| cmd.split_whitespace().next().unwrap_or("").to_string());
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

#[cfg(windows)]
fn pick_existing(candidates: &[&str]) -> Option<String> {
    for c in candidates {
        if !c.is_empty() && PathBuf::from(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

#[cfg(windows)]
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
                .no_window()
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
    #[cfg(windows)]
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

    #[cfg(not(windows))]
    let _ = video_path;

    if let Some(mpv) = which("mpv").or_else(|| {
        #[cfg(windows)]
        { pick_existing(&["C:\\Program Files\\mpv\\mpv.exe", "C:\\Program Files (x86)\\mpv\\mpv.exe"]) }
        #[cfg(not(windows))]
        { None }
    })
    {
        return Some(SeekablePlayer {
            exe: mpv,
            name: "mpv".to_string(),
            args: known_seekable()[0].2,
        });
    }

    #[cfg(windows)]
    let potplayer = pick_existing(&[
        "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
        "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini.exe",
        "C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe",
    ])
    .or_else(find_potplayer_from_registry);
    #[cfg(windows)]
    if let Some(p) = potplayer {
        return Some(SeekablePlayer {
            exe: p,
            name: "PotPlayer".to_string(),
            args: known_seekable()[1].2,
        });
    }

    if let Some(vlc) = which("vlc").or_else(|| {
        #[cfg(windows)]
        { pick_existing(&[
        "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
        "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
        ]) }
        #[cfg(not(windows))]
        { None }
    }) {
        return Some(SeekablePlayer {
            exe: vlc,
            name: "VLC".to_string(),
            args: known_seekable()[3].2,
        });
    }

    None
}

/**
 * 解码单个时间点的一帧（RGB24 裸像素），转 JPEG dataUrl 返回。
 * 用于搜索结果命中帧预览 / 查看索引帧弹层。失败（文件已删/时间点越界/解码错误）
 * 返回 None 时调用方回退到缩略图。
 *
 * ffmpeg 用 `-ss` 前置快速定位 + `-frames:v 1` 取一帧，scale 到 EXTRACT_WIDTH 宽、
 * h=-2 偶数高，输出 rawvideo（rgb24）。rawvideo 无头，高度由字节数反推：
 * height = len / (width*3)，整除校验保证未缺字节。
 */
#[allow(dead_code)]
pub fn decode_frame_at(file_path: &str, time_ms: i64, width: u32) -> Option<String> {
    let tools = resolve_tools()?;
    let secs = (time_ms as f64 / 1000.0).max(0.0);
    let args = [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-ss",
        &format!("{:.3}", secs),
        "-i",
        file_path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        &format!("scale={}:-2", width),
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-an",
        "-sn",
        "-dn",
        "pipe:1",
    ];
    let args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    let out = run_media_command(&tools.ffmpeg, &args, "ffmpeg", FFMPEG_TIMEOUT).ok()?;
    if !out.success || out.stdout.is_empty() {
        return None;
    }
    let w = width as usize;
    if out.stdout.len() % (w * 3) != 0 {
        return None;
    }
    let h = out.stdout.len() / (w * 3);
    if h == 0 {
        return None;
    }
    let mut buf = Vec::new();
    let mut enc = JpegEncoder::new_with_quality(&mut buf, 80);
    enc.encode(&out.stdout, width, h as u32, ExtendedColorType::Rgb8).ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

/* ================================================================== */
/* 索引器所需的探测、抽帧与哈希能力 */
/* ================================================================== */

/// ffmpeg 单次调用的同步结果。
pub struct FfmpegOutput {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Unix 下把子进程放进独立进程组，使 `terminate_child` 能整组发送信号；
/// 其他平台为 no-op。只杀直接子进程时，`sh -c` 这类包装进程的孙进程会继续
/// 持有 stdout/stderr 管道，读取线程会挂到孙进程自然退出，超时形同虚设。
#[cfg(unix)]
fn set_own_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // pgid 传 0 表示以子进程 pid 作为新进程组 id。
    command.process_group(0);
}

#[cfg(not(unix))]
fn set_own_process_group(_command: &mut Command) {}

/// 终止子进程及其全部后代并回收，避免管道读取线程无限阻塞。
#[cfg(unix)]
fn terminate_child(child: &mut std::process::Child) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    // set_own_process_group 保证 pgid == 子进程 pid；负 pid 代表整个进程组。
    unsafe { kill(-(child.id() as i32), SIGKILL) };
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// 运行媒体子进程并持续读取两个输出管道，防止大输出塞满管道导致假死。
/// 超时后终止子进程，避免损坏媒体或卡死的网络盘永久占住索引槽位。
fn local_only_media_args(args: &[String], label: &str) -> Vec<String> {
    let mut safe_args = Vec::with_capacity(args.len() + 3);
    for (index, arg) in args.iter().enumerate() {
        if arg == "-i" {
            safe_args.extend(["-protocol_whitelist".to_string(), "file,crypto,data,pipe,concat".to_string()]);
        }
        if label == "ffprobe" && index + 1 == args.len() {
            safe_args.extend(["-protocol_whitelist".to_string(), "file,crypto,data,pipe,concat".to_string()]);
        }
        safe_args.push(arg.clone());
    }
    safe_args
}

pub type FrameProgressCallback = Arc<dyn Fn(usize) + Send + Sync>;

fn progress_frame_count(line: &[u8]) -> Option<usize> {
    std::str::from_utf8(line).ok()?.trim().strip_prefix("frame=")?.trim().parse().ok()
}

fn read_stderr_with_progress(reader: impl Read, progress: Option<FrameProgressCallback>) -> std::io::Result<Vec<u8>> {
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line)? != 0 {
        if let (Some(callback), Some(count)) = (progress.as_ref(), progress_frame_count(&line)) {
            callback(count);
        }
        bytes.extend_from_slice(&line);
        line.clear();
    }
    Ok(bytes)
}

fn run_media_command_with_progress(
    executable: &str,
    args: &[String],
    label: &str,
    timeout: Duration,
    progress: Option<FrameProgressCallback>,
) -> Result<FfmpegOutput, String> {
    run_media_command_with_input(executable, args, label, timeout, progress, None)
}

fn run_media_command_with_input(
    executable: &str, args: &[String], label: &str, timeout: Duration,
    progress: Option<FrameProgressCallback>, input: Option<Vec<u8>>,
) -> Result<FfmpegOutput, String> {
    run_media_command_cancellable(executable, args, label, timeout, progress, input, &|| false)
}

fn run_media_command_cancellable(
    executable: &str, args: &[String], label: &str, timeout: Duration,
    progress: Option<FrameProgressCallback>, input: Option<Vec<u8>>,
    cancelled: &dyn Fn() -> bool,
) -> Result<FfmpegOutput, String> {
    if cancelled() { return Err(format!("{label} 已取消")); }
    // 本地媒体（尤其 HLS 清单）可能引用远程资源；探测、抽帧和预览只允许本地协议。
    let safe_args = local_only_media_args(args, label);
    let mut command = Command::new(executable);
    command
        .no_window()
        .args(&safe_args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    set_own_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 {label} 失败：{e}"))?;
    let Some(mut stdout_pipe) = child.stdout.take() else {
        terminate_child(&mut child);
        return Err(format!("无法读取 {label} 输出"));
    };
    let Some(mut stderr_pipe) = child.stderr.take() else {
        terminate_child(&mut child);
        return Err(format!("无法读取 {label} 错误输出"));
    };
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout_pipe.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = std::thread::spawn(move || {
        read_stderr_with_progress(&mut stderr_pipe, progress)
    });
    let input_writer = input.map(|bytes| {
        let mut pipe = child.stdin.take().expect("piped stdin");
        std::thread::spawn(move || std::io::Write::write_all(&mut pipe, &bytes))
    });
    let started = Instant::now();
    let status = loop {
        if cancelled() {
            terminate_child(&mut child);
            if let Some(writer) = input_writer { let _ = writer.join(); }
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!("{label} 已取消"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                terminate_child(&mut child);
                if let Some(writer) = input_writer { let _ = writer.join(); }
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("{label} 超时（已终止）"));
            }
            Ok(None) => std::thread::sleep(MEDIA_POLL_INTERVAL),
            Err(e) => {
                terminate_child(&mut child);
                if let Some(writer) = input_writer { let _ = writer.join(); }
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("等待 {label} 失败：{e}"));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("读取 {label} 输出的线程失败"))?
        .map_err(|e| format!("读取 {label} 输出失败：{e}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("读取 {label} 错误输出的线程失败"))?
        .map_err(|e| format!("读取 {label} 错误输出失败：{e}"))?;
    if let Some(writer) = input_writer {
        let result = writer.join().map_err(|_| format!("写入 {label} 输入的线程失败"))?;
        if status.success() {
            result.map_err(|e| format!("写入 {label} 输入失败：{e}"))?;
        }
    }
    Ok(FfmpegOutput {
        success: status.success(),
        stdout,
        stderr: String::from_utf8_lossy(&stderr).to_string(),
    })
}

fn run_media_command(
    executable: &str,
    args: &[String],
    label: &str,
    timeout: Duration,
) -> Result<FfmpegOutput, String> {
    run_media_command_with_progress(executable, args, label, timeout, None)
}

/// 同步跑一次 ffmpeg，收集 stdout / stderr。失败（进程无法启动）返回 Err。
pub fn run_ffmpeg(args: &[String]) -> Result<FfmpegOutput, String> {
    let tools = resolve_tools().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    run_media_command(&tools.ffmpeg, args, "ffmpeg", FFMPEG_TIMEOUT)
}

fn run_ffmpeg_cancellable(
    args: &[String], progress: Option<FrameProgressCallback>, cancelled: &dyn Fn() -> bool,
) -> Result<FfmpegOutput, String> {
    if cancelled() { return Err("ffmpeg 已取消".to_string()); }
    let tools = resolve_tools().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    run_media_command_cancellable(&tools.ffmpeg, args, "ffmpeg", FFMPEG_TIMEOUT, progress, None, cancelled)
}

fn run_ffmpeg_with_progress(args: &[String], progress: Option<FrameProgressCallback>) -> Result<FfmpegOutput, String> {
    let tools = resolve_tools().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    run_media_command_with_progress(&tools.ffmpeg, args, "ffmpeg", FFMPEG_TIMEOUT, progress)
}

/// 同步跑一次 ffprobe。
pub fn run_ffprobe(args: &[String]) -> Result<FfmpegOutput, String> {
    let tools = resolve_tools().ok_or_else(|| "未找到 ffprobe".to_string())?;
    run_media_command(&tools.ffprobe, args, "ffprobe", FFPROBE_TIMEOUT)
}

/// 探测到的视频基础信息（镜像 VideoProbeInfo）。
#[derive(Clone, Debug, Default)]
pub struct VideoProbeInfo {
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub video_codec: Option<String>,
}

/// 用 ffprobe 解析视频时长/分辨率/编码。镜像 probeVideo。
pub fn probe_video(file_path: &str) -> Result<VideoProbeInfo, String> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-print_format".to_string(),
        "json".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        "-select_streams".to_string(),
        "v:0".to_string(),
        file_path.to_string(),
    ];
    let out = run_ffprobe(&args)?;
    if !out.success {
        if out.stderr.contains("not on whitelist") {
            return Err("播放列表引用了远程片段；仅支持本地文件".to_string());
        }
        return Err(format!("ffprobe 失败：{}", out.stderr.trim()));
    }
    parse_video_probe(&out.stdout)
}

fn parse_video_probe(output: &[u8]) -> Result<VideoProbeInfo, String> {
    let parsed: serde_json::Value = serde_json::from_slice(output)
        .map_err(|e| format!("ffprobe 输出无法解析：{e}"))?;
    let stream = parsed.get("streams").and_then(|s| s.get(0));
    if stream.is_none() {
        return Err("未检测到视频画面".to_string());
    }
    let parse_duration = |raw: Option<&serde_json::Value>| raw
        .and_then(|value| value.as_str())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0);
    let duration = parse_duration(stream.and_then(|s| s.get("duration")))
        .or_else(|| parse_duration(parsed.get("format").and_then(|f| f.get("duration"))));
    let width = stream.and_then(|s| s.get("width").and_then(|w| w.as_i64()));
    let height = stream.and_then(|s| s.get("height").and_then(|h| h.as_i64()));
    if width.unwrap_or(0) <= 0 || height.unwrap_or(0) <= 0 || duration.is_none() {
        return Err("无法确定视频画面或时长；实时流与静态图片不支持入库".to_string());
    }
    let codec = stream
        .and_then(|s| s.get("codec_name").and_then(|c| c.as_str()))
        .map(|c| c.to_string());
    Ok(VideoProbeInfo {
        duration,
        width,
        height,
        video_codec: codec,
    })
}

/// HLS 播放列表只有真的能读到片段、解出画面才算可导入。
pub fn verify_playlist_decode(file_path: &str) -> Result<(), String> {
    let args = vec![
        "-hide_banner", "-v", "error", "-nostdin", "-i", file_path,
        "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-",
    ].into_iter().map(str::to_string).collect::<Vec<_>>();
    let tools = resolve_tools().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    let output = run_media_command(&tools.ffmpeg, &args, "ffmpeg", FFPROBE_TIMEOUT)?;
    if output.success { Ok(()) } else { Err("播放列表的片段无法读取或解码（仅支持本地片段）".to_string()) }
}

/// 抽帧后的一帧原始像素（RGB24）。
#[derive(Clone)]
pub struct FramePixels {
    buffer: Arc<Vec<u8>>,
    start: usize,
    end: usize,
}

impl From<Vec<u8>> for FramePixels {
    fn from(buffer: Vec<u8>) -> Self {
        let end = buffer.len();
        Self { buffer: Arc::new(buffer), start: 0, end }
    }
}

impl std::ops::Deref for FramePixels {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.buffer[self.start..self.end]
    }
}

pub struct RawFrame {
    pub time: f64,
    pub width: u32,
    pub height: u32,
    pub rgb: FramePixels,
}

/// 只缓存独立视频文件。清单/播放列表的外部片段不受自身元数据保护。
/// 修改场景滤镜、时间解析或解码语义时递增版本。
pub fn scene_cache_key(file_path: &str, threshold: f64) -> Option<String> {
    let path = std::path::Path::new(file_path);
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(extension.as_str(), "mp4" | "mkv" | "avi" | "webm" | "flv" | "wmv" | "mpg" | "mpeg" | "ts" | "m2ts") {
        return None;
    }
    let tools = resolve_tools()?;
    scene_cache_key_for_files(path, std::path::Path::new(&tools.ffmpeg), threshold)
}

fn scene_cache_key_for_files(video: &std::path::Path, ffmpeg: &std::path::Path, threshold: f64) -> Option<String> {
    fn identity(path: &std::path::Path) -> Option<(PathBuf, u64, u128)> {
        let canonical = std::fs::canonicalize(path).ok()?;
        let metadata = std::fs::metadata(&canonical).ok()?;
        if !metadata.is_file() { return None; }
        Some((canonical, metadata.len(), metadata.modified().ok()?
            .duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos()))
    }
    serde_json::to_string(&(1u32, threshold.to_bits(), identity(video)?, identity(ffmpeg)?)).ok()
}

/// 检测场景切换时间点（秒，升序）。只有选中的场景帧经过 showinfo；
/// 不输出全帧进度日志（run_ffmpeg 同步等待退出，无法实时消费该进度）。
pub fn detect_scenes(
    file_path: &str,
    threshold: f64,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<f64>, String> {
    let args = vec![
        "-hide_banner".to_string(),
        "-v".to_string(),
        "info".to_string(),
        "-nostdin".to_string(),
        "-hwaccel".to_string(),
        "auto".to_string(),
        "-i".to_string(),
        file_path.to_string(),
        "-vf".to_string(),
        format!("scale=w=160:h=-2,select='gt(scene,{threshold})',showinfo"),
        "-an".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];
    let out = run_ffmpeg_null_output_cancellable(&args, cancelled)?;
    if !out.success {
        return Err(format!(
            "场景检测失败（退出码非 0）：{}",
            out.stderr.trim().chars().take(200).collect::<String>()
        ));
    }
    Ok(parse_scene_times(&out.stderr))
}

/// 场景检测没有 stdout 数据；持续读取 stderr 防止管道塞满，并允许索引取消时终止子进程。
fn run_ffmpeg_null_output_cancellable(
    args: &[String],
    cancelled: impl Fn() -> bool,
) -> Result<FfmpegOutput, String> {
    if cancelled() {
        return Err("场景检测已取消".to_string());
    }
    let tools = resolve_tools().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    // 场景检测和普通探测、抽帧遵循相同的离线边界。本地播放列表即使后来
    // 被改为引用远程片段，也不能借场景检测隐式联网。
    let safe_args = local_only_media_args(args, "ffmpeg");
    let mut command = Command::new(&tools.ffmpeg);
    command
        .no_window()
        .args(&safe_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    set_own_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;
    let mut stderr_pipe = child.stderr.take().ok_or_else(|| "无法读取 ffmpeg 日志".to_string())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr_pipe.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        if cancelled() {
            terminate_child(&mut child);
            let _ = stderr_reader.join();
            return Err("场景检测已取消".to_string());
        }
        if started.elapsed() >= FFMPEG_TIMEOUT {
            terminate_child(&mut child);
            let _ = stderr_reader.join();
            return Err("ffmpeg 超时（已终止）".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(SCENE_POLL_INTERVAL),
            Err(e) => {
                terminate_child(&mut child);
                let _ = stderr_reader.join();
                return Err(format!("等待 ffmpeg 失败：{e}"));
            }
        }
    };
    let stderr = stderr_reader
        .join()
        .map_err(|_| "读取 ffmpeg 日志的线程失败".to_string())?
        .map_err(|e| format!("读取 ffmpeg 日志失败：{e}"))?;
    Ok(FfmpegOutput {
        success: status.success(),
        stdout: Vec::new(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
    })
}

fn parse_scene_times(stderr: &str) -> Vec<f64> {
    let mut times: Vec<f64> = Vec::new();
    for line in stderr.lines() {
        // FFmpeg 给 showinfo 分配的数字取决于前面的滤镜，不能写死为 0。
        if !line.contains("[Parsed_showinfo_") || !line.contains("pts_time:") {
            continue;
        }
        if let Some(m) = line.split("pts_time:").nth(1) {
            if let Some(v) = m
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<f64>().ok())
            {
                if v.is_finite() {
                    times.push(v);
                }
            }
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    times
}

/// 查询图、seek 和全片抽帧共用同一 RGB24 重采样路径。
fn fingerprint_filter(width: u32) -> String {
    format!("format=rgb24,scale=w={width}:h=-2:flags=bilinear+accurate_rnd+bitexact,setsar=1")
}

pub fn prepare_query_pixels(img: image::DynamicImage) -> Result<(Vec<u8>, u32, u32), String> {
    let (width, height) = (img.width(), img.height());
    if width == 0 || height == 0 { return Err("图片尺寸为空".to_string()); }
    let target_width = crate::constants::EXTRACT_WIDTH;
    let args = vec!["-hide_banner".into(), "-v".into(), "info".into(),
        "-f".into(), "rawvideo".into(), "-pixel_format".into(), "rgb24".into(),
        "-video_size".into(), format!("{width}x{height}"), "-i".into(), "pipe:0".into(),
        "-vf".into(), format!("{},showinfo", fingerprint_filter(target_width)),
        "-frames:v".into(), "1".into(), "-pix_fmt".into(), "rgb24".into(),
        "-f".into(), "rawvideo".into(), "pipe:1".into()];
    let tools = resolve_tools().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    let out = run_media_command_with_input(&tools.ffmpeg, &args, "ffmpeg", FFMPEG_TIMEOUT,
        None, Some(img.to_rgb8().into_raw()))?;
    if !out.success { return Err(format!("图片预处理失败：{}", out.stderr)); }
    let (_, target_height) = validate_seek_output(out.stdout.len(), &out.stderr, 1, target_width)?;
    Ok((out.stdout, target_width, target_height))
}

/**
 * 抽帧路径 A：逐点 seek。每个时间点一个 `-ss/-i` 输入，各取第一帧后 concat 成单流
 * 输出（帧序由滤镜图拓扑保证，对齐计划时间点）。镜像 scan.ts::extractAndHashBySeek。
 * 旧 ffmpeg 无 `-fps_mode` 时回退到 concat 后接 setpts（保持 passthrough 语义）。
 */
fn extract_frames_seek(
    file_path: &str,
    timestamps: &[f64],
    width: u32,
    progress: Option<FrameProgressCallback>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<RawFrame>, String> {
    let count = timestamps.len();
    if count == 0 {
        return Ok(Vec::new());
    }
    let w = width;
    let mut inputs: Vec<String> = Vec::with_capacity(count * 4);
    let mut parts: Vec<String> = Vec::with_capacity(count + 1);
    let mut labels: Vec<String> = Vec::with_capacity(count);
    for (i, &timestamp) in timestamps.iter().enumerate() {
        inputs.push("-hwaccel".to_string());
        inputs.push("auto".to_string());
        inputs.push("-ss".to_string());
        inputs.push(format!("{timestamp:.3}"));
        inputs.push("-i".to_string());
        inputs.push(file_path.to_string());
        parts.push(format!("[{}:v]trim=end_frame=1,{}[s{}]", i, fingerprint_filter(w), i));
        labels.push(format!("[s{}]", i));
    }
    parts.push(format!("{}concat=n={}:v=1:a=0,showinfo[out]", labels.join(""), count));
    let filter = parts.join(";");

    let mut args: Vec<String> = vec![
        "-hide_banner".to_string(),
        "-v".to_string(),
        "info".to_string(),
        "-nostdin".to_string(),
    ];
    if progress.is_some() {
        args.extend(["-nostats", "-stats_period", "0.5", "-progress", "pipe:2"].map(str::to_string));
    }
    args.append(&mut inputs);
    args.push("-filter_complex".to_string());
    args.push(filter.clone());
    args.push("-map".to_string());
    args.push("[out]".to_string());
    args.push("-fps_mode".to_string());
    args.push("passthrough".to_string());
    args.push("-pix_fmt".to_string());
    args.push("rgb24".to_string());
    args.push("-f".to_string());
    args.push("rawvideo".to_string());
    args.push("-an".to_string());
    args.push("-sn".to_string());
    args.push("-dn".to_string());
    args.push("pipe:1".to_string());

    let mut out = run_ffmpeg_cancellable(&args, progress.clone(), cancelled)?;
    // 旧 ffmpeg 回退：去掉 -fps_mode，concat 后接 setpts 重排成单调帧号网格。
    if !out.success && unsupported_fps_mode(&out.stderr) {
        let mut retry = args[..args.iter().position(|a| a == "-filter_complex").unwrap()].to_vec();
        let mut fb = parts.clone();
        let last = fb.len() - 1;
        fb[last] = format!(
            "{}concat=n={}:v=1:a=0,setpts=N/FRAME_RATE/TB,showinfo[out]",
            labels.join(""),
            count
        );
        retry.push("-filter_complex".to_string());
        retry.push(fb.join(";"));
        retry.push("-map".to_string());
        retry.push("[out]".to_string());
        retry.push("-pix_fmt".to_string());
        retry.push("rgb24".to_string());
        retry.push("-f".to_string());
        retry.push("rawvideo".to_string());
        retry.push("-an".to_string());
        retry.push("-sn".to_string());
        retry.push("-dn".to_string());
        retry.push("pipe:1".to_string());
        out = run_ffmpeg_cancellable(&retry, progress, cancelled)?;
    }
    if !out.success {
        return Err(format!("抽帧失败：{}", out.stderr.trim()));
    }
    // showinfo 只用于校验尺寸和帧数；seek 帧时间仍来自计划，不能使用 concat 的 PTS。
    let (frame_size, height) = validate_seek_output(out.stdout.len(), &out.stderr, count, w)?;

    let pixels = Arc::new(out.stdout);
    let mut frames = Vec::with_capacity(count);
    for (i, &time) in timestamps.iter().enumerate() {
        let rgb = FramePixels { buffer: pixels.clone(), start: i * frame_size, end: (i + 1) * frame_size };
        frames.push(RawFrame {
            time,
            width: w,
            height: height as u32,
            rgb,
        });
    }
    Ok(frames)
}

fn unsupported_fps_mode(stderr: &str) -> bool {
    stderr.contains("Unrecognized option 'fps_mode'")
        || stderr.contains("Option fps_mode not found")
}

fn validate_seek_output(bytes: usize, stderr: &str, count: usize, width: u32) -> Result<(usize, u32), String> {
    let (times, actual_width, height) = parse_showinfo(stderr);
    let frame_size = (actual_width as usize).checked_mul(height as usize)
        .and_then(|n| n.checked_mul(3))
        .ok_or_else(|| "抽帧尺寸溢出".to_string())?;
    if count == 0 || actual_width != width || height == 0 || times.len() != count
        || frame_size.checked_mul(count) != Some(bytes)
    {
        return Err(format!("抽帧不完整：计划 {count} 帧，实际 {} 帧，尺寸 {actual_width}x{height}，收到 {bytes} 字节", times.len()));
    }
    Ok((frame_size, height))
}

/**
 * 抽帧路径 B：单次全片解码 + `fps=N/时长` 均匀采样；原始像素缓冲随帧数增加。
 * 镜像 media.ts::extractFrames：用 showinfo 拿真实输出帧的 w/h 与 pts_time。
 */
fn extract_frames_full_scan(
    file_path: &str,
    timestamps: &[f64],
    duration: Option<f64>,
    width: u32,
    progress: Option<FrameProgressCallback>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<RawFrame>, String> {
    let count = timestamps.len();
    if count == 0 {
        return Ok(Vec::new());
    }
    let dur = duration.unwrap_or_else(|| timestamps[count - 1] * 2.0).max(0.001);
    let rate = count as f64 / dur;
    let mut args = vec![
        "-hide_banner".to_string(),
        "-v".to_string(),
        "info".to_string(),
        "-nostdin".to_string(),
        "-hwaccel".to_string(),
        "auto".to_string(),
        "-i".to_string(),
        file_path.to_string(),
        "-vf".to_string(),
        format!("fps={:.8},{},showinfo", rate, fingerprint_filter(width)),
        "-frames:v".to_string(),
        count.to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-an".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
        "pipe:1".to_string(),
    ];
    if progress.is_some() {
        args.splice(4..4, ["-nostats", "-stats_period", "0.5", "-progress", "pipe:2"].map(str::to_string));
    }
    let out = run_ffmpeg_cancellable(&args, progress, cancelled)?;
    if !out.success {
        return Err(format!("ffmpeg 抽帧失败：{}", out.stderr.trim()));
    }
    let (frame_size, output_height, real_times) =
        validate_full_scan_output(out.stdout.len(), &out.stderr, count, width)?;
    let pixels = Arc::new(out.stdout);
    let mut frames = Vec::with_capacity(count);
    for i in 0..count {
        let rgb = FramePixels { buffer: pixels.clone(), start: i * frame_size, end: (i + 1) * frame_size };
        let time = real_times[i];
        frames.push(RawFrame {
            time,
            width,
            height: output_height,
            rgb,
        });
    }
    Ok(frames)
}

fn validate_full_scan_output(
    bytes: usize,
    stderr: &str,
    count: usize,
    width: u32,
) -> Result<(usize, u32, Vec<f64>), String> {
    let (times, actual_width, height) = parse_showinfo(stderr);
    let frame_size = (actual_width as usize).checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or_else(|| "全片抽帧尺寸溢出".to_string())?;
    let expected_bytes = frame_size.checked_mul(count)
        .ok_or_else(|| "全片抽帧输出大小溢出".to_string())?;
    if count == 0 || actual_width != width || height == 0 || times.len() != count
        || frame_size == 0 || expected_bytes != bytes
    {
        return Err(format!(
            "全片抽帧不完整：计划 {count} 帧，实际 {} 帧，尺寸 {actual_width}x{height}，收到 {bytes} 字节",
            times.len()
        ));
    }
    Ok((frame_size, height, times))
}

/// showinfo 的尺寸字段是 `s:320x180`（不是 w:/h:）。返回最后一次看到的
/// 输出尺寸，以及各输出帧的真实时间戳。
fn parse_showinfo(stderr: &str) -> (Vec<f64>, u32, u32) {
    let mut real_times: Vec<f64> = Vec::new();
    let mut last_width = 0u32;
    let mut last_height = 0u32;
    for line in stderr.lines() {
        if line.contains("pts_time:") {
            if let Some(m) = line.split("pts_time:").nth(1) {
                if let Some(v) = m.split_whitespace().next().and_then(|s| s.parse::<f64>().ok()) {
                    if v.is_finite() {
                        real_times.push(v);
                    }
                }
            }
        }
        if let Some(size) = line
            .split_whitespace()
            .find_map(|field| field.strip_prefix("s:"))
        {
            if let Some((w, h)) = size.split_once('x') {
                if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                    last_width = w;
                    last_height = h;
                }
            }
        }
    }
    (real_times, last_width, last_height)
}

/// 按帧数 / 时间点选择抽帧路径并抽取，返回带时间点的 RGB24 帧。
pub fn extract_and_hash_frames(
    file_path: &str,
    timestamps: &[f64],
    duration: Option<f64>,
    width: Option<i64>,
    height: Option<i64>,
    force_seek: bool,
) -> Result<Vec<RawFrame>, String> {
    extract_and_hash_frames_with_progress(file_path, timestamps, duration, width, height, force_seek, None, &|| false)
}

pub fn extract_and_hash_frames_with_progress(
    file_path: &str,
    timestamps: &[f64],
    duration: Option<f64>,
    width: Option<i64>,
    height: Option<i64>,
    force_seek: bool,
    progress: Option<FrameProgressCallback>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<RawFrame>, String> {
    if force_seek || !should_use_full_scan(timestamps.len(), width, height) {
        extract_frames_seek(file_path, timestamps, crate::constants::EXTRACT_WIDTH, progress, cancelled)
    } else {
        extract_frames_full_scan(file_path, timestamps, duration, crate::constants::EXTRACT_WIDTH, progress, cancelled)
    }
}

/// 生成缩略图（mjpeg 字节），失败时返回 None。time_seconds 为视频内位置。
pub fn make_thumbnail(file_path: &str, time_seconds: f64, width: u32) -> Option<Vec<u8>> {
    let args = vec![
        "-hide_banner".to_string(),
        "-v".to_string(),
        "error".to_string(),
        "-nostdin".to_string(),
        "-ss".to_string(),
        format!("{:.3}", time_seconds.max(0.0)),
        "-i".to_string(),
        file_path.to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        format!("scale={}:-2", width),
        "-q:v".to_string(),
        "6".to_string(),
        "-f".to_string(),
        "image2".to_string(),
        "-c:v".to_string(),
        "mjpeg".to_string(),
        "pipe:1".to_string(),
    ];
    let out = run_ffmpeg(&args).ok()?;
    if out.success && !out.stdout.is_empty() {
        Some(out.stdout)
    } else {
        None
    }
}

/// 文件 SHA-256（流式分块读取，大文件不全量进内存）。镜像 sha256OfFile。
pub fn sha256_of_file(file_path: &str) -> Result<String, String> {
    use std::fs::File;
    use std::io::BufReader;
    let file = File::open(file_path).map_err(|e| format!("打开文件失败：{e}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    // Tauri async command / 索引工作线程的栈通常只有约 2 MiB；4 MiB 固定数组会在
    // 导入阶段刚开始计算文件哈希时触发 Windows 0xc00000fd（栈溢出），进程直接退出。
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("读取文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(format!("{:x}", digest))
}

#[cfg(test)]
mod tests {
    use super::{detect_scenes, local_only_media_args, parse_scene_times, parse_showinfo, parse_video_probe, read_stderr_with_progress, resolve_tools, run_ffmpeg_null_output_cancellable, run_media_command, sha256_of_file, FrameProgressCallback};
    use std::sync::Arc;

    #[test]
    fn path_lookup_uses_a_usable_pair_from_one_directory() {
        let root = std::env::temp_dir().join(format!(
            "whichvideo-tools-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let first = root.join("ffmpeg-only");
        let second = root.join("ffprobe-only");
        let broken = root.join("broken-pair");
        let valid = root.join("valid-pair");
        for dir in [&first, &second, &broken, &valid] {
            fs::create_dir_all(dir).unwrap();
        }
        let (ffmpeg, ffprobe) = super::tool_names();
        fs::write(first.join(ffmpeg), []).unwrap();
        fs::write(second.join(ffprobe), []).unwrap();
        for dir in [&broken, &valid] {
            fs::write(dir.join(ffmpeg), []).unwrap();
            fs::write(dir.join(ffprobe), []).unwrap();
        }
        let path = std::env::join_paths([&first, &second, &broken, &valid]).unwrap();
        let selected = super::tools_in_path(&path, |tools| tools.ffmpeg != broken.join(ffmpeg).to_string_lossy()).unwrap();
        assert_eq!(selected.ffmpeg, valid.join(ffmpeg).to_string_lossy());
        assert_eq!(selected.ffprobe, valid.join(ffprobe).to_string_lossy());
        let split_only = std::env::join_paths([&first, &second]).unwrap();
        assert!(super::tools_in_path(&split_only, |_| true).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    /// FFmpeg 生成的可复现边界媒体；由 pnpm test:media:edge 显式运行。
    #[test]
    #[ignore]
    fn media_edge_cases() {
        let root = std::path::PathBuf::from(std::env::var("WHICHVIDEO_MEDIA_EDGE_DIR").expect("缺少边界媒体目录"));
        fs::create_dir_all(&root).unwrap();
        let tools = resolve_tools().expect("需要 FFmpeg 和 ffprobe");
        let generate = |name: &str, args: &[&str]| {
            let path = root.join(name);
            let mut command: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
            command.extend(["-y".to_string(), path.to_string_lossy().into_owned()]);
            let output = run_media_command(&tools.ffmpeg, &command, "ffmpeg", Duration::from_secs(30)).unwrap();
            assert!(output.success, "生成 {name} 失败：{}", output.stderr);
            path
        };
        let base = generate("base.mp4", &[
            "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=10:duration=2",
            "-c:v", "mpeg4",
        ]);
        let base_name = base.to_string_lossy().into_owned();
        let help = run_media_command(&tools.ffmpeg, &["-hide_banner", "-h", "full"].map(str::to_string), "ffmpeg", Duration::from_secs(10)).unwrap();
        let rotated = if String::from_utf8_lossy(&help.stdout).contains("-display_rotation") {
            generate("rotated.mp4", &["-hide_banner", "-v", "error", "-display_rotation", "90", "-i", &base_name, "-c", "copy"])
        } else {
            generate("rotated.mp4", &["-hide_banner", "-v", "error", "-i", &base_name, "-c", "copy", "-metadata:s:v:0", "rotate=90"])
        };
        let vfr = generate("variable-rate.mkv", &[
            "-hide_banner", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=5:duration=1",
            "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=12:duration=1",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
            "-vsync", "vfr", "-enc_time_base", "1:1000", "-c:v", "mpeg4",
        ]);
        let long = generate("sparse-long.mp4", &[
            "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=64x36:rate=1/600",
            "-frames:v", "7", "-c:v", "mpeg4",
        ]);
        let unicode = root.join("中文 空格 [测试].mp4");
        fs::copy(&base, &unicode).unwrap();
        let empty = root.join("empty.mp4");
        fs::write(&empty, []).unwrap();
        let damaged = root.join("truncated.mp4");
        let original = fs::read(&base).unwrap();
        fs::write(&damaged, &original[..original.len() / 2]).unwrap();

        for path in [&empty, &damaged] {
            assert!(super::probe_video(&path.to_string_lossy()).is_err(), "{} should be rejected", path.display());
        }
        for path in [&base, &rotated, &vfr, &unicode] {
            let path = path.to_string_lossy();
            let probe = super::probe_video(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
            let duration = probe.duration.unwrap();
            assert!(duration >= 1.0, "{path}: {duration}");
            let frames = super::extract_and_hash_frames(&path, &[0.2, 0.8], probe.duration, probe.width, probe.height, true).unwrap();
            assert_eq!(frames.len(), 2, "{path}");
            assert!(frames.iter().all(|frame| !frame.rgb.is_empty()));
            if path == rotated.to_string_lossy() {
                assert!(frames[0].height > frames[0].width, "rotation was not applied to extracted pixels");
            }
        }
        let long_name = long.to_string_lossy();
        let probe = super::probe_video(&long_name).unwrap();
        assert!(probe.duration.unwrap() >= 3600.0, "long sample duration: {:?}", probe.duration);
        assert!(fs::metadata(&long).unwrap().len() < 100_000, "long sample should stay sparse");
        let frames = super::extract_and_hash_frames(&long_name, &[600.0, 3000.0], probe.duration, probe.width, probe.height, true).unwrap();
        assert_eq!(frames.len(), 2);

        let pts_args = ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", vfr.to_str().unwrap()].map(str::to_string);
        let pts = run_media_command(&tools.ffprobe, &pts_args, "ffprobe", Duration::from_secs(10)).unwrap();
        assert!(pts.success);
        let timestamps: Vec<f64> = String::from_utf8_lossy(&pts.stdout).lines().filter_map(|line| line.trim().parse().ok()).collect();
        assert!(timestamps.windows(2).any(|pair| pair[1] - pair[0] > 0.15));
        assert!(timestamps.windows(2).any(|pair| pair[1] - pair[0] < 0.1));

        let rotation_args = ["-v", "error", "-print_format", "json", "-show_streams", rotated.to_str().unwrap()].map(str::to_string);
        let rotation = run_media_command(&tools.ffprobe, &rotation_args, "ffprobe", Duration::from_secs(10)).unwrap();
        assert!(rotation.success);
        let metadata: serde_json::Value = serde_json::from_slice(&rotation.stdout).unwrap();
        assert!(metadata.to_string().contains("rotation") && metadata.to_string().contains("90"), "rotation metadata missing: {metadata}");
    }

    #[test]
    fn query_seek_and_full_scan_produce_identical_pixels() {
        if resolve_tools().is_none() { return; }
        for (width, height) in [(640, 358), (101, 67), (50, 89)] {
            let pixels: Vec<u8> = (0..width * height * 3).map(|i| ((i * 37 + i / 13) % 256) as u8).collect();
            let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(width, height, pixels.clone()).unwrap());
            let query = super::prepare_query_pixels(img).unwrap();
            let path = std::env::temp_dir().join(format!("whichvideo-preprocess-{}-{width}.nut", std::process::id()));
            let args = ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size",
                &format!("{width}x{height}"), "-framerate", "1", "-i", "pipe:0", "-c:v", "rawvideo", "-y",
                path.to_str().unwrap()].map(str::to_string);
            let tools = resolve_tools().unwrap();
            let generated = super::run_media_command_with_input(&tools.ffmpeg, &args, "ffmpeg",
                Duration::from_secs(10), None, Some(pixels)).unwrap();
            assert!(generated.success, "{}", generated.stderr);
            let seek = super::extract_frames_seek(path.to_str().unwrap(), &[0.0], 320, None, &|| false);
            let scan = super::extract_frames_full_scan(path.to_str().unwrap(), &[0.0], Some(1.0), 320, None, &|| false);
            let _ = fs::remove_file(path);
            for frames in [seek.unwrap(), scan.unwrap()] {
                assert_eq!(frames.len(), 1);
                assert_eq!((frames[0].width, frames[0].height), (query.1, query.2));
                assert_eq!(&*frames[0].rgb, query.0.as_slice());
            }
        }
    }

    #[test]
    fn seek_extraction_validates_real_ffmpeg_output() {
        if resolve_tools().is_none() { return; }
        let path = std::env::temp_dir().join(format!("whichvideo-seek-{}.nut", std::process::id()));
        let args = ["-v", "error", "-f", "lavfi", "-i",
            "testsrc2=size=64x36:rate=10:duration=1", "-c:v", "rawvideo", "-y",
            path.to_str().unwrap()].map(str::to_string);
        let generated = super::run_ffmpeg_with_progress(&args, None).unwrap();
        assert!(generated.success, "{}", generated.stderr);
        let frames = super::extract_frames_seek(path.to_str().unwrap(), &[0.1, 0.5], 64, None, &|| false).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!((frames[0].width, frames[0].height), (64, 36));
        assert_eq!(frames[1].time, 0.5);
        let missing = super::extract_frames_seek(path.to_str().unwrap(), &[0.1, 2.0], 64, None, &|| false);
        let _ = fs::remove_file(path);
        assert!(missing.is_err());
    }

    #[test]
    fn seek_output_rejects_missing_or_truncated_frames() {
        let one = "[Parsed_showinfo_2 @ x] n:0 pts_time:0 s:320x180\n";
        let two = format!("{one}{one}");
        assert_eq!(super::validate_seek_output(320 * 180 * 3 * 2, &two, 2, 320).unwrap(), (320 * 180 * 3, 180));
        // 曾被误拆成两张 320x90 的图。
        assert!(super::validate_seek_output(320 * 180 * 3, one, 2, 320).is_err());
        assert!(super::validate_seek_output(320 * 180 * 3, &two, 2, 320).is_err());
        assert!(super::validate_seek_output(320 * 180 * 3 * 2, "", 2, 320).is_err());
        assert!(super::unsupported_fps_mode("Unrecognized option 'fps_mode'."));
        assert!(!super::unsupported_fps_mode("Error while decoding stream"));
    }

    #[test]
    fn full_scan_output_requires_exact_frames_dimensions_and_bytes() {
        let one = "[Parsed_showinfo_2 @ x] n:0 pts_time:0 s:320x180\n";
        let two = format!("{one}[Parsed_showinfo_2 @ x] n:1 pts_time:1 s:320x180\n");
        let bytes = 320 * 180 * 3 * 2;
        let valid = super::validate_full_scan_output(bytes, &two, 2, 320).unwrap();
        assert_eq!((valid.0, valid.1, valid.2), (320 * 180 * 3, 180, vec![0.0, 1.0]));
        assert!(super::validate_full_scan_output(bytes, one, 2, 320).is_err());
        assert!(super::validate_full_scan_output(bytes - 1, &two, 2, 320).is_err());
        assert!(super::validate_full_scan_output(bytes + 1, &two, 2, 320).is_err());
        assert!(super::validate_full_scan_output(bytes, &two, 2, 640).is_err());
        assert!(super::validate_full_scan_output(bytes, "", 2, 320).is_err());
    }

    #[test]
    fn frame_pixels_share_output_without_mixing_adjacent_frames() {
        let buffer = Arc::new(vec![1, 2, 3, 4, 5, 6]);
        let first = super::FramePixels { buffer: buffer.clone(), start: 0, end: 3 };
        let second = super::FramePixels { buffer: buffer.clone(), start: 3, end: 6 };
        assert_eq!(&*first, &[1, 2, 3]);
        assert_eq!(&*second, &[4, 5, 6]);
        assert!(Arc::ptr_eq(&first.buffer, &second.buffer));
    }

    #[test]
    fn ffmpeg_progress_reader_reports_frames_without_losing_diagnostics() {
        let reported = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = reported.clone();
        let callback: FrameProgressCallback = Arc::new(move |count| captured.lock().unwrap().push(count));
        let stderr = b"[info] decoding\nframe=1\nout_time_us=500000\nprogress=continue\nframe= 12 \nprogress=end\n";
        let output = read_stderr_with_progress(&stderr[..], Some(callback)).unwrap();
        assert_eq!(output, stderr);
        assert_eq!(*reported.lock().unwrap(), vec![1, 12]);
    }

    #[test]
    fn probe_rejects_files_without_a_finite_video() {
        assert!(parse_video_probe(br#"{"streams":[],"format":{"duration":"20"}}"#).is_err());
        assert!(parse_video_probe(br#"{"streams":[{"width":640,"height":360}],"format":{}}"#).is_err());
        assert!(parse_video_probe(br#"{"streams":[{"width":640,"height":360}],"format":{"duration":"NaN"}}"#).is_err());
        assert_eq!(parse_video_probe(br#"{"streams":[{"width":640,"height":360,"codec_name":"h264"}],"format":{"duration":"12.5"}}"#).unwrap().duration, Some(12.5));
        assert_eq!(parse_video_probe(br#"{"streams":[{"width":640,"height":360,"duration":"N/A"}],"format":{"duration":"12.5"}}"#).unwrap().duration, Some(12.5));
    }

    #[test]
    fn local_media_cannot_fetch_remote_segments_during_probe_or_decode() {
        let probe = ["-v", "error", "C:\\Videos\\clip.M3U8"].map(str::to_string);
        assert_eq!(local_only_media_args(&probe, "ffprobe"),
            ["-v", "error", "-protocol_whitelist", "file,crypto,data,pipe,concat", "C:\\Videos\\clip.M3U8"].map(str::to_string));
        let decode = ["-ss", "1", "-i", "C:\\Videos\\clip.m3u8", "-f", "null", "-"].map(str::to_string);
        assert_eq!(local_only_media_args(&decode, "ffmpeg"),
            ["-ss", "1", "-protocol_whitelist", "file,crypto,data,pipe,concat", "-i", "C:\\Videos\\clip.m3u8", "-f", "null", "-"].map(str::to_string));
        let scene = ["-hwaccel", "auto", "-i", "C:\\Videos\\clip.m3u8", "-vf", "select='gt(scene,0.3)'", "-f", "null", "-"].map(str::to_string);
        assert_eq!(local_only_media_args(&scene, "ffmpeg"),
            ["-hwaccel", "auto", "-protocol_whitelist", "file,crypto,data,pipe,concat", "-i", "C:\\Videos\\clip.m3u8", "-vf", "select='gt(scene,0.3)'", "-f", "null", "-"].map(str::to_string));
    }
    use std::fs;
    use std::time::{Duration, Instant};

    #[test]
    fn cancelled_scene_detection_does_not_start_ffmpeg() {
        assert_eq!(detect_scenes("missing.mp4", 0.3, || true).unwrap_err(), "场景检测已取消");
    }

    #[test]
    fn scene_cache_identity_tracks_inputs_tools_and_detection_parameters() {
        let root = std::env::temp_dir().join(format!("whichvideo-scene-key-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let video = root.join("video.mp4");
        let tool = root.join("ffmpeg");
        fs::write(&video, b"video").unwrap();
        fs::write(&tool, b"tool").unwrap();
        let key = super::scene_cache_key_for_files(&video, &tool, 0.3).unwrap();
        assert_eq!(super::scene_cache_key_for_files(&video, &tool, 0.3), Some(key.clone()));
        assert_ne!(super::scene_cache_key_for_files(&video, &tool, 0.4), Some(key.clone()));
        let modified = fs::metadata(&video).unwrap().modified().unwrap();
        fs::File::options().write(true).open(&video).unwrap().set_times(
            fs::FileTimes::new().set_modified(modified + Duration::from_secs(2))).unwrap();
        assert_ne!(super::scene_cache_key_for_files(&video, &tool, 0.3), Some(key));
        let key = super::scene_cache_key_for_files(&video, &tool, 0.3).unwrap();
        fs::write(&tool, b"updated tool").unwrap();
        assert_ne!(super::scene_cache_key_for_files(&video, &tool, 0.3), Some(key));
        assert!(super::scene_cache_key("playlist.m3u8", 0.3).is_none());
        assert!(super::scene_cache_key("playlist.m3u", 0.3).is_none());
        assert!(super::scene_cache_key("external-reference.mov", 0.3).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_extraction_does_not_start_ffmpeg() {
        for force_seek in [true, false] {
            let result = super::extract_and_hash_frames_with_progress(
                "missing.mp4", &[0.0], Some(1.0), Some(3840), Some(2160),
                force_seek, None, &|| true,
            );
            assert_eq!(result.err().as_deref(), Some("ffmpeg 已取消"));
        }
    }

    #[test]
    fn running_extraction_can_be_cancelled_with_stdout_open() {
        let Some(tools) = resolve_tools() else { return; };
        let args = ["-v", "error", "-nostdin", "-re", "-f", "lavfi", "-i",
            "testsrc2=size=16x16:rate=30:duration=10", "-f", "rawvideo", "pipe:1"]
            .map(str::to_string);
        let started = Instant::now();
        let result = super::run_media_command_cancellable(
            &tools.ffmpeg, &args, "ffmpeg", Duration::from_secs(10), None, None,
            &|| started.elapsed() >= Duration::from_millis(150),
        );
        assert_eq!(result.err().as_deref(), Some("ffmpeg 已取消"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn running_scene_detection_can_be_cancelled() {
        if resolve_tools().is_none() {
            return; // CI 不要求安装 FFmpeg；有工具的开发机覆盖实际进程取消。
        }
        let args = [
            "-hide_banner", "-v", "error", "-nostdin", "-re", "-f", "lavfi",
            "-i", "testsrc2=size=16x16:rate=30:duration=10", "-f", "null", "-",
        ].map(str::to_string);
        let started = Instant::now();
        let result = run_ffmpeg_null_output_cancellable(&args, || started.elapsed() >= Duration::from_millis(150));
        assert_eq!(result.err().as_deref(), Some("场景检测已取消"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn media_command_timeout_terminates_hung_process() {
        // 子进程睡 10 秒，断言只给 2 秒：一旦终止逻辑只杀直接子进程、
        // 让孙进程继续持有管道，耗时就会退回接近 10 秒并稳定失败；
        // 正常路径只有「100ms 超时 + 轮询与进程启动开销」的量级。
        let (executable, args) = if cfg!(windows) {
            (
                "powershell.exe",
                vec![
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    "Start-Sleep -Seconds 10".to_string(),
                ],
            )
        } else {
            ("sh", vec!["-c".to_string(), "sleep 10".to_string()])
        };
        let started = Instant::now();
        let result = run_media_command(
            executable,
            &args,
            "测试媒体进程",
            Duration::from_millis(100),
        );
        let error = match result {
            Ok(_) => panic!("超时命令意外成功"),
            Err(error) => error,
        };
        assert_eq!(error, "测试媒体进程 超时（已终止）");
        // 2 秒足够兜住 Windows powershell 冷启动（CI 上可达数百毫秒），
        // 同时远小于子进程自身的 10 秒。
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn scene_times_accept_showinfo_filter_index_other_than_zero() {
        let stderr = "[Parsed_showinfo_3 @ a] n:0 pts_time:2.5 s:160x90\n[Parsed_showinfo_3 @ a] n:1 pts_time:1.0 s:160x90\nframe=2";
        assert_eq!(parse_scene_times(stderr), vec![1.0, 2.5]);
    }

    #[test]
    fn file_hash_buffer_is_safe_on_worker_sized_stacks() {
        let path = std::env::temp_dir().join(format!(
            "whichvideo-sha256-{}-{}.bin",
            std::process::id(),
            crate::db::now_ms()
        ));
        fs::write(&path, b"WhichVideo").unwrap();
        let handle = std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn({
                let path = path.clone();
                move || sha256_of_file(&path.to_string_lossy())
            })
            .unwrap();
        let hash = handle.join().unwrap().unwrap();
        let _ = fs::remove_file(path);
        assert_eq!(hash, "6ff578d1e1e2346ac4c5da752462d1fa961e099b2e78ab88cb42d497ccc2c7c5");
    }

    #[test]
    fn showinfo_parser_reads_standard_size_and_timestamps() {
        let stderr = "[Parsed_showinfo_0 @ 1] n: 0 pts: 0 pts_time:0 fmt:rgb24 s:320x180 i:P\n\
[Parsed_showinfo_0 @ 1] n: 1 pts: 1 pts_time:0.04 fmt:rgb24 s:320x180 i:P";
        let (times, width, height) = parse_showinfo(stderr);
        assert_eq!(times, vec![0.0, 0.04]);
        assert_eq!((width, height), (320, 180));
    }
}
