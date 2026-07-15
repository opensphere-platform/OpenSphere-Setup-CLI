import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureShellServiceEndpoint,
  defaultConsoleUrl,
  normalizeConsoleUrl,
  oidcIssuer
} from '../src/console-url.mjs';

test('Console endpoint is an exact HTTPS origin shared by OIDC and CLI', () => {
  assert.equal(normalizeConsoleUrl('https://console.example.test/'), 'https://console.example.test');
  assert.equal(normalizeConsoleUrl('https://console.example.test:9443'), 'https://console.example.test:9443');
  assert.equal(
    oidcIssuer('https://console.example.test'),
    'https://console.example.test/oauth2/openid/opensphere-console'
  );
});

test('edge development has a zero-trust-prompt loopback default', () => {
  assert.equal(defaultConsoleUrl('edge', 'development'), 'http://localhost:8090');
  assert.equal(defaultConsoleUrl('edge', 'production'), 'https://localhost:8090');
  assert.equal(defaultConsoleUrl('stable', 'production'), 'https://localhost:8090');
  assert.equal(normalizeConsoleUrl('http://localhost:8090/'), 'http://localhost:8090');
  assert.equal(normalizeConsoleUrl('http://127.0.0.1:8090'), 'http://127.0.0.1:8090');
});

test('loopback HTTP selects nginx HTTP without weakening the external HTTPS listener', () => {
  const manifest = `apiVersion: v1
kind: Service
metadata:
  name: opensphere-console-ext
  namespace: opensphere-console
spec:
  ports:
    - name: https
      port: 8090
      targetPort: 8443
`;
  assert.match(configureShellServiceEndpoint(manifest, 'http://localhost:8090'), /name: http[\s\S]*targetPort: 8080/);
  assert.equal(configureShellServiceEndpoint(manifest, 'https://localhost:8090'), manifest);
});

test('Console endpoint rejects ambiguous or remote insecure browser origins', () => {
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
