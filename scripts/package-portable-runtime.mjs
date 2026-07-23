#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmod, cp, mkdir, mkdtemp, rm, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return value;
}

function optionalOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  const value = process.argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

const sea = resolve(option('--sea'));
const pwsh = resolve(option('--pwsh-directory'));
const kubectl = resolve(option('--kubectl'));
const output = resolve(option('--output'));
const platform = option('--platform');
const architecture = option('--architecture');
const version = option('--version');
const libatomic = optionalOption('--libatomic');
if (!['windows', 'linux', 'darwin'].includes(platform)) throw new Error('invalid platform');
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('invalid architecture');
if (platform === 'linux' && !libatomic) throw new Error('--libatomic is required for Linux packages');
if (platform !== 'linux' && libatomic) throw new Error('--libatomic is only valid for Linux packages');

const temporary = await mkdtemp(join(tmpdir(), 'opensphere-platform-runtime-'));
const packageRoot = join(temporary, `opensphere-setup-${platform}-${architecture}`);
const runtime = join(packageRoot, 'runtime');
try {
  await mkdir(join(runtime, 'bin'), { recursive: true });
  await cp(pwsh, join(runtime, 'pwsh'), { recursive: true });
  await cp(kubectl, join(runtime, 'bin', platform === 'windows' ? 'kubectl.exe' : 'kubectl'));

  if (platform === 'windows') {
    await cp(sea, join(packageRoot, 'opensphere-setup.exe'));
  } else if (platform === 'linux') {
    await mkdir(join(runtime, 'lib'), { recursive: true });
    await cp(resolve(libatomic), join(runtime, 'lib', 'libatomic.so.1'));
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await cp(sea, join(packageRoot, 'bin', 'opensphere-setup.bin'));
    await writeFile(join(packageRoot, 'opensphere-setup'), `#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export OPENSPHERE_PORTABLE_ROOT="$root"
export LD_LIBRARY_PATH="$root/runtime/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$root/bin/opensphere-setup.bin" "$@"
`, { mode: 0o755 });
  } else {
    await cp(sea, join(packageRoot, 'opensphere-setup'));
  }

  if (platform !== 'windows') {
    await chmod(join(packageRoot, 'opensphere-setup'), 0o755);
    if (platform === 'linux') await chmod(join(packageRoot, 'bin', 'opensphere-setup.bin'), 0o755);
    await chmod(join(runtime, 'pwsh', 'pwsh'), 0o755);
    await chmod(join(runtime, 'bin', 'kubectl'), 0o755);
  }
  await writeFile(join(packageRoot, 'OPENSPHERE-RUNTIME.json'), `${JSON.stringify({
    name: 'opensphere-setup',
    version,
    platform,
    architecture,
    bundled: platform === 'linux'
      ? ['node', 'powershell', 'kubectl', 'libatomic']
      : ['node', 'powershell', 'kubectl']
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, 'THIRD-PARTY-NOTICES.txt'),
    'Node.js: MIT\nPowerShell: MIT\nkubectl/Kubernetes: Apache-2.0\n');

  await mkdir(dirname(output), { recursive: true });
  if (platform === 'windows') {
    run('tar', ['-a', '-cf', output, '-C', temporary, basename(packageRoot)]);
  } else {
    run('tar', ['-czf', output, '-C', temporary, basename(packageRoot)]);
  }
  console.log(`[완료] ${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
