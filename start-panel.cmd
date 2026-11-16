@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem 优先用 PATH 上的 node；找不到时回退到 WorkBuddy 托管的 node（读 current 指针）
set "NODE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE=node"

if not defined NODE (
  set "PTR=%USERPROFILE%\.workbuddy\binaries\node\versions\current"
  if exist "!PTR!" (
    set /p VER=<"!PTR!"
    if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\!VER!\node.exe" (
      set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\!VER!\node.exe"
    )
  )
)

if not defined NODE (
  echo.
  echo   未找到 Node.js，无法启动状态面板。
  echo   请确认 Node 已安装，或 WorkBuddy 的 node 目录存在。
  echo.
  pause
  exit /b 1
)

"%NODE%" server.cjs
if %errorlevel% neq 0 pause
