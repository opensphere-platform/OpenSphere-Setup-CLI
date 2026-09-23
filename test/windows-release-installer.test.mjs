import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const workflow = await readFile(new URL('../.github/workflows/publish-platforms.yml', import.meta.url), 'utf8');
test('retained Windows build support is portable and excluded from the current release assets', () => {
  assert.match(workflow, /launchers[/]windows/);
  assert.match(workflow, /dist[/]opensphere-setup[.]exe/);
  assert.doesNotMatch(workflow, /Install-OpenSphereSetup|install-opensphere-setup[.]sh/);
  assert.match(workflow, /remote_digest/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  publish:')), /dist[/]opensphere-setup[.]exe/);
});
test('retired installer entrypoints cannot mutate host installation or PATH', async () => {
  for (const file of ['Install-OpenSphereSetup.ps1', 'scripts/Install-OpenSphereSetupRelease.ps1', 'scripts/Install-OpenSphereSetupRelease.sh']) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.match(source, /retired/i);
    assert.doesNotMatch(source, /SetEnvironmentVariable|LOCALAPPDATA|npm install|Copy-Item|Move-Item|ln -s/);
  }
});
