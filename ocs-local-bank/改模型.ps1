param(
  [string]$Model,
  [string]$ApiKey,
  [string]$BaseUrl,
  [switch]$NoTest
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $root 'config.json'

function Read-Cfg { Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }

function Mask-Key($k) {
  if (-not $k) { return '(未填写)' }
  if ($k.Length -le 8) { return '****' }
  return $k.Substring(0, 4) + '****' + $k.Substring($k.Length - 4)
}

function Save-Cfg($cfg) {
  $json = $cfg | ConvertTo-Json -Depth 8
  # 必须写不带 BOM 的 UTF-8，否则 Node 解析会失败
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($cfgPath, $json, $utf8)
}

function Set-AiProp($cfg, $name, $value) {
  $exists = @($cfg.ai.PSObject.Properties | ForEach-Object { $_.Name }) -contains $name
  if ($exists) { $cfg.ai.$name = $value }
  else { $cfg.ai | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

$presets = @(
  @{ Label = 'glm-5.3-flash   智谱  按 tokens，通常有赠送额度'; Model = 'glm-5.3-flash';  BaseUrl = 'https://open.bigmodel.cn/api/paas/v4'; Provider = 'zhipu' },
  @{ Label = 'glm-5.3-flashx  智谱  按 tokens';                 Model = 'glm-5.3-flashx'; BaseUrl = 'https://open.bigmodel.cn/api/paas/v4'; Provider = 'zhipu' },
  @{ Label = 'glm-4.6         智谱  按次计费，额度有限';         Model = 'glm-4.6';        BaseUrl = 'https://open.bigmodel.cn/api/paas/v4'; Provider = 'zhipu' },
  @{ Label = 'glm-4.5-flash   智谱';                             Model = 'glm-4.5-flash';  BaseUrl = 'https://open.bigmodel.cn/api/paas/v4'; Provider = 'zhipu' },
  @{ Label = 'deepseek-chat   DeepSeek 官方';                    Model = 'deepseek-chat';  BaseUrl = 'https://api.deepseek.com/v1';          Provider = 'deepseek' },
  @{ Label = 'gpt-4o-mini     OpenAI';                           Model = 'gpt-4o-mini';    BaseUrl = 'https://api.openai.com/v1';            Provider = 'openai' },
  @{ Label = 'qwen2.5:7b      本地 Ollama';                      Model = 'qwen2.5:7b';     BaseUrl = 'http://127.0.0.1:11434/v1';           Provider = 'ollama' }
)

$cfg = Read-Cfg
$port = 8899
if ($cfg.port) { $port = $cfg.port }

if (-not $Model) {
  Write-Host ''
  Write-Host '========== 当前 AI 配置 ==========' -ForegroundColor Cyan
  Write-Host ('  模型    : ' + $cfg.ai.model)
  Write-Host ('  接口    : ' + $cfg.ai.baseUrl)
  Write-Host ('  API Key : ' + (Mask-Key $cfg.ai.apiKey))
  if ($cfg.ai.enable) {
    Write-Host '  状态    : 已启用' -ForegroundColor Green
  } else {
    Write-Host '  状态    : 未启用' -ForegroundColor DarkYellow
  }
  Write-Host '==================================' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '请选择模型：' -ForegroundColor Cyan
  for ($i = 0; $i -lt $presets.Count; $i++) {
    Write-Host ('  ' + ($i + 1) + ') ' + $presets[$i].Label)
  }
  Write-Host ('  ' + ($presets.Count + 1) + ') 自定义')
  Write-Host ''
  $choice = Read-Host '输入序号后回车（直接回车 = 1）'
  if ([string]::IsNullOrWhiteSpace($choice)) { $choice = '1' }
  $choice = [int]$choice

  if ($choice -ge 1 -and $choice -le $presets.Count) {
    $Model = $presets[$choice - 1].Model
    $BaseUrl = $presets[$choice - 1].BaseUrl
    $provider = $presets[$choice - 1].Provider
  } elseif ($choice -eq ($presets.Count + 1)) {
    $BaseUrl = Read-Host ('接口地址 baseUrl（回车沿用 ' + $cfg.ai.baseUrl + '）')
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = $cfg.ai.baseUrl }
    $Model = Read-Host '模型名 model'
    if ([string]::IsNullOrWhiteSpace($Model)) {
      Write-Host '模型名不能为空，已取消。' -ForegroundColor Red
      exit 1
    }
    $provider = 'custom'
  } else {
    Write-Host '输入无效，已取消。' -ForegroundColor Red
    exit 1
  }

  Write-Host ''
  $ApiKey = Read-Host ('API Key（回车保持不变：' + (Mask-Key $cfg.ai.apiKey) + '）')
}
if (-not $provider) { $provider = $cfg.ai.provider }
if (-not $BaseUrl) { $BaseUrl = $cfg.ai.baseUrl }

$fallbackValue = ''
if ($Model -ne 'glm-5.3-flashx' -and $BaseUrl -like '*bigmodel*') { $fallbackValue = 'glm-5.3-flashx' }

$body = @{
  enable        = $true
  provider      = $provider
  baseUrl       = $BaseUrl
  model         = $Model
  fallbackModel = $fallbackValue
}
if (-not [string]::IsNullOrWhiteSpace($ApiKey)) { $body.apiKey = $ApiKey.Trim() }

$listening = $false
try {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($conn) { $listening = $true }
} catch { }

Write-Host ''
if ($listening) {
  try {
    $res = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/config') -Method PUT -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 15
    Write-Host '[成功] 已保存并立即生效，无需重启' -ForegroundColor Green
    Write-Host ('  当前模型 : ' + $res.data.model)
    Write-Host ('  接口地址 : ' + $res.data.baseUrl)
    Write-Host ('  API Key  : ' + $res.data.apiKey)
  } catch {
    Write-Host ('[失败] 调用接口出错：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '       请确认服务正在运行。'
    exit 1
  }

  if (-not $NoTest) {
    Write-Host ''
    $test = Read-Host '要现在测试连接吗？(Y/n)'
    if ([string]::IsNullOrWhiteSpace($test) -or $test -match '^[Yy]') {
      Write-Host '测试中，请稍候...' -ForegroundColor Cyan
      try {
        $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/config/test') -Method POST -TimeoutSec 40
        if ($r.ok) {
          Write-Host ('[通过] ' + $r.model + ' 响应正常，耗时 ' + $r.ms + 'ms，返回「' + $r.reply + '」') -ForegroundColor Green
        } else {
          Write-Host ('[失败] ' + $r.error) -ForegroundColor Red
        }
      } catch {
        Write-Host ('[失败] ' + $_.Exception.Message) -ForegroundColor Red
      }
    }
  }
} else {
  $cfg.ai.enable = $true
  $cfg.ai.baseUrl = $BaseUrl
  $cfg.ai.model = $Model
  Set-AiProp $cfg 'provider' $provider
  Set-AiProp $cfg 'fallbackModel' $fallbackValue
  if (-not [string]::IsNullOrWhiteSpace($ApiKey)) { $cfg.ai.apiKey = $ApiKey.Trim() }
  Save-Cfg $cfg
  Write-Host '[成功] 已写入 config.json' -ForegroundColor Green
  Write-Host ('  当前模型 : ' + $Model)
  Write-Host ('  接口地址 : ' + $BaseUrl)
  Write-Host '  服务未运行，下次启动时生效。' -ForegroundColor Yellow
}

Write-Host ''
