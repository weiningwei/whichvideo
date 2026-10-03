<#
  对比"能启动"和"不能启动"的两个便携版目录，列出所有可观测差异。
  检查：ACL（含 Deny 与能力 SID）、文件属性、备用数据流（Zone.Identifier）、
  短路径、以及各层父目录的 ACL 继承链。

  注意：DSH 工作区的 S-1-4-x-y 能力 SID 与 Everyone 的 DeleteSubdirectoriesAndFiles
  拒绝项是**预期设计**，不是损坏；实测清掉后照样打不开。看到它们不要当成根因。
  本脚本只读，不修改任何 ACL。

  用法： pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lib/compare-portable-dirs.ps1
#>
param(
  [string]$Bad = 'release\WhichVideo-portable',
  [string]$Good = 'E:\code\2026-09\WhichVideo-portable'
)

$ErrorActionPreference = 'Continue'

function Show-DirFacts([string]$label, [string]$path) {
  Write-Output "===== $label : $path ====="
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Output '  （不存在）'
    Write-Output ''
    return
  }
  $full = (Resolve-Path -LiteralPath $path).Path
  $item = Get-Item -LiteralPath $full -Force

  Write-Output "  完整路径长度：$($full.Length)"
  Write-Output "  属性        ：$($item.Attributes)"
  Write-Output "  创建时间    ：$($item.CreationTime)"
  Write-Output "  修改时间    ：$($item.LastWriteTime)"

  # 短路径（8.3）有时会暴露奇怪的重定向
  try {
    $fso = New-Object -ComObject Scripting.FileSystemObject
    Write-Output "  短路径      ：$($fso.GetFolder($full).ShortPath)"
  } catch {
    Write-Output '  短路径      ：(读取失败)'
  }

  $acl = Get-Acl -LiteralPath $full
  Write-Output "  SDDL        ：$($acl.Sddl)"
  $deny = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' })
  Write-Output "  Deny 条目数 ：$($deny.Count)"
  foreach ($d in $deny) { Write-Output "      DENY $($d.IdentityReference) : $($d.FileSystemRights)  (继承=$($d.IsInherited))" }

  $exe = Join-Path $full 'WhichVideo.exe'
  if (Test-Path -LiteralPath $exe) {
    Write-Output '  --- WhichVideo.exe ---'
    $streams = Get-Item -LiteralPath $exe -Stream * -ErrorAction SilentlyContinue
    foreach ($s in $streams) {
      Write-Output "      流: $($s.Stream)  长度=$($s.Length)"
    }
    $hasZone = @($streams | Where-Object { $_.Stream -eq 'Zone.Identifier' }).Count -gt 0
    Write-Output "      Zone.Identifier: $(if ($hasZone) { '有 ⚠' } else { '无' })"
    if ($hasZone) {
      Get-Content -LiteralPath $exe -Stream Zone.Identifier -ErrorAction SilentlyContinue | ForEach-Object { "        $_" }
    }
    $exeItem = Get-Item -LiteralPath $exe -Force
    Write-Output "      exe 属性: $($exeItem.Attributes)"
  }
  Write-Output ''
}

Write-Output '############ 目标目录对比 ############'
Write-Output ''
Show-DirFacts '不能启动' $Bad
Show-DirFacts '能启动' $Good

Write-Output '############ 父目录 ACL 继承链 ############'
Write-Output ''
foreach ($p in @('E:\code\2026-09', 'E:\code\weiningwei')) {
  Write-Output "--- $p ---"
  if (Test-Path -LiteralPath $p) {
    $a = Get-Acl -LiteralPath $p
    Write-Output "  $($a.Sddl)"
    $d = @($a.Access | Where-Object { $_.AccessControlType -eq 'Deny' })
    Write-Output "  Deny 条目数：$($d.Count)"
    foreach ($x in $d) { Write-Output "      DENY $($x.IdentityReference) : $($x.FileSystemRights)" }
  } else {
    Write-Output '  （不存在）'
  }
  Write-Output ''
}

Write-Output '############ 关键差异小结 ############'
Write-Output '  若两边 ACL 都已无 Deny，却仍只有一边能启动，则 ACL 不是原因，'
Write-Output '  需转向：安全软件按路径拦截、进程创建策略、或该路径被某程序占用。'
