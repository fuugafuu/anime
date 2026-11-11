@echo off
setlocal
cd /d "%~dp0"
title FRAME - Install PC AI Engine
echo ============================================
echo FRAME - Install PC AI Engine (No Ollama)
echo ============================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-ai-engine.ps1"
if errorlevel 1 (
  echo.
  echo ERROR: The engine installation did not complete.
) else (
  echo.
  echo Installation completed. Run START_AI.bat next.
)
pause
