@echo off
setlocal
title Offline-LLM - Install Android build dependencies
cd /d "%~dp0"
echo Installing the Windows tools and dependencies needed to build Offline-LLM.
echo Internet is required. Tool installers may request administrator approval.
echo You will be asked to review and accept Android SDK licenses.
echo.
if not exist "%~dp0scripts\windows\android-build.ps1" goto missing_helper
if not exist "%~dp0scripts\windows\android-sdk-tools.ps1" goto missing_helper
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\android-build.ps1" -Mode dependencies
set "RESULT=%ERRORLEVEL%"
goto finished
:missing_helper
echo ERROR: A Windows build helper is missing. Download and extract the entire updated source ZIP.
echo Keep scripts\windows\android-build.ps1 and android-sdk-tools.ps1 with these batch files.
set "RESULT=1"
:finished
echo.
if not "%RESULT%"=="0" echo Dependency setup failed. Read the error above before retrying.
if /I not "%~1"=="--no-pause" pause
endlocal & exit /b %RESULT%
