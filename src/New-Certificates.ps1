param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

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
  'opensphere-console-auth.opensphere-console.svc'
) | ForEach-Object { $san.AddDnsName($_) }
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
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$certificate = $request.CreateSelfSigned($notBefore, $notBefore.AddYears(2))
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'tls.crt'), $certificate.ExportCertificatePem())
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'tls.key'), $key.ExportPkcs8PrivateKeyPem())

$signingKey = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'sig.key'), $signingKey.ExportPkcs8PrivateKeyPem())

$certificate.Dispose()
$key.Dispose()
$signingKey.Dispose()
