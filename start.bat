@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node.js 20以上をインストールしてから再実行してください。
  pause
  exit /b 1
)
echo PAPER / SPACE を起動します。
echo ブラウザで http://localhost:3000 を開いてください。
echo 停止するには Ctrl+C を押します。
echo.
node server/index.mjs
if errorlevel 1 pause
