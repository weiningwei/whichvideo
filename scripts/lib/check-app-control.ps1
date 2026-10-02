# 检查本机的应用控制策略：智能应用控制（Smart App Control）、WDAC、AppLocker、受控文件夹访问。
#
# 为什么查这些：Windows 11 24H2 起，"智能应用控制"默认开启时会拦截未签名/未受信任的 exe，
# 表现就是双击后进程静默退出（无窗口、无日志、无数据目录）。
#
# 用法： pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lib/check-app-control.ps1
$ErrorActionPreference = 'Continue'

function Section($t) { Write-Output ''; Write-Output "===== $t =====" }

Section '1. 系统版本'
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Write-Output ("  {0}  Build {1}.{2}" -f $os.Caption, $os.Version, $os.BuildNumber)
} catch { Write-Output "  读取失败：$($_.Exception.Message)" }

Section '2. 智能应用控制（Smart App Control）'
# 0=关闭 1=开启(强制) 2=评估模式
try {
  $state = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction Stop
  $map = @{ 0 = '关闭'; 1 = '开启（会拦截未签名程序）'; 2 = '评估模式（仅记录）' }
  $v = $state.VerifiedAndReputablePolicyState
  Write-Output ("  VerifiedAndReputablePolicyState = {0}  → {1}" -f $v, ($map[[int]$v] ?? '未知'))
  if ($v -eq 1) { Write-Output '  ⚠ 智能应用控制已开启，未签名的 WhichVideo.exe 很可能被它拦截' }
} catch {
  Write-Output '  未找到该注册表项（通常表示该项在当前系统上不可用/已关闭）'
}

Section '3. 已部署的 WDAC 代码完整性策略'
$ciDir = "$env:SystemRoot\System32\CodeIntegrity\CiPolicies\Active"
if (Test-Path $ciDir) {
  $policies = Get-ChildItem $ciDir -Filter '*.cip' -ErrorAction SilentlyContinue
  if ($policies) {
    foreach ($p in $policies) { Write-Output ("  {0}  {1:N0} 字节" -f $p.Name, $p.Length) }
    Write-Output '  （存在 WDAC 策略文件，可能限制未签名程序；可用 CiTool -lp 查看详情）'
  } else {
    Write-Output '  没有活动的 WDAC 策略文件'
  }
} else {
  Write-Output '  没有活动的 WDAC 策略目录'
}

Section '4. AppLocker 规则'
try {
  $svc = Get-Service AppIDSvc -ErrorAction SilentlyContinue
  Write-Output ("  AppIDSvc 状态：{0}" -f ($svc?.Status ?? '不存在'))
  $rules = Get-AppLockerPolicy -Effective -ErrorAction Stop
  $count = @($rules.RuleCollections).Count
  Write-Output ("  生效的规则集合数：{0}" -f $count)
  foreach ($collection in $rules.RuleCollections) {
    foreach ($rule in $collection) {
      Write-Output ("    {0}  {1}  {2}" -f $rule.Type, $rule.EnforcementMode, $rule.Name)
    }
  }
} catch {
  Write-Output "  未读取到 AppLocker 策略（通常是未启用）：$($_.Exception.Message)"
}

Section '5. 受控文件夹访问（Defender 勒索防护）'
try {
  $pref = Get-MpPreference -ErrorAction Stop
  Write-Output ("  受控文件夹访问：{0}" -f $(if ($pref.EnableControlledFolderAccess -eq 1) { '开启' } else { '关闭' }))
  Write-Output ("  排除路径数：{0}" -f @($pref.ControlledFolderAccessProtectedFolders).Count)
} catch {
  Write-Output "  无法读取 Defender 首选项：$($_.Exception.Message)"
}

Section '6. Defender 近 3 天与本项目相关的检测记录'
try {
  $since = (Get-Date).AddDays(-3)
  $threats = Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.InitialDetectionTime -ge $since }
  $hit = @($threats | Where-Object { $_.Resources -match 'whichvideo|WhichVideo|electron' })
  if ($hit) {
    foreach ($t in $hit) {
      Write-Output ("  {0}  威胁ID={1}" -f $t.InitialDetectionTime, $t.ThreatID)
      foreach ($res in $t.Resources) { Write-Output ("      $res") }
    }
  } else {
    Write-Output '  没有相关检测记录'
  }
} catch {
  Write-Output "  读取失败：$($_.Exception.Message)"
}

Section '7. 代码完整性 8004/8005 事件（程序被阻止的记录）'
try {
  $since = (Get-Date).AddDays(-3)
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; StartTime = $since } -ErrorAction SilentlyContinue |
    Select-Object -First 8
  if ($events) {
    foreach ($e in $events) {
      Write-Output ("  [{0}] Id={1}" -f $e.TimeCreated, $e.Id)
      ($e.Message -split "`n" | Select-Object -First 3) | ForEach-Object { "      $_" }
    }
  } else {
    Write-Output '  近 3 天没有代码完整性事件（该日志默认可能未启用）'
  }
} catch {
  Write-Output "  读取失败：$($_.Exception.Message)"
}

Write-Output ''
Write-Output '把以上全部输出贴回来即可判断是否被应用控制策略拦截。'
