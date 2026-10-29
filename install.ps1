# 一键安装 / 卸载 dsh-virus-cat（Windows）
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1            # 安装（或更新）
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall # 卸载
param(
  [switch]$Uninstall,
  [string]$ProfileName = 'desktop'
)

$ErrorActionPreference = 'Stop'

$HomeDir    = $env:USERPROFILE
$TargetDir  = Join-Path $HomeDir '.dsh\dsh-virus-cat'
$ProfileDir = Join-Path $HomeDir ".dsh\profiles\$ProfileName"
$ProfilePkg = Join-Path $ProfileDir 'package.json'
$PkgName    = 'dsh-virus-cat'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

if (-not (Test-Path -LiteralPath $ProfilePkg)) {
  Write-Warn2 "找不到 profile：$ProfilePkg"
  Write-Warn2 "请先启动过一次 DSH（桌面版会自动创建 profiles\$ProfileName），或用 -ProfileName 指定别的 profile。"
  exit 1
}

# 读 profile package.json（保留原有缩进风格，只改两个字段）
$raw = [System.IO.File]::ReadAllText($ProfilePkg, [System.Text.Encoding]::UTF8)
$pkg = $raw | ConvertFrom-Json
$indent = if ($raw -match '(?m)^  "') { 2 } else { 2 }

$bundles = @()
if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
$deps = @{}
if ($pkg.dependencies) { $pkg.dependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value } }

function Save-Profile {
  if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
  $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force

  $newDeps = [ordered]@{}
  foreach ($k in $deps.Keys) { $newDeps[$k] = $deps[$k] }
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]$newDeps) -Force

  $json = $pkg | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($ProfilePkg, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
  Write-Step "从 profile 移除 $PkgName"
  $bundles = @($bundles | Where-Object { $_ -ne $PkgName })
  $deps.Remove($PkgName) | Out-Null
  Save-Profile

  $link = Join-Path $ProfileDir "node_modules\$PkgName"
  if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    if ($item.LinkType) { cmd /c rmdir "$link" } else { Remove-Item -LiteralPath $link -Recurse -Force }
    Write-Step "已移除 node_modules\$PkgName"
  }

  Write-Step "停止正在运行的猫"
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dsh-virus-cat' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  if (Test-Path -LiteralPath $TargetDir) {
    $ans = Read-Host "要连源码一起删掉吗（$TargetDir）？[y/N]"
    if ($ans -match '^[Yy]') { Remove-Item -LiteralPath $TargetDir -Recurse -Force; Write-Step "已删除 $TargetDir" }
    else { Write-Step "保留了源码：$TargetDir" }
  }
  Write-Host "`n卸载完成。重启 DSH 后生效。" -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------- 安装
Write-Step "复制到 $TargetDir"
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
robocopy $src $TargetDir /E /NFL /NDL /NJH /NJS /NP /XD node_modules .git /XF *.log helper.log | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制失败（robocopy exit=$LASTEXITCODE）" }

Write-Step "在 profile 里建立软链接（编辑源码即时生效）"
$nm = Join-Path $ProfileDir 'node_modules'
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$link = Join-Path $nm $PkgName
if (Test-Path -LiteralPath $link) {
  $item = Get-Item -LiteralPath $link -Force
  if ($item.LinkType) { cmd /c rmdir "$link" } else { Remove-Item -LiteralPath $link -Recurse -Force }
}
cmd /c mklink /J "$link" "$TargetDir" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "创建目录联接失败（需要管理员权限或已存在同名目录）" }
# 注：DSH（Electron）加载 bundle 时会先 fs.realpath，junction 会被解析成真实目录。
# 所以 $TargetDir 里必须是一份完整可用的副本 —— 改了源码后要重跑一次
#   powershell -ExecutionPolicy Bypass -File install.ps1
# 才能让插件版拿到新代码（双击 .cmd 的独立版直接读源码，不受影响）。

Write-Step "写入 profile 的 bundles / dependencies"
if ($bundles -notcontains $PkgName) { $bundles = @($bundles + $PkgName) }
$deps[$PkgName] = "file:../../$PkgName"
Save-Profile

Write-Step "检查 Electron 运行时"
$exe = Join-Path $HomeDir '.dsh\electron\electron.exe'
if (Test-Path -LiteralPath $exe) {
  Write-Host "    找到：$exe"
} else {
  Write-Warn2 "没找到 $exe —— 独立模式需要它（DSH 桌面版通常自带）。"
  Write-Warn2 "也可以设环境变量 DSH_VC_ELECTRON 指向自己的 electron.exe。"
}

Write-Host "`n安装完成！" -ForegroundColor Green
Write-Host "  · 独立体验：双击 $TargetDir\启动猫.cmd"
Write-Host "  · 作为插件：重启 DSH 后自动启动"
Write-Host "  · 加叫声：双击 $TargetDir\打开音效文件夹.cmd"
