import { assertKubectl, kubectl } from './process.mjs';
import { assertStorageProfile } from './storage-profile.mjs';

export const SUPPORTED_NODE_PLATFORMS = Object.freeze(new Set(['linux/amd64', 'linux/arm64']));
export const REQUIRED_ADMISSION_RESOURCES = Object.freeze([
  'validatingadmissionpolicies.admissionregistration.k8s.io',
  'validatingadmissionpolicybindings.admissionregistration.k8s.io'
]);

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
    ['create', 'validatingadmissionpolicies.admissionregistration.k8s.io'],
    ['create', 'validatingadmissionpolicybindings.admissionregistration.k8s.io'],
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

export function assertAdmissionPolicySupport(resources) {
  const observed = new Set(
    Array.isArray(resources)
      ? resources.map(String)
      : String(resources || '').split(/\s+/).filter(Boolean)
  );
  const missing = REQUIRED_ADMISSION_RESOURCES.filter((resource) => !observed.has(resource));
  if (missing.length) {
    throw new Error(`Kubernetes ValidatingAdmissionPolicy API is unavailable (${missing.join(', ')})`);
  }
  return [...REQUIRED_ADMISSION_RESOURCES];
}

function ensureAdmissionPolicySupport() {
  const resources = kubectl([
    'api-resources', '--api-group=admissionregistration.k8s.io', '-o', 'name'
  ], { capture: true });
  return assertAdmissionPolicySupport(resources);
}

function selectStorageClass(requested) {
  const classes = JSON.parse(kubectl(['get', 'storageclass', '-o', 'json'], { capture: true })).items;
  if (requested) {
    if (!classes.some((entry) => entry.metadata.name === requested)) {
      throw new Error(`StorageClass does not exist: ${requested}`);
    }
    return classes.find((entry) => entry.metadata.name === requested);
  }
  const defaults = classes.filter((entry) =>
    entry.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ||
    entry.metadata.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] === 'true'
  );
  if (defaults.length === 1) return defaults[0];
  if (defaults.length > 1) throw new Error('Multiple default StorageClasses exist; use --storage-class');
  if (classes.length === 1) return classes[0];
  throw new Error('No unambiguous StorageClass is available; use --storage-class');
}

export function assertSupportedNodePlatform(node) {
  const platform = `${node?.status?.nodeInfo?.operatingSystem}/${node?.status?.nodeInfo?.architecture}`;
  if (!SUPPORTED_NODE_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported node platform ${node?.metadata?.name}: ${platform}`);
  }
  return platform;
}

export function assertAvailabilityNodeCount(nodes, channel = 'edge') {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('Kubernetes cluster has no nodes');
  // Edge remains intentionally usable on a developer's one-node cluster.
  // Candidate/stable, however, ship PDBs and spread stateless control-plane
  // replicas. Accepting fewer than three Ready nodes would make the published
  // availability profile an assertion rather than an enforceable prerequisite.
  if (channel !== 'edge' && nodes.length < 3) {
    throw new Error(`${channel} requires at least 3 Ready Kubernetes nodes for the Console availability profile`);
  }
  return nodes.length;
}

export function preflight({ storageClass, channel = 'edge' } = {}) {
  const versions = assertKubectl();
  const serverVersion = versions.cluster.serverVersion.gitVersion;
  if (!atLeast(serverVersion, 1, 30)) {
    throw new Error(`Kubernetes ${serverVersion} is unsupported; OpenSphere requires v1.30 or newer`);
  }
  const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'], { capture: true })).items;
  assertAvailabilityNodeCount(nodes, channel);
  for (const node of nodes) {
    const ready = node.status.conditions?.find((condition) => condition.type === 'Ready');
    if (ready?.status !== 'True') throw new Error(`Kubernetes node is not Ready: ${node.metadata.name}`);
    assertSupportedNodePlatform(node);
  }
  const admissionResources = ensureAdmissionPolicySupport();
  ensurePermissions();
  return {
    versions,
    serverVersion,
    nodeCount: nodes.length,
    admissionResources,
    storageClass: assertStorageProfile(selectStorageClass(storageClass), channel).name
  };
}
