$ErrorActionPreference = "Stop"

$source = $PSScriptRoot
$target = Join-Path $source "dist-firefox"

if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
}

New-Item $target -ItemType Directory | Out-Null
Copy-Item (Join-Path $source "*.js") $target
Copy-Item (Join-Path $source "*.html") $target
Copy-Item (Join-Path $source "*.css") $target
Copy-Item (Join-Path $source "icons") $target -Recurse
Copy-Item (Join-Path $source "manifest.firefox.json") (Join-Path $target "manifest.json")

Write-Host "Firefox build created: $target"
