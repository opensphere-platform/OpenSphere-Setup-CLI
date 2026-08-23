import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const installer = readFileSync(new URL('../Install-OpenSphereSetup.ps1', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const entrypoint = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');

test('opensphere-setup is the canonical installed package command', () => {
  assert.deepEqual(pkg.bin, { 'opensphere-setup': 'src/cli.mjs' });
  assert.match(entrypoint, /^#!\/usr\/bin\/env node/);
  assert.match(installer, /npm install --global \$repoRoot --no-audit --no-fund/);
  assert.match(installer, /Get-Command opensphere-setup/);
  assert.match(installer, /\$expectedVersion = "opensphere-setup \$\(\$package\.version\)"/);
});

test('operator documentation and CI smoke test use the canonical command', () => {
  assert.match(readme, /opensphere-setup bootstrap/);
  assert.match(readme, /opensphere-setup verify/);
  assert.match(readme, /opensphere-setup upgrade/);
  assert.doesNotMatch(readme, /node \.?[\\/]+src[\\/]+cli\.mjs/);
  assert.doesNotMatch(readme, /\\opensphere-setup\.cmd/);
  assert.match(ci, /Install-OpenSphereSetup\.ps1/);
  assert.match(ci, /opensphere-setup version/);
  assert.doesNotMatch(ci, /opensphere-setup (?:bootstrap|verify|upgrade)/);
});

test('upgrade preflight accepts historical installed component sets only as baselines', () => {
  const migrationGuard = bootstrap.match(
    /export async function migrateLegacyInstallationLock\(\)[\s\S]*?\r?\n}\r?\n/
  )?.[0] ?? '';

  assert.match(migrationGuard, /isLocalEdgeLock\(lock\)/);
  assert.match(migrationGuard, /allowLegacyComponentSet:\s*true/);
  assert.match(migrationGuard, /allowInstalledAgentIdentityCutover:\s*true/);
});
