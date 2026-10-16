@echo off
setlocal
title Offline-LLM - Build Android APK
cd /d "%~dp0"
echo Building one standalone ARM64 Android APK.
echo First run install-build-dependencies.bat if you have not set up this computer.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\android-build.ps1" -Mode build
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Build failed. Read the error above; no new APK has been reported as successful.
if /I not "%~1"=="--no-pause" pause
endlocal & exit /b %RESULT%
