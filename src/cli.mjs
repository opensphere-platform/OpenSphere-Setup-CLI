#!/usr/bin/env node
import './portable-runtime.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootstrap, existingOpenSphereNamespaces, migrateLegacyInstallationLock, readInstallationLock, uninstallManagedInstallation, upgrade } from './bootstrap.mjs';
import { installConsoleCli } from './install-cli.mjs';
import { installConsoleCliFromCluster } from './cluster-cli-install.mjs';
import { normalizeRegistryCredentials, resolveChannel, validateChannel, validateLock } from './release.mjs';
import { assertKubectl, kubectl } from './process.mjs';
import { verifyInstallation } from './verify.mjs';
import { defaultConsoleUrl, normalizeConsoleUrl } from './console-url.mjs';
import { selectAuthEnvironment } from './auth-environment.mjs';
import { assertReleaseShellTlsReference, parseShellTlsSecretRef } from './shell-tls.mjs';
import { preflightPromotion } from './promotion-preflight.mjs';
import { resetInitialAdministrator } from './reset-initial-admin.mjs';
import { createProgressReporter, reportReleaseProgress } from './progress.mjs';
import {
  DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB,
  assertFreshConsolePortAvailable,
  formatLocalEnvironment,
  inspectLocalEnvironment
} from './doctor.mjs';
import { preflight } from './preflight.mjs';

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

async function registryCredentialsOption() {
  const fromStdin = hasOption('--registry-token-stdin');
  const hasUsername = hasOption('--registry-username');
  if (!fromStdin) {
    if (hasUsername) throw new Error('--registry-username requires --registry-token-stdin');
    return undefined;
  }
  if (!hasUsername) throw new Error('--registry-token-stdin requires --registry-username');
  if (process.stdin.isTTY) {
    throw new Error('--registry-token-stdin requires a pipe; do not enter a registry token as a visible command argument');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return normalizeRegistryCredentials({
    username: option('--registry-username', ''),
    token: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  });
}

function validateInitialAdmin(initialAdmin) {
  if (!/^[a-z][a-z0-9._-]{1,31}$/.test(initialAdmin.username)) {
    throw new Error('--admin-username must be 2-32 lowercase letters, numbers, dot, underscore or hyphen');
  }
  if (['anonymous'].includes(initialAdmin.username)) {
    throw new Error(`--admin-username ${initialAdmin.username} is reserved by Supabase Auth`);
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
  console.log(`OpenSphere Setup CLI 0.5.0-edge.2

Usage:
  opensphere-setup resolve --release <edge|candidate|stable> [--lock <file>]
      [--registry-username <github-login> --registry-token-stdin]
  opensphere-setup preflight --release <candidate|stable> --console <https-origin>
      --recovery-target-secret <namespace/name> --shell-tls-secret <namespace/name>
      [--context <kube-context>] [--storage-class <name>]
  opensphere-setup doctor --release <edge|candidate|stable>
      [--context <kube-context>] [--storage-class <name>]
      [--console <https-origin|loopback-http-origin>]
      [--registry-username <github-login> --registry-token-stdin]
  opensphere-setup bootstrap --release <channel> [--lock <verified-lock-file>]
  opensphere-setup bootstrap -r <channel> [--lock <verified-lock-file>]
      [--context <kube-context>] [--admin-username <name>]
       [--admin-display-name <name>] [--admin-email <email>]
       [--storage-class <name>] [--console <https-origin|loopback-http-origin>]
       [--auth-environment <development|production>]
       [--shell-tls-secret <namespace/name>]
       [--registry-username <github-login> --registry-token-stdin]
       [--no-open-browser] [--add-to-path]
  opensphere-setup upgrade --release <edge|candidate|stable> [--lock <verified-lock-file>]
      [--context <kube-context>] [--storage-class <name>] [--console <https-origin>]
      [--add-to-path] [--registry-username <github-login> --registry-token-stdin]
  opensphere-setup verify [--context <kube-context>] [--console <https-origin>]
  opensphere-setup reset-initial-admin --confirm RESET-INITIAL-ADMIN [--context <kube-context>]
  opensphere-setup uninstall --purge-data --confirm DELETE-OPENSPHERE [--context <kube-context>]
  opensphere-setup install-cli [--console <url>] [--install-dir <directory>]
      [--insecure-skip-tls-verify] [--add-to-path]
  opensphere-setup status
  opensphere-setup version

Fresh bootstrap resolves the selected channel at install time. Resume always uses the
cluster installation lock. --lock is an explicit immutable input; it is never a cache hint.
Kubernetes receives digest-pinned images only.`);
}

function readSecret(reference) {
  return JSON.parse(kubectl(['-n', reference.namespace, 'get', 'secret', reference.name, '-o', 'json'], { capture: true }));
}

function printPromotionPreflight(evidence) {
  console.log(`[완료] ${evidence.channel} 설치 전 읽기 전용 사전검증`);
  console.log(`Kubernetes ${evidence.kubernetesVersion} / ${evidence.nodeCount} nodes / StorageClass ${evidence.storageClass}`);
  console.log(`Recovery ${evidence.recovery.endpoint} bucket=${evidence.recovery.bucket} region=${evidence.recovery.region}`);
  console.log(`TLS ${evidence.tls.hostname} (${evidence.tls.profile}, expires ${evidence.tls.validTo})`);
  console.log(`Authentication policy: ${evidence.authEnvironment} (TOTP enforced)`);
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
  if (hasOption('--backup-target-secret')) {
    throw new Error('The retired --backup-target-secret option is not accepted; --recovery-target-secret is read-only preflight input');
  }

  if (command === 'help' || command === '--help' || command === '-h') return help();
  if (command === 'version' || command === '--version') return console.log('opensphere-setup 0.5.0-edge.2');

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
    const registryCredentials = await registryCredentialsOption();
    const lock = await resolveChannel(channel, { registryCredentials });
    await writeLock(lockPath, lock);
    console.log(`[완료] ${channel} 채널을 ${lock.releaseDigest}로 잠금`);
    console.log(`Lock: ${lockPath}`);
    return;
  }

  if (command === 'preflight') {
    validateChannel(channel);
    const evidence = preflightPromotion({
      channel,
      storageClass: option('--storage-class', undefined),
      consoleUrl: suppliedConsoleUrl,
      authEnvironment,
      recoveryTargetSecret: option('--recovery-target-secret', ''),
      shellTlsSecret: option('--shell-tls-secret', ''),
      readSecret
    });
    printPromotionPreflight(evidence);
    return;
  }

  if (command === 'doctor') {
    const progress = createProgressReporter();
    progress.begin(
      'OpenSphere 읽기 전용 설치 진단',
      `release=${channel}, context=${context || 'current'}`
    );
    progress.step('로컬 실행 환경 확인');
    validateChannel(channel);
    const registryCredentials = await registryCredentialsOption();
    const local = inspectLocalEnvironment();
    progress.done(formatLocalEnvironment(local));

    progress.step('Kubernetes API·노드·권한·StorageClass 확인');
    const cluster = preflight({
      storageClass: option('--storage-class', undefined),
      channel
    });
    progress.done(`${cluster.serverVersion}, ${cluster.nodeCount} nodes, StorageClass ${cluster.storageClass}`);
    const doctorConsoleUrl = suppliedConsoleUrl
      ?? defaultConsoleUrl(channel, selectAuthEnvironment(channel, authEnvironment));
    if (!readInstallationLock()) {
      progress.step('신규 설치 Console 포트 점유 확인', doctorConsoleUrl);
      const port = await assertFreshConsolePortAvailable(doctorConsoleUrl);
      progress.done(port.checked ? `${port.host}:${port.port} 사용 가능` : '원격 origin — 로컬 포트 검사 생략');
    }

    progress.step('Release BOM·이미지 provenance·SBOM 네트워크 검증', `channel=${channel}`);
    const lock = await resolveChannel(channel, {
      registryCredentials,
      onProgress: (event) => reportReleaseProgress(progress, event)
    });
    progress.done(lock.releaseDigest);
    progress.item(
      '용량',
      `PVC 요청 합계 ${DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB}Gi; 실제 여유 공간은 StorageClass 운영자가 별도 확인`
    );
    progress.item(
      'TLS',
      `${doctorConsoleUrl} 인증서 신뢰 상태는 설치 호스트에서 확인`
    );
    progress.finish('설치 전 진단 통과', '클러스터 변경 없음');
    return;
  }

  if (command === 'bootstrap') {
    const progress = createProgressReporter();
    progress.begin(
      'OpenSphere bootstrap',
      `release=${channel}, context=${context || 'current'}, console=${suppliedConsoleUrl ?? 'default'}`
    );
    progress.step('입력 옵션과 설치 정책 검증');
    validateChannel(channel);
    const registryCredentials = await registryCredentialsOption();
    const selectedAuthEnvironment = selectAuthEnvironment(channel, authEnvironment);
    const requestedShellTlsSecret = hasOption('--shell-tls-secret') ? option('--shell-tls-secret', '') : undefined;
    assertReleaseShellTlsReference(channel, requestedShellTlsSecret ? parseShellTlsSecretRef(requestedShellTlsSecret) : undefined);
    const initialAdmin = validateInitialAdmin({
      username: option('--admin-username', 'opensphere-admin'),
      displayName: option('--admin-display-name', 'OpenSphere Administrator'),
      email: option('--admin-email', 'admin@opensphere.local')
    });
    progress.done(`auth=${selectedAuthEnvironment}, registry=${registryCredentials ? 'explicit' : 'automatic'}`);
    progress.step('로컬 실행 환경 fail-fast 검증');
    const localEnvironment = inspectLocalEnvironment();
    progress.done(formatLocalEnvironment(localEnvironment));
    // Validate user input before touching the cluster. Besides providing a
    // clearer error, this keeps invalid bootstrap attempts side-effect free.
    progress.step('kubectl 및 Kubernetes API 연결 확인', `context=${context || 'current'}`);
    assertKubectl();
    progress.done('client와 server 응답 확인');
    progress.step('기존 OpenSphere 설치 상태와 release lock 확인');
    const migrated = await migrateLegacyInstallationLock();
    if (migrated) progress.item('마이그레이션', `기존 설치 잠금을 provenance 검증 후 ${migrated.releaseDigest}로 갱신`);
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
      progress.item('재개', `cluster release lock ${lock.releaseDigest}`);
      progress.done('관리형 설치 재개');
    } else {
      const unmanaged = existingOpenSphereNamespaces();
      if (unmanaged.length) {
        throw new Error(`OpenSphere namespaces exist without an installation lock: ${unmanaged.join(', ')}`);
      }
      const freshConsoleUrl = suppliedConsoleUrl
        ?? defaultConsoleUrl(channel, selectedAuthEnvironment);
      const port = await assertFreshConsolePortAvailable(freshConsoleUrl);
      if (port.checked) progress.item('포트', `${port.host}:${port.port} 사용 가능`);
      if (explicitLock) {
        lock = await readLock(lockPath);
        if (lock.channel !== channel) {
          throw new Error(`Supplied lock channel ${lock.channel} differs from requested channel ${channel}`);
        }
        progress.item('사용', `명시적 release lock ${lock.releaseDigest}`);
        progress.done('명시적 lock 사용');
      } else {
        progress.done('신규 설치 상태');
        progress.step(
          '릴리스 anchor, Release BOM 및 12개 이미지 공급망 검증',
          `channel=${channel}`
        );
        lock = await resolveChannel(channel, {
          registryCredentials,
          onProgress: (event) => reportReleaseProgress(progress, event)
        });
        await writeLock(lockPath, lock);
        progress.done(`${channel} → ${lock.releaseDigest}`);
        progress.item('잠금', `검증된 release lock 저장: ${lockPath}`);
      }
    }
    const bootstrapResult = await bootstrap(lock, {
      initialAdmin,
      requireZeroRestarts: hasOption('--require-zero-restarts') || (!installed && !hasOption('--allow-restarts')),
      storageClass: option('--storage-class', undefined),
      consoleUrl: suppliedConsoleUrl ?? defaultConsoleUrl(channel, selectedAuthEnvironment),
      authEnvironment: selectedAuthEnvironment,
      shellTlsSecret: requestedShellTlsSecret,
      openOnboarding: !hasOption('--no-open-browser'),
      registryCredentials,
      progress,
    });
    progress.step('Console-native os CLI 다운로드·무결성 검증·설치');
    const installedCli = await installConsoleCliFromCluster({
      consoleUrl: bootstrapResult.consoleUrl,
      installDirectory: option('--install-dir', undefined),
      updatePath: hasOption('--add-to-path')
    });
    progress.done(`${installedCli.version} → ${installedCli.target}`);
    if (!installedCli.pathUpdated) progress.item('안내', '현재 PATH는 변경하지 않았습니다. 원하면 다음 설치에서 --add-to-path를 지정하세요.');
    progress.finish('OpenSphere bootstrap 완료', bootstrapResult.consoleUrl);
    return;
  }

  if (command === 'upgrade') {
    validateChannel(channel);
    const registryCredentials = await registryCredentialsOption();
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
      target = await resolveChannel(channel, { registryCredentials });
      await writeLock(lockPath, target);
      console.log(`[완료] ${channel} target을 ${target.releaseDigest}로 잠금`);
    }
    const result = await upgrade(installed, target, {
      storageClass: option('--storage-class', undefined),
      consoleUrl: suppliedConsoleUrl,
      registryCredentials
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

  if (command === 'reset-initial-admin') {
    assertKubectl();
    const result = await resetInitialAdministrator({ confirmation: option('--confirm', '') });
    console.log(`[완료] 시험 관리자 ${result.username} 제거 및 최초 관리자 Wizard 재개방`);
    return;
  }

  if (command === 'uninstall') {
    // Namespace deletion can remove PVCs and audit evidence. Keep both the
    // destructive intent and the exact confirmation phrase in the CLI so a
    // missing/obsolete release lock can never trigger cleanup implicitly.
    if (!hasOption('--purge-data')) {
      throw new Error('uninstall is destructive; specify --purge-data --confirm DELETE-OPENSPHERE');
    }
    if (option('--confirm', '') !== 'DELETE-OPENSPHERE') {
      throw new Error('uninstall requires --confirm DELETE-OPENSPHERE');
    }
    assertKubectl();
    const result = await uninstallManagedInstallation();
    console.log(`[완료] OpenSphere ${result.releaseDigest} 제거: ${result.namespaces.length} namespaces, ${result.persistentVolumes.length} retained PVs, ${result.customResourceDefinitions.length} CRDs`);
    console.log('[주의] 외부 CA·S3 백업 Secret은 사용자가 소유한 namespace에 남겨 두었습니다.');
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
