import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdmissionPolicySupport, assertAvailabilityNodeCount, assertSupportedNodePlatform, REQUIRED_ADMISSION_RESOURCES, SUPPORTED_NODE_PLATFORMS } from '../src/preflight.mjs';

function node(name, operatingSystem, architecture) {
  return { metadata: { name }, status: { nodeInfo: { operatingSystem, architecture } } };
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

test('candidate and stable promotion require enough Ready nodes for PDB and topology spread', () => {
  const nodes = [node('one', 'linux', 'amd64'), node('two', 'linux', 'amd64'), node('three', 'linux', 'amd64')];
  assert.equal(assertAvailabilityNodeCount(nodes, 'candidate'), 3);
  assert.equal(assertAvailabilityNodeCount(nodes, 'stable'), 3);
  assert.equal(assertAvailabilityNodeCount(nodes.slice(0, 1), 'edge'), 1);
  assert.throws(() => assertAvailabilityNodeCount(nodes.slice(0, 2), 'candidate'), /at least 3 Ready Kubernetes nodes/);
  assert.throws(() => assertAvailabilityNodeCount([], 'stable'), /cluster has no nodes/);
});

test('bootstrap fails before mutation if native ValidatingAdmissionPolicy support is unavailable', () => {
  assert.deepEqual(assertAdmissionPolicySupport(REQUIRED_ADMISSION_RESOURCES), REQUIRED_ADMISSION_RESOURCES);
  assert.throws(
    () => assertAdmissionPolicySupport(['validatingadmissionpolicies.admissionregistration.k8s.io']),
    /ValidatingAdmissionPolicy API is unavailable.*validatingadmissionpolicybindings/
  );
});
