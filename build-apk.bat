@echo off
setlocal DisableDelayedExpansion
title Offline-LLM - Build ARM64 APK
echo Offline-LLM standalone Windows tools 2026.10.16.4
echo This file contains its own installer. No companion PowerShell files are needed.
echo Internet is needed for dependency downloads. Use an extracted app source ZIP.
echo.
set "OFFLINE_LLM_SELF=%~f0"
set "OFFLINE_LLM_MODE=build"
where powershell.exe >nul 2>&1
if errorlevel 1 goto no_powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $runner=$null; $code=1; try { $text=[IO.File]::ReadAllText($env:OFFLINE_LLM_SELF); $match=[regex]::Match($text,'(?m)^# === OFFLINE-LLM POWERSHELL PAYLOAD ===\r?$'); if(-not $match.Success){throw 'Embedded installer is missing. Download this batch file again.'}; $cache=Join-Path $env:LOCALAPPDATA 'Offline-LLM\windows-build'; New-Item -ItemType Directory -Path $cache -Force | Out-Null; $runner=Join-Path $cache ('runner-'+[guid]::NewGuid().ToString('N')+'.ps1'); [IO.File]::WriteAllText($runner,$text.Substring($match.Index+$match.Length),(New-Object Text.UTF8Encoding($false))); & $runner -Mode $env:OFFLINE_LLM_MODE -LauncherDirectory (Split-Path -Parent $env:OFFLINE_LLM_SELF); $code=$LASTEXITCODE } catch { [Console]::Error.WriteLine('BOOTSTRAP ERROR: '+$_.Exception.Message); [Console]::Error.WriteLine('Use a writable LOCALAPPDATA directory and Windows PowerShell 5.1+. No app build has succeeded.'); $code=1 } finally { if($runner){Remove-Item -LiteralPath $runner -Force -ErrorAction SilentlyContinue} }; exit $code"
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
# === OFFLINE-LLM POWERSHELL PAYLOAD ===
# Shared implementation for the two root-level Windows batch launchers.
# Requires Windows PowerShell 5.1 or later, not PowerShell 7.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('dependencies', 'build')]
    [string]$Mode,
    [string]$SourceDirectory = '',
    [string]$LauncherDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Filesystem-only Android SDK helpers. Dot-sourcing this file installs nothing.
# Compatible with Windows PowerShell 5.1; no Expand-Archive dependency.

function Test-AndroidCommandLineToolsRoot([string]$Directory) {
    foreach ($relative in @('bin\sdkmanager.bat', 'lib\sdkmanager-classpath.jar', 'source.properties')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $relative) -PathType Leaf)) {
            return $false
        }
    }
    return $true
}

function Expand-AndroidCommandLineTools([string]$Archive, [string]$Destination) {
    # Windows PowerShell's Expand-Archive/Move-Item combination can fail on a
    # missing nested bin directory. Let .NET create the ZIP's directory tree,
    # including archives that have no explicit directory entries.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
    } catch {
        throw "Could not extract Android command-line tools. Check the download, free disk space and permissions. Details: $($_.Exception.Message)"
    }
    $standard = Join-Path $Destination 'cmdline-tools'
    if (Test-AndroidCommandLineToolsRoot $standard) { return $standard }

    # Accept an extra ZIP wrapper directory rather than assuming one layout.
    $candidates = @(Get-ChildItem -LiteralPath $Destination -Filter sdkmanager.bat -Recurse -File |
        ForEach-Object {
            $bin = Split-Path -Parent $_.FullName
            if ((Split-Path -Leaf $bin) -eq 'bin') {
                $root = Split-Path -Parent $bin
                if (Test-AndroidCommandLineToolsRoot $root) { $root }
            }
        })
    if ($candidates.Count -ne 1) {
        throw "The extracted Android tools are incomplete or ambiguous. Expected one tools folder containing bin\sdkmanager.bat, lib\sdkmanager-classpath.jar and source.properties. Found $($candidates.Count) complete folders in $Destination. Retry the download or install Android SDK Command-line Tools from Android Studio."
    }
    return $candidates[0]
}

function Install-AndroidCommandLineToolsDirectory([string]$Source, [string]$Sdk) {
    if (-not (Test-AndroidCommandLineToolsRoot $Source)) {
        throw "Android tools source is incomplete: $Source"
    }
    $parent = Join-Path $Sdk 'cmdline-tools'
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $destination = Join-Path $parent 'latest'
    if (Test-AndroidCommandLineToolsRoot $destination) { return }

    # Temp and SDK may be on different drives. Copy into an SDK-local staging
    # directory first, verify it, then rename on the SAME volume. Do not move a
    # directory tree directly from the user's TEMP drive into the SDK drive.
    $staging = Join-Path $parent ('.offline-llm-staging-' + [guid]::NewGuid().ToString('N'))
    $backup = $null
    try {
        New-Item -ItemType Directory -Path $staging | Out-Null
        Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force -ErrorAction Stop
        }
        if (-not (Test-AndroidCommandLineToolsRoot $staging)) {
            throw "Android tools copy is incomplete in $staging. Check disk space, permissions and antivirus quarantine."
        }
        if (Test-Path -LiteralPath $destination) {
            # Preserve, rather than delete, leftovers from an interrupted install.
            if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
                throw "A file occupies the SDK tools directory: $destination. Move it aside and retry."
            }
            $backup = Join-Path $parent ('latest.incomplete-' + [guid]::NewGuid().ToString('N'))
            [System.IO.Directory]::Move($destination, $backup)
            Write-Warning "Preserved the previous incomplete SDK tools at $backup"
        }
        try {
            [System.IO.Directory]::Move($staging, $destination)
        } catch {
            $installError = $_
            if ($backup -and -not (Test-Path -LiteralPath $destination)) {
                try { [System.IO.Directory]::Move($backup, $destination) }
                catch { Write-Warning "Could not restore the previous SDK tools; they remain at $backup" }
            }
            throw $installError
        }
    } finally {
        # Cleanup must never hide the actual extraction/copy/install failure.
        if (Test-Path -LiteralPath $staging) {
            try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop }
            catch { Write-Warning "Could not remove temporary SDK staging directory: $staging" }
        }
    }
}
$script:ToolVersion = '2026.10.16.4'
$script:CurrentStep = 'startup'
$Repository = $null
$StateDirectory = Join-Path $env:LOCALAPPDATA 'Offline-LLM\windows-build'

function Write-Step([string]$Text) {
    $script:CurrentStep = $Text
    Write-Host "`n== $Text ==" -ForegroundColor Cyan
}

function Test-SourceDirectory([string]$Directory) {
    try {
        if (-not $Directory -or -not (Test-Path -LiteralPath $Directory -PathType Container)) { return $false }
        foreach ($relative in @('package-lock.json', 'android\gradlew.bat', 'vendor\shared\packages\models\src\index.ts')) {
            if (-not (Test-Path -LiteralPath (Join-Path $Directory $relative) -PathType Leaf)) { return $false }
        }
        $packageFile = Join-Path $Directory 'package.json'
        if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) { return $false }
        $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
        return ($package.name -eq 'offgrid-mobile')
    } catch { return $false }
}

function Resolve-SourceDirectory {
    $saved = Join-Path $StateDirectory 'source-path.txt'
    $candidates = @($SourceDirectory, $env:OFFLINE_LLM_SOURCE_DIR, $LauncherDirectory,
        [string](Get-Location), (Join-Path $PSScriptRoot '..\..'))
    if (Test-Path -LiteralPath $saved) {
        try { $candidates += ([System.IO.File]::ReadAllText($saved).Trim()) }
        catch { Write-Warning 'Could not read the remembered source path.' }
    }
    foreach ($candidate in $candidates) {
        if (Test-SourceDirectory $candidate) { return [System.IO.Path]::GetFullPath($candidate) }
    }
    Write-Host 'These standalone batch files contain their own installer code.'
    Write-Host 'To compile the app, you still need an extracted Offline-LLM source ZIP (local-build.3 or newer).'
    Write-Host 'Choose the folder containing package.json, android and vendor. No GitHub login is requested.'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $answer = Read-Host 'Paste the full source folder path (blank to cancel)'
        if (-not $answer) { throw 'Cancelled: no source directory selected. Download/extract the source ZIP, then retry.' }
        $answer = $answer.Trim().Trim('"')
        if (Test-SourceDirectory $answer) { return [System.IO.Path]::GetFullPath($answer) }
        Write-Warning 'Not a complete Offline-LLM source folder. Select the extracted project folder, not its ZIP or android subfolder.'
    }
    throw 'Could not locate the source after three attempts. Set OFFLINE_LLM_SOURCE_DIR to its full path, or put these batch files beside package.json.'
}

function Refresh-ToolPath {
    # A winget installation updates persistent PATH, not this running process.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:Path"
}

function Read-ToolOutput([string]$Executable, [string]$Arguments) {
    # java -version writes to stderr even when it succeeds. Capture it without
    # treating that normal output as a terminating PowerShell error.
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $output = $process.StandardOutput.ReadToEnd()
        $errorOutput = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { return '' }
        return "$output`n$errorOutput"
    } finally {
        $process.Dispose()
    }
}

function Find-Node {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    $version = (Read-ToolOutput $command.Source '--version').Trim()
    if ($version -match '^v(\d+)\.(\d+)\.(\d+)$') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        if (($major -gt 22) -or ($major -eq 22 -and $minor -ge 13)) {
            return $command.Source
        }
    }
    return $null
}

function Find-Java17 {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME 'bin\java.exe') }
    $command = Get-Command java.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $adoptium = Join-Path $env:ProgramFiles 'Eclipse Adoptium'
    if (Test-Path -LiteralPath $adoptium) {
        $candidates += @(Get-ChildItem -LiteralPath $adoptium -Directory -Filter 'jdk-17*' |
            ForEach-Object { Join-Path $_.FullName 'bin\java.exe' })
    }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $version = Read-ToolOutput $candidate '-version'
        if ($version -match 'version "17(?:\.|\")') {
            # Require the compiler too: a JRE is not sufficient.
            $bin = Split-Path -Parent $candidate
            if (Test-Path -LiteralPath (Join-Path $bin 'javac.exe')) {
                return (Split-Path -Parent $bin)
            }
        }
    }
    return $null
}

function Install-WingetPackage([string]$Id) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "winget is missing. Install/update Microsoft's App Installer, or install Node.js 22 LTS and Temurin JDK 17 manually, then retry. See BUILD_ANDROID.md."
    }
    Write-Step "Installing $Id with Windows Package Manager"
    & winget.exe install --id $Id --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        throw "winget could not install $Id (exit $LASTEXITCODE). Install it manually using BUILD_ANDROID.md, then retry."
    }
    Refresh-ToolPath
}

function Get-SdkDirectory {
    # Respect an SDK already configured for this checkout before using defaults.
    $properties = Join-Path $Repository 'android\local.properties'
    if (Test-Path -LiteralPath $properties) {
        foreach ($line in [System.IO.File]::ReadAllLines($properties)) {
            if ($line -match '^\s*sdk\.dir\s*=\s*(.+)$') {
                $value = $Matches[1].Trim()
                $value = [regex]::Replace($value, '\\u([0-9a-fA-F]{4})', {
                    param($match)
                    [string][char][Convert]::ToInt32($match.Groups[1].Value, 16)
                })
                $value = $value.Replace('\:', ':').Replace('\\', '\')
                return [System.IO.Path]::GetFullPath($value)
            }
        }
    }
    if ($env:ANDROID_HOME) { return [System.IO.Path]::GetFullPath($env:ANDROID_HOME) }
    if ($env:ANDROID_SDK_ROOT) { return [System.IO.Path]::GetFullPath($env:ANDROID_SDK_ROOT) }
    return (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
}

function Find-SdkManager([string]$Sdk) {
    $preferred = Join-Path $Sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
    if (Test-AndroidCommandLineToolsRoot (Split-Path -Parent (Split-Path -Parent $preferred))) { return $preferred }
    $tools = Join-Path $Sdk 'cmdline-tools'
    if (Test-Path -LiteralPath $tools) {
        foreach ($directory in (Get-ChildItem -LiteralPath $tools -Directory | Sort-Object Name -Descending)) {
            $manager = Join-Path $directory.FullName 'bin\sdkmanager.bat'
            if (Test-AndroidCommandLineToolsRoot $directory.FullName) { return $manager }
        }
    }
    return $null
}

function Install-CommandLineTools([string]$Sdk) {
    Write-Step 'Downloading official Android command-line tools'
    # Pinned official Windows command-line tools; sdkmanager installs the pinned
    # platform/build tools below. Android Studio itself is not needed by Gradle.
    $url = 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip'
    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('offline-llm-sdk-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $source = $null
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $attemptDirectory = Join-Path $temporary ("attempt-$attempt")
            New-Item -ItemType Directory -Path $attemptDirectory | Out-Null
            $zip = Join-Path $attemptDirectory 'tools.zip'
            $oldProgress = $ProgressPreference
            try {
                Write-Step "Downloading and verifying SDK tools (attempt $attempt of 3)"
                $ProgressPreference = 'SilentlyContinue'
                Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300
                $source = Expand-AndroidCommandLineTools $zip (Join-Path $attemptDirectory 'unpacked')
                break
            } catch {
                if ($attempt -eq 3) {
                    throw "SDK download/extraction failed after 3 attempts. Check network/proxy, antivirus quarantine, permissions and disk space. Details: $($_.Exception.Message)"
                }
                Write-Warning "SDK download/extraction attempt $attempt failed: $($_.Exception.Message). Retrying..."
                Start-Sleep -Seconds (2 * $attempt)
            } finally { $ProgressPreference = $oldProgress }
        }
        if (-not $source) { throw 'No verified Android command-line tools were extracted.' }
        Write-Step 'Copying verified tools into the Android SDK'
        Install-AndroidCommandLineToolsDirectory $source $Sdk
    } finally {
        # Do not mask the real error if antivirus or permissions block cleanup.
        try {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction Stop }
        } catch { Write-Warning "Could not remove temporary SDK download directory: $temporary" }
    }
}

function Write-LocalProperties([string]$Sdk) {
    $properties = Join-Path $Repository 'android\local.properties'
    $lines = @()
    if (Test-Path -LiteralPath $properties) {
        $lines = @([System.IO.File]::ReadAllLines($properties) | Where-Object { $_ -notmatch '^\s*sdk\.dir\s*=' })
    }
    # Java .properties files need escaped non-ASCII characters, even when the
    # Windows account/SDK path has accents. Forward slashes avoid backslash escapes.
    $escaped = ''
    foreach ($character in $Sdk.Replace('\', '/').ToCharArray()) {
        if ([int]$character -gt 127) { $escaped += ('\u{0:x4}' -f [int]$character) }
        else { $escaped += $character }
    }
    $lines += "sdk.dir=$escaped"
    [System.IO.File]::WriteAllLines($properties, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-SdkComponents([string]$Sdk) {
    foreach ($relative in @('platform-tools\adb.exe', 'platforms\android-36\android.jar', 'build-tools\36.0.0\aapt2.exe', 'ndk\27.1.12297006\source.properties', 'cmake\3.22.1\bin\cmake.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Sdk $relative) -PathType Leaf)) {
            throw "Missing Android component: $relative. Run the NEW install-build-dependencies.bat. If setup already ran, check rejected SDK licenses or failed downloads in its log."
        }
    }
}

$previousDirectory = Get-Location
$result = 0
$transcribing = $false
$log = $null
try {
    New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
    $log = Join-Path $StateDirectory ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.log')
    try { Start-Transcript -LiteralPath $log | Out-Null; $transcribing = $true }
    catch { Write-Warning "Could not start the log: $($_.Exception.Message)" }
    Write-Host "Offline-LLM standalone Windows tools $script:ToolVersion ($Mode)" -ForegroundColor Cyan
    Write-Host 'No source-folder PowerShell helpers are loaded by the standalone batch files.'
    Write-Step 'Locating the app source'
    $Repository = Resolve-SourceDirectory
    Write-Host "Source: $Repository"
    try { [System.IO.File]::WriteAllText((Join-Path $StateDirectory 'source-path.txt'), $Repository) }
    catch { Write-Warning 'Could not remember the source path; you may be asked again next time.' }
    Set-Location -LiteralPath $Repository
    if (-not (Test-Path -LiteralPath (Join-Path $Repository 'package-lock.json'))) {
        throw 'The source folder is incomplete: package-lock.json is missing.'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'A 64-bit Windows computer is required for this toolchain.'
    }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        throw 'These launchers target x64 Windows build tools. On Windows ARM64, use the manual guide with a compatible toolchain.'
    }

    Write-Step 'Checking Node.js and npm'
    Refresh-ToolPath
    $node = Find-Node
    if (-not $node -and $Mode -eq 'dependencies') {
        Install-WingetPackage 'OpenJS.NodeJS.22'
        $node = Find-Node
    }
    if (-not $node) { throw 'Node.js 22.13+ was not found. Run install-build-dependencies.bat, or install Node.js 22 LTS and open a new terminal.' }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw 'npm.cmd was not found. Repair your Node.js installation, then retry.' }
    Write-Host ('Node: ' + (Read-ToolOutput $node '--version').Trim())

    Write-Step 'Checking JDK 17'
    $javaHome = Find-Java17
    if (-not $javaHome -and $Mode -eq 'dependencies') {
        Install-WingetPackage 'EclipseAdoptium.Temurin.17.JDK'
        $javaHome = Find-Java17
    }
    if (-not $javaHome) { throw 'JDK 17 was not found. Run install-build-dependencies.bat, or set JAVA_HOME to a JDK 17 installation.' }
    $env:JAVA_HOME = $javaHome
    $env:Path = "$javaHome\bin;$env:Path"
    Write-Host "JDK: $javaHome"

    Write-Step 'Checking Android SDK location'
    $sdk = Get-SdkDirectory
    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk
    $env:Path = "$sdk\platform-tools;$sdk\cmdline-tools\latest\bin;$env:Path"
    Write-Host "Android SDK: $sdk"

    if ($Mode -eq 'dependencies') {
        $manager = Find-SdkManager $sdk
        if (-not $manager) {
            Install-CommandLineTools $sdk
            $manager = Find-SdkManager $sdk
        }
        if (-not $manager) { throw 'Android SDK command-line tools could not be located.' }
        Write-Step 'Review Android SDK licenses (answer y only if you accept)'
        & $manager "--sdk_root=$sdk" --licenses
        if ($LASTEXITCODE -ne 0) { throw 'Android SDK license setup failed.' }
        Write-Step 'Installing Android platform, build tools, NDK and CMake'
        & $manager "--sdk_root=$sdk" 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' 'ndk;27.1.12297006' 'cmake;3.22.1'
        if ($LASTEXITCODE -ne 0) { throw 'Android SDK installation failed. Check accepted licenses, network access and free disk space.' }
        Assert-SdkComponents $sdk
        Write-LocalProperties $sdk
        Write-Step 'Installing locked npm dependencies and applying native patches'
        & $npm.Source ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Do not ignore failed native patches; fix the reported error before building.' }
        Write-Host "`nSetup complete. Run build-apk.bat next." -ForegroundColor Green
    } else {
        Assert-SdkComponents $sdk
        if (-not (Test-Path -LiteralPath (Join-Path $Repository 'node_modules\react-native\package.json'))) {
            throw 'App dependencies are missing. Run install-build-dependencies.bat first.'
        }
        Write-LocalProperties $sdk
        Write-Host "`nSigning: release builds use the included PUBLIC debug key unless you configured your own keystore." -ForegroundColor Yellow
        Write-Host 'See BUILD_ANDROID.md before distributing this APK or replacing an existing installation.'
        Write-Step 'Building standalone ARM64 release APK (first build can take a long time)'
        Set-Location -LiteralPath (Join-Path $Repository 'android')
        & '.\gradlew.bat' assembleRelease '-PreactNativeArchitectures=arm64-v8a' '--no-daemon' '--max-workers=2'
        if ($LASTEXITCODE -ne 0) { throw 'Gradle failed. See the first failing task above. No successful APK is being reported.' }
        $apk = Join-Path $Repository 'android\app\build\outputs\apk\release\app-release.apk'
        if (-not (Test-Path -LiteralPath $apk)) { throw "Gradle returned success but the expected APK is missing: $apk" }
        Write-Host "`nBuild successful. APK: $apk" -ForegroundColor Green
        Write-Host ('SHA-256: ' + (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash)
        Write-Host 'This APK targets ARM64 phones. Model weights are not included.'
    }
} catch {
    Write-Host ("ERROR during '$script:CurrentStep': " + $_.Exception.Message) -ForegroundColor Red
    Write-Host ("Tool version: $script:ToolVersion")
    Write-Host ('Details: ' + $_.Exception.ToString())
    Write-Host ('Location: ' + $_.ScriptStackTrace)
    Write-Host 'The operation stopped safely. Do not create the missing TEMP bin folder manually.'
    Write-Host 'If retrying fails, share the failed step and log after redacting personal paths or private data.'
    $result = 1
} finally {
    try { Set-Location -LiteralPath $previousDirectory }
    catch { Write-Warning 'Could not restore the original working directory.' }
    if ($transcribing) {
        try { Stop-Transcript | Out-Null }
        catch { Write-Warning 'Could not close the diagnostic transcript.' }
    }
    if ($log -and $transcribing) { Write-Host "Diagnostic log: $log" }
}
exit $result
