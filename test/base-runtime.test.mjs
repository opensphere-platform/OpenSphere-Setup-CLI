import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BASE_MANIFESTS,
  baseManifestSpecs,
  BESZEL_MANIFEST,
  CONSOLE_API_MANIFEST,
  coreRolloutsForLock,
  CORE_ROLLOUTS,
  EXTENSION_CONTROLLER_MANIFEST,
  FOUNDATION_ARTIFACT_PATHS,
  GITEA_MANIFEST,
  MANAGED_CLUSTER_RBAC,
  parseSupabaseMigrationManifest,
  renderManifest,
  supabaseServerSecretManifest,
  SUPABASE_MIGRATION_MANIFEST,
  SUPABASE_MANIFEST,
  verifySupabaseMigrationArtifact,
} from '../src/bootstrap.mjs';
import {
  AUXILIARY_ARTIFACTS,
  AVAILABLE_MODULE_COMPONENTS,
  BOOTSTRAP_CORE_COMPONENTS,
  COMPONENTS,
  releaseResponsibilityProfile
} from '../src/release.mjs';
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
  return {
    sourceRevision: '1'.repeat(40),
    components,
    auxiliaryArtifacts: {
      cliArtifacts: {
        image: `ghcr.io/opensphere-platform/${AUXILIARY_ARTIFACTS.cliArtifacts}@sha256:${'f'.repeat(64)}`
      }
    }
  };
}

test('fresh bootstrap consumes the target Supabase, Gitea, C_API, C_EXT and Beszel manifests', () => {
  assert.equal(SUPABASE_MANIFEST.path, 'backend/supabase/target/deploy.yaml');
  assert.equal(GITEA_MANIFEST.path, 'backend/gitea/bootstrap/gitea.yaml');
  assert.equal(CONSOLE_API_MANIFEST.path, 'apps/console-api/deploy.yaml');
  assert.equal(EXTENSION_CONTROLLER_MANIFEST.path, 'apps/extension-controller/deploy.yaml');
  assert.equal(BESZEL_MANIFEST.path, 'deploy/baseline-monitoring/beszel-release.yaml');
  assert.deepEqual(SUPABASE_MANIFEST.replacements.map(([, component]) => component), [
    'supabasePostgres', 'supabaseAuth', 'supabaseRest', 'supabaseStorage'
  ]);
  assert.deepEqual(GITEA_MANIFEST.replacements.map(([, component]) => component), [
    'gitea', 'giteaPostgres'
  ]);
  assert.deepEqual(BESZEL_MANIFEST.replacements.map(([, component]) => component), [
    'beszelHub', 'beszelAgent', 'beszelBootstrap'
  ]);
});

test('Setup owns the exact cluster-scoped C_EXT CLI download authority it installs', () => {
  const source = readFileSync(new URL(EXTENSION_CONTROLLER_MANIFEST.path, CONSOLE_SOURCE), 'utf8');
  const authority = 'opensphere-extension-controller-cli-downloads';
  assert.match(source, /kind: ClusterRole\r?\nmetadata:\r?\n  name: opensphere-extension-controller-cli-downloads/u);
  assert.match(source, /kind: ClusterRoleBinding\r?\nmetadata:\r?\n  name: opensphere-extension-controller-cli-downloads/u);
  assert.deepEqual(MANAGED_CLUSTER_RBAC, [
    'clusterrolebinding/opensphere-extension-controller-cli-downloads',
    'clusterrolebinding/opensphere-registry',
    'clusterrole/opensphere-extension-controller-cli-downloads',
    'clusterrole/opensphere-registry'
  ]);
  assert.equal(MANAGED_CLUSTER_RBAC.every((resource) => resource.endsWith(authority)
    || resource.endsWith('opensphere-registry')), true);
});

test('fresh bootstrap creates only the exact six-key Supabase server Secret', () => {
  const manifest = supabaseServerSecretManifest();
  assert.equal(manifest.type, 'Opaque');
  assert.equal(manifest.metadata.namespace, 'opensphere-console-data');
  assert.equal(manifest.metadata.labels['opensphere.io/secret-scope'], 'supabase-server-only');
  assert.deepEqual(Object.keys(manifest.data).sort(), [
    'anon-key', 'jwt-secret', 'postgres-password', 's3-access-key-id',
    's3-access-key-secret', 'service-role-key'
  ]);
  assert.equal(supabaseServerSecretManifest(manifest), null);
  const extra = structuredClone(manifest);
  extra.data['console-side-secret'] = Buffer.from('forbidden').toString('base64');
  assert.throws(() => supabaseServerSecretManifest(extra), /exact six-key target contract/);
});

test('Setup consumes the Console global migration manifest and materialized-release evidence', () => {
  assert.equal(SUPABASE_MIGRATION_MANIFEST, 'migrations/manifest.json');
  const raw = readFileSync(new URL(SUPABASE_MIGRATION_MANIFEST, CONSOLE_SOURCE), 'utf8');
  const manifest = parseSupabaseMigrationManifest(raw);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.repository, 'OpenSphere-Console');
  assert.equal(manifest.migrationCount, manifest.migrations.length);
  assert.equal(manifest.latestGlobalId, manifest.migrations.at(-1).globalId);
  assert.equal(manifest.migrations[0].predecessorGlobalId, null);
  assert.equal(
    manifest.migrations.at(-1).predecessorGlobalId,
    manifest.migrations.at(-2).globalId
  );
  assert.equal(new Set(manifest.migrations.map(({ globalId }) => globalId)).size, manifest.migrations.length);
  assert.equal(new Set(manifest.migrations.map(({ semanticKey }) => semanticKey)).size, manifest.migrations.length);

  const first = manifest.migrations[0];
  const firstSql = readFileSync(new URL(first.path, CONSOLE_SOURCE), 'utf8');
  assert.equal(verifySupabaseMigrationArtifact(first, firstSql), true);
  assert.throws(
    () => verifySupabaseMigrationArtifact(first, `${firstSql}\n-- tampered`),
    /digest differs/
  );

  const tampered = structuredClone(manifest);
  tampered.migrations[0].sha256 = 'f'.repeat(64);
  assert.throws(() => parseSupabaseMigrationManifest(tampered), /Invalid or duplicate/);
  const duplicate = structuredClone(manifest);
  duplicate.migrations[1].globalId = duplicate.migrations[0].globalId;
  assert.throws(() => parseSupabaseMigrationManifest(duplicate), /Invalid or duplicate/);
  const openSchema = { ...manifest, undeclaredAuthority: true };
  assert.throws(() => parseSupabaseMigrationManifest(openSchema), /Unsupported Console migration manifest/);

  assert.deepEqual(FOUNDATION_ARTIFACT_PATHS, [
    'scripts/Install-ConsoleApiRuntime.ps1',
    'scripts/console-migrations.mjs',
    'backend/gitea/bootstrap/install.ps1',
    'backend/gitea/bootstrap/configure-signing.ps1',
    'backend/gitea/bootstrap/control-plane-bootstrap.ps1',
    'deploy/baseline-monitoring/install.ps1'
  ]);
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(source, /-VerifiedMaterializedRelease/);
  assert.match(source, /-ExpectedMigrationManifestSha256/);
  assert.match(source, /-ExpectedMigrationSetDigest/);
  assert.match(source, /-ExpectedMigrationLatestGlobalId/);
});

test('base manifests contain only bootstrap-owned shared surfaces', () => {
  assert.deepEqual(BASE_MANIFESTS.map(({ path }) => path), [
    'apps/extension-controller/crds/ui-plugin-crds.yaml',
    'apps/extension-controller/config/trusted-keys.yaml',
    'cmd/os-cli/deploy.yaml',
    'backend/registry/deploy/registry.yaml',
    'deploy/manual-ui-admission-policy.yaml',
    'deploy/console-image-admission-policy.yaml',
    'deploy/opensphere-console.yaml'
  ]);
  const paths = baseManifestSpecs(localReleaseLock()).map(({ path }) => path).join('\n');
  for (const retired of [
    'opensphere-console-backend',
    'dupa-control',
    'notification-dispatcher',
    'opensphere-console-osaa-gateway',
    'opensphere-osdst',
    'osaa-governed-adapter',
    'recovery-jobs'
  ]) assert.doesNotMatch(paths, new RegExp(retired));
});

test('release responsibility separates bootstrap core from Console-activated modules', () => {
  const profile = releaseResponsibilityProfile(COMPONENTS);
  assert.deepEqual(profile.bootstrapCore, [...BOOTSTRAP_CORE_COMPONENTS]);
  assert.deepEqual(profile.availableModules, [...AVAILABLE_MODULE_COMPONENTS]);
  for (const component of ['beszelHub', 'beszelAgent', 'beszelBootstrap']) {
    assert.equal(profile.bootstrapCore.includes(component), true);
  }
  for (const component of AVAILABLE_MODULE_COMPONENTS) {
    assert.equal(CORE_ROLLOUTS.some((entry) => entry.join('/').includes(component)), false);
  }
  assert.equal(Object.hasOwn(COMPONENTS, 'backend'), false);
});

test('rollout order establishes authorities, C_API/C_EXT, Beszel and CLI before Main Shell', () => {
  const index = (namespace, resource) =>
    CORE_ROLLOUTS.findIndex(([candidateNamespace, candidateResource]) =>
      candidateNamespace === namespace && candidateResource === resource);
  const postgres = index('opensphere-console-data', 'statefulset/opensphere-supabase-postgres');
  const gitea = index('opensphere-console-change', 'deployment/opensphere-gitea');
  const api = index('opensphere-console', 'deployment/opensphere-console-api');
  const extension = index('opensphere-console', 'deployment/opensphere-extension-controller');
  const registry = index('opensphere-console', 'deployment/opensphere-registry');
  const cli = index('opensphere-console', 'deployment/os-cli');
  const hub = index('opensphere-monitoring', 'statefulset/beszel-hub');
  const agent = index('opensphere-monitoring', 'daemonset/beszel-agent');
  const shell = index('opensphere-console', 'deployment/opensphere-console');
  for (const observed of [postgres, gitea, api, extension, registry, cli, hub, agent, shell]) {
    assert.ok(observed >= 0);
  }
  for (const dependency of [postgres, gitea, api, extension, registry, cli, hub, agent]) {
    assert.ok(dependency < shell);
  }
  assert.deepEqual(coreRolloutsForLock(localReleaseLock()), [...CORE_ROLLOUTS]);
});

test('bootstrap verifies core without installing the host os CLI', () => {
  const cli = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(cli, /installConsoleCliFromCluster/);
  assert.match(cli, /command === 'install-cli'/);
  const bootstrap = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const waitCall = bootstrap.indexOf('waitForCoreRollouts(lock, progress)');
  const verifyCall = bootstrap.indexOf('const evidence = await verifyInstallation(lock', waitCall);
  assert.ok(waitCall >= 0 && verifyCall > waitCall);
});
test('every target workload references the Setup-managed GHCR pull Secret', () => {
  const files = [
    SUPABASE_MANIFEST.path,
    GITEA_MANIFEST.path,
    CONSOLE_API_MANIFEST.path,
    EXTENSION_CONTROLLER_MANIFEST.path,
    BESZEL_MANIFEST.path,
    'cmd/os-cli/deploy.yaml',
    'backend/registry/deploy/registry.yaml',
    'deploy/opensphere-console.yaml'
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, CONSOLE_SOURCE), 'utf8');
    const workloads = source.split(/^---\s*$/mu).filter((document) =>
      /^kind:\s*(?:Deployment|StatefulSet|DaemonSet|Job|CronJob)\s*$/mu.test(document));
    assert.ok(workloads.length >= 1, `${file} must contain at least one workload`);
    for (const document of workloads) {
      assert.match(document, /imagePullSecrets:[\s\S]*?opensphere-ghcr-pull/u, file);
    }
  }
});

test('every target Console manifest renders with governed immutable images', () => {
  const lock = localReleaseLock();
  for (const spec of [
    SUPABASE_MANIFEST,
    GITEA_MANIFEST,
    CONSOLE_API_MANIFEST,
    EXTENSION_CONTROLLER_MANIFEST,
    BESZEL_MANIFEST,
    ...BASE_MANIFESTS
  ]) {
    const source = readFileSync(new URL(spec.path, CONSOLE_SOURCE), 'utf8');
    const rendered = renderManifest(
      lock, spec, source, 'hostpath', 'https://localhost:8090', 'development'
    );
    assert.doesNotMatch(rendered, /__OPENSPHERE_[A-Z0-9_]+__/);
    const images = [...rendered.matchAll(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/gmu)]
      .map((match) => match[1]);
    for (const image of images) {
      assert.match(image, /^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/);
    }
  }
});

test('custom Console endpoint renders into C_API and Main Shell authorities', () => {
  const lock = localReleaseLock();
  for (const spec of [
    CONSOLE_API_MANIFEST,
    BASE_MANIFESTS.find(({ path }) => path === 'deploy/opensphere-console.yaml')
  ]) {
    const source = readFileSync(new URL(spec.path, CONSOLE_SOURCE), 'utf8');
    const rendered = renderManifest(
      lock, spec, source, 'hostpath', 'https://localhost:18090', 'development'
    );
    assert.doesNotMatch(rendered, /__OPENSPHERE_CONSOLE_URL__/);
    assert.match(rendered, /https:\/\/localhost:18090/);
  }
});

test('selected StorageClass is rendered into every Supabase PVC', () => {
  const lock = localReleaseLock();
  const source = readFileSync(new URL(SUPABASE_MANIFEST.path, CONSOLE_SOURCE), 'utf8');
  const rendered = renderManifest(
    lock, SUPABASE_MANIFEST, source, 'hostpath', 'https://localhost:8090', 'development'
  );
  const pvcCount = [...rendered.matchAll(/^kind:\s*PersistentVolumeClaim\s*$/gmu)].length;
  const selectedClassCount = [...rendered.matchAll(/^\s*storageClassName:\s*hostpath\s*$/gmu)].length;
  assert.equal(pvcCount, 2);
  assert.equal(selectedClassCount, pvcCount);
});

test('doctor PVC capacity includes Supabase, Gitea and Beszel bootstrap core', () => {
  const manifests = [SUPABASE_MANIFEST, GITEA_MANIFEST, BESZEL_MANIFEST]
    .map((spec) => readFileSync(new URL(spec.path, CONSOLE_SOURCE), 'utf8'))
    .join('\n');
  const requestedGiB = [...manifests.matchAll(/requests:\s*\{\s*storage:\s*(\d+)Gi\s*\}/gu)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(requestedGiB, DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB);
});

test('active bootstrap never creates Foundation, OSAA credential or Recovery namespaces', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function bootstrap');
  const end = source.indexOf('export async function upgrade', start);
  const active = source.slice(start, end);
  assert.doesNotMatch(active, /opensphere-foundation|opensphere-osaa-credentials|opensphere-console-recovery/);
  assert.doesNotMatch(source, /function ensureFoundationDataEngineCredentials/);
});
