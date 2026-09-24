// Console decision 13: a localhost edge verification install resolves its release
// from the immutable per-revision tag, never from a moved :edge tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChannel, LOCAL_EDGE_ANCHOR_TAG } from '../src/release.mjs';

const TAG = 'local-0123456789ab';

test('an explicit anchor is the immutable tag the Console anchor is read from', async () => {
  const calls = [];
  const resolveImageFn = async (repository, reference) => {
    calls.push([repository, reference]);
    throw new Error('stop after the anchor read');
  };
  await assert.rejects(resolveChannel('edge', { anchorReference: TAG, resolveImageFn, requiredPlatforms: ['linux/amd64'] }), /stop after the anchor read/);
  assert.deepEqual(calls, [['opensphere-console', TAG]]);
  assert.ok(LOCAL_EDGE_ANCHOR_TAG.test(TAG));
});

test('an explicit anchor is refused for another channel, another tag shape or a non-localhost build', async () => {
  const resolveImageFn = async () => ({ image: 'ghcr.io/opensphere-platform/opensphere-console@sha256:' + 'a'.repeat(64), labels: {} });
  for (const [channel, anchorReference] of [['stable', TAG], ['edge', 'edge-2'], ['edge', 'local-XYZ'], ['candidate', TAG]]) {
    await assert.rejects(resolveChannel(channel, { anchorReference, resolveImageFn, requiredPlatforms: ['linux/amd64'] }), /explicit anchor/);
  }
  await assert.rejects(resolveChannel('edge', { anchorReference: TAG, resolveImageFn, requiredPlatforms: ['linux/amd64'] }), /localhost edge build/);
});
