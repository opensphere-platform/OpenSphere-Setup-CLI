import { assertKubectl, kubectl } from './process.mjs';
import { assertStorageProfile } from './storage-profile.mjs';
import { BASELINE_OBSERVABILITY_REQUIREMENT } from './installation-contract.mjs';

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


const MONITORING_APPLY_RESOURCES = Object.freeze([
  'serviceaccounts',
  'roles.rbac.authorization.k8s.io',
  'rolebindings.rbac.authorization.k8s.io',
  'configmaps',
  'secrets',
  'services',
  'persistentvolumeclaims',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'networkpolicies.networking.k8s.io'
]);

export const REQUIRED_KUBERNETES_PERMISSIONS = Object.freeze([
  ['create', 'namespaces'],
  ['create', 'customresourcedefinitions.apiextensions.k8s.io'],
  ['create', 'clusterroles.rbac.authorization.k8s.io'],
  ['create', 'clusterrolebindings.rbac.authorization.k8s.io'],
  ['create', 'validatingadmissionpolicies.admissionregistration.k8s.io'],
  ['create', 'validatingadmissionpolicybindings.admissionregistration.k8s.io'],
  ['create', 'deployments.apps', '--namespace', 'opensphere-console'],
  ['create', 'statefulsets.apps', '--namespace', 'opensphere-console'],
  ['create', 'secrets', '--namespace', 'opensphere-console'],
  ['patch', 'secrets', '--namespace', 'opensphere-console'],
  ['update', 'secrets', '--namespace', 'opensphere-console'],
  ['create', 'persistentvolumeclaims', '--namespace', 'opensphere-console'],
  ['patch', 'deployments.apps', '--namespace', 'opensphere-console'],
  ['get', 'deployments.apps', '--namespace', 'opensphere-console'],
  ...MONITORING_APPLY_RESOURCES.flatMap((resource) => [
    ['create', resource, '--namespace', 'opensphere-monitoring'],
    ['patch', resource, '--namespace', 'opensphere-monitoring'],
    ['update', resource, '--namespace', 'opensphere-monitoring']
  ]),
  ['delete', 'jobs.batch', '--namespace', 'opensphere-monitoring'],
  ['delete', 'services', '--namespace', 'opensphere-monitoring'],
  ['get', 'secrets', '--namespace', 'opensphere-monitoring'],
  ['get', 'configmaps', '--namespace', 'opensphere-monitoring'],
  ['get', 'services', '--namespace', 'opensphere-monitoring'],
  ['get', 'statefulsets.apps', '--namespace', 'opensphere-monitoring'],
  ['get', 'daemonsets.apps', '--namespace', 'opensphere-monitoring'],
  ['get', 'jobs.batch', '--namespace', 'opensphere-monitoring'],
  ['get', 'ingresses.networking.k8s.io', '--namespace', 'opensphere-monitoring'],
  ['list', 'ingresses.networking.k8s.io', '--namespace', 'opensphere-monitoring']
].map((check) => Object.freeze(check)));

function ensurePermissions() {
  for (const check of REQUIRED_KUBERNETES_PERMISSIONS) {
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

function readyCondition(node) {
  return node?.status?.conditions?.find((condition) => condition.type === 'Ready');
}

export function summarizeNodeHealth(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('Kubernetes cluster has no nodes');
  }
  const readyNodes = [];
  const degradedNodes = [];
  for (const node of nodes) {
    const condition = readyCondition(node);
    const schedulable = node?.spec?.unschedulable !== true;
    if (condition?.status === 'True' && schedulable) {
      readyNodes.push(node);
      continue;
    }
    degradedNodes.push(Object.freeze({
      name: String(node?.metadata?.name ?? 'unknown'),
      ready: condition?.status === 'True',
      schedulable,
      reason: String(condition?.reason ?? (schedulable ? 'ReadyUnknown' : 'Unschedulable')),
      message: String(condition?.message ?? '')
    }));
  }
  const platforms = [...new Set(readyNodes.map(assertSupportedNodePlatform))].sort();
  return Object.freeze({
    totalCount: nodes.length,
    readyCount: readyNodes.length,
    readyNodes: Object.freeze(readyNodes),
    degradedNodes: Object.freeze(degradedNodes),
    platforms: Object.freeze(platforms)
  });
}

export function nodePlatforms(nodes) {
  const health = summarizeNodeHealth(nodes);
  if (health.readyCount === 0) {
    throw new Error(`Kubernetes cluster has no Ready schedulable nodes; degraded: ${health.degradedNodes.map(({ name }) => name).join(', ')}`);
  }
  return [...health.platforms];
}

export function readNodePlatforms() {
  const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'], { capture: true })).items;
  return nodePlatforms(nodes);
}

export function assertAvailabilityNodeCount(nodes, channel = 'edge') {
  const health = summarizeNodeHealth(nodes);
  const minimum = channel === 'edge' ? 1 : 3;
  if (health.readyCount < minimum) {
    throw new Error(`${channel} requires at least ${minimum} Ready schedulable Kubernetes node${minimum === 1 ? '' : 's'}; found ${health.readyCount}/${health.totalCount}`);
  }
  return health.readyCount;
}

export function baselineObservabilitySecurityProfile(channel = 'edge', labels = {}) {
  const enforce = String(labels?.['pod-security.kubernetes.io/enforce'] ?? 'cluster-default');
  if (['baseline', 'restricted'].includes(enforce)) {
    throw new Error(
      `opensphere-monitoring Pod Security enforce=${enforce} blocks the Beszel Agent root/read-only hostPath contract; `
      + 'the Kubernetes operator must provide a compatible dedicated namespace because Setup will not lower Pod Security'
    );
  }
  return Object.freeze({
    ...BASELINE_OBSERVABILITY_REQUIREMENT,
    hostAccess: BASELINE_OBSERVABILITY_REQUIREMENT.hostAccess,
    podSecurityEnforce: enforce,
    status: channel === 'edge'
      ? 'accepted-local-edge-requirement'
      : 'production-promotion-hold',
    setupRepairsHost: false,
    setupLowersPodSecurity: false
  });
}

function readBaselineObservabilitySecurity(channel) {
  const raw = kubectl([
    'get', 'namespace', 'opensphere-monitoring', '--ignore-not-found=true', '-o', 'json'
  ], { capture: true });
  const labels = String(raw).trim()
    ? JSON.parse(raw).metadata?.labels ?? {}
    : {};
  return baselineObservabilitySecurityProfile(channel, labels);
}

export function preflight({ storageClass, channel = 'edge' } = {}) {
  const versions = assertKubectl();
  const serverVersion = versions.cluster.serverVersion.gitVersion;
  if (!atLeast(serverVersion, 1, 30)) {
    throw new Error(`Kubernetes ${serverVersion} is unsupported; OpenSphere requires v1.30 or newer`);
  }
  const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'], { capture: true })).items;
  assertAvailabilityNodeCount(nodes, channel);
  const nodeHealth = summarizeNodeHealth(nodes);
  const platforms = [...nodeHealth.platforms];
  const admissionResources = ensureAdmissionPolicySupport();
  ensurePermissions();
  const baselineObservabilitySecurity = readBaselineObservabilitySecurity(channel);
  return {
    versions,
    serverVersion,
    nodeCount: nodeHealth.totalCount,
    readyNodeCount: nodeHealth.readyCount,
    degradedNodes: nodeHealth.degradedNodes,
    nodePlatforms: platforms,
    baselineObservabilitySecurity,
    admissionResources,
    storageClass: assertStorageProfile(selectStorageClass(storageClass), channel).name
  };
}
