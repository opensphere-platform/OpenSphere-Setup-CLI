import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReleaseDigest,
  calculateLegacyReleaseDigest,
  BASE_RUNTIME_COMPONENTS,
  COMPONENTS,
  LEGACY_RELEASE_TRUST,
  migrateLegacyReleaseLock,
  RELEASE_API_VERSION,
  RELEASE_PLATFORMS,
  RELEASE_TRUST,
  resolveSourceRevision,
  SOURCE,
  validateChannel,
  validateLock,
  verifyImageProvenance,
  verifyImageSbom,
  verifyReleaseProvenance,
  resolveChannel,
  requiredPlatformDescriptors
} from '../src/release.mjs';

const REVISION = '1'.repeat(40);
const DIGEST = `sha256:${'a'.repeat(64)}`;

function validLock(channel = 'edge') {
  const components = Object.fromEntries(Object.entries(COMPONENTS).map(([name, repository]) => [
    name,
    {
      repository,
      image: `ghcr.io/opensphere-platform/${repository}@${DIGEST}`,
      sourceRevision: REVISION
    }
  ]));
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel,
    releaseDigest: calculateReleaseDigest(channel, components),
    source: SOURCE,
    sourceRevision: REVISION,
    trust: RELEASE_TRUST,
    components
  };
}

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

test('base runtime excludes the optional OAA gateway package', () => {
  assert.deepEqual(BASE_RUNTIME_COMPONENTS, [
    'console', 'auth', 'backend', 'dupaController', 'kanidm', 'cbsPostgresql', 'cbsRustfs', 'cbsGitea'
  ]);
  assert.equal(BASE_RUNTIME_COMPONENTS.includes('oaaGateway'), false);
});

test('release baseline requires native manifests for every supported Linux platform', () => {
  assert.deepEqual(RELEASE_PLATFORMS, ['linux/amd64', 'linux/arm64']);
  const index = {
    manifests: RELEASE_PLATFORMS.map((platform, index) => {
      const [os, architecture] = platform.split('/');
      return { digest: `sha256:${String(index + 1).repeat(64)}`, platform: { os, architecture } };
    })
  };
  assert.equal(requiredPlatformDescriptors(index, 'opensphere-console').length, 2);
  index.manifests.pop();
  assert.throws(() => requiredPlatformDescriptors(index, 'opensphere-console'), /missing required linux\/arm64 manifest/);
});

test('only governed release channels are accepted', () => {
  for (const channel of ['edge', 'candidate', 'stable']) assert.doesNotThrow(() => validateChannel(channel));
  assert.throws(() => validateChannel('latest'), /Unsupported channel/);
});

test('canonical digest-pinned release lock is accepted', () => {
  const lock = validLock();
  assert.equal(validateLock(lock), lock);
});

test('release lock rejects tag-only references', () => {
  const lock = validLock();
  lock.components.console.image = 'ghcr.io/opensphere-platform/opensphere-console:edge';
  assert.throws(() => validateLock(lock), /not digest-pinned/);
});

test('release lock rejects repository substitution', () => {
  const lock = validLock();
  lock.components.console.repository = 'other-console';
  assert.throws(() => validateLock(lock), /repository is not canonical/);
});

test('release lock rejects mixed source revisions', () => {
  const lock = validLock();
  lock.components.auth.sourceRevision = '2'.repeat(40);
  assert.throws(() => validateLock(lock), /source revision differs/);
});

test('release lock rejects a tampered release digest', () => {
  const lock = validLock();
  lock.releaseDigest = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => validateLock(lock), /digest does not match/);
});

test('release lock rejects an absent or substituted trust root', () => {
  const absent = validLock();
  delete absent.trust;
  assert.throws(() => validateLock(absent), /trust root is not canonical/);

  const substituted = validLock();
  substituted.trust = { ...RELEASE_TRUST, sourceRef: 'refs/heads/feature/untrusted' };
  assert.throws(() => validateLock(substituted), /trust root is not canonical/);
});

test('an installed v1 edge lock remains rollback-compatible but cannot promote', () => {
  const legacyTrusted = validLock('edge');
  legacyTrusted.trust = LEGACY_RELEASE_TRUST;
  legacyTrusted.releaseDigest = calculateReleaseDigest('edge', legacyTrusted.components, LEGACY_RELEASE_TRUST);
  assert.doesNotThrow(() => validateLock(legacyTrusted));

  legacyTrusted.channel = 'candidate';
  legacyTrusted.releaseDigest = calculateReleaseDigest('candidate', legacyTrusted.components, LEGACY_RELEASE_TRUST);
  assert.throws(() => validateLock(legacyTrusted), /require signed SBOM trust v2/);
});

test('a legacy lock receives the trust root only after its original digest is proven', () => {
  const legacy = validLock();
  delete legacy.trust;
  legacy.releaseDigest = calculateLegacyReleaseDigest(legacy.channel, legacy.components);

  const migrated = migrateLegacyReleaseLock(legacy);
  assert.equal(migrated.trust, RELEASE_TRUST);
  assert.equal(migrated.releaseDigest, calculateReleaseDigest(migrated.channel, migrated.components));
  assert.doesNotThrow(() => validateLock(migrated));
  assert.equal(Object.hasOwn(legacy, 'trust'), false);
});

test('a tampered legacy lock cannot be upgraded into the trusted format', () => {
  const legacy = validLock();
  delete legacy.trust;
  legacy.releaseDigest = `sha256:${'c'.repeat(64)}`;
  assert.throws(() => migrateLegacyReleaseLock(legacy), /Legacy release lock digest/);
});

test('image provenance verification binds GH attestation to the release workflow', () => {
  const image = `ghcr.io/opensphere-platform/opensphere-console@${DIGEST}`;
  const calls = [];
  assert.deepEqual(verifyImageProvenance(image, {
    execFile(command, args, options) {
      calls.push({ command, args, options });
    }
  }), { image, trust: RELEASE_TRUST });
  assert.deepEqual(calls, [{
    command: 'gh',
    args: [
      'attestation', 'verify', `oci://${image}`,
      '--bundle-from-oci',
      '--repo', 'opensphere-platform/OpenSphere-console',
      '--signer-workflow', 'opensphere-platform/OpenSphere-console/.github/workflows/publish-edge-images.yml',
      '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
      '--source-ref', 'refs/heads/main',
      '--deny-self-hosted-runners',
      '--predicate-type', 'https://slsa.dev/provenance/v1'
    ],
    options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  }]);
  assert.throws(() => verifyImageProvenance('ghcr.io/elsewhere/console:edge'), /governed digest-pinned image/);
});

test('image SBOM verification binds SPDX attestation to the release workflow', () => {
  const image = `ghcr.io/opensphere-platform/opensphere-console@${DIGEST}`;
  const calls = [];
  assert.deepEqual(verifyImageSbom(image, {
    execFile(command, args, options) {
      calls.push({ command, args, options });
    }
  }), { image, trust: RELEASE_TRUST });
  assert.deepEqual(calls[0].args.slice(-2), ['--predicate-type', 'https://spdx.dev/Document/v2.3']);
  assert.throws(() => verifyImageSbom('ghcr.io/elsewhere/console:edge'), /governed digest-pinned image/);
});

test('attestation verification retries only transient GitHub metadata failures', () => {
  const image = `ghcr.io/opensphere-platform/opensphere-console@${DIGEST}`;
  let calls = 0;
  const pauses = [];
  assert.doesNotThrow(() => verifyImageProvenance(image, {
    attempts: 3,
    baseDelayMs: 1,
    sleep(milliseconds) { pauses.push(milliseconds); },
    execFile() {
      calls += 1;
      if (calls < 3) {
        const error = new Error('metadata unavailable');
        error.stderr = 'HTTP 503: trust-metadata-api service unavailable';
        throw error;
      }
    }
  }));
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [1, 2]);

  assert.throws(() => verifyImageProvenance(image, {
    attempts: 3,
    sleep() { throw new Error('must not retry an invalid attestation'); },
    execFile() {
      const error = new Error('invalid attestation');
      error.stderr = 'no matching attestation found';
      throw error;
    }
  }), /Image provenance verification failed/);
});

test('release provenance verification requires every component image', async () => {
  const provenance = [];
  const sboms = [];
  const verified = await verifyReleaseProvenance(validLock(), {
    verifyImage(image) { provenance.push(image); },
    verifySbom(image) { sboms.push(image); }
  });
  assert.equal(provenance.length, Object.keys(COMPONENTS).length);
  assert.deepEqual(new Set(provenance), new Set(Object.values(validLock().components).map(({ image }) => image)));
  assert.deepEqual(new Set(sboms), new Set(provenance));
  assert.match(verified.provenanceVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(verified.sbomVerifiedAt, verified.provenanceVerifiedAt);
});

test('channel resolution verifies all nine attestations before returning a lock', async () => {
  const resolved = await resolveChannel('edge', {
    async resolveImageFn(repository) {
      return {
        image: `ghcr.io/opensphere-platform/${repository}@${DIGEST}`,
        sourceRevision: REVISION
      };
    },
    verifyImage(image) {
      assert.match(image, /@sha256:a{64}$/);
    },
    verifySbom(image) {
      assert.match(image, /@sha256:a{64}$/);
    }
  });
  assert.equal(resolved.trust, RELEASE_TRUST);
  assert.match(resolved.sbomVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotThrow(() => validateLock(resolved));
});

test('release lock rejects missing or additional components', () => {
  const missing = validLock();
  delete missing.components.cbsGitea;
  assert.throws(() => validateLock(missing), /component set is not canonical/);

  const extra = validLock();
  extra.components.unknown = extra.components.console;
  assert.throws(() => validateLock(extra), /component set is not canonical/);
});

test('channel resolution waits for a publish to become atomic without accepting the mixed revision', async () => {
  const names = Object.keys(COMPONENTS);
  let calls = 0;
  const delays = [];
  const lock = await resolveChannel('edge', {
    resolveImageFn: async (repository) => {
      const firstObservation = calls < names.length;
      const sourceRevision = firstObservation && calls === 0 ? '2'.repeat(40) : REVISION;
      calls += 1;
      return { image: `ghcr.io/opensphere-platform/${repository}@${DIGEST}`, sourceRevision };
    },
    verifyImage: async () => {},
    verifySbom: async () => {},
    atomicResolutionAttempts: 2,
    atomicResolutionRetryMs: 7,
    delay: (milliseconds) => delays.push(milliseconds)
  });
  assert.equal(lock.sourceRevision, REVISION);
  assert.deepEqual(delays, [7]);
  assert.equal(calls, names.length * 2);
});

test('channel resolution does not accept a persistently mixed publish window', async () => {
  let calls = 0;
  await assert.rejects(resolveChannel('edge', {
    resolveImageFn: async (repository) => {
      const sourceRevision = calls++ % 2 === 0 ? REVISION : '2'.repeat(40);
      return { image: `ghcr.io/opensphere-platform/${repository}@${DIGEST}`, sourceRevision };
    },
    verifyImage: async () => {},
    verifySbom: async () => {},
    atomicResolutionAttempts: 2,
    atomicResolutionRetryMs: 0,
    delay: () => {}
  }), /not atomic/);
});

test('a historical source-revision tag becomes a verified explicit rollback lock only when all images match', async () => {
  const calls = [];
  const resolved = await resolveSourceRevision(REVISION, {
    async resolveImageFn(repository, tag) {
      calls.push({ repository, tag });
      return { image: `ghcr.io/opensphere-platform/${repository}@${DIGEST}`, sourceRevision: REVISION };
    },
    verifyImage() {},
    verifySbom() {}
  });
  assert.equal(resolved.channel, 'edge');
  assert.equal(resolved.sourceRevision, REVISION);
  assert.equal(resolved.releaseDigest, calculateReleaseDigest('edge', resolved.components));
  assert.deepEqual(calls, Object.values(COMPONENTS).map((repository) => ({ repository, tag: `sha-${REVISION.slice(0, 7)}` })));
});

test('a historical source-revision resolver rejects a short-tag collision or mixed image set before attestation acceptance', async () => {
  let provenanceChecks = 0;
  await assert.rejects(
    resolveSourceRevision(REVISION, {
      async resolveImageFn(repository) {
        return {
          image: `ghcr.io/opensphere-platform/${repository}@${DIGEST}`,
          sourceRevision: repository === COMPONENTS.console ? REVISION : 'b'.repeat(40)
        };
      },
      verifyImage() { provenanceChecks += 1; },
      verifySbom() { provenanceChecks += 1; }
    }),
    /does not resolve to one exact governed release/
  );
  assert.equal(provenanceChecks, 0);
});
