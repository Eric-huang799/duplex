@echo off
setlocal
cd /d "%~dp0.."
set "PATH=%ProgramFiles%\nodejs;%PATH%"
set "DUPLEX_DATA_DIR=%CD%\.demo-profile\data"
if not exist node_modules (
  echo Dependencies are missing. Run npm ci first.
  exit /b 1
)
if not exist node_modules\electron\path.txt node node_modules\electron\install.js
if errorlevel 1 exit /b %errorlevel%
call npm run build
if errorlevel 1 exit /b %errorlevel%
call npm run start
