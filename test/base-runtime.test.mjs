import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_MANIFESTS } from '../src/bootstrap.mjs';

test('base bootstrap manifests do not deploy an optional OAA subShell service', () => {
  const paths = BASE_MANIFESTS.map((manifest) => manifest.path);
  assert.equal(paths.includes('backend/backbone/console-services.yaml'), false);
  assert.equal(paths.some((path) => path.includes('opensphere-console-oaa-gateway')), false);
});
