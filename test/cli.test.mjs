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
