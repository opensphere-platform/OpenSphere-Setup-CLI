param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string[]]$DnsNames = @()
)

$ErrorActionPreference = 'Stop'
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$caKey = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
$caRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=OpenSphere Installation CA',
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
$caCertificate = $caRequest.CreateSelfSigned($notBefore, $notBefore.AddYears(5))

$key = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=localhost',
  $key,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256
)
$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
@(
  'localhost',
  'kanidm',
  'kanidm-core',
  'kanidm.opensphere-console-auth.svc',
  'kanidm-core.opensphere-console-auth.svc',
  'kanidm.opensphere-console-auth.svc.cluster.local',
  'kanidm-core.opensphere-console-auth.svc.cluster.local',
  'opensphere-console-auth',
  'opensphere-console-auth.opensphere-console.svc',
  'backbone-postgres',
  'backbone-postgres.opensphere-backbone.svc',
  'backbone-postgres.opensphere-backbone.svc.cluster.local',
  'backbone-rustfs',
  'backbone-rustfs.opensphere-backbone.svc',
  'backbone-rustfs.opensphere-backbone.svc.cluster.local'
) + $DnsNames | Sort-Object -Unique | ForEach-Object {
  if ($_ -and $_ -notmatch '[\s/]') { $san.AddDnsName($_) }
}
$san.AddIpAddress([System.Net.IPAddress]::Loopback)
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
