import { readInstallationLock, existingManagedNamespaces, uninstallManagedInstallation } from '../src/bootstrap.mjs';
import { assertNoManagedClusterResiduals } from '../src/installation-residuals.mjs';
import { MANAGED_NAMESPACES } from '../src/installation-contract.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--inventory') {
  console.log(JSON.stringify(MANAGED_NAMESPACES));
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--context' || !args[1] || args[1].startsWith('-')) throw new Error('An explicit test context is required');
process.env.OPENSPHERE_KUBE_CONTEXT = args[1];
if (readInstallationLock()) {
  await uninstallManagedInstallation({onProgress: message => console.log(message)});
} else {
  const namespaces = existingManagedNamespaces();
  if (namespaces.length) throw new Error(`Unowned test namespaces remain: ${namespaces.join(', ')}`);
  assertNoManagedClusterResiduals();
}
