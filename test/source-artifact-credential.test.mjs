import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchReleaseArtifact,
  preflightReleaseArtifacts
} from '../src/bootstrap.mjs';
import {
  SOURCE_ARTIFACT_RAW_ROOT,
  SOURCE_ARTIFACT_TOKEN_ENV,
  sourceArtifactRequest,
  takeSourceArtifactCredential
} from '../src/source-artifact-credential.mjs';

const REVISION = 'a'.repeat(40);
const PATH = 'apps/console-api/deploy.yaml';
const TOKEN = 'github_pat_' + 'b'.repeat(48);

test('source credential is removed from the environment and remains opaque', () => {
  const environment = { [SOURCE_ARTIFACT_TOKEN_ENV]: TOKEN };
  const credential = takeSourceArtifactCredential(environment);
  assert.equal(Object.hasOwn(environment, SOURCE_ARTIFACT_TOKEN_ENV), false);
  assert.deepEqual(credential, { type: 'github-contents-read/v1' });
  assert.doesNotMatch(JSON.stringify(credential), new RegExp(TOKEN));
});

test('authenticated request is bound to exact repository, revision, path and redirects', () => {
  const credential = takeSourceArtifactCredential({ [SOURCE_ARTIFACT_TOKEN_ENV]: TOKEN });
  const request = sourceArtifactRequest(REVISION, PATH, credential);
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://api.github.com');
  assert.equal(url.pathname, '/repos/opensphere-platform/OpenSphere-console/contents/' + PATH);
  assert.equal(url.searchParams.get('ref'), REVISION);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(request.options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(request.options.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('public request preserves immutable raw URL without credential headers', () => {
  const request = sourceArtifactRequest(REVISION, PATH);
  assert.equal(request.url, SOURCE_ARTIFACT_RAW_ROOT + '/' + REVISION + '/' + PATH);
  assert.deepEqual(request.options, { redirect: 'error' });
});

test('source credential and coordinates reject forged or ambiguous input', () => {
  assert.throws(
    () => sourceArtifactRequest(REVISION, PATH, Object.freeze({ type: 'github-contents-read/v1' })),
    /credential is not trusted/
  );
  for (const path of ['../deploy.yaml', 'apps//deploy.yaml', './deploy.yaml', '/deploy.yaml']) {
    assert.throws(() => sourceArtifactRequest(REVISION, path), /path is invalid/);
  }
  assert.throws(() => sourceArtifactRequest('main', PATH), /revision must be one full lowercase commit/);
  assert.throws(
    () => takeSourceArtifactCredential({ [SOURCE_ARTIFACT_TOKEN_ENV]: ' ' + TOKEN }),
    /must contain one bounded GitHub Contents read token/
  );
});

test('artifact fetch uses only opaque source credential and does not disclose it on failure', async () => {
  const credential = takeSourceArtifactCredential({ [SOURCE_ARTIFACT_TOKEN_ENV]: TOKEN });
  const observed = [];
  const body = await fetchReleaseArtifact(
    { sourceRevision: REVISION },
    PATH,
    {
      sourceArtifactCredential: credential,
      async fetchFn(url, options) {
        observed.push({ url, options });
        return { ok: true, status: 200, text: async () => 'manifest' };
      }
    }
  );
  assert.equal(body, 'manifest');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].options.headers.Authorization, 'Bearer ' + TOKEN);

  await assert.rejects(
    fetchReleaseArtifact(
      { sourceRevision: REVISION },
      PATH,
      {
        sourceArtifactCredential: credential,
        async fetchFn() {
          return { ok: false, status: 403, text: async () => '' };
        }
      }
    ),
    (error) => error.message.includes('HTTP 403') && !error.message.includes(TOKEN)
  );
  await assert.rejects(
    fetchReleaseArtifact(
      { sourceRevision: REVISION },
      PATH,
      { sourceArtifactCredential: Object.freeze({ username: 'ghcr', token: TOKEN }) }
    ),
    /credential is not trusted/
  );
});

test('optional artifact accepts only explicit 404', async () => {
  const missing = await fetchReleaseArtifact(
    { sourceRevision: REVISION },
    PATH,
    {
      optional404: true,
      async fetchFn() {
        return { ok: false, status: 404, text: async () => '' };
      }
    }
  );
  assert.equal(missing, null);
  await assert.rejects(
    fetchReleaseArtifact(
      { sourceRevision: REVISION },
      PATH,
      {
        optional404: true,
        async fetchFn() {
          return { ok: false, status: 401, text: async () => '' };
        }
      }
    ),
    /HTTP 401/
  );
});

test('artifact preflight passes source credential without serializing it into a lock', async () => {
  const credential = takeSourceArtifactCredential({ [SOURCE_ARTIFACT_TOKEN_ENV]: TOKEN });
  let received;
  const lock = { sourceRevision: REVISION, components: {}, auxiliaryArtifacts: {} };
  await preflightReleaseArtifacts(
    lock,
    {
      storageClass: 'hostpath',
      consoleUrl: 'https://localhost:8090',
      authEnvironment: 'development',
      sourceArtifactCredential: credential
    },
    {
      async createTemporaryDirectory() {
        return 'temporary-artifact-root';
      },
      async prepare(_lock, _root, _storageClass, _consoleUrl, _authEnvironment, options) {
        received = options.sourceArtifactCredential;
        return { foundation: { migration: null }, all: [] };
      },
      async removeDirectory() {}
    }
  );
  assert.equal(received, credential);
  assert.doesNotMatch(JSON.stringify(lock), new RegExp(TOKEN));
});
