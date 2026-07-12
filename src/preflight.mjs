import { assertKubectl, kubectl } from './process.mjs';

function versionTuple(version) {
  const match = String(version).match(/^v?(\d+)\.(\d+)/);
  if (!match) throw new Error(`Unrecognized Kubernetes version: ${version}`);
  return [Number(match[1]), Number(match[2])];
}

function atLeast(version, minimumMajor, minimumMinor) {
  const [major, minor] = versionTuple(version);
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}

function ensurePermissions() {
  const checks = [
    ['create', 'namespaces'],
    ['create', 'customresourcedefinitions.apiextensions.k8s.io'],
    ['create', 'clusterroles.rbac.authorization.k8s.io'],
    ['create', 'clusterrolebindings.rbac.authorization.k8s.io'],
    ['create', 'deployments.apps', '--namespace', 'opensphere-console'],
    ['create', 'statefulsets.apps', '--namespace', 'opensphere-console'],
    ['create', 'secrets', '--namespace', 'opensphere-console'],
    ['create', 'persistentvolumeclaims', '--namespace', 'opensphere-console']
  ];
  for (const check of checks) {
    const allowed = kubectl(['auth', 'can-i', ...check], { capture: true });
    if (allowed !== 'yes') throw new Error(`Kubernetes permission denied: ${check.join(' ')}`);
  }
}

function selectStorageClass(requested) {
  const classes = JSON.parse(kubectl(['get', 'storageclass', '-o', 'json'], { capture: true })).items;
  if (requested) {
    if (!classes.some((entry) => entry.metadata.name === requested)) {
      throw new Error(`StorageClass does not exist: ${requested}`);
    }
    return requested;
  }
  const defaults = classes.filter((entry) =>
    entry.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ||
    entry.metadata.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] === 'true'
  );
  if (defaults.length === 1) return defaults[0].metadata.name;
  if (defaults.length > 1) throw new Error('Multiple default StorageClasses exist; use --storage-class');
  if (classes.length === 1) return classes[0].metadata.name;
  throw new Error('No unambiguous StorageClass is available; use --storage-class');
}

export function preflight({ storageClass } = {}) {
  const versions = assertKubectl();
  const serverVersion = versions.cluster.serverVersion.gitVersion;
  if (!atLeast(serverVersion, 1, 30)) {
    throw new Error(`Kubernetes ${serverVersion} is unsupported; OpenSphere requires v1.30 or newer`);
  }
  const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'], { capture: true })).items;
  if (!nodes.length) throw new Error('Kubernetes cluster has no nodes');
  for (const node of nodes) {
    const ready = node.status.conditions?.find((condition) => condition.type === 'Ready');
    if (ready?.status !== 'True') throw new Error(`Kubernetes node is not Ready: ${node.metadata.name}`);
    if (node.status.nodeInfo?.architecture !== 'amd64' || node.status.nodeInfo?.operatingSystem !== 'linux') {
      throw new Error(`Unsupported node platform ${node.metadata.name}: ${node.status.nodeInfo?.operatingSystem}/${node.status.nodeInfo?.architecture}`);
    }
  }
  ensurePermissions();
  return {
    versions,
    serverVersion,
    nodeCount: nodes.length,
    storageClass: selectStorageClass(storageClass)
  };
}
