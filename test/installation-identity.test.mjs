import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureInstallationIdentity, INSTALLATION_IDENTITY_CONFIGMAP } from '../src/installation-identity.mjs';

const CLUSTER = '6c1a7b2e-3f4d-4a5b-9c8d-7e6f5a4b3c2d';
const OTHER_CLUSTER = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const ID_A = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const ID_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

// A fake cluster that behaves like kubectl for the calls the module makes.
function cluster({ uid = CLUSTER, stored = null, failCreate } = {}) {
  const state = { uid, stored, creates: 0, applies: 0 };
  const kubectl = (args, options = {}) => {
    const command = args.join(' ');
    if (command === 'get namespace kube-system -o jsonpath={.metadata.uid}') return state.uid;
    if (command === `-n opensphere-console get configmap ${INSTALLATION_IDENTITY_CONFIGMAP} --ignore-not-found -o json`) {
      return state.stored ? JSON.stringify(state.stored) : '';
    }
    if (command === 'create -f -') {
      state.creates += 1;
      if (failCreate) failCreate(state);
      if (state.stored) throw Object.assign(new Error('kubectl create failed'), { stderr: 'Error from server (AlreadyExists): configmaps "x" already exists' });
      state.stored = JSON.parse(options.input);
      return '';
    }
    if (args[0] === 'apply') state.applies += 1;
    throw new Error('unexpected kubectl call: ' + command);
  };
  return { state, kubectl };
}
const NOW = () => new Date('2026-10-04T13:40:00.123Z');

test('a missing identity is created once, immutable and bound to the cluster', () => {
  const c = cluster();
  const identity = ensureInstallationIdentity({ kubectl: c.kubectl, newId: () => ID_A, now: NOW });
  assert.deepEqual(identity, { installationId: ID_A, clusterUid: CLUSTER });
  assert.equal(c.state.stored.immutable, true);
  assert.deepEqual(c.state.stored.data, { installationId: ID_A, clusterUid: CLUSTER, createdAt: '2026-10-04T13:40:00Z' });
  // Later runs read it and never create or apply again.
  const again = ensureInstallationIdentity({ kubectl: c.kubectl, newId: () => ID_B, now: NOW });
  assert.equal(again.installationId, ID_A);
  assert.deepEqual([c.state.creates, c.state.applies], [1, 0]);
});

test('concurrent first runs converge on the one identity that was created', () => {
  // Another Setup run creates the record between our read and our create.
  const c = cluster({ failCreate: (state) => { if (!state.stored) state.stored = { apiVersion: 'v1', kind: 'ConfigMap', immutable: true,
    data: { installationId: ID_B, clusterUid: CLUSTER, createdAt: '2026-10-04T13:39:59Z' } }; } });
  const identity = ensureInstallationIdentity({ kubectl: c.kubectl, newId: () => ID_A, now: NOW });
  assert.equal(identity.installationId, ID_B, 'the losing writer adopts the winner instead of overwriting it');
});

test('an identity of another cluster is refused, never reused or replaced', () => {
  const c = cluster({ stored: { immutable: true, data: { installationId: ID_A, clusterUid: OTHER_CLUSTER, createdAt: '2026-10-01T00:00:00Z' } } });
  assert.throws(() => ensureInstallationIdentity({ kubectl: c.kubectl, newId: () => ID_B }), { code: 'InstallationIdentityClusterMismatch' });
  assert.equal(c.state.creates, 0);
});

test('an earlier recorded installationId is kept on upgrade; a different one conflicts', () => {
  const c = cluster();
  assert.equal(ensureInstallationIdentity({ kubectl: c.kubectl, newId: () => ID_B, adoptInstallationId: ID_A, now: NOW }).installationId, ID_A);
  assert.throws(() => ensureInstallationIdentity({ kubectl: c.kubectl, newId: () => ID_B, adoptInstallationId: ID_B }), { code: 'InstallationIdentityConflict' });
  assert.throws(() => ensureInstallationIdentity({ kubectl: cluster().kubectl, adoptInstallationId: 'not-a-uuid' }), { code: 'InstallationIdentityInvalid' });
});

test('a malformed or mutable record is refused and never repaired automatically', () => {
  for (const stored of [
    { immutable: false, data: { installationId: ID_A, clusterUid: CLUSTER, createdAt: '2026-10-01T00:00:00Z' } },
    { immutable: true, data: { installationId: 'x', clusterUid: CLUSTER, createdAt: '2026-10-01T00:00:00Z' } },
    { immutable: true, data: { installationId: ID_A, clusterUid: CLUSTER, createdAt: '2026-10-01T00:00:00Z', extra: '1' } },
  ]) {
    const c = cluster({ stored });
    assert.throws(() => ensureInstallationIdentity({ kubectl: c.kubectl, newId: () => ID_B }), { code: 'InstallationIdentityInvalid' }, JSON.stringify(stored));
    assert.equal(c.state.creates, 0);
  }
  assert.throws(() => ensureInstallationIdentity({ kubectl: cluster({ uid: '' }).kubectl }), { code: 'InstallationIdentityUnavailable' });
  const other = cluster({ failCreate: () => { throw Object.assign(new Error('kubectl create failed'), { stderr: 'Error from server (Forbidden)' }); } });
  assert.throws(() => ensureInstallationIdentity({ kubectl: other.kubectl, newId: () => ID_A }), /kubectl create failed/, 'other create failures are not swallowed');
});
