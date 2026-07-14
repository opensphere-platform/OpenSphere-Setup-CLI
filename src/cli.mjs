#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootstrap, existingOpenSphereNamespaces, migrateLegacyInstallationLock, readInstallationLock, rotateServiceCredentials, upgrade } from './bootstrap.mjs';
import { installConsoleCli } from './install-cli.mjs';
import { installConsoleCliFromCluster } from './cluster-cli-install.mjs';
import { resolveChannel, validateChannel, validateLock } from './release.mjs';
import { assertKubectl, kubectl } from './process.mjs';
import { verifyInstallation } from './verify.mjs';
import { normalizeConsoleUrl } from './console-url.mjs';
import { selectAuthEnvironment } from './auth-environment.mjs';
import { assertReleaseShellTlsReference, parseShellTlsSecretRef } from './shell-tls.mjs';

function option(names, fallback) {
  const aliases = Array.isArray(names) ? names : [names];
  const matches = aliases
    .map((name) => ({ name, index: process.argv.indexOf(name) }))
    .filter(({ index }) => index >= 0);
  if (matches.length === 0) return fallback;
  if (matches.length > 1) throw new Error(`${aliases.join('/')} may only be specified once`);
  const [{ name, index }] = matches;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
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
  console.log(`OpenSphere Setup CLI 0.3.0-edge.1

Usage:
  opensphere-setup resolve --release <edge|candidate|stable> [--lock <file>]
  opensphere-setup bootstrap --release <channel> [--lock <verified-lock-file>]
  opensphere-setup bootstrap -r <channel> [--lock <verified-lock-file>]
      [--context <kube-context>] [--admin-username <name>]
       [--admin-display-name <name>] [--admin-email <email>]
       [--storage-class <name>] [--console <https-origin>]
       [--auth-environment <development|production>] [--backup-target-secret <namespace/name>]
       [--shell-tls-secret <namespace/name>]
       [--no-open-browser] [--onboarding-url-file <path>] [--add-to-path]
  opensphere-setup upgrade --release <edge|candidate|stable> [--lock <verified-lock-file>]
      [--context <kube-context>] [--storage-class <name>] [--console <https-origin>]
      [--backup-target-secret <namespace/name>] [--add-to-path]
  opensphere-setup verify [--context <kube-context>] [--console <https-origin>]
  opensphere-setup rotate-service-credentials [--context <kube-context>]
  opensphere-setup install-cli [--console <url>] [--install-dir <directory>]
      [--insecure-skip-tls-verify] [--add-to-path]
  opensphere-setup status
  opensphere-setup version

Fresh bootstrap resolves the selected channel at install time. Resume always uses the
cluster installation lock. --lock is an explicit immutable input; it is never a cache hint.
Kubernetes receives digest-pinned images only.`);
}

async function main() {
  const command = process.argv[2] ?? 'help';
  const channel = option(['--release', '-r'], 'stable');
  const lockPath = resolve(option('--lock', `.opensphere-setup/${channel}-release-lock.json`));
  const explicitLock = hasOption('--lock');
  const context = option('--context', '');
  const suppliedConsoleUrl = hasOption('--console') ? normalizeConsoleUrl(option('--console', '')) : undefined;
  const authEnvironment = hasOption('--auth-environment') ? option('--auth-environment', '') : undefined;
  if (context) process.env.OPENSPHERE_KUBE_CONTEXT = context;

  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'version' || command === '--version') return console.log('opensphere-setup 0.3.0-edge.1');

  if (command === 'install-cli') {
    const installed = await installConsoleCli({
      consoleUrl: suppliedConsoleUrl ?? 'https://localhost:8090',
      installDirectory: option('--install-dir', undefined),
      insecureSkipTlsVerify: hasOption('--insecure-skip-tls-verify'),
      updatePath: hasOption('--add-to-path')
    });
    console.log(`[완료] os ${installed.version} 무결성 검증 및 설치`);
    console.log(`Path: ${installed.target}`);
    if (!installed.pathUpdated) console.log('[안내] 현재 PATH는 변경하지 않았습니다. 원하면 다음 설치에서 --add-to-path를 지정하세요.');
    return;
  }

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
    const selectedAuthEnvironment = selectAuthEnvironment(channel, authEnvironment);
    const requestedShellTlsSecret = hasOption('--shell-tls-secret') ? option('--shell-tls-secret', '') : undefined;
    assertReleaseShellTlsReference(channel, requestedShellTlsSecret ? parseShellTlsSecretRef(requestedShellTlsSecret) : undefined);
    const initialAdmin = validateInitialAdmin({
      username: option('--admin-username', 'opensphere-admin'),
      displayName: option('--admin-display-name', 'OpenSphere Administrator'),
      email: option('--admin-email', 'admin@opensphere.local')
    });
    // Validate user input before touching the cluster. Besides providing a
    // clearer error, this keeps invalid bootstrap attempts side-effect free.
    const migrated = await migrateLegacyInstallationLock();
    if (migrated) console.log(`[마이그레이션] 기존 설치 잠금을 provenance 검증 후 ${migrated.releaseDigest}로 갱신`);
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
    const bootstrapResult = await bootstrap(lock, {
      initialAdmin,
      requireZeroRestarts: hasOption('--require-zero-restarts') || (!installed && !hasOption('--allow-restarts')),
      storageClass: option('--storage-class', undefined),
      consoleUrl: suppliedConsoleUrl ?? 'https://localhost:8090',
      authEnvironment: selectedAuthEnvironment,
      backupTargetSecret: hasOption('--backup-target-secret') ? option('--backup-target-secret', '') : undefined,
      shellTlsSecret: requestedShellTlsSecret,
      openOnboarding: !hasOption('--no-open-browser'),
      onboardingUrlFile: hasOption('--onboarding-url-file') ? option('--onboarding-url-file', '') : undefined
    });
    const installedCli = await installConsoleCliFromCluster({
      installDirectory: option('--install-dir', undefined),
      updatePath: hasOption('--add-to-path')
    });
    console.log(`[완료] Console-native os ${installedCli.version} 설치 (${installedCli.target})`);
    if (!installedCli.pathUpdated) console.log('[안내] 현재 PATH는 변경하지 않았습니다. 원하면 --add-to-path를 지정하세요.');
    return;
  }

  if (command === 'upgrade') {
    validateChannel(channel);
    assertKubectl();
    const migrated = await migrateLegacyInstallationLock();
    if (migrated) console.log(`[마이그레이션] 기존 설치 잠금을 provenance 검증 후 ${migrated.releaseDigest}로 갱신`);
    const installed = readInstallationLock();
    if (!installed) throw new Error('No managed OpenSphere installation lock was found');
    let target;
    if (explicitLock) {
      target = await readLock(lockPath);
      if (target.channel !== channel) throw new Error(`Supplied lock channel ${target.channel} differs from requested channel ${channel}`);
      console.log(`[사용] 명시적 target release lock ${target.releaseDigest}`);
    } else {
      target = await resolveChannel(channel);
      await writeLock(lockPath, target);
      console.log(`[완료] ${channel} target을 ${target.releaseDigest}로 잠금`);
    }
    const result = await upgrade(installed, target, {
      storageClass: option('--storage-class', undefined),
      consoleUrl: suppliedConsoleUrl,
      backupTargetSecret: hasOption('--backup-target-secret') ? option('--backup-target-secret', '') : undefined
    });
    const installedCli = await installConsoleCliFromCluster({
      installDirectory: option('--install-dir', undefined),
      updatePath: hasOption('--add-to-path')
    });
    console.log(result.changed ? '[완료] release upgrade 트랜잭션 검증' : '[재사용] 이미 요청 release가 설치됨');
    console.log(`[완료] Console-native os ${installedCli.version} 설치 (${installedCli.target})`);
    if (!installedCli.pathUpdated) console.log('[안내] 현재 PATH는 변경하지 않았습니다. 원하면 --add-to-path를 지정하세요.');
    return;
  }

  if (command === 'verify') {
    assertKubectl();
    const migrated = await migrateLegacyInstallationLock();
    if (migrated) console.log(`[마이그레이션] 기존 설치 잠금을 provenance 검증 후 ${migrated.releaseDigest}로 갱신`);
    const lock = readInstallationLock();
    if (!lock) throw new Error('No managed OpenSphere installation lock was found');
    const evidence = await verifyInstallation(lock, {
      requireZeroRestarts: hasOption('--require-zero-restarts'),
      consoleUrl: suppliedConsoleUrl
    });
    console.log(`[완료] ${evidence.channel} ${evidence.releaseDigest} 검증`);
    console.log(`${evidence.podCount} pods / ${evidence.serviceCount} services / runtime images locked`);
    return;
  }

  if (command === 'rotate-service-credentials') {
    assertKubectl();
    const migrated = await migrateLegacyInstallationLock();
    if (migrated) console.log(`[마이그레이션] 기존 설치 잠금을 provenance 검증 후 ${migrated.releaseDigest}로 갱신`);
    const result = await rotateServiceCredentials();
    console.log(`[완료] Console service credentials 회전 (${result.consoleUrl})`);
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
