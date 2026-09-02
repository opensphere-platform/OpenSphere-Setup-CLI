import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const powershellInstaller = await readFile(
  new URL('../scripts/Install-OpenSphereSetupRelease.ps1', import.meta.url),
  'utf8'
);
const shellInstaller = await readFile(
  new URL('../scripts/Install-OpenSphereSetupRelease.sh', import.meta.url),
  'utf8'
);
const windowsBootstrap = await readFile(
  new URL('../installers/windows/main.go', import.meta.url),
  'utf8'
);
const workflow = await readFile(
  new URL('../.github/workflows/publish-platforms.yml', import.meta.url),
  'utf8'
);
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('Windows public release PowerShell installer verifies and installs the portable runtime', () => {
  assert.match(powershellInstaller, /api[.]github[.]com[/]repos/);
  assert.match(powershellInstaller, /Invoke-RestMethod/);
  assert.match(powershellInstaller, /Invoke-WebRequest -UseBasicParsing/);
  assert.match(powershellInstaller, /[.]immutable -ne [$]true/);
  assert.match(powershellInstaller, /[$]Asset[.]digest/);
  assert.match(powershellInstaller, /Get-FileHash[\s\S]*SHA256/);
  assert.match(powershellInstaller, /SHA256SUMS/);
  assert.match(powershellInstaller, /Expand-Archive/);
  assert.match(powershellInstaller, /\[string\][$]BinDirectory/);
  assert.match(powershellInstaller, /OpenSphere\\bin/);
  assert.match(powershellInstaller, /SetEnvironmentVariable\('Path'/);
  assert.match(powershellInstaller, /opensphere-setup[.]cmd/);
  assert.match(powershellInstaller, /Only the canonical public Setup repository is accepted/);
  assert.match(powershellInstaller, /Version/);
  assert.match(powershellInstaller, /Channel/);
  assert.match(powershellInstaller, /mutually exclusive/);
  assert.match(powershellInstaller, /channels[/][$]Channel/);
  assert.doesNotMatch(powershellInstaller, /gh auth|gh @Arguments|GH_TOKEN|Invoke-Expression|\biex\b/);
  assert.doesNotMatch(powershellInstaller, /Move-Item -LiteralPath [$]stagedRoot/);
  assert.match(
    powershellInstaller,
    /Copy-Item -LiteralPath [$]stagedRoot -Destination [$]installationStaging -Recurse -Force/
  );
  assert.match(
    powershellInstaller,
    /Move-Item -LiteralPath [$]installationStaging -Destination [$]installDirectory/
  );
});

test('Windows executable is a version-bound bootstrap for the verified PowerShell installer', () => {
  assert.match(windowsBootstrap, /var releaseTag string/);
  assert.match(windowsBootstrap, /release[.]Immutable/);
  assert.match(windowsBootstrap, /asset[.]Digest/);
  assert.match(windowsBootstrap, /sha256[.]New/);
  assert.match(windowsBootstrap, /canonicalRepository/);
  assert.match(windowsBootstrap, /powershell[.]exe/);
  assert.match(windowsBootstrap, /--bootstrap-version/);
  assert.match(windowsBootstrap, /--version/);
  assert.match(windowsBootstrap, /--channel/);
  assert.match(windowsBootstrap, /channelPointerBase/);
  assert.match(windowsBootstrap, /mutually exclusive/);
  assert.doesNotMatch(windowsBootstrap, /GH_TOKEN|Authorization/);
  assert.match(workflow, /go build -trimpath/);
  assert.match(workflow, /Install-OpenSphereSetup[.]exe --bootstrap-version/);
});

test('Linux and macOS installer selects one platform archive and verifies SHA-256', () => {
  assert.match(shellInstaller, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
  assert.match(shellInstaller, /uname -s/);
  assert.match(shellInstaller, /uname -m/);
  assert.match(shellInstaller, /sha256sum/);
  assert.match(shellInstaller, /shasum -a 256/);
  assert.match(shellInstaller, /OPENSPHERE_SETUP_INSTALL_ROOT/);
  assert.match(shellInstaller, /OPENSPHERE_SETUP_BIN_DIR/);
  assert.match(shellInstaller, /--version/);
  assert.match(shellInstaller, /--channel/);
  assert.match(shellInstaller, /channels[/][$][{]selected_channel[}]/);
  assert.match(shellInstaller, /mutually exclusive/);
  assert.match(shellInstaller, /Refusing to replace a non-symlink command/);
  assert.doesNotMatch(shellInstaller, /curl[^\n]*[|][^\n]*(?:sh|bash)/);
});

test('public release materializes and publishes all version-bound installers', () => {
  for (const source of [powershellInstaller, shellInstaller]) {
    assert.match(source, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
    const materialized = source.replaceAll(
      '__OPENSPHERE_SETUP_RELEASE_TAG__',
      'setup-v0.5.0-edge.18'
    );
    assert.doesNotMatch(materialized, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
  }
  assert.match(workflow, /Install-OpenSphereSetup[.]exe/);
  assert.match(workflow, /Install-OpenSphereSetup[.]ps1/);
  assert.match(workflow, /install-opensphere-setup[.]sh/);
  assert.match(workflow, /__OPENSPHERE_SETUP_RELEASE_TAG__/);
  assert.match(workflow, /Require declared Setup CLI channel pointer/);
  assert.match(workflow, /channels[/][$]channel/);
  assert.match(workflow, /dist[/]SHA256SUMS/);
  assert.match(workflow, /docs[/]PLATFORM-RELEASE-NOTES[.]md/);
  assert.match(readme, /Install-OpenSphereSetup[.]exe 다운로드/);
  assert.match(readme, /install-opensphere-setup[.]sh/);
});