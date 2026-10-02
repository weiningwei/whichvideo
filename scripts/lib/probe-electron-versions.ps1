<#
  逐个 Electron 版本做启动测试，找出本机能正常运行的版本区间。

  背景：本机用 Electron 44.5.1 跑 3 行极简应用即以 STATUS_BREAKPOINT(0x80000003)
  或访问冲突(0xc0000005) 退出，但用户反馈其它 Electron 应用能正常运行。
  因此需要判断是否为"Electron 版本与系统不兼容"。

  用法：
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lib/probe-electron-versions.ps1
    pwsh ... -Versions 42.0.0,40.0.0,38.0.0      # 自定义要测的版本（逗号分隔）
    pwsh ... -SkipDownload                        # 只测已下载缓存

  说明：每个版本约 100MB，下载到 tmp\electron-versions\。
#>
param(
  [string[]]$Versions = @('44.5.1', '42.0.0', '40.0.0', '38.0.0'),
  [switch]$SkipDownload,
  [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cache = Join-Path $root 'tmp\electron-versions'
$workDir = Join-Path $root 'tmp\electron-version-probe'

# 探测用的极简应用：只写日志，用来判断 Electron 主进程能否启动
function New-ProbeApp([string]$dir) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Set-Content -Path (Join-Path $dir 'package.json') -Encoding UTF8 -Value '{"name":"probe","version":"1.0.0","main":"main.js"}'
  $main = @'
const { app } = require('electron')
const fs = require('fs')
const log = (m) => fs.appendFileSync(__dirname + '/probe.log', m + '\n')
log('main started electron=' + process.versions.electron)
app.on('ready', () => { log('app ready'); setTimeout(() => app.quit(), 300) })
process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.stack || e)))
process.on('exit', (code) => log('exit code=' + code))
'@
  Set-Content -Path (Join-Path $dir 'main.js') -Encoding UTF8 -Value $main
}

Write-Output '========================================'
Write-Output ' Electron 版本启动能力探测'
Write-Output '========================================'
Write-Output "系统: $([System.Environment]::OSVersion.VersionString)  架构: $env:PROCESSOR_ARCHITECTURE"
Write-Output "缓存: $cache"

# 关键：清理会让 electron 以「纯 Node 模式」运行的变量。
# 否则 require('electron') 返回空对象，测出来的是 Node 而不是 GUI 启动能力。
foreach ($name in 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_FORCE_IS_PACKAGED') {
  $item = Get-Item "Env:\$name" -ErrorAction SilentlyContinue
  if ($item) {
    Write-Output "已清理环境变量 $name（原值 '$($item.Value)'）"
    Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
  }
}
Write-Output ''

New-Item -ItemType Directory -Path $cache -Force | Out-Null
New-ProbeApp $workDir

$summary = @()

foreach ($ver in $Versions) {
  Write-Output "===== Electron $ver ====="
  $dest = Join-Path $cache $ver
  $exe = Join-Path $dest 'electron.exe'

  # 项目里已装好的同版本直接复用，省一次下载
  $installedDist = Join-Path $root 'node_modules\electron\dist'
  $installedExe = Join-Path $installedDist 'electron.exe'
  $installedVersionFile = Join-Path $installedDist 'version'
  if (
    -not (Test-Path $exe) -and
    (Test-Path $installedExe) -and
    (Test-Path $installedVersionFile) -and
    ((Get-Content $installedVersionFile -Raw).Trim() -eq $ver)
  ) {
    Write-Output "  复用已安装的 electron：$installedExe"
    $dest = $installedDist
    $exe = $installedExe
  }

  if (-not (Test-Path $exe)) {
    if ($SkipDownload) {
      Write-Output "  跳过：未下载（且指定了 -SkipDownload）"
      Write-Output ''
      continue
    }
    $zip = Join-Path $cache "electron-v$ver-win32-x64.zip"
    if (-not (Test-Path $zip)) {
      $url = "https://github.com/electron/electron/releases/download/v$ver/electron-v$ver-win32-x64.zip"
      Write-Output "  下载 $url"
      try {
        # 关闭进度条输出，避免拖慢下载
        $old = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
        $ProgressPreference = $old
        Write-Output ("  下载完成：{0:N1} MB" -f ((Get-Item $zip).Length / 1MB))
      } catch {
        Write-Output "  ✗ 下载失败：$($_.Exception.Message)"
        Write-Output '    （可能需要代理；也可手动下载 zip 放到上面这个路径后重跑）'
        Write-Output ''
        continue
      }
    } else {
      Write-Output ("  使用已有压缩包：{0:N1} MB" -f ((Get-Item $zip).Length / 1MB))
    }
    try {
      Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
      Write-Output '  解压完成'
    } catch {
      Write-Output "  ✗ 解压失败：$($_.Exception.Message)"
      Write-Output ''
      continue
    }
  } else {
    Write-Output '  使用已解压的缓存'
  }

  if (-not (Test-Path $exe)) {
    Write-Output "  ✗ 没有找到 $exe"
    Write-Output ''
    continue
  }

  $logFile = Join-Path $workDir 'probe.log'
  Remove-Item $logFile -Force -ErrorAction SilentlyContinue
  $out = Join-Path $workDir "out-$ver.txt"
  $err = Join-Path $workDir "err-$ver.txt"
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue

  try {
    $proc = Start-Process -FilePath $exe -ArgumentList $workDir -WorkingDirectory $workDir -PassThru `
      -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
  } catch {
    Write-Output "  ✗ 无法启动：$($_.Exception.Message)"
    Write-Output ''
    continue
  }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  $alive = -not $proc.HasExited
  if ($alive) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

  $code = if ($alive) { $null } else { $proc.ExitCode }
  $hex = if ($null -ne $code) { '0x' + ([uint32]([int64]$code -band 0xFFFFFFFFL)).ToString('x8') } else { '(仍在运行)' }
  $log = ''
  if (Test-Path $logFile) { $log = [string](Get-Content $logFile -Raw -ErrorAction SilentlyContinue) }
  $errText = ''
  if (Test-Path $err) { $errText = [string](Get-Content $err -Raw -ErrorAction SilentlyContinue) }

  $ok = $log -match 'app ready'
  Write-Output "  退出码: $code ($hex)"
  Write-Output "  日志: $(if ($log) { $log -replace "`r?`n", ' | ' } else { '(空)' })"
  if ($errText) {
    $firstLines = ($errText -split "`r?`n" | Select-Object -First 3) -join ' | '
    Write-Output "  stderr: $firstLines"
  }
  Write-Output "  结果: $(if ($ok) { '✓ 可以正常运行' } else { '✗ 启动失败' })"
  Write-Output ''

  $summary += [pscustomobject]@{ Version = $ver; ExitCode = $hex; Ok = $ok }
}

Write-Output '========================================'
Write-Output ' 汇总'
Write-Output '========================================'
$summary | Format-Table -AutoSize | Out-String | Write-Output

$working = @($summary | Where-Object { $_.Ok })
if ($working.Count -gt 0) {
  Write-Output "可以运行的版本：$($working.Version -join ', ')"
  Write-Output '=> 结论：这是 Electron 版本兼容性问题，把 package.json 的 electron 降到可用版本即可。'
} elseif ($summary.Count -gt 0) {
  Write-Output '所有测试版本都无法启动。'
  Write-Output '=> 请确认"能正常运行的其它 Electron 应用"用的是哪个版本（见下面命令），再针对性测试：'
  Write-Output '   Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter version -ErrorAction SilentlyContinue |'
  Write-Output '     Where-Object { Test-Path (Join-Path $_.DirectoryName "resources\app.asar") } |'
  Write-Output '     ForEach-Object { "$(Get-Content $_.FullName)  <- $($_.DirectoryName)" }'
}
