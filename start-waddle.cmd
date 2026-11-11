@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Waddle needs Node.js 20 or newer. Install Node, then run this again.
  exit /b 1
)
node -e "process.exit(parseInt(process.versions.node,10) < 20 ? 1 : 0)" >nul 2>nul
if errorlevel 1 (
  echo Waddle needs Node.js 20 or newer.
  exit /b 1
)
if not defined WADDLE_PROFILE set "WADDLE_PROFILE=small"
if not defined NODE_OPTIONS set "NODE_OPTIONS=--max-old-space-size=320"
if not defined WADDLE_OPEN_BROWSER set "WADDLE_OPEN_BROWSER=1"
node server.js
