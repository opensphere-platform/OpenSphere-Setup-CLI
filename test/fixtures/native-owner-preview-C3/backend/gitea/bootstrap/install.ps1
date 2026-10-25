param(
  [string]$GiteaNamespace = 'opensphere-console-change',
  [string]$ConsoleNamespace = 'opensphere-console',
  [Parameter(Mandatory = $true)][string]$GiteaImage,
  [Parameter(Mandatory = $true)][string]$PostgresImage,
  [string]$StorageClass = 'standard',
  [string]$KubeContext = ''
)

# Fresh-install owner for the Console Declarative Change Authority. Recovery
# uses migrate-namespace.ps1 instead; this script never overwrites existing
# credentials, signing material, configuration, PVCs, or repository history.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $here 'gitea.yaml'
$signingScript = Join-Path $here 'configure-signing.ps1'
$controlPlaneScript = Join-Path $here 'control-plane-bootstrap.ps1'
$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @('--context', $KubeContext) }

function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  if ($InputText) { $InputText | & kubectl @kubectlArgs @Arguments }
  else { & kubectl @kubectlArgs @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
}

function New-RandomBase64([int]$Bytes = 48) {
  $buffer = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer)
}

function New-RandomSafePassword([int]$Length = 40) {
  $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  $buffer = New-Object byte[] $Length
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  $characters = New-Object char[] $Length
  for ($index = 0; $index -lt $Length; $index++) {
    $characters[$index] = $alphabet[$buffer[$index] % $alphabet.Length]
  }
  return -join $characters
}

function Read-Secret([string]$Namespace, [string]$Name) {
  $json = & kubectl @kubectlArgs -n $Namespace get secret $Name -o json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }
  return $json | ConvertFrom-Json
}

function Assert-SecretKeys([object]$Secret, [string[]]$Keys, [string]$Reference) {
  foreach ($key in $Keys) {
    if (-not $Secret.data.PSObject.Properties[$key]) {
      throw "Existing Secret '$Reference' lacks '$key'; refusing implicit credential rotation."
    }
  }
}

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl is required' }
foreach ($path in @($manifestPath, $signingScript, $controlPlaneScript)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing Gitea bootstrap artifact: $path" }
}
if ($GiteaImage -notmatch '^ghcr\.io/opensphere-platform/opensphere-console-gitea@sha256:[a-f0-9]{64}$') {
  throw 'GiteaImage must be the release-locked OpenSphere Gitea digest.'
}
if ($PostgresImage -notmatch '^ghcr\.io/opensphere-platform/opensphere-console-gitea-postgres@sha256:[a-f0-9]{64}$') {
  throw 'PostgresImage must be the release-locked OpenSphere Gitea PostgreSQL digest.'
}

$namespaceManifest = @{
  apiVersion = 'v1'
  kind = 'Namespace'
  metadata = @{
    name = $GiteaNamespace
    labels = @{
      'opensphere.io/layer' = 'console-change'
      'opensphere.io/change-authority' = 'gitea'
    }
  }
} | ConvertTo-Json -Depth 8 -Compress
Invoke-Kubectl @('apply', '-f', '-') $namespaceManifest

$runtime = Read-Secret $GiteaNamespace 'opensphere-gitea-runtime'
if ($runtime) {
  Assert-SecretKeys $runtime @('postgres-password', 'db-password') "$GiteaNamespace/opensphere-gitea-runtime"
  Write-Host 'Reusing existing Gitea runtime credentials.'
} else {
  $runtimeManifest = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{
      name = 'opensphere-gitea-runtime'
      namespace = $GiteaNamespace
      labels = @{ 'opensphere.io/secret-scope' = 'gitea-runtime-only' }
    }
    type = 'Opaque'
    stringData = @{
      'postgres-password' = New-RandomSafePassword
      'db-password' = New-RandomSafePassword
    }
  } | ConvertTo-Json -Depth 10 -Compress
  Invoke-Kubectl @('apply', '-f', '-') $runtimeManifest
}

$config = Read-Secret $GiteaNamespace 'opensphere-gitea-config'
if ($config) {
  Assert-SecretKeys $config @('app.ini') "$GiteaNamespace/opensphere-gitea-config"
  Write-Host 'Reusing existing private Gitea configuration.'
} else {
  $internalToken = New-RandomBase64 64
  $secretKey = New-RandomBase64 48
  $lfsJwtSecret = New-RandomBase64 48
  $appIni = @"
APP_NAME = OpenSphere Declarative Change Authority
RUN_MODE = prod
RUN_USER = git

[repository]
ROOT = /var/lib/gitea/git/repositories

[server]
DOMAIN = opensphere-gitea.$GiteaNamespace.svc.cluster.local
ROOT_URL = http://opensphere-gitea.$GiteaNamespace.svc.cluster.local:3000/
HTTP_PORT = 3000
DISABLE_SSH = true
LFS_START_SERVER = true

[security]
INSTALL_LOCK = true
SECRET_KEY = $secretKey
INTERNAL_TOKEN = $internalToken

[lfs]
JWT_SECRET = $lfsJwtSecret

[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = true
ENABLE_NOTIFY_MAIL = false

[session]
PROVIDER = file

[log]
MODE = console
LEVEL = Info
"@
  $configManifest = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{
      name = 'opensphere-gitea-config'
      namespace = $GiteaNamespace
      labels = @{ 'opensphere.io/secret-scope' = 'gitea-config-only' }
    }
    type = 'Opaque'
    stringData = @{ 'app.ini' = $appIni }
  } | ConvertTo-Json -Depth 10 -Compress
  Invoke-Kubectl @('apply', '-f', '-') $configManifest
}

& $signingScript -GiteaNamespace $GiteaNamespace -KubeContext $KubeContext
if ($LASTEXITCODE -ne 0) { throw 'Gitea signing bootstrap failed' }

$renderedManifest = (Get-Content -Raw -LiteralPath $manifestPath).
  Replace('__OPENSPHERE_GITEA_IMAGE__', $GiteaImage).
  Replace('image: postgres:17-alpine', "image: $PostgresImage").
  Replace('storageClassName: standard', "storageClassName: $StorageClass")
if ($renderedManifest -match '__OPENSPHERE_[A-Z0-9_]+__') {
  throw 'Gitea manifest contains an unresolved Setup placeholder.'
}
Invoke-Kubectl @('apply', '-f', '-') $renderedManifest
Invoke-Kubectl @('-n', $GiteaNamespace, 'rollout', 'status', 'deployment/opensphere-gitea-postgres', '--timeout=10m')

# gitea.yaml deliberately defaults the application to zero replicas so a
# restore target cannot create competing history. Fresh bootstrap owns the
# explicit transition to one replica after the database boundary is Ready.
Invoke-Kubectl @('-n', $GiteaNamespace, 'scale', 'deployment/opensphere-gitea', '--replicas=1')
Invoke-Kubectl @('-n', $GiteaNamespace, 'rollout', 'status', 'deployment/opensphere-gitea', '--timeout=10m')

& $controlPlaneScript -GiteaNamespace $GiteaNamespace -ConsoleNamespace $ConsoleNamespace -ReleaseType 'target' -KubeContext $KubeContext
if ($LASTEXITCODE -ne 0) { throw 'Gitea declarative control-plane bootstrap failed' }

Write-Host "Gitea Declarative Change Authority core installed in namespace $GiteaNamespace; post-merge target owner remains unconfigured."
