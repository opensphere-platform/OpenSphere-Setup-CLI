import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredSecretsForLock } from '../src/verify.mjs';

test('bootstrap verification requires Supabase, Gitea, Beszel and C_API runtime Secrets', () => {
  const required = requiredSecretsForLock({ components: {} });
  assert.deepEqual(required['opensphere-console-data/opensphere-supabase-secrets'], [
    'anon-key', 'jwt-secret', 'postgres-password', 's3-access-key-id',
    's3-access-key-secret', 'service-role-key'
  ]);
  assert.deepEqual(required['opensphere-monitoring/beszel-runtime'], [
    'admin-email', 'admin-password', 'reader-email', 'reader-password', 'agent-token'
  ]);
  assert.deepEqual(required['opensphere-console/opensphere-console-api-runtime'], [
    'database-url', 'session-encryption-key', 'supabase-service-role-key'
  ]);
  assert.deepEqual(required['opensphere-console/opensphere-extension-controller-runtime'], ['database-url']);
});

test('Console-activated optional module Secrets are outside bootstrap verification', () => {
  const required = requiredSecretsForLock({ components: { osdst: {}, osaaGateway: {} } });
  assert.equal(required['opensphere-console/opensphere-osaa-maintenance-runtime'], undefined);
  assert.equal(required['opensphere-console/opensphere-osaa-runtime'], undefined);
  assert.equal(required['opensphere-osaa-credentials/opensphere-osaa-runtime'], undefined);
});

test('Gitea bootstrap requires current scoped tokens without manufacturing retired Backend webhook credentials', () => {
  const required = requiredSecretsForLock({ components: { consoleApi: {}, gitea: {} } });
  assert.deepEqual(required['opensphere-console/opensphere-gitea-control-plane'], ['token', 'review-token']);
});
