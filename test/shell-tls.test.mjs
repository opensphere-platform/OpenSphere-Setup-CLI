import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTERNAL_SHELL_TLS_ANNOTATION,
  EXTERNAL_SHELL_TLS_PROFILE,
  assertReleaseShellTlsReference,
  inspectExternalShellTlsSecret,
  parseShellTlsSecretRef,
  shellTlsSecretData
} from '../src/shell-tls.mjs';

function tlsSecret(overrides = {}) {
  const values = {
    'tls.crt': '-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----',
    'tls.key': 'test-only-key',
    ...overrides
  };
  return {
    type: 'kubernetes.io/tls',
    metadata: { annotations: { [EXTERNAL_SHELL_TLS_ANNOTATION]: EXTERNAL_SHELL_TLS_PROFILE } },
    data: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))
  };
}

function certificateFactory(value) {
  if (value.includes('leaf')) {
    return {
      ca: false,
      subject: 'CN=console.example.test',
      issuer: 'CN=Example Issuer',
      validFrom: 'Jul 01 00:00:00 2026 GMT',
      validTo: 'Jul 01 00:00:00 2027 GMT',
      checkHost: (hostname) => hostname === 'console.example.test',
      checkPrivateKey: () => true,
      verify: () => true
    };
  }
  return { ca: true, publicKey: {}, verify: () => true };
}

const inspectionOptions = {
  now: Date.parse('2026-08-01T00:00:00Z'),
  certificateFactory,
  privateKeyFactory: () => ({})
};

test('promoted channels require a namespace-scoped external shell TLS source', () => {
  assert.deepEqual(parseShellTlsSecretRef('platform-secrets/console-public-tls'), { namespace: 'platform-secrets', name: 'console-public-tls' });
  assert.throws(() => parseShellTlsSecretRef('console-public-tls'), /namespace\/name/);
  assert.doesNotThrow(() => assertReleaseShellTlsReference('edge'));
  assert.throws(() => assertReleaseShellTlsReference('candidate'), /requires --shell-tls-secret/);
  assert.throws(() => assertReleaseShellTlsReference('stable'), /requires --shell-tls-secret/);
});

test('external shell TLS requires an annotated valid chain for the Console origin', () => {
  const inspected = inspectExternalShellTlsSecret(tlsSecret(), 'https://console.example.test', inspectionOptions);
  assert.equal(inspected.hostname, 'console.example.test');
  assert.equal(inspected.certificateCount, 2);
  assert.deepEqual(Object.keys(shellTlsSecretData(tlsSecret())).sort(), ['tls.crt', 'tls.key']);
});

test('external shell TLS refuses an unannotated, mismatched, or expired source', () => {
  const unannotated = tlsSecret();
  delete unannotated.metadata.annotations[EXTERNAL_SHELL_TLS_ANNOTATION];
  assert.throws(() => inspectExternalShellTlsSecret(unannotated, 'https://console.example.test', inspectionOptions), /shell-tls-profile/);
  assert.throws(() => inspectExternalShellTlsSecret(tlsSecret(), 'https://wrong.example.test', inspectionOptions), /does not cover/);
  assert.throws(() => inspectExternalShellTlsSecret(tlsSecret(), 'https://console.example.test', { ...inspectionOptions, now: Date.parse('2028-06-20T00:00:00Z') }), /at least 30 days/);
});
