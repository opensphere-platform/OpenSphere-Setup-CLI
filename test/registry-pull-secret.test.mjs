import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTRY_PULL_SECRET,
  dockerConfigJson,
  registryPullSecretManifest,
  releaseNeedsRegistryCredentials,
  secretHasGhcrCredential
} from '../src/registry-pull-secret.mjs';

test('public release gets a valid anonymous docker config without a secret value', () => {
  const manifest = registryPullSecretManifest('opensphere-console', null);
  assert.equal(manifest.metadata.name, REGISTRY_PULL_SECRET);
  assert.equal(manifest.type, 'kubernetes.io/dockerconfigjson');
  assert.deepEqual(JSON.parse(Buffer.from(manifest.data['.dockerconfigjson'], 'base64').toString('utf8')), { auths: {} });
  assert.equal(secretHasGhcrCredential(manifest), false);
});

test('private release credential is represented only in Secret data and is recognized', () => {
  const credentials = { username: 'opensphere-platform', token: 'read-only-token' };
  const manifest = registryPullSecretManifest('opensphere-console-data', credentials);
  assert.equal(secretHasGhcrCredential(manifest), true);
  assert.doesNotMatch(JSON.stringify(manifest.metadata), /read-only-token/);
  const config = JSON.parse(dockerConfigJson(credentials));
  assert.equal(config.auths['ghcr.io'].username, credentials.username);
  assert.equal(config.auths['ghcr.io'].password, credentials.token);
});

test('release credential requirement is derived from component evidence', () => {
  assert.equal(releaseNeedsRegistryCredentials({ components: { console: { registryCredentialsRequired: false } } }), false);
  assert.equal(releaseNeedsRegistryCredentials({ components: {
    console: { registryCredentialsRequired: false },
    control: { registryCredentialsRequired: true }
  } }), true);
});
