import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  bootstrapNativeRegistryCredential, prepareNativeRuntimePrerequisites,
  NATIVE_JOURNAL, NATIVE_ACTION_INTENT, NATIVE_SESSION_FENCE,
} from '../src/r2d2-native-prerequisites.mjs';
import { INSTALLATION_IDENTITY_CONFIGMAP } from '../src/installation-identity.mjs';
import { REGISTRY_PULL_SECRET } from '../src/registry-pull-secret.mjs';
import { pullSecretData } from '../src/registry-lifecycle-contract.mjs';

// All credentials are generated synthetic values held only in test memory.
// The mock rejects every command except the fixed public prerequisite reads,
// two named Secret reads and create-only stdin writes. It never runs kubectl.
const CLUSTER = '6c1a7b2e-3f4d-4a5b-9c8d-7e6f5a4b3c2d';
const INSTALLATION = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const GENERATION = '2e3d4c5b-6a7f-4890-9b0c-1d2e3f4a5b6c';
const OTHER_GENERATION = '3d4c5b6a-7f8e-4901-8c1d-2e3f4a5b6c7d';
const clone = value => structuredClone(value);
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gatewayImage = `ghcr.io/opensphere-platform/opensphere-console-osaa-gateway@sha256:${'a'.repeat(64)}`;
const nativeImage = `ghcr.io/opensphere-platform/opensphere-console-r2d2-openclaw@sha256:${'b'.repeat(64)}`;
const inventory = [
  ['v1', 'Namespace', 'opensphere-r2d2', undefined],
  ['v1', 'ServiceAccount', 'r2d2-personal-runtime', 'opensphere-r2d2'],
  ['rbac.authorization.k8s.io/v1', 'Role', 'r2d2-personal-runtime-provisioner', 'opensphere-r2d2'],
  ['rbac.authorization.k8s.io/v1', 'RoleBinding', 'r2d2-personal-runtime-provisioner', 'opensphere-r2d2'],
  ['networking.k8s.io/v1', 'NetworkPolicy', 'r2d2-default-deny', 'opensphere-r2d2'],
  ['networking.k8s.io/v1', 'NetworkPolicy', 'r2d2-personal-runtime', 'opensphere-r2d2'],
  ['networking.k8s.io/v1', 'NetworkPolicy', 'r2d2-personal-runtime-to-gateway', 'opensphere-console'],
  ['v1', 'ResourceQuota', 'r2d2-personal-runtime-capacity', 'opensphere-r2d2'],
];
const render = () => inventory.map(([apiVersion, kind, name, namespace]) => ({
  apiVersion, kind, metadata: { name, ...(namespace ? { namespace } : {}) },
}));
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = secret => JSON.parse(Buffer.from(secret.data['.dockerconfigjson'], 'base64').toString('utf8'));
const setConfig = (secret, value) => { secret.data['.dockerconfigjson'] = encode(value); };
function seal(plan) {
  const { planDigest, ...content } = plan;
  return { ...content, planDigest: hash(content) };
}
function fixture({ requiresCredential = true, hasSource = true, existingTarget = false, fresh = false } = {}) {
  const username = 'synthetic-test-user';
  const password = randomBytes(24).toString('hex');
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const source = {
    apiVersion: 'v1', kind: 'Secret',
    metadata: {
      name: REGISTRY_PULL_SECRET, namespace: 'opensphere-console', uid: 'source-uid', resourceVersion: '7',
      labels: { 'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/credential-purpose': 'registry-pull' },
      annotations: { 'opensphere.io/credential-generation': GENERATION },
    },
    type: 'kubernetes.io/dockerconfigjson', data: pullSecretData({ username, token: password }, GENERATION),
  };
  const identity = {
    apiVersion: 'v1', kind: 'ConfigMap', immutable: true,
    metadata: { name: INSTALLATION_IDENTITY_CONFIGMAP, namespace: 'opensphere-console', uid: 'identity-uid', resourceVersion: '2' },
    data: { clusterUid: CLUSTER, installationId: INSTALLATION, createdAt: '2026-10-22T00:00:00Z' },
  };
  const target = clone(source);
  Object.assign(target.metadata, { namespace: 'opensphere-r2d2', uid: 'target-uid', resourceVersion: '5' });
  const state = {
    clusterUid: CLUSTER, identity: fresh ? null : clone(identity), source: hasSource ? source : null,
    target: existingTarget ? target : null, calls: [], secretReads: [], dryRuns: [], attempts: [], writes: [],
    onDryRun: null, onCreate: null, readFailure: null,
  };
  const prerequisiteReads = new Set([
    ...inventory.map(([, kind, name, namespace]) => `-n ${namespace ?? 'default'} get ${kind} ${name} --ignore-not-found -o json`),
    '-n opensphere-console get ConfigMap opensphere-r2d2-runtime-policy --ignore-not-found -o json',
  ]);
  const kubectl = (args, options = {}) => {
    state.calls.push([...args]);
    assert.equal(options.capture, true);
    const command = args.join(' ');
    if (command === 'get namespace kube-system -o jsonpath={.metadata.uid}') return state.clusterUid;
    if (command === `-n opensphere-console get configmap ${INSTALLATION_IDENTITY_CONFIGMAP} --ignore-not-found -o json`) return state.identity ? JSON.stringify(state.identity) : '';
    if (command === '-n opensphere-console get configmap opensphere-installation-lock --ignore-not-found -o json') return '';
    if (prerequisiteReads.has(command)) return '';
    const sourceRead = `-n opensphere-console get secret ${REGISTRY_PULL_SECRET} --ignore-not-found -o json`;
    const targetRead = `-n opensphere-r2d2 get secret ${REGISTRY_PULL_SECRET} --ignore-not-found -o json`;
    if (command === sourceRead || command === targetRead) {
      const namespace = args[1];
      state.secretReads.push(namespace);
      if (state.readFailure?.namespace === namespace) throw state.readFailure.error;
      const object = namespace === 'opensphere-console' ? state.source : state.target;
      return object ? JSON.stringify(object) : '';
    }
    if (command === 'create --dry-run=server -f -' || command === 'create -f -') {
      assert.equal(typeof options.input, 'string');
      const object = JSON.parse(options.input);
      assert.equal(object.kind, 'Secret');
      assert.equal(object.metadata.namespace, 'opensphere-r2d2');
      assert.equal(object.metadata.name, REGISTRY_PULL_SECRET);
      if (args.includes('--dry-run=server')) {
        state.dryRuns.push(object);
        state.onDryRun?.(state);
      } else {
        state.attempts.push(object);
        state.onCreate?.(state);
        if (state.target) throw Object.assign(new Error('Synthetic AlreadyExists'), { code: 'AlreadyExists' });
        state.target = clone(object);
        state.writes.push(object);
      }
      return '';
    }
    throw new Error('Unexpected mock command: ' + command);
  };
  const lock = {
    releaseDigest: `sha256:${'c'.repeat(64)}`,
    components: {
      osaaGateway: { image: gatewayImage, registryCredentialsRequired: requiresCredential },
      r2d2OpenClawGateway: { image: nativeImage, registryCredentialsRequired: requiresCredential },
    },
  };
  const input = {
    schema: 'opensphere.r2d2-runtime-preparation/v1', clusterUid: CLUSTER, installationId: INSTALLATION, installedReleaseDigest: null,
    policy: {
      installationId: INSTALLATION, image: nativeImage, bridgeImage: gatewayImage, imagePullSecretName: REGISTRY_PULL_SECRET,
      storage: { className: 'synthetic-reviewed-storage', accessMode: 'ReadWriteOncePod', sizeGi: 10 },
      resources: { cpuRequestMilli: 200, cpuLimitMilli: 1000, memoryRequestMi: 512, memoryLimitMi: 1024, temporaryMi: 256 },
      bridgeResources: { cpuRequestMilli: 100, cpuLimitMilli: 200, memoryRequestMi: 64, memoryLimitMi: 128 },
    },
    capacity: { maxRuntimes: 2, totalStorageGi: 20, cpuLimitMilli: 2400, memoryLimitMi: 2304 },
  };
  const plan = prepareNativeRuntimePrerequisites(lock, {
    input, render, kubectl,
    manifest: { migrations: [{ semanticKey: NATIVE_JOURNAL }, { semanticKey: NATIVE_ACTION_INTENT }, { semanticKey: NATIVE_SESSION_FENCE }] },
  });
  assert.equal(state.secretReads.length, 0, 'Plan preparation must never read a registry credential');
  return { state, plan, identity, kubectl, markers: [password, auth, source.data['.dockerconfigjson']] };
}
const run = f => bootstrapNativeRegistryCredential(f.plan, { kubectl: f.kubectl });
const noMutation = f => assert.deepEqual([f.state.dryRuns.length, f.state.attempts.length, f.state.writes.length], [0, 0, 0]);
function noSecrets(value, f) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const marker of f.markers) assert.equal(text.includes(marker), false, 'Sensitive synthetic bytes must not enter a public result');
}
function refuses(f, code) {
  assert.throws(() => run(f), error => {
    assert.equal(error.code, code);
    noSecrets(error.stack, f);
    return true;
  });
}

test('prepared plan and successful bootstrap expose no Secret data and create only the fixed native Secret', () => {
  const f = fixture(), beforePlan = JSON.stringify(f.plan), sourceMetadata = clone(f.state.source.metadata);
  assert.equal(f.plan.requiresRegistryCredential, true);
  assert.equal(f.plan.entries.length, 9);
  noSecrets(f.plan, f);
  assert.equal(JSON.stringify(f.plan).includes('.dockerconfigjson'), false);
  const result = run(f);
  assert.deepEqual(result, { state: 'CreatedManagedCredential', namespace: 'opensphere-r2d2', name: REGISTRY_PULL_SECRET, generation: GENERATION });
  assert.equal(f.state.dryRuns.length, 1);
  assert.equal(f.state.writes.length, 1);
  assert.equal(hash(f.state.writes[0].data), hash(f.state.source.data));
  assert.deepEqual(f.state.writes[0].metadata, {
    name: REGISTRY_PULL_SECRET, namespace: 'opensphere-r2d2',
    labels: { 'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/credential-purpose': 'registry-pull' },
    annotations: { 'opensphere.io/credential-generation': GENERATION },
  });
  assert.deepEqual(f.state.source.metadata, sourceMetadata);
  assert.equal(JSON.stringify(f.plan), beforePlan);
  noSecrets(result, f);
  noSecrets(f.state.calls, f);
  assert.deepEqual(f.state.secretReads, ['opensphere-console', 'opensphere-r2d2', 'opensphere-console', 'opensphere-r2d2']);
});

test('exact existing managed credential is idempotent and never replaced', () => {
  const f = fixture({ existingTarget: true }), before = hash(f.state.target);
  assert.deepEqual(run(f), { state: 'ExistingManagedCredential', namespace: 'opensphere-r2d2', name: REGISTRY_PULL_SECRET, generation: GENERATION });
  noMutation(f);
  assert.equal(hash(f.state.target), before);
});

test('public-image policy still bootstraps the managed anonymous generation without adding credentials', () => {
  const f = fixture({ requiresCredential: false });
  setConfig(f.state.source, { auths: {} });
  assert.equal(f.plan.requiresRegistryCredential, false);
  noSecrets(run(f), f);
  assert.deepEqual(decode(f.state.target), { auths: {} });
  assert.equal(f.state.writes.length, 1);
});

test('historical GHCR-only credential without embedded generation remains a bounded bootstrap input', () => {
  const f = fixture(), config = decode(f.state.source);
  delete config['x-opensphere-credential-generation'];
  setConfig(f.state.source, config);
  assert.equal(run(f).state, 'CreatedManagedCredential');
  assert.deepEqual(decode(f.state.target), config);
  noSecrets(f.state.calls, f);
});

for (const [name, mutate] of [
  ['data', f => { f.state.target.data['.dockerconfigjson'] = encode({ auths: {} }); }],
  ['generation', f => { f.state.target.metadata.annotations['opensphere.io/credential-generation'] = OTHER_GENERATION; }],
  ['type', f => { f.state.target.type = 'Opaque'; }],
]) test(`existing managed target with different ${name} fails without overwriting`, () => {
  const f = fixture({ existingTarget: true });
  mutate(f);
  const before = hash(f.state.target);
  refuses(f, 'NativeRuntimeRegistryGenerationChanged');
  noMutation(f);
  assert.equal(hash(f.state.target), before);
});

for (const which of ['source', 'target']) test(`foreign-owned ${which} is not adopted`, () => {
  const f = fixture({ existingTarget: true });
  f.state[which].metadata.labels['app.kubernetes.io/managed-by'] = 'other-owner';
  refuses(f, 'NativeRuntimeForeignObject');
  noMutation(f);
});

for (const [name, mutate] of [
  ['missing source', f => { f.state.source = null; }],
  ['wrong Secret type', f => { f.state.source.type = 'Opaque'; }],
  ['missing data', f => { delete f.state.source.data; }],
  ['extra data field', f => { f.state.source.data.unrelated = 'synthetic-public-value'; }],
  ['invalid encoded JSON', f => { f.state.source.data['.dockerconfigjson'] = Buffer.from('{broken').toString('base64'); }],
  ['empty auths for private images', f => { setConfig(f.state.source, { auths: {} }); }],
  ['unrelated registry', f => { const config = decode(f.state.source); config.auths['registry.example.invalid'] = clone(config.auths['ghcr.io']); setConfig(f.state.source, config); }],
  ['extra docker configuration field', f => { const config = decode(f.state.source); config.credsStore = 'synthetic-helper'; setConfig(f.state.source, config); }],
  ['extra GHCR credential field', f => { const config = decode(f.state.source); config.auths['ghcr.io'].identitytoken = 'synthetic-public-marker'; setConfig(f.state.source, config); }],
  ['inconsistent auth encoding', f => { const config = decode(f.state.source); config.auths['ghcr.io'].auth = Buffer.from('different:synthetic').toString('base64'); setConfig(f.state.source, config); }],
  ['missing GHCR password', f => { const config = decode(f.state.source); delete config.auths['ghcr.io'].password; setConfig(f.state.source, config); }],
  ['non-string GHCR username', f => { const config = decode(f.state.source); config.auths['ghcr.io'].username = 1; setConfig(f.state.source, config); }],
  ['missing generation', f => { delete f.state.source.metadata.annotations; }],
  ['malformed generation', f => { f.state.source.metadata.annotations['opensphere.io/credential-generation'] = 'not-a-generation'; }],
  ['mismatched embedded generation', f => { const config = decode(f.state.source); config['x-opensphere-credential-generation'] = OTHER_GENERATION; setConfig(f.state.source, config); }],
  ['non-string embedded generation', f => { const config = decode(f.state.source); config['x-opensphere-credential-generation'] = 1; setConfig(f.state.source, config); }],
]) test(`invalid source credential (${name}) fails before server dry-run`, () => {
  const f = fixture();
  mutate(f);
  refuses(f, 'NativeRuntimeRegistryCredentialUnavailable');
  noMutation(f);
});

for (const [name, mutate] of [
  ['UID', s => { s.source.metadata.uid = 'recreated-source-uid'; }],
  ['resource version', s => { s.source.metadata.resourceVersion = '8'; }],
  ['credential generation', s => { s.source.metadata.annotations['opensphere.io/credential-generation'] = OTHER_GENERATION; }],
  ['data bytes', s => { setConfig(s.source, { auths: {} }); }],
  ['ownership metadata', s => { s.source.metadata.labels['app.kubernetes.io/managed-by'] = 'other-owner'; }],
  ['source deletion', s => { s.source = null; }],
  ['target appearance', s => { s.target = clone(s.source); s.target.metadata.namespace = 'opensphere-r2d2'; }],
]) test(`server validation detects ${name} drift and makes no create attempt`, () => {
  const f = fixture();
  f.state.onDryRun = mutate;
  refuses(f, 'NativeRuntimeRegistryGenerationChanged');
  assert.equal(f.state.dryRuns.length, 1);
  assert.equal(f.state.attempts.length, 0);
  assert.equal(f.state.writes.length, 0);
});

for (const [name, mutate, code] of [
  ['cluster', s => { s.clusterUid = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'; }, 'NativeRuntimeClusterMismatch'],
  ['identity UID', s => { s.identity.metadata.uid = 'recreated-identity-uid'; }, 'NativeRuntimeIdentityMismatch'],
  ['identity version', s => { s.identity.metadata.resourceVersion = '3'; }, 'NativeRuntimeIdentityMismatch'],
  ['identity deletion', s => { s.identity = null; }, 'NativeRuntimeIdentityMismatch'],
  ['identity mutability', s => { s.identity.immutable = false; }, 'NativeRuntimeIdentityMismatch'],
  ['installation ID', s => { s.identity.data.installationId = OTHER_GENERATION; }, 'NativeRuntimeIdentityMismatch'],
]) test(`context ${name} drift during dry-run blocks creation`, () => {
  const f = fixture();
  f.state.onDryRun = mutate;
  refuses(f, code);
  assert.equal(f.state.dryRuns.length, 1);
  assert.equal(f.state.attempts.length, 0);
  assert.equal(f.state.writes.length, 0);
});

test('context is checked before any source or target credential is read', () => {
  const f = fixture();
  f.state.identity.data.installationId = OTHER_GENERATION;
  refuses(f, 'NativeRuntimeIdentityMismatch');
  assert.equal(f.state.secretReads.length, 0);
  noMutation(f);
});

test('fresh preparation accepts only the subsequently created matching immutable identity', () => {
  const f = fixture({ fresh: true });
  assert.equal(f.plan.identityBinding, null);
  f.state.identity = clone(f.identity);
  assert.equal(run(f).state, 'CreatedManagedCredential');
});

test('fresh preparation does not accept a later identity for another installation', () => {
  const f = fixture({ fresh: true });
  f.state.identity = clone(f.identity);
  f.state.identity.data.installationId = OTHER_GENERATION;
  refuses(f, 'NativeRuntimeIdentityMismatch');
  assert.equal(f.state.secretReads.length, 0);
  noMutation(f);
});

for (const invalid of ['missing', 'tampered']) test(`${invalid} preparation plan fails before credential reads`, () => {
  const f = fixture();
  f.plan = invalid === 'missing' ? undefined : { ...f.plan, installationId: OTHER_GENERATION };
  refuses(f, 'NativeRuntimePlanInvalid');
  assert.equal(f.state.secretReads.length, 0);
  noMutation(f);
});

for (const stage of ['source read', 'target read', 'dry-run', 'create']) test(`failure at ${stage} is sanitized and never retried`, () => {
  const f = fixture();
  const failure = () => { throw new Error('Synthetic API failure containing ' + f.markers.join(' ')); };
  if (stage.endsWith('read')) f.state.readFailure = { namespace: stage === 'source read' ? 'opensphere-console' : 'opensphere-r2d2', error: new Error('Synthetic transport failure ' + f.markers.join(' ')) };
  else if (stage === 'dry-run') f.state.onDryRun = failure;
  else f.state.onCreate = failure;
  refuses(f, 'NativeRuntimeRegistryBootstrapFailed');
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.attempts.length, stage === 'create' ? 1 : 0);
  assert.equal(f.state.dryRuns.length, stage === 'dry-run' || stage === 'create' ? 1 : 0);
});

test('concurrent target creation after the last read is not overwritten or retried', () => {
  const f = fixture();
  f.state.onCreate = s => { s.target = clone(s.source); s.target.metadata.namespace = 'opensphere-r2d2'; s.target.metadata.uid = 'concurrent-target'; };
  refuses(f, 'NativeRuntimeRegistryBootstrapFailed');
  assert.equal(f.state.attempts.length, 1);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.target.metadata.uid, 'concurrent-target');
});

test('explicit anonymous plan still rejects a foreign registry credential instead of copying it', () => {
  const f = fixture({ requiresCredential: false });
  const config = decode(f.state.source);
  setConfig(f.state.source, { auths: { 'registry.example.invalid': config.auths['ghcr.io'] } });
  refuses(f, 'NativeRuntimeRegistryCredentialUnavailable');
  noMutation(f);
});

test('authenticated helper result stays public when an independently sealed reviewed plan is used', () => {
  const f = fixture();
  f.plan = seal(clone(f.plan));
  const result = run(f);
  assert.deepEqual(Object.keys(result).sort(), ['generation', 'name', 'namespace', 'state']);
  noSecrets(result, f);
  noSecrets(f.plan, f);
});
