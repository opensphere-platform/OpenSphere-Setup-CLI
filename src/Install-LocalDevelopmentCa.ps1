param(
  [Parameter(Mandatory = $true)][string]$CertificatePath
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $CertificatePath).Path
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolved)
try {
  if ($certificate.Subject -ne 'CN=OpenSphere Installation CA') {
    throw "Refusing to trust an unexpected certificate subject: $($certificate.Subject)"
  }
  $basicConstraints = $certificate.Extensions |
    Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] } |
    Select-Object -First 1
  if (-not $basicConstraints -or -not $basicConstraints.CertificateAuthority) {
    throw 'Refusing to trust a certificate that is not a CA'
  }
  if ($certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow.AddDays(1)) {
    throw 'Refusing to trust an expired or near-expiry local CA'
  }

  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $existing = $store.Certificates.Find(
      [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
      $certificate.Thumbprint,
      $false
    )
    if ($existing.Count -eq 0) { $store.Add($certificate) }
  }
  finally {
    $store.Dispose()
  }
}
finally {
  $certificate.Dispose()
}
