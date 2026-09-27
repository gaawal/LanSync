@echo off
rem LanSync launcher (ASCII only to avoid codepage issues)
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --registry=https://registry.npmmirror.com
)
echo Starting LanSync...
start "" cmd /c "timeout /t 2 >nul & start http://localhost:7788"
node server.js
pause
