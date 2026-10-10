param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string[]]$DnsNames = @(),
  # A Console reached by address needs an iPAddress SAN; browsers ignore an IP written as a DNS name.
  [string[]]$IpAddresses = @(),
  # 2026-10-10: the CA is named after the installation. Every installation used to issue a CA called
  # "CN=OpenSphere Installation CA"; a workstation that trusted one of them failed every other one with
  # a signature error (Windows selects the trusted CA by name). Empty keeps the legacy name for callers
  # that have no installation identity yet.
  [string]$InstallationId = ''
)

$ErrorActionPreference = 'Stop'
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$caKey = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
if ($InstallationId -and $InstallationId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
  throw "InstallationId must be a lowercase UUID"
}
$caSubject = if ($InstallationId) {
  "CN=OpenSphere Installation CA $($InstallationId.Substring(0, 8)), OU=installation $InstallationId, O=OpenSphere"
} else { 'CN=OpenSphere Installation CA' }
$caRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($caSubject),
  $caKey,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256
)
$caRequest.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
)
$caRequest.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign,
    $true
  )
)
# Key identifiers let a client pick the issuing CA by key, not only by name.
$caRequest.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false)
)
$caCertificate = $caRequest.CreateSelfSigned($notBefore, $notBefore.AddYears(5))

$key = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
# The leaf names the Console host it serves (the first requested name), not "localhost".
$primaryName = @($DnsNames + $IpAddresses | Where-Object { $_ -and $_ -notmatch '[\s/,=+]' } | Select-Object -First 1)
$leafSubject = if ($primaryName.Count -gt 0) { "CN=$($primaryName[0])" } else { 'CN=localhost' }
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($leafSubject),
  $key,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256
)
$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
@(
  'localhost',
  # P3-W1 foundation-identity 스택(plan-003 §13.5.3 SAN 확장): workforce Keycloak·Syncope·SCIM-GW 의
  # in-cluster svc DNS 를 leaf SAN 에 등재한다. CA·sig.key 는 불변 재사용.
  'keycloak.opensphere-foundation.svc',
  'keycloak.opensphere-foundation.svc.cluster.local',
  'syncope.opensphere-foundation.svc',
  'syncope.opensphere-foundation.svc.cluster.local',
  'scim-gw.opensphere-foundation.svc',
  'scim-gw.opensphere-foundation.svc.cluster.local',
  # admission webhook serving cert(opensphere-foundation-identity webhook @ opensphere-system).
  # 회전 시 webhook 서버는 새 SAN/키를 캐시 재로드해야 한다(§12A.2 write-path 하드 의존·§12A.4 AdmissionWebhookCertExpiry).
  'opensphere-foundation-identity-webhook.opensphere-system.svc',
  'opensphere-foundation-identity-webhook.opensphere-system.svc.cluster.local'
) + $DnsNames | Sort-Object -Unique | ForEach-Object {
  if ($_ -and $_ -notmatch '[\s/]') { $san.AddDnsName($_) }
}
$san.AddIpAddress([System.Net.IPAddress]::Loopback)
foreach ($address in $IpAddresses | Sort-Object -Unique) {
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($address, [ref]$parsed)) { throw "Not an IP address: $address" }
  if (-not $parsed.Equals([System.Net.IPAddress]::Loopback)) { $san.AddIpAddress($parsed) }
}
$request.CertificateExtensions.Add($san.Build())
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
    $true
  )
)
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509AuthorityKeyIdentifierExtension]::CreateFromCertificate($caCertificate, $true, $false)
)
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false)
)
$serial = New-Object byte[] 16
[System.Security.Cryptography.RandomNumberGenerator]::Fill($serial)
$leafCertificate = $request.Create($caCertificate, $notBefore, $notBefore.AddYears(2), $serial)
$certificate = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::CopyWithPrivateKey($leafCertificate, $key)
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'ca.crt'), $caCertificate.ExportCertificatePem())
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'tls.crt'), $certificate.ExportCertificatePem())
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'tls.key'), $key.ExportPkcs8PrivateKeyPem())

$signingKey = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'sig.key'), $signingKey.ExportPkcs8PrivateKeyPem())

$certificate.Dispose()
$leafCertificate.Dispose()
$key.Dispose()
$caCertificate.Dispose()
$caKey.Dispose()
$signingKey.Dispose()
