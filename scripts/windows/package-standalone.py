#!/usr/bin/env python3
"""Generate the two self-contained Windows launchers; no third-party packages."""
from pathlib import Path
import argparse
import difflib
import sys

ROOT = Path(__file__).resolve().parents[2]
MARKER = '# === OFFLINE-LLM POWERSHELL PAYLOAD ==='
VERSION = '2026.10.16.4'


def render(mode: str) -> bytes:
    implementation = (ROOT / 'scripts/windows/android-build.ps1').read_text(encoding='utf-8')
    helpers = (ROOT / 'scripts/windows/android-sdk-tools.ps1').read_text(encoding='utf-8')
    include = ". (Join-Path $PSScriptRoot 'android-sdk-tools.ps1')"
    assert implementation.count(include) == 1
    assert f"$script:ToolVersion = '{VERSION}'" in implementation
    payload = implementation.replace(include, helpers.rstrip())
    # No external .ps1 files are read. Environment variables carry paths instead
    # of interpolating filenames into PowerShell expressions.
    bootstrap = (
        "$ErrorActionPreference='Stop'; $runner=$null; $code=1; try { "
        "$text=[IO.File]::ReadAllText($env:OFFLINE_LLM_SELF); "
        "$match=[regex]::Match($text,'(?m)^# === OFFLINE-LLM POWERSHELL PAYLOAD ===\\r?$'); "
        "if(-not $match.Success){throw 'Embedded installer is missing. Download this batch file again.'}; "
        "$cache=Join-Path $env:LOCALAPPDATA 'Offline-LLM\\windows-build'; "
        "New-Item -ItemType Directory -Path $cache -Force | Out-Null; "
        "$runner=Join-Path $cache ('runner-'+[guid]::NewGuid().ToString('N')+'.ps1'); "
        "[IO.File]::WriteAllText($runner,$text.Substring($match.Index+$match.Length),(New-Object Text.UTF8Encoding($false))); "
        "& $runner -Mode $env:OFFLINE_LLM_MODE -LauncherDirectory (Split-Path -Parent $env:OFFLINE_LLM_SELF); "
        "$code=$LASTEXITCODE "
        "} catch { [Console]::Error.WriteLine('BOOTSTRAP ERROR: '+$_.Exception.Message); "
        "[Console]::Error.WriteLine('Use a writable LOCALAPPDATA directory and Windows PowerShell 5.1+. No app build has succeeded.'); $code=1 "
        "} finally { if($runner){Remove-Item -LiteralPath $runner -Force -ErrorAction SilentlyContinue} }; exit $code"
    )
    action = 'Install build dependencies' if mode == 'dependencies' else 'Build ARM64 APK'
    header = f'''@echo off
setlocal DisableDelayedExpansion
title Offline-LLM - {action}
echo Offline-LLM standalone Windows tools {VERSION}
echo This file contains its own installer. No companion PowerShell files are needed.
echo Internet is needed for dependency downloads. Use an extracted app source ZIP.
echo.
set "OFFLINE_LLM_SELF=%~f0"
set "OFFLINE_LLM_MODE={mode}"
where powershell.exe >nul 2>&1
if errorlevel 1 goto no_powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "{bootstrap}"
set "RESULT=%ERRORLEVEL%"
goto finished
:no_powershell
echo ERROR: Windows PowerShell is missing or blocked. Use Windows PowerShell 5.1+ on x64 Windows 10/11.
set "RESULT=1"
:finished
echo.
if not "%RESULT%"=="0" echo Operation failed. Read the failed step and diagnostic log above before retrying.
if /I not "%~1"=="--no-pause" pause
endlocal & exit /b %RESULT%
{MARKER}
{payload}'''
    return header.replace('\r\n', '\n').replace('\n', '\r\n').encode('utf-8')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check generated files without overwriting them')
    args = parser.parse_args()
    failures = 0
    for name, mode in [('install-build-dependencies.bat', 'dependencies'), ('build-apk.bat', 'build')]:
        path = ROOT / name
        expected = render(mode)
        if args.check:
            actual = path.read_bytes() if path.exists() else b''
            if actual != expected:
                print('Out of date: ' + name, file=sys.stderr)
                print(''.join(difflib.unified_diff(actual.decode().splitlines(True), expected.decode().splitlines(True))), file=sys.stderr)
                failures += 1
            else:
                print('Generated launcher is current: ' + name)
        else:
            path.write_bytes(expected)
            print(f'Wrote {name}: {len(expected):,} bytes')
    return bool(failures)


if __name__ == '__main__':
    sys.exit(main())
