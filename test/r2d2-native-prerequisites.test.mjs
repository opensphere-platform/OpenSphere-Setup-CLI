import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, basename } from 'node:path';
import {
  NATIVE_JOURNAL, NATIVE_ACTION_INTENT, NATIVE_SESSION_FENCE, NATIVE_RUNTIME_POLICY, needsNativeRuntimePreparation,
  isLegacyNativeCutover, validateNativeRuntimeInput,
  prepareNativeRuntimePrerequisites, applyNativeRuntimePrerequisites,
} from '../src/r2d2-native-prerequisites.mjs';
import { INSTALLATION_IDENTITY_CONFIGMAP } from '../src/installation-identity.mjs';

const CLUSTER = '6c1a7b2e-3f4d-4a5b-9c8d-7e6f5a4b3c2d';
const OTHER_CLUSTER = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const INSTALLATION = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const OTHER_INSTALLATION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const gatewayImage = `ghcr.io/opensphere-platform/opensphere-console-osaa-gateway@sha256:${'a'.repeat(64)}`;
const nativeImage = `ghcr.io/opensphere-platform/opensphere-console-r2d2-openclaw@sha256:${'b'.repeat(64)}`;
const lock = { releaseDigest: `sha256:${'c'.repeat(64)}`, components: { osaaGateway: { image: gatewayImage }, r2d2OpenClawGateway: { image: nativeImage } } };
const manifest = { migrations: [{ semanticKey: NATIVE_JOURNAL },{semanticKey:NATIVE_ACTION_INTENT},{semanticKey:NATIVE_SESSION_FENCE}] };
const input = {
  schema: 'opensphere.r2d2-runtime-preparation/v1', clusterUid: CLUSTER, installationId: INSTALLATION, installedReleaseDigest:null,
  policy: { installationId: INSTALLATION, image: nativeImage, bridgeImage: gatewayImage, imagePullSecretName:'opensphere-ghcr-pull',
    storage: { className: 'reviewed-storage', accessMode: 'ReadWriteOncePod', sizeGi: 10 },
    resources: { cpuRequestMilli: 200, cpuLimitMilli: 1000, memoryRequestMi: 512, memoryLimitMi: 1024, temporaryMi: 256 },
    bridgeResources: { cpuRequestMilli: 100, cpuLimitMilli: 200, memoryRequestMi: 64, memoryLimitMi: 128 } },
  capacity: { maxRuntimes: 2, totalStorageGi: 20, cpuLimitMilli: 2400, memoryLimitMi: 2304 },
};
const clone = value => structuredClone(value);
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = installationId => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: INSTALLATION_IDENTITY_CONFIGMAP, namespace: 'opensphere-console', uid: 'identity-uid', resourceVersion: '1' }, immutable: true, data: { clusterUid: CLUSTER, installationId, createdAt: '2026-10-22T00:00:00Z' } });

// Fixed public inventory only. Resource/value bounds remain the responsibility
// of the hash-verified Console renderer, rather than duplicated in Setup tests.
function render() {
  return [
    ['v1', 'Namespace', 'opensphere-r2d2'],
    ['v1', 'ServiceAccount', 'r2d2-personal-runtime'],
    ['rbac.authorization.k8s.io/v1', 'Role', 'r2d2-personal-runtime-provisioner'],
    ['rbac.authorization.k8s.io/v1', 'RoleBinding', 'r2d2-personal-runtime-provisioner'],
    ['networking.k8s.io/v1', 'NetworkPolicy', 'r2d2-default-deny'],
    ['networking.k8s.io/v1', 'NetworkPolicy', 'r2d2-personal-runtime'],
    ['networking.k8s.io/v1', 'NetworkPolicy', 'r2d2-personal-runtime-to-gateway'],
    ['v1', 'ResourceQuota', 'r2d2-personal-runtime-capacity'],
  ].map(([apiVersion, kind, name], i) => ({ apiVersion, kind, metadata: { name, ...(kind === 'Namespace' ? {} : { namespace: i === 6 ? 'opensphere-console' : 'opensphere-r2d2' }) }, ...(kind === 'ServiceAccount' ? { automountServiceAccountToken: false } : {}) }));
}

const key = object => [object.kind.toLowerCase(), object.kind === 'Namespace' ? '' : object.metadata.namespace, object.metadata.name].join('/');
function cluster({ clusterUid = CLUSTER, storedIdentity = identity(INSTALLATION), live = [], afterRead, onDryRun, beforeWrite, requireNamespace = true } = {}) {
  const state = { clusterUid, identity: clone(storedIdentity), live: new Map(live.map(object => [key(object), clone(object)])), calls: [], reads: [], dryRuns: [], attempts: [], writes: [], nextVersion: 10 };
  const kubectl = (args, options = {}) => {
    state.calls.push([...args]);
    if (args.join(' ') === 'get namespace kube-system -o jsonpath={.metadata.uid}') return state.clusterUid;
    if (args[0] === '-n' && args[2] === 'get') {
      if (args[3].toLowerCase() === 'configmap' && args[4] === INSTALLATION_IDENTITY_CONFIGMAP) return state.identity ? JSON.stringify(state.identity) : '';
      const objectKey = [args[3].toLowerCase(), args[3] === 'Namespace' ? '' : args[1], args[4]].join('/');
      const result = state.live.get(objectKey);
      state.reads.push(objectKey);
      const text = result ? JSON.stringify(result) : '';
      afterRead?.({ state, objectKey, count: state.reads.filter(value => value === objectKey).length });
      return text;
    }
    if (['create', 'replace'].includes(args[0])) {
      const object = JSON.parse(options.input), objectKey = key(object);
      const dryRun = args.includes('--dry-run=server');
      if (requireNamespace && object.kind !== 'Namespace' && object.metadata.namespace === 'opensphere-r2d2' && !state.live.has('namespace//opensphere-r2d2')) throw new Error('Namespace does not exist yet');
      if (dryRun) {
        state.dryRuns.push({ verb: args[0], object: clone(object) });
        onDryRun?.({ state, object, objectKey });
        return '';
      }
      state.attempts.push({ verb: args[0], object: clone(object) });
      beforeWrite?.({ state, object, objectKey });
      const current = state.live.get(objectKey);
      if (args[0] === 'create' && current) throw Object.assign(new Error('AlreadyExists'), { code: 'AlreadyExists' });
      if (args[0] === 'replace' && (!current || current.metadata.resourceVersion !== object.metadata.resourceVersion || current.metadata.uid !== object.metadata.uid)) throw Object.assign(new Error('Conflict'), { code: 'Conflict' });
      state.writes.push({ verb: args[0], object: clone(object) });
      state.live.set(objectKey, { ...object, metadata: { ...object.metadata, uid: current?.metadata.uid ?? 'created-' + state.nextVersion, resourceVersion: String(state.nextVersion++) } });
      return '';
    }
    throw new Error('Unexpected kubectl call: ' + args.join(' '));
  };
  return { state, kubectl };
}
const prepare = (c, options = {}) => prepareNativeRuntimePrerequisites(lock, { input: clone(input), manifest, kubectl: c.kubectl, render, ...options });
const noWrites = c => assert.deepEqual({ writes: c.state.writes.length, attempts: c.state.attempts.length, dryRuns: c.state.dryRuns.length }, { writes: 0, attempts: 0, dryRuns: 0 });
function existing(object, extra = {}) {
  return { ...clone(object), metadata: { ...object.metadata, uid: 'existing-' + object.metadata.name, resourceVersion: '7', labels: { 'app.kubernetes.io/managed-by': 'opensphere-setup', existing: 'keep' }, ...extra } };
}

test('native preparation is targeted and legacy transition cannot masquerade as native-to-native', () => {
  assert.equal(needsNativeRuntimePreparation(lock), true);
  assert.equal(needsNativeRuntimePreparation(lock, ['console']), false);
  assert.equal(needsNativeRuntimePreparation(lock, ['osaaGateway']), true);
  assert.equal(needsNativeRuntimePreparation({ components: {} }), false);
  assert.equal(isLegacyNativeCutover({ components: { r2d2HermesWorker: {} } }, lock), true);
  assert.equal(isLegacyNativeCutover(lock, lock), false);
});

test('missing explicit policy or journal fails before Kubernetes mutation or rendering', () => {
  for (const options of [{ input: undefined }, { manifest: { migrations: [] } }]) {
    const c = cluster();
    assert.throws(() => prepare(c, options), { code: options.input === undefined && Object.hasOwn(options, 'input') ? 'NativeRuntimePolicyRequired' : 'NativeRuntimeMigrationRequired' });
    noWrites(c);
    assert.equal(c.state.calls.length, 0);
  }
});

for (const semanticKey of [NATIVE_JOURNAL, NATIVE_ACTION_INTENT, NATIVE_SESSION_FENCE]) {
  test(`native preparation requires exactly one ${semanticKey} before cluster reads or mutation`, () => {
    for (const migrations of [manifest.migrations.filter(m=>m.semanticKey!==semanticKey), [...manifest.migrations, {semanticKey}]]) {
      const c = cluster();
      assert.throws(() => prepare(c, {manifest:{migrations}}), {code:'NativeRuntimeMigrationRequired'});
      assert.equal(c.state.calls.length, 0);
      noWrites(c);
    }
  });
}

test('pre-native releases do not invoke renderer or Kubernetes at all', () => {
  assert.equal(prepareNativeRuntimePrerequisites({ components: {} }, { kubectl() { throw Error('Unexpected read'); }, render() { throw Error('Unexpected renderer'); } }), null);
});

for (const [name, change, code] of [
  ['unknown field', value => value.defaults = true, 'NativeRuntimePolicyInvalid'],
  ['missing capacity', value => delete value.capacity, 'NativeRuntimePolicyInvalid'],
  ['missing storage selection', value => delete value.policy.storage.className, 'NativeRuntimePolicyInvalid'],
  ['missing bridge limits', value => delete value.policy.bridgeResources.memoryLimitMi, 'NativeRuntimePolicyInvalid'],
  ['another cluster', value => value.clusterUid = OTHER_CLUSTER, 'NativeRuntimeClusterMismatch'],
  ['another installation', value => { value.installationId = OTHER_INSTALLATION; value.policy.installationId = OTHER_INSTALLATION; }, 'NativeRuntimeIdentityMismatch'],
  ['policy identity differs', value => value.policy.installationId = OTHER_INSTALLATION, 'NativeRuntimeIdentityMismatch'],
  ['another native image', value => value.policy.image = nativeImage.replace(/b{64}/u, 'd'.repeat(64)), 'NativeRuntimeImageMismatch'],
  ['another bridge image', value => value.policy.bridgeImage = gatewayImage.replace(/a{64}/u, 'd'.repeat(64)), 'NativeRuntimeImageMismatch'],
  ['a mutable image tag', value => value.policy.image = nativeImage.split('@')[0] + ':edge', 'NativeRuntimeImageMismatch'],
]) {
  test(`invalid explicit ${name} cannot start any write`, () => {
    const c = cluster(), value = clone(input); change(value);
    assert.throws(() => prepare(c, { input: value }), { code });
    noWrites(c);
  });
}

test('mutable or wrong-cluster persistent installation identity is refused', () => {
  for (const storedIdentity of [{ ...identity(INSTALLATION), immutable: false }, { ...identity(INSTALLATION), data: { ...identity(INSTALLATION).data, clusterUid: OTHER_CLUSTER } }]) {
    const c = cluster({ storedIdentity });
    assert.throws(() => prepare(c), { code: 'NativeRuntimeIdentityMismatch' });
    noWrites(c);
  }
});

test('validated input is cloned and does not acquire storage or capacity defaults', () => {
  const value = clone(input), result = validateNativeRuntimeInput(value, lock, { clusterUid: CLUSTER, identity: identity(INSTALLATION) });
  assert.deepEqual(result, input);
  result.policy.storage.sizeGi = 99;
  assert.equal(value.policy.storage.sizeGi, 10);
});

test('oversized explicit JSON input is refused before cluster reads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'osc-r2d2-policy-test-'));
  try {
    const path = join(directory, 'oversized.json');
    writeFileSync(path, ' '.repeat(32769));
    const c = cluster();
    assert.throws(() => prepare(c, { inputPath: path }), { code: 'NativeRuntimePolicyInvalid' });
    noWrites(c); assert.equal(c.state.calls.length, 0);
  } finally {
    const actual = realpathSync(directory), base = realpathSync(tmpdir());
    assert.ok(actual.startsWith(base + sep) && basename(actual).startsWith('osc-r2d2-policy-test-'), 'Refusing cleanup outside the owned test directory');
    rmSync(actual, { recursive: true, force: true });
  }
});

test('wrong renderer inventory, order or namespace fails without any write', () => {
  for (const change of [objects => objects.pop(), objects => objects.reverse(), objects => objects[2].metadata.namespace = 'kube-system', objects => objects[6].metadata.namespace = 'opensphere-r2d2', objects => objects[3].kind = 'ClusterRoleBinding']) {
    const c = cluster();
    assert.throws(() => prepare(c, { render() { const objects = render(); change(objects); return objects; } }), { code: 'NativeRuntimeRendererInvalid' });
    noWrites(c);
  }
});

test('existing foreign-owned prerequisite blocks the entire prepared inventory', () => {
  const foreign = existing(render()[7]); foreign.metadata.labels['app.kubernetes.io/managed-by'] = 'another-owner';
  const c = cluster({ live: [foreign] });
  assert.throws(() => prepare(c), { code: 'NativeRuntimeForeignObject' });
  noWrites(c);
});

test('plan binds nine exact objects and release/input digests with no apply side effect', () => {
  const c = cluster(), plan = prepare(c);
  assert.equal(plan.entries.length, 9);
  assert.equal(plan.clusterUid, CLUSTER);
  assert.equal(plan.installationId, INSTALLATION);
  assert.equal(plan.releaseDigest, lock.releaseDigest);
  assert.equal(plan.inputSha256, hash(input));
  const { planDigest, ...content } = plan;
  assert.equal(planDigest, hash(content));
  const policy = plan.entries.at(-1).object;
  assert.equal(policy.metadata.name, NATIVE_RUNTIME_POLICY);
  assert.equal(policy.metadata.namespace, 'opensphere-console');
  assert.equal(policy.data.installationId, INSTALLATION);
  assert.deepEqual(JSON.parse(policy.data['policy.json']), input.policy);
  assert.ok(plan.entries.every(entry => entry.object.metadata.labels['app.kubernetes.io/managed-by'] === 'opensphere-setup'));
  noWrites(c);
});

test('tampered plan or changed cluster identity is rejected before the first dry-run/write', () => {
  for (const tamper of [plan => plan.entries[2].object.metadata.namespace = 'kube-system', (plan, state) => state.clusterUid = OTHER_CLUSTER]) {
    const c = cluster(), plan = prepare(c); tamper(plan, c.state);
    assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }));
    noWrites(c);
  }
});

test('changed content, resourceVersion, UID or newly foreign object blocks every write in initial CAS', () => {
  for (const change of [object => object.metadata.resourceVersion = '8', object => object.metadata.uid = 'recreated', object => object.data = { changed: 'same-version' }, object => object.metadata.labels['app.kubernetes.io/managed-by'] = 'foreign']) {
    const owned = existing(render()[7]), c = cluster({ live: [owned] }), plan = prepare(c);
    change(c.state.live.get(key(owned)));
    assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), error => ['NativeRuntimePlanDrift', 'NativeRuntimeForeignObject'].includes(error.code));
    noWrites(c);
  }
});

test('newly appeared prerequisite also invalidates the plan before any write', () => {
  const c = cluster(), plan = prepare(c), appeared = existing(render()[7]);
  c.state.live.set(key(appeared), appeared);
  assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), { code: 'NativeRuntimePlanDrift' });
  noWrites(c);
});

test('Namespace is created before namespaced server validation and every write has a dry-run', () => {
  const c = cluster(), plan = prepare(c), result = applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl });
  assert.equal(result.state, 'Prepared');
  assert.equal(result.objectCount, 9);
  assert.equal(c.state.writes.length, 9);
  assert.equal(c.state.dryRuns.length, 9);
  assert.equal(c.state.writes[0].object.kind, 'Namespace');
  assert.deepEqual(c.state.writes.map(entry => key(entry.object)), c.state.dryRuns.map(entry => key(entry.object)));
  assert.ok(c.state.writes.every(entry => entry.verb === 'create'));
});

test('change during server dry-run is caught before its real write', () => {
  const c = cluster({ onDryRun({ state, object }) { if (object.kind === 'Namespace') state.live.set(key(object), existing(object)); } });
  const plan = prepare(c);
  assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), { code: 'NativeRuntimePlanDrift' });
  assert.equal(c.state.dryRuns.length, 1);
  assert.equal(c.state.attempts.length, 0);
  assert.equal(c.state.writes.length, 0);
});

test('replace preserves exact UID/RV and unrelated metadata but removes client-side lastApplied', () => {
  const owned = render().map(object => existing(object, { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"stale":"unreviewed"}', 'example.test/keep': 'yes' }, managedFields: [{ manager: 'old-client' }] }));
  const c = cluster({ live: owned }), plan = prepare(c);
  applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl });
  assert.equal(c.state.writes.length, 9);
  for (const entry of c.state.writes.filter(value => value.verb === 'replace')) {
    assert.equal(entry.object.metadata.resourceVersion, '7');
    assert.ok(entry.object.metadata.uid.startsWith('existing-'));
    assert.equal(entry.object.metadata.annotations['example.test/keep'], 'yes');
    assert.equal(entry.object.metadata.labels.existing, 'keep');
    assert.equal(Object.hasOwn(entry.object.metadata.annotations, 'kubectl.kubernetes.io/last-applied-configuration'), false);
    assert.equal(Object.hasOwn(entry.object.metadata, 'managedFields'), false);
  }
});

test('Kubernetes final replace conflict cannot overwrite a concurrent writer', () => {
  const owned = existing(render()[0]);
  const c = cluster({ live: [owned], beforeWrite({ state, objectKey }) { state.live.get(objectKey).metadata.resourceVersion = 'newer'; } });
  const plan = prepare(c);
  assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), { code: 'Conflict' });
  assert.equal(c.state.writes.length, 0);
});

test('persistent installation identity replacement after preparation blocks every write', () => {
  const c = cluster(), plan = prepare(c);
  c.state.identity = identity(OTHER_INSTALLATION);
  c.state.identity.metadata.uid = 'replacement-identity';
  assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), error => ['NativeRuntimeIdentityMismatch', 'NativeRuntimePlanDrift'].includes(error.code));
  noWrites(c);
});

test('first-install identity race cannot create runtime prerequisites for a losing installation', () => {
  const c = cluster({ storedIdentity: null }), plan = prepare(c);
  c.state.identity = identity(OTHER_INSTALLATION);
  assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), error => ['NativeRuntimeIdentityMismatch', 'NativeRuntimePlanDrift'].includes(error.code));
  noWrites(c);
});

test('recreated or modified identity with the same installationId still invalidates an existing identity binding', () => {
  for (const change of [object => object.metadata.uid = 'replacement', object => object.metadata.resourceVersion = '2', object => object.metadata.annotations = { changed: 'same-version' }]) {
    const c = cluster(), plan = prepare(c); change(c.state.identity);
    assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), { code: 'NativeRuntimeIdentityMismatch' });
    noWrites(c);
  }
});

test('first-install preparation waits for the same immutable identity instead of inventing one', () => {
  const c = cluster({ storedIdentity: null }), plan = prepare(c);
  assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), { code: 'NativeRuntimeIdentityMismatch' });
  noWrites(c);
  c.state.identity = identity(INSTALLATION);
  assert.equal(applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }).objectCount, 9);
});

test('identity or cluster changes during server validation stop before the first real write', () => {
  for (const change of [state => state.identity = identity(OTHER_INSTALLATION), state => state.clusterUid = OTHER_CLUSTER]) {
    const c = cluster({ onDryRun({ state }) { change(state); } }), plan = prepare(c);
    assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), error => ['NativeRuntimeIdentityMismatch', 'NativeRuntimeClusterMismatch'].includes(error.code));
    assert.equal(c.state.dryRuns.length, 1);
    assert.equal(c.state.attempts.length, 0);
    assert.equal(c.state.writes.length, 0);
  }
});

test('a later server rejection stops the sequence and never claims atomic completion', () => {
  const c = cluster({ onDryRun({ object }) { if (object.kind === 'ResourceQuota') throw Error('Server quota validation rejected'); } }), plan = prepare(c);
  assert.throws(() => applyNativeRuntimePrerequisites(plan, { kubectl: c.kubectl }), /Server quota validation rejected/u);
  assert.equal(c.state.writes.length, 7, 'Earlier reviewed prerequisite writes remain; there is no hidden rollback');
  assert.equal(c.state.live.has(`configmap/opensphere-console/${NATIVE_RUNTIME_POLICY}`), false, 'Runtime policy was not enabled after validation failure');
});
