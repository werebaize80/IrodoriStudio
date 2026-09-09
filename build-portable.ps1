$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$binary = Join-Path $projectRoot "src-tauri\target\release\IrodoriStudio.exe"
if (-not (Test-Path -LiteralPath $binary)) {
    $binary = Join-Path $projectRoot "src-tauri\target\release\irodori_studio.exe"
}
$destination = Join-Path $projectRoot "IrodoriStudio.exe"
if (-not (Test-Path -LiteralPath $binary)) {
    throw "Built IrodoriStudio.exe was not found. Run npm run tauri build -- --no-bundle first."
}
Copy-Item -LiteralPath $binary -Destination $destination -Force
foreach ($relative in @("runtime", "irodori", "server", "models", "data\voices", "data\favorites", "data\history", "data\temp", "data\cache", "data\logs", "licenses")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot $relative) | Out-Null
}
Write-Output "Portable executable: $destination"
