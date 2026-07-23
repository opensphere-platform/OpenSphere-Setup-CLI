[CmdletBinding()]
param()

# Registers the repository's package bin as the canonical user-facing
# `opensphere-setup` command. npm installs a versioned package copy under the
# current user's configured global prefix; the command does not depend on the
# repository remaining at this path.
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$package = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
$expectedVersion = "opensphere-setup $($package.version)"

foreach ($required in @('node', 'npm')) {
  if (-not (Get-Command $required -ErrorAction SilentlyContinue)) {
    throw "$required is required to install the opensphere-setup command."
  }
}

& npm install --global $repoRoot --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  throw 'npm failed to install the opensphere-setup command.'
}

$command = Get-Command opensphere-setup -ErrorAction SilentlyContinue
if (-not $command) {
  $prefix = (& npm prefix --global).Trim()
  throw "opensphere-setup was installed but is not on PATH. Add the npm global prefix to PATH: $prefix"
}

$version = (& $command.Source version).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne $expectedVersion) {
  throw "The installed opensphere-setup command failed its version check: expected '$expectedVersion', got '$version'"
}

Write-Host "[완료] $version"
Write-Host "Command: $($command.Source)"
