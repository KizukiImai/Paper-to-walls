@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20以上を導入してから起動してください。
  pause
  exit /b 1
)
set "RECEIVER_PORT="
set /p RECEIVER_PORT=受信用ポート [3001]: 
if not defined RECEIVER_PORT set RECEIVER_PORT=3001
set "PORT=%RECEIVER_PORT%"
set RECEIVE_ONLY=1
set HOST=0.0.0.0
set "DATA_DIR=%~dp0receiver-data"
node server/index.mjs
pause
