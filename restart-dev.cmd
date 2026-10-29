@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-dev.ps1" %*
if errorlevel 1 (
  echo.
  echo Restart failed. Please check the message above.
  pause
  exit /b 1
)
