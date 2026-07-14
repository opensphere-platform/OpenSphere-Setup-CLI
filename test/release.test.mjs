import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReleaseDigest,
  calculateLegacyReleaseDigest,
  COMPONENTS,
  LEGACY_RELEASE_TRUST,
  migrateLegacyReleaseLock,
  RELEASE_API_VERSION,
  RELEASE_TRUST,
  SOURCE,
  validateChannel,
  validateLock,
  verifyImageProvenance,
  verifyImageSbom,
  verifyReleaseProvenance,
  resolveChannel
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
