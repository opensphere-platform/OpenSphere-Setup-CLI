import assert from 'node:assert/strict';
import test from 'node:test';
import { isRuntimeServicePod } from '../src/verify.mjs';

test('installation readiness ignores completed and failed Job history pods', () => {
  const deploymentPod = {
    metadata: { ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', controller: true }] },
    status: { phase: 'Running' }
  };
  const failedReleaseJobPod = {
    metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', controller: true }] },
    status: { phase: 'Failed' }
  };
  const completedInspectionPod = {
    metadata: { ownerReferences: [] },
    status: { phase: 'Succeeded' }
  };
  const replacedFailedServicePod = {
    metadata: { ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', controller: true }] },
    status: { phase: 'Failed' }
  };

  assert.equal(isRuntimeServicePod(deploymentPod), true);
  assert.equal(isRuntimeServicePod(failedReleaseJobPod), false);
  assert.equal(isRuntimeServicePod(completedInspectionPod), false);
  assert.equal(isRuntimeServicePod(replacedFailedServicePod), false);
});
