@echo off
chcp 65001 >nul
title OCS 本地题库服务
cd /d "%~dp0"

rem 优先使用同目录下的便携版 Node
set "NODE_BIN="
if exist "node\node.exe" set "NODE_BIN=node\node.exe"
if not defined NODE_BIN (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_BIN=node"
)
if not defined NODE_BIN (
  echo.
  echo [错误] 没有找到 Node.js
  echo 方案一：安装 Node.js 18+ 后重新双击本文件  https://nodejs.org/
  echo 方案二：运行 build-portable.ps1 生成自带运行时的便携版
  echo.
  pause
  exit /b 1
)

rem 端口占用检测（默认 8899，改过端口请同步修改此处）
netstat -ano | findstr ":8899" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo [提示] 服务已经在运行了，无需重复启动。
  echo        正在打开配置页面...
  start "" "http://127.0.0.1:8899/config"
  echo.
  pause
  exit /b 0
)

echo 正在启动题库服务，请不要关闭本窗口...
echo.
"%NODE_BIN%" server.mjs

echo.
echo 服务已停止。
pause
