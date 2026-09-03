import {KUBERNETES_EGRESS_SLOT,discoverRegistryKubernetesEgress,renderRegistryKubernetesEgress} from './registry-runtime-access.mjs';
import {setTimeout as registryDelay} from 'node:timers/promises';
import {REGISTRY_AUTH_SECRET,REGISTRY_AUTH_CONTRACT,initialRegistryState,registryStateSecret,parseRegistryState,requiredImages,pullSecretData,GENERATION_ANNOTATION,validateCredential} from './registry-lifecycle-contract.mjs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl, run } from './process.mjs';
import { preflight } from './preflight.mjs';
import { fetchWithRetry } from './http.mjs';
import { sourceArtifactRequest } from './source-artifact-credential.mjs';
import {
  hostRegistryCredentials,
  isLocalEdgeLock,
  RELEASE_SCOPE_COMPONENT,
  releaseResponsibilityProfile,
  validateLock,
  validateReleaseTransition,
  verifyReleaseLock
} from './release.mjs';
import { verifyInstallation } from './verify.mjs';
import {
  BASELINE_OBSERVABILITY_REQUIREMENT,
  INSTALLATION_PHASES,
  MANAGED_CLUSTER_SCOPED_RESOURCES,
  MANAGED_NAMESPACES
} from './installation-contract.mjs';
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
import { reportReleaseProgress } from './progress.mjs';
import { materializeRuntimeAsset } from './runtime-assets.mjs';
import {
  CANONICAL_AGENT_NAMESPACE,
  hasLegacyInstalledAgentIdentity,
  installedNameForCanonicalComponent,
  isAgentIdentityCutover,
  LEGACY_INSTALLED_AGENT_MANIFESTS,
  LEGACY_INSTALLED_AGENT_NAMESPACE,
  LEGACY_INSTALLED_AGENT_ROLLOUTS
} from './release-agent-identity-cutover.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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
const LEGACY_AGENT_WATCH_CURSOR_STATUS_MIGRATION = 'backend/supabase/migrations/0038_oaa_watch_cursor_status_vocabulary.sql';
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
  LEGACY_AGENT_WATCH_CURSOR_STATUS_MIGRATION,
  EXTERNAL_BACKUP_S3_PROFILES_MIGRATION,
  EXTERNAL_BACKUP_TLS_TRUST_MIGRATION
]);
const LEGACY_RECOVERY_MANIFESTS = new Set([
  'backend/recovery/recovery-jobs.yaml',
  'deploy/console-image-admission-policy.yaml'
]);
const PRUNABLE_MANIFEST_KINDS = new Set([
  'ClusterRole', 'ClusterRoleBinding', 'ConfigMap', 'CronJob', 'CustomResourceDefinition',
  'DaemonSet', 'Deployment', 'Job',
  'NetworkPolicy', 'PodDisruptionBudget', 'Role', 'RoleBinding', 'Service',
  'ServiceAccount', 'StatefulSet', 'ValidatingAdmissionPolicy',
  'ValidatingAdmissionPolicyBinding'
]);

export { INSTALLATION_PHASES, MANAGED_NAMESPACES } from './installation-contract.mjs';

export const MANAGED_CRDS = MANAGED_CLUSTER_SCOPED_RESOURCES.customResourceDefinitions;
export const MANAGED_CLUSTER_RBAC = MANAGED_CLUSTER_SCOPED_RESOURCES.clusterRbac;
export const MANAGED_CLUSTER_POLICIES = MANAGED_CLUSTER_SCOPED_RESOURCES.admissionPolicies;

// Historical cluster-scoped resources are evidence for explicit legacy cleanup only.
// A target uninstall must never delete resources owned by Console-activated modules.
export const HISTORICAL_MANAGED_CRDS = Object.freeze([
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
export const HISTORICAL_MANAGED_CLUSTER_RBAC = Object.freeze([
  'clusterrolebinding/dupa-module-profile-installer',
  'clusterrolebinding/dupa-console-evidence-reader',
  'clusterrolebinding/dupa-clidownload-reader',
  'clusterrolebinding/opensphere-console-backend',
  'clusterrolebinding/opensphere-console-osaa-gateway-environment-reader',
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
  'clusterrole/opensphere-console-osaa-gateway-environment-reader',
  'clusterrole/foundation-bootstrap-reconciler',
  'clusterrole/foundation-control-plane-identity-directory',
  'clusterrole/foundation-control-plane-core'
]);
export const HISTORICAL_MANAGED_CLUSTER_POLICIES = Object.freeze([
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
  {
    path: 'apps/extension-controller/crds/ui-plugin-crds.yaml',
    componentOwners: ['extensionController'],
    applyWholeForComponentRelease: true
  },
  {
    path: 'apps/extension-controller/config/trusted-keys.yaml',
    componentOwners: ['extensionController'],
    applyWholeForComponentRelease: true
  },
  {
    path: 'cmd/os-cli/deploy.yaml',
    requiresAuxiliaryArtifact: 'cliArtifacts',
    auxiliaryReplacements: [[
      '__OPENSPHERE_OS_CLI_IMAGE__',
      'cliArtifacts'
    ]]
  },
  {
    path: 'backend/registry/deploy/registry.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-registry(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'registry'
    ]]
  },
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

export const LEGACY_BASE_MANIFESTS = Object.freeze([
  { path: 'backend/dupa-control/platform-support-profile-crd.yaml' },
  {
    path: 'backend/dupa-control/ui-plugin-crds.yaml',
    componentOwners: ['dupaController'],
    applyWholeForComponentRelease: true
  },
  { path: 'backend/dupa-control/dupa-trusted-keys.yaml' },
  { path: 'backend/dupa-control/clidownload-rbac.yaml' },
  {
    path: 'backend/os-cli/deploy.yaml',
    requiresAuxiliaryArtifact: 'cliArtifacts',
    auxiliaryReplacements: [[
      '__OPENSPHERE_OS_CLI_IMAGE__',
      'cliArtifacts'
    ]]
  },
  {
    path: 'backend/dupa-control/opensphere-console-dupa-controller.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-console-(?:dupa-controller|dupa)(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'dupaController'
    ]]
  },
  {
    path: 'backend/registry/deploy/registry.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-registry(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'registry'
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
    path: 'backend/opensphere-console-osaa-gateway/deploy.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-console-osaa-gateway(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'osaaGateway'
    ]]
  },
  {
    path: 'backend/opensphere-osdst/deploy.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-osdst(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'osdst'
    ]]
  },
  {
    path: 'backend/osaa-governed-adapter/deploy.yaml',
    replacements: [[
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-osaa-governed-adapter(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'osaaGovernedAdapter'
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

export const SUPABASE_MIGRATION_MANIFEST = 'migrations/manifest.json';
export const LEGACY_SUPABASE_MIGRATION_MANIFEST = 'backend/supabase/migrations/manifest.json';
const MIGRATION_OWNER_COMPONENTS = Object.freeze(['consoleApi', 'extensionController']);

function sha256Text(value) {
  return createHash('sha256').update(String(value).replace(/\r\n?/gu, '\n'), 'utf8').digest('hex');
}

function migrationSetDigest(entries) {
  const material = entries.map((entry) => [
    entry.globalId,
    entry.semanticKey,
    entry.predecessorGlobalId || '',
    entry.path,
    entry.sha256,
    entry.sourceRevision
  ].join('|') + '\n').join('');
  return `sha256:${sha256Text(material)}`;
}

function parseCurrentMigrationManifest(manifest) {
  const rootKeys = ['schemaVersion', 'repository', 'latestGlobalId', 'migrationCount', 'setDigest', 'migrations'];
  if (manifest?.schemaVersion !== 1 || manifest.repository !== 'OpenSphere-Console'
      || Object.keys(manifest).some((key) => !rootKeys.includes(key))
      || !Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    throw new Error('Unsupported Console migration manifest');
  }
  const ids = new Set();
  const semanticKeys = new Set();
  let predecessor = null;
  for (const [index, entry] of manifest.migrations.entries()) {
    const entryKeys = [
      'globalId', 'semanticKey', 'predecessorGlobalId', 'path', 'sha256',
      'sourceRevision', 'setDigest', 'setSize'
    ];
    if (!entry || Object.keys(entry).some((key) => !entryKeys.includes(key))
        || !/^opensphere-console\/[0-9]{8}\/[0-9]{4}$/u.test(entry.globalId ?? '')
        || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(entry.semanticKey ?? '')
        || !/^migrations\/(?:baseline|versions)\/[a-z0-9][a-z0-9_.-]*\.sql$/u.test(entry.path ?? '')
        || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')
        || !/^[a-f0-9]{40}$/u.test(entry.sourceRevision ?? '')
        || entry.predecessorGlobalId !== predecessor
        || entry.setSize !== index + 1
        || ids.has(entry.globalId) || semanticKeys.has(entry.semanticKey)
        || entry.setDigest !== migrationSetDigest(manifest.migrations.slice(0, index + 1))) {
      throw new Error(`Invalid or duplicate Console migration manifest entry: ${entry?.globalId ?? 'unknown'}`);
    }
    ids.add(entry.globalId);
    semanticKeys.add(entry.semanticKey);
    predecessor = entry.globalId;
  }
  if (manifest.migrationCount !== manifest.migrations.length
      || manifest.latestGlobalId !== predecessor
      || manifest.setDigest !== migrationSetDigest(manifest.migrations)) {
    throw new Error('Console migration manifest count/latest/set digest mismatch');
  }
  return Object.freeze({
    ...manifest,
    migrations: Object.freeze(manifest.migrations.map((entry) => Object.freeze(entry)))
  });
}

function parseLegacyMigrationManifest(manifest) {
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
    ids.add(entry.id);
    names.add(entry.name);
    previous = entry.name;
    predecessorMigrationId = entry.id;
  }
  const latest = manifest.migrations.at(-1).id;
  const material = manifest.migrations.map(({ id, predecessorMigrationId: prior, name, sha256 }) =>
    `${id}\n${prior ?? '-'}\n${name}\n${sha256}`).join('\n');
  const setDigest = `sha256:${sha256Text(material)}`;
  if (manifest.migrationCount !== manifest.migrations.length
      || manifest.latestMigrationId !== latest || manifest.setDigest !== setDigest) {
    throw new Error('Supabase migration manifest count/latest/set digest mismatch');
  }
  return Object.freeze({
    ...manifest,
    migrations: Object.freeze(manifest.migrations.map((entry) => Object.freeze(entry)))
  });
}

export function parseSupabaseMigrationManifest(value) {
  let manifest;
  try {
    manifest = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
  } catch {
    throw new Error('Console migration manifest is not valid JSON');
  }
  if (manifest?.schemaVersion === 1) return parseCurrentMigrationManifest(manifest);
  return parseLegacyMigrationManifest(manifest);
}

export function verifySupabaseMigrationArtifact(entry, contents) {
  if (!entry || sha256Text(contents) !== entry.sha256) {
    throw new Error(`Console migration digest differs from manifest: ${entry?.globalId ?? entry?.name ?? 'unknown'}`);
  }
  return true;
}

export const SUPABASE_MANIFEST = Object.freeze({
  path: 'backend/supabase/target/deploy.yaml',
  replacements: [
    ['__OPENSPHERE_SUPABASE_POSTGRES_IMAGE__', 'supabasePostgres'],
    ['__OPENSPHERE_SUPABASE_AUTH_IMAGE__', 'supabaseAuth'],
    ['__OPENSPHERE_SUPABASE_REST_IMAGE__', 'supabaseRest'],
    ['__OPENSPHERE_SUPABASE_STORAGE_IMAGE__', 'supabaseStorage']
  ]
});

export const CONSOLE_API_MANIFEST = Object.freeze({
  path: 'apps/console-api/deploy.yaml',
  replacements: [['__OPENSPHERE_CONSOLE_API_IMAGE__', 'consoleApi']]
});

export const EXTENSION_CONTROLLER_MANIFEST = Object.freeze({
  path: 'apps/extension-controller/deploy.yaml',
  replacements: [['__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__', 'extensionController']]
});

export const GITEA_MANIFEST = Object.freeze({
  path: 'backend/gitea/bootstrap/gitea.yaml',
  replacements: [
    ['(?:__OPENSPHERE_GITEA_IMAGE__|ghcr\\.io/opensphere-platform/opensphere-console-gitea@sha256:[a-f0-9]+)', 'gitea'],
    ['(?:(?:docker\\.io/library/)?postgres|ghcr\\.io/opensphere-platform/opensphere-console-gitea-postgres)(?:@sha256:[a-f0-9]+|:17-alpine)', 'giteaPostgres']
  ]
});

export const BESZEL_MANIFEST = Object.freeze({
  path: 'deploy/baseline-monitoring/beszel-release.yaml',
  replacements: [
    ['__OPENSPHERE_BESZEL_HUB_IMAGE__', 'beszelHub'],
    ['__OPENSPHERE_BESZEL_AGENT_IMAGE__', 'beszelAgent'],
    ['__OPENSPHERE_BESZEL_BOOTSTRAP_IMAGE__', 'beszelBootstrap']
  ]
});

const TARGET_FOUNDATION_MANIFESTS = Object.freeze([
  SUPABASE_MANIFEST,
  CONSOLE_API_MANIFEST,
  EXTENSION_CONTROLLER_MANIFEST,
  GITEA_MANIFEST,
  BESZEL_MANIFEST
]);

const LEGACY_SUPABASE_MANIFEST = Object.freeze({
  path: 'backend/supabase/bootstrap/supabase.yaml',
  replacements: [
    ['(?:docker\\.io/supabase/postgres|ghcr\\.io/opensphere-platform/opensphere-console-supabase-postgres)(?:@sha256:[a-f0-9]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'supabasePostgres'],
    ['(?:docker\\.io/supabase/gotrue|ghcr\\.io/opensphere-platform/opensphere-console-supabase-auth)(?:@sha256:[a-f0-9]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'supabaseAuth'],
    ['(?:docker\\.io/postgrest/postgrest|ghcr\\.io/opensphere-platform/opensphere-console-supabase-rest)(?:@sha256:[a-f0-9]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'supabaseRest'],
    ['(?:docker\\.io/supabase/storage-api|ghcr\\.io/opensphere-platform/opensphere-console-supabase-storage)(?:@sha256:[a-f0-9]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'supabaseStorage']
  ]
});

export const FOUNDATION_ARTIFACT_PATHS = Object.freeze([
  'scripts/Install-ConsoleApiRuntime.ps1',
  'scripts/console-migrations.mjs',
  'backend/gitea/bootstrap/install.ps1',
  'backend/gitea/bootstrap/configure-signing.ps1',
  'backend/gitea/bootstrap/control-plane-bootstrap.ps1',
  'deploy/baseline-monitoring/install.ps1'
]);

const LEGACY_FOUNDATION_ARTIFACT_PATHS = Object.freeze([
  'backend/supabase/install.ps1',
  'backend/supabase/migration-transaction.ps1',
  'backend/gitea/bootstrap/install.ps1',
  'backend/gitea/bootstrap/configure-signing.ps1',
  'backend/gitea/bootstrap/control-plane-bootstrap.ps1'
]);

export const INSTALL_ARTIFACT_PATHS = Object.freeze([
  ...FOUNDATION_ARTIFACT_PATHS,
  SUPABASE_MIGRATION_MANIFEST,
  ...TARGET_FOUNDATION_MANIFESTS.map(({ path }) => path),
  ...BASE_MANIFESTS.map(({ path }) => path)
]);

function isTargetConsoleRelease(lock) {
  return Boolean(lock?.components?.consoleApi && lock?.components?.extensionController);
}

function migrationManifestPath(lock) {
  return isTargetConsoleRelease(lock)
    ? SUPABASE_MIGRATION_MANIFEST
    : LEGACY_SUPABASE_MIGRATION_MANIFEST;
}

function foundationManifestSpecs(lock) {
  return isTargetConsoleRelease(lock)
    ? TARGET_FOUNDATION_MANIFESTS
    : [LEGACY_SUPABASE_MANIFEST, GITEA_MANIFEST];
}

function foundationArtifactPaths(lock) {
  return isTargetConsoleRelease(lock)
    ? FOUNDATION_ARTIFACT_PATHS
    : LEGACY_FOUNDATION_ARTIFACT_PATHS;
}

function isPreRecoveryRelease(lock) {
  return !lock?.components?.recovery;
}


export function baseManifestSpecs(lock) {
  if (lock?.components?.consoleApi) {
    return BASE_MANIFESTS.filter(({ requiresAuxiliaryArtifact }) =>
      !requiresAuxiliaryArtifact || Boolean(lock.auxiliaryArtifacts?.[requiresAuxiliaryArtifact]));
  }
  let specs = isPreRecoveryRelease(lock)
    ? LEGACY_BASE_MANIFESTS.filter(({ path }) => !LEGACY_RECOVERY_MANIFESTS.has(path))
    : LEGACY_BASE_MANIFESTS;
  if (!lock?.components?.osdst) {
    specs = specs.filter(({ path }) => path !== 'backend/opensphere-osdst/deploy.yaml');
  }
  if (hasLegacyInstalledAgentIdentity(lock?.components)) {
    specs = specs
      .filter((spec) => ![...manifestSpecComponents(spec)].some((component) =>
        component === 'osaaGateway' || component === 'osaaGovernedAdapter'))
      .concat(LEGACY_INSTALLED_AGENT_MANIFESTS);
  }
  return specs.filter(({ requiresAuxiliaryArtifact }) =>
    !requiresAuxiliaryArtifact || Boolean(lock.auxiliaryArtifacts?.[requiresAuxiliaryArtifact]));
}

function manifestSpecComponents(spec) {
  return new Set([
    ...(spec.componentOwners ?? []),
    ...(spec.replacements ?? []).map(([, component]) => component)
  ]);
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
  const foundation = selectRequestedSpecs(foundationManifestSpecs(lock));
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
  return new Set([
    ...foundationArtifactPaths(lock),
    migrationManifestPath(lock),
    ...foundationManifestSpecs(lock).map(({ path }) => path),
    ...baseManifestSpecs(lock).map(({ path }) => path)
  ]).size;
}

export const CORE_ROLLOUTS = Object.freeze([
  ['opensphere-console-data', 'statefulset/opensphere-supabase-postgres', '600s'],
  ['opensphere-console-data', 'deployment/opensphere-supabase-auth', '600s'],
  ['opensphere-console-data', 'deployment/opensphere-supabase-rest', '600s'],
  ['opensphere-console-data', 'deployment/opensphere-supabase-storage', '600s'],
  ['opensphere-console-change', 'deployment/opensphere-gitea-postgres', '600s'],
  ['opensphere-console-change', 'deployment/opensphere-gitea', '900s'],
  ['opensphere-console', 'deployment/opensphere-console-api', '600s'],
  ['opensphere-console', 'deployment/opensphere-extension-controller', '600s'],
  ['opensphere-console', 'deployment/opensphere-registry', '600s'],
  ['opensphere-console', 'deployment/os-cli', '600s'],
  ['opensphere-monitoring', 'statefulset/beszel-hub', '600s'],
  ['opensphere-monitoring', 'daemonset/beszel-agent', '600s'],
  ['opensphere-console', 'deployment/opensphere-console', '600s']
]);

const LEGACY_CORE_ROLLOUTS = Object.freeze([
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
  ['opensphere-console', 'deployment/opensphere-console-osaa-gateway', '600s'],
  ['opensphere-console', 'deployment/opensphere-osdst', '600s'],
  ['opensphere-console', 'deployment/osaa-governed-adapter', '600s'],
  ['opensphere-console', 'deployment/os-cli', '600s'],
  ['opensphere-console', 'deployment/opensphere-console', '600s']
]);

export const COMPONENT_ROLLOUTS = Object.freeze({
  console: [['opensphere-console', 'deployment/opensphere-console', '600s']],
  consoleApi: [['opensphere-console', 'deployment/opensphere-console-api', '600s']],
  extensionController: [['opensphere-console', 'deployment/opensphere-extension-controller', '600s']],
  registry: [['opensphere-console', 'deployment/opensphere-registry', '600s']],
  gitea: [['opensphere-console-change', 'deployment/opensphere-gitea', '900s']],
  giteaPostgres: [['opensphere-console-change', 'deployment/opensphere-gitea-postgres', '600s']],
  supabasePostgres: [['opensphere-console-data', 'statefulset/opensphere-supabase-postgres', '600s']],
  supabaseAuth: [['opensphere-console-data', 'deployment/opensphere-supabase-auth', '600s']],
  supabaseRest: [['opensphere-console-data', 'deployment/opensphere-supabase-rest', '600s']],
  supabaseStorage: [['opensphere-console-data', 'deployment/opensphere-supabase-storage', '600s']],
  beszelHub: [['opensphere-monitoring', 'statefulset/beszel-hub', '600s']],
  beszelAgent: [['opensphere-monitoring', 'daemonset/beszel-agent', '600s']],
  beszelBootstrap: [],
  osaaGateway: [],
  osdst: [],
  osaaGovernedAdapter: [],
  notificationDispatcher: [],
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

function jwtSegment(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createSupabaseServiceJwt(secret, role, now = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new Error('Supabase JWT secret must contain at least 32 bytes');
  }
  if (!['anon', 'service_role'].includes(role)) {
    throw new Error('Unsupported Supabase service JWT role');
  }
  const header = jwtSegment({ alg: 'HS256', typ: 'JWT' });
  const payload = jwtSegment({
    iss: 'supabase',
    role,
    iat: now,
    exp: now + (10 * 365 * 24 * 60 * 60)
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(unsigned, 'ascii').digest('base64url');
  return `${unsigned}.${signature}`;
}

export function supabaseServerSecretManifest(existing = null) {
  const expectedKeys = [
    'anon-key',
    'jwt-secret',
    'postgres-password',
    's3-access-key-id',
    's3-access-key-secret',
    'service-role-key'
  ].sort();
  if (existing) {
    const actualKeys = Object.keys(existing.data ?? {}).sort();
    if (existing.type !== 'Opaque'
        || existing.metadata?.labels?.['opensphere.io/secret-scope'] !== 'supabase-server-only'
        || JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
        || expectedKeys.some((key) => !existing.data?.[key])) {
      throw new Error('Existing opensphere-supabase-secrets differs from the exact six-key target contract; no implicit repair or rotation was attempted');
    }
    return null;
  }

  const jwtSecret = randomBytes(48);
  const jwtSecretText = jwtSecret.toString('base64url');
  const literals = {
    'anon-key': createSupabaseServiceJwt(Buffer.from(jwtSecretText, 'utf8'), 'anon'),
    'jwt-secret': jwtSecretText,
    'postgres-password': randomBytes(48).toString('base64url'),
    's3-access-key-id': `opensphere-${randomBytes(12).toString('hex')}`,
    's3-access-key-secret': randomBytes(48).toString('base64url'),
    'service-role-key': createSupabaseServiceJwt(Buffer.from(jwtSecretText, 'utf8'), 'service_role')
  };
  jwtSecret.fill(0);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'opensphere-supabase-secrets',
      namespace: 'opensphere-console-data',
      labels: { 'opensphere.io/secret-scope': 'supabase-server-only' }
    },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(literals).map(([key, value]) => [
        key,
        Buffer.from(value, 'utf8').toString('base64')
      ])
    )
  };
}

export function ensureSupabaseServerSecret() {
  let existing = null;
  try { existing = readSecret('opensphere-console-data', 'opensphere-supabase-secrets'); } catch {}
  const manifest = supabaseServerSecretManifest(existing);
  if (!manifest) return false;
  applyYaml(`${JSON.stringify(manifest)}\n`);
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

export function ensureRegistryPullSecrets(lock, suppliedCredentials, {lifecycleEnabled=false}={}) {
  if(suppliedCredentials)validateCredential(suppliedCredentials);
  if(suppliedCredentials?.lifecycle?.mode==='github-device' && !lifecycleEnabled)throw new Error('Target Console has not enabled registry-auth/v1; OAuth runtime handoff is blocked');
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
  const ownerJson=kubectl(['-n','opensphere-console','get','secret',REGISTRY_AUTH_SECRET,'--ignore-not-found','-o','json'],{capture:true});
  if(ownerJson.trim()){
    const owner=parseRegistryState(JSON.parse(ownerJson));
    if(!everyNamespaceReady)throw new Error('Runtime-owned registry pull Secrets are incomplete; repair through Console or an explicit recovery procedure');
    return {credentialsRequired:requiresCredentials,credentialSource:'console-managed',lifecycleGeneration:owner.generation};
  }
  if (!suppliedCredentials && everyNamespaceReady && !lifecycleEnabled) {
    return {
      credentialsRequired: requiresCredentials,
      credentialSource: requiresCredentials ? 'existing-secret' : 'anonymous'
    };
  }
  const credentials = suppliedCredentials ?? null;
  const state=lifecycleEnabled ? initialRegistryState(credentials,requiredImages(lock)) : null;
  if (requiresCredentials && !credentials) {
    throw new Error('This release contains private GHCR packages; provide --registry-username with --registry-token-stdin or authenticate gh with read:packages');
  }
  for (const namespace of MANAGED_NAMESPACES) {
    if (!credentials && existing.get(namespace)) continue;
    const manifest=registryPullSecretManifest(namespace, credentials);
    if(state){manifest.data=pullSecretData(credentials,state.generation);manifest.metadata.annotations={[GENERATION_ANNOTATION]:state.generation};}
    applyYaml(JSON.stringify(manifest)+'\n');
  }
  if(state) kubectl(['create','-f','-'],{capture:true,input:JSON.stringify(registryStateSecret(state))});
  return {
    credentialsRequired: requiresCredentials,
    lifecycleGeneration:state?.generation,
    credentialSource: credentials ? 'managed-secret' : 'anonymous'
  };
}

export async function verifyRegistryHandoff(generation,{read=()=>readSecret('opensphere-console',REGISTRY_AUTH_SECRET),sleep=registryDelay,now=Date.now,timeoutMs=120000}={}){
  const deadline=now()+timeoutMs;
  while(now()<deadline){
    const state=parseRegistryState(read());
    if(state.generation!==generation)throw new Error('Registry credential generation changed during Setup handoff');
    if(state.phase==='ReauthorizationRequired')throw new Error('Console requires registry reauthorization');
    if(state.phase==='Ready' && state.observation?.generation===generation && JSON.stringify([...state.observation.namespaces].sort())===JSON.stringify([...MANAGED_NAMESPACES].sort()) && now()-Date.parse(state.observation.verifiedAt)<300000)return;
    await sleep(2000);
  }
  throw new Error('Console registry credential handoff was not verified before timeout');
}

function validateAuthEnvironment(value) {
  return selectAuthEnvironment('edge', value);
}

export async function fetchReleaseArtifact(
  lock,
  path,
  {
    optional404 = false,
    sourceRevision = lock.sourceRevision,
    sourceArtifactCredential = null,
    fetchFn = fetchWithRetry
  } = {}
) {
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision ?? '')) {
    throw new Error(`Release artifact source revision is invalid for ${path}`);
  }
  const request = sourceArtifactRequest(sourceRevision, path, sourceArtifactCredential);
  const response = await fetchFn(request.url, request.options);
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
  { sourceRevision = lock.sourceRevision, kubernetesApiEgress } = {}
) {
  let yaml = renderRegistryKubernetesEgress(sourceYaml, kubernetesApiEgress);
  for (const [pattern, component] of spec.replacements ?? []) {
    const image = lock.components?.[component]?.image;
    if (!image) throw new Error(`Release lock lacks component ${component}`);
    const expression = new RegExp(pattern, 'g');
    if (!expression.test(yaml)) {
      throw new Error(`Manifest ${spec.path} no longer exposes the governed ${component} image slot`);
    }
    yaml = yaml.replace(new RegExp(pattern, 'g'), image);
  }
  for (const [pattern, artifact] of spec.auxiliaryReplacements ?? []) {
    const image = lock.auxiliaryArtifacts?.[artifact]?.image;
    if (!image) throw new Error(`Release lock lacks auxiliary artifact ${artifact}`);
    const expression = new RegExp(pattern, 'g');
    if (!expression.test(yaml)) {
      throw new Error(`Manifest ${spec.path} no longer exposes the governed ${artifact} artifact slot`);
    }
    yaml = yaml.replace(new RegExp(pattern, 'g'), image);
  }
  yaml = yaml.replace(/storageClassName:\s*standard/g, `storageClassName: ${storageClass}`);
  yaml = yaml.replaceAll('__OPENSPHERE_STORAGE_CLASS__', storageClass);
  const normalizedConsoleUrl = normalizeConsoleUrl(consoleUrl);
  yaml = yaml.replaceAll('__OPENSPHERE_CONSOLE_URL__', normalizedConsoleUrl);
  yaml = yaml.replaceAll('__OPENSPHERE_SUPABASE_NAMESPACE__', 'opensphere-console-data');
  yaml = yaml.replaceAll('https://localhost:8090', normalizedConsoleUrl);
  yaml = yaml.replaceAll('https://localhost:1114', normalizedConsoleUrl);
  yaml = configureShellServiceEndpoint(yaml, normalizedConsoleUrl);
  yaml = yaml.replaceAll('__OPENSPHERE_RELEASE_REVISION__', sourceRevision);
  if (yaml.includes('__OPENSPHERE_REGISTRY_IMAGE_DIGEST__')) {
    const registryImage = String(lock.components?.registry?.image ?? '');
    const registryDigest = registryImage.split('@')[1] ?? '';
    if (!/^sha256:[a-f0-9]{64}$/u.test(registryDigest)) {
      throw new Error(`Manifest ${spec.path} lacks the governed Registry image digest`);
    }
    yaml = yaml.replaceAll('__OPENSPHERE_REGISTRY_IMAGE_DIGEST__', registryDigest);
  }
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
  { sourceRevision = lock.sourceRevision, sourceArtifactCredential = null } = {}
) {
  const sourceYaml = await fetchReleaseArtifact(lock, spec.path, {
    sourceRevision,
    sourceArtifactCredential
  });
  return renderManifest(
    lock,
    spec,
    sourceYaml,
    storageClass,
    consoleUrl,
    authEnvironment,
    { sourceRevision, kubernetesApiEgress: sourceYaml.includes(KUBERNETES_EGRESS_SLOT)
      ? discoverRegistryKubernetesEgress(kubectl) : undefined }
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
  signedEvidence = lock.releaseBom?.migrationManifest,
  manifestPath = migrationManifestPath(lock),
  { sourceArtifactCredential = null } = {}
) {
  const rawManifest = await fetchReleaseArtifact(lock, manifestPath, {
    sourceRevision,
    sourceArtifactCredential
  });
  const manifest = parseSupabaseMigrationManifest(rawManifest);
  const current = manifest.schemaVersion === 1;
  const observedEvidence = current
    ? {
        path: manifestPath,
        sha256: `sha256:${sha256Text(rawManifest)}`,
        setDigest: manifest.setDigest,
        latestGlobalId: manifest.latestGlobalId,
        migrationCount: manifest.migrationCount
      }
    : {
        path: manifestPath,
        sha256: `sha256:${sha256Text(rawManifest)}`,
        setDigest: manifest.setDigest,
        latestMigrationId: manifest.latestMigrationId,
        migrationCount: manifest.migrationCount
      };
  if (signedEvidence && (
    Object.entries(observedEvidence).some(([key, value]) => signedEvidence[key] !== value)
    || Object.keys(signedEvidence).length !== Object.keys(observedEvidence).length
  )) {
    throw new Error('Console migration manifest differs from release evidence');
  }
  const artifacts = await Promise.all(manifest.migrations.map(async (entry) => {
    const contents = await fetchReleaseArtifact(lock, entry.path, {
      sourceRevision,
      sourceArtifactCredential
    });
    verifySupabaseMigrationArtifact(entry, contents);
    return { path: entry.path, contents };
  }));
  await writeReleaseArtifact(root, manifestPath, rawManifest);
  for (const artifact of artifacts) await writeReleaseArtifact(root, artifact.path, artifact.contents);
  return {
    manifest,
    manifestPath,
    sourceRevision,
    evidence: Object.freeze(observedEvidence),
    artifactCount: artifacts.length + 1
  };
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
    migrationEvidence = lock.releaseBom?.migrationManifest,
    sourceArtifactCredential = null
  } = {}
) {
  const target = isTargetConsoleRelease(lock);
  const manifestArtifacts = await Promise.all(foundationManifestSpecs(lock).map(async (spec) => {
    const raw = await fetchReleaseArtifact(lock, spec.path, { sourceArtifactCredential });
    const rendered = renderManifest(
      lock,
      spec,
      raw,
      storageClass,
      consoleUrl,
      authEnvironment,
      { kubernetesApiEgress: raw.includes(KUBERNETES_EGRESS_SLOT)
        ? discoverRegistryKubernetesEgress(kubectl) : undefined }
    );
    return { spec, raw, rendered };
  }));
  const artifacts = (await Promise.all(foundationArtifactPaths(lock).map(async (path) => {
    const contents = await fetchReleaseArtifact(lock, path, {
      optional404: optionalArtifacts.has(path),
      sourceArtifactCredential
    });
    return contents === null ? null : { path, contents };
  }))).filter(Boolean);
  for (const artifact of artifacts) await writeReleaseArtifact(root, artifact.path, artifact.contents);
  const migration = await materializeSupabaseMigrationSet(
    lock,
    root,
    migrationSourceRevision,
    migrationEvidence,
    undefined,
    { sourceArtifactCredential }
  );
  for (const artifact of manifestArtifacts) {
    await writeReleaseArtifact(
      root,
      artifact.spec.path,
      target ? artifact.raw : artifact.rendered
    );
  }
  return {
    root,
    target,
    migration,
    release: manifestArtifacts.map(({ spec, rendered }) => ({
      path: spec.path,
      yaml: rendered
    }))
  };
}

function currentKubeContext() {
  return process.env.OPENSPHERE_KUBE_CONTEXT
    || kubectl(['config', 'current-context'], { capture: true }).trim();
}

function runLegacyFoundationInstallers(lock, foundation, storageClass, consoleUrl, progress) {
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
  progress?.item('설치', 'Legacy Supabase rollback baseline');
  run('pwsh', supabaseArgs);

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
  run('pwsh', giteaArgs);
}

function runFoundationInstallers(lock, foundation, storageClass, consoleUrl, progress) {
  if (!foundation.target) {
    runLegacyFoundationInstallers(lock, foundation, storageClass, consoleUrl, progress);
    return;
  }
  const context = currentKubeContext();

  progress?.item('설치', 'Gitea Declarative Change Authority');
  run('pwsh', [
    '-NoProfile', '-NonInteractive', '-File',
    join(foundation.root, 'backend', 'gitea', 'bootstrap', 'install.ps1'),
    '-GiteaNamespace', 'opensphere-console-change',
    '-ConsoleNamespace', 'opensphere-console',
    '-GiteaImage', lock.components.gitea.image,
    '-PostgresImage', lock.components.giteaPostgres.image,
    '-StorageClass', storageClass,
    '-KubeContext', context
  ]);
  progress?.item('완료', 'Gitea bootstrap 및 control-plane credential');

  const migration = foundation.migration.evidence;
  progress?.item('설치', 'Supabase Data & Identity + Console API/Extension Controller');
  run('pwsh', [
    '-NoProfile', '-NonInteractive', '-File',
    join(foundation.root, 'scripts', 'Install-ConsoleApiRuntime.ps1'),
    '-ConsoleApiImage', lock.components.consoleApi.image,
    '-ExtensionControllerImage', lock.components.extensionController.image,
    '-SupabasePostgresImage', lock.components.supabasePostgres.image,
    '-SupabaseAuthImage', lock.components.supabaseAuth.image,
    '-SupabaseRestImage', lock.components.supabaseRest.image,
    '-SupabaseStorageImage', lock.components.supabaseStorage.image,
    '-ConsoleUrl', consoleUrl,
    '-StorageClass', storageClass,
    '-KubeContext', context,
    '-VerifiedMaterializedRelease',
    '-ExpectedMigrationManifestSha256', migration.sha256,
    '-ExpectedMigrationSetDigest', migration.setDigest,
    '-ExpectedMigrationLatestGlobalId', migration.latestGlobalId
  ]);
  progress?.item('완료', 'fresh migration prefix 및 최소권한 C_API/C_EXT runtime');

  progress?.item('설치', 'Beszel baseline host observability');
  run('pwsh', [
    '-NoProfile', '-NonInteractive', '-File',
    join(foundation.root, 'deploy', 'baseline-monitoring', 'install.ps1'),
    '-KubectlContext', context,
    '-BeszelHubImage', lock.components.beszelHub.image,
    '-BeszelAgentImage', lock.components.beszelAgent.image,
    '-BeszelBootstrapImage', lock.components.beszelBootstrap.image
  ]);
  progress?.item('완료', 'Beszel Hub bootstrap Job 및 Agent restart 검증');
}

function runComponentMigrations(foundation, progress) {
  if (!foundation.migration || foundation.target) return;
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

async function materializeBaseRelease(
  lock,
  storageClass,
  consoleUrl,
  authEnvironment,
  sourceArtifactCredential = null
) {
  return Promise.all(baseManifestSpecs(lock).map(async (spec) => ({
    path: spec.path,
    yaml: await fetchManifest(
      lock,
      spec,
      storageClass,
      consoleUrl,
      authEnvironment,
      { sourceArtifactCredential }
    )
  })));
}

const TRUST_CONFIGMAP_PATH = 'apps/extension-controller/config/trusted-keys.yaml';
const TRUST_CONFIGMAP_NAME = 'opensphere-extension-trusted-keys';

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
      '-n', 'opensphere-console', 'get', 'configmap', TRUST_CONFIGMAP_NAME, '-o', 'json'
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
    '-n', 'opensphere-console', 'patch', 'configmap', TRUST_CONFIGMAP_NAME,
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
      if (
        baseSpec?.applyWholeForComponentRelease === true
        && completeOwners.size === 1
        && completeOwners.has(component)
      ) {
        selected.set(`${source.path}#complete`, {
          path: `${source.path}#${component}`,
          yaml: source.yaml.endsWith('\n') ? source.yaml : `${source.yaml}\n`
        });
        continue;
      }
      if (completeOwners.size === 1 && completeOwners.has(component)) {
        if (!imageLine.test(source.yaml)) continue;
        found = true;
        selected.set(`${source.path}#complete`, {
          path: `${source.path}#${component}`,
          yaml: source.yaml.endsWith('\n') ? source.yaml : `${source.yaml}\n`
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

export function replaceComponentInventory(baseInventory, previousComponentInventory, targetComponentInventory) {
  const previous = new Set((previousComponentInventory ?? []).map(inventoryKey));
  const merged = new Map(
    (baseInventory ?? [])
      .filter((resource) => !previous.has(inventoryKey(resource)))
      .map((resource) => [inventoryKey(resource), resource])
  );
  for (const resource of targetComponentInventory ?? []) merged.set(inventoryKey(resource), resource);
  return [...merged.values()].sort((left, right) => inventoryKey(left).localeCompare(inventoryKey(right)));
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

  const kind = String(workload.kind ?? '').toLowerCase();
  if (kind === 'daemonset') {
    const scheduled = Number(workload.status?.desiredNumberScheduled ?? 0);
    return scheduled > 0
      && Number(workload.status?.updatedNumberScheduled ?? 0) === scheduled
      && Number(workload.status?.numberReady ?? 0) === scheduled
      && Number(workload.status?.numberUnavailable ?? 0) === 0;
  }

  const ready = Number(workload.status?.readyReplicas ?? 0) === desired;
  const updated = Number(workload.status?.updatedReplicas ?? 0) === desired;
  if (!ready || !updated) return false;
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

export function coreRolloutsForLock(lock) {
  const rollouts = isTargetConsoleRelease(lock) ? CORE_ROLLOUTS : LEGACY_CORE_ROLLOUTS;
  return rollouts.filter(([, resource]) => (
    (resource !== 'deployment/os-cli' || Boolean(lock?.auxiliaryArtifacts?.cliArtifacts))
    && (resource !== 'deployment/opensphere-osdst' || Boolean(lock?.components?.osdst))
  ));
}

function waitForCoreRollouts(lock, progress) {
  waitForRollouts(coreRolloutsForLock(lock), progress);
}

export function waitForComponentRollouts(changedComponents, progress) {
  const unique = new Map();
  for (const component of changedComponents) {
    const rollouts = COMPONENT_ROLLOUTS[component] ?? LEGACY_INSTALLED_AGENT_ROLLOUTS[component];
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

function installationClusterScopedResources() {
  return {
    customResourceDefinitions: [...MANAGED_CLUSTER_SCOPED_RESOURCES.customResourceDefinitions],
    clusterRbac: [...MANAGED_CLUSTER_SCOPED_RESOURCES.clusterRbac],
    admissionPolicies: [...MANAGED_CLUSTER_SCOPED_RESOURCES.admissionPolicies]
  };
}

function baselineObservabilityState(observed = {}) {
  return {
    ...BASELINE_OBSERVABILITY_REQUIREMENT,
    hostAccess: [...BASELINE_OBSERVABILITY_REQUIREMENT.hostAccess],
    podSecurityEnforce: String(observed.podSecurityEnforce ?? 'not-observed'),
    status: String(observed.status ?? 'not-observed')
  };
}

export function installationStateDocument(
  phase,
  lock,
  {
    observedAt = new Date().toISOString(),
    verification,
    failureCode,
    baselineObservabilitySecurity
  } = {}
) {
  if (!INSTALLATION_PHASES.includes(phase)) {
    throw new Error(`Unsupported installation phase: ${phase}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(lock?.releaseDigest ?? '')) {
    throw new Error('Installation state requires an exact release digest');
  }
  if (phase === 'Ready') {
    if (verification?.evidenceConfigMap !== 'opensphere-installation-evidence'
        || !/^\d{4}-\d{2}-\d{2}T/u.test(verification?.verifiedAt ?? '')) {
      throw new Error('Ready installation state requires completed verification evidence');
    }
  } else if (verification !== undefined) {
    throw new Error(`${phase} installation state cannot claim completed verification`);
  }
  if (phase === 'Failed' && !/^[a-z][a-z0-9-]{2,63}$/u.test(failureCode ?? '')) {
    throw new Error('Failed installation state requires a bounded failure code');
  }
  return {
    apiVersion: 'bootstrap.opensphere.io/v1alpha1',
    kind: 'OpenSphereInstallationState',
    phase,
    releaseDigest: lock.releaseDigest,
    observedAt,
    managedNamespaces: [...MANAGED_NAMESPACES],
    managedClusterScopedResources: installationClusterScopedResources(),
    baselineObservabilitySecurity: baselineObservabilityState(baselineObservabilitySecurity),
    ...(verification ? { verification } : {}),
    ...(failureCode ? { failureCode } : {})
  };
}

export function recordInstallationState(
  lock,
  storageClass,
  initialAdmin,
  consoleUrl,
  authEnvironment,
  shellTlsSecret,
  phase = 'Preparing',
  stateOptions = {}
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
    responsibilityBoundary: releaseResponsibilityProfile(lock.components, lock.auxiliaryArtifacts),
    baselineObservabilityRequirement: {
      ...BASELINE_OBSERVABILITY_REQUIREMENT,
      hostAccess: [...BASELINE_OBSERVABILITY_REQUIREMENT.hostAccess]
    },
    ...(shellTlsSecret ? { shellTlsSecret } : {}),
    initialAdmin
  };
  const state = installationStateDocument(phase, lock, stateOptions);
  applyYaml(`${JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'opensphere-installation-lock', namespace: 'opensphere-console' },
    data: {
      'release.json': JSON.stringify(lock),
      'config.json': JSON.stringify(config),
      'state.json': JSON.stringify(state)
    }
  })}\n`);
  return { config, state };
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

export function readInstallationState() {
  try {
    const object = JSON.parse(kubectl([
      '-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock', '-o', 'json'
    ], { capture: true }));
    const state = JSON.parse(object.data?.['state.json'] ?? 'null');
    if (!state || state.apiVersion !== 'bootstrap.opensphere.io/v1alpha1'
        || state.kind !== 'OpenSphereInstallationState'
        || !INSTALLATION_PHASES.includes(state.phase)
        || !/^sha256:[a-f0-9]{64}$/u.test(state.releaseDigest ?? '')
        || JSON.stringify(state.managedNamespaces) !== JSON.stringify(MANAGED_NAMESPACES)
        || JSON.stringify(state.managedClusterScopedResources) !== JSON.stringify(installationClusterScopedResources())
        || JSON.stringify(state.baselineObservabilitySecurity?.hostAccess) !== JSON.stringify(BASELINE_OBSERVABILITY_REQUIREMENT.hostAccess)
        || state.baselineObservabilitySecurity?.setupRepairsHost !== false
        || state.baselineObservabilitySecurity?.setupLowersPodSecurity !== false) {
      throw new Error('Installation state is absent or does not own the canonical namespace set');
    }
    return state;
  } catch {
    return null;
  }
}

export function readInstallationLock() {
  const lock = readStoredInstallationLock();
  return lock ? validateLock(lock, {
    allowLegacyComponentSet: true,
    allowInstalledAgentIdentityCutover: true
  }) : null;
}

// The retired Kanidm/PostgreSQL/RustFS release shape is not migratable by a
// fresh-install bootstrap. Existing clusters must use an explicit data
// migration/recovery workflow; this function only recognizes modern locks.
export async function migrateLegacyInstallationLock() {
  const lock = readStoredInstallationLock();
  if (!lock || lock.releaseBom) return null;
  if (isLocalEdgeLock(lock)) {
    // An installed edge lock is a rollback/upgrade baseline, not a newly
    // resolved target. Accept the two historical component sets here for the
    // same reason readInstallationLock() and upgrade() do: the target release
    // remains strict and adds any newly governed runtime (for example OSDST).
    validateLock(lock, {
      allowLegacyComponentSet: true,
      allowInstalledAgentIdentityCutover: true
    });
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

export function existingManagedNamespaces(namespaces = existingOpenSphereNamespaces()) {
  const managed = new Set(MANAGED_NAMESPACES);
  return [...new Set(namespaces.filter((name) => managed.has(name)))].sort();
}

function listManagedPersistentVolumes() {
  const namespaces = new Set(MANAGED_NAMESPACES);
  const volumes = JSON.parse(kubectl(['get', 'persistentvolumes', '-o', 'json'], { capture: true }));
  return (volumes.items ?? [])
    .filter((volume) => namespaces.has(volume.spec?.claimRef?.namespace))
    .map((volume) => volume.metadata?.name)
    .filter(Boolean);
}

export function listClusterWideCustomResourceInstances(crd) {
  const definitionText = kubectl([
    'get', 'customresourcedefinition', crd, '--ignore-not-found', '-o', 'json'
  ], { capture: true }).trim();
  if (!definitionText) return [];

  let definition;
  try {
    definition = JSON.parse(definitionText);
  } catch {
    throw new Error(`Cannot verify custom resource definition before deletion: ${crd}`);
  }
  if (definition.metadata?.name !== crd || definition.spec?.scope !== 'Namespaced') {
    throw new Error(`Refusing to delete custom resource definition with an unexpected identity or scope: ${crd}`);
  }

  let inventory;
  try {
    inventory = JSON.parse(kubectl([
      'get', crd, '--all-namespaces', '-o', 'json'
    ], { capture: true }));
  } catch {
    throw new Error(`Cannot verify cluster-wide custom resource instances before deletion: ${crd}`);
  }
  if (!Array.isArray(inventory?.items)) {
    throw new Error(`Custom resource inventory is not an exact Kubernetes List: ${crd}`);
  }
  return inventory.items.map((item) => {
    const namespace = String(item.metadata?.namespace ?? '');
    const name = String(item.metadata?.name ?? '');
    if (!namespace || !name) {
      throw new Error(`Custom resource inventory contains an unscoped item: ${crd}`);
    }
    return `${namespace}/${name}`;
  }).sort();
}

export async function uninstallManagedInstallation({ runtime = {} } = {}) {
  const operations = {
    readInstallationLock,
    readInstallationState,
    existingOpenSphereNamespaces,
    existingManagedNamespaces,
    listManagedPersistentVolumes,
    listManagedCrdInstances: listClusterWideCustomResourceInstances,
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
  if (runtime.existingOpenSphereNamespaces && !runtime.existingManagedNamespaces) {
    operations.existingManagedNamespaces = () =>
      existingManagedNamespaces(runtime.existingOpenSphereNamespaces());
  }
  const installed = operations.readInstallationLock();
  const state = operations.readInstallationState();
  const namespaces = operations.existingManagedNamespaces();
  if (!installed) {
    if (namespaces.length) throw new Error(`Refusing to purge unmanaged Setup namespaces: ${namespaces.join(', ')}`);
    throw new Error('No managed OpenSphere installation lock was found');
  }
  if (!state || state.releaseDigest !== installed.releaseDigest
      || JSON.stringify(state.managedNamespaces) !== JSON.stringify(MANAGED_NAMESPACES)
      || JSON.stringify(state.managedClusterScopedResources) !== JSON.stringify(installationClusterScopedResources())) {
    throw new Error('Installation lock does not own the canonical managed namespace and cluster-scoped resource set');
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
  const ownedClusterScoped = state.managedClusterScopedResources;
  for (const crd of ownedClusterScoped.customResourceDefinitions) {
    const instances = operations.listManagedCrdInstances(crd);
    if (!Array.isArray(instances)) {
      throw new Error(`Custom resource deletion guard returned an invalid inventory: ${crd}`);
    }
    if (instances.length) {
      throw new Error(`Refusing to delete shared custom resource definition ${crd}; cluster-wide instances remain: ${instances.join(', ')}`);
    }
  }
  for (const crd of ownedClusterScoped.customResourceDefinitions) operations.deleteManagedCrd(crd);
  for (const resource of ownedClusterScoped.admissionPolicies) operations.deleteManagedClusterRbac(resource);
  for (const resource of ownedClusterScoped.clusterRbac) operations.deleteManagedClusterRbac(resource);
  return {
    releaseDigest: installed.releaseDigest,
    namespaces: [...MANAGED_NAMESPACES],
    persistentVolumes,
    customResourceDefinitions: [...ownedClusterScoped.customResourceDefinitions],
    clusterPolicies: [...ownedClusterScoped.admissionPolicies],
    clusterRbac: [...ownedClusterScoped.clusterRbac]
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
    materializeBaseRelease(
      lock,
      storageClass,
      consoleUrl,
      authEnvironment,
      options.sourceArtifactCredential
    )
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
    includeMigrations = true,
    sourceArtifactCredential = null
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
        { sourceRevision: spec.artifactSourceRevision, sourceArtifactCredential }
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
        { sourceRevision: spec.artifactSourceRevision, sourceArtifactCredential }
      )
    })))
  ]);
  let migration = null;
  if (migrationSourceRevision) {
    const script = await fetchReleaseArtifact(lock, 'backend/supabase/migrate-only.ps1', {
      sourceRevision: migrationSourceRevision,
      sourceArtifactCredential
    });
    await writeReleaseArtifact(root, 'backend/supabase/migrate-only.ps1', script);
    migration = await materializeSupabaseMigrationSet(
      lock,
      root,
      migrationSourceRevision,
      undefined,
      undefined,
      { sourceArtifactCredential }
    );
  }
  const foundation = { root, release: foundationRelease, migration };
  return { foundation, base, all: [...foundationRelease, ...base] };
}

export async function preflightReleaseArtifacts(lock, {
  storageClass,
  consoleUrl,
  authEnvironment,
  sourceArtifactCredential = null
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
      authEnvironment,
      { sourceArtifactCredential }
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
  trustLocalCa = false,
  authEnvironment,
  shellTlsSecret,
  registryCredentials,
  sourceArtifactCredential = null,
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
  const existingNamespaces = existingManagedNamespaces();
  if (!installed && !lock.auxiliaryArtifacts?.cliArtifacts) {
    throw new Error('Fresh installation release lock lacks the digest-bound Console CLI artifact');
  }
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
  progress?.done(`${cluster.serverVersion}, ${cluster.readyNodeCount}/${cluster.nodeCount} Ready schedulable nodes, StorageClass ${cluster.storageClass}`);
  for (const node of cluster.degradedNodes) {
    progress?.item(
      '노드 경고',
      `${node.name}: ${node.ready ? 'Ready/unschedulable' : 'NotReady'} (${node.reason}) — Kubernetes 운영자 복구 대상; Setup은 노드나 Docker Desktop을 재시작하지 않음`
    );
  }
  progress?.item(
    'Beszel Pod Security',
    `${cluster.baselineObservabilitySecurity.podSecurityEnforce}; ${cluster.baselineObservabilitySecurity.status}; root + read-only hostPath 요구를 설치 상태에 기록하며 Setup은 host/PSA를 변경하지 않음`
  );
  const work = await mkdtemp(join(tmpdir(), 'opensphere-setup-supabase-'));
  let installationStateRecorded = false;
  let installationReady = false;
  try {
    progress?.step('서명된 release artifact 전체 다운로드와 digest 고정 manifest 생성');
    const prepared = await prepareRelease(
      lock,
      work,
      cluster.storageClass,
      effectiveConsoleUrl,
      effectiveAuthEnvironment,
      { sourceArtifactCredential }
    );
    progress?.done(`${installArtifactCount(lock) + Number(prepared.foundation?.migration?.manifest?.migrationCount || 0)} artifacts, ${prepared.all.length} manifest groups`);

    const registryLifecycleEnabled=prepared.all.some(entry=>entry.yaml.includes('CONSOLE_REGISTRY_AUTH_CONTRACT') && entry.yaml.includes('registry-auth/v1'));
    if(registryCredentials?.lifecycle?.mode==='github-device' && !registryLifecycleEnabled)throw new Error('Target Console has not enabled registry-auth/v1; no OAuth credentials or namespaces were written');
    const externalShellTls = effectiveShellTls
      ? readSecret(effectiveShellTls.namespace, effectiveShellTls.name)
      : undefined;
    if (externalShellTls) inspectExternalShellTlsSecret(externalShellTls, effectiveConsoleUrl);
    progress?.step('관리 namespace, installation lock과 GHCR image pull 경로 준비');
    ensureNamespace('opensphere-console');
    recordInstallationState(
      lock,
      cluster.storageClass,
      initialAdmin,
      effectiveConsoleUrl,
      effectiveAuthEnvironment,
      shellTlsSecretRefText(effectiveShellTls),
      'Preparing',
      { baselineObservabilitySecurity: cluster.baselineObservabilitySecurity }
    );
    installationStateRecorded = true;
    progress?.item('namespace', 'opensphere-console');
    for (const namespace of MANAGED_NAMESPACES.filter((name) => name !== 'opensphere-console')) {
      ensureNamespace(namespace);
      progress?.item('namespace', namespace);
    }
    const registry = ensureRegistryPullSecrets(lock, registryCredentials, {lifecycleEnabled:registryLifecycleEnabled});
    progress?.done(`GHCR credentials=${registry.credentialSource}`);

    progress?.item('설치 경계', 'Recovery 및 기타 선택 모듈 설정은 bootstrap 이후 Console에서 수행');

    progress?.step('Console HTTPS 인증서와 TLS Secret 준비');
    recordInstallationState(
      lock,
      cluster.storageClass,
      initialAdmin,
      effectiveConsoleUrl,
      effectiveAuthEnvironment,
      shellTlsSecretRefText(effectiveShellTls),
      'Preparing',
      { baselineObservabilitySecurity: cluster.baselineObservabilitySecurity }
    );
    installationStateRecorded = true;

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
      trustLocalCa
      && !externalShellTls
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
    ensureSupabaseServerSecret();
    progress?.done('CLI runtime과 exact six-key Supabase server Secret 준비');

    progress?.step('Supabase·Gitea·Beszel backbone 및 OpenSphere workload 적용');
    recordInstallationState(
      lock,
      cluster.storageClass,
      initialAdmin,
      effectiveConsoleUrl,
      effectiveAuthEnvironment,
      shellTlsSecretRefText(effectiveShellTls),
      'Installing',
      { baselineObservabilitySecurity: cluster.baselineObservabilitySecurity }
    );
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
    progress?.step('Supabase·Gitea·Beszel·C_API·C_EXT·Registry·CLI·Main Shell rollout 대기');
    waitForCoreRollouts(lock, progress);
    progress?.done('핵심 workload Ready');
    if(registry.lifecycleGeneration && registryCredentials){
      progress?.step('Console registry credential 인계 및 Secret 전파 확인');
      await verifyRegistryHandoff(registry.lifecycleGeneration);
      progress?.done('Console이 동일 credential generation과 5개 namespace 전파를 확인함');
    }

    progress?.step('Pod·Service·runtime image·초기 관리자 상태 최종 검증');
    const evidence = await verifyInstallation(lock, {
      requireZeroRestarts,
      consoleUrl: effectiveConsoleUrl,
      requireRecoveryDrill: false
    });
    recordReleaseInventory(lock, releaseResourceInventory(prepared.all));
    recordInstallationState(
      lock,
      cluster.storageClass,
      initialAdmin,
      effectiveConsoleUrl,
      effectiveAuthEnvironment,
      shellTlsSecretRefText(effectiveShellTls),
      'Ready',
      {
        verification: {
          evidenceConfigMap: 'opensphere-installation-evidence',
          verifiedAt: evidence.verifiedAt
        },
        baselineObservabilitySecurity: cluster.baselineObservabilitySecurity
      }
    );
    installationReady = true;
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
      setupRequired: evidence.consoleApi.initialOperatorState === 'required',
      temporaryDirectory: keepTemporaryFiles ? work : undefined
    };
  } catch (error) {
    if (installationStateRecorded && !installationReady) {
      try {
        recordInstallationState(
          lock,
          cluster.storageClass,
          initialAdmin,
          effectiveConsoleUrl,
          effectiveAuthEnvironment,
          shellTlsSecretRefText(effectiveShellTls),
          'Failed',
          {
            failureCode: 'bootstrap-failed',
            baselineObservabilitySecurity: cluster.baselineObservabilitySecurity
          }
        );
      } catch {}
    }
    throw error;
  } finally {
    if (!keepTemporaryFiles) await rm(work, { recursive: true, force: true });
  }
}

export async function upgrade(
  previousLock,
  targetLock,
  {
    storageClass,
    consoleUrl,
    registryCredentials,
    sourceArtifactCredential = null,
    requiredPlatforms,
    runtime = {}
  } = {}
) {
  validateLock(previousLock, {
    allowLegacyComponentSet: true,
    allowInstalledAgentIdentityCutover: true
  });
  validateLock(targetLock);
  validateReleaseTransition(previousLock, targetLock);
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
    runComponentMigrations,
    waitForCoreRollouts,
    waitForComponentRollouts,
    verifyInstallation,
    recordInstallationState,
    readReleaseInventory,
    releaseResourceInventory,
    pruneReleaseResources,
    recordReleaseInventory,
    deleteAgentIdentityNamespace: (namespace) =>
      kubectl(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=true']),
    ensureManagedNamespaces: () => {
      for (const namespace of MANAGED_NAMESPACES) ensureNamespace(namespace);
    },
    ...runtime
  };
  await Promise.all([
    operations.verifyReleaseLock(previousLock, {
      registryCredentials,
      requiredPlatforms,
      allowLegacyComponentSet: true,
      allowInstalledAgentIdentityCutover: true,
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
    return {
      changed: false,
      lock: previousLock,
      consoleUrl: effectiveConsoleUrl,
      evidence: await operations.verifyInstallation(previousLock, { consoleUrl: effectiveConsoleUrl })
    };
  }
  operations.preflight({ storageClass: config.storageClass, channel: targetLock.channel });
  operations.ensureManagedNamespaces();
  if(registryCredentials?.lifecycle?.mode==='github-device')throw new Error('Use Console Registry reauthorization for an existing installation; Setup upgrade does not replace runtime refresh authority');
  operations.ensureRegistryPullSecrets(targetLock, registryCredentials);
  const initialAdmin = config.initialAdmin;
  const componentTransition = targetLock.releaseScope === RELEASE_SCOPE_COMPONENT;
  const changedComponents = componentTransition ? targetLock.changedComponents : [];
  const agentIdentityCutover = componentTransition
    && isAgentIdentityCutover(previousLock.components, targetLock.components);
  const introducedComponents = componentTransition
    ? changedComponents.filter((component) => !previousLock.components?.[component])
    : [];
  const rollbackChangedComponents = agentIdentityCutover
    ? changedComponents.map(installedNameForCanonicalComponent)
    : changedComponents.filter((component) => !introducedComponents.includes(component));
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
          { changedComponents, includeMigrations: true, sourceArtifactCredential }
        ),
        rollbackChangedComponents.length > 0
          ? operations.prepareComponentRelease(
            previousLock,
            rollbackWork,
            config.storageClass,
            effectiveConsoleUrl,
            config.authEnvironment,
            {
              changedComponents: rollbackChangedComponents,
              includeMigrations: false,
              sourceArtifactCredential
            }
          )
          : Promise.resolve({
            foundation: { root: rollbackWork, release: [], migration: null },
            base: [],
            all: []
          })
      ])
      : await Promise.all([
        operations.prepareRelease(
          targetLock,
          targetWork,
          config.storageClass,
          effectiveConsoleUrl,
          config.authEnvironment,
          { sourceArtifactCredential }
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
            migrationEvidence: targetLock.releaseBom?.migrationManifest,
            sourceArtifactCredential
          }
        )
      ]);
    const recordedInventory = operations.readReleaseInventory();
    if (componentTransition && !recordedInventory) {
      throw new Error('Component release requires the existing complete release inventory');
    }
    const previousInventory = recordedInventory
      ?? operations.releaseResourceInventory(rollback.all);
    const previousComponentInventory = componentTransition && rollback.all.length > 0
      ? operations.releaseResourceInventory(rollback.all)
      : [];
    const targetComponentInventory = componentTransition
      ? operations.releaseResourceInventory(target.all)
      : [];
    const targetInventory = componentTransition
      ? replaceComponentInventory(previousInventory, previousComponentInventory, targetComponentInventory)
      : operations.releaseResourceInventory(target.all);
    let agentIdentityMigrationCommitted = false;
    try {
      if (componentTransition) {
        operations.installPreparedComponentRelease(
          targetLock,
          target,
          config.storageClass,
          effectiveConsoleUrl,
          '업그레이드',
          changedComponents,
          undefined,
          { applyMigrations: !agentIdentityCutover }
        );
        if (agentIdentityCutover) {
          // The canonical workloads are staged first while the old DB identity
          // is still intact. Migration 0063 is transactional but intentionally
          // one-way; once it commits, a false rollback to pre-cutover binaries would be unsafe.
          operations.runComponentMigrations(target.foundation);
          agentIdentityMigrationCommitted = true;
        }
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
      else operations.waitForCoreRollouts(targetLock);
      const evidence = await operations.verifyInstallation(targetLock, {
        consoleUrl: effectiveConsoleUrl,
        requireZeroRestarts: false,
        componentSelection: componentTransition ? changedComponents : null
      });
      if (agentIdentityCutover) {
        operations.pruneReleaseResources(previousComponentInventory, targetComponentInventory);
        operations.deleteAgentIdentityNamespace(LEGACY_INSTALLED_AGENT_NAMESPACE);
      } else if (componentTransition) {
        operations.pruneReleaseResources(previousComponentInventory, targetComponentInventory);
      } else {
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
      console.error(`[롤백] upgrade 검증 실패: ${upgradeError.message}`);
      if (agentIdentityCutover) {
        if (agentIdentityMigrationCommitted) {
          // The DB schema, roles and policies now have OSAA identity. Preserve
          // the canonical lock and workloads for deterministic resume instead
          // of pretending that old binaries can be restored against new data.
          operations.recordInstallationState(
            targetLock,
            config.storageClass,
            initialAdmin,
            effectiveConsoleUrl,
            config.authEnvironment,
            config.shellTlsSecret
          );
          operations.recordReleaseInventory(targetLock, targetInventory);
          throw new Error(
            `OSAA identity cutover requires attention after its one-way database migration; `
            + `the canonical target was preserved for resume: ${upgradeError.message}`
          );
        }
        // Before migration commit, the installed identity remains untouched.
        // Remove only newly staged OSAA resources and leave the old installation
        // lock/inventory as the exact recovery point.
        operations.pruneReleaseResources(targetComponentInventory, previousComponentInventory);
        operations.deleteAgentIdentityNamespace(CANONICAL_AGENT_NAMESPACE);
        operations.recordReleaseInventory(previousLock, previousInventory);
        throw new Error(`OSAA identity cutover failed before migration; previous installation retained: ${upgradeError.message}`);
      }
      try {
        if (componentTransition && rollbackChangedComponents.length > 0) {
          operations.installPreparedComponentRelease(
            previousLock,
            rollback,
            config.storageClass,
            effectiveConsoleUrl,
            '롤백',
            rollbackChangedComponents,
            undefined,
            { applyMigrations: false }
          );
        } else {
          if (!componentTransition) operations.installPreparedRelease(
            previousLock, rollback, config.storageClass, effectiveConsoleUrl, '롤백'
          );
        }
        if (componentTransition) {
          operations.pruneReleaseResources(targetComponentInventory, previousComponentInventory);
        }
        operations.recordInstallationState(
          previousLock,
          config.storageClass,
          initialAdmin,
          effectiveConsoleUrl,
          config.authEnvironment,
          config.shellTlsSecret
        );
        if (componentTransition && rollbackChangedComponents.length > 0) {
          operations.waitForComponentRollouts(rollbackChangedComponents);
        }
        else operations.waitForCoreRollouts(previousLock);
        await operations.verifyInstallation(previousLock, {
          consoleUrl: effectiveConsoleUrl,
          requireZeroRestarts: false,
          mode: 'rollback',
          componentSelection: componentTransition && rollbackChangedComponents.length > 0
            ? rollbackChangedComponents
            : null
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
