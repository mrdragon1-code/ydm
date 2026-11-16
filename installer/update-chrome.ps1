# Keeps the Chrome/Edge/Brave copy of YDM up to date.
#
# Chrome only updates extensions from its store, so the installer runs this
# script on a schedule for the current user (no administrator rights): it
# asks GitHub for the latest release, and if it is newer than the copy in
# the folder Chrome loads, downloads it, checks its SHA-256 against the one
# GitHub publishes, and replaces the files. manifest.json is written last:
# YDM notices the new version in it and reloads itself once no download is
# running.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File update-chrome.ps1 [-Repo owner/name] [-Dir path]

param(
  [string]$Repo = 'mrdragon1-code/ydm',
  [string]$Dir = (Join-Path $PSScriptRoot 'chrome')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$log = Join-Path $PSScriptRoot 'update.log'
function Log([string]$message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message
  Add-Content -Path $log -Value $line -Encoding utf8
  # Only the last 200 lines are kept.
  $all = Get-Content $log -ErrorAction SilentlyContinue
  if ($all.Count -gt 200) { $all | Select-Object -Last 200 | Set-Content $log -Encoding utf8 }
}

function Newer([string]$a, [string]$b) {
  $pa = $a.TrimStart('v').Split('.') | ForEach-Object { [int]$_ }
  $pb = $b.TrimStart('v').Split('.') | ForEach-Object { [int]$_ }
  for ($i = 0; $i -lt [Math]::Max($pa.Count, $pb.Count); $i++) {
    $x = if ($i -lt $pa.Count) { $pa[$i] } else { 0 }
    $y = if ($i -lt $pb.Count) { $pb[$i] } else { 0 }
    if ($x -ne $y) { return $x -gt $y }
  }
  return $false
}

$manifestPath = Join-Path $Dir 'manifest.json'
if (-not (Test-Path $manifestPath)) { Log "no YDM in $Dir; nothing to update"; exit 0 }
$current = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version

try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
    -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'YDM-updater' } -TimeoutSec 30
} catch {
  Log "GitHub not reachable: $($_.Exception.Message)"
  exit 0
}
$latest = $release.tag_name.TrimStart('v')
if ($release.draft -or $release.prerelease -or -not (Newer $latest $current)) { exit 0 }

$asset = $release.assets | Where-Object { $_.name -eq "ydm-$latest-chrome.zip" } | Select-Object -First 1
if (-not $asset) { Log "release $latest has no Chrome package"; exit 0 }
# Only files from this repository's own releases.
if (-not $asset.browser_download_url.StartsWith("https://github.com/$Repo/releases/download/")) {
  Log "unexpected download address: $($asset.browser_download_url)"
  exit 1
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("ydm-update-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $zip = Join-Path $work 'chrome.zip'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing -TimeoutSec 300 `
    -Headers @{ 'User-Agent' = 'YDM-updater' }

  # GitHub publishes each file's SHA-256: a damaged or altered download is refused.
  $expected = if ($asset.digest -match '^sha256:([0-9a-f]{64})$') { $Matches[1] } else { $null }
  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  if (-not $expected) { Log "release $latest has no checksum; not installed"; exit 1 }
  if ($actual -ne $expected) { Log "checksum mismatch for $latest; not installed"; exit 1 }

  $new = Join-Path $work 'chrome'
  Expand-Archive -Path $zip -DestinationPath $new
  $newManifest = Join-Path $new 'manifest.json'
  if (-not (Test-Path $newManifest)) { Log "package $latest has no manifest; not installed"; exit 1 }
  if ((Get-Content $newManifest -Raw | ConvertFrom-Json).version -ne $latest) {
    Log "package version differs from release $latest; not installed"
    exit 1
  }

  # Everything but the manifest first, old files removed; the manifest last,
  # so YDM only sees the new version once all of its files are in place.
  & robocopy $new $Dir /MIR /XF manifest.json /NFL /NDL /NJH /NJS /NP /R:3 /W:2 | Out-Null
  if ($LASTEXITCODE -ge 8) { Log "copy failed (robocopy $LASTEXITCODE)"; exit 1 }
  Copy-Item -Path $newManifest -Destination $manifestPath -Force
  Log "updated $current -> $latest"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
exit 0
