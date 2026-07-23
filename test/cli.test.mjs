import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'src', 'cli.mjs');

test('Supabase-reserved initial administrator name fails before cluster mutation', () => {
  const result = spawnSync(process.execPath, [CLI, 'bootstrap', '--release', 'edge', '--admin-username', 'anonymous'], {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reserved by Supabase Auth/);
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

test('Console endpoint rejects remote HTTP before any bootstrap action', () => {
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

test('promotion preflight refuses missing external inputs before cluster access', () => {
  const result = spawnSync(process.execPath, [CLI, 'preflight', '--release', 'candidate', '--console', 'https://console.example.test'], {
    encoding: 'utf8', cwd: ROOT, windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--recovery-target-secret must be an existing namespace\/name Secret reference/);
});

test('retired Kanidm service credential rotation is not exposed', () => {
  const result = spawnSync(process.execPath, [CLI, 'help'], {
    encoding: 'utf8', cwd: ROOT, windowsHide: true
  });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /rotate-service-credentials/);
});

test('retired backup target option is rejected instead of ignored', () => {
  const result = spawnSync(process.execPath, [
    CLI,
    'bootstrap',
    '--release',
    'edge',
    '--backup-target-secret',
    'platform-secrets/legacy'
  ], {
    encoding: 'utf8', cwd: ROOT, windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retired --backup-target-secret option is not accepted/);
});

test('registry credentials are accepted only through the paired token-stdin contract', () => {
  const missingTokenStdin = spawnSync(process.execPath, [CLI, 'resolve', '--release', 'edge', '--registry-username', 'opensphere-platform'], {
    encoding: 'utf8', cwd: ROOT, windowsHide: true
  });
  assert.notEqual(missingTokenStdin.status, 0);
  assert.match(missingTokenStdin.stderr, /--registry-username requires --registry-token-stdin/);

  const missingUsername = spawnSync(process.execPath, [CLI, 'resolve', '--release', 'edge', '--registry-token-stdin'], {
    encoding: 'utf8', cwd: ROOT, windowsHide: true, input: 'not-a-real-token'
  });
  assert.notEqual(missingUsername.status, 0);
  assert.match(missingUsername.stderr, /--registry-token-stdin requires --registry-username/);
});
