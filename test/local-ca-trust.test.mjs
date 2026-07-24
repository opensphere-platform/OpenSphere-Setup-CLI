import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('Windows local CA trust is narrowly scoped to the managed localhost development origin', async () => {
  const bootstrap = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  assert.match(bootstrap, /\['localhost', '127\.0\.0\.1', '\[::1\]'\]\.includes\(hostname\)/);
  assert.match(bootstrap, /!externalShellTls[\s\S]{0,180}lock\.channel === 'edge'[\s\S]{0,120}effectiveAuthEnvironment === 'development'/);
  assert.match(bootstrap, /process\.platform === 'win32'/);
  assert.match(bootstrap, /Install-LocalDevelopmentCa\.ps1/);
});

test('local CA installer validates the exact CA identity and writes only CurrentUser Root', async () => {
  const source = await readFile(join(ROOT, 'src', 'Install-LocalDevelopmentCa.ps1'), 'utf8');
  assert.match(source, /Subject -ne 'CN=OpenSphere Installation CA'/);
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
