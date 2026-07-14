import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('bootstrap service tokens are bounded and carry rotation metadata', async () => {
  const source = await readFile(join(ROOT, 'src', 'provision-admin.mjs'), 'utf8');
  assert.match(source, /OPENSPHERE_SERVICE_TOKEN_TTL_DAYS/);
  assert.match(source, /SERVICE_TOKEN_TTL_DAYS < 1 \|\| SERVICE_TOKEN_TTL_DAYS > 90/);
  assert.match(source, /const expiry = Math\.floor\(expiresAt\.getTime\(\) \/ 1000\)/);
  assert.match(source, /expiry,/);
  assert.doesNotMatch(source, /expiry:\s*null/);
  assert.match(source, /expires_at: credential\.expiresAt/);
});

test('service token Secrets are passed on stdin instead of process argv', async () => {
  const source = await readFile(join(ROOT, 'src', 'provision-admin.mjs'), 'utf8');
  assert.match(source, /Secret document on stdin/);
  assert.match(source, /spawnSync\('kubectl', \['apply', '-f', '-'\]/);
  assert.doesNotMatch(source, /--from-literal=token=/);
});

test('installation verification rejects missing or soon-expiring service credentials', async () => {
  const source = await readFile(join(ROOT, 'src', 'verify.mjs'), 'utf8');
  assert.match(source, /opensphere-identity-kanidm': \['url', 'token', 'expires_at'\]/);
  assert.match(source, /Service credential must be rotated before expiry/);
  assert.match(source, /backbone-rustfs-tls': \['tls\.crt', 'tls\.key'\]/);
  assert.match(source, /verifyRustfsTransport/);
  assert.match(source, /verified in-cluster HTTPS endpoint/);
});
