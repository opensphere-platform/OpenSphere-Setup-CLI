import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectOwnerObservation, isPersonalNativeOwnerWorkload, readOwnerObservation, comparePreparedOwners } from '../src/adoption-owner-preservation.mjs';
import { calculateReleaseBomDigest } from '../src/release.mjs';
import { readinessProfile, verifyOwnerPreservation } from '../src/release-readiness-profile.mjs';

const sha = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const image = (name, letter = 'a') => `ghcr.io/opensphere-platform/${name}@sha256:${letter.repeat(64)}`;
const installationId = '11111111-1111-4111-8111-111111111111';
const clusterUid = '22222222-2222-4222-8222-222222222222';
const source = 'a'.repeat(40), now = Date.parse('2026-10-22T00:00:00Z');
const previous = { releaseDigest: 'sha256:' + 'e'.repeat(64), components: {
  osaaGateway: { repository: 'opensphere-console-osaa-gateway', image: image('opensphere-console-osaa-gateway', 'a') },
  r2d2OpenClawGateway: { repository: 'opensphere-console-r2d2-openclaw', image: image('opensphere-console-r2d2-openclaw', 'b') },
} };
const target = { releaseDigest: 'sha256:' + 'f'.repeat(64), components: {
  osaaGateway: { repository: 'opensphere-console-osaa-gateway', image: image('opensphere-console-osaa-gateway', 'c') },
  r2d2OpenClawGateway: { repository: 'opensphere-console-r2d2-openclaw', image: image('opensphere-console-r2d2-openclaw', 'd') },
} };
const repositories = Object.fromEntries(Object.entries(previous.components).map(([name, component]) => [component.image.split('@')[0], name]));

function controlPlane(lock = previous) {
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'opensphere-console-osaa-gateway', namespace: 'opensphere-console', uid: 'control-uid', resourceVersion: '7' },
    spec: { replicas: 1, selector: { matchLabels: { app: 'c-ai' } }, template: { metadata: { labels: { app: 'c-ai' } }, spec: { serviceAccountName: 'opensphere-console-osaa-gateway',
      containers: [{ name: 'gateway', image: lock.components.osaaGateway.image,
        env: [{ name: 'R2D2_BACKEND', value: 'openclaw-native' },
          { name: 'R2D2_NATIVE_GATEWAY_IMAGE', value: lock.components.r2d2OpenClawGateway.image },
          { name: 'R2D2_NATIVE_BRIDGE_IMAGE', value: lock.components.osaaGateway.image },
          { name: 'OTHER_PUBLIC_OPTION', value: 'unchanged' }],
        securityContext: { readOnlyRootFilesystem: true }, volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }] }],
      volumes: [{ name: 'tmp', emptyDir: {} }] } } } };
}

function preservedInput(before, after) {
  return { profile: readinessProfile('full', source), sourceRevision: source, now,
    installed: { releaseDigest: previous.releaseDigest, resourceVersion: '55', observedUtc: new Date(now).toISOString(), workloads: [before] },
    rendered: { sourceRevision: source, baseReleaseDigest: previous.releaseDigest, baseResourceVersion: '55', deactivations: [],
      workloads: [{ ...after, baseUid: before.uid, baseResourceVersion: before.resourceVersion }] } };
}

test('normal native update normalizes only the two verified release image references', () => {
  const before = controlPlane(previous), after = controlPlane(target);
  const projectedBefore = projectOwnerObservation(before, repositories, undefined, previous);
  const projectedAfter = projectOwnerObservation(after, repositories, undefined, target);
  assert.equal(projectedAfter.configurationDigest, projectedBefore.configurationDigest);
  assert.equal(verifyOwnerPreservation(preservedInput(projectedBefore, projectedAfter)).status, 'preserved');
  assert.notEqual(projectOwnerObservation(before, repositories).configurationDigest, projectOwnerObservation(after, repositories).configurationDigest,
    'Without explicit verified image normalization the actual template change remains visible');
  assert.equal(before.spec.template.spec.containers[0].env[1].value, previous.components.r2d2OpenClawGateway.image, 'Projection never mutates the observed object');
});

for (const name of ['R2D2_NATIVE_GATEWAY_IMAGE', 'R2D2_NATIVE_BRIDGE_IMAGE']) {
  for (const [failure, mutate] of [
    ['missing', (gateway, entry) => gateway.env.splice(gateway.env.indexOf(entry), 1)],
    ['duplicate', (gateway, entry) => gateway.env.push({ ...entry })],
    ['wrong image', (_gateway, entry) => entry.value = image('opensphere-console-osaa-gateway', '0')],
    ['not a public literal', (_gateway, entry) => entry.valueFrom = { configMapKeyRef: { name: 'other', key: 'image' } }],
  ]) {
    test(`native normalization rejects ${failure} ${name}`, () => {
      const workload = controlPlane(target), gateway = workload.spec.template.spec.containers[0];
      mutate(gateway, gateway.env.find(entry => entry.name === name));
      assert.throws(() => projectOwnerObservation(workload, repositories, undefined, target));
    });
  }
}

for (const [name, mutate] of [
  ['other environment value', workload => workload.spec.template.spec.containers[0].env.find(entry => entry.name === 'OTHER_PUBLIC_OPTION').value = 'changed'],
  ['container security', workload => workload.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem = false],
  ['Pod labels', workload => workload.spec.template.metadata.labels.authority = 'changed'],
  ['mount', workload => workload.spec.template.spec.containers[0].volumeMounts[0].mountPath = '/host'],
  ['init executable', workload => workload.spec.template.spec.initContainers = [{ name: 'extra', image: target.components.osaaGateway.image }]],
]) {
  test(`native image normalization never hides ${name} changes`, () => {
    const before = projectOwnerObservation(controlPlane(previous), repositories, undefined, previous);
    const body = controlPlane(target); mutate(body);
    const after = projectOwnerObservation(body, repositories, undefined, target);
    assert.notEqual(before.configurationDigest, after.configurationDigest);
    assert.throws(() => verifyOwnerPreservation(preservedInput(before, after)), /configuration would change/u);
  });
}

test('a different workload never receives the C_AI image-reference exception', () => {
  const before = controlPlane(previous), after = controlPlane(target);
  before.metadata.name = after.metadata.name = 'another-owner';
  assert.notEqual(projectOwnerObservation(before, repositories, undefined, previous).configurationDigest,
    projectOwnerObservation(after, repositories, undefined, target).configurationDigest);
});

function personalRuntime() {
  const owner = createHash('sha256').update(JSON.stringify(['opensphere.r2d2.personal-runtime/v1', installationId, 'public-test-subject'])).digest('hex');
  const id = owner.slice(0, 40), installation = createHash('sha256').update(installationId).digest('hex');
  const annotations = { 'opensphere.io/r2d2-owner-digest': owner, 'opensphere.io/r2d2-installation-digest': installation };
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'r2d2-' + id, namespace: 'opensphere-r2d2', uid: 'personal-uid', resourceVersion: '9',
    labels: { 'opensphere.io/r2d2-runtime': id, 'app.kubernetes.io/name': 'r2d2-openclaw-runtime', 'app.kubernetes.io/managed-by': 'opensphere-r2d2' }, annotations: { ...annotations } },
    spec: { replicas: 1, selector: { matchLabels: { 'opensphere.io/r2d2-runtime': id } }, template: { metadata: { annotations: { ...annotations } }, spec: {
      serviceAccountName: 'r2d2-personal-runtime', automountServiceAccountToken: false,
      containers: [{ name: 'gateway', image: previous.components.r2d2OpenClawGateway.image }, { name: 'bridge', image: previous.components.osaaGateway.image }],
    } } } };
}

test('only the exact personal-runtime owner and installation shape is outside static Console adoption', () => {
  const workload = personalRuntime();
  assert.equal(isPersonalNativeOwnerWorkload(workload, installationId), true);
  assert.equal(isPersonalNativeOwnerWorkload(workload, 'another-installation'), false);
  assert.equal(isPersonalNativeOwnerWorkload(workload, undefined), false);
  assert.equal(isPersonalNativeOwnerWorkload(controlPlane(), installationId), false);
});

for (const [name, mutate] of [
  ['namespace', workload => workload.metadata.namespace = 'opensphere-console'],
  ['name', workload => workload.metadata.name += '-foreign'],
  ['manager', workload => workload.metadata.labels['app.kubernetes.io/managed-by'] = 'other'],
  ['application', workload => workload.metadata.labels['app.kubernetes.io/name'] = 'other'],
  ['owner annotation', workload => workload.metadata.annotations['opensphere.io/r2d2-owner-digest'] = '0'.repeat(64)],
  ['installation annotation', workload => workload.metadata.annotations['opensphere.io/r2d2-installation-digest'] = '0'.repeat(64)],
  ['Pod owner', workload => workload.spec.template.metadata.annotations['opensphere.io/r2d2-owner-digest'] = '0'.repeat(64)],
  ['Pod installation', workload => workload.spec.template.metadata.annotations['opensphere.io/r2d2-installation-digest'] = '0'.repeat(64)],
  ['service identity', workload => workload.spec.template.spec.serviceAccountName = 'admin'],
  ['mounted token', workload => workload.spec.template.spec.automountServiceAccountToken = true],
  ['container set', workload => workload.spec.template.spec.containers.push({ name: 'extra', image: previous.components.osaaGateway.image })],
  ['native image', workload => workload.spec.template.spec.containers[0].image = image('foreign-native')],
  ['bridge image', workload => workload.spec.template.spec.containers[1].image = image('foreign-bridge')],
]) {
  test(`personal-runtime exclusion refuses an unexpected ${name}`, () => {
    const workload = personalRuntime(); mutate(workload);
    assert.equal(isPersonalNativeOwnerWorkload(workload, installationId), false);
  });
}

function reader(lock, workloads) {
  const calls = [], record = { metadata: { uid: 'lock-uid', resourceVersion: '55' }, data: {
    'release.json': JSON.stringify(lock), 'config.json': JSON.stringify({ installationId }),
  } };
  const client = (args, options) => {
    calls.push([...args]);
    assert.equal(options?.capture, true);
    if (args[0] !== 'get') throw Error('Only read operations are permitted');
    return JSON.stringify(args[1] === 'configmap' ? record : { kind: 'List', items: workloads });
  };
  return { calls, client };
}

test('real owner discovery excludes one valid personal deployment but retains an unexpected workload for fail-closed comparison', () => {
  const unknown = personalRuntime(); unknown.metadata.name += '-unowned';
  const c = reader(previous, [controlPlane(), personalRuntime(), unknown]);
  const observation = readOwnerObservation(previous, { client: c.client, now, normalizeNativeImages: true });
  assert.equal(observation.installed.workloads.length, 2);
  assert.ok(observation.installed.workloads.some(workload => workload.name === unknown.metadata.name));
  assert.ok(observation.installed.workloads.some(workload => workload.name === 'opensphere-console-osaa-gateway'));
  assert.equal(c.calls.length, 2);
});

test('actual full-profile adoption allows native image updates with an existing personal runtime but refuses an unknown workload', () => {
  const profile = readinessProfile('full', source), bom = { kind: 'OpenSphereReleaseBOM', sourceRevision: source, readinessProfile: profile };
  const digest = calculateReleaseBomDigest(bom), targetLock = { ...target, sourceRevision: source, releaseBom: { digest, readinessProfile: profile } };
  const prepared = { all: [{ path: 'synthetic-native-c-ai.json', yaml: JSON.stringify(controlPlane(target)) }], foundation: {} };
  for (const unknown of [false, true]) {
    const personal = personalRuntime(); if (unknown) personal.metadata.name += '-unowned';
    const c = reader(previous, [controlPlane(previous), personal]); let dryRuns = 0;
    const client = (args, options) => {
      if (args[0] === 'get') return c.client(args, options);
      assert.deepEqual(args, ['apply', '--dry-run=server', '--validate=true', '-f', '-', '-o', 'json']);
      dryRuns += 1; return JSON.stringify(JSON.parse(options.input));
    };
    const compare = () => comparePreparedOwners(previous, targetLock, prepared, { verifiedBom: { bom, digest }, client, now });
    if (unknown) {
      assert.throws(compare, /Active Owner omitted from rendered artifacts/u);
      assert.equal(dryRuns, 0, 'Unknown ownership stops even before server validation');
    } else {
      assert.equal(compare().status, 'preserved');
      assert.equal(dryRuns, 1);
    }
  }
});

// Public synthetic trust-boundary fixture. Supply-chain verification is done
// by upgrade() before this comparator; this test never signs or applies objects.
test('actual prepared-owner comparator consumes the exact producer thirteen-field native cutover proof', () => {
  const previousLock = { releaseDigest: previous.releaseDigest, components: { osaaGateway: previous.components.osaaGateway,
    r2d2HermesWorker: { repository: 'opensphere-console-r2d2-hermes-worker', image: image('opensphere-console-r2d2-hermes-worker') } } };
  const profile = readinessProfile('native-r2d2-cutover', source);
  const bom = { kind: 'OpenSphereReleaseBOM', sourceRevision: source, readinessProfile: profile };
  const digest = calculateReleaseBomDigest(bom), targetLock = { ...target, sourceRevision: source, releaseBom: { digest, readinessProfile: profile } };
  const before = controlPlane(previous), after = controlPlane(target), ag = before.spec.template.spec.containers[0], bg = after.spec.template.spec.containers[0];
  const nativeNames = ['R2D2_BACKEND', 'R2D2_NATIVE_GATEWAY_IMAGE', 'R2D2_NATIVE_BRIDGE_IMAGE'];
  ag.env = ag.env.filter(entry => !nativeNames.includes(entry.name));
  ag.env.push({ name: 'R2D2_HERMES_SOCK', value: '/run/r2d2/hermes.sock' }, { name: 'R2D2_HERMES_ENABLED', value: 'true' });
  ag.volumeMounts.push({ name: 'r2d2-hermes-ipc', mountPath: '/run/r2d2' });
  before.spec.template.spec.containers.push({ name: 'hermes-worker', image: previousLock.components.r2d2HermesWorker.image });
  before.spec.template.spec.volumes.push({ name: 'worker-tmp', emptyDir: { sizeLimit: '256Mi' } }, { name: 'r2d2-hermes-ipc', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } });
  bg.env.push({ name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } },
    { name: 'OPENSPHERE_INSTALLATION_ID', valueFrom: { configMapKeyRef: { name: 'opensphere-r2d2-runtime-policy', key: 'installationId' } } },
    { name: 'R2D2_NATIVE_RUNTIME_POLICY', valueFrom: { configMapKeyRef: { name: 'opensphere-r2d2-runtime-policy', key: 'policy.json' } } });
  const reviewed = { schema: 'opensphere.r2d2-runtime-preparation/v1', installedReleaseDigest: previousLock.releaseDigest,
    installationId, clusterUid, policy: { installationId, image: target.components.r2d2OpenClawGateway.image, bridgeImage: target.components.osaaGateway.image }, capacity: {} };
  const plan = { schema: reviewed.schema, releaseDigest: targetLock.releaseDigest, installedReleaseDigest: previousLock.releaseDigest,
    installationId, clusterUid, inputSha256: sha(reviewed), entries: [{ object: { kind: 'ConfigMap', metadata: { name: 'opensphere-r2d2-runtime-policy' }, data: { 'preparation.json': JSON.stringify(reviewed) } } }] };
  plan.planDigest = sha(plan);
  const c = reader(previousLock, [before]), requests = [];
  const client = (args, options) => {
    if (args[0] === 'get') return c.client(args, options);
    assert.deepEqual(args, ['apply', '--dry-run=server', '--validate=true', '-f', '-', '-o', 'json']);
    const request = JSON.parse(options.input); requests.push(request);
    return JSON.stringify({ kind: 'List', items: request.items });
  };
  const result = comparePreparedOwners(previousLock, targetLock, { all: [{ path: 'synthetic-c-ai.json', yaml: JSON.stringify(after) }], foundation: { nativeRuntime: plan } }, {
    verifiedBom: { bom, digest }, client, now,
  });
  assert.equal(result.status, 'preserved');
  assert.deepEqual(result.nativeCutover, { ownerIdentity: 'Deployment/opensphere-console/opensphere-console-osaa-gateway', reviewedPolicyDigest: plan.inputSha256 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].items.length, 1);
});
