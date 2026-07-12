import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS, RELEASE_API_VERSION, validateChannel, validateLock } from '../src/release.mjs';

test('canonical baseline contains the promised nine repositories', () => {
  assert.deepEqual(Object.values(COMPONENTS), [
    'opensphere-console',
    'opensphere-console-auth',
    'opensphere-console-backend',
    'opensphere-console-dupa-controller',
    'opensphere-console-oaa-gateway',
    'opensphere-console-kanidm',
    'opensphere-cbs-postgresql',
    'opensphere-cbs-rustfs',
    'opensphere-cbs-gitea'
  ]);
});

test('only governed release channels are accepted', () => {
  for (const channel of ['edge', 'candidate', 'stable']) assert.doesNotThrow(() => validateChannel(channel));
  assert.throws(() => validateChannel('latest'), /Unsupported channel/);
});

test('release lock rejects tag-only references', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const components = Object.fromEntries(Object.keys(COMPONENTS).map((name) => [
    name,
    { image: `ghcr.io/opensphere-platform/${COMPONENTS[name]}@${digest}` }
  ]));
  const valid = { apiVersion: RELEASE_API_VERSION, kind: 'OpenSphereReleaseLock', channel: 'edge', components };
  assert.equal(validateLock(valid), valid);
  valid.components.console.image = 'ghcr.io/opensphere-platform/opensphere-console:edge';
  assert.throws(() => validateLock(valid), /not digest-pinned/);
});
