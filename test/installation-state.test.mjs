import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  installationStateDocument,
  MANAGED_NAMESPACES
} from '../src/bootstrap.mjs';
import {
  BASELINE_OBSERVABILITY_REQUIREMENT,
  MANAGED_CLUSTER_SCOPED_RESOURCES
} from '../src/installation-contract.mjs';

const lock = { releaseDigest: `sha256:${'a'.repeat(64)}` };

test('installation lifecycle cannot publish Ready without verification evidence', () => {
  assert.equal(installationStateDocument('Preparing', lock).phase, 'Preparing');
  assert.equal(installationStateDocument('Installing', lock).phase, 'Installing');
  assert.throws(
    () => installationStateDocument('Ready', lock),
    /completed verification evidence/
  );
  const ready = installationStateDocument('Ready', lock, {
    observedAt: '2026-09-02T00:00:01.000Z',
    verification: {
      evidenceConfigMap: 'opensphere-installation-evidence',
      verifiedAt: '2026-09-02T00:00:00.000Z'
    }
  });
  assert.equal(ready.phase, 'Ready');
  assert.deepEqual(ready.managedNamespaces, [...MANAGED_NAMESPACES]);
  assert.equal(ready.verification.evidenceConfigMap, 'opensphere-installation-evidence');
});

test('failed installation state has bounded machine-readable cause and no false verification', () => {
  assert.throws(
    () => installationStateDocument('Failed', lock),
    /bounded failure code/
  );
  assert.throws(
    () => installationStateDocument('Installing', lock, {
      verification: {
        evidenceConfigMap: 'opensphere-installation-evidence',
        verifiedAt: '2026-09-02T00:00:00.000Z'
      }
    }),
    /cannot claim completed verification/
  );
  assert.deepEqual(
    installationStateDocument('Failed', lock, {
      observedAt: '2026-09-02T00:00:02.000Z',
      failureCode: 'bootstrap-failed'
    }),
    {
      apiVersion: 'bootstrap.opensphere.io/v1alpha1',
      kind: 'OpenSphereInstallationState',
      phase: 'Failed',
      releaseDigest: lock.releaseDigest,
      observedAt: '2026-09-02T00:00:02.000Z',
      managedNamespaces: [...MANAGED_NAMESPACES],
      managedClusterScopedResources: {
        customResourceDefinitions: [...MANAGED_CLUSTER_SCOPED_RESOURCES.customResourceDefinitions],
        clusterRbac: [...MANAGED_CLUSTER_SCOPED_RESOURCES.clusterRbac],
        admissionPolicies: [...MANAGED_CLUSTER_SCOPED_RESOURCES.admissionPolicies]
      },
      baselineObservabilitySecurity: {
        ...BASELINE_OBSERVABILITY_REQUIREMENT,
        hostAccess: [...BASELINE_OBSERVABILITY_REQUIREMENT.hostAccess],
        podSecurityEnforce: 'not-observed',
        status: 'not-observed'
      },
      failureCode: 'bootstrap-failed'
    }
  );
});
test('bootstrap records a durable Preparing lock before namespace-scoped setup and Ready only after verification', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const bootstrap = source.slice(source.indexOf('export async function bootstrap('));
  const materialized = bootstrap.indexOf('const prepared = await prepareRelease(');
  const consoleNamespace = bootstrap.indexOf("ensureNamespace('opensphere-console')", materialized);
  const preparing = bootstrap.indexOf("'Preparing'", consoleNamespace);
  const otherNamespaces = bootstrap.indexOf('MANAGED_NAMESPACES.filter', preparing);
  const registry = bootstrap.indexOf('ensureRegistryPullSecrets(', preparing);
  const verify = bootstrap.indexOf('const evidence = await verifyInstallation(', registry);
  const ready = bootstrap.indexOf("'Ready'", verify);
  assert.ok(materialized >= 0 && consoleNamespace > materialized);
  assert.ok(preparing > consoleNamespace && otherNamespaces > preparing && registry > preparing);
  assert.ok(verify > registry && ready > verify);
});
