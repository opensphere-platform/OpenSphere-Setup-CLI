import { randomBytes, X509Certificate } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl, run } from './process.mjs';
import { preflight } from './preflight.mjs';
import { fetchWithRetry } from './http.mjs';
import { migrateLegacyReleaseLock, validateLock, verifyReleaseProvenance } from './release.mjs';
import { verifyInstallation } from './verify.mjs';
import { normalizeConsoleUrl } from './console-url.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = 'https://raw.githubusercontent.com/opensphere-platform/OpenSphere-console';
const RUSTFS_ENDPOINT = 'https://backbone-rustfs.opensphere-backbone.svc.cluster.local:9000';
const RUSTFS_DNS_NAME = 'backbone-rustfs.opensphere-backbone.svc.cluster.local';

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

const CORE_ROLLOUTS = [
  ['opensphere-console-auth', 'statefulset/kanidm', '360s'],
  ['opensphere-backbone', 'deployment/backbone-postgres', '600s'],
  ['opensphere-backbone', 'statefulset/backbone-rustfs', '600s'],
  ['opensphere-backbone', 'deployment/backbone-gitea', '900s'],
  ['opensphere-console', 'deployment/opensphere-console-auth', '600s'],
  ['opensphere-console', 'deployment/opensphere-console-dupa-controller', '600s'],
  ['opensphere-console', 'deployment/opensphere-console-backend', '600s'],
  ['opensphere-backbone', 'deployment/opensphere-console-oaa-gateway', '600s'],
  ['opensphere-console', 'deployment/opensphere-console', '600s']
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
  let existing = null;
  try {
    existing = JSON.parse(kubectl(['-n', namespace, 'get', 'secret', name, '-o', 'json'], { capture: true }));
  } catch {}
  // Never place a secret in a process argument (`kubectl --from-literal` is
  // observable by same-host processes). kubectl accepts JSON on stdin.
  const data = {};
  for (const [key, value] of Object.entries(literals)) data[key] = Buffer.from(String(value)).toString('base64');
  for (const [key, path] of Object.entries(files)) data[key] = readFileSync(path).toString('base64');
  const missing = Object.keys(data).some((key) => !existing?.data?.[key]);
  if (existing && !missing) return;
  // Preserve current credentials on resume/upgrade. This path only adds a newly
  // required public CA or schema key; explicit rotation owns credential changes.
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: existing?.type || 'Opaque',
    data: { ...(existing?.data || {}), ...Object.fromEntries(Object.entries(data).filter(([key]) => !existing?.data?.[key])) }
  })}\n`);
}

function ensureTlsSecret(namespace, name, cert, key, { replace = false } = {}) {
  try {
    kubectl(['-n', namespace, 'get', 'secret', name], { capture: true });
    if (!replace) return false;
  } catch {}
  const yaml = kubectl([
    '-n', namespace, 'create', 'secret', 'tls', name,
    `--cert=${cert}`, `--key=${key}`, '--dry-run=client', '-o', 'yaml'
  ], { capture: true });
  applyYaml(yaml);
  return true;
}

// Endpoint and protocol are release configuration, not a credential. Keep the
// keys that authenticate RustFS stable, while allowing a security upgrade from
// HTTP to the verified HTTPS endpoint on an existing installation.
function setSecretLiteral(namespace, name, key, value) {
  const existing = JSON.parse(kubectl(['-n', namespace, 'get', 'secret', name, '-o', 'json'], { capture: true }));
  const encoded = Buffer.from(String(value)).toString('base64');
  if (existing.data?.[key] === encoded) return false;
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: existing.type || 'Opaque',
    data: { ...(existing.data || {}), [key]: encoded }
  })}\n`);
  return true;
}

function readSecretSnapshot(namespace, name) {
  try {
    const secret = JSON.parse(kubectl(['-n', namespace, 'get', 'secret', name, '-o', 'json'], { capture: true }));
    return { namespace, name, exists: true, type: secret.type || 'Opaque', data: secret.data || {} };
  } catch {
    return { namespace, name, exists: false };
  }
}

function restoreSecretSnapshot(snapshot) {
  if (!snapshot.exists) {
    kubectl(['-n', snapshot.namespace, 'delete', 'secret', snapshot.name, '--ignore-not-found']);
    return;
  }
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1', kind: 'Secret', metadata: { name: snapshot.name, namespace: snapshot.namespace },
    type: snapshot.type, data: snapshot.data
  })}\n`);
}

function rustfsTlsNeedsUpgrade() {
  try {
    const secret = JSON.parse(kubectl(['-n', 'opensphere-backbone', 'get', 'secret', 'backbone-rustfs-tls', '-o', 'json'], { capture: true }));
    const pem = Buffer.from(secret.data?.['tls.crt'] ?? '', 'base64');
    const certificate = new X509Certificate(pem);
    return !certificate.subjectAltName.includes(`DNS:${RUSTFS_DNS_NAME}`);
  } catch {
    return true;
  }
}

function appendCertificateAuthority(namespace, name, caPath) {
  const secret = JSON.parse(kubectl(['-n', namespace, 'get', 'secret', name, '-o', 'json'], { capture: true }));
  const existing = Buffer.from(secret.data?.['ca.crt'] ?? '', 'base64').toString('utf8').trim();
  const incoming = readFileSync(caPath, 'utf8').trim();
  if (existing.includes(incoming)) return false;
  const bundled = [existing, incoming].filter(Boolean).join('\n');
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: secret.type || 'Opaque',
    data: { ...(secret.data || {}), 'ca.crt': Buffer.from(`${bundled}\n`).toString('base64') }
  })}\n`);
  return true;
}

// A legacy installation has no RustFS TLS secret. Add a dedicated leaf and
// append only its new CA to the existing trust bundle. This avoids replacing
// the current PostgreSQL/Kanidm trust root before the target release is proven.
async function prepareUpgradePrerequisites(consoleUrl) {
  const snapshots = [
    readSecretSnapshot('opensphere-backbone', 'backbone-rustfs'),
    readSecretSnapshot('opensphere-backbone', 'backbone-postgres'),
    readSecretSnapshot('opensphere-backbone', 'backbone-rustfs-tls')
  ];
  let changed = setSecretLiteral('opensphere-backbone', 'backbone-rustfs', 'endpoint', RUSTFS_ENDPOINT);
  if (!rustfsTlsNeedsUpgrade()) {
    return { changed, restore: () => snapshots.slice().reverse().forEach(restoreSecretSnapshot) };
  }

  let work;
  try {
    work = await mkdtemp(join(tmpdir(), 'opensphere-rustfs-tls-'));
    run('pwsh', [
      '-NoProfile', '-File', join(HERE, 'New-Certificates.ps1'), '-OutputDirectory', work,
      '-DnsNames', new URL(normalizeConsoleUrl(consoleUrl)).hostname
    ]);
    const cert = join(work, 'tls.crt');
    const key = join(work, 'tls.key');
    const ca = join(work, 'ca.crt');
    ensureGenericSecret('opensphere-backbone', 'backbone-postgres', {}, { 'ca.crt': ca });
    ensureTlsSecret('opensphere-backbone', 'backbone-rustfs-tls', cert, key, { replace: true });
    appendCertificateAuthority('opensphere-backbone', 'backbone-postgres', ca);
    changed = true;
    return { changed, restore: () => snapshots.slice().reverse().forEach(restoreSecretSnapshot) };
  } catch (error) {
    snapshots.slice().reverse().forEach(restoreSecretSnapshot);
    throw error;
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}

function validateAuthEnvironment(value) {
  if (!['development', 'production'].includes(value)) {
    throw new Error(`Unsupported authentication environment: ${value}`);
  }
  return value;
}

async function fetchManifest(lock, spec, storageClass, consoleUrl = 'https://localhost:8090', authEnvironment = 'development') {
  const url = `${RAW_ROOT}/${lock.sourceRevision}/${spec.path}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`Manifest download failed (${spec.path}): HTTP ${response.status}`);
  let yaml = await response.text();
  for (const [pattern, component] of spec.replacements ?? []) {
    const image = lock.components[component].image;
    yaml = yaml.replace(new RegExp(pattern, 'g'), image);
  }
  yaml = yaml.replace(/storageClassName:\s*standard/g, `storageClassName: ${storageClass}`);
  yaml = yaml.replaceAll('__OPENSPHERE_CONSOLE_URL__', normalizeConsoleUrl(consoleUrl));
  yaml = yaml.replaceAll('name: AUTH_ENVIRONMENT, value: "development"', `name: AUTH_ENVIRONMENT, value: "${validateAuthEnvironment(authEnvironment)}"`);
  if (yaml.includes('__OPENSPHERE_CONSOLE_URL__')) {
    throw new Error(`Manifest ${spec.path} has an unresolved Console URL placeholder`);
  }
  for (const match of yaml.matchAll(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/gm)) {
    if (!/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(match[1])) {
      throw new Error(`Manifest ${spec.path} contains an ungoverned image reference: ${match[1]}`);
    }
  }
  return yaml;
}

async function materializeRelease(lock, storageClass, consoleUrl, authEnvironment = 'development') {
  return Promise.all(MANIFESTS.map(async (spec) => ({
    path: spec.path,
    yaml: await fetchManifest(lock, spec, storageClass, consoleUrl, authEnvironment)
  })));
}

function applyRelease(release, label) {
  for (const manifest of release) {
    applyYaml(manifest.yaml);
    console.log(`[${label}] ${manifest.path}`);
  }
}

export function terminalPodError(pods) {
  const immediate = new Set(['CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName']);
  for (const pod of pods.items ?? []) {
    for (const status of pod.status?.containerStatuses ?? []) {
      const waiting = status.state?.waiting;
      if (waiting && immediate.has(waiting.reason)) {
        return `${pod.metadata?.name}/${status.name}: ${waiting.reason}${waiting.message ? ` (${waiting.message})` : ''}`;
      }
    }
  }
  return null;
}

function waitForCoreRollouts() {
  for (const [namespace, resource, timeout] of CORE_ROLLOUTS) {
    const seconds = Number.parseInt(timeout, 10);
    const deadline = Date.now() + (seconds * 1000);
    while (Date.now() < deadline) {
      try {
        kubectl(['-n', namespace, 'rollout', 'status', resource, '--timeout=15s'], { capture: true });
        break;
      } catch (rolloutError) {
        const workload = JSON.parse(kubectl(['-n', namespace, 'get', resource, '-o', 'json'], { capture: true }));
        const labels = workload.spec?.selector?.matchLabels ?? {};
        const selector = Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(',');
        const pods = JSON.parse(kubectl([
          '-n', namespace, 'get', 'pods', ...(selector ? ['-l', selector] : []), '-o', 'json'
        ], { capture: true }));
        const terminal = terminalPodError(pods);
        if (terminal) throw new Error(`${resource} has a terminal pod error: ${terminal}`);
        if (Date.now() >= deadline) throw rolloutError;
      }
    }
  }
}

// A healthy Deployment does not prove that the durable audit record can be
// recovered. Bootstrap therefore writes one recovery point and restores it into
// an ephemeral database. The restore source CronJob is permanently suspended.
function runBackboneRecoveryDrill() {
  const suffix = hex(5);
  const backupJob = `backbone-postgres-backup-bootstrap-${suffix}`;
  const restoreJob = `backbone-postgres-restore-drill-${suffix}`;
  kubectl(['-n', 'opensphere-backbone', 'create', 'job', backupJob, '--from=cronjob/backbone-postgres-backup']);
  kubectl(['-n', 'opensphere-backbone', 'wait', '--for=condition=complete', `job/${backupJob}`, '--timeout=900s']);
  kubectl(['-n', 'opensphere-backbone', 'create', 'job', restoreJob, '--from=cronjob/backbone-postgres-restore-drill']);
  kubectl(['-n', 'opensphere-backbone', 'wait', '--for=condition=complete', `job/${restoreJob}`, '--timeout=900s']);
  return { backupJob, restoreJob };
}

function recordInstallationState(lock, storageClass, initialAdmin, consoleUrl, authEnvironment = 'development') {
  const config = {
    apiVersion: 'bootstrap.opensphere.io/v1alpha1',
    kind: 'OpenSphereInstallationConfig',
    channel: lock.channel,
    releaseDigest: lock.releaseDigest,
    storageClass,
    consoleUrl: normalizeConsoleUrl(consoleUrl),
    authEnvironment: validateAuthEnvironment(authEnvironment),
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

function readStoredInstallationLock() {
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
  return JSON.parse(raw);
}

export function readInstallationLock() {
  const lock = readStoredInstallationLock();
  return lock ? validateLock(lock) : null;
}

// Persist a canonical trust root only after every already-installed legacy
// image has passed the same GitHub provenance check used for new channels.
export async function migrateLegacyInstallationLock() {
  const legacy = readStoredInstallationLock();
  if (!legacy || Object.hasOwn(legacy, 'trust')) return null;

  const migrated = migrateLegacyReleaseLock(legacy);
  await verifyReleaseProvenance(migrated);

  const config = readInstallationConfig();
  const initialAdmin = readInitialAdmin() ?? config?.initialAdmin;
  if (!config || !initialAdmin) {
    throw new Error('Legacy installation has incomplete metadata; trust migration is refused');
  }
  recordInstallationState(
    migrated,
    config.storageClass,
    initialAdmin,
    config.consoleUrl ?? 'https://localhost:8090',
    config.authEnvironment ?? 'development'
  );
  return migrated;
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

async function provisionInitialAdmin({ username, displayName, email }, consoleUrl, { rotateServiceCredentials = false, authEnvironment = 'development' } = {}) {
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
        OPENSPHERE_SKIP_SERVICE_TOKENS: String(serviceCredentialsExist && !rotateServiceCredentials),
        OPENSPHERE_SERVICE_TOKEN_TTL_DAYS: '30',
        OPENSPHERE_AUTH_ENVIRONMENT: validateAuthEnvironment(authEnvironment)
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
    console.log(rotateServiceCredentials
      ? '[완료] Console service credential 교체 및 만료일 갱신'
      : serviceCredentialsExist
        ? '[재사용] Console service credential 유지, 최초 관리자 Wizard token 재발급'
        : '[완료] 최초 관리자와 Console service credential 구성');
    return {
      onboardingUrl: `${normalizeConsoleUrl(consoleUrl)}/ui/reset?token=${encodeURIComponent(result.resetToken)}`,
      serviceCredentialsCreated: !serviceCredentialsExist
    };
  } finally {
    forward.kill();
  }
}

export async function rotateServiceCredentials() {
  const installed = readInstallationLock();
  if (!installed) throw new Error('No managed OpenSphere installation lock was found');
  const config = readInstallationConfig();
  const initialAdmin = readInitialAdmin() ?? config?.initialAdmin;
  if (!config || !initialAdmin) throw new Error('Managed installation has incomplete administrator metadata');
  const consoleUrl = normalizeConsoleUrl(config.consoleUrl ?? 'https://localhost:8090');
  const result = await provisionInitialAdmin(initialAdmin, consoleUrl, {
    rotateServiceCredentials: true,
    authEnvironment: config.authEnvironment ?? 'development'
  });
  kubectl(['-n', 'opensphere-console', 'rollout', 'restart', 'deployment/opensphere-console-auth', 'deployment/opensphere-console-backend']);
  kubectl(['-n', 'opensphere-console', 'rollout', 'status', 'deployment/opensphere-console-auth', '--timeout=300s']);
  kubectl(['-n', 'opensphere-console', 'rollout', 'status', 'deployment/opensphere-console-backend', '--timeout=300s']);
  return { consoleUrl, serviceCredentialsRotated: true, onboardingUrl: result.onboardingUrl ?? null };
}

export async function bootstrap(lock, {
  keepTemporaryFiles = false,
  initialAdmin = {
    username: 'opensphere-admin',
    displayName: 'OpenSphere Administrator',
    email: 'admin@opensphere.local'
  },
  requireZeroRestarts = true,
  storageClass,
  consoleUrl = 'https://localhost:8090',
  openOnboarding = true,
  requireRecoveryDrill = true,
  authEnvironment = 'development'
} = {}) {
  validateLock(lock);
  const requestedConsoleUrl = normalizeConsoleUrl(consoleUrl);
  const requestedAuthEnvironment = validateAuthEnvironment(authEnvironment);
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
  const storedConsoleUrl = storedConfig?.consoleUrl ?? 'https://localhost:8090';
  const effectiveConsoleUrl = normalizeConsoleUrl(installed ? storedConsoleUrl : requestedConsoleUrl);
  const effectiveAuthEnvironment = validateAuthEnvironment(storedConfig?.authEnvironment ?? requestedAuthEnvironment);
  if (installed && requestedConsoleUrl !== effectiveConsoleUrl) {
    throw new Error(`Installation uses Console URL ${effectiveConsoleUrl}; changing it requires an endpoint migration`);
  }
  if (installed && requestedAuthEnvironment !== effectiveAuthEnvironment) {
    throw new Error(`Installation uses authentication environment ${effectiveAuthEnvironment}; changing it requires an authentication migration`);
  }
  const effectiveAdmin = installed ? (readInitialAdmin() ?? storedConfig.initialAdmin) : initialAdmin;
  const cluster = preflight({ storageClass: storedConfig?.storageClass ?? storageClass });
  const work = await mkdtemp(join(tmpdir(), 'opensphere-setup-'));
  try {
    console.log(`[완료] Kubernetes 연결 (${cluster.serverVersion}, ${cluster.nodeCount} nodes, StorageClass ${cluster.storageClass})`);
    for (const namespace of ['opensphere-console-auth', 'opensphere-console', 'opensphere-backbone']) ensureNamespace(namespace);
    recordInstallationState(lock, cluster.storageClass, effectiveAdmin, effectiveConsoleUrl, effectiveAuthEnvironment);
    console.log(`[완료] ${lock.channel} release lock 기록 (${lock.releaseDigest})`);

    run('pwsh', [
      '-NoProfile', '-File', join(HERE, 'New-Certificates.ps1'), '-OutputDirectory', work,
      '-DnsNames', new URL(effectiveConsoleUrl).hostname
    ]);
    const cert = join(work, 'tls.crt');
    const key = join(work, 'tls.key');
    const ca = join(work, 'ca.crt');
    const sig = join(work, 'sig.key');
    ensureTlsSecret('opensphere-console-auth', 'kanidm-tls', cert, key);
    ensureTlsSecret('opensphere-console', 'kanidm-tls', cert, key);
    ensureTlsSecret('opensphere-console', 'shell-tls', cert, key);
    // The root is a real CA; TLS leaves are never treated as trust anchors.
    ensureGenericSecret('opensphere-console', 'opensphere-console-auth-ca', {}, { 'ca.crt': ca, 'tls.crt': cert });
    ensureGenericSecret('opensphere-console', 'opensphere-console-auth-sig', {}, { 'sig.key': sig });
    ensureGenericSecret('opensphere-backbone', 'backbone-postgres', {
      // `password` belongs to the constrained Console runtime role. PostgreSQL
      // initialisation uses a distinct bootstrap operator so Console can never
      // begin life as the database superuser.
      password: hex(32),
      bootstrap_password: hex(32)
    }, { 'ca.crt': ca });
    ensureTlsSecret('opensphere-backbone', 'backbone-postgres-tls', cert, key);
    ensureTlsSecret('opensphere-backbone', 'backbone-rustfs-tls', cert, key);
    ensureGenericSecret('opensphere-backbone', 'backbone-rustfs', {
      access_key: `os${hex(10)}`,
      secret_key: hex(32),
      endpoint: RUSTFS_ENDPOINT
    });
    setSecretLiteral('opensphere-backbone', 'backbone-rustfs', 'endpoint', RUSTFS_ENDPOINT);
    ensureGenericSecret('opensphere-backbone', 'backbone-gitea', {
      db_password: hex(32),
      admin_user: 'opensphere-admin',
      admin_password: hex(24)
    });
    console.log('[완료] Namespace와 bootstrap secret 준비');

    for (const spec of MANIFESTS) {
      const yaml = await fetchManifest(lock, spec, cluster.storageClass, effectiveConsoleUrl, effectiveAuthEnvironment);
      const file = join(work, spec.path.replaceAll('/', '-'));
      await writeFile(file, yaml, 'utf8');
      applyYaml(yaml);
      console.log(`[완료] ${spec.path}`);
    }
    console.log('[대기] Kanidm과 CBS rollout');
    kubectl(['-n', 'opensphere-console-auth', 'rollout', 'status', 'statefulset/kanidm', '--timeout=360s']);
    const onboarding = await provisionInitialAdmin(effectiveAdmin, effectiveConsoleUrl, { authEnvironment: effectiveAuthEnvironment });
    const onboardingUrl = onboarding.onboardingUrl;
    recordInitialAdmin(effectiveAdmin);
    if (onboarding.serviceCredentialsCreated) {
      kubectl(['-n', 'opensphere-console', 'rollout', 'restart', 'deployment/opensphere-console-auth', 'deployment/opensphere-console-backend']);
    }

    console.log('[대기] CBS와 Main Console rollout');
    // Kanidm was already awaited before administrator provisioning; waiting again
    // is harmless and keeps bootstrap/upgrade rollout coverage identical.
    waitForCoreRollouts();

    let recoveryDrill;
    if (requireRecoveryDrill) {
      console.log('[검증] Backbone PostgreSQL → RustFS backup 및 비파괴 restore drill');
      recoveryDrill = runBackboneRecoveryDrill();
      console.log(`[완료] recovery drill (${recoveryDrill.backupJob}, ${recoveryDrill.restoreJob})`);
    }

    console.log('[검증] release lock, runtime image, Secret, 인증 및 Console endpoint');
    const evidence = await verifyInstallation(lock, {
      requireZeroRestarts,
      consoleUrl: effectiveConsoleUrl,
      requireRecoveryDrill: Boolean(recoveryDrill)
    });
    console.log(`[완료] OpenSphere Console ${lock.channel} 설치 검증 (${evidence.podCount} pods, ${evidence.serviceCount} services)`);
    if (onboardingUrl && openOnboarding) {
      openBrowser(onboardingUrl);
      console.log('[필요] 최초 관리자 Wizard가 브라우저에 열렸습니다. 비밀번호 설정 후 Console 로그인을 완료하세요.');
    } else if (onboardingUrl) {
      console.log('[완료] 최초 관리자 Wizard token이 생성됐으며 비대화형 검증을 위해 브라우저 열기는 생략했습니다.');
    }
    return { lock, evidence, consoleUrl: effectiveConsoleUrl, onboardingUrl, temporaryDirectory: keepTemporaryFiles ? work : undefined };
  } finally {
    if (!keepTemporaryFiles) await rm(work, { recursive: true, force: true });
  }
}

export async function upgrade(previousLock, targetLock, { storageClass, consoleUrl, runtime = {} } = {}) {
  const operations = {
    readInstallationLock,
    readInstallationConfig,
    readInitialAdmin,
    materializeRelease,
    applyRelease,
    recordInstallationState,
    prepareUpgradePrerequisites,
    waitForCoreRollouts,
    runBackboneRecoveryDrill,
    verifyInstallation,
    ...runtime
  };
  validateLock(previousLock);
  validateLock(targetLock);
  const installed = operations.readInstallationLock();
  if (!installed || installed.releaseDigest !== previousLock.releaseDigest) {
    throw new Error('Cluster release lock changed before the upgrade transaction started');
  }
  const storedConfig = operations.readInstallationConfig();
  if (!storedConfig) throw new Error('Managed installation has no installation config');
  if (storageClass && storageClass !== storedConfig.storageClass) {
    throw new Error(`Installation uses StorageClass ${storedConfig.storageClass}; changing it requires migration`);
  }
  const effectiveConsoleUrl = normalizeConsoleUrl(storedConfig.consoleUrl ?? 'https://localhost:8090');
  const effectiveAuthEnvironment = validateAuthEnvironment(storedConfig.authEnvironment ?? 'development');
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== effectiveConsoleUrl) {
    throw new Error(`Installation uses Console URL ${effectiveConsoleUrl}; changing it requires an endpoint migration`);
  }
  if (previousLock.releaseDigest === targetLock.releaseDigest) {
    const evidence = await operations.verifyInstallation(previousLock, { requireZeroRestarts: false, consoleUrl: effectiveConsoleUrl });
    return { changed: false, lock: previousLock, consoleUrl: effectiveConsoleUrl, evidence };
  }

  const effectiveStorageClass = storedConfig.storageClass;
  const initialAdmin = operations.readInitialAdmin() ?? storedConfig.initialAdmin;
  if (!initialAdmin) throw new Error('Managed installation has no initial administrator metadata');

  // Both directions are downloaded and digest-policy checked before the first
  // cluster mutation. A registry/source outage therefore cannot strand rollback.
  console.log('[준비] 대상 release와 이전 release rollback manifest 검증');
  const [targetRelease, rollbackRelease] = await Promise.all([
    operations.materializeRelease(targetLock, effectiveStorageClass, effectiveConsoleUrl, effectiveAuthEnvironment),
    operations.materializeRelease(previousLock, effectiveStorageClass, effectiveConsoleUrl, effectiveAuthEnvironment)
  ]);

  let prerequisites;
  try {
    prerequisites = await operations.prepareUpgradePrerequisites(effectiveConsoleUrl);
    if (prerequisites.changed) console.log('[준비] 기존 설치에 RustFS TLS와 CA trust bundle 추가');
    operations.applyRelease(targetRelease, '업그레이드');
    operations.recordInstallationState(targetLock, effectiveStorageClass, initialAdmin, effectiveConsoleUrl, effectiveAuthEnvironment);
    console.log('[대기] 대상 release rollout');
    operations.waitForCoreRollouts();
    console.log('[검증] Backbone PostgreSQL → RustFS backup 및 비파괴 restore drill');
    const recoveryDrill = operations.runBackboneRecoveryDrill();
    const evidence = await operations.verifyInstallation(targetLock, {
      requireZeroRestarts: false, consoleUrl: effectiveConsoleUrl, requireRecoveryDrill: Boolean(recoveryDrill)
    });
    console.log(`[완료] ${previousLock.releaseDigest} → ${targetLock.releaseDigest}`);
    return { changed: true, lock: targetLock, consoleUrl: effectiveConsoleUrl, evidence };
  } catch (upgradeError) {
    console.error(`[롤백] upgrade 검증 실패: ${upgradeError.message}`);
    try {
      if (typeof prerequisites?.restore === 'function') prerequisites.restore();
      operations.applyRelease(rollbackRelease, '롤백');
      operations.recordInstallationState(previousLock, effectiveStorageClass, initialAdmin, effectiveConsoleUrl, effectiveAuthEnvironment);
      operations.waitForCoreRollouts();
      await operations.verifyInstallation(previousLock, { requireZeroRestarts: false, consoleUrl: effectiveConsoleUrl });
    } catch (rollbackError) {
      throw new Error(`Upgrade failed (${upgradeError.message}); rollback also failed (${rollbackError.message})`);
    }
    throw new Error(`Upgrade failed and the previous release was restored: ${upgradeError.message}`);
  }
}
