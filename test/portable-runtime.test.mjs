import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { activatePortableRuntime } from '../src/portable-runtime.mjs';

const PACKAGER = resolve(import.meta.dirname, '..', 'scripts', 'package-portable-runtime.mjs');

test('portable archive prepends its bundled pwsh and kubectl without requiring host installs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opensphere-portable-test-'));
  try {
    await mkdir(join(root, 'runtime', 'pwsh'), { recursive: true });
    await mkdir(join(root, 'runtime', 'bin'), { recursive: true });
    await writeFile(join(root, 'runtime', 'pwsh', 'pwsh.exe'), '');
    await writeFile(join(root, 'runtime', 'bin', 'kubectl.exe'), '');
    const environment = { PATH: 'host-path', OPENSPHERE_PORTABLE_ROOT: root };
    const result = activatePortableRuntime({ environment, platform: 'win32' });
    assert.equal(result.active, true);
    assert.equal(environment.OPENSPHERE_BUNDLED_RUNTIME, '1');
    assert.deepEqual(environment.PATH.split(delimiter).slice(0, 2), [
      join(root, 'runtime', 'pwsh'),
      join(root, 'runtime', 'bin')
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('platform packager emits the bundled Windows and Linux runtime layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opensphere-package-test-'));
  try {
    const pwsh = join(root, 'pwsh');
    const sea = join(root, 'setup.bin');
    const kubectl = join(root, 'kubectl');
    const libatomic = join(root, 'libatomic.so.1');
    await mkdir(pwsh, { recursive: true });
    await Promise.all([
      writeFile(join(pwsh, 'pwsh.exe'), ''),
      writeFile(join(pwsh, 'pwsh'), ''),
      writeFile(sea, ''),
      writeFile(kubectl, ''),
      writeFile(libatomic, '')
    ]);

    const cases = [
      {
        platform: 'windows',
        output: join(root, 'windows.zip'),
        expected: [
          'opensphere-setup-windows-amd64/opensphere-setup.exe',
          'opensphere-setup-windows-amd64/runtime/pwsh/pwsh.exe',
          'opensphere-setup-windows-amd64/runtime/bin/kubectl.exe'
        ],
        extra: []
      },
      {
        platform: 'linux',
        output: join(root, 'linux.tar.gz'),
        expected: [
          'opensphere-setup-linux-amd64/opensphere-setup',
          'opensphere-setup-linux-amd64/bin/opensphere-setup.bin',
          'opensphere-setup-linux-amd64/runtime/pwsh/pwsh',
          'opensphere-setup-linux-amd64/runtime/bin/kubectl',
          'opensphere-setup-linux-amd64/runtime/lib/libatomic.so.1'
        ],
        extra: ['--libatomic', libatomic]
      }
    ];

    for (const item of cases) {
      const packaged = spawnSync(process.execPath, [
        PACKAGER,
        '--sea', sea,
        '--pwsh-directory', pwsh,
        '--kubectl', kubectl,
        '--platform', item.platform,
        '--architecture', 'amd64',
        '--version', 'test',
        '--output', item.output,
        ...item.extra
      ], { encoding: 'utf8', windowsHide: true });
      assert.equal(packaged.status, 0, packaged.stderr);

      const listed = spawnSync('tar', ['-tf', item.output], {
        encoding: 'utf8',
        windowsHide: true
      });
      assert.equal(listed.status, 0, listed.stderr);
      const entries = listed.stdout.replaceAll('\\', '/');
      for (const expected of item.expected) assert.match(entries, new RegExp(expected.replaceAll('.', '\\.')));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
