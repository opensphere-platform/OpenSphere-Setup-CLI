import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightPromotion } from '../src/promotion-preflight.mjs';

const encode = (value) => Buffer.from(value).toString('base64');
const backupSecret = (endpoint = 'https://backup.example.test') => ({
  data: {
    endpoint: encode(endpoint),
    bucket: encode('opensphere-audit'),
    access_key: encode('not-logged'),
    secret_key: encode('not-logged'),
    'ca.crt': encode('not-logged'),
    region: encode('ap-chuncheon-1')
  }
});
const tlsSecret = { type: 'kubernetes.io/tls', data: { 'tls.crt': encode('not-logged'), 'tls.key': encode('not-logged') } };
const cluster = { serverVersion: 'v1.31.2', nodeCount: 3, storageClass: 'durable-csi' };
const inspectedTls = { hostname: 'console.example.test', subject: 'CN=console.example.test', validTo: '2030-01-01T00:00:00.000Z', certificateCount: 2, profile: 'external-ca-v1' };

test('candidate promotion preflight validates read-only prerequisites without disclosing Secret values', () => {
  const reads = [];
  const evidence = preflightPromotion({
    channel: 'candidate',
    consoleUrl: 'https://console.example.test',
    backupTargetSecret: 'platform-secrets/opensphere-audit-backup',
    shellTlsSecret: 'platform-secrets/opensphere-console-public-tls',
    readSecret(reference) {
      reads.push(`${reference.namespace}/${reference.name}`);
      return reference.name.includes('audit') ? backupSecret() : tlsSecret;
    },
    runPreflight: () => cluster,
    inspectTls: () => inspectedTls
  });

  assert.deepEqual(reads, [
    'platform-secrets/opensphere-audit-backup',
    'platform-secrets/opensphere-console-public-tls'
  ]);
  assert.deepEqual(evidence, {
    channel: 'candidate',
    authEnvironment: 'production',
    kubernetesVersion: 'v1.31.2',
    nodeCount: 3,
    storageClass: 'durable-csi',
    backup: { endpoint: 'https://backup.example.test', bucket: 'opensphere-audit', region: 'ap-chuncheon-1' },
    tls: inspectedTls
  });
  assert.doesNotMatch(JSON.stringify(evidence), /not-logged/);
});

test('promotion preflight rejects in-cluster backup endpoints and non-promotion channels', () => {
  const options = {
    consoleUrl: 'https://console.example.test',
    backupTargetSecret: 'platform-secrets/opensphere-audit-backup',
    shellTlsSecret: 'platform-secrets/opensphere-console-public-tls',
    readSecret(reference) { return reference.name.includes('audit') ? backupSecret('https://rustfs.opensphere-backbone.svc') : tlsSecret; },
    runPreflight: () => cluster,
    inspectTls: () => inspectedTls
  };
  assert.throws(() => preflightPromotion({ ...options, channel: 'candidate' }), /external S3-compatible/);
  assert.throws(() => preflightPromotion({ ...options, channel: 'edge' }), /only available for candidate or stable/);
});
