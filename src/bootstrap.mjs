import { randomBytes, X509Certificate } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl, run } from './process.mjs';
import { preflight } from './preflight.mjs';
import { fetchWithRetry } from './http.mjs';
import { migrateLegacyReleaseLock, validateLock, verifyReleaseProvenance } from './release.mjs';
import { verifyInstallation } from './verify.mjs';
import {
  configureShellServiceEndpoint,
  defaultConsoleUrl,
  isLegacyEdgeLoopbackHttpOrigin,
  normalizeConsoleUrl
} from './console-url.mjs';
import { assertReleaseBackupTarget, backupTargetData, inspectBackupTarget, parseBackupTargetSecretRef } from './backup-target.mjs';
import { selectAuthEnvironment } from './auth-environment.mjs';
import {
  BACKUP_CRONJOB_RESOURCE,
  BACKUP_SCRIPTS_CONFIGMAP_RESOURCE,
  RESTORE_DRILL_CRONJOB_RESOURCE,
  BACKUP_ROLE_RECONCILE_RESOURCE,
  backupBoundaryFullyDedicated,
  buildBackupRoleReconcileManifests,
  buildCompatibilityOverlaySet,
  planBootstrapBackupBoundary
} from './backup-boundary.mjs';
import {
  EXTERNAL_SHELL_TLS_ANNOTATION,
  EXTERNAL_SHELL_TLS_PROFILE,
  assertReleaseShellTlsReference,
  inspectExternalShellTlsSecret,
  parseShellTlsSecretRef,
  shellTlsSecretData,
  shellTlsSecretRefText
} from './shell-tls.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = 'https://raw.githubusercontent.com/opensphere-platform/OpenSphere-console';
const RUSTFS_ENDPOINT = 'https://backbone-rustfs.opensphere-backbone.svc.cluster.local:9000';
const RUSTFS_DNS_NAME = 'backbone-rustfs.opensphere-backbone.svc.cluster.local';
const RELEASE_INVENTORY_CONFIGMAP = 'opensphere-release-inventory';
const PRUNABLE_MANIFEST_KINDS = new Set([
  'ClusterRole', 'ClusterRoleBinding', 'ConfigMap', 'CronJob', 'Deployment',
  'NetworkPolicy', 'PodDisruptionBudget', 'Role', 'RoleBinding', 'Service',
  'ServiceAccount', 'StatefulSet'
]);
export const MANAGED_NAMESPACES = Object.freeze([
  'opensphere-console-auth',
  'opensphere-console',
  'opensphere-backbone'
]);
export const MANAGED_CRDS = Object.freeze([
  'backboneclaims.backbone.opensphere.io',
  'uipluginpackages.plugins.opensphere.io',
  'uipluginregistrations.plugins.opensphere.io'
]);
export const MANAGED_CLUSTER_RBAC = Object.freeze([
  'clusterrolebinding/dupa-backbone-installer',
  'clusterrolebinding/dupa-module-profile-installer',
  'clusterrolebinding/opensphere-console-backend',
  'clusterrolebinding/opensphere-console-oaa-gateway-environment-reader',
  'clusterrole/dupa-backbone-installer',
  'clusterrole/opensphere-module-cluster-observer-v1',
  'clusterrole/opensphere-module-cluster-his-manager-v1',
  'clusterrole/opensphere-module-cluster-infrastructure-manager-v1',
  'clusterrole/dupa-module-profile-installer',
  'clusterrole/opensphere-console-backend',
  'clusterrole/opensphere-console-oaa-gateway-environment-reader'
]);

export const BASE_MANIFESTS = Object.freeze([
  { path: 'backend/identity/kanidm-image/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-kanidm:[^\\s]+', 'kanidm']] },
  { path: 'backend/backbone/bootstrap/backbone.yaml', replacements: [
    ['opensphere-backbone-postgres@sha256:[a-f0-9]+', 'cbsPostgresql'],
    ['opensphere-backbone-rustfs@sha256:[a-f0-9]+', 'cbsRustfs'],
    ['opensphere-backbone-gitea@sha256:[a-f0-9]+', 'cbsGitea']
  ] },
  // Only the canonical ghcr.io/opensphere-platform/opensphere-console-oaa-gateway
  // repository is matched; alternate registries/orgs/repos are intentionally
  // left unreplaced so the governed-image validator below rejects them. Both
  // branches stop at the first character outside a strict allow-list, so the
  // match cannot bleed into surrounding YAML quotes, comments, or whitespace:
  //   @sha256:<placeholder-or-hex>  -- e.g. the source's
  //       __OAA_GATEWAY_IMAGE_DIGEST__ placeholder, or a real historical
  //       @sha256:<64hex> digest from a previously signed release.
  //   :<tag>                        -- e.g. a historical signed release's
  //       mutable-tag reference such as :2.0.0-rc.1.
  { path: 'backend/backbone/console-services.yaml', replacements: [
    ['ghcr\\.io/opensphere-platform/opensphere-console-oaa-gateway(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'oaaGateway']
  ] },
  { path: 'backend/dupa-control/backboneclaim-crd.yaml' },
  { path: 'backend/dupa-control/ui-plugin-crds.yaml' },
  { path: 'backend/dupa-control/dupa-trusted-keys.yaml' },
  { path: 'backend/dupa-control/opensphere-console-dupa-controller.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-dupa-controller:[^\\s]+', 'dupaController']] },
  { path: 'backend/opensphere-console-backend/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-backend:[^\\s]+', 'backend']] },
  { path: 'backend/identity/opensphere-console-auth/deploy.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console-auth:[^\\s]+', 'auth']] },
  { path: 'deploy/opensphere-console.yaml', replacements: [['ghcr.io/opensphere-platform/opensphere-console:[^\\s]+', 'console']] }
]);

const CORE_ROLLOUTS = [
  ['opensphere-console-auth', 'statefulset/kanidm', '360s'],
  ['opensphere-backbone', 'deployment/backbone-postgres', '600s'],
  ['opensphere-backbone', 'statefulset/backbone-rustfs', '600s'],
  ['opensphere-backbone', 'deployment/backbone-gitea', '900s'],
  ['opensphere-backbone', 'deployment/opensphere-console-oaa-gateway', '600s'],
  ['opensphere-console', 'deployment/opensphere-console-auth', '600s'],
  ['opensphere-console', 'deployment/opensphere-console-dupa-controller', '600s'],
  ['opensphere-console', 'deployment/opensphere-console-backend', '600s'],
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

// Pure merge: existing Secret data always wins. Only keys absent from
// `existingData` are taken from `candidateData`, so a value generated fresh on
// every invocation (e.g. `hex(32)`) is applied once on creation and never
// rotates an already-installed credential on a resume/upgrade re-run.
// Exported (rather than inlined) so preservation semantics can be asserted
// directly against representative fixtures instead of via source-text
// pattern matching alone.
export function mergeSecretData(existingData = {}, candidateData = {}) {
  return {
    ...existingData,
    ...Object.fromEntries(Object.entries(candidateData).filter(([key]) => !existingData?.[key]))
  };
}

// Returns true when the Secret was created or a previously-absent key was added, false when
// every requested key was already present (a pure no-op). Callers that must restart consumers
// after a credential first becomes available (e.g. a Deployment env var sourced from a
// secretKeyRef, which Kubernetes never live-refreshes) rely on this to decide whether a restart
// is required.
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
  if (existing && !missing) return false;
  // Preserve current credentials on resume/upgrade. This path only adds a newly
  // required public CA or schema key; explicit rotation owns credential changes.
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: existing?.type || 'Opaque',
    data: mergeSecretData(existing?.data, data)
  })}\n`);
  return true;
}

function readSecret(namespace, name) {
  return JSON.parse(kubectl(['-n', namespace, 'get', 'secret', name, '-o', 'json'], { capture: true }));
}

function readConfigMap(namespace, name) {
  return JSON.parse(kubectl(['-n', namespace, 'get', 'configmap', name, '-o', 'json'], { capture: true }));
}

// Backup credentials are carried as Kubernetes Secret data on stdin.  Do not
// use --from-literal: process listings and captured command errors must never
// disclose an external backup credential.
function prepareBackupTarget(channel, sourceRef) {
  const snapshot = readSecretSnapshot('opensphere-backbone', 'backbone-postgres-backup-target');
  let source;
  if (sourceRef) {
    source = readSecret(sourceRef.namespace, sourceRef.name);
  } else {
    // Edge keeps the historical in-cluster RustFS destination, but writes the
    // complete generic S3 contract. RustFS credentials and the CBS CA live in
    // separate Secrets, so compose their public contract without exposing a
    // value on argv or stdout.
    const rustfs = readSecret('opensphere-backbone', 'backbone-rustfs');
    const postgres = readSecret('opensphere-backbone', 'backbone-postgres');
    source = {
      data: {
        ...rustfs.data,
        bucket: Buffer.from('backups').toString('base64'),
        region: Buffer.from('us-east-1').toString('base64'),
        'ca.crt': postgres.data?.['ca.crt']
      }
    };
  }
  const target = assertReleaseBackupTarget(inspectBackupTarget(source), channel);
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1', kind: 'Secret', metadata: { name: 'backbone-postgres-backup-target', namespace: 'opensphere-backbone' },
    type: 'Opaque', data: backupTargetData(source)
  })}\n`);
  return {
    mode: target.inCluster ? 'in-cluster-rustfs' : 'external-s3',
    endpoint: target.endpoint,
    bucket: target.bucket,
    // A failed channel upgrade must not leave an external backup endpoint
    // configured for a release that has rolled back. Bootstrap intentionally
    // retains the target, while upgrade invokes this restore after rollback.
    restore: () => restoreSecretSnapshot(snapshot)
  };
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

function ensureExternalShellTlsSecret(sourceRef, source) {
  const namespace = 'opensphere-console';
  const name = 'shell-tls';
  const expectedData = shellTlsSecretData(source);
  const expectedAnnotations = {
    [EXTERNAL_SHELL_TLS_ANNOTATION]: EXTERNAL_SHELL_TLS_PROFILE,
    'opensphere.io/source-secret': shellTlsSecretRefText(sourceRef)
  };
  try {
    const existing = readSecret(namespace, name);
    const unchanged = existing.type === 'kubernetes.io/tls'
      && Object.entries(expectedData).every(([key, value]) => existing.data?.[key] === value)
      && Object.entries(expectedAnnotations).every(([key, value]) => existing.metadata?.annotations?.[key] === value);
    if (!unchanged) {
      throw new Error('Existing shell-tls differs from the configured external TLS source; certificate rotation requires an explicit endpoint migration');
    }
    return false;
  } catch (error) {
    if (!String(error.message).startsWith('Existing shell-tls differs')) {
      applyYaml(`${JSON.stringify({
        apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace, annotations: expectedAnnotations },
        type: 'kubernetes.io/tls', data: expectedData
      })}\n`);
      return true;
    }
    throw error;
  }
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

function assertPostgresUpgradeBoundary() {
  const consoleSuperuser = kubectl([
    '-n', 'opensphere-backbone', 'exec', 'deployment/backbone-postgres', '--',
    'psql', '-U', 'console', '-d', 'console', '-Atc',
    "SELECT rolsuper FROM pg_roles WHERE rolname = 'console'"
  ], { capture: true });
  // PostgreSQL 19 protects the original bootstrap superuser from self-demotion.
  // An installer must not claim a P0 audit boundary after such a partial
  // migration; a fresh setup (or an explicit future data migration) is needed.
  if (consoleSuperuser === 't') {
    throw new Error('Existing PostgreSQL uses console as the cluster bootstrap superuser; in-place upgrade is refused. Bootstrap a fresh OpenSphere edge installation or use an explicit data migration.');
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

function tlsSecretNeedsDnsName(namespace, name, dnsName) {
  try {
    const secret = JSON.parse(kubectl(['-n', namespace, 'get', 'secret', name, '-o', 'json'], { capture: true }));
    const pem = Buffer.from(secret.data?.['tls.crt'] ?? '', 'base64');
    const certificate = new X509Certificate(pem);
    return !certificate.subjectAltName.includes(`DNS:${dnsName}`);
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

// The OAA gateway Deployment in opensphere-backbone mounts opensphere-backbone/
// opensphere-console-auth-ca as its trust anchor (console-services.yaml), but
// Setup has historically only maintained the Console-namespace copy. Mirror
// only the public ca.crt -- never a private key or leaf certificate -- via
// Kubernetes JSON on stdin so the trust anchor is never observable on argv or
// in a captured command log. Unrelated keys already present on the target
// Secret are preserved; only ca.crt is added or updated.
function mirrorConsoleAuthCaToBackbone() {
  const source = readSecret('opensphere-console', 'opensphere-console-auth-ca');
  const sourceCa = source.data?.['ca.crt'];
  if (!sourceCa) throw new Error('opensphere-console/opensphere-console-auth-ca has no ca.crt to mirror');
  let existing = null;
  try {
    existing = readSecret('opensphere-backbone', 'opensphere-console-auth-ca');
  } catch {}
  if (existing?.data?.['ca.crt'] === sourceCa) return false;
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'opensphere-console-auth-ca', namespace: 'opensphere-backbone' },
    type: existing?.type || 'Opaque',
    data: { ...(existing?.data || {}), 'ca.crt': sourceCa }
  })}\n`);
  return true;
}

// A legacy installation may lack CBS TLS leaves. Add only the required new
// leaves and append their CA to the existing PostgreSQL trust bundle, without
// replacing the current PostgreSQL/Kanidm trust root before target verification.
async function prepareUpgradePrerequisites(consoleUrl) {
  const snapshots = [
    readSecretSnapshot('opensphere-backbone', 'backbone-rustfs'),
    readSecretSnapshot('opensphere-backbone', 'backbone-postgres'),
    readSecretSnapshot('opensphere-backbone', 'backbone-postgres-tls'),
    readSecretSnapshot('opensphere-backbone', 'backbone-rustfs-tls'),
    readSecretSnapshot('opensphere-console', 'opensphere-console-auth-ca'),
    readSecretSnapshot('opensphere-backbone', 'opensphere-console-auth-ca')
  ];
  let changed = setSecretLiteral('opensphere-backbone', 'backbone-rustfs', 'endpoint', RUSTFS_ENDPOINT);
  // Mirror the OAA gateway's CA trust anchor unconditionally: an installation
  // that predates the Backbone-namespace mount must not stay unschedulable
  // just because its existing CBS TLS leaves need no migration.
  if (mirrorConsoleAuthCaToBackbone()) changed = true;
  // A legacy/pre-OAA installation may lack the dedicated opensphere_oaa credential.
  // console-services.yaml/backbone.yaml (CONSTITUTION-0004 §4.5 OAA bootstrap boundary) both
  // require backbone-postgres/oaa_password to exist before applyRelease's Backbone boundary
  // reconcile Job runs -- so this must be added here unconditionally, not only when a TLS DNS
  // name migration also happens to be needed below. ensureGenericSecret only adds the key when
  // absent; an already-installed OAA credential is never rotated by an upgrade.
  if (ensureGenericSecret('opensphere-backbone', 'backbone-postgres', { oaa_password: hex(32) }, {})) {
    changed = true;
  }
  // A legacy/pre-backup-role installation may lack the dedicated opensphere_backup
  // credential. backbone.yaml's init/reconcile provisioning and the backup CronJob
  // all require backbone-postgres/backup_password before applyRelease's Backbone
  // boundary reconcile Job runs, so backfill it here unconditionally (same rationale
  // as oaa_password above). ensureGenericSecret only adds the key when absent; an
  // already-installed backup credential is never rotated by an upgrade.
  if (ensureGenericSecret('opensphere-backbone', 'backbone-postgres', { backup_password: hex(32) }, {})) {
    changed = true;
  }
  const needsPostgresTls = tlsSecretNeedsDnsName('opensphere-backbone', 'backbone-postgres-tls', 'backbone-postgres.opensphere-backbone.svc.cluster.local');
  const needsRustfsTls = tlsSecretNeedsDnsName('opensphere-backbone', 'backbone-rustfs-tls', RUSTFS_DNS_NAME);
  if (!needsPostgresTls && !needsRustfsTls) {
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
    // Legacy installations lack the separate bootstrap operator credential.
    // Add it only when absent; the existing Console runtime password is never
    // rotated as part of an upgrade.
    ensureGenericSecret('opensphere-backbone', 'backbone-postgres', { bootstrap_password: hex(32) }, { 'ca.crt': ca });
    if (needsPostgresTls) ensureTlsSecret('opensphere-backbone', 'backbone-postgres-tls', cert, key, { replace: true });
    if (needsRustfsTls) ensureTlsSecret('opensphere-backbone', 'backbone-rustfs-tls', cert, key, { replace: true });
    appendCertificateAuthority('opensphere-backbone', 'backbone-postgres', ca);
    // DUPA uses the Console trust bundle for both Kanidm and Backbone service
    // calls. Keep the existing Kanidm CA and append the CBS CA so HTTPS S3
    // verification never falls back to plaintext on an upgraded installation.
    appendCertificateAuthority('opensphere-console', 'opensphere-console-auth-ca', ca);
    changed = true;
    return { changed, restore: () => snapshots.slice().reverse().forEach(restoreSecretSnapshot) };
  } catch (error) {
    snapshots.slice().reverse().forEach(restoreSecretSnapshot);
    throw error;
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}

function restartBackboneTrustConsumers() {
  // Secret volumes update asynchronously and Node TLS contexts are loaded at
  // process start. A retry after a partially-applied release must therefore
  // refresh the consumers rather than waiting forever on their old CA bundle.
  // The OAA gateway consumer runs in opensphere-backbone, not
  // opensphere-console; do not assume a single namespace for all consumers.
  for (const [namespace, deployment] of [
    ['opensphere-console', 'opensphere-console-dupa-controller'],
    ['opensphere-console', 'opensphere-console-auth'],
    ['opensphere-console', 'opensphere-console-backend'],
    ['opensphere-console', 'opensphere-console'],
    ['opensphere-backbone', 'opensphere-console-oaa-gateway']
  ]) {
    kubectl(['-n', namespace, 'rollout', 'restart', `deployment/${deployment}`]);
  }
}

function validateAuthEnvironment(value) {
  return selectAuthEnvironment('edge', value);
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
  const normalizedConsoleUrl = normalizeConsoleUrl(consoleUrl);
  yaml = yaml.replaceAll('__OPENSPHERE_CONSOLE_URL__', normalizedConsoleUrl);
  yaml = configureShellServiceEndpoint(yaml, normalizedConsoleUrl);
  yaml = yaml.replaceAll('__OPENSPHERE_RELEASE_REVISION__', lock.sourceRevision);
  yaml = yaml.replaceAll('name: AUTH_ENVIRONMENT, value: "development"', `name: AUTH_ENVIRONMENT, value: "${validateAuthEnvironment(authEnvironment)}"`);
  if (yaml.includes('__OPENSPHERE_CONSOLE_URL__') || yaml.includes('__OPENSPHERE_RELEASE_REVISION__')) {
    throw new Error(`Manifest ${spec.path} has an unresolved Setup placeholder`);
  }
  for (const match of yaml.matchAll(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/gm)) {
    if (!/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(match[1])) {
      throw new Error(`Manifest ${spec.path} contains an ungoverned image reference: ${match[1]}`);
    }
  }
  return yaml;
}

async function materializeRelease(lock, storageClass, consoleUrl, authEnvironment = 'development') {
  return Promise.all(BASE_MANIFESTS.map(async (spec) => ({
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

function inventoryKey(resource) {
  return [resource.apiVersion, resource.kind, resource.namespace ?? '', resource.name].join('|');
}

// Use kubectl's client-side YAML decoder instead of a second YAML parser. The
// operation is dry-run only and records no last-applied state in the cluster.
// Secrets, PVCs, CRDs and namespaces are intentionally excluded: their
// lifecycle requires explicit migration or destructive user confirmation.
function releaseResourceInventory(release) {
  const inventory = new Map();
  for (const manifest of release) {
    const decoded = JSON.parse(kubectl([
      'apply', '--dry-run=client', '--validate=false', '-f', '-', '-o', 'json'
    ], { capture: true, input: manifest.yaml }));
    const items = decoded.kind === 'List' ? decoded.items ?? [] : [decoded];
    for (const item of items) {
      const kind = String(item.kind ?? '');
      const name = String(item.metadata?.name ?? '');
      if (!PRUNABLE_MANIFEST_KINDS.has(kind) || !name) continue;
      const resource = {
        apiVersion: String(item.apiVersion ?? ''),
        kind,
        name,
        ...(item.metadata?.namespace ? { namespace: String(item.metadata.namespace) } : {})
      };
      inventory.set(inventoryKey(resource), resource);
    }
  }
  return [...inventory.values()].sort((left, right) => inventoryKey(left).localeCompare(inventoryKey(right)));
}

function readReleaseInventory() {
  try {
    const configMap = readConfigMap('opensphere-console', RELEASE_INVENTORY_CONFIGMAP);
    const raw = configMap.data?.['resources.json'];
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((resource) =>
      !PRUNABLE_MANIFEST_KINDS.has(resource?.kind) || !resource?.name || !resource?.apiVersion)) {
      throw new Error('stored release inventory is invalid');
    }
    return parsed;
  } catch (error) {
    if (/not found/i.test(String(error.message))) return null;
    throw error;
  }
}

function recordReleaseInventory(lock, inventory) {
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: RELEASE_INVENTORY_CONFIGMAP, namespace: 'opensphere-console' },
    data: {
      'release-digest': lock.releaseDigest,
      'resources.json': JSON.stringify(inventory)
    }
  })}\n`);
}

function pruneReleaseResources(fromInventory, targetInventory) {
  const target = new Set(targetInventory.map(inventoryKey));
  for (const resource of fromInventory) {
    if (target.has(inventoryKey(resource))) continue;
    kubectl([
      ...(resource.namespace ? ['-n', resource.namespace] : []),
      'delete', `${resource.kind}/${resource.name}`, '--ignore-not-found', '--wait=true'
    ]);
  }
}

export function terminalPodError(pods) {
  const immediate = new Set(['CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName']);
  const unrecoverableImagePull = /manifest unknown|not found|pull access denied|repository .* does not exist|authorization failed/i;
  for (const pod of pods.items ?? []) {
    for (const status of pod.status?.containerStatuses ?? []) {
      const waiting = status.state?.waiting;
      if (waiting && immediate.has(waiting.reason)) {
        return `${pod.metadata?.name}/${status.name}: ${waiting.reason}${waiting.message ? ` (${waiting.message})` : ''}`;
      }
      if (waiting && ['ErrImagePull', 'ImagePullBackOff'].includes(waiting.reason) && unrecoverableImagePull.test(String(waiting.message ?? ''))) {
        return `${pod.metadata?.name}/${status.name}: ${waiting.reason} (${waiting.message})`;
      }
    }
  }
  return null;
}

function terminalPodEventError(namespace, pods) {
  for (const pod of pods.items ?? []) {
    const events = JSON.parse(kubectl([
      '-n', namespace, 'get', 'events', '--field-selector', `involvedObject.name=${pod.metadata?.name}`,
      '-o', 'json'
    ], { capture: true }));
    for (const event of events.items ?? []) {
      if (event.type !== 'Warning' || event.reason !== 'FailedMount') continue;
      const match = String(event.message ?? '').match(/secret "([^"]+)" not found/);
      if (!match) continue;
      // Kubernetes retains FailedMount events after the referenced Secret has
      // been restored. Treat the condition, not its historical event, as the
      // terminal signal. Otherwise a retry can undo a repaired prerequisite
      // before kubelet has a chance to mount it.
      try {
        kubectl(['-n', namespace, 'get', 'secret', match[1]], { capture: true });
      } catch {
        return `${pod.metadata?.name}: ${event.message}`;
      }
    }
  }
  return null;
}

// Ordered StatefulSets do not replace an unready Pod from a rejected target
// revision. During rollback that can strand the previous template behind the
// target Pod indefinitely. Deleting only Pods whose controller revision differs
// from the now-desired revision is safe: the StatefulSet recreates the exact
// rollback template and keeps its PVC intact.
function reconcileRollbackStatefulSets() {
  for (const [namespace, resource] of CORE_ROLLOUTS) {
    if (!resource.startsWith('statefulset/')) continue;
    const workload = JSON.parse(kubectl(['-n', namespace, 'get', resource, '-o', 'json'], { capture: true }));
    const desiredRevision = workload.status?.updateRevision;
    if (!desiredRevision) continue;
    const selector = Object.entries(workload.spec?.selector?.matchLabels ?? {})
      .map(([key, value]) => `${key}=${value}`).join(',');
    if (!selector) continue;
    const pods = JSON.parse(kubectl(['-n', namespace, 'get', 'pods', '-l', selector, '-o', 'json'], { capture: true }));
    for (const pod of pods.items ?? []) {
      if (pod.metadata?.labels?.['controller-revision-hash'] === desiredRevision) continue;
      kubectl(['-n', namespace, 'delete', 'pod', pod.metadata.name, '--wait=false']);
    }
  }
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
        const terminalEvent = terminalPodEventError(namespace, pods);
        if (terminalEvent) throw new Error(`${resource} has a terminal pod error: ${terminalEvent}`);
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
  waitForJobCompletion('opensphere-backbone', backupJob);
  kubectl(['-n', 'opensphere-backbone', 'create', 'job', restoreJob, '--from=cronjob/backbone-postgres-restore-drill']);
  waitForJobCompletion('opensphere-backbone', restoreJob);
  return { backupJob, restoreJob };
}

// `kubectl wait --for=condition=complete` ignores a Job's Failed condition and
// therefore consumed the full 15-minute recovery timeout after a deterministic
// restore error. Poll both terminal conditions so bootstrap and CI fail immediately,
// and include the pod log in the error without leaking it on a successful path.
export function waitForJobCompletion(namespace, jobName, {
  timeoutMs = 900_000,
  intervalMs = 2_000,
  kubectlFn = kubectl,
  now = Date.now,
  sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
} = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const job = JSON.parse(kubectlFn(['-n', namespace, 'get', 'job', jobName, '-o', 'json'], { capture: true }));
    const conditions = job.status?.conditions ?? [];
    if (conditions.some((condition) => condition.type === 'Complete' && condition.status === 'True')) return job;
    const failed = conditions.find((condition) => condition.type === 'Failed' && condition.status === 'True');
    if (failed) {
      let logs = '';
      try {
        logs = kubectlFn(['-n', namespace, 'logs', `job/${jobName}`, '--all-containers=true'], { capture: true });
      } catch {
        // The terminal Job condition is authoritative even if log collection races TTL cleanup.
      }
      const reason = [failed.reason, failed.message].filter(Boolean).join(': ') || 'Job failed';
      throw new Error(`${namespace}/job/${jobName} failed: ${reason}${logs ? `\n${logs}` : ''}`);
    }
    if (now() >= deadline) throw new Error(`${namespace}/job/${jobName} did not complete within ${Math.ceil(timeoutMs / 1000)}s`);
    sleep(intervalMs);
  }
}

function readOptionalBackboneResource(kind, name) {
  const json = kubectl([
    '-n', 'opensphere-backbone', 'get', kind, name, '--ignore-not-found', '-o', 'json'
  ], { capture: true });
  return json ? JSON.parse(json) : null;
}

// Flatten every document of every materialized release manifest into a single
// list of decoded objects using kubectl's client-side YAML decoder (dry-run only,
// no cluster state). A single manifest file (e.g. backbone.yaml) carries the
// backup CronJob, its scripts ConfigMap and the restore-drill CronJob as separate
// `---` documents, so kubectl returns a `List`; expand it so every required
// resource is recognized regardless of how the manifests are bundled.
function decodeReleaseItems(release) {
  const items = [];
  for (const manifest of release) {
    const decoded = JSON.parse(kubectl([
      'apply', '--dry-run=client', '--validate=false', '-f', '-', '-o', 'json'
    ], { capture: true, input: manifest.yaml }));
    items.push(...(decoded.kind === 'List' ? decoded.items ?? [] : [decoded]));
  }
  return items;
}

// Decode one resource of a given kind/name from materialized release manifests.
// Used to decide whether the release being applied already provides the dedicated
// backup boundary -- so a forward upgrade's own (equal-or-newer) backup manifests
// are never clobbered by a preserved copy.
function decodeReleaseResource(release, kind, name) {
  return decodeReleaseItems(release).find((item) => item.kind === kind && item.metadata?.name === name) ?? null;
}

// The release itself provides the dedicated boundary only when ALL THREE of its
// resources are on the boundary: the backup CronJob binds backup_password, its
// backup-scripts ConfigMap runs pg_dump as opensphere_backup, AND its restore-drill
// CronJob preserves the credential boundary -- POSTGRES_PASSWORD binds the sealed
// bootstrap operator and no backup/console read credential is wired into PGPASSWORD.
// Fails closed on any one: a release whose backup CronJob/script are dedicated but
// whose restore drill still binds the console runtime `password` into PGPASSWORD is a
// regression and must be overlaid, not trusted -- otherwise the regressed restore
// drill would be applied and preserved as if it were on the boundary.
function releaseProvidesDedicatedBackupBoundary(release) {
  const cronJob = decodeReleaseResource(release, 'CronJob', BACKUP_CRONJOB_RESOURCE);
  const configMap = decodeReleaseResource(release, 'ConfigMap', BACKUP_SCRIPTS_CONFIGMAP_RESOURCE);
  const restoreDrill = decodeReleaseResource(release, 'CronJob', RESTORE_DRILL_CRONJOB_RESOURCE);
  return backupBoundaryFullyDedicated({ cronJob, configMap, restoreDrill });
}

// Snapshot the live scheduled-backup CronJob, its scripts ConfigMap and the
// restore-drill CronJob before a release apply overwrites them. `dedicated`
// records whether the installation currently sits on the opensphere_backup
// boundary across ALL THREE live resources -- the CronJob credential, the ConfigMap
// script AND the restore-drill credential boundary (sealed bootstrap only, no exposed
// backup/console read credential); only then is there a full boundary (including
// restore drill) worth preserving across a regressive downgrade, and a live
// installation whose restore drill has already regressed -- e.g. wiring the console
// runtime `password` into PGPASSWORD -- is not treated as dedicated.
function captureBackupBoundary() {
  const cronJob = readOptionalBackboneResource('cronjob', BACKUP_CRONJOB_RESOURCE);
  const configMap = readOptionalBackboneResource('configmap', BACKUP_SCRIPTS_CONFIGMAP_RESOURCE);
  const restoreDrill = readOptionalBackboneResource('cronjob', RESTORE_DRILL_CRONJOB_RESOURCE);
  return { dedicated: backupBoundaryFullyDedicated({ cronJob, configMap, restoreDrill }), cronJob, configMap, restoreDrill };
}

// Monotonic security-boundary compatibility: if the installation already had the
// dedicated backup boundary and the just-applied release would regress either half
// of it (its own backbone-postgres-backup still authenticates as the console
// runtime role, OR its backbone-postgres-backup-scripts still runs
// `pg_dump -U console`), re-apply the preserved ConfigMap and both CronJobs as an
// annotated compatibility overlay, digest-pinned to the applied release's
// cbsPostgresql image. This keeps the rolled-back installation's scheduled backup
// authenticating as opensphere_backup so it can still read the forward `oaa` schema,
// and keeps the restore drill on its credential boundary -- rebuilding an ephemeral
// database with the sealed bootstrap operator alone and never re-exposing the console
// runtime `password` (or the backup read credential) to the restore job -- without
// re-granting console broad access or deleting forward data. The scripts ConfigMap is overlaid first so both CronJobs mount the
// dedicated backup.sh. A no-op when nothing regresses.
function reassertBackupBoundary(boundary, lock, release) {
  if (!boundary?.dedicated || releaseProvidesDedicatedBackupBoundary(release)) {
    return { overlaid: false, resources: [] };
  }
  const postgresImage = lock.components.cbsPostgresql.image;
  const overlays = buildCompatibilityOverlaySet(boundary, lock, postgresImage);
  for (const overlay of overlays) applyYaml(`${JSON.stringify(overlay)}\n`);
  return { overlaid: overlays.length > 0, resources: overlays.map((overlay) => `${overlay.kind}/${overlay.metadata.name}`) };
}

// Decode the three backup-boundary resources from the materialized release in a single
// client-side pass, keyed by their REAL distinct in-cluster names -- they are not a
// shared identity. Absent resources decode to null so the planner can fail closed.
function decodeBackupBoundaryResources(release) {
  const items = decodeReleaseItems(release);
  const find = (kind, name) => items.find((item) => item.kind === kind && item.metadata?.name === name) ?? null;
  return {
    cronJob: find('CronJob', BACKUP_CRONJOB_RESOURCE),
    configMap: find('ConfigMap', BACKUP_SCRIPTS_CONFIGMAP_RESOURCE),
    restoreDrill: find('CronJob', RESTORE_DRILL_CRONJOB_RESOURCE)
  };
}

// Clean bootstrap of a historical signed lock (for the upgrade/rollback gate): unlike
// upgrade/downgrade there is no live dedicated boundary to capture, so DERIVE the three
// dedicated resources from the just-applied release and overlay them (ConfigMap first,
// image-pinned to this release's cbsPostgresql digest). This monotonically establishes
// the CURRENT boundary -- so the scheduled pg_dump authenticates as opensphere_backup
// and can read the forward `oaa` schema -- BEFORE the boundary reconcile and recovery
// drill run, keeping verifyRecovery strict. A no-op when the applied release already
// ships all three dedicated resources (a forward release is never overlaid).
function establishBootstrapBackupBoundary(lock, release) {
  const overlays = planBootstrapBackupBoundary(
    decodeBackupBoundaryResources(release), lock, lock.components.cbsPostgresql.image
  );
  for (const overlay of overlays) applyYaml(`${JSON.stringify(overlay)}\n`);
  return { overlaid: overlays.length > 0, resources: overlays.map((overlay) => `${overlay.kind}/${overlay.metadata.name}`) };
}

// Run the Setup-owned dedicated backup-ROLE reconcile as a one-shot Job (never kubectl
// exec). Called only after establishBootstrapBackupBoundary actually overlaid a regressed
// historical release, whose PostgreSQL never created the opensphere_backup login role.
// The ConfigMap is applied first so the pod can mount the shell + SQL; a Job's spec is
// immutable, so any Job left by a prior attempt is deleted (the Job object only, with
// --ignore-not-found -- never a PVC/namespace/database, i.e. no data deletion) before the
// fresh image-pinned Job is created and awaited to completion.
function runBackupRoleReconcile(lock) {
  const [configMap, job] = buildBackupRoleReconcileManifests(lock);
  applyYaml(`${JSON.stringify(configMap)}\n`);
  kubectl(['-n', 'opensphere-backbone', 'delete', 'job', BACKUP_ROLE_RECONCILE_RESOURCE, '--ignore-not-found', '--wait=true']);
  applyYaml(`${JSON.stringify(job)}\n`);
  return waitForBackupRoleReconcile(job.metadata.name);
}

// Await the Setup-owned role reconcile Job, reporting a precise failure. A Failed
// condition surfaces its reason/message; a never-completing Job fails closed on timeout so
// the boundary is never silently left unestablished before the recovery drill runs.
function waitForBackupRoleReconcile(jobName) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = JSON.parse(kubectl([
      '-n', 'opensphere-backbone', 'get', 'job', jobName, '-o', 'json'
    ], { capture: true }));
    const conditions = job.status?.conditions ?? [];
    if (conditions.some((condition) => condition.type === 'Complete' && condition.status === 'True')) {
      return jobName;
    }
    const failed = conditions.find((condition) => condition.type === 'Failed' && condition.status === 'True');
    if (failed) {
      const detail = failed.reason ? ` (${failed.reason}${failed.message ? `: ${failed.message}` : ''})` : '';
      throw new Error(`Dedicated backup-role reconcile Job failed: ${jobName}${detail}`);
    }
    try {
      kubectl(['-n', 'opensphere-backbone', 'wait', '--for=condition=complete', `job/${jobName}`, '--timeout=15s'], { capture: true });
      return jobName;
    } catch {
      // A timed-out `kubectl wait` is expected while PostgreSQL is starting or the role
      // reconcile is still in flight; re-check the Job conditions on the next iteration.
    }
  }
  throw new Error('Dedicated backup-role reconcile Job did not complete before timeout');
}

function waitForBackboneBoundaryReconcile(lock) {
  const selector = `opensphere.io/boundary-reconcile=true,opensphere.io/release-revision=${lock.sourceRevision}`;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const jobs = JSON.parse(kubectl([
      '-n', 'opensphere-backbone', 'get', 'jobs', '-l', selector, '-o', 'json'
    ], { capture: true })).items ?? [];
    const job = jobs.sort((left, right) => String(right.metadata?.creationTimestamp ?? '')
      .localeCompare(String(left.metadata?.creationTimestamp ?? '')))[0];
    if (!job) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      continue;
    }
    const conditions = job.status?.conditions ?? [];
    if (conditions.some((condition) => condition.type === 'Complete' && condition.status === 'True')) {
      return job.metadata.name;
    }
    if (conditions.some((condition) => condition.type === 'Failed' && condition.status === 'True')) {
      throw new Error(`PostgreSQL boundary reconcile Job failed: ${job.metadata.name}`);
    }
    try {
      kubectl(['-n', 'opensphere-backbone', 'wait', '--for=condition=complete', `job/${job.metadata.name}`, '--timeout=15s'], { capture: true });
      return job.metadata.name;
    } catch {
      // A timed-out `kubectl wait` is expected while PostgreSQL is starting.
    }
  }
  throw new Error('PostgreSQL boundary reconcile Job did not complete before timeout');
}

function recordInstallationState(lock, storageClass, initialAdmin, consoleUrl, authEnvironment = 'development', shellTlsSecret) {
  const config = {
    apiVersion: 'bootstrap.opensphere.io/v1alpha1',
    kind: 'OpenSphereInstallationConfig',
    channel: lock.channel,
    releaseDigest: lock.releaseDigest,
    storageClass,
    consoleUrl: normalizeConsoleUrl(consoleUrl),
    authEnvironment: validateAuthEnvironment(authEnvironment),
    ...(shellTlsSecret ? { shellTlsSecret } : {}),
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

function recordInitialAdmin(initialAdmin, setupRequired) {
  // A clean bootstrap has no metadata ConfigMap yet. Reuse the optional read
  // path so first installation creates it instead of failing on NotFound.
  const existing = readInitialAdmin();
  const state = setupRequired === undefined ? (existing?.state || 'complete') : (setupRequired ? 'required' : 'complete');
  const yaml = kubectl([
    '-n', 'opensphere-console', 'create', 'configmap', 'opensphere-initial-admin',
    `--from-literal=username=${initialAdmin.username}`,
    `--from-literal=displayName=${initialAdmin.displayName}`,
    `--from-literal=email=${initialAdmin.email}`,
    `--from-literal=state=${state}`,
    '--dry-run=client', '-o', 'yaml'
  ], { capture: true });
  applyYaml(yaml);
}

export function shouldUseBrowserSetup(installed, recordedAdmin) {
  return !installed || recordedAdmin?.state !== 'complete';
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
  return { username: data.username, displayName: data.displayName, email: data.email, state: data.state || 'complete' };
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
    config.authEnvironment ?? 'development',
    config.shellTlsSecret
  );
  return migrated;
}

export function existingOpenSphereNamespaces() {
  return MANAGED_NAMESPACES
    .filter((name) => kubectl(['get', 'namespace', name, '--ignore-not-found', '-o', 'name'], { capture: true }));
}

function listManagedPersistentVolumes() {
  const namespaces = new Set(MANAGED_NAMESPACES);
  const volumes = JSON.parse(kubectl(['get', 'persistentvolumes', '-o', 'json'], { capture: true }));
  return (volumes.items ?? [])
    .filter((volume) => namespaces.has(volume.spec?.claimRef?.namespace))
    .map((volume) => volume.metadata?.name)
    .filter(Boolean);
}

function deleteManagedNamespace(namespace) {
  kubectl(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=false']);
}

function waitForManagedNamespaceDeletion(namespace) {
  kubectl(['wait', '--for=delete', `namespace/${namespace}`, '--timeout=600s'], { capture: true });
}

function deleteManagedPersistentVolume(name) {
  kubectl(['delete', 'persistentvolume', name, '--ignore-not-found', '--wait=true']);
}

function deleteManagedCrd(name) {
  kubectl(['delete', 'customresourcedefinition', name, '--ignore-not-found', '--wait=true']);
}

function deleteManagedClusterRbac(resource) {
  kubectl(['delete', resource, '--ignore-not-found', '--wait=true']);
}

// Full removal is deliberately a data-destruction operation. A normal
// bootstrap/upgrade must never infer this intent from a missing lock or a
// changed channel. The command caller validates the explicit CLI confirmation
// before it reaches here; this function independently refuses any unmanaged
// namespace so it cannot become a generic namespace deletion primitive.
export async function uninstallManagedInstallation({ runtime = {} } = {}) {
  const operations = {
    readInstallationLock,
    existingOpenSphereNamespaces,
    listManagedPersistentVolumes,
    deleteManagedNamespace,
    waitForManagedNamespaceDeletion,
    deleteManagedPersistentVolume,
    deleteManagedCrd,
    deleteManagedClusterRbac,
    ...runtime
  };
  const installed = operations.readInstallationLock();
  const namespaces = operations.existingOpenSphereNamespaces();
  if (!installed) {
    if (namespaces.length) {
      throw new Error(`Refusing to purge unmanaged OpenSphere namespaces: ${namespaces.join(', ')}`);
    }
    throw new Error('No managed OpenSphere installation lock was found');
  }
  if (namespaces.length !== MANAGED_NAMESPACES.length) {
    throw new Error(`Managed installation is incomplete; refusing purge while namespaces are missing: ${MANAGED_NAMESPACES.filter((name) => !namespaces.includes(name)).join(', ')}`);
  }
  // Capture PV names before namespace deletion: Retain policies keep them
  // cluster-scoped after their claims have disappeared.
  const persistentVolumes = operations.listManagedPersistentVolumes();
  for (const namespace of MANAGED_NAMESPACES) operations.deleteManagedNamespace(namespace);
  for (const namespace of MANAGED_NAMESPACES) operations.waitForManagedNamespaceDeletion(namespace);
  for (const volume of persistentVolumes) operations.deleteManagedPersistentVolume(volume);
  for (const crd of MANAGED_CRDS) operations.deleteManagedCrd(crd);
  for (const resource of MANAGED_CLUSTER_RBAC) operations.deleteManagedClusterRbac(resource);
  return {
    releaseDigest: installed.releaseDigest,
    namespaces: [...MANAGED_NAMESPACES],
    persistentVolumes,
    customResourceDefinitions: [...MANAGED_CRDS],
    clusterRbac: [...MANAGED_CLUSTER_RBAC]
  };
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

async function provisionInitialAdmin({ username, displayName, email }, consoleUrl, { rotateServiceCredentials = false, authEnvironment = 'development', browserSetup = false } = {}) {
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
        OPENSPHERE_AUTH_ENVIRONMENT: validateAuthEnvironment(authEnvironment),
        OPENSPHERE_BROWSER_SETUP: String(browserSetup)
      }
    });
    if (provision.status !== 0) {
      throw new Error(`Initial admin provisioning failed: ${provision.stderr.trim()}`);
    }
    let result;
    try { result = JSON.parse(provision.stdout.trim()); }
    catch { throw new Error('Initial admin provisioning returned an invalid result'); }
    if (result.browserSetup || result.onboardingRequired) {
      console.log('[완료] Console service credential 준비 · 최초 관리자는 첫 접속 Wizard에서 구성');
      return { onboardingUrl: null, serviceCredentialsCreated: !serviceCredentialsExist, setupRequired: true };
    }
    if (!result.onboardingRequired) {
      console.log('[재사용] Console service credential과 최초 관리자 credential이 이미 구성됨');
      return { onboardingUrl: null, serviceCredentialsCreated: false };
    }
    throw new Error('Initial administrator provisioning returned an unsupported onboarding result');
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
  return { consoleUrl, serviceCredentialsRotated: true, setupRequired: Boolean(result.setupRequired) };
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
  consoleUrl,
  openOnboarding = true,
  requireRecoveryDrill = true,
  authEnvironment,
  backupTargetSecret,
  shellTlsSecret,
} = {}) {
  validateLock(lock);
  const requestedAuthEnvironment = selectAuthEnvironment(lock.channel, authEnvironment);
  const requestedConsoleUrl = normalizeConsoleUrl(
    consoleUrl ?? defaultConsoleUrl(lock.channel, requestedAuthEnvironment)
  );
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
  const effectiveAuthEnvironment = selectAuthEnvironment(lock.channel, storedConfig?.authEnvironment ?? requestedAuthEnvironment);
  const repairLegacyLoopbackHttp = installed && isLegacyEdgeLoopbackHttpOrigin({
    channel: lock.channel,
    authEnvironment: effectiveAuthEnvironment,
    storedUrl: storedConsoleUrl,
    requestedUrl: requestedConsoleUrl
  });
  const effectiveConsoleUrl = normalizeConsoleUrl(
    installed && !repairLegacyLoopbackHttp ? storedConsoleUrl : requestedConsoleUrl
  );
  if (installed && requestedConsoleUrl !== effectiveConsoleUrl && !repairLegacyLoopbackHttp) {
    throw new Error(`Installation uses Console URL ${effectiveConsoleUrl}; changing it requires an endpoint migration`);
  }
  if (installed && requestedAuthEnvironment !== effectiveAuthEnvironment) {
    throw new Error(`Installation uses authentication environment ${effectiveAuthEnvironment}; changing it requires an authentication migration`);
  }
  if (installed && backupTargetSecret) {
    throw new Error('Changing the audit backup target requires a dedicated migration; bootstrap will not replace it');
  }
  const requestedBackupTarget = backupTargetSecret ? parseBackupTargetSecretRef(backupTargetSecret) : undefined;
  const requestedShellTls = shellTlsSecret ? parseShellTlsSecretRef(shellTlsSecret) : undefined;
  const storedShellTls = storedConfig?.shellTlsSecret ? parseShellTlsSecretRef(storedConfig.shellTlsSecret) : undefined;
  const effectiveShellTls = installed ? storedShellTls : requestedShellTls;
  if (installed && shellTlsSecret && shellTlsSecretRefText(requestedShellTls) !== shellTlsSecretRefText(storedShellTls)) {
    throw new Error('Changing the Console external TLS source requires an explicit endpoint migration');
  }
  assertReleaseShellTlsReference(lock.channel, effectiveShellTls);
  const effectiveAdmin = installed ? (readInitialAdmin() ?? storedConfig.initialAdmin) : initialAdmin;
  const cluster = preflight({ storageClass: storedConfig?.storageClass ?? storageClass, channel: lock.channel });
  const work = await mkdtemp(join(tmpdir(), 'opensphere-setup-'));
  try {
    console.log(`[완료] Kubernetes 연결 (${cluster.serverVersion}, ${cluster.nodeCount} nodes, StorageClass ${cluster.storageClass})`);
    if (repairLegacyLoopbackHttp) console.log('[마이그레이션] edge loopback Console origin을 HTTPS로 복구');
    for (const namespace of MANAGED_NAMESPACES) ensureNamespace(namespace);
    const externalShellTls = effectiveShellTls
      ? readSecret(effectiveShellTls.namespace, effectiveShellTls.name)
      : undefined;
    if (externalShellTls) inspectExternalShellTlsSecret(externalShellTls, effectiveConsoleUrl);
    recordInstallationState(
      lock, cluster.storageClass, effectiveAdmin, effectiveConsoleUrl, effectiveAuthEnvironment,
      shellTlsSecretRefText(effectiveShellTls)
    );
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
    if (externalShellTls) ensureExternalShellTlsSecret(effectiveShellTls, externalShellTls);
    else ensureTlsSecret('opensphere-console', 'shell-tls', cert, key);
    // The root is a real CA; TLS leaves are never treated as trust anchors.
    ensureGenericSecret('opensphere-console', 'opensphere-console-auth-ca', {}, { 'ca.crt': ca, 'tls.crt': cert });
    const effectiveConsoleHost = new URL(effectiveConsoleUrl).hostname;
    const localConsoleHost = ['localhost', '127.0.0.1', '[::1]'].includes(effectiveConsoleHost);
    if (!externalShellTls && localConsoleHost && lock.channel === 'edge' && effectiveAuthEnvironment === 'development') {
      const installedCa = readSecret('opensphere-console', 'opensphere-console-auth-ca').data?.['ca.crt'];
      if (!installedCa) throw new Error('Managed local Console CA is missing');
      const localCa = join(work, 'opensphere-local-development-ca.crt');
      await writeFile(localCa, Buffer.from(installedCa, 'base64').toString('utf8'), 'utf8');
      if (process.platform === 'win32') {
        run('pwsh', [
          '-NoProfile', '-NonInteractive', '-File', join(HERE, 'Install-LocalDevelopmentCa.ps1'),
          '-CertificatePath', localCa
        ]);
        console.log('[완료] localhost HTTPS 인증서를 현재 Windows 사용자에 신뢰 등록');
      }
    }
    // console-services.yaml mounts this Secret in opensphere-backbone for the
    // OAA gateway's trust anchor. Only the public ca.crt is mirrored here --
    // never the private key or leaf certificate -- and it must exist before
    // BASE_MANIFESTS is applied or a clean bootstrap leaves OAA unschedulable.
    ensureGenericSecret('opensphere-backbone', 'opensphere-console-auth-ca', {}, { 'ca.crt': ca });
    ensureGenericSecret('opensphere-console', 'opensphere-console-auth-sig', {}, { 'sig.key': sig });
    ensureGenericSecret('opensphere-backbone', 'backbone-postgres', {
      // `password` belongs to the constrained Console runtime role. PostgreSQL
      // initialisation uses a distinct bootstrap operator so Console can never
      // begin life as the database superuser.
      password: hex(32),
      bootstrap_password: hex(32),
      // Dedicated, independently-generated credential for the OAA gateway's own
      // least-privilege opensphere_oaa PostgreSQL role (CONSTITUTION-0004 §4.5 OAA
      // bootstrap boundary) -- never the Console runtime `password` above. Consumed by
      // both the empty-PVC init script and the idempotent boundary reconcile Job (see
      // backend/backbone/bootstrap/backbone.yaml in OpenSphere-console). ensureGenericSecret
      // only ever adds this key when absent, so a rerun/upgrade preserves the existing
      // value rather than rotating it.
      oaa_password: hex(32),
      // Dedicated, independently-generated credential for the least-privilege
      // opensphere_backup PostgreSQL role used only by the scheduled pg_dump job --
      // never the Console runtime `password`, the superuser `bootstrap_password`, or
      // the OAA `oaa_password`. Consumed by the empty-PVC init script, the boundary
      // reconcile Job, and the backup CronJob (backend/backbone/bootstrap/backbone.yaml
      // in OpenSphere-console). Added only when absent, so a rerun/upgrade preserves it.
      backup_password: hex(32)
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
    const backupTarget = prepareBackupTarget(lock.channel, requestedBackupTarget);
    console.log(`[완료] 감사 백업 대상 준비 (${backupTarget.mode})`);
    console.log('[완료] Namespace와 bootstrap secret 준비');

    const release = [];
    for (const spec of BASE_MANIFESTS) {
      const yaml = await fetchManifest(lock, spec, cluster.storageClass, effectiveConsoleUrl, effectiveAuthEnvironment);
      const file = join(work, spec.path.replaceAll('/', '-'));
      await writeFile(file, yaml, 'utf8');
      applyYaml(yaml);
      release.push({ path: spec.path, yaml });
      console.log(`[완료] ${spec.path}`);
    }
    // The applied release may be a historical signed lock whose own backup manifests
    // predate the dedicated opensphere_backup boundary. Re-establish the CURRENT
    // boundary from the applied release now -- after BASE_MANIFESTS are applied but
    // before the reconcile Job and recovery drill -- so verifyRecovery stays strict.
    const bootstrapBackupBoundary = establishBootstrapBackupBoundary(lock, release);
    if (bootstrapBackupBoundary.overlaid) {
      console.log(`[준비] 전용 백업 경계 호환성 overlay 적용 (${bootstrapBackupBoundary.resources.join(', ')})`);
    }
    console.log('[대기] Kanidm과 CBS rollout');
    kubectl(['-n', 'opensphere-console-auth', 'rollout', 'status', 'statefulset/kanidm', '--timeout=360s']);
    console.log('[대기] PostgreSQL audit ownership boundary reconcile');
    waitForBackboneBoundaryReconcile(lock);
    // Only a historical release that regressed the boundary (overlaid above) predates the
    // opensphere_backup login role. Establish that missing role now -- after the release's
    // own boundary reconcile, before the recovery drill's pg_dump authenticates as it. A
    // forward release with a fully dedicated boundary was a no-op above and gets no
    // Setup-owned role Job here.
    if (bootstrapBackupBoundary.overlaid) {
      console.log('[준비] 전용 백업 역할 opensphere_backup reconcile');
      const backupRoleReconcileJob = runBackupRoleReconcile(lock);
      console.log(`[완료] 전용 백업 역할 reconcile (${backupRoleReconcileJob})`);
    }
    const recordedAdmin = installed ? readInitialAdmin() : null;
    const onboarding = await provisionInitialAdmin(effectiveAdmin, effectiveConsoleUrl, {
      authEnvironment: effectiveAuthEnvironment,
      // A retry after a post-provision verification failure already has an
      // installation lock. It must still preserve the browser-owned human
      // credential boundary until the Wizard itself records completion.
      browserSetup: shouldUseBrowserSetup(installed, recordedAdmin),
    });
    recordInitialAdmin(effectiveAdmin, installed ? undefined : Boolean(onboarding.setupRequired));
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
    recordReleaseInventory(lock, releaseResourceInventory(release));
    console.log(`[완료] OpenSphere Console ${lock.channel} 설치 검증 (${evidence.podCount} pods, ${evidence.serviceCount} services)`);
    if (onboarding.setupRequired && openOnboarding) {
      openBrowser(effectiveConsoleUrl);
      console.log('[필요] Console 첫 접속 관리자 구성 Wizard가 브라우저에 열렸습니다.');
    } else if (onboarding.setupRequired) {
      console.log(`[필요] ${effectiveConsoleUrl} 에 접속해 최초 관리자 구성 Wizard를 완료하세요.`);
    }
    return {
      lock,
      evidence,
      consoleUrl: effectiveConsoleUrl,
      setupRequired: Boolean(onboarding.setupRequired),
      temporaryDirectory: keepTemporaryFiles ? work : undefined
    };
  } finally {
    if (!keepTemporaryFiles) await rm(work, { recursive: true, force: true });
  }
}

export async function upgrade(previousLock, targetLock, { storageClass, consoleUrl, backupTargetSecret, runtime = {} } = {}) {
  const operations = {
    readInstallationLock,
    readInstallationConfig,
    readInitialAdmin,
    assertPostgresUpgradeBoundary,
    materializeRelease,
    applyRelease,
    releaseResourceInventory,
    readReleaseInventory,
    recordReleaseInventory,
    pruneReleaseResources,
    recordInstallationState,
    prepareBackupTarget,
    prepareUpgradePrerequisites,
    restartBackboneTrustConsumers,
    reconcileRollbackStatefulSets,
    captureBackupBoundary,
    reassertBackupBoundary,
    waitForCoreRollouts,
    waitForBackboneBoundaryReconcile,
    runBackboneRecoveryDrill,
    verifyInstallation,
    preflight,
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
  // An edge installation may not be promoted while its stored policy permits
  // password-only authentication.  The migration needs an explicit operator
  // workflow, not an accidental channel upgrade.
  selectAuthEnvironment(targetLock.channel, effectiveAuthEnvironment);
  const storedShellTls = storedConfig.shellTlsSecret ? parseShellTlsSecretRef(storedConfig.shellTlsSecret) : undefined;
  assertReleaseShellTlsReference(targetLock.channel, storedShellTls);
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== effectiveConsoleUrl) {
    throw new Error(`Installation uses Console URL ${effectiveConsoleUrl}; changing it requires an endpoint migration`);
  }
  if (previousLock.releaseDigest === targetLock.releaseDigest) {
    const evidence = await operations.verifyInstallation(previousLock, { requireZeroRestarts: false, consoleUrl: effectiveConsoleUrl });
    return { changed: false, lock: previousLock, consoleUrl: effectiveConsoleUrl, evidence };
  }

  const effectiveStorageClass = storedConfig.storageClass;
  operations.preflight({ storageClass: effectiveStorageClass, channel: targetLock.channel });
  const requestedBackupTarget = backupTargetSecret ? parseBackupTargetSecretRef(backupTargetSecret) : undefined;
  const initialAdmin = operations.readInitialAdmin() ?? storedConfig.initialAdmin;
  if (!initialAdmin) throw new Error('Managed installation has no initial administrator metadata');
  operations.assertPostgresUpgradeBoundary();

  // Both directions are downloaded and digest-policy checked before the first
  // cluster mutation. A registry/source outage therefore cannot strand rollback.
  console.log('[준비] 대상 release와 이전 release rollback manifest 검증');
  const [targetRelease, rollbackRelease] = await Promise.all([
    operations.materializeRelease(targetLock, effectiveStorageClass, effectiveConsoleUrl, effectiveAuthEnvironment),
    operations.materializeRelease(previousLock, effectiveStorageClass, effectiveConsoleUrl, effectiveAuthEnvironment)
  ]);
  const targetInventory = operations.releaseResourceInventory(targetRelease);
  const rollbackInventory = operations.readReleaseInventory() ?? operations.releaseResourceInventory(rollbackRelease);

  let prerequisites;
  let backupTarget;
  // Snapshot the live scheduled-backup boundary before any release apply so it can
  // be preserved across both the target apply and, if verification fails, the
  // rollback apply.
  const backupBoundary = operations.captureBackupBoundary();
  try {
    prerequisites = await operations.prepareUpgradePrerequisites(effectiveConsoleUrl);
    if (prerequisites.changed) console.log('[준비] 기존 설치에 RustFS TLS와 CA trust bundle 추가');
    backupTarget = operations.prepareBackupTarget(targetLock.channel, requestedBackupTarget);
    console.log(`[준비] 감사 백업 대상 확인 (${backupTarget.mode})`);
    operations.applyRelease(targetRelease, '업그레이드');
    // Reassert the dedicated backup boundary before the recovery drill runs: a
    // downgrade target whose backbone-postgres-backup regresses to `pg_dump -U
    // console` would otherwise fail on the forward `oaa` schema.
    const overlay = operations.reassertBackupBoundary(backupBoundary, targetLock, targetRelease);
    if (overlay.overlaid) console.log(`[준비] 전용 백업 경계 호환성 overlay 적용 (${overlay.resources.join(', ')})`);
    console.log('[대기] PostgreSQL audit ownership boundary reconcile');
    operations.waitForBackboneBoundaryReconcile(targetLock);
    if (prerequisites.changed) operations.restartBackboneTrustConsumers();
    operations.recordInstallationState(targetLock, effectiveStorageClass, initialAdmin, effectiveConsoleUrl, effectiveAuthEnvironment, storedConfig.shellTlsSecret);
    console.log('[대기] 대상 release rollout');
    operations.waitForCoreRollouts();
    console.log('[검증] Backbone PostgreSQL → RustFS backup 및 비파괴 restore drill');
    const recoveryDrill = operations.runBackboneRecoveryDrill();
    const evidence = await operations.verifyInstallation(targetLock, {
      requireZeroRestarts: false, consoleUrl: effectiveConsoleUrl, requireRecoveryDrill: Boolean(recoveryDrill)
    });
    operations.pruneReleaseResources(rollbackInventory, targetInventory);
    operations.recordReleaseInventory(targetLock, targetInventory);
    await operations.verifyInstallation(targetLock, { requireZeroRestarts: false, consoleUrl: effectiveConsoleUrl });
    console.log(`[완료] ${previousLock.releaseDigest} → ${targetLock.releaseDigest}`);
    return { changed: true, lock: targetLock, consoleUrl: effectiveConsoleUrl, evidence };
  } catch (upgradeError) {
    console.error(`[롤백] upgrade 검증 실패: ${upgradeError.message}`);
    try {
      operations.applyRelease(rollbackRelease, '롤백');
      // Preserve the dedicated backup boundary on the rollback target too: if the
      // previous release's own backbone-postgres-backup would regress it, keep the
      // installation authenticating as opensphere_backup.
      operations.reassertBackupBoundary(backupBoundary, previousLock, rollbackRelease);
      operations.pruneReleaseResources(targetInventory, rollbackInventory);
      operations.recordInstallationState(previousLock, effectiveStorageClass, initialAdmin, effectiveConsoleUrl, effectiveAuthEnvironment, storedConfig.shellTlsSecret);
      operations.reconcileRollbackStatefulSets();
      operations.waitForCoreRollouts();
      await operations.verifyInstallation(previousLock, {
        requireZeroRestarts: false, consoleUrl: effectiveConsoleUrl, record: false, mode: 'rollback'
      });
      operations.recordReleaseInventory(previousLock, rollbackInventory);
      // Only remove compatibility prerequisites once the previous template is
      // running again. Removing them before its StatefulSet has reconciled can
      // leave rollback stuck behind a target Pod with a Secret volume.
      if (typeof prerequisites?.restore === 'function') prerequisites.restore();
      if (typeof backupTarget?.restore === 'function') backupTarget.restore();
    } catch (rollbackError) {
      throw new Error(`Upgrade failed (${upgradeError.message}); rollback also failed (${rollbackError.message})`);
    }
    throw new Error(`Upgrade failed and the previous release was restored: ${upgradeError.message}`);
  }
}
