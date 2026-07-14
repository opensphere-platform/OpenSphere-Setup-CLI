import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReleaseBackupTarget, backupTargetData, inspectBackupTarget, parseBackupTargetSecretRef } from '../src/backup-target.mjs';

function secret(values = {}) {
  const defaults = {
    endpoint: 'https://s3.example.test', bucket: 'opensphere-audit', access_key: 'access', secret_key: 'secret', 'ca.crt': 'ca', region: 'ap-chuncheon-1',
  };
  return { data: Object.fromEntries(Object.entries({ ...defaults, ...values }).map(([key, value]) => [key, Buffer.from(value).toString('base64')])) };
}

test('backup target secret reference is namespace scoped', () => {
  assert.deepEqual(parseBackupTargetSecretRef('platform-secrets/audit-backup'), { namespace: 'platform-secrets', name: 'audit-backup' });
  assert.throws(() => parseBackupTargetSecretRef('audit-backup'), /namespace\/name/);
});

test('candidate and stable reject an in-cluster backup target', () => {
  const target = inspectBackupTarget(secret({ endpoint: 'https://backbone-rustfs.opensphere-backbone.svc.cluster.local:9000' }));
  assert.equal(target.inCluster, true);
  assert.doesNotThrow(() => assertReleaseBackupTarget(target, 'edge'));
  assert.throws(() => assertReleaseBackupTarget(target, 'candidate'), /external S3-compatible/);
  assert.throws(() => assertReleaseBackupTarget(target, 'stable'), /external S3-compatible/);
});

test('backup target copies only the declared backup contract', () => {
  const source = secret();
  source.data.unrelated = Buffer.from('must-not-copy').toString('base64');
  assert.deepEqual(Object.keys(backupTargetData(source)).sort(), ['access_key', 'bucket', 'ca.crt', 'endpoint', 'region', 'secret_key']);
});
