<#
  审计打包产物的 ACL：找出非法/未知 SID、Deny 条目、以及缺少读取权限的文件。
  起因：release 目录树曾被沙箱 ACL 工具处理过（用户在该 exe 上看到未知账户
  S-1-4-66101308-411491026），需要确认是否影响到关键文件的读取。

  用法： pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lib/audit-release-acl.ps1
#>
param(
  [string]$Root = 'release\WhichVideo-portable'
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path -LiteralPath $Root).Path
Write-Output "审计目录：$root"
Write-Output ''

$wellKnown = '^(BUILTIN|NT AUTHORITY|NT SERVICE|APPLICATION PACKAGE AUTHORITY|CREATOR OWNER|Everyone|S-1-5-|S-1-16-)'
$unknown = New-Object System.Collections.Generic.List[string]
$deny = New-Object System.Collections.Generic.List[string]
$noRead = New-Object System.Collections.Generic.List[string]
$checked = 0

function Test-Readable($path) {
  try {
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $fs.Close()
    return $true
  } catch {
    return $false
  }
}

# 递归枚举；关键文件优先检查（大目录下只抽查关键文件，避免太慢）
$keyPatterns = '\.(exe|dll|asar|dat|pak|bin|node|json)$'
$files = Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue

foreach ($f in $files) {
  $isKey = $f.Name -match $keyPatterns -or $f.Name -match '^WhichVideo'
  if (-not $isKey) { continue }
  $checked++

  try {
    $acl = Get-Acl -LiteralPath $f.FullName -ErrorAction Stop
  } catch {
    $unknown.Add("$($f.FullName) : 无法读取 ACL（$($_.Exception.Message)）")
    continue
  }

  # 属主/属组是否非法
  foreach ($id in @($acl.Owner, $acl.Group)) {
    if ($id -and $id -notmatch $wellKnown -and $id -notmatch '^S-1-5-21-') {
      $unknown.Add("$($f.FullName) : 属主/属组异常 -> $id")
    }
  }

  foreach ($ace in $acl.Access) {
    $id = "$($ace.IdentityReference)"
    if ($id -notmatch $wellKnown -and $id -notmatch '^S-1-5-21-') {
      $unknown.Add("$($f.FullName) : 未知 SID -> $id ($($ace.FileSystemRights))")
    }
    if ($ace.AccessControlType -eq 'Deny') {
      $deny.Add("$($f.FullName) : Deny $id ($($ace.FileSystemRights))")
    }
  }

  # 实际能否读取（比 ACL 语义更直接）
  if (-not (Test-Readable $f.FullName)) {
    $noRead.Add($f.FullName)
  }
}

Write-Output "检查的关键文件数：$checked"
Write-Output ''

Write-Output "===== 未知 SID / 异常属主（$($unknown.Count) 条）====="
if ($unknown.Count) { $unknown | Select-Object -First 30 | ForEach-Object { "  $_" } } else { '  （无）' }

Write-Output ''
Write-Output "===== Deny 条目（$($deny.Count) 条）====="
if ($deny.Count) { $deny | Select-Object -First 30 | ForEach-Object { "  $_" } } else { '  （无）' }

Write-Output ''
Write-Output "===== 实际读取失败的文件（$($noRead.Count) 个）====="
if ($noRead.Count) { $noRead | Select-Object -First 30 | ForEach-Object { "  $_" } } else { '  （无）' }

Write-Output ''
Write-Output '===== 结论 ====='
if ($noRead.Count -eq 0 -and $deny.Count -eq 0) {
  Write-Output '  所有关键文件都可读，且没有 Deny 条目 —— ACL 不会阻止程序启动。'
  Write-Output '  未知 SID 只是历史残留（Allow 条目），可以清理，但它不是启动失败的原因。'
} else {
  Write-Output '  ⚠ 存在读取失败或 Deny 条目，这可能直接导致程序启动失败。'
  Write-Output '  建议：把整个便携版目录复制到别处（例如 D:\test\）再运行，复制后 ACL 会重新继承。'
}

Write-Output ''
Write-Output '关键目录自身的 ACL：'
try {
  $racl = Get-Acl -LiteralPath $root
  Write-Output "  SDDL: $($racl.Sddl)"
} catch { Write-Output "  读取失败：$($_.Exception.Message)" }
