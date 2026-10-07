// CON-FR platform release / C_API+C_CLI: source readiness and runtime activation
// are distinct. This versioned predicate is attested with the release BOM.
// Consumers must verify the BOM's signature first; this module does not establish trust.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONTRACT = 'opensphere-release-readiness/v1';
export const BOOTSTRAP = Object.freeze({
  components: ['console', 'consoleApi', 'extensionController', 'registry', 'gitea', 'giteaPostgres',
    'supabasePostgres', 'supabaseAuth', 'supabaseRest', 'supabaseStorage', 'beszelHub', 'beszelAgent', 'beszelBootstrap'],
  availableComponents: ['osaaGateway', 'r2d2HermesWorker', 'osdst', 'osaaGovernedAdapter', 'notificationDispatcher', 'recovery'],
  auxiliary: ['cliArtifacts', 'consoleIndexContent'],
  availableAuxiliary: ['osShellControl', 'osShellRuntime'],
});
const sorted = values => [...values].sort();
const digest = /^sha256:[a-f0-9]{64}$/u;
const revision = /^[a-f0-9]{40}$/u;
const image = /^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/u;

export function readinessProfile(name, sourceRevision) {
  assert.ok(['full', 'bootstrap-core'].includes(name), 'Unknown release readiness profile');
  assert.match(sourceRevision, revision, 'Profile must identify the exact release source');
  return {
    contract: CONTRACT, name, sourceRevision,
    purpose: 'source-readiness', runtimePolicy: 'preserve-installed-owners',
    adoptionRequirement: 'fresh-installed-versus-rendered-owner-comparison',
    // Full does not inherit the bootstrap partition or its incomplete feature scope.
    ...(name === 'bootstrap-core' ? { sourcePartition: structuredClone(BOOTSTRAP) } : {}),
  };
}

export function validateReadinessProfile(profile, sourceRevision) {
  assert.deepEqual(profile, readinessProfile(profile?.name, sourceRevision),
    'Readiness profile is not the exact versioned contract');
  return profile;
}

export function attachReadinessProfile(bom, name, sourceRevision, boundary) {
  assert.equal(bom.sourceRevision, sourceRevision, 'BOM and profile source differ');
  assert.equal(bom.kind, 'OpenSphereReleaseBOM');
  assert.deepEqual(sorted(Object.keys(bom.components ?? {})),
    sorted([...BOOTSTRAP.components, ...BOOTSTRAP.availableComponents]), 'BOM must retain all 19 canonical components');
  for (const component of Object.values(bom.components)) {
    assert.equal(component.sourceRevision, sourceRevision, 'BOM contains a different source revision');
    assert.match(component.image, image, 'BOM components must remain digest-pinned');
  }
  assert.deepEqual(sorted(Object.keys(bom.auxiliaryArtifacts ?? {})), sorted([...BOOTSTRAP.auxiliary, ...BOOTSTRAP.availableAuxiliary]),
    'BOM must retain all governed auxiliary artifacts at their own versions');
  for (const artifact of Object.values(bom.auxiliaryArtifacts)) {
    assert.equal(artifact.sourceRevision, sourceRevision, 'Auxiliary artifact source differs');
    assert.match(artifact.image, image, 'Auxiliary artifacts must remain digest-pinned');
  }
  const activation = boundary?.releaseProfiles?.['bootstrap-core']?.artifactActivation;
  assert.deepEqual(activation, {
    bootstrapCore: BOOTSTRAP.components, availableModules: BOOTSTRAP.availableComponents,
    bootstrapAuxiliaryArtifacts: BOOTSTRAP.auxiliary, availableAuxiliaryArtifacts: BOOTSTRAP.availableAuxiliary,
  }, 'Readiness partition changed: review the versioned producer/consumer contract');
  return { ...bom, readinessProfile: readinessProfile(name, sourceRevision) };
}

function workloadsByIdentity(workloads) {
  assert.ok(Array.isArray(workloads), 'Owner observation must contain a workload array');
  const result = new Map();
  for (const workload of workloads) {
    assert.ok(['Deployment', 'StatefulSet', 'DaemonSet'].includes(workload.kind), 'Unknown workload kind');
    assert.equal(typeof workload.namespace, 'string');
    assert.equal(typeof workload.name, 'string');
    assert.equal(typeof workload.owner, 'string', 'An explicit Owner is required');
    const key = `${workload.kind}/${workload.namespace}/${workload.name}`;
    assert.ok(!result.has(key), 'Duplicate Owner workload');
    assert.ok(Number.isSafeInteger(workload.replicas) && workload.replicas > 0, 'Active Owner replica count must be positive');
    assert.ok(Array.isArray(workload.containers) && workload.containers.length > 0, 'Owner containers are missing');
    assert.match(workload.configurationDigest ?? '', digest, 'Owner configuration comparison is missing');
    assert.equal(new Set(workload.containers.map(c => c.name)).size, workload.containers.length, 'Duplicate container');
    for (const container of workload.containers) {
      assert.equal(typeof container.name, 'string');
      assert.match(container.image, image, 'Owner image must be a governed digest');
      // Snapshot values are feature switches only. Never accept credentials/env dumps.
      assert.ok(container.features && typeof container.features === 'object' && !Array.isArray(container.features));
      for (const [name, value] of Object.entries(container.features)) {
        assert.ok(/^R2D2_HERMES_ENABLED$/u.test(name), 'Unsupported public feature switch');
        assert.ok(['true', 'false'].includes(value), 'Feature switch must be a boolean literal');
      }
    }
    result.set(key, workload);
  }
  return result;
}

// Invoke before any adoption write and again if the installation lock or live
// workload resourceVersions change. Replica/container/feature preservation is
// mandatory even when the Owner is outside the bootstrap readiness partition.
// Ready Pods do not prove functional acceptance; that remains a post-deploy gate.
export function verifyOwnerPreservation({ profile, sourceRevision, installed, rendered, now = Date.now() }) {
  validateReadinessProfile(profile, sourceRevision);
  assert.match(installed?.releaseDigest ?? '', digest, 'Installed release digest is missing');
  assert.match(installed?.resourceVersion ?? '', /^[0-9]+$/u, 'Installation lock observation is missing');
  const observed = Date.parse(installed?.observedUtc);
  assert.ok(Number.isFinite(observed) && observed <= now && now - observed <= 300_000, 'Owner observation is missing, stale or in the future');
  assert.equal(rendered?.baseReleaseDigest, installed.releaseDigest, 'Rendered plan is based on a different installation');
  assert.equal(rendered?.baseResourceVersion, installed.resourceVersion, 'Rendered plan is based on a different lock version');
  assert.equal(rendered?.sourceRevision, sourceRevision, 'Rendered plan and signed BOM source differ');
  assert.deepEqual(rendered?.deactivations, [], 'Readiness selection cannot deactivate installed Owners');
  const live = workloadsByIdentity(installed.workloads), planned = workloadsByIdentity(rendered.workloads);
  assert.ok(live.size > 0, 'An empty observation cannot prove installed Owner preservation');
  for (const [key, before] of live) {
    assert.equal(typeof before.uid, 'string', 'Live workload UID is missing');
    assert.match(before.resourceVersion ?? '', /^[0-9]+$/u, 'Live workload version is missing');
    const after = planned.get(key);
    assert.ok(after, `Active Owner workload would be removed: ${key}`);
    assert.equal(after.owner, before.owner, `Owner writer would change: ${key}`);
    assert.equal(after.baseUid, before.uid, `Owner workload identity changed: ${key}`);
    assert.equal(after.baseResourceVersion, before.resourceVersion, `Owner observation changed: ${key}`);
    assert.ok(after.replicas >= before.replicas, `Active Owner would shrink: ${key}`);
    assert.equal(after.configurationDigest, before.configurationDigest, `Active Owner configuration would change: ${key}`);
    for (const container of before.containers) {
      const target = after.containers.find(c => c.name === container.name);
      assert.ok(target, `Active Owner container would be removed: ${key}/${container.name}`);
      assert.equal(target.image.split('@')[0], container.image.split('@')[0], `Active Owner image repository would change: ${key}/${container.name}`);
      assert.deepEqual(target.features, container.features, `Active Owner feature switches would change: ${key}/${container.name}`);
    }
  }
  return { contract: CONTRACT, sourceRevision, baseReleaseDigest: installed.releaseDigest,
    baseResourceVersion: installed.resourceVersion, comparedWorkloads: live.size, status: 'preserved' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const json = path => JSON.parse(readFileSync(path, 'utf8'));
  if (command === 'attach') {
    assert.equal(args.length, 3, 'attach requires BOM path, profile and source revision');
    const [path, name, sourceRevision] = args;
    const bom = attachReadinessProfile(json(path), name, sourceRevision,
      json(new URL('../apps/component-boundaries.json', import.meta.url)));
    writeFileSync(path, JSON.stringify(bom, null, 2) + '\n');
  } else if (command === 'verify-adoption') {
    assert.equal(args.length, 3, 'verify-adoption requires verified BOM, installed observation and rendered plan');
    const [bomPath, installedPath, renderedPath] = args;
    const bom = json(bomPath);
    const result = verifyOwnerPreservation({ profile: bom.readinessProfile, sourceRevision: bom.sourceRevision,
      installed: json(installedPath), rendered: json(renderedPath) });
    process.stdout.write(JSON.stringify(result) + '\n');
  } else throw new Error('Unknown release readiness command');
}
