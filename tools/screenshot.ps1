# Regenerates docs/screenshot.png from a live FBSimCity using headless Edge.
#
#   ./tools/screenshot.ps1                         # local server, stuck-OIT state
#   ./tools/screenshot.ps1 -Url "https://mariuz.github.io/FBSimCity/?scenario=locks&warp=30"
#
# Serve the repo first if shooting locally:  python -m http.server 8137
#
# ASCII only, deliberately: Windows PowerShell 5.1 reads a .ps1 as ANSI unless
# it carries a BOM, so a stray em dash in a comment is a parse error rather
# than a typo.

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

# Shoot to a temp file and move it into place only on success.
#
# This script used to point Edge straight at $Out and report "Wrote ..." if the
# file existed afterwards. Two things went wrong with that, and both were found
# by looking at the image it produced for the v0.9.0 README: it showed a city
# three releases old.
#
#   1. Calling the exe with the call operator did not reliably wait for it, so
#      the existence check ran while Edge was still starting. Start-Process
#      -Wait actually waits.
#   2. On a failed run the previous image was still sitting at $Out, so the
#      check passed and the script announced a screenshot it had not taken.
#
# A tool that reports success it did not achieve is worse than one that fails
# loudly, and this one had been quietly lying for at least one release.
$shotPath = Join-Path ([System.IO.Path]::GetTempPath()) ("fbsimcity-shot-" + [guid]::NewGuid() + ".png")

$args = @(
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--user-data-dir=$profileDir", "--no-first-run", "--disable-extensions",
  "--window-size=$Width,$Height", "--virtual-time-budget=20000",
  "--screenshot=$shotPath", $Url
)

try {
  $proc = Start-Process -FilePath $edge -ArgumentList $args -Wait -PassThru -NoNewWindow
  $edgeExit = $proc.ExitCode
} finally {
  if (Test-Path $profileDir) {
    Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path $shotPath)) {
  Write-Error "Edge exited $edgeExit without writing a screenshot. $Out left untouched."
  exit 1
}

$bytes = (Get-Item $shotPath).Length
if ($bytes -lt 20000) {
  Remove-Item $shotPath -Force -ErrorAction SilentlyContinue
  Write-Error "Screenshot was only $bytes bytes, so the page probably did not render. $Out left untouched."
  exit 1
}

Move-Item $shotPath $outPath -Force
Write-Host "Wrote $outPath ($bytes bytes)"
Write-Host "  from $Url"
