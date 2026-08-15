import { createHash, randomBytes } from 'node:crypto';
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
  RELEASE_SCOPE_COMPONENT,
  validateLock,
  validateReleaseTransition,
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
import { ensurePlatformReleaseAuthorityTls } from './platform-release-authority-tls.mjs';
import { cleanupBootstrapAInitializer } from './platform-release-bootstrap-cleanup.mjs';
import { projectBootstrapInitializerManifest } from './platform-release-bootstrap-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = 'https://raw.githubusercontent.com/opensphere-platform/OpenSphere-console';
const RELEASE_INVENTORY_CONFIGMAP = 'opensphere-release-inventory';
const LEGACY_RECOVERY_MIGRATION = 'backend/supabase/migrations/0026_schema_migration_ledger.sql';
const EXTERNAL_CHANNEL_REASON_POLICY_MIGRATION = 'backend/supabase/migrations/0027_external_channel_reason_policy.sql';
const CHANGE_RECONCILE_RETRY_MIGRATION = 'backend/supabase/migrations/0028_change_reconcile_retry.sql';
const BROWSER_SESSION_BASELINE_MIGRATION = 'backend/supabase/migrations/0029_browser_session_and_baseline_monitoring.sql';
const CEPH_DATA_PATH_RUNTIME_MIGRATION = 'backend/supabase/migrations/0030_ceph_data_path_verification_runtime.sql';
const FOUNDATION_BOOTSTRAP_MIGRATION = 'backend/supabase/migrations/0031_foundation_bootstrap_consumer.sql';
const AUDIT_EVENT_LEDGER_CHAIN_MIGRATION = 'backend/supabase/migrations/0032_audit_event_ledger_chain.sql';
const PLATFORM_RELEASE_CONSUMER_MIGRATION = 'backend/supabase/migrations/0033_platform_release_consumer.sql';
const MODULE_OPERATION_LEDGER_MIGRATION = 'backend/supabase/migrations/0035_module_operation_ledger.sql';
const PLATFORM_SUPPORT_OBSERVABILITY_MIGRATION = 'backend/supabase/migrations/0036_platform_support_observability_permissions.sql';
const BROWSER_SESSION_EXPIRY_MIGRATION = 'backend/supabase/migrations/0037_browser_session_expiry_evidence.sql';
const OAA_WATCH_CURSOR_STATUS_MIGRATION = 'backend/supabase/migrations/0038_oaa_watch_cursor_status_vocabulary.sql';
const AUDIT_LEDGER_INTEGRITY_MIGRATION = 'backend/supabase/migrations/0039_audit_ledger_integrity.sql';
const APPROVAL_OUTCOME_LEDGER_MIGRATION = 'backend/supabase/migrations/0040_approval_outcome_ledger.sql';
const AGENT_ACTION_LEDGER_MIGRATION = 'backend/supabase/migrations/0041_agent_action_ledger.sql';
const FOUNDATION_BOOTSTRAP_CATALOG_MIRROR_MIGRATION = 'backend/supabase/migrations/0042_foundation_bootstrap_catalog_mirror.sql';
const EXTERNAL_BACKUP_S3_PROFILES_MIGRATION = 'backend/supabase/migrations/0043_external_backup_s3_compatible_profiles.sql';
const EXTERNAL_BACKUP_TLS_TRUST_MIGRATION = 'backend/supabase/migrations/0044_external_backup_target_tls_trust.sql';
const LEGACY_ROLLBACK_OPTIONAL_ARTIFACTS = new Set([
  EXTERNAL_CHANNEL_REASON_POLICY_MIGRATION,
  CHANGE_RECONCILE_RETRY_MIGRATION,
  BROWSER_SESSION_BASELINE_MIGRATION,
  CEPH_DATA_PATH_RUNTIME_MIGRATION,
  FOUNDATION_BOOTSTRAP_MIGRATION,
  AUDIT_EVENT_LEDGER_CHAIN_MIGRATION,
  PLATFORM_RELEASE_CONSUMER_MIGRATION,
  AUDIT_LEDGER_INTEGRITY_MIGRATION,
  APPROVAL_OUTCOME_LEDGER_MIGRATION,
  AGENT_ACTION_LEDGER_MIGRATION,
  FOUNDATION_BOOTSTRAP_CATALOG_MIRROR_MIGRATION,
  MODULE_OPERATION_LEDGER_MIGRATION,
  PLATFORM_SUPPORT_OBSERVABILITY_MIGRATION,
  BROWSER_SESSION_EXPIRY_MIGRATION,
  OAA_WATCH_CURSOR_STATUS_MIGRATION,
  EXTERNAL_BACKUP_S3_PROFILES_MIGRATION,
  EXTERNAL_BACKUP_TLS_TRUST_MIGRATION
]);
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
  'uipluginregistrations.plugins.opensphere.io',
  'foundationmodels.foundation.opensphere.io',
  'foundationmoduledescriptors.foundation.opensphere.io',
  'foundationclaims.foundation.opensphere.io',
  'foundationbindings.foundation.opensphere.io',
  'identitydirectoryclaims.foundation.opensphere.io',
  'identitydirectorybindings.foundation.opensphere.io'
]);

export const MANAGED_CLUSTER_RBAC = Object.freeze([
  'clusterrolebinding/dupa-module-profile-installer',
  'clusterrolebinding/dupa-console-evidence-reader',
  'clusterrolebinding/dupa-clidownload-reader',
  'clusterrolebinding/opensphere-console-backend',
  'clusterrolebinding/opensphere-console-oaa-gateway-environment-reader',
  'clusterrolebinding/foundation-bootstrap-reconciler',
  'clusterrolebinding/foundation-control-plane-identity-directory',
  'clusterrolebinding/foundation-control-plane-core',
  'clusterrole/opensphere-module-cluster-observer-v1',
  'clusterrole/opensphere-module-cluster-his-manager-v1',
  'clusterrole/opensphere-module-cluster-infrastructure-manager-v1',
  'clusterrole/dupa-module-profile-installer',
  'clusterrole/dupa-console-evidence-reader',
  'clusterrole/dupa-clidownload-reader',
  'clusterrole/opensphere-console-backend',
  'clusterrole/opensphere-console-oaa-gateway-environment-reader',
  'clusterrole/foundation-bootstrap-reconciler',
  'clusterrole/foundation-control-plane-identity-directory',
  'clusterrole/foundation-control-plane-core'
]);

// These resources are cluster-scoped, so namespace deletion cannot remove
// them. Bindings are deliberately deleted before their policies.
export const MANAGED_CLUSTER_POLICIES = Object.freeze([
  'validatingadmissionpolicybinding/foundation-bootstrap-closed-catalog',
  'validatingadmissionpolicy/foundation-bootstrap-closed-catalog',
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

export const SUPABASE_MIGRATION_MANIFEST = 'backend/supabase/migrations/manifest.json';
const MIGRATION_OWNER_COMPONENTS = Object.freeze(['console', 'backend', 'oaaGateway']);

function sha256Text(value) {
  return createHash('sha256').update(String(value).replace(/\r\n/gu, '\n'), 'utf8').digest('hex');
}

export function parseSupabaseMigrationManifest(value) {
  let manifest;
  try { manifest = typeof value === 'string' ? JSON.parse(value) : structuredClone(value); }
  catch { throw new Error('Supabase migration manifest is not valid JSON'); }
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    throw new Error('Unsupported Supabase migration manifest');
  }
  const ids = new Set();
  const names = new Set();
  let previous = '';
  let predecessorMigrationId = null;
  for (const entry of manifest.migrations) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/u.test(entry?.name ?? '')
        || entry.id !== entry.name.slice(0, 4)
        || entry.path !== `backend/supabase/migrations/${entry.name}`
        || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')
        || ids.has(entry.id) || names.has(entry.name) || (previous && entry.name <= previous)
        || entry.predecessorMigrationId !== predecessorMigrationId) {
      throw new Error(`Invalid or duplicate Supabase migration manifest entry: ${entry?.name ?? 'unknown'}`);
    }
    ids.add(entry.id); names.add(entry.name); previous = entry.name; predecessorMigrationId = entry.id;
  }
  const latest = manifest.migrations.at(-1).id;
  const material = manifest.migrations.map(({ id, predecessorMigrationId: predecessor, name, sha256 }) =>
    `${id}\n${predecessor ?? '-'}\n${name}\n${sha256}`).join('\n');
  const setDigest = `sha256:${sha256Text(material)}`;
  if (manifest.migrationCount !== manifest.migrations.length
      || manifest.latestMigrationId !== latest || manifest.setDigest !== setDigest) {
    throw new Error('Supabase migration manifest count/latest/set digest mismatch');
  }
  return Object.freeze({ ...manifest, migrations: Object.freeze(manifest.migrations.map(Object.freeze)) });
}

export function verifySupabaseMigrationArtifact(entry, contents) {
  if (!entry || sha256Text(contents) !== entry.sha256) {
    throw new Error(`Supabase migration digest differs from manifest: ${entry?.name ?? 'unknown'}`);
  }
  return true;
}

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
  'backend/gitea/bootstrap/install.ps1',
  'backend/gitea/bootstrap/configure-signing.ps1',
  'backend/gitea/bootstrap/control-plane-bootstrap.ps1'
]);

export const INSTALL_ARTIFACT_PATHS = Object.freeze([
  ...FOUNDATION_ARTIFACT_PATHS,
  SUPABASE_MIGRATION_MANIFEST,
  SUPABASE_MANIFEST.path,
  GITEA_MANIFEST.path,
  ...BASE_MANIFESTS.map(({ path }) => path)
]);

function isPreRecoveryRelease(lock) {
  return !lock?.components?.recovery;
}

function foundationArtifactPaths(lock) {
  return FOUNDATION_ARTIFACT_PATHS;
}

function baseManifestSpecs(lock) {
  return isPreRecoveryRelease(lock)
    ? BASE_MANIFESTS.filter(({ path }) => !LEGACY_RECOVERY_MANIFESTS.has(path))
    : BASE_MANIFESTS;
}

function manifestSpecComponents(spec) {
  return new Set((spec.replacements ?? []).map(([, component]) => component));
}

export function componentReleaseManifestSpecs(
  lock,
  changedComponents = lock.changedComponents
) {
  if (!Array.isArray(changedComponents) || changedComponents.length === 0) {
    throw new Error('Component release requires a non-empty changed component set');
  }
  const requested = new Set(changedComponents);
  const selectRequestedSpecs = (specs) => specs.flatMap((spec) => {
    const owners = [...manifestSpecComponents(spec)].filter((component) => requested.has(component));
    if (owners.length === 0) return [];
    const sourceRevisions = new Set(owners.map((component) => {
      const sourceRevision = lock.components?.[component]?.sourceRevision;
      if (!/^[a-f0-9]{40}$/u.test(sourceRevision ?? '')) {
        throw new Error(`Component release lacks a governed source revision for ${component}`);
      }
      return sourceRevision;
    }));
    if (sourceRevisions.size !== 1) {
      throw new Error(
        `Component release manifest ${spec.path} spans incompatible source revisions for: ${owners.join(', ')}`
      );
    }
    return [{ ...spec, artifactSourceRevision: [...sourceRevisions][0] }];
  });
  const foundation = selectRequestedSpecs([SUPABASE_MANIFEST, GITEA_MANIFEST]);
  const base = selectRequestedSpecs(baseManifestSpecs(lock));
  const exposed = new Set(
    [...foundation, ...base].flatMap((spec) => [...manifestSpecComponents(spec)])
  );
  const missing = changedComponents.filter((component) => !exposed.has(component));
  if (missing.length > 0) {
    throw new Error(`Component release has no governed manifest for: ${missing.join(', ')}`);
  }
  return { foundation, base };
}

function installArtifactCount(lock) {
  return foundationArtifactPaths(lock).length + 3 + baseManifestSpecs(lock).length;
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
  ['opensphere-console', 'deployment/foundation-bootstrap-reconciler', '600s'],
  ['opensphere-console', 'deployment/platform-release-reconciler', '600s'],
  ['opensphere-console', 'deployment/opensphere-notification-dispatcher', '600s'],
  ['opensphere-console', 'deployment/opensphere-external-channel-executor', '600s'],
  ['opensphere-console', 'deployment/opensphere-console-oaa-gateway', '600s'],
  ['opensphere-console', 'deployment/oaa-governed-adapter', '600s'],
  ['opensphere-console', 'deployment/opensphere-console', '600s']
]);

export const COMPONENT_ROLLOUTS = Object.freeze({
  console: [['opensphere-console', 'deployment/opensphere-console', '600s']],
  backend: [
    ['opensphere-console', 'deployment/opensphere-console-backend', '600s'],
    ['opensphere-console', 'deployment/foundation-bootstrap-reconciler', '600s'],
    ['opensphere-console', 'deployment/platform-release-reconciler', '600s'],
    ['opensphere-console', 'deployment/foundation-owner-release-reconciler', '600s']
  ],
  dupaController: [['opensphere-console', 'deployment/opensphere-console-dupa-controller', '600s']],
  oaaGateway: [['opensphere-console', 'deployment/opensphere-console-oaa-gateway', '600s']],
  oaaGovernedAdapter: [['opensphere-console', 'deployment/oaa-governed-adapter', '600s']],
  notificationDispatcher: [
    ['opensphere-console', 'deployment/opensphere-notification-dispatcher', '600s'],
    ['opensphere-console', 'deployment/opensphere-external-channel-executor', '600s']
  ],
  gitea: [['opensphere-console-change', 'deployment/opensphere-gitea', '900s']],
  giteaPostgres: [['opensphere-console-change', 'deployment/opensphere-gitea-postgres', '600s']],
  supabasePostgres: [['opensphere-console-data', 'statefulset/opensphere-supabase-postgres', '600s']],
  supabaseAuth: [['opensphere-console-data', 'deployment/opensphere-supabase-auth', '600s']],
  supabaseRest: [['opensphere-console-data', 'deployment/opensphere-supabase-rest', '600s']],
  supabaseStorage: [['opensphere-console-data', 'deployment/opensphere-supabase-storage', '600s']],
  recovery: []
});

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

function ensureFoundationDataEngineSecretAccess() {
  applyYaml(`${JSON.stringify({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: 'foundation-console-valkey-secret-manager', namespace: 'opensphere-foundation' },
    rules: [{
      apiGroups: [''], resources: ['secrets'],
      resourceNames: ['foundation-data-valkey-auth', 'rustfs-credentials'],
      verbs: ['get', 'patch']
    }]
  })}\n`);
  applyYaml(`${JSON.stringify({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: 'foundation-console-valkey-secret-manager', namespace: 'opensphere-foundation' },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'foundation-console-valkey-secret-manager' },
    subjects: [{ kind: 'ServiceAccount', name: 'opensphere-foundation', namespace: 'opensphere-console' }]
  })}\n`);
}

export function ensureFoundationDataEngineCredentials() {
  ensureGenericSecret('opensphere-foundation', 'foundation-data-valkey-auth', {
    password: randomBytes(32).toString('base64')
  });
  ensureGenericSecret('opensphere-foundation', 'rustfs-credentials', {
    access_key: `opensphere-${randomBytes(9).toString('hex')}`,
    secret_key: randomBytes(32).toString('base64url')
  });
  ensureFoundationDataEngineSecretAccess();
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

async function fetchReleaseArtifact(
  lock,
  path,
  { optional404 = false, sourceRevision = lock.sourceRevision } = {}
) {
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision ?? '')) {
    throw new Error(`Release artifact source revision is invalid for ${path}`);
  }
  const response = await fetchWithRetry(`${RAW_ROOT}/${sourceRevision}/${path}`);
  if (optional404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`Release artifact download failed (${path}): HTTP ${response.status}`);
  return response.text();
}

export function renderManifest(
  lock,
  spec,
  sourceYaml,
  storageClass,
  consoleUrl = defaultConsoleUrl('edge', 'development'),
  authEnvironment = 'development',
  { sourceRevision = lock.sourceRevision } = {}
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
  yaml = yaml.replaceAll('__OPENSPHERE_RELEASE_REVISION__', sourceRevision);
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
  authEnvironment = 'development',
  { sourceRevision = lock.sourceRevision } = {}
) {
  const sourceYaml = await fetchReleaseArtifact(lock, spec.path, { sourceRevision });
  return renderManifest(
    lock,
    spec,
    sourceYaml,
    storageClass,
    consoleUrl,
    authEnvironment,
    { sourceRevision }
  );
}

async function writeReleaseArtifact(root, path, contents) {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  return target;
}

export async function materializeSupabaseMigrationSet(
  lock,
  root,
  sourceRevision = lock.sourceRevision,
  signedEvidence = lock.releaseBom?.migrationManifest
) {
  const rawManifest = await fetchReleaseArtifact(lock, SUPABASE_MIGRATION_MANIFEST, { sourceRevision });
  const manifest = parseSupabaseMigrationManifest(rawManifest);
  if (signedEvidence) {
    const observedEvidence = {
      path: SUPABASE_MIGRATION_MANIFEST,
      sha256: `sha256:${sha256Text(rawManifest)}`,
      setDigest: manifest.setDigest,
      latestMigrationId: manifest.latestMigrationId,
      migrationCount: manifest.migrationCount,
    };
    if (Object.entries(observedEvidence).some(([key, value]) => signedEvidence[key] !== value)
        || Object.keys(signedEvidence).length !== Object.keys(observedEvidence).length) {
      throw new Error('Supabase migration manifest differs from signed Release BOM evidence');
    }
  }
  const artifacts = await Promise.all(manifest.migrations.map(async (entry) => {
    const contents = await fetchReleaseArtifact(lock, entry.path, { sourceRevision });
    verifySupabaseMigrationArtifact(entry, contents);
    return { path: entry.path, contents };
  }));
  await writeReleaseArtifact(root, SUPABASE_MIGRATION_MANIFEST, rawManifest);
  for (const artifact of artifacts) await writeReleaseArtifact(root, artifact.path, artifact.contents);
  return { manifest, sourceRevision, artifactCount: artifacts.length + 1 };
}

async function materializeFoundationInstallers(
  lock,
  root,
  storageClass,
  consoleUrl,
  authEnvironment,
  {
    optionalArtifacts = new Set(),
    migrationSourceRevision = lock.sourceRevision,
    migrationEvidence = lock.releaseBom?.migrationManifest
  } = {}
) {
  const [supabaseManifest, giteaManifest] = await Promise.all([
    fetchManifest(lock, SUPABASE_MANIFEST, storageClass, consoleUrl, authEnvironment),
    fetchManifest(lock, GITEA_MANIFEST, storageClass, consoleUrl, authEnvironment)
  ]);
  const artifacts = (await Promise.all(foundationArtifactPaths(lock).map(async (path) => {
    const contents = await fetchReleaseArtifact(lock, path, {
      optional404: optionalArtifacts.has(path)
    });
    return contents === null ? null : { path, contents };
  }))).filter(Boolean);
  for (const artifact of artifacts) await writeReleaseArtifact(root, artifact.path, artifact.contents);
  // Database expansion is forward-only. During rollback preparation, callers
  // source the immutable migration set from the target release while the
  // workloads/installers still come from the previous release. This avoids
  // requiring a newly introduced manifest in an older source revision.
  const migration = await materializeSupabaseMigrationSet(
    lock,
    root,
    migrationSourceRevision,
    migrationEvidence
  );
  await writeReleaseArtifact(root, SUPABASE_MANIFEST.path, supabaseManifest);
  await writeReleaseArtifact(root, GITEA_MANIFEST.path, giteaManifest);
  return {
    root,
    migration,
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

function runComponentMigrations(foundation, progress) {
  if (!foundation.migration) return;
  const context = process.env.OPENSPHERE_KUBE_CONTEXT || '';
  const args = [
    '-NoProfile', '-NonInteractive', '-File',
    join(foundation.root, 'backend', 'supabase', 'migrate-only.ps1'),
    '-Namespace', 'opensphere-console-data',
    '-SourceRevision', foundation.migration.sourceRevision
  ];
  if (context) args.push('-KubeContext', context);
  progress?.item('마이그레이션', `Supabase ${foundation.migration.manifest.setDigest}`);
  run('pwsh', args);
}

async function materializeBaseRelease(lock, storageClass, consoleUrl, authEnvironment) {
  return Promise.all(baseManifestSpecs(lock).map(async (spec) => ({
    path: spec.path,
    yaml: await fetchManifest(lock, spec, storageClass, consoleUrl, authEnvironment)
  })));
}

const TRUST_CONFIGMAP_PATH = 'backend/dupa-control/dupa-trusted-keys.yaml';

export function mergeTrustedKeySets(baseline = {}, existing = {}, { preserveEdgeLocal = false } = {}) {
  // Release-owned keys are authoritative. Only the constitution-defined,
  // Docker Desktop-only edge identity may survive an edge upgrade; preserving
  // arbitrary pre-existing IDs would defeat release key revocation.
  const hostLocal = preserveEdgeLocal && existing['opensphere-edge-local-v1']
    ? { 'opensphere-edge-local-v1': existing['opensphere-edge-local-v1'] }
    : {};
  return {
    ...hostLocal,
    ...baseline,
  };
}

function readTrustedKeySet() {
  try {
    const configMap = JSON.parse(kubectl([
      '-n', 'opensphere-console', 'get', 'configmap', 'dupa-trusted-keys', '-o', 'json'
    ], { capture: true }));
    return JSON.parse(String(configMap?.data?.['trusted-keys.json'] || '{}')).trustedKeys || {};
  } catch {
    return {};
  }
}

function preserveHostLocalTrustedKeys(existing) {
  const baseline = readTrustedKeySet();
  const merged = mergeTrustedKeySets(baseline, existing, { preserveEdgeLocal: true });
  if (JSON.stringify(merged) === JSON.stringify(baseline)) return;
  kubectl([
    '-n', 'opensphere-console', 'patch', 'configmap', 'dupa-trusted-keys',
    '--type', 'merge',
    '-p', JSON.stringify({
      data: {
        'trusted-keys.json': `${JSON.stringify({ trustedKeys: merged }, null, 2)}\n`
      }
    })
  ], { capture: true });
}

function applyRelease(release, label, progress, { preserveHostLocalEdgeTrust = false } = {}) {
  for (const manifest of release) {
    const hostLocalTrustedKeys = preserveHostLocalEdgeTrust && manifest.path === TRUST_CONFIGMAP_PATH
      ? readTrustedKeySet()
      : null;
    applyYaml(manifest.yaml);
    if (hostLocalTrustedKeys) preserveHostLocalTrustedKeys(hostLocalTrustedKeys);
    if (progress) progress.item(label, manifest.path);
    else console.log(`[${label}] ${manifest.path}`);
  }
}

function manifestDocuments(yaml) {
  return String(yaml)
    .split(/^---\s*$/mu)
    .map((document) => document.trim())
    .filter(Boolean);
}

function escapeExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function componentReleaseWorkloadManifests(
  lock,
  prepared,
  changedComponents = lock.changedComponents
) {
  if (!Array.isArray(changedComponents) || changedComponents.length === 0) {
    throw new Error('Component release requires a non-empty changed component set');
  }
  const sources = [...prepared.foundation.release, ...prepared.base];
  const selected = new Map();
  for (const component of changedComponents) {
    const image = lock.components?.[component]?.image;
    if (!image) throw new Error(`Component release lock lacks ${component}`);
    const imageLine = new RegExp(
      `^[ \\t]*(?:-[ \\t]*)?image:[ \\t]+["']?${escapeExpression(image)}["']?[ \\t]*(?:#.*)?$`,
      'mu'
    );
    let found = false;
    for (const source of sources) {
      const baseSpec = baseManifestSpecs(lock).find(({ path }) => path === source.path);
      const completeOwners = baseSpec ? manifestSpecComponents(baseSpec) : new Set();
      if (completeOwners.size === 1 && completeOwners.has(component)) {
        if (!imageLine.test(source.yaml)) continue;
        found = true;
        const yaml = component === 'backend'
          ? projectBootstrapInitializerManifest({
            yaml: source.yaml,
            sourceRevision: lock.sourceRevision,
            backendImage: image,
            bootstrapFrom: lock.componentPublication?.bootstrapFrom,
          }).yaml
          : source.yaml;
        selected.set(`${source.path}#complete`, {
          path: `${source.path}#${component}`,
          yaml: yaml.endsWith('\n') ? yaml : `${yaml}\n`
        });
        continue;
      }
      manifestDocuments(source.yaml).forEach((document, index) => {
        if (!imageLine.test(document)) return;
        found = true;
        selected.set(`${source.path}#${index}`, {
          path: `${source.path}#${component}`,
          yaml: `${document}\n`
        });
      });
    }
    if (!found) {
      throw new Error(`Component release artifact does not expose workload image ${component}`);
    }
  }
  return [...selected.values()];
}

function installPreparedComponentRelease(
  lock,
  prepared,
  _storageClass,
  _consoleUrl,
  label,
  changedComponents = lock.changedComponents,
  progress,
  { applyMigrations = true } = {}
) {
  if (applyMigrations) runComponentMigrations(prepared.foundation, progress);
  const release = componentReleaseWorkloadManifests(lock, prepared, changedComponents);
  applyRelease(release, label, progress);
}

function inventoryKey(resource) {
  return [resource.apiVersion, resource.kind, resource.namespace ?? '', resource.name].join('|');
}

export function releaseResourceInventory(release, kubectlFn = kubectl) {
  const inventory = new Map();
  for (const manifest of release) {
    // Inventory only needs manifest decoding and client-side defaulting. Using
    // `apply --dry-run=client` unnecessarily calculates a three-way patch
    // against live objects and can fail on an older CRD whose structural
    // schema differs from the target release before the upgrade starts. A
    // JSONPath record format is used because `kubectl create -o json` emits
    // adjacent JSON objects (not a List) for multi-document YAML.
    const records = kubectlFn([
      'create', '--dry-run=client', '--validate=false', '-f', '-',
      '-o', 'jsonpath={.apiVersion}{"\\t"}{.kind}{"\\t"}{.metadata.namespace}{"\\t"}{.metadata.name}{"\\n"}'
    ], { capture: true, input: manifest.yaml });
    for (const record of records.split(/\r?\n/u)) {
      if (!record) continue;
      const [apiVersion = '', kind = '', namespace = '', name = ''] = record.split('\t');
      if (!PRUNABLE_MANIFEST_KINDS.has(kind) || !name) continue;
      const resource = {
        apiVersion,
        kind,
        name,
        ...(namespace ? { namespace } : {})
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

export function workloadReady(workload) {
  const desired = Number(workload.spec?.replicas ?? 1);
  const observedGeneration = Number(workload.status?.observedGeneration ?? 0);
  const generation = Number(workload.metadata?.generation ?? 0);
  if (observedGeneration < generation) return false;

  const ready = Number(workload.status?.readyReplicas ?? 0) === desired;
  const updated = Number(workload.status?.updatedReplicas ?? 0) === desired;
  if (!ready || !updated) return false;

  const kind = String(workload.kind ?? '').toLowerCase();
  if (kind === 'deployment') {
    return Number(workload.status?.availableReplicas ?? 0) === desired
      && Number(workload.status?.unavailableReplicas ?? 0) === 0;
  }
  if (kind === 'statefulset') {
    return Number(workload.status?.currentReplicas ?? 0) === desired
      && Boolean(workload.status?.currentRevision)
      && workload.status.currentRevision === workload.status.updateRevision;
  }
  return true;
}

function waitForRollouts(rollouts, progress) {
  for (const [namespace, resource, timeout] of rollouts) {
    progress?.wait(`${namespace}/${resource} rollout`, `timeout=${timeout}`);
    const deadline = Date.now() + Number.parseInt(timeout, 10) * 1000;
    while (true) {
      const workload = JSON.parse(kubectl(['-n', namespace, 'get', resource, '-o', 'json'], { capture: true }));
      if (workloadReady(workload)) {
        progress?.item('준비', `${namespace}/${resource}`);
        break;
      }
      const selector = Object.entries(workload.spec?.selector?.matchLabels ?? {})
        .map(([key, value]) => `${key}=${value}`).join(',');
      const pods = JSON.parse(kubectl([
        '-n', namespace, 'get', 'pods', ...(selector ? ['-l', selector] : []), '-o', 'json'
      ], { capture: true }));
      const terminal = terminalPodError(pods);
      if (terminal) throw new Error(`${resource} has a terminal pod error: ${terminal}`);
      if (Date.now() >= deadline) {
        throw new Error(`${resource} did not reach its current generation and exact replica readiness within ${timeout}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
  }
}

function waitForCoreRollouts(progress) {
  waitForRollouts(CORE_ROLLOUTS, progress);
}

export function waitForComponentRollouts(changedComponents, progress) {
  const unique = new Map();
  for (const component of changedComponents) {
    const rollouts = COMPONENT_ROLLOUTS[component];
    if (!rollouts) throw new Error(`Component rollout contract is missing for ${component}`);
    for (const rollout of rollouts) unique.set(`${rollout[0]}|${rollout[1]}`, rollout);
  }
  waitForRollouts([...unique.values()], progress);
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
  return lock ? validateLock(lock, {
    allowLegacyComponentSet: true,
    allowUnsignedComponentBootstrapBase: true
  }) : null;
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
  authEnvironment,
  options = {}
) {
  const [foundation, base] = await Promise.all([
    materializeFoundationInstallers(lock, root, storageClass, consoleUrl, authEnvironment, options),
    materializeBaseRelease(lock, storageClass, consoleUrl, authEnvironment)
  ]);
  return { foundation, base, all: [...foundation.release, ...base] };
}

export async function prepareComponentRelease(
  lock,
  root,
  storageClass,
  consoleUrl,
  authEnvironment,
  {
    changedComponents = lock.changedComponents,
    includeMigrations = true
  } = {}
) {
  const specs = componentReleaseManifestSpecs(lock, changedComponents);
  const migrationOwners = includeMigrations
    ? changedComponents.filter((component) => MIGRATION_OWNER_COMPONENTS.includes(component))
    : [];
  const migrationSourceRevisions = new Set(migrationOwners.map((component) => lock.components?.[component]?.sourceRevision));
  if (migrationSourceRevisions.has(undefined) || migrationSourceRevisions.has(null) || migrationSourceRevisions.size > 1) {
    throw new Error('Component-scoped migrations require one exact Console source revision');
  }
  const migrationSourceRevision = migrationSourceRevisions.size === 1 ? [...migrationSourceRevisions][0] : null;
  if (migrationSourceRevision && !/^[a-f0-9]{40}$/u.test(migrationSourceRevision)) {
    throw new Error('Component-scoped migrations lack an immutable source revision');
  }
  const [foundationRelease, base] = await Promise.all([
    Promise.all(specs.foundation.map(async (spec) => ({
      path: spec.path,
      yaml: await fetchManifest(
        lock,
        spec,
        storageClass,
        consoleUrl,
        authEnvironment,
        { sourceRevision: spec.artifactSourceRevision }
      )
    }))),
    Promise.all(specs.base.map(async (spec) => ({
      path: spec.path,
      yaml: await fetchManifest(
        lock,
        spec,
        storageClass,
        consoleUrl,
        authEnvironment,
        { sourceRevision: spec.artifactSourceRevision }
      )
    })))
  ]);
  let migration = null;
  if (migrationSourceRevision) {
    const script = await fetchReleaseArtifact(lock, 'backend/supabase/migrate-only.ps1', {
      sourceRevision: migrationSourceRevision
    });
    await writeReleaseArtifact(root, 'backend/supabase/migrate-only.ps1', script);
    migration = await materializeSupabaseMigrationSet(lock, root, migrationSourceRevision);
  }
  const foundation = { root, release: foundationRelease, migration };
  return { foundation, base, all: [...foundationRelease, ...base] };
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
      artifactCount: installArtifactCount(lock) + Number(prepared.foundation?.migration?.manifest?.migrationCount || 0),
      manifestGroupCount: prepared.all.length
    };
  } finally {
    await removeDirectory(root);
  }
}

function installPreparedRelease(lock, prepared, storageClass, consoleUrl, label, progress) {
  runFoundationInstallers(lock, prepared.foundation, storageClass, consoleUrl, progress);
  applyRelease(prepared.base, label, progress, {
    preserveHostLocalEdgeTrust: lock.channel === 'edge'
  });
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
  if (lock.releaseScope === RELEASE_SCOPE_COMPONENT) {
    throw new Error('Component release locks are upgrade-only and cannot bootstrap a cluster');
  }
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
    progress?.done(`${installArtifactCount(lock) + Number(prepared.foundation?.migration?.manifest?.migrationCount || 0)} artifacts, ${prepared.all.length} manifest groups`);

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
    // Foundation Valkey는 Console/Control Plane에 namespace-wide Secret create
    // 권한을 주지 않는다. 플랫폼 installer가 exact Secret을 최초 1회 만들고,
    // ensureGenericSecret의 merge 규칙으로 resume·reboot·upgrade 시 값을 보존한다.
    ensureFoundationDataEngineCredentials();
    progress?.done('CLI·notification·external-channel runtime 및 Valkey·RustFS exact Secret·RBAC 준비');

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
  validateLock(previousLock, {
    allowLegacyComponentSet: true,
    allowUnsignedComponentBootstrapBase: true
  });
  validateLock(targetLock);
  if (previousLock.releaseDigest !== targetLock.releaseDigest) {
    validateReleaseTransition(previousLock, targetLock);
  }
  promotionBlocked(targetLock.channel);
  const operations = {
    readInstallationLock,
    readInstallationConfig,
    verifyReleaseLock,
    preflight,
    ensureRegistryPullSecrets,
    prepareRelease,
    prepareComponentRelease,
    installPreparedRelease,
    installPreparedComponentRelease,
    waitForCoreRollouts,
    waitForComponentRollouts,
    verifyInstallation,
    recordInstallationState,
    readReleaseInventory,
    releaseResourceInventory,
    pruneReleaseResources,
    recordReleaseInventory,
    ensureManagedNamespaces: () => {
      for (const namespace of MANAGED_NAMESPACES) ensureNamespace(namespace);
    },
    ensurePlatformReleaseAuthorityTls,
    cleanupBootstrapAInitializer,
    ...runtime
  };
  await Promise.all([
    operations.verifyReleaseLock(previousLock, {
      registryCredentials,
      requiredPlatforms,
      allowLegacyComponentSet: true,
      allowUnsignedComponentBootstrapBase: true,
      allowRetiredEdgeRollback: true
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
    let evidence = await operations.verifyInstallation(previousLock, { consoleUrl: effectiveConsoleUrl });
    if (targetLock.releaseScope === RELEASE_SCOPE_COMPONENT
        && targetLock.changedComponents?.includes('backend')
        && targetLock.componentPublication?.bootstrapFrom) {
      const authority = await operations.ensurePlatformReleaseAuthorityTls();
      const bootstrapAInitializerCleanup = await operations.cleanupBootstrapAInitializer({
        bootstrapFrom: targetLock.componentPublication.bootstrapFrom,
        targetReleaseDigest: targetLock.releaseDigest,
        authority,
      });
      evidence = { ...evidence, bootstrapAInitializerCleanup };
    }
    return {
      changed: false,
      lock: targetLock,
      consoleUrl: effectiveConsoleUrl,
      evidence
    };
  }
  operations.preflight({ storageClass: config.storageClass, channel: targetLock.channel });
  operations.ensureManagedNamespaces();
  operations.ensureRegistryPullSecrets(targetLock, registryCredentials);
  const initialAdmin = config.initialAdmin;
  const componentTransition = targetLock.releaseScope === RELEASE_SCOPE_COMPONENT;
  const changedComponents = componentTransition ? targetLock.changedComponents : [];
  const targetWork = await mkdtemp(join(tmpdir(), 'opensphere-upgrade-target-'));
  const rollbackWork = await mkdtemp(join(tmpdir(), 'opensphere-upgrade-rollback-'));
  try {
    console.log('[준비] 대상 release와 이전 release rollback artifact 검증');
    const [target, rollback] = componentTransition
      ? await Promise.all([
        operations.prepareComponentRelease(
          targetLock,
          targetWork,
          config.storageClass,
          effectiveConsoleUrl,
          config.authEnvironment,
          { changedComponents, includeMigrations: true }
        ),
        operations.prepareComponentRelease(
          previousLock,
          rollbackWork,
          config.storageClass,
          effectiveConsoleUrl,
          config.authEnvironment,
          { changedComponents, includeMigrations: false }
        )
      ])
      : await Promise.all([
        operations.prepareRelease(
          targetLock, targetWork, config.storageClass, effectiveConsoleUrl, config.authEnvironment
        ),
        operations.prepareRelease(
          previousLock,
          rollbackWork,
          config.storageClass,
          effectiveConsoleUrl,
          config.authEnvironment,
          {
            optionalArtifacts: LEGACY_ROLLBACK_OPTIONAL_ARTIFACTS,
            migrationSourceRevision: targetLock.sourceRevision,
            migrationEvidence: targetLock.releaseBom?.migrationManifest
          }
        )
      ]);
    if (componentTransition && changedComponents.includes('backend')) {
      const boundMigrationSetDigest = targetLock.componentPublication?.migrationSetDigest;
      const materializedMigrationSetDigest = target.foundation?.migration?.manifest?.setDigest;
      if (!/^sha256:[a-f0-9]{64}$/.test(boundMigrationSetDigest ?? '')
          || materializedMigrationSetDigest !== boundMigrationSetDigest) {
        throw new Error('Backend component publication migration set differs from the materialized target migrations');
      }
    }
    const recordedInventory = operations.readReleaseInventory();
    if (componentTransition && !recordedInventory) {
      throw new Error('Component release requires the existing complete release inventory');
    }
    const previousInventory = recordedInventory
      ?? operations.releaseResourceInventory(rollback.all);
    const targetInventory = componentTransition
      ? previousInventory
      : operations.releaseResourceInventory(target.all);
    let bootstrapACleanupStarted = false;
    try {
      if (componentTransition) {
        if (changedComponents.includes('backend')) {
          await operations.ensurePlatformReleaseAuthorityTls();
        }
        operations.installPreparedComponentRelease(
          targetLock,
          target,
          config.storageClass,
          effectiveConsoleUrl,
          '업그레이드',
          changedComponents
        );
      } else {
        operations.installPreparedRelease(
          targetLock, target, config.storageClass, effectiveConsoleUrl, '업그레이드'
        );
      }
      operations.recordInstallationState(
        targetLock,
        config.storageClass,
        initialAdmin,
        effectiveConsoleUrl,
        config.authEnvironment,
        config.shellTlsSecret
      );
      if (componentTransition) operations.waitForComponentRollouts(changedComponents);
      else operations.waitForCoreRollouts();
      let evidence = await operations.verifyInstallation(targetLock, {
        consoleUrl: effectiveConsoleUrl,
        requireZeroRestarts: false,
        componentSelection: componentTransition ? changedComponents : null
      });
      let bootstrapAInitializerCleanup;
      if (componentTransition && changedComponents.includes('backend')
          && targetLock.componentPublication?.bootstrapFrom) {
        const authority = await operations.ensurePlatformReleaseAuthorityTls();
        bootstrapACleanupStarted = true;
        bootstrapAInitializerCleanup = await operations.cleanupBootstrapAInitializer({
          bootstrapFrom: targetLock.componentPublication.bootstrapFrom,
          targetReleaseDigest: targetLock.releaseDigest,
          authority,
        });
        evidence = { ...evidence, bootstrapAInitializerCleanup };
      }
      if (!componentTransition) {
        operations.pruneReleaseResources(previousInventory, targetInventory);
      }
      operations.recordReleaseInventory(targetLock, targetInventory);
      return {
        changed: true,
        lock: targetLock,
        consoleUrl: effectiveConsoleUrl,
        evidence
      };
    } catch (upgradeError) {
      if (bootstrapACleanupStarted) {
        throw new Error(`NeedsAttention: Bootstrap A initializer cleanup did not complete; rollback was not attempted and the retained TLS authority must not be recreated (${upgradeError.message})`);
      }
      console.error(`[롤백] upgrade 검증 실패: ${upgradeError.message}`);
      try {
        if (componentTransition) {
          operations.installPreparedComponentRelease(
            previousLock,
            rollback,
            config.storageClass,
            effectiveConsoleUrl,
            '롤백',
            changedComponents,
            undefined,
            { applyMigrations: false }
          );
        } else {
          operations.installPreparedRelease(
            previousLock, rollback, config.storageClass, effectiveConsoleUrl, '롤백'
          );
        }
        operations.recordInstallationState(
          previousLock,
          config.storageClass,
          initialAdmin,
          effectiveConsoleUrl,
          config.authEnvironment,
          config.shellTlsSecret
        );
        if (componentTransition) operations.waitForComponentRollouts(changedComponents);
        else operations.waitForCoreRollouts();
        await operations.verifyInstallation(previousLock, {
          consoleUrl: effectiveConsoleUrl,
          requireZeroRestarts: false,
          mode: 'rollback',
          componentSelection: componentTransition ? changedComponents : null
        });
        if (!componentTransition) {
          operations.pruneReleaseResources(targetInventory, previousInventory);
        }
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
