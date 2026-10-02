<#
  区分两种可能：
    A. 只有当前会话/沙箱拦 GUI 进程
    B. 整台机器都跑不了 Chromium 系 GUI

  做法：找一个与 Electron 无关的 Chromium 程序（系统自带 Edge，或 Chrome），
  用无头模式跑一次；另外试一次 notepad（普通 Win32 GUI）。
  两者都失败 => 是会话级限制；Chromium 失败但 notepad 成功 => 是 Chromium/系统层面问题。

  用法： pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lib/probe-gui-capability.ps1
#>
$ErrorActionPreference = 'Continue'

function Try-Gui([string]$label, [string]$exe, [string[]]$args, [int]$waitSeconds = 8) {
  Write-Output "--- $label ---"
  if (-not (Test-Path $exe)) {
    Write-Output "  跳过：找不到 $exe"
    Write-Output ''
    return $null
  }
  Write-Output "  $exe"
  try {
    $proc = Start-Process -FilePath $exe -ArgumentList $args -PassThru -ErrorAction Stop
  } catch {
    Write-Output "  ✗ 启动失败（进程创建被拒）：$($_.Exception.Message)"
    Write-Output ''
    return 'spawn-failed'
  }
  Start-Sleep -Seconds $waitSeconds
  if ($proc.HasExited) {
    $code = $proc.ExitCode
    $hex = if ($null -ne $code) { '0x' + ([uint32]([int64]$code -band 0xFFFFFFFFL)).ToString('x8') } else { '(未知)' }
    Write-Output "  已退出：退出码 $code ($hex)"
    if ($code -eq 2147483651 -or $code -eq -2147483645) {
      Write-Output '  ⚠ 同样是 STATUS_BREAKPOINT (0x80000003)'
    }
  } else {
    Write-Output '  ✓ 仍在运行（说明能够创建 GUI/Chromium 进程）'
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
  Write-Output ''
  return 'ok'
}

Write-Output "当前会话：powershell=$($PSVersionTable.PSVersion) 用户=$env:USERNAME"
Write-Output ''

$edgePaths = @(
  "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Write-Output '===== 1. Chromium 系（与 Electron 无关）====='
$edgeResult = Try-Gui 'Edge 无头模式' $edge @('--headless=new', '--disable-gpu', '--no-first-run', '--dump-dom', 'about:blank')
$chromeResult = Try-Gui 'Chrome 无头模式' $chrome @('--headless=new', '--disable-gpu', '--no-first-run', '--dump-dom', 'about:blank')

Write-Output '===== 2. 普通 Win32 GUI（记事本）====='
$notepadResult = Try-Gui 'notepad' "$env:SystemRoot\System32\notepad.exe" @()

Write-Output '===== 3. 结论 ====='
if ($edgeResult -eq 'ok' -or $chromeResult -eq 'ok') {
  Write-Output '  Chromium 系程序能正常运行 —— 说明系统本身没问题。'
  Write-Output '  那么 Electron 失败更可能是：Electron 版本与系统不兼容，或仅当前会话受限。'
  Write-Output '  建议：开一个全新的普通 PowerShell 窗口（从开始菜单启动），再跑一次'
  Write-Output '        node scripts\probe-electron-startup.mjs'
} elseif ($edgeResult -eq 'ok' -or $chromeResult -eq 'ok' -or $notepadResult -eq 'ok') {
  Write-Output '  普通 GUI 能起但 Chromium 系不行 —— 偏向 Chromium/系统层面问题。'
} else {
  Write-Output '  连 Edge/Chrome/notepad 都无法正常启动 —— 是当前会话级别限制（沙箱/策略）。'
  Write-Output '  请在一个全新的、普通的 PowerShell 窗口里重跑本脚本对比。'
}
