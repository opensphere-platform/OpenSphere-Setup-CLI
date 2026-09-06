import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGED_CLUSTER_POLICIES, MANAGED_CLUSTER_RBAC, MANAGED_CRDS, MANAGED_NAMESPACES, existingManagedNamespaces, uninstallManagedInstallation } from '../src/bootstrap.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'src', 'cli.mjs');

function ownedInstallationState(releaseDigest = 'sha256:managed') {
  return {
    releaseDigest,
    managedNamespaces: [...MANAGED_NAMESPACES],
    managedClusterScopedResources: {
      customResourceDefinitions: [...MANAGED_CRDS],
      clusterRbac: [...MANAGED_CLUSTER_RBAC],
      admissionPolicies: [...MANAGED_CLUSTER_POLICIES]
    }
  };
}

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

test('managed cluster RBAC owns every cluster authority installed by Console bootstrap', () => {
  assert.deepEqual(MANAGED_CLUSTER_RBAC, [
    'clusterrolebinding/opensphere-extension-controller-cli-downloads',
    'clusterrolebinding/opensphere-registry',
    'clusterrolebinding/opensphere-console-osaa-gateway-environment-reader',
    'clusterrolebinding/opensphere-shell-runtime-token-reviewer',
    'clusterrolebinding/opensphere-cluster-manager-runtime',
    'clusterrolebinding/opensphere-extension-installation-profile-reader',
    'clusterrole/opensphere-extension-controller-cli-downloads',
    'clusterrole/opensphere-registry',
    'clusterrole/opensphere-console-osaa-gateway-environment-reader',
    'clusterrole/opensphere-shell-runtime-token-reviewer',
    'clusterrole/opensphere-cluster-manager-runtime',
    'clusterrole/opensphere-extension-installation-profile-reader'
  ]);
  assert.equal(MANAGED_CLUSTER_RBAC.some((resource) => resource.includes('backend')), false);
});

test('managed uninstall owns only Console bootstrap admission policies', () => {
  assert.deepEqual(MANAGED_CLUSTER_POLICIES, [
    'validatingadmissionpolicybinding/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicy/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-workload',
    'validatingadmissionpolicy/opensphere-console-image-integrity-workload',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-cronjob',
    'validatingadmissionpolicy/opensphere-console-image-integrity-cronjob',
    'validatingadmissionpolicybinding/opensphere-shell-runtime-template-v1',
    'validatingadmissionpolicy/opensphere-shell-runtime-template-v1'
  ]);
});

test('managed uninstall deletes namespaces, retained PVs, then only OpenSphere CRDs', async () => {
  const events = [];
  const result = await uninstallManagedInstallation({
    runtime: {
      readInstallationLock: () => ({ releaseDigest: 'sha256:managed' }),
      readInstallationState: () => ownedInstallationState(),
      existingOpenSphereNamespaces: () => [...MANAGED_NAMESPACES, 'opensphere-developer', 'opensphere-www'],
      listManagedPersistentVolumes: () => ['pvc-retained-a', 'pvc-retained-b'],
      deleteManagedNamespace: (name) => events.push(`delete-ns:${name}`),
      waitForManagedNamespaceDeletion: (name) => events.push(`wait-ns:${name}`),
      deleteManagedPersistentVolume: (name) => events.push(`delete-pv:${name}`),
      listManagedCrdInstances: (name) => { events.push(`guard-crd:${name}`); return []; },
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
    ...MANAGED_CRDS.map((name) => `guard-crd:${name}`),
    ...MANAGED_CRDS.map((name) => `delete-crd:${name}`),
    ...MANAGED_CLUSTER_POLICIES.map((name) => `delete-rbac:${name}`),
    ...MANAGED_CLUSTER_RBAC.map((name) => `delete-rbac:${name}`)
  ]);
});

test('managed uninstall preserves shared CRDs when any cluster-wide instance remains', async () => {
  const events = [];
  await assert.rejects(
    uninstallManagedInstallation({
      runtime: {
        readInstallationLock: () => ({ releaseDigest: 'sha256:managed' }),
        readInstallationState: () => ownedInstallationState(),
        existingOpenSphereNamespaces: () => [...MANAGED_NAMESPACES, 'opensphere-developer'],
        listManagedPersistentVolumes: () => [],
        deleteManagedNamespace: (name) => events.push(`delete-ns:${name}`),
        waitForManagedNamespaceDeletion: (name) => events.push(`wait-ns:${name}`),
        listManagedCrdInstances: (name) => {
          events.push(`guard-crd:${name}`);
          return name === MANAGED_CRDS[0] ? ['opensphere-developer/developer-plugin'] : [];
        },
        deleteManagedCrd: (name) => events.push(`delete-crd:${name}`),
        deleteManagedClusterRbac: (name) => events.push(`delete-rbac:${name}`)
      }
    }),
    /Refusing to delete shared custom resource definition.*opensphere-developer\/developer-plugin/
  );
  assert.deepEqual(events, [
    ...MANAGED_NAMESPACES.map((name) => `delete-ns:${name}`),
    ...MANAGED_NAMESPACES.map((name) => `wait-ns:${name}`),
    `guard-crd:${MANAGED_CRDS[0]}`
  ]);
  assert.equal(events.some((event) => event.startsWith('delete-crd:') || event.startsWith('delete-rbac:')), false);
});

test('managed uninstall refuses an installation lock that does not own every namespace', async () => {
  await assert.rejects(
    uninstallManagedInstallation({
      runtime: {
        readInstallationLock: () => ({ releaseDigest: 'sha256:managed' }),
        readInstallationState: () => ownedInstallationState(),
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
    /Refusing to purge unmanaged Setup namespaces/
  );
});


test('managed namespace discovery ignores other OpenSphere products', () => {
  assert.deepEqual(existingManagedNamespaces([
    'opensphere-www',
    'opensphere-console',
    'opensphere-developer',
    'opensphere-console-data',
    'opensphere-console',
  ]), ['opensphere-console', 'opensphere-console-data']);
});
