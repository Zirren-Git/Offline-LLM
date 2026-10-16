# Shared implementation for the two root-level Windows batch launchers.
# Requires Windows PowerShell 5.1 or later, not PowerShell 7.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('dependencies', 'build')]
    [string]$Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'android-sdk-tools.ps1')
$Repository = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Write-Step([string]$Text) {
    Write-Host "`n== $Text ==" -ForegroundColor Cyan
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
        $zip = Join-Path $temporary 'tools.zip'
        $oldProgress = $ProgressPreference
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        } finally {
            $ProgressPreference = $oldProgress
        }
        Write-Step 'Extracting and verifying Android command-line tools'
        $source = Expand-AndroidCommandLineTools $zip (Join-Path $temporary 'unpacked')
        Write-Step 'Copying verified tools into the Android SDK'
        Install-AndroidCommandLineToolsDirectory $source $Sdk
    } finally {
        # Only remove the uniquely named temporary directory this invocation made.
        if (Test-Path -LiteralPath $temporary) {
            try { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction Stop }
            catch { Write-Warning "Could not remove temporary SDK download directory: $temporary" }
        }
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

$previousDirectory = Get-Location
$result = 0
try {
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

    $javaHome = Find-Java17
    if (-not $javaHome -and $Mode -eq 'dependencies') {
        Install-WingetPackage 'EclipseAdoptium.Temurin.17.JDK'
        $javaHome = Find-Java17
    }
    if (-not $javaHome) { throw 'JDK 17 was not found. Run install-build-dependencies.bat, or set JAVA_HOME to a JDK 17 installation.' }
    $env:JAVA_HOME = $javaHome
    $env:Path = "$javaHome\bin;$env:Path"
    Write-Host "JDK: $javaHome"

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
        Write-LocalProperties $sdk
        Write-Step 'Installing locked npm dependencies and applying native patches'
        & $npm.Source ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Do not ignore failed native patches; fix the reported error before building.' }
        Write-Host "`nSetup complete. Run build-apk.bat next." -ForegroundColor Green
    } else {
        foreach ($relative in @('platforms\android-36\android.jar', 'build-tools\36.0.0\aapt2.exe', 'ndk\27.1.12297006\source.properties', 'cmake\3.22.1\bin\cmake.exe')) {
            if (-not (Test-Path -LiteralPath (Join-Path $sdk $relative))) {
                throw "Missing Android component: $relative. Run install-build-dependencies.bat first."
            }
        }
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
    [Console]::Error.WriteLine(('ERROR: ' + $_.Exception.Message))
    $result = 1
} finally {
    Set-Location -LiteralPath $previousDirectory
}
exit $result
