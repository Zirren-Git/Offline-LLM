@echo off
setlocal
title Offline-LLM - Build Android APK
cd /d "%~dp0"
echo Building one standalone ARM64 Android APK.
echo First run install-build-dependencies.bat if you have not set up this computer.
echo.
if not exist "%~dp0scripts\windows\android-build.ps1" goto missing_helper
if not exist "%~dp0scripts\windows\android-sdk-tools.ps1" goto missing_helper
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\android-build.ps1" -Mode build
set "RESULT=%ERRORLEVEL%"
goto finished
:missing_helper
echo ERROR: A Windows build helper is missing. Download and extract the entire updated source ZIP.
echo Keep scripts\windows\android-build.ps1 and android-sdk-tools.ps1 with these batch files.
set "RESULT=1"
:finished
echo.
if not "%RESULT%"=="0" echo Build failed. Read the error above; no new APK has been reported as successful.
if /I not "%~1"=="--no-pause" pause
endlocal & exit /b %RESULT%
