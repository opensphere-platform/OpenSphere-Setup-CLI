import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConsoleUrl, oidcIssuer } from '../src/console-url.mjs';

test('Console endpoint is an exact HTTPS origin shared by OIDC and CLI', () => {
  assert.equal(normalizeConsoleUrl('https://console.example.test/'), 'https://console.example.test');
  assert.equal(normalizeConsoleUrl('https://console.example.test:9443'), 'https://console.example.test:9443');
  assert.equal(
    oidcIssuer('https://console.example.test'),
    'https://console.example.test/oauth2/openid/opensphere-console'
  );
});

test('Console endpoint rejects ambiguous browser origins', () => {
  for (const value of [
    'http://console.example.test',
    'https://user:secret@console.example.test',
    'https://console.example.test/manage',
    'https://console.example.test/?debug=1',
    'not-a-url'
  ]) {
    assert.throws(() => normalizeConsoleUrl(value), /--console/);
  }
});
