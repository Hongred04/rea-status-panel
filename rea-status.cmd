@echo off
setlocal
set "P=%~dp0rea-status.ps1"
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%P%"
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%P%"
)
echo.
pause
