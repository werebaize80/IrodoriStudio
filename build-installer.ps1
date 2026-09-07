$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installerDirectory = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"

Push-Location $projectRoot
try {
    npm run tauri build -- --bundles nsis
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to build the NSIS installer."
    }

    $installer = Get-ChildItem -LiteralPath $installerDirectory -File | Where-Object { $_.Name -like '*-setup.exe' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) {
        throw "The NSIS installer was not found."
    }
    Write-Output "Windows installer: $($installer.FullName)"
} finally {
    Pop-Location
}
