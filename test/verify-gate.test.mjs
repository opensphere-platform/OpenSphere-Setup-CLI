import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableInstallationReadinessError } from '../src/verify.mjs';

test('only transient endpoint and pod readiness failures are retried', () => {
  assert.equal(isRetryableInstallationReadinessError(
    new Error('Required Service has no ready EndpointSlice endpoint: opensphere-console/opensphere-console-ext')
  ), true);
  assert.equal(isRetryableInstallationReadinessError(
    new Error('OpenSphere Pods are not Ready: opensphere-console/opensphere-console-abc')
  ), true);
  assert.equal(isRetryableInstallationReadinessError(
    new Error('Runtime image differs from release lock: opensphere-console/opensphere-console')
  ), false);
  assert.equal(isRetryableInstallationReadinessError(
    new Error('Workload does not reference the governed registry pull Secret: opensphere-console/opensphere-console')
  ), false);
});
