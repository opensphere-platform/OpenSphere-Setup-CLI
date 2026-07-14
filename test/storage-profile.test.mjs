import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStorageProfile } from '../src/storage-profile.mjs';

function storageClass(overrides = {}) {
  return {
    metadata: { name: 'durable-csi', annotations: {
      'opensphere.io/backbone-storage-profile': 'durable-v1',
      'opensphere.io/encryption-at-rest': 'true',
      'opensphere.io/failure-domain': 'zone-redundant',
    } },
    provisioner: 'csi.example.test', reclaimPolicy: 'Retain', allowVolumeExpansion: true,
    ...overrides,
  };
}

test('edge permits a local StorageClass for a disposable bootstrap', () => {
  const local = storageClass({ metadata: { name: 'standard', annotations: {} }, provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', allowVolumeExpansion: false });
  assert.deepEqual(assertStorageProfile(local, 'edge'), { name: 'standard', profile: 'edge' });
});

test('candidate and stable require an operator-certified durable storage profile', () => {
  const local = storageClass({ provisioner: 'rancher.io/local-path' });
  assert.throws(() => assertStorageProfile(local, 'candidate'), /node-local/);
  assert.throws(() => assertStorageProfile(local, 'stable'), /node-local/);
  assert.deepEqual(assertStorageProfile(storageClass(), 'candidate'), { name: 'durable-csi', profile: 'durable-v1' });
});
