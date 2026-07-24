[CmdletBinding()]
param(
  [string]$ReleaseTag = '__OPENSPHERE_SETUP_RELEASE_TAG__',
  [string]$Repository = 'opensphere-platform/OpenSphere-Setup-CLI',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'OpenSphere\Setup'),
  [string]$BinDirectory = (Join-Path $env:LOCALAPPDATA 'OpenSphere\bin'),
  [switch]$NoPathUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-GitHubCli {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & gh @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI failed: gh $($Arguments -join ' ')"
  }
  return $output
}

if (-not $env:LOCALAPPDATA) {
  throw 'LOCALAPPDATA is required for the per-user OpenSphere installation.'
}
if ($ReleaseTag -notmatch '^setup-v(?<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$') {
  throw "Invalid OpenSphere Setup release tag: $ReleaseTag"
}
$version = $Matches.version
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notmatch 'AMD64') {
  throw "This installer supports Windows amd64 only: $env:PROCESSOR_ARCHITECTURE"
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI (gh) is required. Install gh, then run gh auth login.'
}

Invoke-GitHubCli auth status | Out-Host

$archiveName = 'opensphere-setup-windows-amd64.zip'
$expectedVersion = "opensphere-setup $version"
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporary = Join-Path $temporaryBase "opensphere-setup-install-$([Guid]::NewGuid().ToString('N'))"
$download = Join-Path $temporary 'download'
$expanded = Join-Path $temporary 'expanded'
$installDirectory = Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) $version
$installationStaging = "$installDirectory.installing-$([Guid]::NewGuid().ToString('N'))"
$BinDirectory = [System.IO.Path]::GetFullPath($BinDirectory)

New-Item -ItemType Directory -Force $download, $expanded | Out-Null

try {
  Write-Host "[단계 01] 비공개 OpenSphere Setup release 다운로드 — $ReleaseTag"
  Invoke-GitHubCli release download $ReleaseTag `
    --repo $Repository `
    --pattern $archiveName `
    --pattern 'SHA256SUMS' `
    --dir $download | Out-Host

  $archive = Join-Path $download $archiveName
  $checksums = Join-Path $download 'SHA256SUMS'
  if (-not (Test-Path -LiteralPath $archive) -or -not (Test-Path -LiteralPath $checksums)) {
    throw 'The private release did not contain the Windows archive and SHA256SUMS.'
  }

  Write-Host '[단계 02] Immutable release, attestation 및 SHA-256 검증'
  Invoke-GitHubCli release verify $ReleaseTag --repo $Repository | Out-Host
  Invoke-GitHubCli release verify-asset $ReleaseTag $archive --repo $Repository | Out-Host
  $checksumLine = Get-Content -LiteralPath $checksums |
    Where-Object { $_ -match " $([regex]::Escape($archiveName))$" } |
    Select-Object -First 1
  if (-not $checksumLine) {
    throw "SHA256SUMS does not contain $archiveName."
  }
  $expectedDigest = ($checksumLine -split '\s+')[0].ToLowerInvariant()
  $actualDigest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualDigest -ne $expectedDigest) {
    throw "OpenSphere Setup archive checksum mismatch: $actualDigest"
  }

  Write-Host '[단계 03] 자체 포함 runtime 압축 해제와 실행 검증'
  Expand-Archive -LiteralPath $archive -DestinationPath $expanded
  $stagedRoot = Join-Path $expanded 'opensphere-setup-windows-amd64'
  $stagedSetup = Join-Path $stagedRoot 'opensphere-setup.exe'
  if (-not (Test-Path -LiteralPath $stagedSetup -PathType Leaf)) {
    throw 'The verified archive does not contain opensphere-setup.exe.'
  }
  $stagedVersion = (& $stagedSetup version).Trim()
  if ($LASTEXITCODE -ne 0 -or $stagedVersion -ne $expectedVersion) {
    throw "Staged Setup version check failed: expected '$expectedVersion', got '$stagedVersion'"
  }

  Write-Host "[단계 04] 사용자 전용 경로에 설치 — $installDirectory"
  if (Test-Path -LiteralPath $installDirectory) {
    $existingSetup = Join-Path $installDirectory 'opensphere-setup.exe'
    $existingVersion = if (Test-Path -LiteralPath $existingSetup -PathType Leaf) {
      (& $existingSetup version).Trim()
    } else {
      ''
    }
    if ($LASTEXITCODE -ne 0 -or $existingVersion -ne $expectedVersion) {
      throw "Install target already exists but is not the verified release: $installDirectory"
    }
  } else {
    New-Item -ItemType Directory -Force (Split-Path -Parent $installDirectory) | Out-Null
    # The staged executable was just smoke-tested. Windows security scanners can
    # briefly retain a handle to it, which makes moving that directory fail even
    # after the child process exits. Copy into an unexecuted sibling first, then
    # atomically rename that sibling into the versioned installation directory.
    Copy-Item -LiteralPath $stagedRoot -Destination $installationStaging -Recurse -Force
    $copiedSetup = Join-Path $installationStaging 'opensphere-setup.exe'
    if (-not (Test-Path -LiteralPath $copiedSetup -PathType Leaf)) {
      throw 'The verified Setup runtime could not be staged for installation.'
    }
    Move-Item -LiteralPath $installationStaging -Destination $installDirectory
  }

  New-Item -ItemType Directory -Force $binDirectory | Out-Null
  $installedSetup = Join-Path $installDirectory 'opensphere-setup.exe'
  $shim = Join-Path $binDirectory 'opensphere-setup.cmd'
  [System.IO.File]::WriteAllText(
    $shim,
    "@echo off`r`n`"$installedSetup`" %*`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  if (-not $NoPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $hasBin = @($userPath -split ';' | Where-Object {
      $_ -and [string]::Equals(
        [System.IO.Path]::GetFullPath($_),
        [System.IO.Path]::GetFullPath($binDirectory),
        [StringComparison]::OrdinalIgnoreCase
      )
    }).Count -gt 0
    if (-not $hasBin) {
      $pathEntries = @($userPath.TrimEnd(';'), $binDirectory) | Where-Object { $_ }
      $nextPath = [string]::Join(';', $pathEntries)
      [Environment]::SetEnvironmentVariable('Path', $nextPath, 'User')
    }
    $env:PATH = "$binDirectory;$env:PATH"
  }

  $finalVersion = (& $shim version).Trim()
  if ($LASTEXITCODE -ne 0 -or $finalVersion -ne $expectedVersion) {
    throw "Installed command verification failed: expected '$expectedVersion', got '$finalVersion'"
  }

  Write-Host "[완료] $finalVersion"
  Write-Host "Command: $shim"
  Write-Host '다음 명령: opensphere-setup doctor --release edge --context docker-desktop --storage-class hostpath'
} finally {
  if (Test-Path -LiteralPath $installationStaging) {
    Remove-Item -LiteralPath $installationStaging -Recurse -Force -ErrorAction SilentlyContinue
  }
  $resolvedTemporary = [System.IO.Path]::GetFullPath($temporary)
  if ($resolvedTemporary.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolvedTemporary).StartsWith('opensphere-setup-install-')) {
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
  }
}
