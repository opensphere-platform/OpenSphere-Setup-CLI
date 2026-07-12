#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootstrap } from './bootstrap.mjs';
import { resolveChannel, validateChannel, validateLock } from './release.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function help() {
  console.log(`OpenSphere Setup CLI 0.1.0-edge.1

Usage:
  opensphere-setup resolve --release edge [--lock <file>]
  opensphere-setup bootstrap --release edge [--lock <file>]
  opensphere-setup status
  opensphere-setup version

The channel tag is used only during resolve. Kubernetes receives digest-pinned images.`);
}

async function main() {
  const command = process.argv[2] ?? 'help';
  const channel = option('--release', 'stable');
  const lockPath = resolve(option('--lock', `.opensphere-setup/${channel}-release-lock.json`));

  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'version' || command === '--version') return console.log('opensphere-setup 0.1.0-edge.1');

  if (command === 'resolve') {
    validateChannel(channel);
    const lock = await resolveChannel(channel);
    await mkdir(resolve(lockPath, '..'), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    console.log(`[완료] ${channel} 채널을 ${lock.releaseDigest}로 잠금`);
    console.log(`Lock: ${lockPath}`);
    return;
  }

  if (command === 'bootstrap') {
    validateChannel(channel);
    let lock;
    try {
      lock = validateLock(JSON.parse(await readFile(lockPath, 'utf8')));
      console.log(`[재사용] 기존 release lock ${lock.releaseDigest}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      lock = await resolveChannel(channel);
      await mkdir(resolve(lockPath, '..'), { recursive: true });
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      console.log(`[완료] ${channel} 채널을 ${lock.releaseDigest}로 잠금`);
    }
    await bootstrap(lock);
    return;
  }

  if (command === 'status') {
    const { kubectl } = await import('./process.mjs');
    kubectl(['get', 'pods', '-A', '-l', 'app.kubernetes.io/part-of=opensphere', '-o', 'wide']);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[실패] ${error.message}`);
  process.exitCode = 1;
});
