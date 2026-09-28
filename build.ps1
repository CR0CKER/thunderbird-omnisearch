[CmdletBinding()]
param(
    [switch]$Release
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$manifest = Get-Content -Raw -LiteralPath 'manifest.json' | ConvertFrom-Json
$version = $manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'manifest.json does not contain a version.'
}

$stamp = ''
if (-not $Release) {
    $gitDir = & git rev-parse --git-dir 2>$null
    if ($LASTEXITCODE -eq 0) {
        $branch = (& git rev-parse --abbrev-ref HEAD 2>$null).Trim()
        if ([string]::IsNullOrWhiteSpace($branch)) { $branch = 'detached' }
        $sha = (& git rev-parse --short HEAD 2>$null).Trim()
        if ([string]::IsNullOrWhiteSpace($sha)) { $sha = 'unknown' }

        & git diff --quiet HEAD -- 2>$null
        $dirty = if ($LASTEXITCODE -ne 0) { '-dirty' } else { '' }
        $safeBranch = $branch -replace '/', '-'
        $safeBranch = $safeBranch -replace '[^A-Za-z0-9._-]', ''
        $stamp = "+$safeBranch-$sha$dirty"
    }
}

$xpi = "thunderbird-omnisearch-$version$stamp.xpi"
$zip = "$xpi.zip"
Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'thunderbird-omnisearch-*.xpi' -File |
    Remove-Item -Force

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("thunderbird-omnisearch-" + [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    $include = @('manifest.json', 'background.js', 'lib', 'ui', 'options', 'icons', 'README.md', 'LICENSE')
    foreach ($item in $include) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $item) -Destination $staging -Recurse -Force
    }

    Remove-Item -LiteralPath (Join-Path $staging 'icons\omnisearch-128.png') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $staging 'lib\VENDOR.md') -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $staging -Recurse -Include '*.DS_Store', '*.map' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force

    Add-Type -AssemblyName System.IO.Compression
    $zipPath = Join-Path $PSScriptRoot $zip
    $zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
    $archive = [System.IO.Compression.ZipArchive]::new(
        $zipStream,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        Get-ChildItem -Path $staging -Recurse -File | ForEach-Object {
            $entryName = $_.FullName.Substring($staging.Length + 1) -replace '\\', '/'
            $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $input = $_.OpenRead()
            $output = $entry.Open()
            try {
                $input.CopyTo($output)
            }
            finally {
                $output.Dispose()
                $input.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
        $zipStream.Dispose()
    }
    Move-Item -LiteralPath (Join-Path $PSScriptRoot $zip) -Destination (Join-Path $PSScriptRoot $xpi) -Force
}
finally {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot $zip)) {
        Remove-Item -LiteralPath (Join-Path $PSScriptRoot $zip) -Force
    }
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}

Write-Output "Built $xpi"
if ($stamp) {
    Write-Output "  development build - run '.\build.ps1 -Release' for the release artifact"
}