# TidyWork 插件卸载（DSH 桌面版 · Windows）
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host $m }
function Fail($m) { Write-Host ''; Write-Host "[失败] $m" -ForegroundColor Red; exit 1 }

$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$store = Join-Path $env:USERPROFILE '.dsh\plugins\tidywork-plugin'
$nm = Join-Path $profileDir 'node_modules\@tidywork\dsh-plugin'

function FindApp {
  $cands = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    foreach ($k in (Get-ChildItem $r -ErrorAction SilentlyContinue)) {
      $props = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
      if ($props -and $props.DisplayName -like '*DeepSeek Harness*' -and $props.InstallLocation) {
        $exe = Join-Path $props.InstallLocation 'DeepSeek Harness.exe'
        if (Test-Path $exe) { return $exe }
      }
    }
  }
  return $null
}

Say 'TidyWork 插件卸载（DSH 桌面版 · Windows）'
Say '--------------------------------------'
$pkg = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkg)) { Fail ("没找到 " + $pkg) }

$app = FindApp
$bak = Join-Path $profileDir ('package.json.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item $pkg $bak

if ($app) {
  $js = Join-Path $env:TEMP ('twunpatch-' + [guid]::NewGuid().ToString('N') + '.js')
  $code = @'
const fs = require('fs')
const [pkgPath] = process.argv.slice(2)
const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
if (j.dependencies) delete j.dependencies['@tidywork/dsh-plugin']
const b = j.dsh && j.dsh.profile && j.dsh.profile.bundles
if (Array.isArray(b)) j.dsh.profile.bundles = b.filter((x) => x !== '@tidywork/dsh-plugin')
fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n')
console.log('OK')
'@
  Set-Content -Path $js -Value $code -Encoding UTF8
  $env:ELECTRON_RUN_AS_NODE = '1'
  try {
    $out = & $app $js $pkg 2>$null
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item $js -Force -ErrorAction SilentlyContinue
  }
  if (-not ($out -match 'OK')) { Fail ("改写 profile 配置失败。原配置已备份：" + $bak) }
  Say '已从 profile 中移除插件登记'
} else {
  Say '找不到应用，跳过配置改写；请手动从 profile 的 package.json 里移除 @tidywork/dsh-plugin。'
}

if (Test-Path $nm) { Remove-Item $nm -Recurse -Force; Say ("已删除 " + $nm) }
if (Test-Path $store) { Remove-Item $store -Recurse -Force; Say ("已删除 " + $store) }

if ($env:TW_NO_RESTART -ne '1' -and $app) {
  Say ''
  Say '正在重启 DSH 桌面版…'
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-Process -FilePath $app
}

Say ''
Say '完成。你的待办/会议/笔记数据仍在 %USERPROFILE%\.dsh\profiles\desktop\tidywork 里，重新安装后会接上。'
