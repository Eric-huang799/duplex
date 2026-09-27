@echo off
rem Build the Windows installer into release\ (uses npmmirror for downloads)
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set DEBUG=electron-builder
cd /d %~dp0
npx electron-builder --win --publish never > release-build.log 2>&1
echo EXIT_CODE=%ERRORLEVEL% >> release-build.log
