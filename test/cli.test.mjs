import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'src', 'cli.mjs');

test('identity-reserved initial administrator names fail before cluster mutation', () => {
  for (const name of ['admin', 'idm_admin', 'anonymous']) {
    const result = spawnSync(process.execPath, [CLI, 'bootstrap', '--release', 'edge', '--admin-username', name], {
      encoding: 'utf8',
      cwd: ROOT,
      windowsHide: true
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is reserved by the identity service/);
  }
});

test('missing option values are rejected', () => {
  const result = spawnSync(process.execPath, [CLI, 'bootstrap', '--release'], {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--release requires a value/);
});

test('-r is an alias for --release', () => {
  const result = spawnSync(process.execPath, [CLI, 'bootstrap', '-r', 'not-a-channel', '--admin-username', 'admin'], {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported channel: not-a-channel/);
});

test('long and short release options cannot conflict', () => {
  const result = spawnSync(process.execPath, [CLI, 'bootstrap', '--release', 'stable', '-r', 'edge'], {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--release\/-r may only be specified once/);
});

test('Console endpoint must be an exact HTTPS origin before any bootstrap action', () => {
  const result = spawnSync(process.execPath, [CLI, 'bootstrap', '--console', 'http://insecure.example.test'], {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--console must be an HTTPS origin/);
});

test('promotion bootstrap refuses to touch the cluster without an external shell TLS source', () => {
  const result = spawnSync(process.execPath, [CLI, 'bootstrap', '--release', 'candidate'], {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --shell-tls-secret/);
});

test('service credential rotation is an explicit supported maintenance command', () => {
  const result = spawnSync(process.execPath, [CLI, 'help'], {
    encoding: 'utf8', cwd: ROOT, windowsHide: true
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /rotate-service-credentials/);
});
