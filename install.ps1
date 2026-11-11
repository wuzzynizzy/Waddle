# Download a clean Waddle checkout and install a small-server launcher.
$ErrorActionPreference = 'Stop'
$repo = 'wuzzynizzy/Waddle'
$ref = if ($env:WADDLE_REF) { $env:WADDLE_REF } else { 'main' }
$destination = if ($env:WADDLE_HOME) { $env:WADDLE_HOME } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Waddle' } else { Join-Path $HOME 'AppData\Local\Waddle' }

if ($ref -notmatch '^[A-Za-z0-9._/-]+$' -or $ref.Contains('..')) {
  throw 'WADDLE_REF must be a branch name.'
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw 'Waddle needs Node.js 20 or newer. Install Node, then run this installer again.'
}
$nodeVersionText = (& node --version).Trim()
if ($nodeVersionText -notmatch '^v?(\d+)\.') { throw "Could not read the Node.js version: $nodeVersionText" }
if ([int]$Matches[1] -lt 20) { throw "Waddle needs Node.js 20 or newer; found $nodeVersionText." }

$destination = [IO.Path]::GetFullPath($destination)
$trimmedDestination = $destination.TrimEnd([char[]]@('\', '/'))
$destinationRoot = [IO.Path]::GetPathRoot($destination).TrimEnd([char[]]@('\', '/'))
if (-not $trimmedDestination -or $trimmedDestination -ieq $destinationRoot) {
  throw 'Choose a dedicated install directory, not a drive or share root.'
}
$protectedPaths = @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:LOCALAPPDATA, $HOME) |
  Where-Object { $_ } |
  ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd([char[]]@('\', '/')) }
if ($protectedPaths -contains $trimmedDestination) {
  throw 'Choose a dedicated install directory, not a Windows or profile root.'
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('waddle-install-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $temp 'source.zip'
$expanded = Join-Path $temp 'expanded'
try {
  New-Item -ItemType Directory -Path $temp, $expanded -Force | Out-Null
  $archiveUrl = "https://codeload.github.com/$repo/zip/refs/heads/$ref"
  Write-Host "Fetching Waddle ($ref) from GitHub…"
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archive -UseBasicParsing
  Expand-Archive -Path $archive -DestinationPath $expanded -Force
  $source = Get-ChildItem -Path $expanded -Directory | Select-Object -First 1
  if (-not $source -or -not (Test-Path (Join-Path $source.FullName 'server.js'))) {
    throw 'The downloaded archive did not contain the Waddle server.'
  }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Copy-Item -Path (Join-Path $source.FullName '*') -Destination $destination -Recurse -Force

  $runner = @'
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $env:WADDLE_PROFILE) { $env:WADDLE_PROFILE = 'small' }
if (-not $env:NODE_OPTIONS) { $env:NODE_OPTIONS = '--max-old-space-size=320' }
node .\server.js
'@
  Set-Content -Path (Join-Path $destination 'run-waddle.ps1') -Value $runner -Encoding UTF8
  $runnerCmd = @'
@echo off
cd /d "%~dp0"
if not defined WADDLE_PROFILE set "WADDLE_PROFILE=small"
if not defined NODE_OPTIONS set "NODE_OPTIONS=--max-old-space-size=320"
node server.js
'@
  Set-Content -Path (Join-Path $destination 'run-waddle.cmd') -Value $runnerCmd -Encoding ASCII
  Write-Host "`nWaddle is installed in $destination"
  Write-Host ('Start it with: "' + $destination + '\run-waddle.cmd"')
  Write-Host 'Then open:     http://localhost:8080'
  Write-Host 'It listens on this machine only by default. Set a strong WADDLE_PASSWORD before exposing it.'
} finally {
  Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
