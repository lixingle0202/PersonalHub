@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo PersonalHub has not been prepared yet. Please follow README.md first.
  pause
  exit /b 1
)
set "PYTHONPATH=%CD%\backend"
".venv\Scripts\python.exe" "backend\personalhub_entry.py"
if errorlevel 1 pause
