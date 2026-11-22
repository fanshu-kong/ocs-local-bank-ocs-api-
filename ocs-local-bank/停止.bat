@echo off
chcp 65001 >nul
title 停止 OCS 本地题库服务
echo.
echo 正在停止题库服务...

set "FOUND=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8899" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>nul
  if not errorlevel 1 (
    echo   已结束进程 PID %%a
    set "FOUND=1"
  )
)

if "%FOUND%"=="0" echo   当前没有正在运行的服务。
echo.
echo 完成。
ping -n 2 127.0.0.1 >nul
