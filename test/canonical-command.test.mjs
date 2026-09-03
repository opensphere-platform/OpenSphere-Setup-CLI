import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const installer = readFileSync(new URL('../Install-OpenSphereSetup.ps1', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const entrypoint = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');

test('source command remains available without a global installation', () => {
  assert.deepEqual(pkg.bin, { 'opensphere-setup': 'src/cli.mjs' });
  assert.match(installer, /retired/);
  assert.doesNotMatch(installer, /npm install --global|SetEnvironmentVariable|New-Item/);
  assert.equal(pkg.scripts['install:command'], undefined);
  assert.equal(pkg.scripts['pretest:e2e:edge'], undefined);
});

test('operator documentation and CI use in-place execution', () => {
  assert.match(readme, /opensphere-setup[.]exe --channel edge doctor/);
  assert.match(ci, /node src[/]cli[.]mjs version/);
  assert.doesNotMatch(ci, /Install-OpenSphereSetup[.]ps1|npm install --global/);
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
