import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl, run } from './process.mjs';
import { preflight } from './preflight.mjs';
import { fetchWithRetry } from './http.mjs';
import {
  hostRegistryCredentials,
  isLocalEdgeLock,
  validateLock,
  verifyReleaseLock
} from './release.mjs';
import { verifyInstallation } from './verify.mjs';
import {
  configureShellServiceEndpoint,
  defaultConsoleUrl,
  isLegacyEdgeLoopbackHttpOrigin,
  normalizeConsoleUrl
} from './console-url.mjs';
import { selectAuthEnvironment } from './auth-environment.mjs';
import {
  assertReleaseShellTlsReference,
  inspectExternalShellTlsSecret,
  parseShellTlsSecretRef,
  shellTlsSecretRefText
} from './shell-tls.mjs';
import {
  REGISTRY_PULL_SECRET,
  registryPullSecretManifest,
  releaseNeedsRegistryCredentials,
  secretHasGhcrCredential
} from './registry-pull-secret.mjs';
import {
  inspectRecoveryTarget,
  parseRecoveryTargetSecretRef,
  recoveryTargetData
} from './recovery-target.mjs';
import { reportReleaseProgress } from './progress.mjs';
import { materializeRuntimeAsset } from './runtime-assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = 'https://raw.githubusercontent.com/opensphere-platform/OpenSphere-console';
const RELEASE_INVENTORY_CONFIGMAP = 'opensphere-release-inventory';
const LEGACY_RECOVERY_MIGRATION = 'backend/supabase/migrations/0026_schema_migration_ledger.sql';
const LEGACY_RECOVERY_MANIFESTS = new Set([
  'backend/recovery/recovery-jobs.yaml',
  'deploy/console-image-admission-policy.yaml'
]);
const PRUNABLE_MANIFEST_KINDS = new Set([
  'ClusterRole', 'ClusterRoleBinding', 'ConfigMap', 'CronJob', 'Deployment',
  'NetworkPolicy', 'PodDisruptionBudget', 'Role', 'RoleBinding', 'Service',
  'ServiceAccount', 'StatefulSet', 'ValidatingAdmissionPolicy',
  'ValidatingAdmissionPolicyBinding'
]);

export const MANAGED_NAMESPACES = Object.freeze([
  'opensphere-console-data',
  'opensphere-console-change',
  'opensphere-console-recovery',
  'opensphere-console',
  'opensphere-oaa-credentials',
  'opensphere-foundation',
  'opensphere-system'
]);

export const MANAGED_CRDS = Object.freeze([
  'platformsupportprofiles.platform.opensphere.io',
  'uipluginpackages.plugins.opensphere.io',
  'uipluginregistrations.plugins.opensphere.io'
]);

export const MANAGED_CLUSTER_RBAC = Object.freeze([
  'clusterrolebinding/dupa-module-profile-installer',
  'clusterrolebinding/dupa-console-evidence-reader',
  'clusterrolebinding/dupa-clidownload-reader',
  'clusterrolebinding/opensphere-console-backend',
  'clusterrolebinding/opensphere-console-oaa-gateway-environment-reader',
  'clusterrole/opensphere-module-cluster-observer-v1',
  'clusterrole/opensphere-module-cluster-his-manager-v1',
  'clusterrole/opensphere-module-cluster-infrastructure-manager-v1',
  'clusterrole/dupa-module-profile-installer',
  'clusterrole/dupa-console-evidence-reader',
  'clusterrole/dupa-clidownload-reader',
  'clusterrole/opensphere-console-backend',
  'clusterrole/opensphere-console-oaa-gateway-environment-reader'
]);

// These resources are cluster-scoped, so namespace deletion cannot remove
// them. Bindings are deliberately deleted before their policies.
export const MANAGED_CLUSTER_POLICIES = Object.freeze([
  'validatingadmissionpolicybinding/opensphere-console-manual-ui-contract',
  'validatingadmissionpolicy/opensphere-console-manual-ui-contract',
  'validatingadmissionpolicybinding/opensphere-console-image-integrity-workload',
  'validatingadmissionpolicy/opensphere-console-image-integrity-workload',
  'validatingadmissionpolicybinding/opensphere-console-image-integrity-cronjob',
  'validatingadmissionpolicy/opensphere-console-image-integrity-cronjob'
]);

export const BASE_MANIFESTS = Object.freeze([
  { path: 'backend/dupa-control/platform-support-profile-crd.yaml' },
  { path: 'backend/dupa-control/ui-plugin-crds.yaml' },
  { path: 'backend/dupa-control/dupa-trusted-keys.yaml' },
  { path: 'backend/dupa-control/clidownload-rbac.yaml' },
  {
    path: 'backend/dupa-control/opensphere-console-dupa-controller.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-console-(?:dupa-controller|dupa)(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'dupaController'
    ]]
  },
  {
    path: 'backend/opensphere-console-backend/deploy.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-console-backend(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'backend'
    ]]
  },
  {
    path: 'backend/notification-dispatcher/deploy.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?(?:opensphere-console-|opensphere-)?notification-dispatcher(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'notificationDispatcher'
    ]]
  },
  {
    path: 'backend/recovery/recovery-jobs.yaml',
    replacements: [[
      '(?:__OPENSPHERE_RECOVERY_IMAGE__|ghcr\\.io/opensphere-platform/opensphere-console-recovery@sha256:[a-f0-9]+)',
      'recovery'
    ]]
  },
  {
    path: 'backend/opensphere-console-oaa-gateway/deploy.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-console-oaa-gateway(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'oaaGateway'
    ]]
  },
  {
    path: 'backend/oaa-governed-adapter/deploy.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-oaa-governed-adapter(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'oaaGovernedAdapter'
    ]]
  },
  // This is part of the released install set, rather than an operator-side
  // optional file.  It supplies the Main Shell PDBs and ingress boundaries;
  // it intentionally does not pretend that a single-replica RWO data plane
  // is HA (that remains a separately certified production prerequisite).
  { path: 'deploy/production-hardening.yaml' },
  { path: 'deploy/manual-ui-admission-policy.yaml' },
  { path: 'deploy/console-image-admission-policy.yaml' },
  {
    path: 'deploy/opensphere-console.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-console(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'console'
    ]]
  }
]);

export const SUPABASE_MIGRATIONS = Object.freeze([
  '0001_console_backbone.sql',
  '0002_backend_boundary.sql',
  '0003_change_correlation.sql',
  '0004_backend_rls.sql',
  '0005_oaa_governed_agent.sql',
  '0006_cli_identity.sql',
  '0007_extension_revocation.sql',
  '0008_backend_service_role.sql',
  '0009_platform_control_governance.sql',
  '0010_change_approval.sql',
  '0011_notification_delivery.sql',
  '0012_oaa_llm_usage_ledger.sql',
  '0013_oaa_agent_control_plane.sql',
  '0014_cli_token_scope.sql',
  '0015_oaa_knowledge_revisions.sql',
  '0016_oaa_runtime_watch.sql',
  '0017_oaa_watch_observer.sql',
  '0018_oaa_owner_api_projection.sql',
  '0019_oaa_evidence_correlation_retention.sql',
  '0020_oaa_owner_control_permissions.sql',
  '0021_oaa_infrastructure_owner_permissions.sql',
  '0022_oaa_recovery_owner_permissions.sql',
  '0023_ceph_prerequisite_consumer.sql',
  '0024_ai_consumer_contract.sql',
  '0025_external_channels_backup.sql',
  '0026_schema_migration_ledger.sql',
  '0027_external_channel_reason_policy.sql'
]);

export const SUPABASE_MANIFEST = Object.freeze({
  path: 'backend/supabase/bootstrap/supabase.yaml',
  replacements: [
    ['(?:docker\\.io/supabase/postgres|ghcr\\.io/opensphere-platform/opensphere-console-supabase-postgres)(?:@sha256:[a-f0-9]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'supabasePostgres'],
    ['(?:docker\\.io/supabase/gotrue|ghcr\\.io/opensphere-platform/opensphere-console-supabase-auth)(?:@sha256:[a-f0-9]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'supabaseAuth'],
    ['(?:docker\\.io/postgrest/postgrest|ghcr\\.io/opensphere-platform/opensphere-console-supabase-rest)(?:@sha256:[a-f0-9]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'supabaseRest'],
    ['(?:docker\\.io/supabase/storage-api|ghcr\\.io/opensphere-platform/opensphere-console-supabase-storage)(?:@sha256:[a-f0-9]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'supabaseStorage']
  ]
});

export const GITEA_MANIFEST = Object.freeze({
  path: 'backend/gitea/bootstrap/gitea.yaml',
  replacements: [
    ['(?:__OPENSPHERE_GITEA_IMAGE__|ghcr\\.io/opensphere-platform/opensphere-console-gitea@sha256:[a-f0-9]+)', 'gitea'],
    ['(?:(?:docker\\.io/library/)?postgres|ghcr\\.io/opensphere-platform/opensphere-console-gitea-postgres)(?:@sha256:[a-f0-9]+|:17-alpine)', 'giteaPostgres']
  ]
});

export const FOUNDATION_ARTIFACT_PATHS = Object.freeze([
  'backend/supabase/install.ps1',
  ...SUPABASE_MIGRATIONS.map((name) => `backend/supabase/migrations/${name}`),
  'backend/gitea/bootstrap/install.ps1',
  'backend/gitea/bootstrap/configure-signing.ps1',
  'backend/gitea/bootstrap/control-plane-bootstrap.ps1'
]);

export const INSTALL_ARTIFACT_PATHS = Object.freeze([
  ...FOUNDATION_ARTIFACT_PATHS,
  SUPABASE_MANIFEST.path,
  GITEA_MANIFEST.path,
  ...BASE_MANIFESTS.map(({ path }) => path)
]);

function isPreRecoveryRelease(lock) {
  return !lock?.components?.recovery;
}

function foundationArtifactPaths(lock) {
  return isPreRecoveryRelease(lock)
    ? FOUNDATION_ARTIFACT_PATHS.filter((path) => path !== LEGACY_RECOVERY_MIGRATION)
    : FOUNDATION_ARTIFACT_PATHS;
}

function baseManifestSpecs(lock) {
  return isPreRecoveryRelease(lock)
    ? BASE_MANIFESTS.filter(({ path }) => !LEGACY_RECOVERY_MANIFESTS.has(path))
    : BASE_MANIFESTS;
}

function installArtifactCount(lock) {
  return foundationArtifactPaths(lock).length + 2 + baseManifestSpecs(lock).length;
}

export const CORE_ROLLOUTS = Object.freeze([
  ['opensphere-console-data', 'statefulset/opensphere-supabase-postgres', '600s'],
  ['opensphere-console-data', 'deployment/opensphere-supabase-auth', '600s'],
  ['opensphere-console-data', 'deployment/opensphere-supabase-rest', '600s'],
  ['opensphere-console-data', 'deployment/opensphere-supabase-storage', '600s'],
  ['opensphere-console-change', 'deployment/opensphere-gitea-postgres', '600s'],
  ['opensphere-console-change', 'deployment/opensphere-gitea', '900s'],
  ['opensphere-console', 'deployment/opensphere-console-dupa-controller', '600s'],
  ['opensphere-console', 'deployment/opensphere-console-backend', '600s'],
  ['opensphere-console', 'deployment/opensphere-notification-dispatcher', '600s'],
  ['opensphere-console', 'deployment/opensphere-external-channel-executor', '600s'],
  ['opensphere-console', 'deployment/opensphere-console-oaa-gateway', '600s'],
  ['opensphere-console', 'deployment/oaa-governed-adapter', '600s'],
  ['opensphere-console', 'deployment/opensphere-console', '600s']
]);

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

function readSecret(namespace, name) {
  return JSON.parse(kubectl(['-n', namespace, 'get', 'secret', name, '-o', 'json'], { capture: true }));
}

export function mergeSecretData(existingData = {}, candidateData = {}) {
  return {
    ...existingData,
    ...Object.fromEntries(Object.entries(candidateData).filter(([key]) => !existingData?.[key]))
  };
}

function ensureGenericSecret(namespace, name, literals = {}, files = {}) {
  let existing = null;
  try { existing = readSecret(namespace, name); } catch {}
  const candidate = {};
  for (const [key, value] of Object.entries(literals)) {
    candidate[key] = Buffer.from(String(value)).toString('base64');
  }
  for (const [key, path] of Object.entries(files)) {
    candidate[key] = readFileSync(path).toString('base64');
  }
  const data = mergeSecretData(existing?.data, candidate);
  const changed = !existing || Object.keys(candidate).some((key) => !existing.data?.[key]);
  if (!changed) return false;
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    type: existing?.type || 'Opaque',
    data
  })}\n`);
  return true;
}

function ensureRecoveryTargetSecret(namespace, source) {
  const candidate = recoveryTargetData(source);
  let existing = null;
  try { existing = readSecret(namespace, 'opensphere-platform-recovery-target'); } catch {}
  if (existing) {
    const changed = Object.keys(candidate).some((key) => existing.data?.[key] !== candidate[key]);
    if (changed) {
      throw new Error(`Recovery target rotation is a governed migration; refusing to replace ${namespace}/opensphere-platform-recovery-target during bootstrap`);
    }
    return false;
  }
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'opensphere-platform-recovery-target',
      namespace,
      labels: { 'opensphere.io/authority': 'external-recovery-target' }
    },
    type: 'Opaque',
    data: candidate
  })}\n`);
  return true;
}

function ensureTlsSecret(namespace, name, certificatePath, keyPath, caPath) {
  return ensureGenericSecret(namespace, name, {}, {
    'tls.crt': certificatePath,
    'tls.key': keyPath,
    ...(caPath ? { 'ca.crt': caPath } : {})
  });
}

function ensureExternalShellTlsSecret(reference, source) {
  const existing = (() => {
    try { return readSecret('opensphere-console', 'shell-tls'); } catch { return null; }
  })();
  const sourceCertificate = source.data?.['tls.crt'];
  const sourceKey = source.data?.['tls.key'];
  if (!sourceCertificate || !sourceKey) throw new Error('External shell TLS source is incomplete');
  if (existing?.data?.['tls.crt'] === sourceCertificate && existing?.data?.['tls.key'] === sourceKey) return;
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'shell-tls',
      namespace: 'opensphere-console',
      annotations: {
        'opensphere.io/source-secret': shellTlsSecretRefText(reference)
      }
    },
    type: 'kubernetes.io/tls',
    data: { 'tls.crt': sourceCertificate, 'tls.key': sourceKey }
  })}\n`);
}

export function ensureRegistryPullSecrets(lock, suppliedCredentials) {
  const requiresCredentials = releaseNeedsRegistryCredentials(lock);
  const existing = new Map(MANAGED_NAMESPACES.map((namespace) => {
    try { return [namespace, readSecret(namespace, REGISTRY_PULL_SECRET)]; }
    catch { return [namespace, null]; }
  }));
  const everyNamespaceReady = MANAGED_NAMESPACES.every((namespace) =>
    requiresCredentials
      ? secretHasGhcrCredential(existing.get(namespace))
      : Boolean(existing.get(namespace))
  );
  if (!suppliedCredentials && everyNamespaceReady) {
    return {
      credentialsRequired: requiresCredentials,
      credentialSource: requiresCredentials ? 'existing-secret' : 'anonymous'
    };
  }
  const credentials = suppliedCredentials ?? (requiresCredentials ? hostRegistryCredentials() : null);
  if (requiresCredentials && !credentials) {
    throw new Error('This release contains private GHCR packages; provide --registry-username with --registry-token-stdin or authenticate gh with read:packages');
  }
  for (const namespace of MANAGED_NAMESPACES) {
    if (!credentials && existing.get(namespace)) continue;
    applyYaml(`${JSON.stringify(registryPullSecretManifest(namespace, credentials))}\n`);
  }
  return {
    credentialsRequired: requiresCredentials,
    credentialSource: credentials ? 'managed-secret' : 'anonymous'
  };
}

function validateAuthEnvironment(value) {
  return selectAuthEnvironment('edge', value);
}

async function fetchReleaseArtifact(lock, path) {
  const response = await fetchWithRetry(`${RAW_ROOT}/${lock.sourceRevision}/${path}`);
  if (!response.ok) throw new Error(`Release artifact download failed (${path}): HTTP ${response.status}`);
  return response.text();
}

export function renderManifest(
  lock,
  spec,
  sourceYaml,
  storageClass,
  consoleUrl = defaultConsoleUrl('edge', 'development'),
  authEnvironment = 'development'
) {
  let yaml = sourceYaml;
  for (const [pattern, component] of spec.replacements ?? []) {
    const image = lock.components?.[component]?.image;
    if (!image) throw new Error(`Release lock lacks component ${component}`);
    const expression = new RegExp(pattern, 'g');
    if (!expression.test(yaml)) {
      throw new Error(`Manifest ${spec.path} no longer exposes the governed ${component} image slot`);
    }
    yaml = yaml.replace(new RegExp(pattern, 'g'), image);
  }
  yaml = yaml.replace(/storageClassName:\s*standard/g, `storageClassName: ${storageClass}`);
  yaml = yaml.replaceAll('__OPENSPHERE_STORAGE_CLASS__', storageClass);
  const normalizedConsoleUrl = normalizeConsoleUrl(consoleUrl);
  yaml = yaml.replaceAll('__OPENSPHERE_CONSOLE_URL__', normalizedConsoleUrl);
  yaml = yaml.replaceAll('__OPENSPHERE_SUPABASE_NAMESPACE__', 'opensphere-console-data');
  yaml = yaml.replaceAll('https://localhost:8090', normalizedConsoleUrl);
  yaml = configureShellServiceEndpoint(yaml, normalizedConsoleUrl);
  yaml = yaml.replaceAll('__OPENSPHERE_RELEASE_REVISION__', lock.sourceRevision);
  yaml = yaml.replaceAll(
    'name: AUTH_ENVIRONMENT, value: "development"',
    `name: AUTH_ENVIRONMENT, value: "${validateAuthEnvironment(authEnvironment)}"`
  );
  if (/__OPENSPHERE_[A-Z0-9_]+__/.test(yaml)) {
    throw new Error(`Manifest ${spec.path} has an unresolved Setup placeholder`);
  }
  for (const match of yaml.matchAll(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/gm)) {
    if (!/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(match[1])) {
      throw new Error(`Manifest ${spec.path} contains an ungoverned image reference: ${match[1]}`);
    }
  }
  return yaml;
}

export async function fetchManifest(
  lock,
  spec,
  storageClass,
  consoleUrl = defaultConsoleUrl('edge', 'development'),
  authEnvironment = 'development'
) {
  const sourceYaml = await fetchReleaseArtifact(lock, spec.path);
  return renderManifest(lock, spec, sourceYaml, storageClass, consoleUrl, authEnvironment);
}

async function writeReleaseArtifact(root, path, contents) {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  return target;
}

async function materializeFoundationInstallers(
  lock,
  root,
  storageClass,
  consoleUrl,
  authEnvironment
) {
  const [supabaseManifest, giteaManifest] = await Promise.all([
    fetchManifest(lock, SUPABASE_MANIFEST, storageClass, consoleUrl, authEnvironment),
    fetchManifest(lock, GITEA_MANIFEST, storageClass, consoleUrl, authEnvironment)
  ]);
  const artifacts = await Promise.all(foundationArtifactPaths(lock).map(async (path) => ({
    path,
    contents: await fetchReleaseArtifact(lock, path)
  })));
  for (const artifact of artifacts) await writeReleaseArtifact(root, artifact.path, artifact.contents);
  await writeReleaseArtifact(root, SUPABASE_MANIFEST.path, supabaseManifest);
  await writeReleaseArtifact(root, GITEA_MANIFEST.path, giteaManifest);
  return {
    root,
    release: [
      { path: SUPABASE_MANIFEST.path, yaml: supabaseManifest },
      { path: GITEA_MANIFEST.path, yaml: giteaManifest }
    ]
  };
}

function runFoundationInstallers(lock, foundation, storageClass, consoleUrl, progress) {
  const context = process.env.OPENSPHERE_KUBE_CONTEXT || '';
  const supabaseArgs = [
    '-NoProfile', '-NonInteractive', '-File',
    join(foundation.root, 'backend', 'supabase', 'install.ps1'),
    '-ConsoleUrl', consoleUrl,
    '-Namespace', 'opensphere-console-data',
    '-StorageClass', storageClass,
    '-SourceRevision', lock.sourceRevision
  ];
  if (context) supabaseArgs.push('-KubeContext', context);
  progress?.item('설치', 'Supabase Data & Identity Backbone');
  run('pwsh', supabaseArgs);
  progress?.item('완료', 'Supabase Data & Identity Backbone manifest 적용');

  const giteaArgs = [
    '-NoProfile', '-NonInteractive', '-File',
    join(foundation.root, 'backend', 'gitea', 'bootstrap', 'install.ps1'),
    '-GiteaNamespace', 'opensphere-console-change',
    '-ConsoleNamespace', 'opensphere-console',
    '-GiteaImage', lock.components.gitea.image,
    '-PostgresImage', lock.components.giteaPostgres.image,
    '-StorageClass', storageClass
  ];
  if (context) giteaArgs.push('-KubeContext', context);
  progress?.item('설치', 'Gitea Declarative Change Authority');
  run('pwsh', giteaArgs);
  progress?.item('완료', 'Gitea Declarative Change Authority manifest 적용');
}

async function materializeBaseRelease(lock, storageClass, consoleUrl, authEnvironment) {
  return Promise.all(baseManifestSpecs(lock).map(async (spec) => ({
    path: spec.path,
    yaml: await fetchManifest(lock, spec, storageClass, consoleUrl, authEnvironment)
  })));
}

function applyRelease(release, label, progress) {
  for (const manifest of release) {
    applyYaml(manifest.yaml);
    if (progress) progress.item(label, manifest.path);
    else console.log(`[${label}] ${manifest.path}`);
  }
}

function inventoryKey(resource) {
  return [resource.apiVersion, resource.kind, resource.namespace ?? '', resource.name].join('|');
}

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
  return [...inventory.values()].sort((left, right) =>
    inventoryKey(left).localeCompare(inventoryKey(right)));
}

function readReleaseInventory() {
  try {
    const configMap = JSON.parse(kubectl([
      '-n', 'opensphere-console', 'get', 'configmap', RELEASE_INVENTORY_CONFIGMAP, '-o', 'json'
    ], { capture: true }));
    const parsed = JSON.parse(configMap.data?.['resources.json'] ?? 'null');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordReleaseInventory(lock, inventory) {
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: RELEASE_INVENTORY_CONFIGMAP, namespace: 'opensphere-console' },
    data: {
      'release-digest': lock.releaseDigest,
      'resources.json': JSON.stringify(inventory)
    }
  })}\n`);
}

function pruneReleaseResources(fromInventory, targetInventory) {
  const target = new Set(targetInventory.map(inventoryKey));
  for (const resource of fromInventory ?? []) {
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
    for (const status of [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? [])
    ]) {
      const waiting = status.state?.waiting;
      if (waiting && immediate.has(waiting.reason)) {
        return `${pod.metadata?.name}/${status.name}: ${waiting.reason}${waiting.message ? ` (${waiting.message})` : ''}`;
      }
      if (
        waiting
        && ['ErrImagePull', 'ImagePullBackOff'].includes(waiting.reason)
        && unrecoverableImagePull.test(String(waiting.message ?? ''))
      ) {
        return `${pod.metadata?.name}/${status.name}: ${waiting.reason} (${waiting.message})`;
      }
    }
  }
  return null;
}

function waitForCoreRollouts(progress) {
  for (const [namespace, resource, timeout] of CORE_ROLLOUTS) {
    progress?.wait(`${namespace}/${resource} rollout`, `timeout=${timeout}`);
    const deadline = Date.now() + Number.parseInt(timeout, 10) * 1000;
    while (Date.now() < deadline) {
      try {
        kubectl(['-n', namespace, 'rollout', 'status', resource, '--timeout=15s'], { capture: true });
        progress?.item('준비', `${namespace}/${resource}`);
        break;
      } catch (rolloutError) {
        const workload = JSON.parse(kubectl(['-n', namespace, 'get', resource, '-o', 'json'], { capture: true }));
        const selector = Object.entries(workload.spec?.selector?.matchLabels ?? {})
          .map(([key, value]) => `${key}=${value}`).join(',');
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

export function waitForJobCompletion(
  namespace,
  name,
  {
    timeoutMs = 600_000,
    intervalMs = 1_000,
    kubectlFn = kubectl,
    now = () => Date.now(),
    sleep = (milliseconds) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  } = {}
) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const job = JSON.parse(kubectlFn(
      ['-n', namespace, 'get', 'job', name, '-o', 'json'],
      { capture: true }
    ));
    const conditions = job.status?.conditions ?? [];
    if (conditions.some((condition) => condition.type === 'Complete' && condition.status === 'True')) return job;
    const failed = conditions.find((condition) => condition.type === 'Failed' && condition.status === 'True');
    if (failed) {
      let logs = '';
      try {
        logs = kubectlFn(
          ['-n', namespace, 'logs', `job/${name}`, '--all-containers=true'],
          { capture: true }
        );
      } catch {}
      throw new Error(
        `Job ${namespace}/${name} failed${failed.reason ? ` (${failed.reason})` : ''}`
        + `${failed.message ? `: ${failed.message}` : ''}${logs ? `\n${logs}` : ''}`
      );
    }
    sleep(intervalMs);
  }
  throw new Error(`Job ${namespace}/${name} did not complete within ${timeoutMs / 1000}s`);
}

function recordInstallationState(
  lock,
  storageClass,
  initialAdmin,
  consoleUrl,
  authEnvironment,
  shellTlsSecret
) {
  const config = {
    apiVersion: 'bootstrap.opensphere.io/v1alpha1',
    kind: 'OpenSphereInstallationConfig',
    architecture: 'supabase-data-identity+gitea-change-authority',
    channel: lock.channel,
    releaseDigest: lock.releaseDigest,
    storageClass,
    consoleUrl: normalizeConsoleUrl(consoleUrl),
    authEnvironment: validateAuthEnvironment(authEnvironment),
    ...(shellTlsSecret ? { shellTlsSecret } : {}),
    initialAdmin
  };
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'opensphere-installation-lock', namespace: 'opensphere-console' },
    data: {
      'release.json': JSON.stringify(lock),
      'config.json': JSON.stringify(config)
    }
  })}\n`);
}

function recordInitialAdmin(initialAdmin, state = 'required') {
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'opensphere-initial-admin', namespace: 'opensphere-console' },
    data: {
      username: initialAdmin.username,
      displayName: initialAdmin.displayName,
      email: initialAdmin.email,
      state
    }
  })}\n`);
}

function readInstallationConfig() {
  try {
    const object = JSON.parse(kubectl([
      '-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock', '-o', 'json'
    ], { capture: true }));
    return JSON.parse(object.data?.['config.json'] ?? 'null');
  } catch {
    return null;
  }
}

function readStoredInstallationLock() {
  try {
    const object = JSON.parse(kubectl([
      '-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock', '-o', 'json'
    ], { capture: true }));
    return JSON.parse(object.data?.['release.json'] ?? 'null');
  } catch {
    return null;
  }
}

export function readInstallationLock() {
  const lock = readStoredInstallationLock();
  return lock ? validateLock(lock, { allowLegacyComponentSet: true }) : null;
}

// The retired Kanidm/PostgreSQL/RustFS release shape is not migratable by a
// fresh-install bootstrap. Existing clusters must use an explicit data
// migration/recovery workflow; this function only recognizes modern locks.
export async function migrateLegacyInstallationLock() {
  const lock = readStoredInstallationLock();
  if (!lock || lock.releaseBom) return null;
  if (isLocalEdgeLock(lock)) {
    validateLock(lock);
    return null;
  }
  throw new Error('Legacy Kanidm/PostgreSQL/RustFS installation lock detected; fresh Supabase bootstrap refuses in-place trust migration');
}

export function existingOpenSphereNamespaces() {
  const namespaces = JSON.parse(kubectl(['get', 'namespaces', '-o', 'json'], { capture: true }));
  return (namespaces.items ?? [])
    .map((item) => String(item.metadata?.name ?? ''))
    .filter((name) => name.startsWith('opensphere-'))
    .sort();
}

function listManagedPersistentVolumes() {
  const namespaces = new Set(MANAGED_NAMESPACES);
  const volumes = JSON.parse(kubectl(['get', 'persistentvolumes', '-o', 'json'], { capture: true }));
  return (volumes.items ?? [])
    .filter((volume) => namespaces.has(volume.spec?.claimRef?.namespace))
    .map((volume) => volume.metadata?.name)
    .filter(Boolean);
}

export async function uninstallManagedInstallation({ runtime = {} } = {}) {
  const operations = {
    readInstallationLock,
    existingOpenSphereNamespaces,
    listManagedPersistentVolumes,
    deleteManagedNamespace: (namespace) =>
      kubectl(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=false']),
    waitForManagedNamespaceDeletion: (namespace) =>
      kubectl(['wait', '--for=delete', `namespace/${namespace}`, '--timeout=600s'], { capture: true }),
    deleteManagedPersistentVolume: (name) =>
      kubectl(['delete', 'persistentvolume', name, '--ignore-not-found', '--wait=true']),
    deleteManagedCrd: (name) =>
      kubectl(['delete', 'customresourcedefinition', name, '--ignore-not-found', '--wait=true']),
    deleteManagedClusterRbac: (resource) =>
      kubectl(['delete', resource, '--ignore-not-found', '--wait=true']),
    ...runtime
  };
  const installed = operations.readInstallationLock();
  const namespaces = operations.existingOpenSphereNamespaces();
  if (!installed) {
    if (namespaces.length) throw new Error(`Refusing to purge unmanaged OpenSphere namespaces: ${namespaces.join(', ')}`);
    throw new Error('No managed OpenSphere installation lock was found');
  }
  const unexpected = namespaces.filter((name) => !MANAGED_NAMESPACES.includes(name));
  const missing = MANAGED_NAMESPACES.filter((name) => !namespaces.includes(name));
  if (unexpected.length || missing.length) {
    throw new Error(`Managed namespace ownership differs (missing=${missing.join(',') || 'none'}, unexpected=${unexpected.join(',') || 'none'})`);
  }
  const persistentVolumes = operations.listManagedPersistentVolumes();
  for (const namespace of MANAGED_NAMESPACES) operations.deleteManagedNamespace(namespace);
  for (const namespace of MANAGED_NAMESPACES) operations.waitForManagedNamespaceDeletion(namespace);
  for (const volume of persistentVolumes) operations.deleteManagedPersistentVolume(volume);
  for (const crd of MANAGED_CRDS) operations.deleteManagedCrd(crd);
  for (const resource of MANAGED_CLUSTER_POLICIES) operations.deleteManagedClusterRbac(resource);
  for (const resource of MANAGED_CLUSTER_RBAC) operations.deleteManagedClusterRbac(resource);
  return {
    releaseDigest: installed.releaseDigest,
    namespaces: [...MANAGED_NAMESPACES],
    persistentVolumes,
    customResourceDefinitions: [...MANAGED_CRDS],
    clusterPolicies: [...MANAGED_CLUSTER_POLICIES],
    clusterRbac: [...MANAGED_CLUSTER_RBAC]
  };
}

export function shouldUseBrowserSetup(installed, recordedAdmin) {
  return !installed || recordedAdmin?.state !== 'complete';
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
}

function promotionBlocked(channel) {
  if (channel === 'edge') return;
  throw new Error(
    `${channel} bootstrap is blocked until the isolated Supabase DB + Storage + Gitea integrated recovery drill is implemented`
  );
}

async function prepareRelease(
  lock,
  root,
  storageClass,
  consoleUrl,
  authEnvironment
) {
  const [foundation, base] = await Promise.all([
    materializeFoundationInstallers(lock, root, storageClass, consoleUrl, authEnvironment),
    materializeBaseRelease(lock, storageClass, consoleUrl, authEnvironment)
  ]);
  return { foundation, base, all: [...foundation.release, ...base] };
}

export async function preflightReleaseArtifacts(lock, {
  storageClass,
  consoleUrl,
  authEnvironment
}, {
  createTemporaryDirectory = () => mkdtemp(join(tmpdir(), 'opensphere-artifact-preflight-')),
  prepare = prepareRelease,
  removeDirectory = (path) => rm(path, { recursive: true, force: true })
} = {}) {
  const root = await createTemporaryDirectory();
  try {
    const prepared = await prepare(
      lock,
      root,
      storageClass,
      consoleUrl,
      authEnvironment
    );
    return {
      artifactCount: installArtifactCount(lock),
      manifestGroupCount: prepared.all.length
    };
  } finally {
    await removeDirectory(root);
  }
}

function installPreparedRelease(lock, prepared, storageClass, consoleUrl, label, progress) {
  runFoundationInstallers(lock, prepared.foundation, storageClass, consoleUrl, progress);
  applyRelease(prepared.base, label, progress);
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
  authEnvironment,
  shellTlsSecret,
  recoveryTargetSecret,
  registryCredentials,
  requiredPlatforms,
  progress
} = {}) {
  progress?.step('release lock 구조와 채널 공급망 재검증');
  validateLock(lock);
  await verifyReleaseLock(lock, {
    registryCredentials,
    requiredPlatforms,
    onProgress: (event) => reportReleaseProgress(progress, event)
  });
  promotionBlocked(lock.channel);
  progress?.done(`release=${lock.releaseDigest}`);
  progress?.step('설치 상태·endpoint·StorageClass 호환성 확인');
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
  if (storedConfig?.architecture && storedConfig.architecture !== 'supabase-data-identity+gitea-change-authority') {
    throw new Error(`Unsupported installed architecture: ${storedConfig.architecture}`);
  }
  if (storedConfig && storageClass && storedConfig.storageClass !== storageClass) {
    throw new Error(`Installation uses StorageClass ${storedConfig.storageClass}; changing it requires migration`);
  }
  const storedConsoleUrl = storedConfig?.consoleUrl ?? 'https://localhost:8090';
  const effectiveAuthEnvironment = selectAuthEnvironment(
    lock.channel,
    storedConfig?.authEnvironment ?? requestedAuthEnvironment
  );
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
    throw new Error(`Installation uses Console URL ${effectiveConsoleUrl}; changing it requires endpoint migration`);
  }
  const requestedShellTls = shellTlsSecret ? parseShellTlsSecretRef(shellTlsSecret) : undefined;
  const requestedRecoveryTarget = recoveryTargetSecret ? parseRecoveryTargetSecretRef(recoveryTargetSecret) : undefined;
  const storedShellTls = storedConfig?.shellTlsSecret
    ? parseShellTlsSecretRef(storedConfig.shellTlsSecret)
    : undefined;
  const effectiveShellTls = installed ? storedShellTls : requestedShellTls;
  if (
    installed
    && shellTlsSecret
    && shellTlsSecretRefText(requestedShellTls) !== shellTlsSecretRefText(storedShellTls)
  ) {
    throw new Error('Changing the Console external TLS source requires endpoint migration');
  }
  assertReleaseShellTlsReference(lock.channel, effectiveShellTls);
  progress?.done(
    `console=${effectiveConsoleUrl}, tls=${effectiveShellTls ? 'external' : 'managed'}`
  );
  progress?.step('Kubernetes 노드와 StorageClass 사전검증');
  const cluster = preflight({
    storageClass: storedConfig?.storageClass ?? storageClass,
    channel: lock.channel
  });
  progress?.done(`${cluster.serverVersion}, ${cluster.nodeCount} nodes, StorageClass ${cluster.storageClass}`);
  const work = await mkdtemp(join(tmpdir(), 'opensphere-setup-supabase-'));
  try {
    progress?.step('서명된 release artifact 전체 다운로드와 digest 고정 manifest 생성');
    const prepared = await prepareRelease(
      lock,
      work,
      cluster.storageClass,
      effectiveConsoleUrl,
      effectiveAuthEnvironment
    );
    progress?.done(`${installArtifactCount(lock)} artifacts, ${prepared.all.length} manifest groups`);

    const externalShellTls = effectiveShellTls
      ? readSecret(effectiveShellTls.namespace, effectiveShellTls.name)
      : undefined;
    if (externalShellTls) inspectExternalShellTlsSecret(externalShellTls, effectiveConsoleUrl);
    const externalRecoveryTarget = requestedRecoveryTarget
      ? readSecret(requestedRecoveryTarget.namespace, requestedRecoveryTarget.name)
      : undefined;
    if (externalRecoveryTarget) inspectRecoveryTarget(externalRecoveryTarget);

    progress?.step('관리 namespace와 GHCR image pull 경로 준비');
    for (const namespace of MANAGED_NAMESPACES) {
      ensureNamespace(namespace);
      progress?.item('namespace', namespace);
    }
    const registry = ensureRegistryPullSecrets(lock, registryCredentials);
    progress?.done(`GHCR credentials=${registry.credentialSource}`);

    if (externalRecoveryTarget) {
      progress?.step('외부 S3 recovery target을 데이터·변경·격리 drill namespace에 최소 복제');
      for (const namespace of ['opensphere-console-data', 'opensphere-console-change', 'opensphere-console-recovery']) {
        ensureRecoveryTargetSecret(namespace, externalRecoveryTarget);
      }
      progress?.done('Recovery target Secret 준비 (백업 Job은 Change Control 승인 전 suspend)');
    } else {
      progress?.item('Recovery', '외부 recovery target 미지정 — backup/drill Job은 fail-closed 상태로 유지');
    }

    progress?.step('Console HTTPS 인증서와 TLS Secret 준비');
    recordInstallationState(
      lock,
      cluster.storageClass,
      initialAdmin,
      effectiveConsoleUrl,
      effectiveAuthEnvironment,
      shellTlsSecretRefText(effectiveShellTls)
    );

    const certificateGenerator = await materializeRuntimeAsset('New-Certificates.ps1', HERE);
    try {
      run('pwsh', [
        '-NoProfile', '-NonInteractive', '-File', certificateGenerator.path,
        '-OutputDirectory', work,
        '-DnsNames', new URL(effectiveConsoleUrl).hostname
      ]);
    } finally {
      await certificateGenerator.cleanup();
    }
    const certificate = join(work, 'tls.crt');
    const key = join(work, 'tls.key');
    const ca = join(work, 'ca.crt');
    if (externalShellTls) ensureExternalShellTlsSecret(effectiveShellTls, externalShellTls);
    else ensureTlsSecret('opensphere-console', 'shell-tls', certificate, key, ca);

    const hostname = new URL(effectiveConsoleUrl).hostname;
    if (
      !externalShellTls
      && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
      && lock.channel === 'edge'
      && effectiveAuthEnvironment === 'development'
      && process.platform === 'win32'
    ) {
      const localCa = join(work, 'opensphere-local-development-ca.crt');
      await writeFile(localCa, await readFile(ca, 'utf8'), 'utf8');
      const caInstaller = await materializeRuntimeAsset('Install-LocalDevelopmentCa.ps1', HERE);
      try {
        run('pwsh', [
          '-NoProfile', '-NonInteractive', '-File', caInstaller.path,
          '-CertificatePath', localCa
        ]);
      } finally {
        await caInstaller.cleanup();
      }
      progress?.item('신뢰', 'localhost 개발 CA를 현재 Windows 사용자 인증서 저장소에 등록');
    }
    progress?.done(externalShellTls ? shellTlsSecretRefText(effectiveShellTls) : 'managed shell-tls');

    progress?.step('내부 runtime Secret과 설치 상태 기록');
    ensureGenericSecret('opensphere-console', 'opensphere-console-cli-runtime', {
      'jwt-secret': randomBytes(48).toString('base64')
    });
    ensureGenericSecret('opensphere-console', 'opensphere-notification-runtime', {
      'encryption-key': randomBytes(32).toString('base64'),
      'internal-token': hex(32),
      'event-token': hex(32)
    });
    ensureGenericSecret('opensphere-console', 'opensphere-external-channel-runtime', {
      'credential-encryption-key': randomBytes(32).toString('base64'),
      'backup-encryption-key': randomBytes(32).toString('base64'),
      'internal-token': hex(32)
    });
    progress?.done('CLI·notification·external-channel runtime Secret 준비');

    progress?.step('Supabase·Gitea foundation 및 OpenSphere workload 적용');
    installPreparedRelease(
      lock,
      prepared,
      cluster.storageClass,
      effectiveConsoleUrl,
      '적용',
      progress
    );
    recordInitialAdmin(initialAdmin, 'required');
    progress?.done('Kubernetes API 적용 완료');
    progress?.step('Supabase·Gitea·OAA·Main Shell rollout 대기');
    waitForCoreRollouts(progress);
    progress?.done('핵심 workload Ready');

    progress?.step('Pod·Service·runtime image·초기 관리자 상태 최종 검증');
    const evidence = await verifyInstallation(lock, {
      requireZeroRestarts,
      consoleUrl: effectiveConsoleUrl,
      requireRecoveryDrill: false
    });
    recordReleaseInventory(lock, releaseResourceInventory(prepared.all));
    progress?.done(`${evidence.podCount} pods, ${evidence.serviceCount} services`);
    progress?.step('최초 관리자 onboarding 인계');
    if (openOnboarding) {
      openBrowser(effectiveConsoleUrl);
      progress?.item('필요', 'Supabase 최초 관리자 Wizard가 브라우저에 열렸습니다.');
    } else {
      progress?.item('필요', `${effectiveConsoleUrl} 에 접속해 Supabase 최초 관리자 Wizard를 완료하세요.`);
    }
    progress?.done(effectiveConsoleUrl);
    return {
      lock,
      evidence,
      consoleUrl: effectiveConsoleUrl,
      setupRequired: evidence.backend.initialOperatorState === 'required',
      temporaryDirectory: keepTemporaryFiles ? work : undefined
    };
  } finally {
    if (!keepTemporaryFiles) await rm(work, { recursive: true, force: true });
  }
}

export async function upgrade(
  previousLock,
  targetLock,
  { storageClass, consoleUrl, registryCredentials, requiredPlatforms, runtime = {} } = {}
) {
  validateLock(previousLock, { allowLegacyComponentSet: true });
  validateLock(targetLock);
  promotionBlocked(targetLock.channel);
  const operations = {
    readInstallationLock,
    readInstallationConfig,
    verifyReleaseLock,
    preflight,
    ensureRegistryPullSecrets,
    prepareRelease,
    installPreparedRelease,
    waitForCoreRollouts,
    verifyInstallation,
    recordInstallationState,
    readReleaseInventory,
    releaseResourceInventory,
    pruneReleaseResources,
    recordReleaseInventory,
    ensureManagedNamespaces: () => {
      for (const namespace of MANAGED_NAMESPACES) ensureNamespace(namespace);
    },
    ...runtime
  };
  await Promise.all([
    operations.verifyReleaseLock(previousLock, {
      registryCredentials,
      requiredPlatforms,
      allowLegacyComponentSet: true
    }),
    operations.verifyReleaseLock(targetLock, { registryCredentials, requiredPlatforms })
  ]);
  const installed = operations.readInstallationLock();
  if (!installed || installed.releaseDigest !== previousLock.releaseDigest) {
    throw new Error('Cluster release lock changed before the upgrade transaction started');
  }
  const config = operations.readInstallationConfig();
  if (!config || config.architecture !== 'supabase-data-identity+gitea-change-authority') {
    throw new Error('Upgrade requires a managed Supabase/Gitea installation');
  }
  if (storageClass && storageClass !== config.storageClass) {
    throw new Error(`Installation uses StorageClass ${config.storageClass}; changing it requires migration`);
  }
  const effectiveConsoleUrl = normalizeConsoleUrl(config.consoleUrl);
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== effectiveConsoleUrl) {
    throw new Error(`Installation uses Console URL ${effectiveConsoleUrl}; changing it requires endpoint migration`);
  }
  if (previousLock.releaseDigest === targetLock.releaseDigest) {
    return {
      changed: false,
      lock: previousLock,
      consoleUrl: effectiveConsoleUrl,
      evidence: await operations.verifyInstallation(previousLock, { consoleUrl: effectiveConsoleUrl })
    };
  }
  operations.preflight({ storageClass: config.storageClass, channel: targetLock.channel });
  operations.ensureManagedNamespaces();
  operations.ensureRegistryPullSecrets(targetLock, registryCredentials);
  const initialAdmin = config.initialAdmin;
  const targetWork = await mkdtemp(join(tmpdir(), 'opensphere-upgrade-target-'));
  const rollbackWork = await mkdtemp(join(tmpdir(), 'opensphere-upgrade-rollback-'));
  try {
    console.log('[준비] 대상 release와 이전 release rollback artifact 검증');
    const [target, rollback] = await Promise.all([
      operations.prepareRelease(
        targetLock, targetWork, config.storageClass, effectiveConsoleUrl, config.authEnvironment
      ),
      operations.prepareRelease(
        previousLock, rollbackWork, config.storageClass, effectiveConsoleUrl, config.authEnvironment
      )
    ]);
    const previousInventory = operations.readReleaseInventory()
      ?? operations.releaseResourceInventory(rollback.all);
    const targetInventory = operations.releaseResourceInventory(target.all);
    try {
      operations.installPreparedRelease(
        targetLock, target, config.storageClass, effectiveConsoleUrl, '업그레이드'
      );
      operations.recordInstallationState(
        targetLock,
        config.storageClass,
        initialAdmin,
        effectiveConsoleUrl,
        config.authEnvironment,
        config.shellTlsSecret
      );
      operations.waitForCoreRollouts();
      const evidence = await operations.verifyInstallation(targetLock, {
        consoleUrl: effectiveConsoleUrl,
        requireZeroRestarts: false
      });
      operations.pruneReleaseResources(previousInventory, targetInventory);
      operations.recordReleaseInventory(targetLock, targetInventory);
      return {
        changed: true,
        lock: targetLock,
        consoleUrl: effectiveConsoleUrl,
        evidence
      };
    } catch (upgradeError) {
      console.error(`[롤백] upgrade 검증 실패: ${upgradeError.message}`);
      try {
        operations.installPreparedRelease(
          previousLock, rollback, config.storageClass, effectiveConsoleUrl, '롤백'
        );
        operations.recordInstallationState(
          previousLock,
          config.storageClass,
          initialAdmin,
          effectiveConsoleUrl,
          config.authEnvironment,
          config.shellTlsSecret
        );
        operations.waitForCoreRollouts();
        await operations.verifyInstallation(previousLock, {
          consoleUrl: effectiveConsoleUrl,
          requireZeroRestarts: false,
          mode: 'rollback'
        });
        operations.pruneReleaseResources(targetInventory, previousInventory);
        operations.recordReleaseInventory(previousLock, previousInventory);
      } catch (rollbackError) {
        throw new Error(`Upgrade failed (${upgradeError.message}); rollback also failed (${rollbackError.message})`);
      }
      throw new Error(`Upgrade failed and the previous release was restored: ${upgradeError.message}`);
    }
  } finally {
    await Promise.all([
      rm(targetWork, { recursive: true, force: true }),
      rm(rollbackWork, { recursive: true, force: true })
    ]);
  }
}
