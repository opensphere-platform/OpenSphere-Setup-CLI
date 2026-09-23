import { kubectl } from './process.mjs';
import { MANAGED_CLUSTER_SCOPED_RESOURCES } from './installation-contract.mjs';

// Only these governed Foundation/catalog definitions are cluster scoped.
export const CLUSTER_SCOPED_MANAGED_CRDS = Object.freeze([
  'foundationmodels.foundation.opensphere.io',
  'foundationmoduledescriptors.foundation.opensphere.io',
  'addoncapabilities.catalog.opensphere.io',
  'addonofferings.catalog.opensphere.io',
  'addonplans.catalog.opensphere.io',
  'postgresruntimecatalogs.catalog.opensphere.io'
]);

export function listManagedClusterResiduals({ run = kubectl } = {}) {
  const resources = [
    ...MANAGED_CLUSTER_SCOPED_RESOURCES.admissionPolicies,
    ...MANAGED_CLUSTER_SCOPED_RESOURCES.clusterRbac,
    ...MANAGED_CLUSTER_SCOPED_RESOURCES.customResourceDefinitions.map(name => `customresourcedefinition/${name}`)
  ];
  const found = [];
  for (const resource of resources) {
    const value = run(['get', resource, '--ignore-not-found', '-o', 'name', '--request-timeout=15s'], { capture: true });
    if (value.trim()) found.push(resource);
  }
  return found;
}

export function assertNoManagedClusterResiduals(options) {
  const remaining = listManagedClusterResiduals(options);
  if (remaining.length) {
    throw new Error(`Console cluster-scoped resources remain: ${remaining.join(', ')}. Complete the managed uninstall before fresh bootstrap; no namespace or credential was written`);
  }
}

export function assertManagedAdmissionParameters({ run = kubectl } = {}) {
  for (const resource of MANAGED_CLUSTER_SCOPED_RESOURCES.admissionPolicies.filter(r => r.startsWith('validatingadmissionpolicybinding/'))) {
    const raw = run(['get', resource, '--ignore-not-found', '-o', 'json', '--request-timeout=15s'], { capture: true });
    if (!raw.trim()) continue;
    const binding = JSON.parse(raw);
    const ref = binding.spec?.paramRef;
    if (!ref) continue;
    // The sole parameterized binding in the canonical owned set.
    if (resource !== 'validatingadmissionpolicybinding/opensphere-ceph-preparation-job'
        || ref.name !== 'opensphere-ceph-preparation-policy' || ref.namespace !== 'opensphere-console'
        || ref.selector || ref.parameterNotFoundAction !== 'Deny') {
      throw new Error(`Unexpected managed admission parameter reference: ${resource}`);
    }
    const parameter = run(['-n', ref.namespace, 'get', 'configmap', ref.name, '--ignore-not-found', '-o', 'name', '--request-timeout=15s'], { capture: true });
    if (!parameter.trim()) {
      throw new Error(`Broken Console admission binding ${binding.metadata.name}: missing ConfigMap ${ref.namespace}/${ref.name}. Complete managed uninstall before reinstalling; Setup will not weaken admission enforcement`);
    }
  }
}
