@echo off
rem Build the Windows installer into release\ (uses npmmirror for downloads)
rem
rem IMPORTANT: build first. electron-builder only packages whatever out\ and
rem dist-bridge\ currently contain, and it does NOT fail when they are stale
rem or missing -- skipping the build steps happily ships the previous build
rem (or a package with no MCP bridge at all).
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set DEBUG=electron-builder
cd /d %~dp0

echo ==== build:bridge ==== > release-build.log
call npm run build:bridge >> release-build.log 2>&1
if errorlevel 1 goto failed

echo ==== build ==== >> release-build.log
call npm run build >> release-build.log 2>&1
if errorlevel 1 goto failed

echo ==== package ==== >> release-build.log
npx electron-builder --win --publish never >> release-build.log 2>&1
if errorlevel 1 goto failed

echo EXIT_CODE=0 >> release-build.log
exit /b 0

:failed
echo EXIT_CODE=%ERRORLEVEL% >> release-build.log
exit /b 1
