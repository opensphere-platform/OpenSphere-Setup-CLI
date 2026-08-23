import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredSecretsForLock } from '../src/verify.mjs';

test('OSDST releases require the dedicated maintenance runtime Secret', () => {
  const required = requiredSecretsForLock({ components: { osdst: {} } });
  assert.deepEqual(
    required['opensphere-console/opensphere-osaa-maintenance-runtime'],
    [
      'operational-pg-user', 'operational-pg-password',
      'dialogue-pg-user', 'dialogue-pg-password'
    ]
  );
  assert.deepEqual(
    required['opensphere-console/opensphere-osaa-runtime'],
    [
      'pg-password', 'observer-pg-user', 'observer-pg-password',
      'relay-pg-user', 'relay-pg-password'
    ]
  );
});

test('pre-OSDST rollback does not require the later maintenance runtime Secret', () => {
  const required = requiredSecretsForLock({ components: {} });
  assert.equal(required['opensphere-console/opensphere-osaa-maintenance-runtime'], undefined);
  assert.equal(required['opensphere-console/opensphere-osaa-runtime'].includes('maintenance-pg-user'), false);
});
