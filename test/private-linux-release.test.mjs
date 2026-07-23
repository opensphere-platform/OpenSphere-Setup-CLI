import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/publish-private-linux.yml', import.meta.url), 'utf8');
const build = await readFile(new URL('../scripts/build-linux-sea.mjs', import.meta.url), 'utf8');
const portableBuild = await readFile(new URL('../scripts/build-portable-linux-executable.mjs', import.meta.url), 'utf8');
const documentation = await readFile(new URL('../docs/PRIVATE-LINUX-INSTALL.md', import.meta.url), 'utf8');

test('private release publisher fails closed for a public repository', () => {
  assert.match(workflow, /visibility.*private/i);
  assert.match(workflow, /Refusing to publish.*public repository/i);
  assert.match(workflow, /opensphere-setup-linux-amd64/);
  assert.match(workflow, /opensphere-setup-linux-arm64/);
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

test('portable executable bundles libatomic and verifies its private extracted payload', () => {
  assert.match(workflow, /libatomic1:amd64/);
  assert.match(workflow, /libatomic1:arm64/);
  assert.match(portableBuild, /lib\/libatomic\.so\.1/);
  assert.match(portableBuild, /NODE-LICENSE/);
  assert.match(portableBuild, /LIBATOMIC-COPYRIGHT/);
  assert.match(portableBuild, /sha256sum --check PAYLOAD\.SHA256/);
  assert.match(portableBuild, /LD_LIBRARY_PATH=/);
});

test('private Linux installation requires authenticated GitHub download and checksum verification', () => {
  assert.match(documentation, /gh auth status/);
  assert.match(documentation, /gh release download/);
  assert.match(documentation, /sha256sum --check/);
  assert.match(documentation, /Contents:\s*read/i);
  assert.match(documentation, /libatomic\.so\.1/);
  assert.match(documentation, /필요하지 않다/);
  assert.doesNotMatch(documentation, /curl.*github\.com.*releases\/download/);
});
