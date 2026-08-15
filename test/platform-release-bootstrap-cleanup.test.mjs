import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  bootstrapACleanupResourceSet,
  canonicalJson,
  cleanupBootstrapAInitializer,
  createInClusterKubernetesClient,
} from '../src/platform-release-bootstrap-cleanup.mjs';
import { BOOTSTRAP_INITIALIZER_LIVE_PROFILE } from '../src/platform-release-bootstrap-manifest.mjs';

const sourceRevision = 'a'.repeat(40);
const sourceImage = `ghcr.io/opensphere-platform/opensphere-console-backend@sha256:${'a'.repeat(64)}`;
const requestId = '11111111-2222-4333-8444-555555555555';
const targetReleaseDigest = `sha256:${'b'.repeat(64)}`;
const key = (kind, name) => `${kind}/${name}`;
const CONSOLE_SOURCE = process.env.OPENSPHERE_CONSOLE_SOURCE
  ? pathToFileURL(`${resolve(process.env.OPENSPHERE_CONSOLE_SOURCE)}${sep}`)
  : new URL('../../OpenSphere-console/', import.meta.url);
const deploySource = readFileSync(
  new URL('backend/opensphere-console-backend/deploy.yaml', CONSOLE_SOURCE), 'utf8'
).replaceAll('\r\n', '\n');

function sourceDocuments() {
  return deploySource.split(/^---\s*$/mu).map((entry) => entry.trim()).filter(Boolean);
}

function sourcePolicyExpression(name) {
  const document = sourceDocuments().find((entry) =>
    /^kind: ValidatingAdmissionPolicy$/mu.test(entry)
      && new RegExp(`metadata: \\{ name: ${name} \\}`).test(entry));
  assert.ok(document, `canonical policy source missing ${name}`);
  const match = document.match(/^\s+- expression: >-\s*$\n([\s\S]*?)^\s+message: (.+)$/mu);
  assert.ok(match, `canonical policy expression missing ${name}`);
  return match[1].split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
}

function policySpec(name) {
  const profile = BOOTSTRAP_INITIALIZER_LIVE_PROFILE.policies[name];
  return {
    failurePolicy: 'Fail',
    ...(profile.paramKind ? { paramKind: structuredClone(profile.paramKind) } : {}),
    matchConstraints: { resourceRules: structuredClone(profile.resourceRules) },
    validations: [{ expression: sourcePolicyExpression(name), message: profile.message }],
  };
}

function metadata(name, namespace = '') {
  return { name, ...(namespace ? { namespace } : {}), uid: `uid-${name}`, resourceVersion: '100' };
}

function cleanupObject(descriptor) {
  const base = { apiVersion: descriptor.apiVersion, kind: descriptor.kind,
    metadata: metadata(descriptor.name, descriptor.namespace) };
  if (descriptor.kind === 'Job') return {
    ...base,
    metadata: { ...base.metadata, labels: { app: 'platform-release-tls-initializer',
      'opensphere.io/source-revision': sourceRevision } },
    spec: {
      parallelism: 1, completions: 1, completionMode: 'NonIndexed', backoffLimit: 0,
      activeDeadlineSeconds: 600, ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { app: 'platform-release-tls-initializer',
          'opensphere.io/source-revision': sourceRevision } },
        spec: {
          serviceAccountName: 'platform-release-tls-initializer',
          automountServiceAccountToken: false, restartPolicy: 'Never',
          imagePullSecrets: [{ name: 'opensphere-ghcr-pull' }],
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'initializer', image: sourceImage, imagePullPolicy: 'IfNotPresent',
            command: ['node', '/app/opensphere-console-backend/platform-release-tls-initializer.mjs'],
            env: [
              { name: 'HOME', value: '/tmp/home' },
              { name: 'NODE_EXTRA_CA_CERTS',
                value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
              { name: 'PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE',
                value: 'opensphere-platform-release-tls-initializer/v1' },
            ],
            volumeMounts: [
              { name: 'kube-api-access',
                mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true },
              { name: 'tmp', mountPath: '/tmp' },
            ],
            resources: { requests: { cpu: '20m', memory: '64Mi' },
              limits: { cpu: '500m', memory: '256Mi' } },
            securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          }],
          volumes: [
            { name: 'kube-api-access', projected: { defaultMode: 256, sources: [
              { serviceAccountToken: { path: 'token', audience: 'https://kubernetes.default.svc',
                expirationSeconds: 600 } },
              { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
            ] } },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
  if (descriptor.kind === 'ServiceAccount') return { ...base, automountServiceAccountToken: false };
  if (descriptor.kind === 'Role') return { ...base,
    rules: structuredClone(BOOTSTRAP_INITIALIZER_LIVE_PROFILE.roleRules) };
  if (descriptor.kind === 'RoleBinding') return { ...base,
    ...structuredClone(BOOTSTRAP_INITIALIZER_LIVE_PROFILE.roleBinding) };
  if (descriptor.kind === 'ValidatingAdmissionPolicy') return { ...base,
    spec: policySpec(descriptor.name) };
  if (descriptor.kind === 'ValidatingAdmissionPolicyBinding') return { ...base,
    spec: structuredClone(BOOTSTRAP_INITIALIZER_LIVE_PROFILE.bindings[descriptor.name]) };
  if (descriptor.kind === 'NetworkPolicy') return { ...base,
    spec: structuredClone(BOOTSTRAP_INITIALIZER_LIVE_PROFILE.networkPolicySpec) };
  throw new Error(`fixture missing ${descriptor.kind}`);
}

function permanent(name, kind) {
  const base = { apiVersion: 'admissionregistration.k8s.io/v1', kind,
    metadata: metadata(name) };
  if (kind === 'ValidatingAdmissionPolicyBinding') {
    return { ...base, spec: structuredClone(BOOTSTRAP_INITIALIZER_LIVE_PROFILE.bindings[name]) };
  }
  return { ...base, spec: policySpec(name) };
}

function authority() {
  return {
    secret: { apiVersion: 'v1', kind: 'Secret', metadata: metadata(
      'opensphere-platform-release-authority-tls', 'opensphere-console'),
    data: { 'ca.crt': Buffer.from('ca').toString('base64'),
      'tls.crt': Buffer.from('cert').toString('base64') } },
    configMap: { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(
      'opensphere-platform-release-control-ca', 'opensphere-console') },
    service: { apiVersion: 'v1', kind: 'Service', metadata: {
      ...metadata('opensphere-platform-release-authority', 'opensphere-console'),
      labels: { app: 'opensphere-platform-release-authority' },
    }, spec: {
      selector: { app: 'opensphere-console-backend' },
      ports: [{ name: 'https', port: 8446, protocol: 'TCP', targetPort: 'release-tls' }],
      type: 'ClusterIP', clusterIP: '10.96.1.2', clusterIPs: ['10.96.1.2'],
      ipFamilies: ['IPv4'], ipFamilyPolicy: 'SingleStack', internalTrafficPolicy: 'Cluster',
      sessionAffinity: 'None',
    } },
  };
}

class FakeClient {
  constructor({ responseLoss = false } = {}) {
    this.objects = new Map();
    this.responseLoss = responseLoss;
    this.deleteCalls = [];
    for (const descriptor of bootstrapACleanupResourceSet(sourceRevision)) {
      this.put(cleanupObject(descriptor));
    }
    for (const name of [
      'opensphere-platform-release-authority-service-custody',
      'opensphere-bootstrap-a-initializer-cleanup-journal-custody',
    ]) {
      this.put(permanent(name, 'ValidatingAdmissionPolicy'));
      this.put(permanent(name, 'ValidatingAdmissionPolicyBinding'));
    }
    for (const object of Object.values(authority())) this.put(object);
  }
  put(object) { this.objects.set(key(object.kind, object.metadata.name), structuredClone(object)); }
  async get(descriptor) {
    return structuredClone(this.objects.get(key(descriptor.kind, descriptor.name)) || null);
  }
  async list(descriptor) {
    return [...this.objects.values()].filter((object) => object.kind === descriptor.kind
      && (!descriptor.namespace || object.metadata?.namespace === descriptor.namespace))
      .map((object) => structuredClone(object));
  }
  async create(_descriptor, object) {
    const stored = structuredClone(object);
    stored.metadata.uid = `uid-${stored.metadata.name}`;
    stored.metadata.resourceVersion = '200';
    this.put(stored);
    if (this.responseLoss) throw new Error('simulated create response loss');
    return stored;
  }
  async delete(descriptor, precondition) {
    const object = this.objects.get(key(descriptor.kind, descriptor.name));
    assert.equal(precondition.uid, object.metadata.uid);
    assert.equal(precondition.resourceVersion, object.metadata.resourceVersion);
    this.deleteCalls.push({ descriptor, precondition });
    this.objects.delete(key(descriptor.kind, descriptor.name));
    if (descriptor.kind === 'Job') {
      for (const [entryKey, entry] of this.objects) {
        if (entry.kind === 'Pod' && entry.metadata?.ownerReferences?.[0]?.uid === object.metadata.uid) {
          this.objects.delete(entryKey);
        }
      }
    }
    if (this.responseLoss) throw new Error('simulated delete response loss');
    return null;
  }
}

const input = (client) => ({
  bootstrapFrom: { requestId, sourceRevision, image: sourceImage }, targetReleaseDigest,
  authority: authority(), client, sleep: async () => {},
  now: () => new Date('2026-08-15T00:00:00.000Z'),
});

test('in-cluster client sends UID and resourceVersion DeleteOptions over verified TLS', async () => {
  const calls = [];
  const requestFn = (options, callback) => {
    const request = new EventEmitter();
    let body = '';
    request.write = (chunk) => { body += chunk.toString(); };
    request.end = () => queueMicrotask(() => {
      calls.push({ options, body });
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      response.emit('data', Buffer.from('{}'));
      response.emit('end');
    });
    return request;
  };
  const client = await createInClusterKubernetesClient({
    environment: { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT_HTTPS: '443' },
    readFileFn: async (path) => path.endsWith('/token') ? 'projected-token\n' : Buffer.from('root-ca'),
    requestFn,
  });
  const descriptor = bootstrapACleanupResourceSet(sourceRevision)
    .find((entry) => entry.kind === 'Job');
  await client.delete(descriptor, { uid: 'uid-job', resourceVersion: '777' });
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(calls[0].options.servername, 'kubernetes.default.svc');
  assert.equal(calls[0].options.headers.authorization, 'Bearer projected-token');
  assert.deepEqual(JSON.parse(calls[0].body), {
    apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground',
    preconditions: { uid: 'uid-job', resourceVersion: '777' },
  });
});

test('cleanup journals exact preconditions and converges across create/delete response loss', async () => {
  const client = new FakeClient({ responseLoss: true });
  const proof = await cleanupBootstrapAInitializer(input(client));
  assert.equal(proof.contract, 'opensphere-bootstrap-a-initializer-cleanup/v1');
  assert.equal(proof.bootstrapRequestId, requestId);
  assert.equal(proof.bootstrapSourceRevision, sourceRevision);
  assert.equal(proof.targetReleaseDigest, targetReleaseDigest);
  assert.equal(proof.deletedResources.length, 11);
  assert.equal(proof.residueCount, 0);
  assert.match(proof.cleanupSetDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(proof.journalSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(proof.journalCustody).sort(), [
    'bindingResourceVersion','bindingUid','policyResourceVersion','policyUid'
  ]);
  assert.equal(client.deleteCalls.length, 11);
  assert.ok(client.objects.has(key('Secret', 'opensphere-platform-release-authority-tls')));
  assert.ok(client.objects.has(key('Service', 'opensphere-platform-release-authority')));
  assert.ok(client.objects.has(key('ValidatingAdmissionPolicy',
    'opensphere-platform-release-authority-service-custody')));
});

test('cleanup rejects a wholly missing or partially missing set before journal creation', async () => {
  for (const missing of ['all', 'one']) {
    const client = new FakeClient();
    for (const descriptor of bootstrapACleanupResourceSet(sourceRevision)) {
      if (missing === 'all' || descriptor.kind === 'ServiceAccount') {
        client.objects.delete(key(descriptor.kind, descriptor.name));
      }
    }
    await assert.rejects(cleanupBootstrapAInitializer(input(client)), /NeedsAttention:.*missing/);
    assert.equal(client.objects.has(key('ConfigMap',
      'opensphere-bootstrap-a-initializer-cleanup-journal')), false);
  }
});

test('cleanup rejects unexpected prefixed or labeled residues', async () => {
  const client = new FakeClient();
  client.put({ apiVersion: 'batch/v1', kind: 'Job',
    metadata: metadata(`opensphere-tls-init-${'c'.repeat(40)}`, 'opensphere-console'), spec: {} });
  await assert.rejects(cleanupBootstrapAInitializer(input(client)),
    /NeedsAttention: unexpected Bootstrap A initializer residue/);
});

test('cleanup rejects drift before creating its immutable journal', async () => {
  const client = new FakeClient();
  client.objects.get(key('ServiceAccount', 'platform-release-tls-initializer'))
    .automountServiceAccountToken = true;
  await assert.rejects(cleanupBootstrapAInitializer(input(client)),
    /NeedsAttention: Bootstrap A initializer ServiceAccount drifted/);
  assert.equal(client.deleteCalls.length, 0);
});

test('live cleanup rejects every initializer and permanent custody broadening before mutation', async () => {
  const cases = [
    (client) => client.objects.get(key('Role', 'platform-release-tls-initializer'))
      .rules[0].verbs.push('get'),
    (client) => client.objects.get(key('Role', 'platform-release-tls-initializer'))
      .rules.push({ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }),
    (client) => client.objects.get(key('ValidatingAdmissionPolicy',
      'platform-release-tls-initializer-job-boundary'))
      .spec.matchConstraints.resourceRules[0].resources.push('cronjobs'),
    (client) => { client.objects.get(key('ValidatingAdmissionPolicy',
      'platform-release-tls-initializer-pod-boundary'))
      .spec.validations[0].expression += ' || true'; },
    (client) => { client.objects.get(key('ValidatingAdmissionPolicyBinding',
      'platform-release-tls-initializer-job-boundary')).spec.validationActions = ['Warn']; },
    (client) => client.objects.get(key('NetworkPolicy', 'platform-release-tls-initializer'))
      .spec.egress[0].ports.push({ protocol: 'TCP', port: 6443 }),
    (client) => { client.objects.get(key('NetworkPolicy', 'platform-release-tls-initializer'))
      .spec.egress[1].to[0].ipBlock.cidr = '0.0.0.0/0'; },
    (client) => client.objects.get(key('Job', `opensphere-tls-init-${sourceRevision}`))
      .spec.template.spec.containers[0].env.push({ name: 'EXTRA', value: 'unsafe' }),
    (client) => client.objects.get(key('Job', `opensphere-tls-init-${sourceRevision}`))
      .spec.template.spec.volumes.push({ name: 'host', hostPath: { path: '/' } }),
    (client) => { client.objects.get(key('Job', `opensphere-tls-init-${sourceRevision}`))
      .spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation = true; },
    (client) => { client.objects.get(key('ValidatingAdmissionPolicy',
      'opensphere-platform-release-authority-service-custody'))
      .spec.validations[0].expression += ' || true'; },
    (client) => { client.objects.get(key('ValidatingAdmissionPolicyBinding',
      'opensphere-bootstrap-a-initializer-cleanup-journal-custody'))
      .spec.validationActions = ['Warn']; },
    (client) => { client.objects.get(key('Service', 'opensphere-platform-release-authority'))
      .spec.type = 'LoadBalancer'; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const client = new FakeClient();
    mutate(client);
    await assert.rejects(cleanupBootstrapAInitializer(input(client)), /NeedsAttention:/,
      `live authority mutation case ${index} must fail closed`);
    assert.equal(client.deleteCalls.length, 0);
    assert.equal(client.objects.has(key('ConfigMap',
      'opensphere-bootstrap-a-initializer-cleanup-journal')), false);
  }
});

test('cleanup resumes a partial journaled deletion without recreating retained authority', async () => {
  const client = new FakeClient();
  const originalDelete = client.delete.bind(client);
  let blocked = true;
  client.delete = async (descriptor, precondition) => {
    if (blocked && descriptor.kind === 'Role') throw new Error('persistent transport loss');
    return originalDelete(descriptor, precondition);
  };
  await assert.rejects(cleanupBootstrapAInitializer(input(client)),
    /NeedsAttention: exact cleanup delete did not converge/);
  assert.ok(client.objects.has(key('ConfigMap',
    'opensphere-bootstrap-a-initializer-cleanup-journal')));
  blocked = false;
  const proof = await cleanupBootstrapAInitializer(input(client));
  assert.equal(proof.residueCount, 0);
  assert.equal(proof.deletedResources.length, 11);
});

test('journal replay rejects extra, duplicate, and wrong descriptor shapes before mutation', async () => {
  for (const mutation of [
    (journal) => { journal.extra = true; },
    (journal) => { journal.deletedResources[1] = structuredClone(journal.deletedResources[0]); },
    (journal) => { journal.deletedResources[0].name = 'platform-release-tls-initializer-wrong'; },
  ]) {
    const client = new FakeClient();
    let deleteAttempts = 0;
    client.delete = async () => { deleteAttempts += 1; throw new Error('blocked before mutation'); };
    await assert.rejects(cleanupBootstrapAInitializer(input(client)),
      /NeedsAttention: exact cleanup delete did not converge/);
    const object = client.objects.get(key('ConfigMap',
      'opensphere-bootstrap-a-initializer-cleanup-journal'));
    const journal = JSON.parse(object.data['journal.json']);
    mutation(journal);
    object.data['journal.json'] = canonicalJson(journal);
    deleteAttempts = 0;
    await assert.rejects(cleanupBootstrapAInitializer(input(client)),
      /NeedsAttention: Bootstrap A cleanup journal/);
    assert.equal(deleteAttempts, 0);
  }
});
