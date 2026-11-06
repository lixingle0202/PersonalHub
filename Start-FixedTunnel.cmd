@echo off
set "PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if not exist "%PWSH%" (
  echo PowerShell 7 was not found. Return to Codex for help.
  pause
  exit /b 1
)
"%PWSH%" -NoProfile -File "%~dp0scripts\Start-FixedPublicHub.ps1"
pause
