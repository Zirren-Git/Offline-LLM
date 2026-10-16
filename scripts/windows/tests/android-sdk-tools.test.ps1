# Run on Windows without Pester or any downloads:
# powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\tests\android-sdk-tools.test.ps1
# Optionally pass -SdkDestinationRoot D:\Temp to test TEMP -> SDK across drives.
param([string]$SdkDestinationRoot = [System.IO.Path]::GetTempPath())
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\android-sdk-tools.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('offline-llm-sdk-tests-' + [guid]::NewGuid().ToString('N'))
$sdkTemporary = Join-Path $SdkDestinationRoot ('offline-llm-sdk-test-dest-' + [guid]::NewGuid().ToString('N'))
$script:failures = 0

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        Write-Host "PASS: $Name" -ForegroundColor Green
    } catch {
        $script:failures++
        Write-Host "FAIL: $Name - $($_.Exception.Message)" -ForegroundColor Red
    }
}
function New-ToolsZip([string]$Path, [string]$Prefix = 'cmdline-tools/', [switch]$Incomplete) {
    $zip = [System.IO.Compression.ZipFile]::Open($Path, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = @('bin/sdkmanager.bat', 'source.properties')
        if (-not $Incomplete) { $files += 'lib/sdkmanager-classpath.jar' }
        foreach ($file in $files) {
            # Deliberately create file entries ONLY: no bin/ directory entry.
            $entry = $zip.CreateEntry($Prefix + $file)
            $stream = $entry.Open()
            try {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes('fixture')
                $stream.Write($bytes, 0, $bytes.Length)
            } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
}

try {
    New-Item -ItemType Directory -Path $temporary | Out-Null
    New-Item -ItemType Directory -Path $sdkTemporary | Out-Null
    $archive = Join-Path $temporary 'tools.zip'
    New-ToolsZip $archive
    $script:tools = $null

    Test-Case 'extracts nested bin files even without explicit directory entries' {
        $output = Join-Path $temporary 'emil.gunnerlind [space] unpacked'
        $script:tools = Expand-AndroidCommandLineTools $archive $output
        Assert (Test-AndroidCommandLineToolsRoot $script:tools) 'Expected a complete extracted tools directory.'
    }
    Test-Case 'copies into an SDK-local stage and installs latest' {
        $sdk = Join-Path $sdkTemporary 'SDK with [brackets] and spaces'
        Install-AndroidCommandLineToolsDirectory $script:tools $sdk
        Assert (Test-AndroidCommandLineToolsRoot (Join-Path $sdk 'cmdline-tools\latest')) 'Installed tools are incomplete.'
        $stages = @(Get-ChildItem -LiteralPath (Join-Path $sdk 'cmdline-tools') -Directory -Filter '.offline-llm-staging-*')
        Assert ($stages.Count -eq 0) 'A staging directory was left behind.'
    }
    Test-Case 'reuses complete latest without overwriting it' {
        $sdk = Join-Path $sdkTemporary 'SDK with [brackets] and spaces'
        $marker = Join-Path $sdk 'cmdline-tools\latest\keep.txt'
        [System.IO.File]::WriteAllText($marker, 'keep existing install')
        Install-AndroidCommandLineToolsDirectory $script:tools $sdk
        Assert ([System.IO.File]::ReadAllText($marker) -eq 'keep existing install') 'Existing tools were overwritten.'
    }
    Test-Case 'preserves and repairs an incomplete previous latest' {
        $sdk = Join-Path $sdkTemporary 'partial-sdk'
        $latest = Join-Path $sdk 'cmdline-tools\latest'
        New-Item -ItemType Directory -Path $latest -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $latest 'old-file.txt'), 'preserve me')
        Install-AndroidCommandLineToolsDirectory $script:tools $sdk
        Assert (Test-AndroidCommandLineToolsRoot $latest) 'Repair did not install complete tools.'
        $backups = @(Get-ChildItem -LiteralPath (Join-Path $sdk 'cmdline-tools') -Directory -Filter 'latest.incomplete-*')
        Assert ($backups.Count -eq 1) 'Expected one preserved backup.'
        Assert (Test-Path -LiteralPath (Join-Path $backups[0].FullName 'old-file.txt')) 'Previous files were lost.'
    }
    Test-Case 'handles an additional ZIP wrapper directory' {
        $wrapped = Join-Path $temporary 'wrapped.zip'
        New-ToolsZip $wrapped 'wrapper/cmdline-tools/'
        $root = Expand-AndroidCommandLineTools $wrapped (Join-Path $temporary 'wrapped')
        Assert (Test-AndroidCommandLineToolsRoot $root) 'Wrapped archive was not located.'
    }
    Test-Case 'rejects an incomplete archive with an actionable error' {
        $incomplete = Join-Path $temporary 'incomplete.zip'
        New-ToolsZip $incomplete -Incomplete
        $message = ''
        try { Expand-AndroidCommandLineTools $incomplete (Join-Path $temporary 'incomplete') | Out-Null }
        catch { $message = $_.Exception.Message }
        Assert ($message -like '*incomplete or ambiguous*') 'Missing library was not reported as incomplete.'
    }
    Test-Case 'rejects a corrupt ZIP without replacing the extraction error' {
        $corrupt = Join-Path $temporary 'corrupt.zip'
        [System.IO.File]::WriteAllText($corrupt, 'not a zip')
        $message = ''
        try { Expand-AndroidCommandLineTools $corrupt (Join-Path $temporary 'corrupt') | Out-Null }
        catch { $message = $_.Exception.Message }
        Assert ($message -like 'Could not extract Android command-line tools.*') 'Extraction error was not preserved.'
    }
    Test-Case 'does not accept sdkmanager alone as a complete installation' {
        $partial = Join-Path $temporary 'manager-only'
        New-Item -ItemType Directory -Path (Join-Path $partial 'bin') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $partial 'bin\sdkmanager.bat'), 'fixture')
        Assert (-not (Test-AndroidCommandLineToolsRoot $partial)) 'An incomplete installation was accepted.'
    }
} finally {
    foreach ($path in @($temporary, $sdkTemporary)) {
        if (Test-Path -LiteralPath $path) {
            try { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
            catch { Write-Warning "Test temporary directory could not be removed: $path" }
        }
    }
}
if ($script:failures -gt 0) { exit 1 }
Write-Host 'All 8 SDK filesystem regression tests passed.' -ForegroundColor Green
exit 0
