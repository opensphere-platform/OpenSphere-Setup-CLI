import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReleaseRecoveryTarget,
  inspectRecoveryTarget,
  parseRecoveryTargetSecretRef,
  recoveryTargetData
} from '../src/recovery-target.mjs';

function secret(values = {}) {
  const defaults = {
    endpoint: 'https://s3.example.test', bucket: 'opensphere-audit', access_key: 'access', secret_key: 'secret', 'ca.crt': 'ca', region: 'ap-chuncheon-1',
  };
  return { data: Object.fromEntries(Object.entries({ ...defaults, ...values }).map(([key, value]) => [key, Buffer.from(value).toString('base64')])) };
}

test('recovery target secret reference is namespace scoped', () => {
  assert.deepEqual(parseRecoveryTargetSecretRef('platform-secrets/recovery-target'), { namespace: 'platform-secrets', name: 'recovery-target' });
  assert.throws(() => parseRecoveryTargetSecretRef('recovery-target'), /namespace\/name/);
});

test('candidate and stable reject an in-cluster recovery target', () => {
  const target = inspectRecoveryTarget(secret({ endpoint: 'https://object-store.opensphere-console-data.svc.cluster.local:9000' }));
  assert.equal(target.inCluster, true);
  assert.doesNotThrow(() => assertReleaseRecoveryTarget(target, 'edge'));
  assert.throws(() => assertReleaseRecoveryTarget(target, 'candidate'), /external S3-compatible/);
  assert.throws(() => assertReleaseRecoveryTarget(target, 'stable'), /external S3-compatible/);
});

test('recovery target copies only the declared recovery contract', () => {
  const source = secret();
  source.data.unrelated = Buffer.from('must-not-copy').toString('base64');
  assert.deepEqual(Object.keys(recoveryTargetData(source)).sort(), ['access_key', 'bucket', 'ca.crt', 'endpoint', 'region', 'secret_key']);
});
