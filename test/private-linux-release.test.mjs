import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/publish-private-platforms.yml', import.meta.url), 'utf8');
const build = await readFile(new URL('../scripts/build-linux-sea.mjs', import.meta.url), 'utf8');
const portableBuild = await readFile(new URL('../scripts/package-portable-runtime.mjs', import.meta.url), 'utf8');
const documentation = await readFile(new URL('../docs/PRIVATE-PLATFORM-INSTALL.md', import.meta.url), 'utf8');

test('private release publisher fails closed for a public repository', () => {
  assert.match(workflow, /visibility.*private/i);
  assert.match(workflow, /Refusing public Setup distribution/i);
  assert.match(workflow, /opensphere-setup-windows-amd64/);
  assert.match(workflow, /opensphere-setup-linux-amd64/);
  assert.match(workflow, /opensphere-setup-linux-arm64/);
  assert.match(workflow, /opensphere-setup-darwin-amd64/);
  assert.match(workflow, /opensphere-setup-darwin-arm64/);
  assert.match(workflow, /SHA256SUMS/);
  assert.doesNotMatch(workflow, /npm publish|docker push/);
});

test('Linux release is a self-contained SEA with embedded certificate assets', () => {
  assert.match(build, /mainFormat: 'module'/);
  assert.match(build, /New-Certificates\.ps1/);
  assert.match(build, /Install-LocalDevelopmentCa\.ps1/);
  assert.match(build, /useCodeCache: false/);
  assert.match(build, /useSnapshot: false/);
});

test('portable archives bundle their required runtimes, including Linux libatomic', () => {
  assert.match(workflow, /debian:bookworm-slim/);
  assert.match(workflow, /apt-get download libatomic1/);
  assert.match(portableBuild, /join\(runtime, 'lib', 'libatomic\.so\.1'\)/);
  assert.match(portableBuild, /powershell/);
  assert.match(portableBuild, /kubectl/);
  assert.match(portableBuild, /LD_LIBRARY_PATH=/);
});

test('private platform installation requires authenticated GitHub download and checksum verification', () => {
  assert.match(documentation, /gh auth status/);
  assert.match(documentation, /gh release download/);
  assert.match(documentation, /SHA256SUMS/);
  assert.match(documentation, /Contents:\s*read/i);
  assert.match(documentation, /libatomic\.so\.1/);
  assert.match(documentation, /Node\.js.*npm.*PowerShell.*kubectl.*libatomic.*필요가 없다/s);
  assert.doesNotMatch(documentation, /curl.*github\.com.*releases\/download/);
});
