import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInstallationEvidence } from '../src/verify.mjs';

test('verification persists secret-free installation evidence in the documented ConfigMap', () => {
  let invocation;
  const evidence = {
    channel: 'edge',
    releaseDigest: 'sha256:' + '1'.repeat(64),
    verifiedAt: '2026-07-23T00:00:00.000Z',
    podCount: 12
  };
  const manifest = recordInstallationEvidence(evidence, {
    apply(args, options) { invocation = { args, options }; }
  });
  assert.deepEqual(invocation.args, ['apply', '-f', '-']);
  assert.equal(invocation.options.capture, true);
  assert.equal(manifest.metadata.name, 'opensphere-installation-evidence');
  assert.equal(manifest.metadata.namespace, 'opensphere-console');
  assert.deepEqual(JSON.parse(manifest.data['evidence.json']), evidence);
  assert.doesNotMatch(invocation.options.input, /token|password|privateKey/i);
});
