import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/publish-platforms.yml', import.meta.url), 'utf8');
const build = await readFile(new URL('../scripts/build-linux-sea.mjs', import.meta.url), 'utf8');
const portableBuild = await readFile(new URL('../scripts/package-portable-runtime.mjs', import.meta.url), 'utf8');
const documentation = await readFile(new URL('../docs/PLATFORM-INSTALL.md', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('public release publisher fails closed for a non-public repository', () => {
  assert.match(workflow, /visibility.*public/i);
  assert.match(workflow, /Refusing non-public Setup distribution/i);
  assert.match(workflow, /opensphere-setup-windows-amd64/);
  assert.match(workflow, /opensphere-setup-linux-amd64/);
  assert.match(workflow, /opensphere-setup-linux-arm64/);
  assert.match(workflow, /opensphere-setup-darwin-amd64/);
  assert.match(workflow, /opensphere-setup-darwin-arm64/);
  assert.match(workflow, /codesign --force --sign -/);
  assert.match(workflow, /Smoke-test packaged runtime/);
  assert.match(workflow, /Bundled PowerShell smoke test failed/);
  assert.match(workflow, /Bundled kubectl smoke test failed/);
  assert.match(workflow, /SHA256SUMS/);
  assert.match(workflow, /[.]immutable/);
  assert.match(workflow, /remote_digest/);
  assert.match(workflow, /Publish public GitHub Release/);
  assert.doesNotMatch(workflow, /attest-build-provenance/);
  assert.doesNotMatch(workflow, /npm publish|docker push/);
  assert.equal(pkg.private, true, 'npm publication remains deliberately disabled');
});

test('public publisher reads the governed private Console source through one scoped secret', () => {
  assert.match(workflow, /OPENSPHERE_CONSOLE_SOURCE_TOKEN/);
  assert.match(workflow, /token: [$][{][{] secrets[.]OPENSPHERE_CONSOLE_SOURCE_TOKEN [}][}]/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /token:\s*[$][{][{]\s*github[.]token/);
});

test('Linux release is a self-contained SEA with embedded certificate assets', () => {
  assert.match(build, /mainFormat: 'module'/);
  assert.match(build, /New-Certificates[.]ps1/);
  assert.match(build, /Install-LocalDevelopmentCa[.]ps1/);
  assert.match(build, /useCodeCache: false/);
  assert.match(build, /useSnapshot: false/);
});

test('portable archives bundle their required runtimes, including Linux libatomic', () => {
  assert.match(workflow, /debian:bookworm-slim/);
  assert.match(workflow, /apt-get download libatomic1/);
  assert.match(portableBuild, /join\(runtime, 'lib', 'libatomic[.]so[.]1'\)/);
  assert.match(portableBuild, /powershell/);
  assert.match(portableBuild, /kubectl/);
  assert.match(portableBuild, /LD_LIBRARY_PATH=/);
  assert.match(portableBuild, /run\('codesign', \['--force', '--sign', '-', packagedSetup\]\)/);
  assert.match(portableBuild, /run\('codesign', \['--verify', '--strict', '--verbose=4', packagedSetup\]\)/);
  assert.match(portableBuild, /usesMacIntelRuntime/);
  assert.match(portableBuild, /runtime[/]bin[/]node/);
  assert.match(portableBuild, /runtime[/]setup[/]index[.]mjs/);
  assert.match(workflow, /--node-executable/);
});

test('public platform installation is unauthenticated and checksum verified', () => {
  assert.match(documentation, /공개 GitHub Release/);
  assert.match(documentation, /api[.]github[.]com[/]repos[/][$]repository[/]releases[/]tags[/][$]release/);
  assert.match(documentation, /Invoke-WebRequest/);
  assert.match(documentation, /curl --fail --location/);
  assert.match(documentation, /SHA256SUMS/);
  assert.match(documentation, /libatomic[.]so[.]1/);
  assert.match(documentation, /Node[.]js.*npm.*PowerShell.*kubectl.*libatomic.*별도로 설치할 필요가 없다/s);
  assert.doesNotMatch(documentation, /gh auth login|Contents:\s*read/i);
});
