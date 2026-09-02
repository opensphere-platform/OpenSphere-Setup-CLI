import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const installer = await readFile(
  new URL('../scripts/Install-OpenSphereSetupRelease.ps1', import.meta.url),
  'utf8'
);
const workflow = await readFile(
  new URL('../.github/workflows/publish-platforms.yml', import.meta.url),
  'utf8'
);

test('Windows public release installer automates unauthenticated download and verification', () => {
  assert.match(installer, /api[.]github[.]com[/]repos/);
  assert.match(installer, /Invoke-RestMethod/);
  assert.match(installer, /Invoke-WebRequest/);
  assert.match(installer, /[.]immutable -ne [$]true/);
  assert.match(installer, /[$]Asset[.]digest/);
  assert.match(installer, /Get-FileHash[\s\S]*SHA256/);
  assert.match(installer, /SHA256SUMS/);
  assert.match(installer, /Expand-Archive/);
  assert.match(installer, /\[string\][$]BinDirectory/);
  assert.match(installer, /OpenSphere\\bin/);
  assert.match(installer, /SetEnvironmentVariable\('Path'/);
  assert.match(installer, /opensphere-setup[.]cmd/);
  assert.match(installer, /Only the canonical public Setup repository is accepted/);
  assert.doesNotMatch(installer, /gh auth|gh @Arguments|GH_TOKEN|Invoke-Expression|\biex\b/);
  assert.doesNotMatch(installer, /Move-Item -LiteralPath [$]stagedRoot/);
  assert.match(
    installer,
    /Copy-Item -LiteralPath [$]stagedRoot -Destination [$]installationStaging -Recurse -Force/
  );
  assert.match(
    installer,
    /Move-Item -LiteralPath [$]installationStaging -Destination [$]installDirectory/
  );
});

test('public release materializes and publishes the version-bound installer', () => {
  assert.match(installer, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
  const materialized = installer.replaceAll(
    '__OPENSPHERE_SETUP_RELEASE_TAG__',
    'setup-v0.5.0-edge.17'
  );
  assert.doesNotMatch(materialized, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
  assert.match(workflow, /Install-OpenSphereSetup[.]ps1/);
  assert.match(workflow, /Install-OpenSphereSetupRelease[.]ps1/);
  assert.match(workflow, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
  assert.match(workflow, /dist[/]SHA256SUMS/);
  assert.match(workflow, /docs[/]PLATFORM-RELEASE-NOTES[.]md/);
});
