[CmdletBinding()]
param(
  [ValidateSet('edge', 'candidate', 'stable')][string]$Channel = 'edge',
  [ValidateRange(1, 100)][int]$Iterations = 1,
  [string]$Context = 'docker-desktop',
  [switch]$InterruptAfterLock,
  [switch]$RemoveAfterLastRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$EvidenceDirectory = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot '.opensphere-e2e'))
if (-not $EvidenceDirectory.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Evidence path escaped repository root: $EvidenceDirectory"
}
[System.IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null


$Namespaces = @(
  'opensphere-console-data',
  'opensphere-console-change',
  'opensphere-monitoring',
  'opensphere-console',
  'opensphere-system'
)
$Crds = @(
  'uipluginpackages.plugins.opensphere.io',
  'uipluginregistrations.plugins.opensphere.io'
)
$ClusterRoles = @(
  'opensphere-extension-controller-cli-downloads',
  'opensphere-registry'
)
$ClusterRoleBindings = @(
  'opensphere-extension-controller-cli-downloads',
  'opensphere-registry'
)
$AdmissionPolicies = @(
  'opensphere-console-manual-ui-contract',
  'opensphere-console-image-integrity-workload',
  'opensphere-console-image-integrity-cronjob'
)
$AdmissionPolicyBindings = @(
  'opensphere-console-manual-ui-contract',
  'opensphere-console-image-integrity-workload',
  'opensphere-console-image-integrity-cronjob'
)
$ManagedSecrets = @(
  'opensphere-console-data/opensphere-supabase-secrets',
  'opensphere-console-change/opensphere-gitea-runtime',
  'opensphere-console-change/opensphere-gitea-config',
  'opensphere-console-change/opensphere-gitea-signing',
  'opensphere-monitoring/beszel-runtime',
  'opensphere-console/shell-tls',
  'opensphere-console/opensphere-console-api-runtime',
  'opensphere-console/opensphere-extension-controller-runtime',
  'opensphere-console/opensphere-gitea-control-plane',
  'opensphere-console/opensphere-console-cli-runtime',
  'opensphere-console/opensphere-baseline-monitoring-reader',
  'opensphere-console-data/opensphere-ghcr-pull',
  'opensphere-console-change/opensphere-ghcr-pull',
  'opensphere-monitoring/opensphere-ghcr-pull',
  'opensphere-console/opensphere-ghcr-pull',
  'opensphere-system/opensphere-ghcr-pull'
)


function Invoke-Kubectl {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & kubectl --context $Context @Arguments
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
}


function Get-OtherProductNamespaceIdentity {
  $json = & kubectl --context $Context get namespaces -o json
  if ($LASTEXITCODE -ne 0) { throw 'Namespace inventory failed before scoped cleanup' }
  if ([string]::IsNullOrWhiteSpace(($json -join ''))) { return @() }
  $objects = $json | ConvertFrom-Json
  $items = if ($null -eq $objects -or $null -eq $objects.items) { @() } else { @($objects.items) }
  return @($items | Where-Object {
    $null -ne $_.metadata -and
    [string]$_.metadata.name -like 'opensphere-*' -and
    [string]$_.metadata.name -notin $Namespaces
  } | ForEach-Object {
    [pscustomobject]@{ name = [string]$_.metadata.name; uid = [string]$_.metadata.uid }
  })
}

function Assert-OtherProductNamespacesPreserved([object[]]$Before) {
  foreach ($entry in $Before) {
    $current = & kubectl --context $Context get namespace $entry.name -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $current.metadata.uid -ne $entry.uid) {
      throw "Cleanup changed another OpenSphere product namespace: $($entry.name)"
    }
  }
}

function Assert-NoCustomResourceInstances {
  foreach ($crd in $Crds) {
    $definitionJson = & kubectl --context $Context get customresourcedefinition $crd --ignore-not-found -o json
    if ($LASTEXITCODE -ne 0) { throw "CRD identity check failed before scoped cleanup: $crd" }
    if ([string]::IsNullOrWhiteSpace(($definitionJson -join ''))) { continue }
    $definition = $definitionJson | ConvertFrom-Json
    if ($null -eq $definition -or $definition.metadata.name -ne $crd -or $definition.spec.scope -ne 'Namespaced') {
      throw "Refusing to delete CRD with unexpected identity or scope: $crd"
    }

    $inventoryJson = & kubectl --context $Context get $crd --all-namespaces -o json
    if ($LASTEXITCODE -ne 0) { throw "Cluster-wide CR inventory failed before scoped cleanup: $crd" }
    $inventory = $inventoryJson | ConvertFrom-Json
    if ($null -eq $inventory -or $null -eq $inventory.items) {
      throw "Cluster-wide CR inventory was not an exact Kubernetes List: $crd"
    }
    $items = @($inventory.items)
    if ($items.Count) {
      $references = @($items | ForEach-Object { "$([string]$_.metadata.namespace)/$([string]$_.metadata.name)" })
      throw "Refusing to delete shared CRD ${crd}; cluster-wide instances remain: $($references -join ', ')"
    }
  }
}

function Remove-OpenSphere {
  $otherProductNamespaces = Get-OtherProductNamespaceIdentity
  Invoke-Kubectl delete namespace @Namespaces --ignore-not-found --wait=false | Out-Null
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
  do {
    $remaining = @($Namespaces | Where-Object {
      (& kubectl --context $Context get namespace $_ --ignore-not-found -o name 2>$null)
    })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Seconds 2
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  if ($remaining.Count) { throw "Namespaces did not terminate: $($remaining -join ', ')" }

  Assert-NoCustomResourceInstances
  Invoke-Kubectl delete customresourcedefinition @Crds --ignore-not-found --wait=true | Out-Null
  Invoke-Kubectl delete clusterrole @ClusterRoles --ignore-not-found --wait=true | Out-Null
  Invoke-Kubectl delete clusterrolebinding @ClusterRoleBindings --ignore-not-found --wait=true | Out-Null
  Invoke-Kubectl delete validatingadmissionpolicybinding @AdmissionPolicyBindings --ignore-not-found --wait=true | Out-Null
  Invoke-Kubectl delete validatingadmissionpolicy @AdmissionPolicies --ignore-not-found --wait=true | Out-Null

  Assert-OtherProductNamespacesPreserved $otherProductNamespaces

  $pvs = & kubectl --context $Context get pv -o json | ConvertFrom-Json
  $pvItems = if ($null -eq $pvs -or $null -eq $pvs.items) { @() } else { @($pvs.items) }
  $leftovers = @($pvItems | Where-Object { $_.spec.claimRef.namespace -in $Namespaces })
  if ($leftovers.Count) {
    throw "OpenSphere persistent volumes remain after cleanup: $($leftovers.metadata.name -join ', ')"
  }
}

function Reset-TestEnvironment {
  Remove-OpenSphere
}

function Get-SecretFingerprint {
  $values = [ordered]@{}
  foreach ($reference in $ManagedSecrets) {
    $parts = $reference.Split('/', 2)
    $secret = & kubectl --context $Context -n $parts[0] get secret $parts[1] -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Secret lookup failed: $reference" }
    $canonical = [ordered]@{}
    foreach ($property in @($secret.data.PSObject.Properties | Sort-Object Name)) {
      $canonical[$property.Name] = $property.Value
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($canonical | ConvertTo-Json -Compress))
    $values[$reference] = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  }
  return $values
}

function Invoke-Setup {
  Push-Location $RepoRoot
  try {
    & opensphere-setup bootstrap --release $Channel --context $Context `
      --admin-username e2e-admin --admin-display-name 'OpenSphere E2E Administrator' `
      --admin-email 'e2e-admin@opensphere.local' --no-open-browser
    if ($LASTEXITCODE -ne 0) { throw "OpenSphere Setup bootstrap failed for $Channel" }
  } finally {
    Pop-Location
  }
}

function Invoke-FreshSetupAndOnboarding {
  Invoke-Setup
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $stdout = Join-Path $EvidenceDirectory ("$Channel-console-port-forward.stdout.log")
  $stderr = Join-Path $EvidenceDirectory ("$Channel-console-port-forward.stderr.log")
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  $kubectl = (Get-Command kubectl -ErrorAction Stop).Source
  $arguments = @(
    '--context', $Context,
    '-n', 'opensphere-console',
    'port-forward', 'svc/opensphere-console-ext', "${port}:https",
    '--address', '127.0.0.1'
  )
  $forward = Start-Process -FilePath $kubectl -ArgumentList $arguments -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  try {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    do {
      Start-Sleep -Milliseconds 200
      if ($forward.HasExited) {
        throw "Console port-forward exited before ready; inspect $stdout and $stderr"
      }
      $ready = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
    } while (-not $ready -and [DateTimeOffset]::UtcNow -lt $deadline)
    if (-not $ready) { throw "Console port-forward did not become ready; inspect $stdout and $stderr" }

    Push-Location $RepoRoot
    try {
      $previousConsole = $env:OPENSPHERE_E2E_CONSOLE
      $env:OPENSPHERE_E2E_CONSOLE = "https://localhost:$port"
      & node .\scripts\e2e-first-admin.mjs
      if ($LASTEXITCODE -ne 0) { throw "OpenSphere Supabase first-administrator E2E failed for $Channel" }
    } finally {
      $env:OPENSPHERE_E2E_CONSOLE = $previousConsole
      Pop-Location
    }
  } finally {
    if (-not $forward.HasExited) { Stop-Process -Id $forward.Id -Force }
  }
}

function Invoke-InterruptedSetup {
  $stdout = Join-Path $EvidenceDirectory ("$Channel-interrupted.stdout.log")
  $stderr = Join-Path $EvidenceDirectory ("$Channel-interrupted.stderr.log")
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  $node = (Get-Command node -ErrorAction Stop).Source
  $arguments = @(
    (Join-Path $RepoRoot 'src/cli.mjs'), 'bootstrap',
    '--release', $Channel, '--context', $Context,
    '--admin-username', 'e2e-admin',
    '--admin-display-name', 'OpenSphere-E2E-Administrator',
    '--admin-email', 'e2e-admin@opensphere.local',
    '--no-open-browser'
  )
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(2)
  try {
    do {
      Start-Sleep -Milliseconds 100
      $lock = & kubectl --context $Context -n opensphere-console get configmap opensphere-installation-lock --ignore-not-found -o name 2>$null
      if ($lock) { break }
      if ($process.HasExited) {
        throw "Setup exited before the interruption point; inspect $stdout and $stderr"
      }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if (-not $lock) { throw 'Installation lock was not recorded before interruption timeout' }
  } finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  }
  Start-Sleep -Seconds 3
  Write-Host '[E2E] Setup process interrupted after durable cluster lock; resuming'
}

for ($iteration = 1; $iteration -le $Iterations; $iteration += 1) {
  Write-Host "[E2E] $Channel iteration $iteration/${Iterations}: reset"
  Reset-TestEnvironment

  $lockPath = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot ".opensphere-setup/$Channel-release-lock.json"))
  if (-not $lockPath.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release lock path escaped repository root: $lockPath"
  }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

  Write-Host "[E2E] $Channel iteration $iteration/${Iterations}: fresh bootstrap"
  if ($InterruptAfterLock) { Invoke-InterruptedSetup }
  Invoke-FreshSetupAndOnboarding
  $before = Get-SecretFingerprint

  Write-Host "[E2E] $Channel iteration $iteration/${Iterations}: resume/idempotency"
  Invoke-Setup
  $after = Get-SecretFingerprint
  if (($before | ConvertTo-Json -Compress) -ne ($after | ConvertTo-Json -Compress)) {
    throw 'Managed secret payload changed during idempotent resume'
  }

  Push-Location $RepoRoot
  try {
    & node .\src\cli.mjs verify --release $Channel --context $Context --require-zero-restarts
    if ($LASTEXITCODE -ne 0) { throw 'Final Setup verification failed' }
  } finally {
    Pop-Location
  }

  $evidence = & kubectl --context $Context -n opensphere-console get configmap opensphere-installation-evidence -o jsonpath='{.data.evidence\.json}' | ConvertFrom-Json
  $result = [ordered]@{
    test = 'OpenSphere clean channel installation'
    channel = $Channel
    iteration = $iteration
    context = $Context
    interruptedAfterLock = [bool]$InterruptAfterLock
    completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    secretPayloadsStableAcrossResume = $true
    evidence = $evidence
  }
  $mode = if ($InterruptAfterLock) { 'interrupted-resume' } else { 'clean-resources' }
  $path = Join-Path $EvidenceDirectory ("{0}-{1}-iteration-{2}.json" -f $Channel, $mode, $iteration)
  [System.IO.File]::WriteAllText($path, (($result | ConvertTo-Json -Depth 12) + [Environment]::NewLine))
  Write-Host "[E2E] PASS -> $path"
}

if ($RemoveAfterLastRun) { Remove-OpenSphere }
