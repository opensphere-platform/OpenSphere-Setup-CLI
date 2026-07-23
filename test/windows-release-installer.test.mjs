import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const installer = await readFile(
  new URL('../scripts/Install-OpenSphereSetupRelease.ps1', import.meta.url),
  'utf8'
);
const workflow = await readFile(
  new URL('../.github/workflows/publish-private-platforms.yml', import.meta.url),
  'utf8'
);

test('Windows release installer automates authenticated download and verification', () => {
  assert.match(installer, /gh @Arguments/);
  assert.match(installer, /release download/);
  assert.match(installer, /release verify /);
  assert.match(installer, /release verify-asset/);
  assert.match(installer, /Get-FileHash[\s\S]*SHA256/);
  assert.match(installer, /Expand-Archive/);
  assert.match(installer, /\[string\]\$BinDirectory/);
  assert.match(installer, /OpenSphere\\bin/);
  assert.match(installer, /SetEnvironmentVariable\('Path'/);
  assert.match(installer, /opensphere-setup\.cmd/);
  assert.doesNotMatch(installer, /Invoke-Expression|\biex\b|curl|Invoke-WebRequest/);
});

test('private release materializes and publishes the version-bound installer', () => {
  assert.match(installer, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
  assert.match(workflow, /Install-OpenSphereSetup\.ps1/);
  assert.match(workflow, /Install-OpenSphereSetupRelease\.ps1/);
  assert.match(workflow, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
  assert.match(workflow, /dist\/SHA256SUMS/);
});
