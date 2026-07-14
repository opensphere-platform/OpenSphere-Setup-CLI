import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAuthEnvironment } from '../src/auth-environment.mjs';

test('edge remains the explicit development default', () => {
  assert.equal(selectAuthEnvironment('edge'), 'development');
  assert.equal(selectAuthEnvironment('edge', 'production'), 'production');
});

test('promotion channels default to and require production MFA policy', () => {
  assert.equal(selectAuthEnvironment('candidate'), 'production');
  assert.equal(selectAuthEnvironment('stable'), 'production');
  assert.throws(() => selectAuthEnvironment('candidate', 'development'), /requires --auth-environment production/);
  assert.throws(() => selectAuthEnvironment('stable', 'invalid'), /Unsupported authentication environment/);
});
