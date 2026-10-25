#requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OsaaGatewayImage,
  [Parameter(Mandatory)][string]$R2d2OpenClawGatewayImage,
  [Parameter(Mandatory)][string]$KnowledgePackageDirectory,
  [Parameter(Mandatory)][string]$OsdstImage,
  [Parameter(Mandatory)][string]$OsShellControlImage,
  [Parameter(Mandatory)][string]$OsShellRuntimeImage,
  [Parameter(Mandatory)][string]$OsCliImage,
  [Parameter(Mandatory)][string]$ConsoleUrl,
  [Parameter(Mandatory)][ValidateSet('edge','candidate','stable','lts')][string]$ReleaseChannel,
  [Parameter(Mandatory)][string]$ReleaseDigest,
  [Parameter(Mandatory)][string]$ExpectedMigrationManifestSha256,
  [Parameter(Mandatory)][string]$ExpectedMigrationSetDigest,
  [Parameter(Mandatory)][string]$ExpectedMigrationLatestGlobalId,
  [string]$KubeContext = 'docker-desktop',
  [string]$RuntimeNamespace = 'opensphere-console',
  [string]$DataNamespace = 'opensphere-console-data',
  [string]$SessionNamespace = 'opensphere-shell-sessions'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'os-shell-tls-contract.ps1')

$script:stage = $null
function Start-Stage([int]$Number, [string]$Name) {
  $script:stage = @{ Number = $Number; Name = $Name; Clock = [Diagnostics.Stopwatch]::StartNew() }
  Write-ProgressLine '시작'
}
function Write-ProgressLine([string]$State, [string]$Detail = '') {
  if (-not $script:stage) { return }
  $elapsed = $script:stage.Clock.Elapsed.TotalSeconds.ToString('F1', [Globalization.CultureInfo]::InvariantCulture)
  $suffix = if ($Detail) { " | $Detail" } else { '' }
  [Console]::Error.WriteLine(('[{0} {1:00}/08] {2}{3} ({4}s)' -f $State, $script:stage.Number, $script:stage.Name, $suffix, $elapsed))
}
function Complete-Stage([string]$Detail = '') { Write-ProgressLine '완료' $Detail; $script:stage = $null }

function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  $all = @('--context', $KubeContext) + $Arguments
  if ($InputText) { $output = $InputText | & kubectl @all } else { $output = & kubectl @all }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
  return @($output)
}
function Get-Sha256Text([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Value))).Replace('-', '').ToLowerInvariant()) }
  finally { $sha.Dispose() }
}
function Get-CanonicalFileSha256([string]$Path) {
  return Get-Sha256Text ([IO.File]::ReadAllText($Path).Replace("`r`n", "`n"))
}
function New-RandomSafeString([int]$Length) {
  $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  $bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes($Length)
  return -join @($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}
function New-RandomBase64([int]$Length) {
  return [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes($Length))
}
function Get-JsonField($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}
# M2-M3 contract §4: the OS Shell API reads the Kubernetes API only to admit the Foundation system actor.
# Its egress names the exact default/kubernetes Service and ready HTTPS endpoint addresses, as Setup renders
# for C_API (registry-runtime-access.mjs). A missing endpoint is never widened to every address.
function Get-KubernetesApiEgressRules {
  $fail = 'OS Shell Kubernetes egress requires the default/kubernetes Service and ready HTTPS EndpointSlices'
  $service = ((Invoke-Kubectl @('-n','default','get','service','kubernetes','-o','json')) | Out-String) | ConvertFrom-Json
  $slices = ((Invoke-Kubectl @('-n','default','get','endpointslices.discovery.k8s.io','-l','kubernetes.io/service-name=kubernetes','-o','json')) | Out-String) | ConvertFrom-Json
  if ([string](Get-JsonField $service.metadata 'name') -cne 'kubernetes' -or [string](Get-JsonField $service.metadata 'namespace') -cne 'default') { throw $fail }
  $rules = [Collections.Generic.SortedDictionary[string,string]]::new([StringComparer]::Ordinal)
  function Add-Rule([string]$Address, $PortValue) {
    $ip = $null; $port = 0
    if (-not [Net.IPAddress]::TryParse($Address, [ref]$ip) -or $ip.ToString() -cne $Address -or
        -not [int]::TryParse([string]$PortValue, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw $fail }
    $bytes = $ip.GetAddressBytes()
    $ipv4 = $ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork
    # Unspecified, loopback, link-local and multicast addresses cannot be a remote API target.
    if (($ipv4 -and ($bytes[0] -eq 0 -or $bytes[0] -eq 127 -or ($bytes[0] -eq 169 -and $bytes[1] -eq 254) -or $bytes[0] -ge 224)) -or
        (-not $ipv4 -and ($ip.Equals([Net.IPAddress]::IPv6Any) -or $ip.Equals([Net.IPAddress]::IPv6Loopback) -or $ip.IsIPv6LinkLocal -or $ip.IsIPv6Multicast))) { throw $fail }
    $cidr = if ($ipv4) { "$Address/32" } else { "$Address/128" }
    $rules["${cidr}:$port"] = '{"to":[{"ipBlock":{"cidr":"' + $cidr + '"}}],"ports":[{"protocol":"TCP","port":' + $port + '}]}'
  }
  $servicePorts = @(@(Get-JsonField $service.spec 'ports') | Where-Object { $_ -and [string](Get-JsonField $_ 'name') -ceq 'https' -and [string](Get-JsonField $_ 'protocol') -in @('', 'TCP') })
  if ($servicePorts.Count -ne 1) { throw $fail }
  $serviceIps = @(@(Get-JsonField $service.spec 'clusterIPs') | Where-Object { $_ })
  if (-not $serviceIps.Count) { $serviceIps = @(@(Get-JsonField $service.spec 'clusterIP') | Where-Object { $_ }) }
  if (-not $serviceIps.Count) { throw $fail }
  foreach ($address in $serviceIps) { Add-Rule ([string]$address) (Get-JsonField $servicePorts[0] 'port') }
  $ready = 0
  foreach ($slice in @(Get-JsonField $slices 'items')) {
    if (-not $slice) { continue }
    $addressType = [string](Get-JsonField $slice 'addressType')
    if ([string](Get-JsonField $slice.metadata 'namespace') -cne 'default' -or
        [string](Get-JsonField (Get-JsonField $slice.metadata 'labels') 'kubernetes.io/service-name') -cne 'kubernetes' -or
        $addressType -cnotin @('IPv4', 'IPv6')) { throw $fail }
    $ports = @(@(Get-JsonField $slice 'ports') | Where-Object { $_ -and [string](Get-JsonField $_ 'name') -ceq 'https' -and [string](Get-JsonField $_ 'protocol') -in @('', 'TCP') })
    if ($ports.Count -ne 1) { throw $fail }
    foreach ($endpoint in @(Get-JsonField $slice 'endpoints')) {
      if (-not $endpoint) { continue }
      $conditions = Get-JsonField $endpoint 'conditions'
      if ((Get-JsonField $conditions 'ready') -eq $false -or (Get-JsonField $conditions 'terminating') -eq $true) { continue }
      $addresses = @(@(Get-JsonField $endpoint 'addresses') | Where-Object { $_ })
      if (-not $addresses.Count) { throw $fail }
      foreach ($address in $addresses) {
        if (([string]$address).Contains(':') -ne ($addressType -ceq 'IPv6')) { throw $fail }
        Add-Rule ([string]$address) (Get-JsonField $ports[0] 'port'); $ready++
      }
    }
  }
  if (-not $ready -or $rules.Count -gt 128) { throw $fail }
  return @($rules.Values)
}

trap {
  if ($script:stage) { Write-ProgressLine '실패' $_.Exception.Message }
  throw
}

Start-Stage 1 '릴리스·마이그레이션 입력 검증'
$images = [ordered]@{
  osaaGateway = $OsaaGatewayImage
  r2d2OpenClawGateway = $R2d2OpenClawGatewayImage
  osdst = $OsdstImage
  osShellControl = $OsShellControlImage
  osShellRuntime = $OsShellRuntimeImage
  cliArtifacts = $OsCliImage
}
$imagePatterns = [ordered]@{
  osaaGateway = '^ghcr[.]io/opensphere-platform/opensphere-console-osaa-gateway@sha256:[a-f0-9]{64}$'
  r2d2OpenClawGateway = '^ghcr[.]io/opensphere-platform/opensphere-console-r2d2-openclaw@sha256:[a-f0-9]{64}$'
  osdst = '^ghcr[.]io/opensphere-platform/opensphere-osdst@sha256:[a-f0-9]{64}$'
  osShellControl = '^ghcr[.]io/opensphere-platform/opensphere-console-os-shell-control@sha256:[a-f0-9]{64}$'
  osShellRuntime = '^ghcr[.]io/opensphere-platform/opensphere-os-shell-runtime@sha256:[a-f0-9]{64}$'
  cliArtifacts = '^ghcr[.]io/opensphere-platform/opensphere-os-cli@sha256:[a-f0-9]{64}$'
}
foreach ($entry in $images.GetEnumerator()) {
  if ($entry.Value -cnotmatch $imagePatterns[$entry.Key]) { throw "Invalid exact-digest image for $($entry.Key)" }
}
if ($ConsoleUrl -cnotmatch '^https://[^/?#]+(?::[0-9]+)?$') { throw 'ConsoleUrl must be an HTTPS origin' }
foreach ($digest in @($ReleaseDigest, $ExpectedMigrationManifestSha256, $ExpectedMigrationSetDigest)) {
  if ($digest -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'Release and migration digests must be exact SHA-256 values' }
}
if ($ExpectedMigrationLatestGlobalId -cnotmatch '^opensphere-console/[0-9]{8}/[0-9]{4}$') { throw 'Invalid latest migration global ID' }
$migrationManifestPath = Join-Path $repositoryRoot 'migrations\manifest.json'
$migrationManifest = Get-Content -Raw -LiteralPath $migrationManifestPath | ConvertFrom-Json
if ((Get-CanonicalFileSha256 $migrationManifestPath) -cne $ExpectedMigrationManifestSha256 -or
    [string]$migrationManifest.setDigest -cne $ExpectedMigrationSetDigest -or
    [string]$migrationManifest.latestGlobalId -cne $ExpectedMigrationLatestGlobalId) {
  throw 'Materialized migration authority differs from the verified release'
}
if (@($migrationManifest.migrations | Where-Object { $_.semanticKey -ceq 'console.r2d2.native_request_journal' }).Count -ne 1) {
  throw 'Native request journal is not registered exactly once in the verified release; no native activation is permitted'
}
if (@($migrationManifest.migrations | Where-Object { $_.semanticKey -ceq 'console.r2d2.native_action_intent' }).Count -ne 1) {
  throw 'Native action intent is not registered exactly once in the verified release; no native activation is permitted'
}
if (@($migrationManifest.migrations | Where-Object { $_.semanticKey -ceq 'console.r2d2.native_session_dispatch_fence' }).Count -ne 1) {
  throw 'Native session dispatch fence is not registered exactly once in the verified release; no native activation is permitted'
}
# Read-only preflight before credentials, SQL or workload writes. Setup owns the
# explicitly reviewed policy and quota; this installer invents no defaults.
$runtimePolicy = ((Invoke-Kubectl @('-n',$RuntimeNamespace,'get','configmap','opensphere-r2d2-runtime-policy','-o','json')) | Out-String) | ConvertFrom-Json
$installationIdentity = ((Invoke-Kubectl @('-n',$RuntimeNamespace,'get','configmap','opensphere-installation-identity','-o','json')) | Out-String) | ConvertFrom-Json
$clusterUid = ((Invoke-Kubectl @('get','namespace','kube-system','-o','jsonpath={.metadata.uid}')) | Out-String).Trim()
if ($runtimePolicy.metadata.labels.'app.kubernetes.io/managed-by' -cne 'opensphere-setup' -or
    $installationIdentity.immutable -ne $true -or
    $installationIdentity.data.clusterUid -cne $clusterUid -or
    $runtimePolicy.data.installationId -cne $installationIdentity.data.installationId) {
  throw 'Native runtime policy does not match the persistent installation and cluster identity'
}
$policyInput = [string]$runtimePolicy.data.'policy.json'
$policy = $policyInput | ConvertFrom-Json
if ($policy.installationId -cne $installationIdentity.data.installationId -or
    $policy.image -cne $R2d2OpenClawGatewayImage -or $policy.bridgeImage -cne $OsaaGatewayImage) {
  throw 'Native runtime policy does not bind the exact native Gateway and C_AI release images'
}
$policyInput | & node -e "const fs=require('node:fs');let t='';process.stdin.on('data',b=>t+=b);process.stdin.on('end',()=>require(process.argv[1]).validatePersonalRuntimePolicy(JSON.parse(t)));" (Join-Path $repositoryRoot 'apps/osaa-gateway/openclaw-runtime-resources.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Reviewed native runtime resource or storage policy is invalid' }
$latestMigration = @($migrationManifest.migrations)[-1]
$latestSourceRevision = [string]$latestMigration.sourceRevision
if ($latestSourceRevision -cnotmatch '^[a-f0-9]{40}$') { throw 'Latest migration source revision is invalid' }
$manifestPath = Join-Path $repositoryRoot 'apps\os-shell-control\deploy.yaml'
$osaaPath = Join-Path $repositoryRoot 'apps\osaa-gateway\deploy.yaml'
$osdstPath = Join-Path $repositoryRoot 'apps\osdst\deploy.yaml'
$runtimeTemplatePath = Join-Path $repositoryRoot 'apps\os-shell-control\runtime-template.js'
foreach ($path in @($manifestPath, $osaaPath, $osdstPath, $runtimeTemplatePath)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing native runtime artifact: $path" }
}
$componentSetDigest = Get-Sha256Text (($images.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n")
Complete-Stage "release=$ReleaseDigest"

$knowledgeText = & node (Join-Path $PSScriptRoot 'render-knowledge-package.mjs') $KnowledgePackageDirectory
if ($LASTEXITCODE -ne 0) { throw 'Verified Knowledge package preparation failed; no runtime changes were made' }
$knowledgeProjection = ($knowledgeText | Out-String) | ConvertFrom-Json
if (-not $knowledgeProjection.configMaps -or -not $knowledgeProjection.sources) { throw 'Knowledge projection is empty' }

Start-Stage 2 '대상 PostgreSQL·마이그레이션 상태 확인'
$postgres = ((Invoke-Kubectl @('-n',$DataNamespace,'get','pod','-l','app=opensphere-supabase-postgres','-o','json')) | Out-String) | ConvertFrom-Json
$readyPods = @($postgres.items | Where-Object {
  $_.status.phase -eq 'Running' -and @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1
})
if ($readyPods.Count -ne 1) { throw 'Exactly one Ready target Supabase PostgreSQL Pod is required' }
$postgresPod = [string]$readyPods[0].metadata.name
function Invoke-OwnerSql([string]$Sql) {
  $command = 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -h 127.0.0.1 -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1'
  $rows = @((Invoke-Kubectl @('-n',$DataNamespace,'exec','-i',$postgresPod,'--','sh','-ec',$command) $Sql) | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  Write-Output -NoEnumerate $rows
}
$ledger = Invoke-OwnerSql "SELECT global_id||'|'||migration_set_digest||'|'||source_revision FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1;"
if ($ledger.Count -ne 1 -or $ledger[0] -cne "$ExpectedMigrationLatestGlobalId|$ExpectedMigrationSetDigest|$latestSourceRevision") {
  throw 'Target database is not at the exact verified migration head'
}
Complete-Stage $ledger[0].Split('|')[0]

Start-Stage 3 '네이티브 서비스 최소권한 DB 계정'
$dbProfiles = @(
  [ordered]@{ Login='opensphere_osaa_gateway_runtime'; Authority='opensphere_osaa_gateway'; Secret='opensphere-osaa-gateway-db'; Shell=$false },
  [ordered]@{ Login='opensphere_osdst_runtime'; Authority='opensphere_osdst'; Secret='opensphere-osdst-db'; Shell=$false },
  [ordered]@{ Login='opensphere_osdst_maintenance_runtime'; Authority='opensphere_osdst_maintenance'; Secret='opensphere-osdst-maintenance-db'; Shell=$false },
  [ordered]@{ Login='opensphere_shell_api_runtime'; Authority='opensphere_shell_api'; Secret='opensphere-shell-api-db'; Shell=$true },
  [ordered]@{ Login='opensphere_shell_gateway_runtime'; Authority='opensphere_shell_gateway'; Secret='opensphere-shell-gateway-db'; Shell=$true },
  [ordered]@{ Login='opensphere_shell_reconciler_runtime'; Authority='opensphere_shell_reconciler'; Secret='opensphere-shell-reconciler-db'; Shell=$true }
)
foreach ($profile in $dbProfiles) {
  $roleState = Invoke-OwnerSql "SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='$($profile.Login)') THEN 'present' ELSE 'absent' END;"
  $secretRaw = ((Invoke-Kubectl @('-n',$RuntimeNamespace,'get','secret',$profile.Secret,'--ignore-not-found','-o','json')) | Out-String).Trim()
  $secretPresent = [bool]$secretRaw
  if (($roleState[0] -eq 'present') -ne $secretPresent) { throw "Split runtime identity state: $($profile.Secret)" }
  if ($secretPresent) {
    $secret = $secretRaw | ConvertFrom-Json
    $user = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$secret.data.username))
    $password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$secret.data.password))
    if ($user -cne $profile.Login -or -not $password) { throw "Invalid runtime Secret identity: $($profile.Secret)" }
    $contract = Invoke-OwnerSql "SELECT rolcanlogin::text||'|'||rolinherit::text||'|'||rolsuper::text||'|'||rolcreatedb::text||'|'||rolcreaterole::text||'|'||rolreplication::text||'|'||rolbypassrls::text||'|'||pg_has_role('$($profile.Login)','$($profile.Authority)','member')::text FROM pg_roles WHERE rolname='$($profile.Login)';"
    if ($contract.Count -ne 1 -or $contract[0] -cne 'true|false|false|false|false|false|false|true') { throw "Runtime role contract drift: $($profile.Login)" }
  } else {
    $password = New-RandomSafeString 48
    $escaped = $password.Replace("'", "''")
    Invoke-OwnerSql @"
DO `$`$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='$($profile.Authority)' AND NOT rolcanlogin) THEN
    RAISE EXCEPTION 'Missing authority role $($profile.Authority)';
  END IF;
  CREATE ROLE $($profile.Login) LOGIN PASSWORD '$escaped'
    NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  GRANT $($profile.Authority) TO $($profile.Login);
END `$`$;
"@ | Out-Null
    $stringData = [ordered]@{
      host = "opensphere-supabase-postgres.$DataNamespace.svc.cluster.local"
      port = '5432'; database = 'postgres'; username = $profile.Login; password = $password
    }
    if ($profile.Shell) { $stringData.provider='postgres'; $stringData.sslmode='prefer' }
    $secretManifest = [ordered]@{
      apiVersion='v1'; kind='Secret'; metadata=[ordered]@{name=$profile.Secret;namespace=$RuntimeNamespace;labels=[ordered]@{
        'app.kubernetes.io/managed-by'='opensphere-setup-cli';'opensphere.io/secret-scope'="$($profile.Authority)-only"
      }}; type='Opaque'; stringData=$stringData
    } | ConvertTo-Json -Depth 8
    try { Invoke-Kubectl @('create','-f','-') $secretManifest | Out-Null }
    catch { Invoke-OwnerSql "DROP ROLE IF EXISTS $($profile.Login);" | Out-Null; throw }
  }
  $password = $null
}
Complete-Stage '6개 역할/Secret 검증'

Start-Stage 4 'OS Shell 위임 Secret·내부 TLS'
$controlSecretRaw = ((Invoke-Kubectl @('-n',$RuntimeNamespace,'get','secret','opensphere-shell-control-runtime','--ignore-not-found','-o','json')) | Out-String).Trim()
if ($controlSecretRaw) {
  $controlSecret = $controlSecretRaw | ConvertFrom-Json
  $keys = @($controlSecret.data.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ',') -cne 'admission-secret,delegation-secret,delegation-signing-key') { throw 'OS Shell control Secret key set is invalid' }
  $signingKey = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$controlSecret.data.'delegation-signing-key'))
  if ([Convert]::FromBase64String($signingKey).Length -ne 32) { throw 'OS Shell delegation signing key must decode to 32 bytes' }
} else {
  $controlManifest = [ordered]@{
    apiVersion='v1';kind='Secret';metadata=[ordered]@{name='opensphere-shell-control-runtime';namespace=$RuntimeNamespace;labels=[ordered]@{
      'app.kubernetes.io/managed-by'='opensphere-setup-cli';'opensphere.io/secret-scope'='shell-control-only'
    }};type='Opaque';stringData=[ordered]@{
      'admission-secret'=(New-RandomSafeString 48)
      'delegation-secret'=(New-RandomSafeString 48)
      'delegation-signing-key'=(New-RandomBase64 32)
    }
  } | ConvertTo-Json -Depth 8
  Invoke-Kubectl @('create','-f','-') $controlManifest | Out-Null
}

$sessionNamespaceManifest = [ordered]@{apiVersion='v1';kind='Namespace';metadata=[ordered]@{name=$SessionNamespace;labels=[ordered]@{
  'opensphere.io/scope'='ephemeral-shell-runtime';'pod-security.kubernetes.io/enforce'='restricted';
  'pod-security.kubernetes.io/audit'='restricted';'pod-security.kubernetes.io/warn'='restricted'
}}} | ConvertTo-Json -Depth 6
Invoke-Kubectl @('apply','-f','-') $sessionNamespaceManifest | Out-Null

$controlCaConfigMap = 'opensphere-shell-control-ca'
$privateTlsProfiles = @(
  [ordered]@{Secret='opensphere-shell-api-tls';Service='opensphere-shell-api'},
  [ordered]@{Secret='opensphere-shell-reconciler-tls';Service='opensphere-shell-reconciler'},
  [ordered]@{Secret='opensphere-shell-credential-authority-tls';Service='opensphere-shell-credential-authority'},
  [ordered]@{Secret='opensphere-shell-console-api-tls';Service='opensphere-shell-console-api'}
)
function Assert-CertificateLifetime($Certificate, [string]$Name) {
  $now=[DateTime]::UtcNow
  if($Certificate.NotBefore.ToUniversalTime() -gt $now -or $Certificate.NotAfter.ToUniversalTime() -lt $now.AddHours(24)){throw "$Name has less than 24 hours validity"}
}
function Assert-ExistingTls([string]$CaPem) {
  $ca=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($CaPem)
  try {
    Assert-CertificateLifetime $ca 'OS Shell CA'
    foreach($profile in $privateTlsProfiles){
      $secret=((Invoke-Kubectl @('-n',$RuntimeNamespace,'get','secret',$profile.Secret,'-o','json'))|Out-String)|ConvertFrom-Json
      $certPem=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$secret.data.'tls.crt'))
      $keyPem=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$secret.data.'tls.key'))
      $cert=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($certPem,$keyPem)
      try {
        Assert-CertificateLifetime $cert $profile.Secret
        Assert-ExactCertificateDnsNames -Certificate $cert -ExpectedDnsNames @($profile.Service,"$($profile.Service).$RuntimeNamespace.svc","$($profile.Service).$RuntimeNamespace.svc.cluster.local") -Name $profile.Secret
        $chain=[Security.Cryptography.X509Certificates.X509Chain]::new()
        try{$chain.ChainPolicy.RevocationMode='NoCheck';$chain.ChainPolicy.TrustMode='CustomRootTrust';[void]$chain.ChainPolicy.CustomTrustStore.Add($ca);if(-not $chain.Build($cert)){throw "TLS leaf does not chain to CA: $($profile.Secret)"}}
        finally{$chain.Dispose()}
      } finally {$cert.Dispose()}
    }
  } finally {$ca.Dispose()}
}
$presence=@()
foreach($profile in $privateTlsProfiles){$presence += [bool](((Invoke-Kubectl @('-n',$RuntimeNamespace,'get','secret',$profile.Secret,'--ignore-not-found','-o','name')))-join '')}
foreach($namespace in @($RuntimeNamespace,$SessionNamespace)){$presence += [bool](((Invoke-Kubectl @('-n',$namespace,'get','configmap',$controlCaConfigMap,'--ignore-not-found','-o','name')))-join '')}
$presentCount=@($presence|Where-Object{$_}).Count
if($presentCount -notin @(0,6)){throw 'OS Shell TLS trust set is partial'}
if($presentCount -eq 6){
  $controlCa=(Invoke-Kubectl @('-n',$RuntimeNamespace,'get','configmap',$controlCaConfigMap,'-o','jsonpath={.data.ca\.crt}'))-join ''
  $sessionCa=(Invoke-Kubectl @('-n',$SessionNamespace,'get','configmap',$controlCaConfigMap,'-o','jsonpath={.data.ca\.crt}'))-join ''
  if($sessionCa -cne $controlCa){throw 'OS Shell CA projections differ'}
  Assert-ExistingTls $controlCa
} else {
  $notBefore=[DateTimeOffset]::UtcNow.AddMinutes(-5);$notAfter=[DateTimeOffset]::UtcNow.AddDays(397)
  $caKey=[Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
  $caRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=OpenSphere OS Shell Setup CA',$caKey,[Security.Cryptography.HashAlgorithmName]::SHA256)
  $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$true,0,$true))
  $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign),$true))
  $ca=$caRequest.CreateSelfSigned($notBefore,$notAfter)
  try{
    $caPem=$ca.ExportCertificatePem()
    foreach($profile in $privateTlsProfiles){
      $serviceDns="$($profile.Service).$RuntimeNamespace.svc.cluster.local"
      $leafKey=[Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
      try{
        $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$serviceDns",$leafKey,[Security.Cryptography.HashAlgorithmName]::SHA256)
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,$true))
        $oids=[Security.Cryptography.OidCollection]::new();[void]$oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$true))
        $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new();$san.AddDnsName($profile.Service);$san.AddDnsName("$($profile.Service).$RuntimeNamespace.svc");$san.AddDnsName($serviceDns);$request.CertificateExtensions.Add($san.Build($true))
        $leaf=$request.Create($ca,$notBefore,$notAfter,[Security.Cryptography.RandomNumberGenerator]::GetBytes(16))
        try{
          $tls=[ordered]@{apiVersion='v1';kind='Secret';metadata=[ordered]@{name=$profile.Secret;namespace=$RuntimeNamespace;labels=[ordered]@{'app.kubernetes.io/managed-by'='opensphere-setup-cli'}};type='kubernetes.io/tls';stringData=[ordered]@{'tls.crt'=$leaf.ExportCertificatePem();'tls.key'=$leafKey.ExportPkcs8PrivateKeyPem()}}|ConvertTo-Json -Depth 7
          Invoke-Kubectl @('create','-f','-') $tls|Out-Null
        }finally{$leaf.Dispose()}
      }finally{$leafKey.Dispose()}
    }
    foreach($namespace in @($RuntimeNamespace,$SessionNamespace)){
      $cm=[ordered]@{apiVersion='v1';kind='ConfigMap';metadata=[ordered]@{name=$controlCaConfigMap;namespace=$namespace;labels=[ordered]@{'app.kubernetes.io/managed-by'='opensphere-setup-cli'}};data=[ordered]@{'ca.crt'=$caPem}}|ConvertTo-Json -Depth 6
      Invoke-Kubectl @('create','-f','-') $cm|Out-Null
    }
  }finally{$ca.Dispose();$caKey.Dispose()}
}
# M2-M3 contract §4: the Foundation controller verifies the OS Shell API internal listener with this CA. Only the
# public CA certificate is projected, re-applied from the verified opensphere-console copy on every run.
$foundationNamespace='opensphere-foundation'
if(-not (((Invoke-Kubectl @('get','namespace',$foundationNamespace,'--ignore-not-found','-o','name')))-join '')){throw "Namespace $foundationNamespace must exist before the OS Shell CA projection"}
$controlCaSource=((Invoke-Kubectl @('-n',$RuntimeNamespace,'get','configmap',$controlCaConfigMap,'-o','json'))|Out-String)|ConvertFrom-Json
$controlCaPem=[string](Get-JsonField $controlCaSource.data 'ca.crt')
if($controlCaPem -cnotmatch '^-----BEGIN CERTIFICATE-----'){throw 'OS Shell CA projection source is invalid'}
$foundationCa=[ordered]@{apiVersion='v1';kind='ConfigMap';metadata=[ordered]@{name=$controlCaConfigMap;namespace=$foundationNamespace;labels=[ordered]@{'app.kubernetes.io/managed-by'='opensphere-setup-cli'}};data=[ordered]@{'ca.crt'=$controlCaPem}}|ConvertTo-Json -Depth 6
Invoke-Kubectl @('apply','-f','-') $foundationCa|Out-Null
$projected=((Invoke-Kubectl @('-n',$foundationNamespace,'get','configmap',$controlCaConfigMap,'-o','json'))|Out-String)|ConvertFrom-Json
if([string](Get-JsonField $projected.data 'ca.crt') -cne $controlCaPem){throw 'OS Shell CA projection into opensphere-foundation differs'}
Complete-Stage '위임키 3개, TLS leaf 4개, CA 3개'

Start-Stage 5 '세션 GHCR pull 자격 증명 투영'
$source=((Invoke-Kubectl @('-n',$RuntimeNamespace,'get','secret','opensphere-ghcr-pull','-o','json'))|Out-String)|ConvertFrom-Json
$dockerConfig=[string]$source.data.'.dockerconfigjson'
if([string]$source.type -cne 'kubernetes.io/dockerconfigjson' -or -not $dockerConfig){throw 'Console GHCR pull Secret is invalid'}
$pull=[ordered]@{apiVersion='v1';kind='Secret';metadata=[ordered]@{name='opensphere-ghcr-pull';namespace=$SessionNamespace;labels=[ordered]@{'app.kubernetes.io/managed-by'='opensphere-setup-cli'}};type='kubernetes.io/dockerconfigjson';data=[ordered]@{'.dockerconfigjson'=$dockerConfig}}|ConvertTo-Json -Depth 6
Invoke-Kubectl @('apply','-f','-') $pull|Out-Null
Complete-Stage 'opensphere-shell-sessions'

Start-Stage 6 'OSDST·R2D2·OS Shell 선언 적용'
$authEnvironment=if($ReleaseChannel -eq 'edge'){'development'}else{'production'}
$osaa=[IO.File]::ReadAllText($osaaPath).Replace('__OPENSPHERE_OSAA_GATEWAY_IMAGE__',$OsaaGatewayImage).Replace('__OPENSPHERE_R2D2_OPENCLAW_GATEWAY_IMAGE__',$R2d2OpenClawGatewayImage).Replace('__OPENSPHERE_RELEASE_CHANNEL__',$ReleaseChannel).Replace('__OPENSPHERE_AUTH_ENVIRONMENT__',$authEnvironment).Replace('__OPENSPHERE_CONSOLE_URL__',$ConsoleUrl)
$knowledgeSources = ConvertTo-Json -InputObject @($knowledgeProjection.sources) -Depth 15 -Compress
$osaa = $osaa.Replace('__OPENSPHERE_KNOWLEDGE_SOURCES__', $knowledgeSources)
foreach ($configMap in $knowledgeProjection.configMaps) {
  Invoke-Kubectl @('apply','-f','-') ($configMap | ConvertTo-Json -Depth 15 -Compress) | Out-Null
}
$osdst=[IO.File]::ReadAllText($osdstPath).Replace('__OPENSPHERE_OSDST_IMAGE__',$OsdstImage)
$manifestSha=Get-CanonicalFileSha256 $manifestPath
$templateSha=Get-CanonicalFileSha256 $runtimeTemplatePath
$artifactDigest='sha256:'+($OsCliImage -split '@sha256:',2)[1]
$evidenceRef="release://$ReleaseChannel/$($ReleaseDigest.Substring(7))/native-console-runtime"
$shell=[IO.File]::ReadAllText($manifestPath).Replace('__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__',$OsShellControlImage).Replace('__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__',$OsShellRuntimeImage).Replace('__OPENSPHERE_CONSOLE_URL__',$ConsoleUrl).Replace('__OPENSPHERE_OS_SHELL_OS_ARTIFACT_DIGEST__',$artifactDigest).Replace('__OPENSPHERE_OS_SHELL_MANIFEST_SHA256__',$manifestSha).Replace('__OPENSPHERE_OS_SHELL_RELEASE_EVIDENCE_REF__',$evidenceRef).Replace('__OPENSPHERE_OS_SHELL_RUNTIME_TEMPLATE_SHA256__',$templateSha)
$egressSlots=[regex]::Matches($shell,'(?m)^([ \t]*)- __OPENSPHERE_REGISTRY_KUBERNETES_EGRESS__[ \t]*\r?$')
if($egressSlots.Count -ne 1){throw 'OS Shell manifest must expose exactly one Kubernetes API egress slot'}
$egressIndent=$egressSlots[0].Groups[1].Value
$shell=$shell.Remove($egressSlots[0].Index,$egressSlots[0].Length).Insert($egressSlots[0].Index,((Get-KubernetesApiEgressRules|ForEach-Object{"$egressIndent- $_"}) -join "`n"))
foreach($rendered in @($osaa,$osdst,$shell)){if($rendered -match '__OPENSPHERE_[A-Z0-9_]+__'){throw "Unresolved native runtime placeholder: $($Matches[0])"};Invoke-Kubectl @('apply','-f','-') $rendered|Out-Null}
Invoke-Kubectl @('-n',$RuntimeNamespace,'rollout','restart','deployment/opensphere-console-api')|Out-Null
Complete-Stage '대상 선언 적용 및 C_API gate reload'

Start-Stage 7 '네이티브 런타임 rollout 검증'
$rollouts=@(
  'deployment/opensphere-console-api','deployment/opensphere-osdst','deployment/opensphere-console-osaa-gateway',
  'deployment/opensphere-shell-api','deployment/opensphere-shell-gateway','deployment/opensphere-shell-reconciler'
)
foreach($workload in $rollouts){Write-ProgressLine '대기' $workload;Invoke-Kubectl @('-n',$RuntimeNamespace,'rollout','status',$workload,'--timeout=10m')|Out-Null}
Complete-Stage '6개 workload Ready'

Start-Stage 8 'OS Shell 설치 증거 기록·기능 활성화'
& (Join-Path $PSScriptRoot 'Test-OsShellRuntimeAdmission.ps1') -RuntimeImage $OsShellRuntimeImage -KubeContext $KubeContext
if (-not $?) { throw 'OS Shell runtime admission conformance failed; feature activation was not attempted' }
$workloadSet=@('opensphere-console-api','opensphere-console-osaa-gateway','opensphere-osdst','opensphere-shell-api','opensphere-shell-gateway','opensphere-shell-reconciler')
$evidence=[ordered]@{authority='opensphere-setup-cli';channel=$ReleaseChannel;componentSetDigest=$componentSetDigest;latestGlobalId=$ExpectedMigrationLatestGlobalId;migrationSetDigest=$ExpectedMigrationSetDigest;releaseDigest=$ReleaseDigest;sourceRevision=$latestSourceRevision;workloadSet=$workloadSet}
$evidenceJson=($evidence|ConvertTo-Json -Depth 5 -Compress).Replace("'","''")
$state=Invoke-OwnerSql 'SELECT enabled::text||''|''||revision::text FROM console_shell.shell_control_state WHERE singleton=true;'
if($state.Count -ne 1){throw 'OS Shell feature state is unavailable'}
$parts=$state[0].Split('|');$revision=[long]$parts[1]
if($parts[0] -ne 'true'){
  Invoke-OwnerSql "SELECT enabled::text||'|'||revision::text FROM console_shell.activate_native_runtime_from_setup($revision,'$evidenceJson'::jsonb);"|Out-Null
}
$final=Invoke-OwnerSql "SELECT enabled::text||'|'||revision::text||'|'||COALESCE(operation_phase,'') FROM console_shell.shell_control_state WHERE singleton=true;"
if($final.Count -ne 1 -or -not $final[0].StartsWith('true|')){throw 'OS Shell feature activation did not converge'}
Complete-Stage $final[0]

[ordered]@{schemaVersion='1.0';status='ready';releaseDigest=$ReleaseDigest;componentSetDigest=$componentSetDigest;workloads=$workloadSet;osShellState=$final[0]}|ConvertTo-Json -Depth 5
