#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod, copyFile, mkdir, mkdtemp, rm, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return value;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

const sea = resolve(option('--sea'));
const libatomic = resolve(option('--libatomic'));
const nodeLicense = resolve(option('--node-license'));
const libatomicLicense = resolve(option('--libatomic-license'));
const output = resolve(option('--output'));
const version = option('--version');
const architecture = option('--architecture');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('invalid version');
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('invalid architecture');

const stage = await mkdtemp(join(tmpdir(), 'opensphere-setup-portable-'));
const archive = join(stage, 'payload.tar.gz');
const payload = join(stage, 'payload');
const payloadFiles = [
  ['bin/opensphere-setup.bin', sea],
  ['lib/libatomic.so.1', libatomic],
  ['licenses/NODE-LICENSE', nodeLicense],
  ['licenses/LIBATOMIC-COPYRIGHT', libatomicLicense]
];

try {
  for (const [relative, source] of payloadFiles) {
    const target = join(payload, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await chmod(join(payload, 'bin', 'opensphere-setup.bin'), 0o755);
  const checksums = [];
  for (const [relative] of payloadFiles) {
    checksums.push(`${await sha256(join(payload, relative))}  ${relative}`);
  }
  await writeFile(join(payload, 'PAYLOAD.SHA256'), `${checksums.join('\n')}\n`, 'utf8');
  run('tar', ['-czf', archive, '-C', payload, '.']);

  const header = `#!/bin/sh
set -eu
umask 077
version='${version}'
architecture='${architecture}'
cache_home="\${XDG_CACHE_HOME:-\${HOME:-/tmp}/.cache}"
runtime="\${cache_home}/opensphere-setup/\${version}/\${architecture}"
binary="\${runtime}/bin/opensphere-setup.bin"
library="\${runtime}/lib/libatomic.so.1"
tmp=''
cleanup() {
  if [ -n "\${tmp}" ] && [ -d "\${tmp}" ]; then rm -rf -- "\${tmp}"; fi
}
trap cleanup EXIT HUP INT TERM
if [ ! -x "\${binary}" ] || [ ! -f "\${library}" ]; then
  mkdir -p "\$(dirname "\${runtime}")"
  tmp="\$(mktemp -d "\${runtime}.tmp.XXXXXX")"
  archive_line="\$(awk '/^__OPENSPHERE_ARCHIVE_BELOW__$/ { print NR + 1; exit }' "$0")"
  if [ -z "\${archive_line}" ]; then
    echo 'OpenSphere Setup payload marker is missing' >&2
    exit 1
  fi
  tail -n "+\${archive_line}" "$0" | tar -xzf - -C "\${tmp}"
  (cd "\${tmp}" && sha256sum --check PAYLOAD.SHA256 >/dev/null)
  if mv "\${tmp}" "\${runtime}" 2>/dev/null; then
    tmp=''
  else
    rm -rf -- "\${tmp}"
    tmp=''
  fi
fi
if [ ! -x "\${binary}" ] || [ ! -f "\${library}" ]; then
  echo 'OpenSphere Setup portable runtime extraction failed' >&2
  exit 1
fi
LD_LIBRARY_PATH="\${runtime}/lib\${LD_LIBRARY_PATH:+:\${LD_LIBRARY_PATH}}" exec "\${binary}" "$@"
exit 1
__OPENSPHERE_ARCHIVE_BELOW__
`;

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, header, { encoding: 'utf8', mode: 0o755 });
  await pipeline(createReadStream(archive), createWriteStream(output, { flags: 'a' }));
  await chmod(output, 0o755);
  console.log(`[완료] Portable Linux executable: ${basename(output)}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
