# 打包应用启动诊断：一次性收集判断"为什么双击没反应"所需的全部证据。
#
# 用法（在仓库根目录）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lib/diagnose-app-startup.ps1
param(
  [string]$PortableDir = ''
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $PortableDir) { $PortableDir = Join-Path $root 'release\WhichVideo-portable' }
$exe = Join-Path $PortableDir 'WhichVideo.exe'

function Section($title) { Write-Output ''; Write-Output "===== $title =====" }

Section '1. 便携版目录'
if (Test-Path $PortableDir) {
  Get-ChildItem $PortableDir -Force |
    Select-Object -First 12 @{n = '名称'; e = { $_.Name } }, @{n = '时间'; e = { $_.LastWriteTime } } |
    Format-Table -AutoSize | Out-String | Write-Output
} else {
  Write-Output "  ✗ 目录不存在：$PortableDir"
}

Section '2. exe 与 asar'
foreach ($f in 'WhichVideo.exe', 'resources\app.asar', 'resources\app.asar.unpacked', 'resources\bin') {
  $p = Join-Path $PortableDir $f
  if (Test-Path $p) {
    $item = Get-Item $p
    Write-Output ("  ✓ {0,-32} {1,10:N0} 字节  {2}" -f $f, $item.Length, $item.LastWriteTime)
  } else {
    Write-Output ("  ✗ {0,-32} 不存在" -f $f)
  }
}

Section '3. exe 的完整路径与签名/Zone 标记'
Write-Output "  完整路径：$exe"
if (Test-Path $exe) {
  $ads = Get-Item $exe -Stream * -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Stream
  if ($ads -contains 'Zone.Identifier') {
    Write-Output '  ⚠ 该文件带 Zone.Identifier（来自网络下载），Windows 可能阻止运行'
  } else {
    Write-Output '  ✓ 没有 Zone.Identifier 标记'
  }
}

Section '4. 两个可能的数据目录'
$candidates = @(
  (Join-Path $PortableDir 'data'),
  (Join-Path $env:APPDATA 'WhichVideo')
)
foreach ($dir in $candidates) {
  if (Test-Path $dir) {
    Write-Output "  ✓ 存在：$dir"
    Get-ChildItem $dir -Force | Select-Object -First 10 @{n = '  内容'; e = { $_.Name } }, @{n = '  时间'; e = { $_.LastWriteTime } } |
      Format-Table -AutoSize | Out-String | Write-Output
    $log = Join-Path $dir 'whichvideo.log'
    if (Test-Path $log) {
      Write-Output "  --- $log 最后 30 行 ---"
      Get-Content $log -Tail 30 | ForEach-Object { "    $_" }
    }
  } else {
    Write-Output "  ✗ 不存在：$dir"
  }
}

Section '5. 是否已有进程在运行（单实例锁会让第二次启动静默退出）'
$procs = Get-Process -Name 'WhichVideo' -ErrorAction SilentlyContinue
if ($procs) {
  $procs | Select-Object Id, ProcessName, StartTime, Path | Format-Table -AutoSize | Out-String | Write-Output
} else {
  Write-Output '  （没有正在运行的 WhichVideo 进程）'
}

Section '6. 相关事件日志（应用错误 / 崩溃）'
try {
  $since = (Get-Date).AddDays(-3)
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -ErrorAction Stop |
    Where-Object { $_.Message -match 'WhichVideo|electron|chromium' } |
    Select-Object -First 10
  if ($events) {
    foreach ($e in $events) {
      Write-Output ("  [{0}] {1} (Id={2})" -f $e.TimeCreated, $e.ProviderName, $e.Id)
      ($e.Message -split "`n" | Select-Object -First 6) | ForEach-Object { "      $_" }
    }
  } else {
    Write-Output '  近 3 天没有相关事件'
  }
} catch {
  Write-Output "  读取事件日志失败：$($_.Exception.Message)"
}

Section '7. 手动启动一次并抓取输出'
Write-Output '  下面会用 ELECTRON_ENABLE_LOGGING 启动，6 秒后自动结束进程。'
Write-Output '  主进程加载失败的错误（例如 ESM/CJS 相关）会出现在“--- 输出 ---”里。'
if (Test-Path $exe) {
  $env:ELECTRON_ENABLE_LOGGING = '1'
  $out = Join-Path $env:TEMP "whichvideo-launch-$([guid]::NewGuid().ToString('N')).log"
  # 刻意不用 -WindowStyle Hidden：那会让 GUI 程序的窗口行为失真，尽量贴近真实双击
  $proc = Start-Process -FilePath $exe -WorkingDirectory $PortableDir -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  Start-Sleep -Seconds 6
  $alive = -not $proc.HasExited
  Write-Output "  启动后 6 秒仍在运行：$(if ($alive) { '是（进程没崩，问题在窗口/渲染层）' } else { '否（已退出）' })"
  if (-not $alive) {
    $code = $proc.ExitCode
    $hex = if ($null -ne $code) { '0x' + ([uint32]$code).ToString('x8') } else { '(未知)' }
    Write-Output "  退出码：$code  ($hex)"
    if ($code -eq -2147483645) {
      Write-Output '  ⚠ STATUS_BREAKPOINT (0x80000003)：Chromium 的通用 CHECK 崩溃码。'
      Write-Output '     常见原因：GPU 子进程/沙箱、安全软件拦截、Chromium 与系统版本不兼容。'
      Write-Output '     WhichVideo 已在 Windows 上默认加 --disable-gpu-sandbox；若仍为此码，可试 --disable-gpu。'
    }
  } else {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
  foreach ($f in $out, "$out.err") {
    if (Test-Path $f) {
      $content = Get-Content $f -Raw -ErrorAction SilentlyContinue
      Write-Output "  --- 输出 $([System.IO.Path]::GetFileName($f)) ---"
      if ($content) { $content.Trim() | ForEach-Object { "    $_" } } else { Write-Output '    （空）' }
      Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item Env:\ELECTRON_ENABLE_LOGGING -ErrorAction SilentlyContinue
} else {
  Write-Output "  跳过：找不到 $exe"
}

Write-Output ''
Write-Output '提示：把以上全部输出贴回来即可定位。'
