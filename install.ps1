<#
.SYNOPSIS
    Installs the DICOM Tool CLI Agent (dcm) for the current user.

.DESCRIPTION
    Downloads the latest release binary, verifies its checksum against the
    published SHA256SUMS.txt, installs it under the user's local programs
    folder, and adds that folder to the user PATH.

    Nothing is written outside the user profile and no administrator rights are
    required. The system PATH is never touched.

.EXAMPLE
    irm https://raw.githubusercontent.com/Alan6195/dcm-cli-agent/master/install.ps1 | iex

.EXAMPLE
    .\install.ps1 -Version v0.2.0
#>
[CmdletBinding()]
param(
    [string]$Repo = 'Alan6195/dcm-cli-agent',
    [string]$Version = 'latest',
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\dcm-cli",
    [switch]$NoPath
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Note($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '  DICOM Tool CLI Agent - installer' -ForegroundColor Cyan
Write-Host ''

# --- Work out which release to fetch -----------------------------------------
$api = if ($Version -eq 'latest') {
    "https://api.github.com/repos/$Repo/releases/latest"
} else {
    "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

Write-Step "Looking up the $Version release of $Repo"
try {
    $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'dcm-installer' }
} catch {
    throw "Could not reach the GitHub release API: $($_.Exception.Message)"
}

$tag = $release.tag_name
Write-Note "Found $tag"

# Windows is x64-only for now; arm64 Windows runs the x64 build under emulation.
$assetName = 'dcm-windows-x64.exe'
$asset = $release.assets | Where-Object { $_.name -eq $assetName }
if (-not $asset) {
    $available = ($release.assets | ForEach-Object { $_.name }) -join ', '
    throw "Release $tag has no asset named $assetName. Available: $available"
}

# --- Download ----------------------------------------------------------------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "dcm-install-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tmp | Out-Null
$downloaded = Join-Path $tmp $assetName

try {
    Write-Step "Downloading $assetName ($([math]::Round($asset.size / 1MB, 1)) MB)"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloaded -UseBasicParsing

    # --- Verify ---------------------------------------------------------------
    # Fails closed: a release with no checksum file, or a checksum file with
    # no line for this asset, is refused rather than installed unverified.
    $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }
    if (-not $sums) {
        throw "$tag publishes no SHA256SUMS.txt, so the download cannot be verified. Not installing. Pick a newer release with -Version."
    }
    Write-Step 'Verifying checksum'
    $sumsBytes = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing).Content
    # A .txt asset is served as application/octet-stream, which Windows
    # PowerShell hands back as bytes rather than a string.
    $sumsText = if ($sumsBytes -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($sumsBytes) } else { [string]$sumsBytes }
    # Match the filename field exactly (sha256sum may prefix it with '*'),
    # not as a substring of the line.
    $expected = $null
    foreach ($line in ($sumsText -split "`r?`n")) {
        $fields = $line.Trim() -split '\s+', 2
        if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -ceq $assetName) { $expected = $fields[0]; break }
    }
    if (-not $expected) {
        throw "SHA256SUMS.txt for $tag has no entry for $assetName. Not installing."
    }

    $actual = (Get-FileHash $downloaded -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
        throw "Checksum mismatch. Expected $expected but got $actual. Not installing."
    }
    Write-Note "OK  $actual"

    # --- Install --------------------------------------------------------------
    Write-Step "Installing to $InstallDir"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $target = Join-Path $InstallDir 'dcm.exe'

    try {
        Copy-Item $downloaded $target -Force
    } catch {
        throw "Could not write $target. Close any running dcm windows and try again. ($($_.Exception.Message))"
    }

    # Clear the downloaded-from-the-internet mark if one is present. Files
    # fetched by Invoke-WebRequest normally have none, but Copy-Item preserves
    # it when there is, and SmartScreen warns on every launch of a marked
    # unsigned executable rather than only the first.
    Unblock-File -Path $target -ErrorAction SilentlyContinue

    # --- PATH -----------------------------------------------------------------
    if (-not $NoPath) {
        # Read and write the registry value directly, preserving its type.
        # setx is deliberately avoided: it truncates at 1024 characters, which
        # is a well-known way to destroy someone's PATH.
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        # A profile that has never had a user PATH has no Path value at all, and
        # GetValueKind throws on a missing value rather than reporting it. Treat
        # that as an empty String-kind PATH — the clean-machine case this is most
        # likely to run on.
        try { $kind = $key.GetValueKind('Path') } catch { $kind = 'String' }
        $current = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')

        $entries = @($current -split ';' | Where-Object { $_.Trim() -ne '' })
        $already = $entries | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') }

        if ($already) {
            Write-Note 'Already on your PATH'
        } else {
            Write-Step 'Adding it to your user PATH'
            $key.SetValue('Path', (($entries + $InstallDir) -join ';'), $kind)
        }
        $key.Close()
    }

    Write-Host ''
    Write-Host '  Installed.' -ForegroundColor Green
    Write-Host ''
    Write-Host '  Open a NEW terminal, then:' -ForegroundColor White
    Write-Host ''
    Write-Host '      dcm' -ForegroundColor Cyan -NoNewline
    Write-Host '                     interactive menu'
    Write-Host '      dcm --help' -ForegroundColor Cyan -NoNewline
    Write-Host '              full command reference'
    Write-Host '      dcm info C:\path\to\study' -ForegroundColor Cyan
    Write-Host ''
    Write-Note 'The new terminal matters: PATH is read when a shell starts.'
    Write-Host ''
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
