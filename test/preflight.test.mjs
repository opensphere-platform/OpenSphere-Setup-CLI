import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSupportedNodePlatform, SUPPORTED_NODE_PLATFORMS } from '../src/preflight.mjs';

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
