#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootstrap, existingOpenSphereNamespaces, readInstallationLock } from './bootstrap.mjs';
import { resolveChannel, validateChannel, validateLock } from './release.mjs';
import { assertKubectl, kubectl } from './process.mjs';
import { verifyInstallation } from './verify.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function hasOption(name) {
  return process.argv.includes(name);
}

function validateInitialAdmin(initialAdmin) {
  if (!/^[a-z][a-z0-9._-]{1,31}$/.test(initialAdmin.username)) {
    throw new Error('--admin-username must be 2-32 lowercase letters, numbers, dot, underscore or hyphen');
  }
  if (['admin', 'idm_admin', 'anonymous'].includes(initialAdmin.username)) {
    throw new Error(`--admin-username ${initialAdmin.username} is reserved by the identity service`);
  }
  if (!initialAdmin.displayName.trim()) throw new Error('--admin-display-name must not be empty');
  if (!/^[^\s@]+@[^\s@]+$/.test(initialAdmin.email)) throw new Error('--admin-email must be an email address');
  return initialAdmin;
}

async function writeLock(lockPath, lock) {
  await mkdir(resolve(lockPath, '..'), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function readLock(lockPath) {
  return validateLock(JSON.parse(await readFile(lockPath, 'utf8')));
}

function help() {
  console.log(`OpenSphere Setup CLI 0.2.0-edge.1

Usage:
  opensphere-setup resolve --release <edge|candidate|stable> [--lock <file>]
  opensphere-setup bootstrap --release <channel> [--lock <verified-lock-file>]
      [--context <kube-context>] [--admin-username <name>]
      [--admin-display-name <name>] [--admin-email <email>]
      [--storage-class <name>] [--no-open-browser]
  opensphere-setup verify [--context <kube-context>]
  opensphere-setup status
  opensphere-setup version

Fresh bootstrap resolves the selected channel at install time. Resume always uses the
cluster installation lock. --lock is an explicit immutable input; it is never a cache hint.
Kubernetes receives digest-pinned images only.`);
}

async function main() {
  const command = process.argv[2] ?? 'help';
  const channel = option('--release', 'stable');
  const lockPath = resolve(option('--lock', `.opensphere-setup/${channel}-release-lock.json`));
  const explicitLock = hasOption('--lock');
  const context = option('--context', '');
  if (context) process.env.OPENSPHERE_KUBE_CONTEXT = context;

  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'version' || command === '--version') return console.log('opensphere-setup 0.2.0-edge.1');

  if (command === 'resolve') {
    validateChannel(channel);
    const lock = await resolveChannel(channel);
    await writeLock(lockPath, lock);
    console.log(`[완료] ${channel} 채널을 ${lock.releaseDigest}로 잠금`);
    console.log(`Lock: ${lockPath}`);
    return;
  }

  if (command === 'bootstrap') {
    validateChannel(channel);
    const initialAdmin = validateInitialAdmin({
      username: option('--admin-username', 'opensphere-admin'),
      displayName: option('--admin-display-name', 'OpenSphere Administrator'),
      email: option('--admin-email', 'admin@opensphere.local')
    });
    assertKubectl();
    let lock;
    const installed = readInstallationLock();
    if (installed) {
      if (installed.channel !== channel) {
        throw new Error(`Cluster is installed from ${installed.channel}; ${channel} requires an explicit upgrade transaction`);
      }
      if (explicitLock) {
        const supplied = await readLock(lockPath);
        if (supplied.releaseDigest !== installed.releaseDigest) {
          throw new Error('Supplied lock differs from the cluster installation lock');
        }
      }
      lock = installed;
      console.log(`[재개] cluster release lock ${lock.releaseDigest}`);
    } else {
      const unmanaged = existingOpenSphereNamespaces();
      if (unmanaged.length) {
        throw new Error(`OpenSphere namespaces exist without an installation lock: ${unmanaged.join(', ')}`);
      }
      if (explicitLock) {
        lock = await readLock(lockPath);
        if (lock.channel !== channel) {
          throw new Error(`Supplied lock channel ${lock.channel} differs from requested channel ${channel}`);
        }
        console.log(`[사용] 명시적 release lock ${lock.releaseDigest}`);
      } else {
        lock = await resolveChannel(channel);
        await writeLock(lockPath, lock);
        console.log(`[완료] ${channel} 채널을 ${lock.releaseDigest}로 새로 잠금`);
      }
    }
    await bootstrap(lock, {
      initialAdmin,
      requireZeroRestarts: hasOption('--require-zero-restarts') || (!installed && !hasOption('--allow-restarts')),
      storageClass: option('--storage-class', undefined),
      openOnboarding: !hasOption('--no-open-browser')
    });
    return;
  }

  if (command === 'verify') {
    assertKubectl();
    const lock = readInstallationLock();
    if (!lock) throw new Error('No managed OpenSphere installation lock was found');
    const evidence = await verifyInstallation(lock, {
      requireZeroRestarts: hasOption('--require-zero-restarts')
    });
    console.log(`[완료] ${evidence.channel} ${evidence.releaseDigest} 검증`);
    console.log(`${evidence.podCount} pods / ${evidence.serviceCount} services / runtime images locked`);
    return;
  }

  if (command === 'refresh-lock') {
    throw new Error('refresh-lock is not supported; channel changes require an upgrade transaction');
  }

  if (command === 'status') {
    assertKubectl();
    kubectl(['get', 'pods', '-A', '-o', 'wide']);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[실패] ${error.message}`);
  process.exitCode = 1;
});
