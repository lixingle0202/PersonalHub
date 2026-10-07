@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-ai.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)
if exist "%~dp0dist\PersonalHub\PersonalHub.exe" (
  "%~dp0dist\PersonalHub\PersonalHub.exe"
) else (
  call "%~dp0Start-PersonalHub.cmd"
)
