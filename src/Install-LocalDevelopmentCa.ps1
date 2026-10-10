param(
  [Parameter(Mandatory = $true)][string]$CertificatePath,
  # 2026-10-10: the caller names the SHA-256 fingerprint it showed and the operator compared.
  # A different certificate is refused before any change.
  [Parameter(Mandatory = $true)][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $CertificatePath).Path
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolved)
try {
  # The legacy shared name, or the per-installation name "OpenSphere Installation CA <8 hex>" with
  # OU "installation <uuid>" and O "OpenSphere".
  $legacy = $certificate.Subject -eq 'CN=OpenSphere Installation CA'
  $perInstallation = $certificate.Subject -match '^CN=OpenSphere Installation CA ([0-9a-f]{8}), OU=installation (\1[0-9a-f-]{28}), O=OpenSphere$'
  if (-not $legacy -and -not $perInstallation) {
    throw "Refusing to trust an unexpected certificate subject: $($certificate.Subject)"
  }
  if ($certificate.Subject -ne $certificate.Issuer) {
    throw 'Refusing to trust a CA that is not self-signed'
  }
  $basicConstraints = $certificate.Extensions |
    Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] } |
    Select-Object -First 1
  if (-not $basicConstraints -or -not $basicConstraints.CertificateAuthority) {
    throw 'Refusing to trust a certificate that is not a CA'
  }
  # Subject = Issuer only says self-issued. The Windows chain engine checks the self-signature itself
  # (NotSignatureValid); an unknown root is allowed here because this CA is not trusted yet.
  $selfCheck = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
  try {
    $selfCheck.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $selfCheck.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
    [void]$selfCheck.Build($certificate)
    $badSignature = @($selfCheck.ChainStatus | Where-Object {
      $_.Status -band [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::NotSignatureValid })
    if ($selfCheck.ChainElements.Count -ne 1 -or $badSignature.Count -gt 0) {
      throw 'Refusing to trust a CA whose self-signature does not verify'
    }
  }
  finally {
    $selfCheck.Dispose()
  }
  if ($certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow) {
    throw 'Refusing to trust a CA that is not valid yet'
  }
  if ($certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow.AddDays(1)) {
    throw 'Refusing to trust an expired or near-expiry local CA'
  }
  $expected = ($ExpectedSha256 -replace ':', '').ToLowerInvariant()
  $actual = $certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
  if ($expected -notmatch '^[0-9a-f]{64}$' -or $actual -ne $expected) {
    throw 'Refusing to trust a CA whose SHA-256 fingerprint differs from the one reviewed'
  }

  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    $existing = $store.Certificates.Find(
      [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
      $certificate.Thumbprint,
      $false
    )
  }
  finally {
    $store.Dispose()
  }
  if ($existing.Count -eq 0) {
    $certutil = Join-Path $env:SystemRoot 'System32\certutil.exe'
    & $certutil -user -f -addstore Root $resolved | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "certutil failed to add the OpenSphere installation CA to CurrentUser Root (exit=$LASTEXITCODE)"
    }
  }
}
finally {
  $certificate.Dispose()
}
