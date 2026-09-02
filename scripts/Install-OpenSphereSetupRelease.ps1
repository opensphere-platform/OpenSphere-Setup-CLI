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
$canonicalRepository = 'opensphere-platform/OpenSphere-Setup-CLI'
$githubHeaders = @{
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2026-03-10'
  'User-Agent' = 'OpenSphere-Setup-Installer'
}

function Get-ReleaseAsset {
  param(
    [Parameter(Mandatory)]$Release,
    [Parameter(Mandatory)][string]$Name
  )
  $matches = @($Release.assets | Where-Object { $_.name -eq $Name })
  if ($matches.Count -ne 1) {
    throw "Public release must contain exactly one $Name asset; found $($matches.Count)."
  }
  $asset = $matches[0]
  if ($asset.digest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw "GitHub release asset $Name has no canonical SHA-256 digest."
  }
  $url = [Uri]$asset.browser_download_url
  $expectedPrefix = "/$canonicalRepository/releases/download/$ReleaseTag/"
  if ($url.Scheme -ne 'https' -or $url.Host -ne 'github.com' -or
      -not $url.AbsolutePath.StartsWith($expectedPrefix, [StringComparison]::Ordinal)) {
    throw "GitHub release asset URL is outside the canonical public release path: $Name"
  }
  return $asset
}

function Save-VerifiedReleaseAsset {
  param(
    [Parameter(Mandatory)]$Asset,
    [Parameter(Mandatory)][string]$Destination
  )
  Invoke-WebRequest -Uri $Asset.browser_download_url -Headers $githubHeaders `
    -MaximumRedirection 5 -OutFile $Destination
  $actual = 'sha256:' + (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Asset.digest) {
    throw "GitHub release asset digest mismatch for $($Asset.name): $actual"
  }
}

if (-not $env:LOCALAPPDATA) {
  throw 'LOCALAPPDATA is required for the per-user OpenSphere installation.'
}
if ($Repository -ne $canonicalRepository) {
  throw "Only the canonical public Setup repository is accepted: $canonicalRepository"
}
if ($ReleaseTag -notmatch '^setup-v(?<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$') {
  throw "Invalid OpenSphere Setup release tag: $ReleaseTag"
}
$version = $Matches.version
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notmatch 'AMD64') {
  throw "This installer supports Windows amd64 only: $env:PROCESSOR_ARCHITECTURE"
}

$releaseApi = "https://api.github.com/repos/$canonicalRepository/releases/tags/$ReleaseTag"
Write-Host "[단계 01] 공개 OpenSphere Setup immutable release 조회 — $ReleaseTag"
$release = Invoke-RestMethod -Uri $releaseApi -Headers $githubHeaders -MaximumRedirection 0
if ($release.tag_name -ne $ReleaseTag -or $release.immutable -ne $true -or $release.draft -eq $true) {
  throw 'GitHub release is not the requested published immutable Setup release.'
}

$archiveName = 'opensphere-setup-windows-amd64.zip'
$archiveAsset = Get-ReleaseAsset -Release $release -Name $archiveName
$checksumsAsset = Get-ReleaseAsset -Release $release -Name 'SHA256SUMS'
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
  Write-Host '[단계 02] 공개 release asset 다운로드와 GitHub digest 검증'
  $archive = Join-Path $download $archiveName
  $checksums = Join-Path $download 'SHA256SUMS'
  Save-VerifiedReleaseAsset -Asset $archiveAsset -Destination $archive
  Save-VerifiedReleaseAsset -Asset $checksumsAsset -Destination $checksums

  Write-Host '[단계 03] SHA256SUMS 교차 검증'
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

  Write-Host '[단계 04] 자체 포함 runtime 압축 해제와 실행 검증'
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

  Write-Host "[단계 05] 사용자 전용 경로에 설치 — $installDirectory"
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
    Copy-Item -LiteralPath $stagedRoot -Destination $installationStaging -Recurse -Force
    $copiedSetup = Join-Path $installationStaging 'opensphere-setup.exe'
    if (-not (Test-Path -LiteralPath $copiedSetup -PathType Leaf)) {
      throw 'The verified Setup runtime could not be staged for installation.'
    }
    Move-Item -LiteralPath $installationStaging -Destination $installDirectory
  }

  New-Item -ItemType Directory -Force $BinDirectory | Out-Null
  $installedSetup = Join-Path $installDirectory 'opensphere-setup.exe'
  $shim = Join-Path $BinDirectory 'opensphere-setup.cmd'
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
        [System.IO.Path]::GetFullPath($BinDirectory),
        [StringComparison]::OrdinalIgnoreCase
      )
    }).Count -gt 0
    if (-not $hasBin) {
      $pathEntries = @($userPath.TrimEnd(';'), $BinDirectory) | Where-Object { $_ }
      $nextPath = [string]::Join(';', $pathEntries)
      [Environment]::SetEnvironmentVariable('Path', $nextPath, 'User')
    }
    $env:PATH = "$BinDirectory;$env:PATH"
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
