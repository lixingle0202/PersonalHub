@echo off
cd /d "%~dp0"
set "PYTHONPATH=%~dp0backend"
"%~dp0.venv\Scripts\python.exe" -m app.desktop_launcher
if errorlevel 1 pause
