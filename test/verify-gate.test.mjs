import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasDurableBeszelBootstrapEvidence,
  isRetryableInstallationReadinessError
} from '../src/verify.mjs';

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

test('expired Beszel bootstrap Job requires evidence bound to the exact installation state', () => {
  const releaseDigest = `sha256:${'a'.repeat(64)}`;
  const verifiedAt = '2026-09-04T05:48:24.074Z';
  const lock = { releaseDigest };
  const installationState = { verification: { verifiedAt } };
  const evidence = {
    releaseDigest,
    verifiedAt,
    runtimeImagesMatchLock: true,
    beszel: { bootstrapJobComplete: true, agentPublicKeyPublished: true }
  };

  assert.equal(hasDurableBeszelBootstrapEvidence(evidence, lock, installationState), true);
  assert.equal(hasDurableBeszelBootstrapEvidence(
    { ...evidence, releaseDigest: `sha256:${'b'.repeat(64)}` },
    lock,
    installationState
  ), false);
  assert.equal(hasDurableBeszelBootstrapEvidence(
    { ...evidence, verifiedAt: '2026-09-04T05:48:25.000Z' },
    lock,
    installationState
  ), false);
  assert.equal(hasDurableBeszelBootstrapEvidence(
    { ...evidence, runtimeImagesMatchLock: false },
    lock,
    installationState
  ), false);
});
