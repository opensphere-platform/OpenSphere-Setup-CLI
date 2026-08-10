import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BASE_MANIFESTS,
  CORE_ROLLOUTS,
  GITEA_MANIFEST,
  renderManifest,
  SUPABASE_MANIFEST,
  SUPABASE_MIGRATIONS
} from '../src/bootstrap.mjs';
import { COMPONENTS } from '../src/release.mjs';
import { DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB } from '../src/doctor.mjs';

const CONSOLE_SOURCE = process.env.OPENSPHERE_CONSOLE_SOURCE
  ? pathToFileURL(`${resolve(process.env.OPENSPHERE_CONSOLE_SOURCE)}${sep}`)
  : new URL('../../OpenSphere-console/', import.meta.url);

function localReleaseLock() {
  const components = Object.fromEntries(Object.entries(COMPONENTS).map(
    ([component, repository], index) => [
      component,
      {
        image: `ghcr.io/opensphere-platform/${repository}@sha256:${String(index + 1).padStart(64, '0')}`
      }
    ]
  ));
  return { sourceRevision: '1'.repeat(40), components };
}

test('fresh bootstrap is Supabase Data & Identity plus separate Gitea change authority', () => {
  assert.equal(SUPABASE_MANIFEST.path, 'backend/supabase/bootstrap/supabase.yaml');
  assert.equal(GITEA_MANIFEST.path, 'backend/gitea/bootstrap/gitea.yaml');
  assert.deepEqual(SUPABASE_MANIFEST.replacements.map(([, component]) => component), [
    'supabasePostgres', 'supabaseAuth', 'supabaseRest', 'supabaseStorage'
  ]);
  assert.deepEqual(GITEA_MANIFEST.replacements.map(([, component]) => component), [
    'gitea', 'giteaPostgres'
  ]);
});

test('fresh bootstrap provisions the exact Valkey credential without rotating it on resume', () => {
  const bootstrap = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(
    bootstrap,
    /ensureGenericSecret\('opensphere-foundation', 'foundation-data-valkey-auth', \{[\s\S]*?password: randomBytes\(32\)\.toString\('base64'\)/
  );
  assert.match(bootstrap, /mergeSecretData\(existing\?\.data, candidate\)/);
});

test('fresh bootstrap provisions the exact RustFS credential without rotating it on resume', () => {
  const bootstrap = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(
    bootstrap,
    /ensureGenericSecret\('opensphere-foundation', 'rustfs-credentials', \{[\s\S]*?access_key:[\s\S]*?secret_key: randomBytes\(32\)\.toString\('base64url'\)/
  );
  assert.match(bootstrap, /mergeSecretData\(existing\?\.data, candidate\)/);
});

test('fresh bootstrap grants the Foundation Console only exact data-engine Secret access', () => {
  const bootstrap = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(bootstrap, /resourceNames: \['foundation-data-valkey-auth', 'rustfs-credentials'\]/);
  assert.match(bootstrap, /verbs: \['get', 'patch'\]/);
  assert.match(bootstrap, /subjects: \[\{ kind: 'ServiceAccount', name: 'opensphere-foundation', namespace: 'opensphere-console' \}\]/);
  assert.doesNotMatch(bootstrap, /resources: \['secrets'\][\s\S]{0,180}verbs: \[[^\]]*(?:create|delete|list|watch)/);
});

test('all current Supabase migrations, including component release and backup contracts, are release material', () => {
  assert.equal(SUPABASE_MIGRATIONS[0], '0001_console_backbone.sql');
  assert.equal(SUPABASE_MIGRATIONS.at(-1), '0052_r2d2_engineering_execution.sql');
  assert.equal(SUPABASE_MIGRATIONS.includes('0011_notification_delivery.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0022_oaa_recovery_owner_permissions.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0024_ai_consumer_contract.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0026_schema_migration_ledger.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0028_change_reconcile_retry.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0029_browser_session_and_baseline_monitoring.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0030_ceph_data_path_verification_runtime.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0031_foundation_bootstrap_consumer.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0032_audit_event_ledger_chain.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0033_platform_release_consumer.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0035_module_operation_ledger.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0036_platform_support_observability_permissions.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0037_browser_session_expiry_evidence.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0038_oaa_watch_cursor_status_vocabulary.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0039_audit_ledger_integrity.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0040_approval_outcome_ledger.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0041_agent_action_ledger.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0042_foundation_bootstrap_catalog_mirror.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0043_external_backup_s3_compatible_profiles.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0044_external_backup_target_tls_trust.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0045_legacy_audit_fork_convergence_repair.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0046_r2d2_operational_graph.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0047_r2d2_incident_risk.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0048_r2d2_durable_operation.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0049_r2d2_engineering_remediation.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0050_r2d2_retention_slo.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0051_r2d2_engineering_worker_isolation.sql'), true);
  assert.equal(SUPABASE_MIGRATIONS.includes('0052_r2d2_engineering_execution.sql'), true);
  assert.equal(new Set(SUPABASE_MIGRATIONS).size, SUPABASE_MIGRATIONS.length);
  const bootstrapSource = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(bootstrapSource, /0032_audit_ledger_integrity\.sql/);
  assert.doesNotMatch(bootstrapSource, /0033_approval_outcome_ledger\.sql/);
  assert.doesNotMatch(bootstrapSource, /0034_agent_action_ledger\.sql/);
});

test('base Main Shell includes Backend, DUPA, notification, OAA, governed adapter and production guardrails', () => {
  const paths = BASE_MANIFESTS.map(({ path }) => path);
  for (const path of [
    'backend/opensphere-console-backend/deploy.yaml',
    'backend/dupa-control/opensphere-console-dupa-controller.yaml',
    'backend/notification-dispatcher/deploy.yaml',
    'backend/recovery/recovery-jobs.yaml',
    'backend/opensphere-console-oaa-gateway/deploy.yaml',
    'backend/oaa-governed-adapter/deploy.yaml',
    'deploy/production-hardening.yaml',
    'deploy/manual-ui-admission-policy.yaml',
    'deploy/console-image-admission-policy.yaml',
    'deploy/opensphere-console.yaml'
  ]) assert.equal(paths.includes(path), true, path);
  assert.equal(paths.some((path) => /kanidm|backbone/.test(path)), false);
});

test('rollout order establishes Supabase and Gitea before OAA and Main Shell', () => {
  const index = (namespace, resource) =>
    CORE_ROLLOUTS.findIndex(([candidateNamespace, candidateResource]) =>
      candidateNamespace === namespace && candidateResource === resource);
  const supabase = index('opensphere-console-data', 'statefulset/opensphere-supabase-postgres');
  const gitea = index('opensphere-console-change', 'deployment/opensphere-gitea');
  const backend = index('opensphere-console', 'deployment/opensphere-console-backend');
  const foundationBootstrap = index('opensphere-console', 'deployment/foundation-bootstrap-reconciler');
  const oaa = index('opensphere-console', 'deployment/opensphere-console-oaa-gateway');
  const shell = index('opensphere-console', 'deployment/opensphere-console');
  assert.ok(supabase >= 0 && gitea >= 0 && backend >= 0 && foundationBootstrap >= 0 && oaa >= 0 && shell >= 0);
  assert.ok(supabase < backend);
  assert.ok(gitea < backend);
  assert.ok(backend < foundationBootstrap);
  assert.ok(foundationBootstrap < oaa);
  assert.ok(backend < oaa);
  assert.ok(oaa < shell);
});

test('every release base workload references the Setup-managed GHCR pull Secret', () => {
  const files = [
    'backend/supabase/bootstrap/supabase.yaml',
    'backend/gitea/bootstrap/gitea.yaml',
    'backend/opensphere-console-backend/deploy.yaml',
    'backend/dupa-control/opensphere-console-dupa-controller.yaml',
    'backend/notification-dispatcher/deploy.yaml',
    'backend/recovery/recovery-jobs.yaml',
    'backend/opensphere-console-oaa-gateway/deploy.yaml',
    'backend/oaa-governed-adapter/deploy.yaml',
    'deploy/opensphere-console.yaml'
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, CONSOLE_SOURCE), 'utf8');
    const workloads = [...source.matchAll(/^kind:\s*(?:Deployment|StatefulSet|DaemonSet|Job|CronJob)\s*$/gm)].length;
    const pullSecretReferences = [...source.matchAll(/imagePullSecrets:\s*\[\{ name: opensphere-ghcr-pull \}\]/g)].length;
    assert.ok(workloads >= 1, `${file} must contain at least one workload`);
    assert.equal(
      pullSecretReferences,
      workloads,
      `${file} must attach the managed pull Secret to every workload Pod template`
    );
  }
});

test('production guardrails are released with PDBs and stateless control-plane topology spread', () => {
  const hardening = readFileSync(new URL('deploy/production-hardening.yaml', CONSOLE_SOURCE), 'utf8');
  assert.match(hardening, /kind: PodDisruptionBudget[\s\S]+name: opensphere-console/);
  assert.match(hardening, /kind: PodDisruptionBudget[\s\S]+name: opensphere-console-backend/);
  assert.match(hardening, /kind: NetworkPolicy[\s\S]+name: opensphere-console-ingress/);
  for (const file of [
    'deploy/opensphere-console.yaml',
    'backend/opensphere-console-backend/deploy.yaml',
    'backend/opensphere-console-oaa-gateway/deploy.yaml'
  ]) {
    const source = readFileSync(new URL(file, CONSOLE_SOURCE), 'utf8');
    assert.match(source, /topologySpreadConstraints:[\s\S]+topologyKey: kubernetes\.io\/hostname[\s\S]+whenUnsatisfiable: DoNotSchedule/);
  }
});

test('every canonical Console manifest renders with only governed immutable images', () => {
  const lock = localReleaseLock();
  for (const spec of [SUPABASE_MANIFEST, GITEA_MANIFEST, ...BASE_MANIFESTS]) {
    const source = readFileSync(new URL(spec.path, CONSOLE_SOURCE), 'utf8');
    const rendered = renderManifest(
      lock,
      spec,
      source,
      'hostpath',
      'https://localhost:8090',
      'development'
    );
    assert.doesNotMatch(rendered, /__OPENSPHERE_[A-Z0-9_]+__/);
    const images = [...rendered.matchAll(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/gm)]
      .map((match) => match[1]);
    for (const image of images) {
      assert.match(
        image,
        /^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/
      );
    }
  }
});

test('selected StorageClass is rendered into every Supabase PVC', () => {
  const lock = localReleaseLock();
  const source = readFileSync(new URL(SUPABASE_MANIFEST.path, CONSOLE_SOURCE), 'utf8');
  const rendered = renderManifest(
    lock,
    SUPABASE_MANIFEST,
    source,
    'hostpath',
    'https://localhost:8090',
    'development'
  );
  const pvcCount = [...rendered.matchAll(/^kind:\s*PersistentVolumeClaim\s*$/gm)].length;
  const selectedClassCount = [...rendered.matchAll(/^\s*storageClassName:\s*hostpath\s*$/gm)].length;
  assert.equal(pvcCount, 2);
  assert.equal(selectedClassCount, pvcCount);
});

test('doctor PVC capacity report matches the canonical Supabase and Gitea manifests', () => {
  const manifests = [SUPABASE_MANIFEST, GITEA_MANIFEST]
    .map((spec) => readFileSync(new URL(spec.path, CONSOLE_SOURCE), 'utf8'))
    .join('\n');
  const requestedGiB = [...manifests.matchAll(/requests:\s*\{\s*storage:\s*(\d+)Gi\s*\}/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(requestedGiB, DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB);
});

test('active Setup bootstrap source has no retired runtime orchestration', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /opensphere-console-auth|opensphere-backbone|backbone-postgres|backbone-rustfs/);
  assert.doesNotMatch(source, /provision-admin\.mjs|recover-account|KANIDM_/);
});
