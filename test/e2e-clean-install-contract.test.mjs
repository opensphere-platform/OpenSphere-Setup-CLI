import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cleanup = readFileSync(new URL('../scripts/e2e-clean-install.ps1', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function powershellArray(name) {
  const match = cleanup.match(new RegExp('\\$' + name + '\\s*=\\s*@\\(([\\s\\S]*?)\\)'));
  assert.ok(match, `missing PowerShell array: ${name}`);
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

test('edge E2E cleanup owns exactly the five Setup bootstrap namespaces', () => {
  assert.deepEqual(powershellArray('Namespaces'), [
    'opensphere-console-data',
    'opensphere-console-change',
    'opensphere-monitoring',
    'opensphere-console',
    'opensphere-system'
  ]);
  for (const foreignNamespace of [
    'opensphere-developer',
    'opensphere-www',
    'opensphere-foundation',
    'opensphere-osaa-credentials',
    'opensphere-console-recovery'
  ]) {
    assert.equal(powershellArray('Namespaces').includes(foreignNamespace), false);
  }
  assert.doesNotMatch(pkg.scripts['test:e2e:edge'], /FullClusterReset/u);
  assert.doesNotMatch(cleanup, /FullClusterReset/u);
  assert.doesNotMatch(cleanup, /delete\s+namespace[^\r\n]*(?:opensphere-\*|--all)/iu);
});

test('edge E2E cleanup owns the exact target cluster-scoped set', () => {
  assert.deepEqual(powershellArray('Crds'), [
    'uipluginpackages.plugins.opensphere.io',
    'uipluginregistrations.plugins.opensphere.io'
  ]);
  assert.deepEqual(powershellArray('ClusterRoles'), ['opensphere-registry']);
  assert.deepEqual(powershellArray('ClusterRoleBindings'), ['opensphere-registry']);
  const policies = [
    'opensphere-console-manual-ui-contract',
    'opensphere-console-image-integrity-workload',
    'opensphere-console-image-integrity-cronjob'
  ];
  assert.deepEqual(powershellArray('AdmissionPolicies'), policies);
  assert.deepEqual(powershellArray('AdmissionPolicyBindings'), policies);

  for (const invocation of [
    'Invoke-Kubectl delete namespace @Namespaces',
    'Invoke-Kubectl delete customresourcedefinition @Crds',
    'Invoke-Kubectl delete clusterrole @ClusterRoles',
    'Invoke-Kubectl delete clusterrolebinding @ClusterRoleBindings',
    'Invoke-Kubectl delete validatingadmissionpolicybinding @AdmissionPolicyBindings',
    'Invoke-Kubectl delete validatingadmissionpolicy @AdmissionPolicies'
  ]) assert.match(cleanup, new RegExp(escapeRegex(invocation)));

  assert.doesNotMatch(cleanup, /&\s*kubectl[^\r\n]*\sdelete\s/iu);

  const namespaceWait = cleanup.indexOf('if ($remaining.Count) { throw "Namespaces did not terminate');
  const instanceGuard = cleanup.indexOf('Assert-NoCustomResourceInstances', namespaceWait);
  const crdDeletion = cleanup.indexOf('Invoke-Kubectl delete customresourcedefinition @Crds');
  assert.ok(namespaceWait >= 0 && instanceGuard > namespaceWait && crdDeletion > instanceGuard);
  assert.match(cleanup, /get \$crd --all-namespaces -o json/u);
  assert.match(cleanup, /Refusing to delete shared CRD \$\{crd\}; cluster-wide instances remain/u);
});

test('edge E2E cleanup preserves every other OpenSphere namespace identity', () => {
  const capture = cleanup.indexOf('$otherProductNamespaces = Get-OtherProductNamespaceIdentity');
  const deletion = cleanup.indexOf('Invoke-Kubectl delete namespace @Namespaces');
  const preservation = cleanup.indexOf('Assert-OtherProductNamespacesPreserved $otherProductNamespaces');
  assert.ok(capture >= 0 && deletion > capture && preservation > deletion);
  assert.match(cleanup, /\[string\]\$_.metadata.name -like 'opensphere-\*'/u);
  assert.match(cleanup, /\[string\]\$_.metadata.name -notin \$Namespaces/u);
  assert.match(cleanup, /\$null -eq \$objects\.items/u);
  assert.match(cleanup, /\$null -eq \$pvs\.items/u);
  assert.match(cleanup, /metadata\.uid -ne \$entry\.uid/u);
});
