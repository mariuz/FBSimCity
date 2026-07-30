# Regenerates docs/screenshot.png from a live FBSimCity using headless Edge.
#
#   ./tools/screenshot.ps1                         # local server, stuck-OIT state
#   ./tools/screenshot.ps1 -Url "https://mariuz.github.io/FBSimCity/?scenario=locks&warp=30"
#
# Serve the repo first if shooting locally:  python -m http.server 8137

param(
  [string]$Url = "http://localhost:8137/?scenario=stuckoit&warp=50",
  [string]$Out = "docs/screenshot.png",
  [int]$Width = 1600,
  [int]$Height = 1000
)

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($null -eq $edge) {
  Write-Error "Microsoft Edge not found; install it or point this script at another Chromium."
  exit 1
}

$outPath = Join-Path (Split-Path $PSScriptRoot -Parent) $Out

# Use a throwaway profile and delete it afterwards. Without an explicit
# --user-data-dir, headless Chromium reuses (and grows) a default profile
# directory on every run; caches and crash dumps accumulate there unnoticed.
$profileDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fbsimcity-shot-" + [guid]::NewGuid())

try {
  & $edge --headless=new --disable-gpu --hide-scrollbars `
    --user-data-dir="$profileDir" --no-first-run --disable-extensions `
    --window-size="$Width,$Height" --virtual-time-budget=12000 `
    --screenshot="$outPath" $Url
} finally {
  if (Test-Path $profileDir) {
    Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (Test-Path $outPath) {
  Write-Host "Wrote $outPath ($((Get-Item $outPath).Length) bytes)"
} else {
  Write-Error "Screenshot was not written."
  exit 1
}
