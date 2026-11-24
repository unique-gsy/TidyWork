# TidyWork 插件安装（DSH 桌面版 · Windows）
# 用法：双击「Windows-安装.bat」，或在 PowerShell 里执行 .\install.ps1
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host $m }
function Fail($m) { Write-Host ''; Write-Host "[失败] $m" -ForegroundColor Red; exit 1 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'plugin'
if (-not (Test-Path (Join-Path $src 'package.json'))) {
  $alt = Join-Path (Split-Path -Parent $here) 'plugin'
  if (Test-Path (Join-Path $alt 'package.json')) { $src = $alt }
}

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

Say 'TidyWork 插件安装（DSH 桌面版 · Windows）'
Say '--------------------------------------'

$app = FindApp
if (-not $app) { Fail '没找到 DeepSeek Harness.exe。请先装好 DSH 桌面版再运行本脚本。' }
Say "应用：$app"

if (-not (Test-Path $profileDir)) {
  Fail ("没找到配置目录：" + $profileDir + "`n请先打开一次 DeepSeek Harness（停在任意界面），退出后再运行本脚本。")
}
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) { Fail ("配置目录缺少 package.json：" + $profileDir) }
if (-not (Test-Path (Join-Path $src 'lib\index.js'))) { Fail '压缩包不完整：缺少 plugin\lib\index.js。' }

New-Item -ItemType Directory -Force -Path $store | Out-Null
# 先清掉上一次装的代码目录，避免旧版本残留（例如已删除的 ui/）继续被加载
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $store 'lib'), (Join-Path $store 'locale'), (Join-Path $store 'ui')
Copy-Item -Path (Join-Path $src '*') -Destination $store -Recurse -Force
Say "插件文件：$store"

New-Item -ItemType Directory -Force -Path $nm | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $nm 'lib'), (Join-Path $nm 'locale'), (Join-Path $nm 'ui')
Copy-Item -Path (Join-Path $src '*') -Destination $nm -Recurse -Force
Say "已就位：$nm"

$bak = Join-Path $profileDir ('package.json.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item (Join-Path $profileDir 'package.json') $bak
# 备份只留最近 3 份，避免 profile 目录越滚越大
Get-ChildItem -Path $profileDir -Filter 'package.json.bak-*' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
Say "已备份：$bak"

$js = Join-Path $env:TEMP ('twpatch-' + [guid]::NewGuid().ToString('N') + '.js')
$code = @'
const fs = require('fs')
const [pkgPath, pluginDir] = process.argv.slice(2)
const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
j.dependencies = j.dependencies || {}
j.dependencies['@tidywork/dsh-plugin'] = 'file:' + pluginDir.replace(/\\/g, '/')
j.dsh = j.dsh || {}
j.dsh.profile = j.dsh.profile || {}
const bundles = (j.dsh.profile.bundles = j.dsh.profile.bundles || [])
if (!bundles.includes('@tidywork/dsh-plugin')) bundles.push('@tidywork/dsh-plugin')
fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n')
console.log('OK')
'@
Set-Content -Path $js -Value $code -Encoding UTF8

$env:ELECTRON_RUN_AS_NODE = '1'
try {
  $out = & $app $js (Join-Path $profileDir 'package.json') $store 2>$null
} finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item $js -Force -ErrorAction SilentlyContinue
}
if (-not ($out -match 'OK')) { Fail ("写入 profile 配置失败。原配置已备份：" + $bak) }
Say '已在 profile 中登记插件'

if ($env:TW_NO_RESTART -ne '1') {
  Say ''
  Say '正在重启 DSH 桌面版…'
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-Process -FilePath $app
}

Say ''
Say '完成。打开 DSH 桌面版后，左侧栏应出现「工作台 / 待办 / 会议 / 笔记」四个入口。'
Say '如果右侧仍是 DSH 原界面，点侧栏最上面的「工作台」即可。'
