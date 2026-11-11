@echo off
setlocal
cd /d "%~dp0"
title FRAME Animation AI - Local PC Service
echo ==========================================
echo FRAME Animation AI - Local PC Service
echo ==========================================
echo Keep this window open while using AI tools.
echo Local URL: http://127.0.0.1:8766
echo.
where py >nul 2>nul
if not errorlevel 1 (
  py -3 ai_server.py
  goto end
)
where python >nul 2>nul
if not errorlevel 1 (
  python ai_server.py
  goto end
)
echo ERROR: Python 3 was not found.
echo Install Python 3 and restart this script.
:end
if errorlevel 1 echo ERROR: The AI service stopped unexpectedly.
pause
