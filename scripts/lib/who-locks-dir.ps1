# 诊断：谁占着这个目录？
#
# Windows 上"目录被占用"有两个常见来源：
#   A. 某进程把该目录当作**当前工作目录**（CWD）—— 这种占用不能改名也不能删除，
#      而且跟进程的 exe 在哪毫无关系（例如 D:\SublimeText 里的 plugin_host 停在项目目录上）
#   B. 某进程打开了目录里的文件句柄（编辑器索引/杀软扫描等）
#
# 这个脚本用 PEB 读取每个进程的实际工作目录，找出 A 类占用者；
# 再用"改名试探"确认当前是否真的无法改名（B 类占用也会让改名失败）。
#
# 用法：
#   pwsh -NoProfile -File scripts/lib/who-locks-dir.ps1 -Path E:\code\...\release
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$All,
  [switch]$Brief
)

$ErrorActionPreference = 'Stop'
$target = (Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue).Path
if (-not $target) { $target = [System.IO.Path]::GetFullPath($Path) }

Write-Output "目标目录：$target"

# ---------- 1. 改名试探：能否证明它被占用 ----------
$probe = "$target.__rename_probe_$([guid]::NewGuid().ToString('N').Substring(0,8))"
$locked = $false
try {
  Rename-Item -LiteralPath $target -NewName ([System.IO.Path]::GetFileName($probe)) -ErrorAction Stop
  Rename-Item -LiteralPath $probe -NewName ([System.IO.Path]::GetFileName($target)) -ErrorAction Stop
  Write-Output '改名试探：成功（目录当前未被占用）'
} catch {
  $locked = $true
  Write-Output "改名试探：失败 → 目录确实被占用（$($_.Exception.GetType().Name)）"
}

# ---------- 2. 找出占用者 ----------
# 首选：读每个进程的当前工作目录（CWD）。需要 P/Invoke，只在 PowerShell 7+ 可用；
# Windows PowerShell 5.1 会因语言模式拦下 Add-Type，此时退化为"命令行里提到该路径"的判断。
$cwdReader = $null
try {
  $readerScript = Join-Path $PSScriptRoot 'peb-cwd-reader.ps1'
  if (Test-Path -LiteralPath $readerScript) {
    . $readerScript
    $cwdReader = [PebReader]
  }
} catch {
  Write-Output "提示：当前 PowerShell 无法加载 CWD 读取器（$($_.Exception.Message.Trim())），改用命令行线索。"
  $cwdReader = $null
}

Write-Output ''
Write-Output '--- 占用者 ---'
$found = 0
$names = @()

if ($cwdReader) {
  foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
    $cwd = $null
    try { $cwd = $cwdReader::GetWorkingDirectory($process.Id) } catch { }
    if (-not $cwd) { continue }
    $normalized = $cwd.TrimEnd('\')
    $isTarget = $normalized -eq $target.TrimEnd('\')
    $isParent = $target.TrimEnd('\').StartsWith($normalized + '\', [System.StringComparison]::OrdinalIgnoreCase)
    if ($All) {
      if ($normalized -like '*whichvideo*' -or $isTarget -or $isParent) {
        Write-Output ("  PID {0,-6} {1,-24} CWD={2}" -f $process.Id, $process.ProcessName, $normalized)
        $found++
      }
      continue
    }
    if ($isTarget -or $isParent) {
      $found++
      $names += $process.ProcessName
      if (-not $Brief) {
        $where = if ($isTarget) { 'CWD 就是它' } else { 'CWD 停在上级目录' }
        Write-Output ("  PID {0,-6} {1,-24} {2}" -f $process.Id, $process.ProcessName, $where)
        Write-Output ("         exe={0}" -f $process.Path)
        Write-Output ("         CWD={0}" -f $normalized)
      }
    }
  }
}

# 补充线索：命令行里出现该路径（能抓到编辑器/构建工具这类显式传参的进程）
$byCommandLine = @()
try {
  foreach ($process in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    if ($process.CommandLine -and $process.CommandLine -like "*$target*") {
      $byCommandLine += ("  PID {0,-6} {1} （命令行里出现该路径）" -f $process.ProcessId, $process.Name)
      $names += [System.IO.Path]::GetFileNameWithoutExtension($process.Name)
      $found++
    }
  }
} catch {
  Write-Output '提示：无法枚举命令行（WMI 不可用）。'
}
foreach ($line in $byCommandLine) { if (-not $Brief) { Write-Output $line } }

if ($found -eq 0) {
  Write-Output '  （没有直接命中：占用多半来自"打开了目录里的文件"）'
  Write-Output '  用资源监视器 →「CPU」→「关联的句柄」搜索目录名，能看到具体是谁打开了它们。'
}

if ($All) {
  Write-Output ''
  Write-Output '--- 命令行里提到 whichvideo 的进程 ---'
  $foundCmd = 0
  foreach ($process in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    if ($process.CommandLine -and $process.CommandLine -match 'whichvideo') {
      $foundCmd++
      Write-Output ("  PID {0,-6} {1}" -f $process.ProcessId, $process.Name)
      Write-Output ("         {0}" -f $process.CommandLine)
    }
  }
  if ($foundCmd -eq 0) { Write-Output '  （无）' }
}

if ($Brief) {
  # 供脚本调用：一行摘要，便于写进报错信息
  if ($found -gt 0) {
    $unique = ($names | Where-Object { $_ } | Sort-Object -Unique) -join '、'
    Write-Output ("HOLDERS 命中 {0} 个占用线索：{1}" -f $found, $unique)
  } else {
    Write-Output 'HOLDERS 无直接命中（多半是"打开了目录里的文件"）'
  }
}

Write-Output ''
if ($locked) {
  Write-Output '结论：目录确实被占用（改名失败）。'
  Write-Output '若上面没有命中，占用来自"打开了目录里的文件"（编辑器索引、杀软扫描、资源管理器预览等），'
  Write-Output '可在资源监视器 →「CPU」→「关联的句柄」里搜索目录名定位。'
} else {
  Write-Output '结论：目录当前可正常改名/删除，占用已解除。'
}
