$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$packages = Join-Path $root "packages"
$chromeStage = Join-Path $packages "chrome"
$firefoxStage = Join-Path $packages "firefox"

if (Test-Path $packages) {
    Remove-Item $packages -Recurse -Force
}

New-Item $chromeStage -ItemType Directory -Force | Out-Null
New-Item $firefoxStage -ItemType Directory -Force | Out-Null

$commonFiles = @(
    "background.js", "content.js", "page.js", "popup.html", "popup.css",
    "popup.js", "offscreen.html", "offscreen.js"
)

foreach ($file in $commonFiles) {
    Copy-Item (Join-Path $root $file) (Join-Path $chromeStage $file)
    Copy-Item (Join-Path $root $file) (Join-Path $firefoxStage $file)
}

Copy-Item (Join-Path $root "icons") (Join-Path $chromeStage "icons") -Recurse
Copy-Item (Join-Path $root "icons") (Join-Path $firefoxStage "icons") -Recurse
Copy-Item (Join-Path $root "manifest.json") (Join-Path $chromeStage "manifest.json")
Copy-Item (Join-Path $root "manifest.firefox.json") (Join-Path $firefoxStage "manifest.json")

Compress-Archive -Path (Join-Path $chromeStage "*") -DestinationPath (Join-Path $packages "animelib-downloader-chrome.zip")
Compress-Archive -Path (Join-Path $firefoxStage "*") -DestinationPath (Join-Path $packages "animelib-downloader-firefox.zip")

Remove-Item $chromeStage -Recurse -Force
Remove-Item $firefoxStage -Recurse -Force

Write-Host "Store packages created in: $packages"
