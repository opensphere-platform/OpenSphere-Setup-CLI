import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE_MANIFESTS } from '../src/bootstrap.mjs';

test('base bootstrap manifests do not deploy an optional OAA subShell service', () => {
  const paths = BASE_MANIFESTS.map((manifest) => manifest.path);
  assert.equal(paths.includes('backend/backbone/console-services.yaml'), false);
  assert.equal(paths.some((path) => path.includes('opensphere-console-oaa-gateway')), false);
});

test('upgrade materialization uses the canonical base manifest set', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function materializeRelease[\s\S]*?BASE_MANIFESTS\.map/);
  assert.doesNotMatch(source, /\bMANIFESTS\.map/);
});
