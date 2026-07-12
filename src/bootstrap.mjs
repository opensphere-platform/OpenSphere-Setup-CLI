import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl, run } from './process.mjs';
import { preflight } from './preflight.mjs';
import { fetchWithRetry } from './http.mjs';
import { validateLock } from './release.mjs';
import { verifyInstallation } from './verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = 'https://raw.githubusercontent.com/opensphere-platform/OpenSphere-console';

const MANIFESTS = [
  { path: 'backend/identity/kanidm-image/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-kanidm:[^\\s]+', 'kanidm']] },
  { path: 'backend/backbone/bootstrap/backbone.yaml', replacements: [
    ['opensphere-backbone-postgres@sha256:[a-f0-9]+', 'cbsPostgresql'],
    ['opensphere-backbone-rustfs@sha256:[a-f0-9]+', 'cbsRustfs'],
    ['opensphere-backbone-gitea@sha256:[a-f0-9]+', 'cbsGitea']
  ] },
  { path: 'backend/dupa-control/backboneclaim-crd.yaml' },
  { path: 'backend/dupa-control/ui-plugin-crds.yaml' },
  { path: 'backend/dupa-control/dupa-trusted-keys.yaml' },
  { path: 'backend/dupa-control/opensphere-console-dupa-controller.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-dupa-controller:[^\\s]+', 'dupaController']] },
  { path: 'backend/opensphere-console-backend/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-backend:[^\\s]+', 'backend']] },
  { path: 'backend/identity/opensphere-console-auth/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-auth:[^\\s]+', 'auth']] },
  { path: 'backend/backbone/console-services.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-oaa-gateway:[^\\s]+', 'oaaGateway']] },
  { path: 'deploy/opensphere-console.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console:[^\\s]+', 'console']] }
];

function hex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function applyYaml(yaml) {
  kubectl(['apply', '-f', '-'], { capture: true, input: yaml });
}

function ensureNamespace(name) {
  const yaml = kubectl(['create', 'namespace', name, '--dry-run=client', '-o', 'yaml'], { capture: true });
  applyYaml(yaml);
}

function ensureGenericSecret(namespace, name, literals = {}, files = {}) {
  try {
    kubectl(['-n', namespace, 'get', 'secret', name], { capture: true });
    return;
  } catch {}
  const args = ['-n', namespace, 'create', 'secret', 'generic', name];
  for (const [key, value] of Object.entries(literals)) args.push(`--from-literal=${key}=${value}`);
  for (const [key, path] of Object.entries(files)) args.push(`--from-file=${key}=${path}`);
  args.push('--dry-run=client', '-o', 'yaml');
  applyYaml(kubectl(args, { capture: true }));
}

function ensureTlsSecret(namespace, name, cert, key) {
  try {
    kubectl(['-n', namespace, 'get', 'secret', name], { capture: true });
    return;
  } catch {}
  const yaml = kubectl([
    '-n', namespace, 'create', 'secret', 'tls', name,
    `--cert=${cert}`, `--key=${key}`, '--dry-run=client', '-o', 'yaml'
  ], { capture: true });
  applyYaml(yaml);
}

async function fetchManifest(lock, spec, storageClass) {
  const url = `${RAW_ROOT}/${lock.sourceRevision}/${spec.path}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`Manifest download failed (${spec.path}): HTTP ${response.status}`);
  let yaml = await response.text();
  for (const [pattern, component] of spec.replacements ?? []) {
    const image = lock.components[component].image;
    yaml = yaml.replace(new RegExp(pattern, 'g'), image);
  }
  yaml = yaml.replace(/storageClassName:\s*standard/g, `storageClassName: ${storageClass}`);
  for (const match of yaml.matchAll(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/gm)) {
    if (!/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(match[1])) {
      throw new Error(`Manifest ${spec.path} contains an ungoverned image reference: ${match[1]}`);
    }
  }
  return yaml;
}

function recordInstallationState(lock, storageClass, initialAdmin) {
  const config = {
    apiVersion: 'bootstrap.opensphere.io/v1alpha1',
    kind: 'OpenSphereInstallationConfig',
    channel: lock.channel,
    releaseDigest: lock.releaseDigest,
    storageClass,
    initialAdmin
  };
  const yaml = kubectl([
    '-n', 'opensphere-console', 'create', 'configmap', 'opensphere-installation-lock',
    `--from-literal=release.json=${JSON.stringify(lock)}`,
    `--from-literal=config.json=${JSON.stringify(config)}`,
    '--dry-run=client', '-o', 'yaml'
  ], { capture: true });
  applyYaml(yaml);
}

function recordInitialAdmin(initialAdmin) {
  const yaml = kubectl([
    '-n', 'opensphere-console', 'create', 'configmap', 'opensphere-initial-admin',
    `--from-literal=username=${initialAdmin.username}`,
    `--from-literal=displayName=${initialAdmin.displayName}`,
    `--from-literal=email=${initialAdmin.email}`,
    '--dry-run=client', '-o', 'yaml'
  ], { capture: true });
  applyYaml(yaml);
}

function readInitialAdmin() {
  const json = kubectl([
    '-n', 'opensphere-console', 'get', 'configmap', 'opensphere-initial-admin',
    '--ignore-not-found', '-o', 'json'
  ], { capture: true });
  if (!json) return null;
  const data = JSON.parse(json).data ?? {};
  if (!data.username || !data.displayName || !data.email) {
    throw new Error('Existing initial administrator metadata is incomplete');
  }
  return { username: data.username, displayName: data.displayName, email: data.email };
}

function readInstallationConfig() {
  const json = kubectl([
    '-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock',
    '--ignore-not-found', '-o', 'json'
  ], { capture: true });
  if (!json) return null;
  const raw = JSON.parse(json).data?.['config.json'];
  if (!raw) throw new Error('Existing installation config has no config.json');
  return JSON.parse(raw);
}

export function readInstallationLock() {
  const namespace = kubectl(['get', 'namespace', 'opensphere-console', '--ignore-not-found', '-o', 'name'], { capture: true });
  if (!namespace) return null;
  const json = kubectl([
    '-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock',
    '--ignore-not-found', '-o', 'json'
  ], { capture: true });
  if (!json) return null;
  const object = JSON.parse(json);
  const raw = object.data?.['release.json'];
  if (!raw) throw new Error('Existing installation lock has no release.json');
  return validateLock(JSON.parse(raw));
}

export function existingOpenSphereNamespaces() {
  return ['opensphere-console-auth', 'opensphere-console', 'opensphere-backbone']
    .filter((name) => kubectl(['get', 'namespace', name, '--ignore-not-found', '-o', 'name'], { capture: true }));
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function waitForForward(process, timeoutMs = 30_000) {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Kanidm bootstrap tunnel timed out')), timeoutMs);
    const inspect = (chunk) => {
      if (String(chunk).includes('Forwarding from 127.0.0.1:')) {
        clearTimeout(timer);
        resolveReady();
      }
    };
    process.stdout.on('data', inspect);
    process.stderr.on('data', inspect);
    process.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Kanidm bootstrap tunnel exited early (${code})`));
    });
  });
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

async function provisionInitialAdmin({ username, displayName, email }) {
  let serviceCredentialsExist = true;
  for (const name of ['opensphere-identity-kanidm', 'opensphere-rolemgr-kanidm']) {
    try { kubectl(['-n', 'opensphere-console', 'get', 'secret', name], { capture: true }); }
    catch { serviceCredentialsExist = false; }
  }

  const recovery = kubectl([
    '-n', 'opensphere-console-auth', 'exec', 'kanidm-0', '--',
    'kanidmd', 'recover-account', '-c', '/config/server.toml', 'idm_admin'
  ], { capture: true });
  const password = recovery.match(/new_password:\s*"([^"]+)"/)?.[1];
  if (!password) throw new Error('Kanidm recovery password was not returned');

  const port = await freePort();
  const forward = spawn('kubectl', [
    '-n', 'opensphere-console-auth', 'port-forward', 'svc/kanidm', `${port}:8443`, '--address', '127.0.0.1'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await waitForForward(forward);
    const provision = spawnSync(process.execPath, [join(HERE, 'provision-admin.mjs')], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        KANIDM_BOOTSTRAP_URL: `https://localhost:${port}`,
        KANIDM_ADMIN_PASSWORD: password,
        OPENSPHERE_INITIAL_ADMIN: username,
        OPENSPHERE_INITIAL_ADMIN_DISPLAY: displayName,
        OPENSPHERE_INITIAL_ADMIN_EMAIL: email,
        OPENSPHERE_SKIP_SERVICE_TOKENS: String(serviceCredentialsExist)
      }
    });
    if (provision.status !== 0) {
      throw new Error(`Initial admin provisioning failed: ${provision.stderr.trim()}`);
    }
    let result;
    try { result = JSON.parse(provision.stdout.trim()); }
    catch { throw new Error('Initial admin provisioning returned an invalid result'); }
    if (!result.onboardingRequired) {
      console.log('[재사용] Console service credential과 최초 관리자 credential이 이미 구성됨');
      return { onboardingUrl: null, serviceCredentialsCreated: false };
    }
    if (!result.resetToken) throw new Error('Initial admin reset token was not returned');
    console.log(serviceCredentialsExist
      ? '[재사용] Console service credential 유지, 최초 관리자 Wizard token 재발급'
      : '[완료] 최초 관리자와 Console service credential 구성');
    return {
      onboardingUrl: `https://localhost:8090/ui/reset?token=${encodeURIComponent(result.resetToken)}`,
      serviceCredentialsCreated: !serviceCredentialsExist
    };
  } finally {
    forward.kill();
  }
}

export async function bootstrap(lock, {
  keepTemporaryFiles = false,
  initialAdmin = {
    username: 'admin',
    displayName: 'OpenSphere Administrator',
    email: 'admin@opensphere.local'
  },
  requireZeroRestarts = true,
  storageClass,
  openOnboarding = true
} = {}) {
  validateLock(lock);
  const installed = readInstallationLock();
  const existingNamespaces = existingOpenSphereNamespaces();
  if (installed && installed.releaseDigest !== lock.releaseDigest) {
    throw new Error(`Existing installation is locked to ${installed.releaseDigest}; upgrade is a separate transaction`);
  }
  if (!installed && existingNamespaces.length) {
    throw new Error(`Unmanaged OpenSphere state exists without a release lock: ${existingNamespaces.join(', ')}`);
  }
  const storedConfig = installed ? readInstallationConfig() : null;
  if (installed && !storedConfig) throw new Error('Managed installation has no installation config');
  if (storedConfig?.releaseDigest !== installed?.releaseDigest) {
    throw new Error('Installation config differs from the cluster release lock');
  }
  if (storedConfig && storageClass && storedConfig.storageClass !== storageClass) {
    throw new Error(`Installation uses StorageClass ${storedConfig.storageClass}; changing it requires migration`);
  }
  const effectiveAdmin = installed ? (readInitialAdmin() ?? storedConfig.initialAdmin) : initialAdmin;
  const cluster = preflight({ storageClass: storedConfig?.storageClass ?? storageClass });
  const work = await mkdtemp(join(tmpdir(), 'opensphere-setup-'));
  try {
    console.log(`[완료] Kubernetes 연결 (${cluster.serverVersion}, ${cluster.nodeCount} nodes, StorageClass ${cluster.storageClass})`);
    for (const namespace of ['opensphere-console-auth', 'opensphere-console', 'opensphere-backbone']) ensureNamespace(namespace);
    recordInstallationState(lock, cluster.storageClass, effectiveAdmin);
    console.log(`[완료] ${lock.channel} release lock 기록 (${lock.releaseDigest})`);

    run('pwsh', ['-NoProfile', '-File', join(HERE, 'New-Certificates.ps1'), '-OutputDirectory', work]);
    const cert = join(work, 'tls.crt');
    const key = join(work, 'tls.key');
    const sig = join(work, 'sig.key');
    ensureTlsSecret('opensphere-console-auth', 'kanidm-tls', cert, key);
    ensureTlsSecret('opensphere-console', 'kanidm-tls', cert, key);
    ensureTlsSecret('opensphere-console', 'shell-tls', cert, key);
    // nginx currently addresses tls.crt while other consumers use the conventional ca.crt.
    // Publish the same trust anchor under both stable keys during the compatibility window.
    ensureGenericSecret('opensphere-console', 'opensphere-console-auth-ca', {}, { 'ca.crt': cert, 'tls.crt': cert });
    ensureGenericSecret('opensphere-console', 'opensphere-console-auth-sig', {}, { 'sig.key': sig });
    ensureGenericSecret('opensphere-backbone', 'backbone-postgres', { password: hex(32) });
    ensureGenericSecret('opensphere-backbone', 'backbone-rustfs', {
      access_key: `os${hex(10)}`,
      secret_key: hex(32),
      endpoint: 'http://backbone-rustfs.opensphere-backbone.svc.cluster.local:9000'
    });
    ensureGenericSecret('opensphere-backbone', 'backbone-gitea', {
      db_password: hex(32),
      admin_user: 'opensphere-admin',
      admin_password: hex(24)
    });
    console.log('[완료] Namespace와 bootstrap secret 준비');

    for (const spec of MANIFESTS) {
      const yaml = await fetchManifest(lock, spec, cluster.storageClass);
      const file = join(work, spec.path.replaceAll('/', '-'));
      await writeFile(file, yaml, 'utf8');
      applyYaml(yaml);
      console.log(`[완료] ${spec.path}`);
    }
    console.log('[대기] Kanidm과 CBS rollout');
    kubectl(['-n', 'opensphere-console-auth', 'rollout', 'status', 'statefulset/kanidm', '--timeout=360s']);
    const onboarding = await provisionInitialAdmin(effectiveAdmin);
    const onboardingUrl = onboarding.onboardingUrl;
    recordInitialAdmin(effectiveAdmin);
    if (onboarding.serviceCredentialsCreated) {
      kubectl(['-n', 'opensphere-console', 'rollout', 'restart', 'deployment/opensphere-console-auth', 'deployment/opensphere-console-backend']);
    }

    console.log('[대기] CBS와 Main Console rollout');
    for (const [namespace, resource, timeout] of [
      ['opensphere-backbone', 'deployment/backbone-postgres', '600s'],
      ['opensphere-backbone', 'statefulset/backbone-rustfs', '600s'],
      ['opensphere-backbone', 'deployment/backbone-gitea', '900s'],
      ['opensphere-console', 'deployment/opensphere-console-auth', '600s'],
      ['opensphere-console', 'deployment/opensphere-console-dupa-controller', '600s'],
      ['opensphere-console', 'deployment/opensphere-console-backend', '600s'],
      ['opensphere-backbone', 'deployment/opensphere-console-oaa-gateway', '600s'],
      ['opensphere-console', 'deployment/opensphere-console', '600s']
    ]) kubectl(['-n', namespace, 'rollout', 'status', resource, `--timeout=${timeout}`]);

    console.log('[검증] release lock, runtime image, Secret, 인증 및 Console endpoint');
    const evidence = await verifyInstallation(lock, { requireZeroRestarts });
    console.log(`[완료] OpenSphere Console ${lock.channel} 설치 검증 (${evidence.podCount} pods, ${evidence.serviceCount} services)`);
    if (onboardingUrl && openOnboarding) {
      openBrowser(onboardingUrl);
      console.log('[필요] 최초 관리자 Wizard가 브라우저에 열렸습니다. 비밀번호 설정 후 Console 로그인을 완료하세요.');
    } else if (onboardingUrl) {
      console.log('[완료] 최초 관리자 Wizard token이 생성됐으며 비대화형 검증을 위해 브라우저 열기는 생략했습니다.');
    }
    return { lock, evidence, onboardingUrl, temporaryDirectory: keepTemporaryFiles ? work : undefined };
  } finally {
    if (!keepTemporaryFiles) await rm(work, { recursive: true, force: true });
  }
}
