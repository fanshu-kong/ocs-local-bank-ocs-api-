@echo off
chcp 65001 >nul
title 更改 AI 模型
cd /d "%~dp0"

if not exist "config.json" (
  echo [提示] 还没有 config.json，先启动一次服务会自动生成。
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0改模型.ps1"

echo.
pause
