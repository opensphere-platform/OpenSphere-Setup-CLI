import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAdmissionPolicySupport,
  assertAvailabilityNodeCount,
  baselineObservabilitySecurityProfile,
  assertSupportedNodePlatform,
  nodePlatforms,
  summarizeNodeHealth,
  REQUIRED_ADMISSION_RESOURCES,
  REQUIRED_KUBERNETES_PERMISSIONS,
  SUPPORTED_NODE_PLATFORMS
} from '../src/preflight.mjs';

function node(name, operatingSystem, architecture, ready = 'True') {
  return {
    metadata: { name },
    status: {
      nodeInfo: { operatingSystem, architecture },
      conditions: [{ type: 'Ready', status: ready }]
    }
  };
}

test('Setup supports the two published Linux image architectures', () => {
  assert.deepEqual([...SUPPORTED_NODE_PLATFORMS].sort(), ['linux/amd64', 'linux/arm64']);
  assert.equal(assertSupportedNodePlatform(node('amd', 'linux', 'amd64')), 'linux/amd64');
  assert.equal(assertSupportedNodePlatform(node('arm', 'linux', 'arm64')), 'linux/arm64');
});

test('Setup rejects unsupported node platforms before bootstrap', () => {
  assert.throws(() => assertSupportedNodePlatform(node('windows', 'windows', 'amd64')), /Unsupported node platform windows: windows\/amd64/);
  assert.throws(() => assertSupportedNodePlatform(node('ppc', 'linux', 'ppc64le')), /Unsupported node platform ppc: linux\/ppc64le/);
});

test('edge image platform requirements are derived from Ready cluster nodes', () => {
  assert.deepEqual(nodePlatforms([
    node('amd-1', 'linux', 'amd64'),
    node('amd-2', 'linux', 'amd64')
  ]), ['linux/amd64']);
  assert.deepEqual(nodePlatforms([
    node('arm', 'linux', 'arm64'),
    node('amd', 'linux', 'amd64')
  ]), ['linux/amd64', 'linux/arm64']);
  const mixed = [
    node('amd-ready', 'linux', 'amd64'),
    node('desktop-worker', 'linux', 'amd64', 'False')
  ];
  assert.deepEqual(nodePlatforms(mixed), ['linux/amd64']);
  const health = summarizeNodeHealth(mixed);
  assert.equal(health.readyCount, 1);
  assert.equal(health.totalCount, 2);
  assert.deepEqual(health.degradedNodes.map(({ name }) => name), ['desktop-worker']);
  assert.throws(
    () => nodePlatforms([node('not-ready', 'linux', 'amd64', 'False')]),
    /no Ready schedulable nodes/
  );
});

test('candidate and stable promotion require enough Ready nodes for PDB and topology spread', () => {
  const nodes = [node('one', 'linux', 'amd64'), node('two', 'linux', 'amd64'), node('three', 'linux', 'amd64')];
  assert.equal(assertAvailabilityNodeCount(nodes, 'candidate'), 3);
  assert.equal(assertAvailabilityNodeCount(nodes, 'stable'), 3);
  assert.equal(assertAvailabilityNodeCount(nodes.slice(0, 1), 'edge'), 1);
  assert.equal(assertAvailabilityNodeCount([...nodes, node('degraded', 'linux', 'amd64', 'False')], 'candidate'), 3);
  assert.throws(() => assertAvailabilityNodeCount(nodes.slice(0, 2), 'candidate'), /at least 3 Ready schedulable Kubernetes nodes/);
  assert.throws(() => assertAvailabilityNodeCount([], 'stable'), /cluster has no nodes/);
});

test('bootstrap fails before mutation if native ValidatingAdmissionPolicy support is unavailable', () => {
  assert.deepEqual(assertAdmissionPolicySupport(REQUIRED_ADMISSION_RESOURCES), REQUIRED_ADMISSION_RESOURCES);
  assert.throws(
    () => assertAdmissionPolicySupport(['validatingadmissionpolicies.admissionregistration.k8s.io']),
    /ValidatingAdmissionPolicy API is unavailable.*validatingadmissionpolicybindings/
  );
});


test('monitoring preflight permissions match every Beszel installer mutation and observation', () => {
  const resources = [
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
  ];
  const expected = [
    ...resources.flatMap((resource) => [
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
  ];
  assert.deepEqual(
    REQUIRED_KUBERNETES_PERMISSIONS.filter((check) => check.includes('opensphere-monitoring')),
    expected
  );
});

test('Setup records the Beszel host contract and never lowers Pod Security', () => {
  const edge = baselineObservabilitySecurityProfile('edge', {});
  assert.equal(edge.podSecurityEnforce, 'cluster-default');
  assert.equal(edge.status, 'accepted-local-edge-requirement');
  assert.equal(edge.runAsUser, 0);
  assert.equal(edge.setupRepairsHost, false);
  assert.equal(edge.setupLowersPodSecurity, false);
  assert.deepEqual([...edge.hostAccess], [
    '/proc:ro', '/sys:ro', '/etc:ro', '/:ro', '/var/lib/opensphere/beszel-agent:rw'
  ]);

  const candidate = baselineObservabilitySecurityProfile('candidate', {});
  assert.equal(candidate.status, 'production-promotion-hold');
  for (const enforce of ['baseline', 'restricted']) {
    assert.throws(
      () => baselineObservabilitySecurityProfile('edge', {
        'pod-security.kubernetes.io/enforce': enforce
      }),
      /operator must provide a compatible dedicated namespace.*Setup will not lower Pod Security/
    );
  }
});
