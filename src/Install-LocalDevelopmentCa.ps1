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
      throw "certutil failed to add the OpenSphere development CA to CurrentUser Root (exit=$LASTEXITCODE)"
    }
  }
}
finally {
  $certificate.Dispose()
}
