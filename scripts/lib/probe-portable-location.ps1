<#
  位置对照实验：判断"打不开"到底是**路径位置**造成的，还是**那份目录的内容/状态**造成的。

  做法：把同一个可执行文件分别放到三个位置，各启动一次并记录退出码与日志：
    A. 管控区内、一个新目录（E:\code\weiningwei\whichvideo\...)  ← 与出问题的位置同属一棵树
    B. 管控区外、一个新目录（E:\code\_wv_probe\...）             ← 与能正常启动的位置同属一棵树
    C. 原地（release\WhichVideo-portable，可选）

  结果解读：
    A 失败 + B 成功 → 是"位于 DSH 管控目录树内"这个条件导致的
    A 成功         → 与位置无关，原目录是被某个残留状态卡住（重新打包即可）
    都失败         → 与位置无关，需要另找原因（安全软件/进程创建策略）

  用法： pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lib/probe-portable-location.ps1
#>
param(
  [string]$Source = 'release\WhichVideo-portable',
  [int]$WaitSeconds = 12,
  # 管控区外的对照位置；默认用用户临时目录（一定有写权限），也可自定义
  [string]$OutsideDir = ''
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$src = if ([System.IO.Path]::IsPathRooted($Source)) { $Source } else { Join-Path $root $Source }

# 清理会让 electron 以纯 Node 模式运行的变量，否则测的不是 GUI
foreach ($n in 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE') {
  if (Test-Path "Env:\$n") { Remove-Item "Env:\$n" -ErrorAction SilentlyContinue }
}

if (-not (Test-Path (Join-Path $src 'WhichVideo.exe'))) {
  Write-Output "✗ 找不到 $src\WhichVideo.exe"
  exit 1
}

if (-not $OutsideDir) {
  $OutsideDir = Join-Path $env:TEMP 'wv-location-probe'
}

$locations = @(
  @{ Name = 'A. 管控区内（workspace 下）'; Dir = Join-Path $root '_location-probe' },
  @{ Name = 'B. 管控区外（临时目录）'; Dir = $OutsideDir },
  @{ Name = 'C. 原地'; Dir = $src }
)

Write-Output '=========================================='
Write-Output ' 便携版"位置"对照实验'
Write-Output '=========================================='
Write-Output "源目录：$src"
Write-Output ''

$results = @()

foreach ($loc in $locations) {
  Write-Output "===== $($loc.Name) ====="
  Write-Output "  路径：$($loc.Dir)"

  if ($loc.Dir -ne $src) {
    try {
      if (Test-Path $loc.Dir) { Remove-Item $loc.Dir -Recurse -Force -ErrorAction Stop }
      # 只用 robocopy 拷文件内容，避免继承源目录的 ACL 异常
      New-Item -ItemType Directory -Path $loc.Dir -Force | Out-Null
      $rc = Start-Process -FilePath 'robocopy.exe' -ArgumentList @($src, $loc.Dir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1') -Wait -PassThru -WindowStyle Hidden
      Write-Output "  复制完成（robocopy 返回 $($rc.ExitCode)）"
    } catch {
      Write-Output "  ✗ 准备失败：$($_.Exception.Message)"
      Write-Output ''
      continue
    }
  }

  $exe = Join-Path $loc.Dir 'WhichVideo.exe'
  if (-not (Test-Path $exe)) {
    Write-Output '  ✗ 没有 exe'
    Write-Output ''
    continue
  }

  # 关键：启动前先删掉副本里的 data\。
  # 源目录本身就带着 data\（上次运行留下的），不删的话"启动后有 data"永远为真，判定就失效。
  # 删掉之后，只要 data\ 重新出现，就证明程序真的启动过。
  $dataDir = Join-Path $loc.Dir 'data'
  try {
    if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force -ErrorAction Stop }
  } catch {
    Write-Output "  ⚠ 无法清理副本里的 data\：$($_.Exception.Message)"
  }
  $hadData = Test-Path $dataDir

  $out = Join-Path $env:TEMP "wv-loc-$([guid]::NewGuid().ToString('N')).txt"
  try {
    $proc = Start-Process -FilePath $exe -WorkingDirectory $loc.Dir -PassThru `
      -RedirectStandardOutput $out -RedirectStandardError "$out.err" -ErrorAction Stop
  } catch {
    Write-Output "  ✗ 无法启动进程：$($_.Exception.Message)"
    $results += [pscustomobject]@{ 位置 = $loc.Name; 结果 = '启动失败(EPERM?)'; 退出码 = ''; 生成data = '' }
    Write-Output ''
    continue
  }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  $alive = -not $proc.HasExited
  if ($alive) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

  $code = if ($alive) { $null } else { $proc.ExitCode }
  $hex = if ($null -ne $code) { '0x' + ([uint32]([int64]$code -band 0xFFFFFFFFL)).ToString('x8') } else { '(仍在运行)' }

  Start-Sleep -Milliseconds 500
  $nowData = Test-Path $dataDir
  $logTail = ''
  $logFile = Join-Path $dataDir 'whichvideo.log'
  if (Test-Path $logFile) {
    $logTail = (Get-Content $logFile -Tail 3 -ErrorAction SilentlyContinue) -join ' / '
  }

  Write-Output "  退出码：$code ($hex)"
  Write-Output "  启动前有 data：$hadData，启动后有 data：$nowData"
  if ($logTail) { Write-Output "  日志尾部：$logTail" }
  $errFile = "$out.err"
  if (Test-Path $errFile) {
    $errRaw = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
    $e = if ($null -eq $errRaw) { '' } else { [string]$errRaw }
    if ($e.Trim()) { Write-Output "  stderr：$(($e.Trim() -split "`r?`n" | Select-Object -First 2) -join ' | ')" }
  }
  Remove-Item $out, $errFile -Force -ErrorAction SilentlyContinue

  $verdict = if ($nowData) { '✓ 启动成功（重新生成了 data）' } else { '✗ 启动失败（没有生成 data）' }
  Write-Output "  判定：$verdict"
  Write-Output ''
  $results += [pscustomobject]@{
    位置       = $loc.Name
    结果       = $verdict
    退出码     = $hex
    生成data   = $nowData
  }
}

Write-Output '=========================================='
Write-Output ' 汇总'
Write-Output '=========================================='
$results | Format-Table -AutoSize | Out-String | Write-Output

$a = $results | Where-Object { $_.位置 -like 'A.*' }
$b = $results | Where-Object { $_.位置 -like 'B.*' }
if ($a -and $b) {
  if (-not $a.生成data -and $b.生成data) {
    Write-Output '结论：位置在起作用 —— 同一份文件放在管控区外能启动，放在管控区内不能。'
    Write-Output '      解决办法：把项目或产物移到 DSH 管控目录之外（例如 E:\work\whichvideo）。'
  } elseif ($a.生成data) {
    Write-Output '结论：管控区内也能启动 —— 问题与位置无关，是原来那个目录的残留状态，'
    Write-Output '      删掉 release 重新打包即可。'
  } else {
    Write-Output '结论：两个新位置都无法启动 —— 与位置无关，需要另查（安全软件、进程创建策略）。'
  }
}
