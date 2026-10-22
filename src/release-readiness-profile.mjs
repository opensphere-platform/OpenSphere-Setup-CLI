// CON-FR platform release / C_API+C_CLI: source readiness and runtime activation
// are distinct. This versioned predicate is attested with the release BOM.
// Consumers must verify the BOM's signature first; this module does not establish trust.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const CONTRACT = 'opensphere-release-readiness/v1';
export const NATIVE_R2D2_CUTOVER_PROFILE = 'native-r2d2-cutover';
export const BOOTSTRAP = Object.freeze({
  components: ['console', 'consoleApi', 'extensionController', 'registry', 'gitea', 'giteaPostgres',
    'supabasePostgres', 'supabaseAuth', 'supabaseRest', 'supabaseStorage', 'beszelHub', 'beszelAgent', 'beszelBootstrap'],
  availableComponents: ['osaaGateway', 'r2d2OpenClawGateway', 'osdst', 'osaaGovernedAdapter', 'notificationDispatcher', 'recovery'],
  auxiliary: ['cliArtifacts', 'consoleIndexContent'],
  availableAuxiliary: ['osShellControl', 'osShellRuntime'],
});
const sorted = values => [...values].sort();
const digest = /^sha256:[a-f0-9]{64}$/u;
const revision = /^[a-f0-9]{40}$/u;
const image = /^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const nativeOwnerIdentity = 'Deployment/opensphere-console/opensphere-console-osaa-gateway';

export function readinessProfile(name, sourceRevision) {
  assert.ok(['full', 'bootstrap-core', NATIVE_R2D2_CUTOVER_PROFILE].includes(name), 'Unknown release readiness profile');
  assert.match(sourceRevision, revision, 'Profile must identify the exact release source');
  return {
    contract: CONTRACT, name, sourceRevision,
    purpose: 'source-readiness',
    runtimePolicy: name === NATIVE_R2D2_CUTOVER_PROFILE ? 'reviewed-native-runtime-cutover' : 'preserve-installed-owners',
    adoptionRequirement: name === NATIVE_R2D2_CUTOVER_PROFILE
      ? 'reviewed-native-policy-and-exact-installed-owner-comparison'
      : 'fresh-installed-versus-rendered-owner-comparison',
    // Only bootstrap-core carries a smaller source partition. Native cutover
    // retains the full source gate even though its adoption predicate differs.
    ...(name === 'bootstrap-core' ? { sourcePartition: structuredClone(BOOTSTRAP) } : {}),
  };
}

export function validateReadinessProfile(profile, sourceRevision, { allowInstalledHermes = false } = {}) {
  const expected = readinessProfile(profile?.name, sourceRevision);
  // Installed evidence only: callers enable this solely after proving the
  // complete exact historical Hermes inventory. Targets keep the strict default.
  if (allowInstalledHermes === true && profile?.name === 'bootstrap-core') {
    const historical = structuredClone(expected);
    historical.sourcePartition.availableComponents = historical.sourcePartition.availableComponents
      .map(name => name === 'r2d2OpenClawGateway' ? 'r2d2HermesWorker' : name);
    if (isDeepStrictEqual(profile, historical)) return profile;
  }
  assert.deepEqual(profile, expected,
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
        assert.ok(['R2D2_HERMES_ENABLED','R2D2_BACKEND'].includes(name), 'Unsupported public feature switch');
        assert.ok((name==='R2D2_BACKEND'?['openclaw-native','disabled']:['true','false']).includes(value), 'Feature switch literal is unsupported');
      }
    }
    result.set(key, workload);
  }
  return result;
}

function validateNativeCutoverProof(proof, installed) {
  const keys = ['ownerIdentity', 'previousOwner', 'nextOwner', 'beforeConfigurationDigest', 'afterConfigurationDigest',
    'removedContainer', 'previousWorkerImage', 'reviewedPolicyDigest', 'installedReleaseDigest',
    'installationId', 'clusterUid', 'gatewayImage', 'nativeImage'];
  assert.ok(proof && typeof proof === 'object' && !Array.isArray(proof), 'Reviewed native cutover proof is required');
  assert.deepEqual(sorted(Object.keys(proof)), sorted(keys), 'Native cutover proof shape differs');
  assert.equal(proof.ownerIdentity, nativeOwnerIdentity, 'Native cutover Owner identity differs');
  assert.equal(proof.previousOwner, 'osaaGateway+r2d2HermesWorker', 'Native cutover previous Owner differs');
  assert.equal(proof.nextOwner, 'osaaGateway', 'Native cutover next Owner differs');
  assert.equal(proof.removedContainer, 'hermes-worker', 'Native cutover may remove only the retired worker');
  for (const key of ['beforeConfigurationDigest', 'afterConfigurationDigest', 'reviewedPolicyDigest', 'installedReleaseDigest']) {
    assert.match(proof[key] ?? '', digest, `Native cutover ${key} is invalid`);
  }
  assert.notEqual(proof.beforeConfigurationDigest, proof.afterConfigurationDigest, 'Native cutover configuration must identify the actual transition');
  assert.equal(proof.installedReleaseDigest, installed.releaseDigest, 'Native cutover installed release differs');
  for (const key of ['installationId', 'clusterUid']) assert.match(proof[key] ?? '', uuid, `Native cutover ${key} is invalid`);
  for (const [key, repository] of [['previousWorkerImage', 'opensphere-console-r2d2-hermes-worker'], ['gatewayImage', 'opensphere-console-osaa-gateway'], ['nativeImage', 'opensphere-console-r2d2-openclaw']]) {
    assert.match(proof[key] ?? '', new RegExp(`^ghcr\\.io/opensphere-platform/${repository}@sha256:[a-f0-9]{64}$`, 'u'), `Native cutover ${key} differs`);
  }
  return proof;
}

function assertNativeCutoverOwner(before, after, proof) {
  assert.equal(before.owner, proof.previousOwner, 'Native cutover observed previous Owner differs');
  assert.equal(after.owner, proof.nextOwner, 'Native cutover rendered next Owner differs');
  assert.equal(before.configurationDigest, proof.beforeConfigurationDigest, 'Native cutover before configuration differs');
  assert.equal(after.configurationDigest, proof.afterConfigurationDigest, 'Native cutover after configuration differs');
  const worker = before.containers.find(container => container.name === proof.removedContainer);
  assert.ok(worker, 'Native cutover observed retired worker is missing');
  assert.equal(worker.image, proof.previousWorkerImage, 'Native cutover retired worker image differs');
  assert.ok(after.containers.every(container => container.name !== proof.removedContainer), 'Native cutover retained the retired worker');
  assert.equal(after.containers.length, before.containers.length - 1, 'Native cutover may only remove its one retired container');
  const gateway = before.containers.find(container => container.name === 'gateway');
  const nextGateway = after.containers.find(container => container.name === 'gateway');
  assert.ok(gateway && nextGateway, 'Native cutover must retain the C_AI gateway container');
  assert.equal(nextGateway.image, proof.gatewayImage, 'Native cutover Gateway image differs from reviewed proof');
  assert.deepEqual(gateway.features, { R2D2_HERMES_ENABLED: 'true' }, 'Native cutover previous backend differs');
  assert.deepEqual(nextGateway.features, { R2D2_BACKEND: 'openclaw-native' }, 'Native cutover next backend differs');
}

// Invoke before any adoption write and again if the installation lock or live
// workload resourceVersions change. Replica/container/feature preservation is
// mandatory even when the Owner is outside the bootstrap readiness partition.
// Only the explicit native profile and trusted Setup proof admit the one C_AI
// replacement below; they cannot authorize another Owner or container removal.
// Ready Pods do not prove functional acceptance; that remains a post-deploy gate.
export function verifyOwnerPreservation({ profile, sourceRevision, installed, rendered, nativeCutover, now = Date.now() }) {
  validateReadinessProfile(profile, sourceRevision);
  const native = profile.name === NATIVE_R2D2_CUTOVER_PROFILE;
  if (!native) assert.equal(nativeCutover, undefined, 'Native cutover proof requires its explicit signed profile');
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
  // This explicit argument is supplied only by Setup's trusted comparison of
  // reviewed policy, immutable installation and exact admitted manifests. A
  // self-reported field in rendered JSON is never an approval or a proof.
  const proof = native ? validateNativeCutoverProof(nativeCutover, installed) : null;
  if (proof) assert.ok(live.has(nativeOwnerIdentity) && planned.has(nativeOwnerIdentity), 'Native cutover C_AI Owner is missing');
  for (const [key, before] of live) {
    assert.equal(typeof before.uid, 'string', 'Live workload UID is missing');
    assert.match(before.resourceVersion ?? '', /^[0-9]+$/u, 'Live workload version is missing');
    const after = planned.get(key);
    assert.ok(after, `Active Owner workload would be removed: ${key}`);
    const cutoverOwner = proof && key === nativeOwnerIdentity;
    if (cutoverOwner) assertNativeCutoverOwner(before, after, proof);
    else assert.equal(after.owner, before.owner, `Owner writer would change: ${key}`);
    assert.equal(after.baseUid, before.uid, `Owner workload identity changed: ${key}`);
    assert.equal(after.baseResourceVersion, before.resourceVersion, `Owner observation changed: ${key}`);
    assert.ok(after.replicas >= before.replicas, `Active Owner would shrink: ${key}`);
    if (!cutoverOwner) assert.equal(after.configurationDigest, before.configurationDigest, `Active Owner configuration would change: ${key}`);
    for (const container of before.containers) {
      if (cutoverOwner && container.name === proof.removedContainer) continue;
      const target = after.containers.find(c => c.name === container.name);
      assert.ok(target, `Active Owner container would be removed: ${key}/${container.name}`);
      assert.equal(target.image.split('@')[0], container.image.split('@')[0], `Active Owner image repository would change: ${key}/${container.name}`);
      if (!(cutoverOwner && container.name === 'gateway')) {
        assert.deepEqual(target.features, container.features, `Active Owner feature switches would change: ${key}/${container.name}`);
      }
    }
  }
  return { contract: CONTRACT, sourceRevision, baseReleaseDigest: installed.releaseDigest,
    baseResourceVersion: installed.resourceVersion, comparedWorkloads: live.size, status: 'preserved',
    ...(proof ? { nativeCutover: { ownerIdentity: proof.ownerIdentity, reviewedPolicyDigest: proof.reviewedPolicyDigest } } : {}) };
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
