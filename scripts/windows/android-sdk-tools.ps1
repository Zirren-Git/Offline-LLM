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
