# 生成免安装便携版：把 Node 运行时打进 便携版 文件夹，复制到其他电脑直接双击使用
param(
  [string]$NodeVersion = 'v24.20.0',
  [string]$OutDir = '便携版'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$out = Join-Path $root $OutDir
$nodeDir = Join-Path $out 'node'

Write-Host "[1/4] 准备目录 $out" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null

$zip = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
if (-not (Test-Path $zip)) {
  Write-Host "[2/4] 下载 Node $NodeVersion（约 36MB）" -ForegroundColor Cyan
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $zip -TimeoutSec 600
} else {
  Write-Host '[2/4] 复用已下载的 Node 压缩包' -ForegroundColor Cyan
}

$tmp = Join-Path $env:TEMP "node-$NodeVersion-extract"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
Copy-Item (Join-Path $tmp "node-$NodeVersion-win-x64\node.exe") (Join-Path $nodeDir 'node.exe') -Force

Write-Host '[3/4] 复制程序文件' -ForegroundColor Cyan
$files = @('server.mjs', '启动.bat', '停止.bat', '改模型.bat', '改模型.ps1', 'config.example.json', '题库.example.json', 'README.md')
foreach ($f in $files) {
  if (Test-Path $f) { Copy-Item $f (Join-Path $out $f) -Force }
}
if (Test-Path 'public') {
  Copy-Item 'public' (Join-Path $out 'public') -Recurse -Force
}

Write-Host '[4/4] 完成' -ForegroundColor Green
$size = [math]::Round(((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ''
Write-Host ("便携版目录: " + $out) -ForegroundColor Green
Write-Host ("体积: " + $size + " MB") -ForegroundColor Green
Write-Host '把这个文件夹整个复制到其他 Windows 电脑，双击 启动.bat 即可使用，无需安装 Node。' -ForegroundColor Gray
