<#
  用 Windows API 读取 exe 的 asar 完整性资源（type=INTEGRITY, name=ELECTRONASAR），
  解析其中的 JSON，并与实际 app.asar 的大小/哈希比对。

  为什么重要：Electron 启动时会校验这个资源。若与实际 asar 不符，
  Electron 会 IMMEDIATE_CRASH（Windows 上即 STATUS_BREAKPOINT / 0x80000003），
  而且不产生任何应用日志 —— 正是"双击没反应、无 log、无 data 目录"的现象。

  用法： pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lib/check-asar-resource.ps1
         （可加 -ExePath / -AsarPath 指定别的产物）
#>
param(
  [string]$ExePath = 'release\WhichVideo-portable\WhichVideo.exe',
  [string]$AsarPath = 'release\WhichVideo-portable\resources\app.asar'
)

$ErrorActionPreference = 'Continue'

if (-not ('AsarResProbe' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AsarResProbe
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr LoadLibraryExW(string lpLibFileName, IntPtr hFile, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr FindResourceW(IntPtr hModule, string lpName, string lpType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LoadResource(IntPtr hModule, IntPtr hResInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LockResource(IntPtr hResData);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SizeofResource(IntPtr hModule, IntPtr hResInfo);
}
'@
}

$exe = (Resolve-Path -LiteralPath $ExePath).Path
$asar = (Resolve-Path -LiteralPath $AsarPath).Path

Write-Output "exe : $exe"
Write-Output "asar: $asar"

$LOAD_LIBRARY_AS_DATAFILE = 0x00000002
$module = [AsarResProbe]::LoadLibraryExW($exe, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($module -eq [IntPtr]::Zero) {
  Write-Output "  ✗ 无法以数据文件方式加载 exe（错误 $([Runtime.InteropServices.Marshal]::GetLastWin32Error())）"
  exit 1
}

$resInfo = [AsarResProbe]::FindResourceW($module, 'ELECTRONASAR', 'INTEGRITY')
if ($resInfo -eq [IntPtr]::Zero) {
  Write-Output '  ✗ 没有找到 INTEGRITY/ELECTRONASAR 资源 —— 说明该 exe 未启用 asar 完整性校验'
  exit 0
}

$size = [AsarResProbe]::SizeofResource($module, $resInfo)
$handle = [AsarResProbe]::LoadResource($module, $resInfo)
$pointer = [AsarResProbe]::LockResource($handle)
Write-Output "  资源大小：$size 字节"

$bytes = New-Object byte[] $size
[Runtime.InteropServices.Marshal]::Copy($pointer, $bytes, 0, $size)
$text = [Text.Encoding]::UTF8.GetString($bytes)
Write-Output '  --- 资源内容 ---'
Write-Output $text

$json = $null
try { $json = $text | ConvertFrom-Json } catch { Write-Output "  （不是合法 JSON：$($_.Exception.Message)）" }

$actualSize = (Get-Item -LiteralPath $asar).Length
$actualHash = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLower()
Write-Output ''
Write-Output "  实际 asar 大小：$actualSize"
Write-Output "  实际 asar SHA256：$actualHash"

if ($json) {
  $embeddedSize = $null
  $embeddedHash = $null
  # 内容形如 { "files": { "resources/app.asar": { "size":..., "integrity": { "algorithm":"SHA256", "hash":"..." } } } }
  if ($json.files) {
    foreach ($prop in $json.files.PSObject.Properties) {
      $entry = $prop.Value
      if ($entry.size) { $embeddedSize = $entry.size }
      if ($entry.integrity -and $entry.integrity.hash) { $embeddedHash = $entry.integrity.hash.ToLower() }
      Write-Output "  条目 $($prop.Name)：size=$($entry.size) hash=$($entry.integrity.hash)"
    }
  }
  Write-Output ''
  if ($embeddedSize -ne $null) {
    Write-Output "  大小一致：$(if ([int64]$embeddedSize -eq [int64]$actualSize) { '✓ 是' } else { "✗ 否（嵌入 $embeddedSize）" })"
  }
  if ($embeddedHash) {
    Write-Output "  哈希一致：$(if ($embeddedHash -eq $actualHash) { '✓ 是' } else { '✗ 否 —— Electron 会因此直接崩溃（0x80000003）' })"
  }
} else {
  Write-Output '  （无法解析资源内容，跳过比对）'
}
