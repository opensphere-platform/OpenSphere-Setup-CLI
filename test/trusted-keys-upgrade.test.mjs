import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeTrustedKeySets } from '../src/bootstrap.mjs';

test('Console upgrade preserves a distinct host-local edge trust key', () => {
  const merged = mergeTrustedKeySets(
    {
      'opensphere-plugins-v5': 'release-spki',
    },
    {
      'opensphere-plugins-v5': 'stale-or-tampered-spki',
      'opensphere-edge-local-v1': 'docker-desktop-spki',
      'unapproved-host-key': 'must-not-survive',
    },
    { preserveEdgeLocal: true },
  );

  assert.deepEqual(merged, {
    'opensphere-plugins-v5': 'release-spki',
    'opensphere-edge-local-v1': 'docker-desktop-spki',
  });
});

test('an empty development cluster receives only release trust keys', () => {
  assert.deepEqual(
    mergeTrustedKeySets({ 'opensphere-plugins-v5': 'release-spki' }, {}),
    { 'opensphere-plugins-v5': 'release-spki' },
  );
});

test('GA does not preserve the Docker Desktop-only edge trust identity', () => {
  assert.deepEqual(
    mergeTrustedKeySets(
      { 'opensphere-plugins-v5': 'release-spki' },
      { 'opensphere-edge-local-v1': 'docker-desktop-spki' },
    ),
    { 'opensphere-plugins-v5': 'release-spki' },
  );
});
