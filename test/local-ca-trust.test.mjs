import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('Windows local CA trust is narrowly scoped to the explicit managed edge development install', async () => {
  const bootstrap = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  assert.match(bootstrap, /!externalShellTls[\s\S]{0,180}lock\.channel === 'edge'[\s\S]{0,120}effectiveAuthEnvironment === 'development'/);
  assert.match(bootstrap, /process\.platform === 'win32'/);
  assert.match(bootstrap, /Install-LocalDevelopmentCa\.ps1/);
  assert.match(bootstrap, /trustLocalCa = false/);
  assert.match(bootstrap, /trustLocalCa\s*&& !externalShellTls/);
});

// Since 2026-09-23 trust is offered for any Console origin, not only localhost. That is safe only
// because the CA private key dies with the script: a trusted CA that can never sign again covers
// exactly the names already issued. If this ever fails, restore the localhost limit first.
test('installation CA private key is never written, so trusting the CA cannot extend to other names', async () => {
  const source = await readFile(join(ROOT, 'src', 'New-Certificates.ps1'), 'utf8');
  assert.match(source, /\$caKey\.Dispose\(\)/);
  assert.doesNotMatch(source, /\$caKey\.Export/);
  assert.match(source, /'ca\.crt'\), \$caCertificate\.ExportCertificatePem\(\)/);
  assert.doesNotMatch(source, /\$caCertificate\.(CopyWithPrivateKey|Export\(|ExportPkcs)/);
});

test('local CA installer validates the CA identity and the reviewed fingerprint and writes only CurrentUser Root', async () => {
  const source = await readFile(join(ROOT, 'src', 'Install-LocalDevelopmentCa.ps1'), 'utf8');
  // The legacy shared name or the per-installation name (2026-10-10), self-signed.
  assert.match(source, /Subject -eq 'CN=OpenSphere Installation CA'/);
  assert.match(source, /OU=installation/);
  assert.match(source, /Subject -ne \$certificate\.Issuer/);
  // The fingerprint the operator compared is mandatory and checked before any store access.
  assert.match(source, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedSha256/);
  assert.ok(source.indexOf('GetCertHashString') < source.indexOf('X509Store]::new'));
  assert.match(source, /X509BasicConstraintsExtension/);
  assert.match(source, /CertificateAuthority/);
  assert.match(source, /StoreName\]::Root/);
  assert.match(source, /StoreLocation\]::CurrentUser/);
  assert.match(source, /OpenFlags\]::ReadOnly/);
  assert.match(source, /certutil\.exe/);
  assert.match(source, /-user -f -addstore Root/);
  assert.doesNotMatch(source, /OpenFlags\]::ReadWrite|\.Add\(\$certificate\)/);
  assert.doesNotMatch(source, /LocalMachine/);
});

test('bootstrap contains only the explicit temporary HTTP-to-HTTPS repair exception', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  assert.match(source, /isLegacyEdgeLoopbackHttpOrigin/);
  assert.match(source, /installed && !repairLegacyLoopbackHttp \? storedConsoleUrl : requestedConsoleUrl/);
  assert.match(source, /changing it requires endpoint migration/);
});
