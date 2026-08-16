import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BASE_MANIFESTS,
  CORE_ROLLOUTS,
  FOUNDATION_ARTIFACT_PATHS,
  GITEA_MANIFEST,
  parseSupabaseMigrationManifest,
  renderManifest,
  SUPABASE_MIGRATION_MANIFEST,
  SUPABASE_MANIFEST,
  verifySupabaseMigrationArtifact,
} from '../src/bootstrap.mjs';
import { AUXILIARY_ARTIFACTS, COMPONENTS } from '../src/release.mjs';
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
  const auxiliaryArtifacts = {
    cliArtifacts: {
      image: `ghcr.io/opensphere-platform/${AUXILIARY_ARTIFACTS.cliArtifacts}@sha256:${'f'.repeat(64)}`
    }
  };
  return { sourceRevision: '1'.repeat(40), components, auxiliaryArtifacts };
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

test('Setup consumes the Console digest-bound migration manifest without a handwritten inventory', () => {
  assert.equal(SUPABASE_MIGRATION_MANIFEST, 'backend/supabase/migrations/manifest.json');
  const raw = readFileSync(new URL(SUPABASE_MIGRATION_MANIFEST, CONSOLE_SOURCE), 'utf8');
  const manifest = parseSupabaseMigrationManifest(raw);
  assert.equal(manifest.migrations[0].name, '0001_console_backbone.sql');
  assert.equal(manifest.latestMigrationId, '0057');
  assert.equal(manifest.migrations.at(-1).name, '0057_foundation_postgres_durable_plan.sql');
  assert.equal(new Set(manifest.migrations.map(({ id }) => id)).size, manifest.migrations.length);
  assert.equal(manifest.schemaVersion, 2);
  const legacyV1 = structuredClone(manifest);
  legacyV1.schemaVersion = 1;
  assert.throws(() => parseSupabaseMigrationManifest(legacyV1), /Unsupported Supabase migration manifest/);
  assert.equal(manifest.migrations[0].predecessorMigrationId, null);
  assert.equal(manifest.migrations.at(-1).predecessorMigrationId, manifest.migrations.at(-2).id);
  const tampered = structuredClone(manifest);
  tampered.migrations[0] = { ...tampered.migrations[0], sha256: 'f'.repeat(64) };
  assert.throws(() => parseSupabaseMigrationManifest(tampered), /set digest mismatch/);
  const first = manifest.migrations[0];
  const firstSql = readFileSync(new URL(first.path, CONSOLE_SOURCE), 'utf8');
  assert.equal(verifySupabaseMigrationArtifact(first, firstSql), true);
  assert.throws(() => verifySupabaseMigrationArtifact(first, `${firstSql}\n-- tampered`), /digest differs/);
  const duplicate = structuredClone(manifest);
  duplicate.migrations[1] = { ...duplicate.migrations[1], id: duplicate.migrations[0].id };
  assert.throws(() => parseSupabaseMigrationManifest(duplicate), /Invalid or duplicate/);
  const brokenLineage = structuredClone(manifest);
  brokenLineage.migrations[2] = { ...brokenLineage.migrations[2], predecessorMigrationId: '9999' };
  assert.throws(() => parseSupabaseMigrationManifest(brokenLineage), /Invalid or duplicate/);
  const bootstrapSource = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(bootstrapSource, /SUPABASE_MIGRATIONS\s*=\s*Object\.freeze\(\[/);
  assert.doesNotMatch(bootstrapSource, /0032_audit_ledger_integrity\.sql/);
  assert.doesNotMatch(bootstrapSource, /0033_approval_outcome_ledger\.sql/);
  assert.doesNotMatch(bootstrapSource, /0034_agent_action_ledger\.sql/);
  assert.equal(FOUNDATION_ARTIFACT_PATHS.includes('backend/supabase/migrate-only.ps1'), false,
    'integrated rollback must not require a component-only runner from an older source revision');
  assert.match(bootstrapSource, /migrationSourceRevision: targetLock\.sourceRevision/,
    'integrated rollback must use the target digest-bound forward-only migration set');
  assert.match(bootstrapSource, /migrationEvidence: targetLock\.releaseBom\?\.migrationManifest/,
    'integrated rollback must verify the target migration set against target Release BOM evidence');
  assert.match(bootstrapSource, /\{ changedComponents, includeMigrations: false \}/,
    'component rollback must not prepare or reverse schema migrations');
  const migrationCall = bootstrapSource.indexOf('runComponentMigrations(prepared.foundation');
  const workloadApply = bootstrapSource.indexOf('applyRelease(release, label, progress)', migrationCall);
  assert.ok(migrationCall > 0 && workloadApply > migrationCall,
    'component migrations must complete before changed workload manifests are applied');
});

test('base Main Shell includes Backend, DUPA, notification, OAA, governed adapter and production guardrails', () => {
  const paths = BASE_MANIFESTS.map(({ path }) => path);
  for (const path of [
    'backend/opensphere-console-backend/deploy.yaml',
    'backend/os-cli/deploy.yaml',
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

test('rollout order establishes Supabase, Gitea and the CLI artifact before Main Shell', () => {
  const index = (namespace, resource) =>
    CORE_ROLLOUTS.findIndex(([candidateNamespace, candidateResource]) =>
      candidateNamespace === namespace && candidateResource === resource);
  const supabase = index('opensphere-console-data', 'statefulset/opensphere-supabase-postgres');
  const gitea = index('opensphere-console-change', 'deployment/opensphere-gitea');
  const backend = index('opensphere-console', 'deployment/opensphere-console-backend');
  const foundationBootstrap = index('opensphere-console', 'deployment/foundation-bootstrap-reconciler');
  const oaa = index('opensphere-console', 'deployment/opensphere-console-oaa-gateway');
  const cliArtifact = index('opensphere-console', 'deployment/os-cli');
  const shell = index('opensphere-console', 'deployment/opensphere-console');
  assert.ok(supabase >= 0 && gitea >= 0 && backend >= 0 && foundationBootstrap >= 0
    && oaa >= 0 && cliArtifact >= 0 && shell >= 0);
  assert.ok(supabase < backend);
  assert.ok(gitea < backend);
  assert.ok(backend < foundationBootstrap);
  assert.ok(foundationBootstrap < oaa);
  assert.ok(backend < oaa);
  assert.ok(cliArtifact < shell);
  assert.ok(oaa < shell);
});

test('fresh install downloads os only after the lock-bound CLI artifact and Console are Ready', () => {
  const cli = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  const bootstrapCall = cli.indexOf('const bootstrapResult = await bootstrap(lock');
  const cliInstall = cli.indexOf('const installedCli = await installConsoleCliFromCluster', bootstrapCall);
  assert.ok(bootstrapCall >= 0 && cliInstall > bootstrapCall);
  const bootstrap = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const waitCall = bootstrap.indexOf('waitForCoreRollouts(lock, progress)');
  const verifyCall = bootstrap.indexOf('const evidence = await verifyInstallation(lock', waitCall);
  assert.ok(waitCall >= 0 && verifyCall > waitCall);
});

test('every release base workload references the Setup-managed GHCR pull Secret', () => {
  const files = [
    'backend/supabase/bootstrap/supabase.yaml',
    'backend/gitea/bootstrap/gitea.yaml',
    'backend/opensphere-console-backend/deploy.yaml',
    'backend/os-cli/deploy.yaml',
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

test('custom Console endpoint rewrites every canonical public-origin authority', () => {
  const lock = localReleaseLock();
  const spec = BASE_MANIFESTS.find(({ path }) => path === 'backend/opensphere-console-backend/deploy.yaml');
  assert.ok(spec, 'Console backend manifest must remain a governed base manifest');
  const source = readFileSync(new URL(spec.path, CONSOLE_SOURCE), 'utf8');
  const rendered = renderManifest(
    lock,
    spec,
    source,
    'hostpath',
    'https://localhost:18090',
    'development'
  );
  assert.doesNotMatch(rendered, /https:\/\/localhost:1114/);
  assert.match(rendered, /name: SUPABASE_AUTH_ISSUER, value: "https:\/\/localhost:18090\/auth\/v1"/);
  assert.match(rendered, /name: CONSOLE_PUBLIC_URL, value: "https:\/\/localhost:18090"/);
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
