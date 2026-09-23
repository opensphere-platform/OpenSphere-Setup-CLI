import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const cleanup = readFileSync(new URL('../scripts/e2e-clean-install.ps1', import.meta.url), 'utf8');
const driver = readFileSync(new URL('../scripts/e2e-managed-cleanup.mjs', import.meta.url), 'utf8');
test('clean-install harness exercises production uninstall and canonical inventory', () => {
  assert.match(cleanup, /--inventory \| ConvertFrom-Json/);
  assert.match(driver, /MANAGED_NAMESPACES.*installation-contract.mjs/);
  assert.match(cleanup, /scripts\/e2e-managed-cleanup.mjs/);
  assert.match(driver, /await uninstallManagedInstallation/);
  assert.match(driver, /assertNoManagedClusterResiduals\(\)/);
  assert.match(cleanup, /Managed uninstall did not complete; refusing the next bootstrap/);
  assert.doesNotMatch(cleanup, /Invoke-Kubectl delete|FullClusterReset|\$Crds\s*=|\$AdmissionPolicies\s*=/);
});
test('clean-install harness checks other product namespace identities around production cleanup', () => {
  const capture = cleanup.indexOf('$otherProductNamespaces = Get-OtherProductNamespaceIdentity');
  const deletion = cleanup.indexOf("'scripts/e2e-managed-cleanup.mjs'", capture);
  const preservation = cleanup.indexOf('Assert-OtherProductNamespacesPreserved $otherProductNamespaces', deletion);
  assert.ok(capture >= 0 && deletion > capture && preservation > deletion);
  assert.match(cleanup, /metadata\.uid -ne \$entry\.uid/);
});
