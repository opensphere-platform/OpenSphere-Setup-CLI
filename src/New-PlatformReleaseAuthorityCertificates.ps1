#requires -Version 7.2
param([Parameter(Mandatory)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = $notBefore.AddYears(2)
$caKey = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
$caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=OpenSphere Platform Release Internal CA', $caKey,
  [Security.Cryptography.HashAlgorithmName]::SHA256)
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
      [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign,$true))
$ca = $caRequest.CreateSelfSigned($notBefore,$notBefore.AddYears(5))

$leafKey = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
$leafRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=opensphere-platform-release-authority.opensphere-console.svc.cluster.local', $leafKey,
  [Security.Cryptography.HashAlgorithmName]::SHA256)
$san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('opensphere-platform-release-authority.opensphere-console.svc')
$san.AddDnsName('opensphere-platform-release-authority.opensphere-console.svc.cluster.local')
$leafRequest.CertificateExtensions.Add($san.Build())
$leafRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
$leafRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,$true))
$serverAuth = [Security.Cryptography.OidCollection]::new()
$serverAuth.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
$leafRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($serverAuth,$true))
$serial = [byte[]]::new(16)
[Security.Cryptography.RandomNumberGenerator]::Fill($serial)
$leaf = $leafRequest.Create($ca,$notBefore,$notAfter,$serial)
$certificate = [Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::CopyWithPrivateKey($leaf,$leafKey)

[IO.File]::WriteAllText((Join-Path $OutputDirectory 'ca.crt'),$ca.ExportCertificatePem())
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'tls.crt'),$certificate.ExportCertificatePem())
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'tls.key'),$leafKey.ExportPkcs8PrivateKeyPem())

$certificate.Dispose(); $leaf.Dispose(); $leafKey.Dispose(); $ca.Dispose(); $caKey.Dispose()
