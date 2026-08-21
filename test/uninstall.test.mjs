import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGED_CLUSTER_POLICIES, MANAGED_CLUSTER_RBAC, MANAGED_CRDS, MANAGED_NAMESPACES, uninstallManagedInstallation } from '../src/bootstrap.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'src', 'cli.mjs');

test('uninstall refuses to reach Kubernetes without the explicit destructive confirmation', () => {
  for (const args of [
    ['uninstall'],
    ['uninstall', '--purge-data'],
    ['uninstall', '--purge-data', '--confirm', 'delete-opensphere']
  ]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /uninstall .*--purge-data.*--confirm DELETE-OPENSPHERE|requires --confirm DELETE-OPENSPHERE/);
    assert.doesNotMatch(result.stderr, /kubectl/i);
  }
});

test('managed cluster RBAC retains OSAA environment-reader lifecycle ownership but drops the obsolete controlled-operator role', () => {
  assert.equal(MANAGED_CLUSTER_RBAC.includes('clusterrolebinding/opensphere-console-osaa-gateway-environment-reader'), true);
  assert.equal(MANAGED_CLUSTER_RBAC.includes('clusterrole/opensphere-console-osaa-gateway-environment-reader'), true);
  assert.equal(MANAGED_CLUSTER_RBAC.some((resource) => resource.includes('controlled-operator')), false);
});

test('managed uninstall owns Console integrity and Foundation closed-catalog admission policies', () => {
  assert.deepEqual(MANAGED_CLUSTER_POLICIES, [
    'validatingadmissionpolicybinding/foundation-bootstrap-closed-catalog',
    'validatingadmissionpolicy/foundation-bootstrap-closed-catalog',
    'validatingadmissionpolicybinding/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicy/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-workload',
    'validatingadmissionpolicy/opensphere-console-image-integrity-workload',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-cronjob',
    'validatingadmissionpolicy/opensphere-console-image-integrity-cronjob'
  ]);
});

test('managed uninstall deletes namespaces, retained PVs, then only OpenSphere CRDs', async () => {
  const events = [];
  const result = await uninstallManagedInstallation({
    runtime: {
      readInstallationLock: () => ({ releaseDigest: 'sha256:managed' }),
      existingOpenSphereNamespaces: () => [...MANAGED_NAMESPACES],
      listManagedPersistentVolumes: () => ['pvc-retained-a', 'pvc-retained-b'],
      deleteManagedNamespace: (name) => events.push(`delete-ns:${name}`),
      waitForManagedNamespaceDeletion: (name) => events.push(`wait-ns:${name}`),
      deleteManagedPersistentVolume: (name) => events.push(`delete-pv:${name}`),
      deleteManagedCrd: (name) => events.push(`delete-crd:${name}`),
      deleteManagedClusterRbac: (name) => events.push(`delete-rbac:${name}`)
    }
  });
  assert.deepEqual(result, {
    releaseDigest: 'sha256:managed',
    namespaces: [...MANAGED_NAMESPACES],
    persistentVolumes: ['pvc-retained-a', 'pvc-retained-b'],
    customResourceDefinitions: [...MANAGED_CRDS],
    clusterPolicies: [...MANAGED_CLUSTER_POLICIES],
    clusterRbac: [...MANAGED_CLUSTER_RBAC]
  });
  assert.deepEqual(events, [
    ...MANAGED_NAMESPACES.map((name) => `delete-ns:${name}`),
    ...MANAGED_NAMESPACES.map((name) => `wait-ns:${name}`),
    'delete-pv:pvc-retained-a',
    'delete-pv:pvc-retained-b',
    ...MANAGED_CRDS.map((name) => `delete-crd:${name}`),
    ...MANAGED_CLUSTER_POLICIES.map((name) => `delete-rbac:${name}`),
    ...MANAGED_CLUSTER_RBAC.map((name) => `delete-rbac:${name}`)
  ]);
});

test('managed uninstall refuses an installation lock that does not own every namespace', async () => {
  await assert.rejects(
    uninstallManagedInstallation({
      runtime: {
        readInstallationLock: () => ({ releaseDigest: 'sha256:managed' }),
        existingOpenSphereNamespaces: () => ['opensphere-console']
      }
    }),
    /Managed namespace ownership differs/
  );
});

test('managed uninstall never purges a namespace without an installation lock', async () => {
  await assert.rejects(
    uninstallManagedInstallation({
      runtime: {
        readInstallationLock: () => null,
        existingOpenSphereNamespaces: () => ['opensphere-console']
      }
    }),
    /Refusing to purge unmanaged OpenSphere namespaces/
  );
});
