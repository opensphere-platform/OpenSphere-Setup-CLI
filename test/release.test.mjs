import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReleaseDigest,
  calculateReleaseBomDigest,
  calculateLegacyReleaseDigest,
  BASE_RUNTIME_COMPONENTS,
  COMPONENTS,
  LEGACY_BASE_RUNTIME_COMPONENTS,
  LEGACY_RELEASE_TRUST,
  migrateLegacyReleaseLock,
  RELEASE_API_VERSION,
  RELEASE_BOM_PREDICATE,
  RELEASE_PLATFORMS,
  RELEASE_TRUST,
  resolveSourceRevision,
  releaseBomPointer,
  SOURCE,
  validateChannel,
  validateLock,
  verifyImageProvenance,
  verifyImageSbom,
  verifyReleaseProvenance,
  verifyReleaseBomAttestation,
  verifyReleaseLock,
  resolveImage,
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

function validBom(channel = 'edge', revision = REVISION, digest = DIGEST) {
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseBOM',
    channel,
    status: 'Active',
    source: SOURCE,
    sourceRevision: revision,
    supportedPlatforms: ['linux/amd64', 'linux/arm64'],
    components: Object.fromEntries(Object.entries(COMPONENTS).map(([name, repository]) => [
      name,
      {
        repository,
        image: `ghcr.io/opensphere-platform/${repository}@${digest}`,
        sourceRevision: revision
      }
    ]))
  };
}

function bomVerifier(bom = validBom()) {
  return async (subject) => ({ bom, digest: calculateReleaseBomDigest(bom), subject });
}

test('canonical baseline contains the complete Supabase/Gitea release repositories', () => {
  assert.deepEqual(Object.values(COMPONENTS), [
    'opensphere-console',
    'opensphere-console-backend',
    'opensphere-console-dupa-controller',
    'opensphere-console-oaa-gateway',
    'opensphere-oaa-governed-adapter',
    'opensphere-console-notification-dispatcher',
    'opensphere-console-gitea',
    'opensphere-console-supabase-postgres',
    'opensphere-console-supabase-auth',
    'opensphere-console-supabase-rest',
    'opensphere-console-supabase-storage',
    'opensphere-console-gitea-postgres',
    'opensphere-console-recovery'
  ]);
});

test('base runtime requires OAA Core as native Main Shell runtime', () => {
  assert.deepEqual(BASE_RUNTIME_COMPONENTS, [
    'console', 'backend', 'dupaController', 'oaaGateway', 'oaaGovernedAdapter',
    'notificationDispatcher', 'gitea', 'supabasePostgres', 'supabaseAuth',
    'supabaseRest', 'supabaseStorage', 'giteaPostgres', 'recovery'
  ]);
  assert.equal(BASE_RUNTIME_COMPONENTS.includes('oaaGateway'), true);
  assert.deepEqual(LEGACY_BASE_RUNTIME_COMPONENTS, BASE_RUNTIME_COMPONENTS.slice(0, -1));
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

function registryFixture({ privatePackage = false } = {}) {
  const calls = [];
  const platformDigests = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];
  const configDigests = [`sha256:${'3'.repeat(64)}`, `sha256:${'4'.repeat(64)}`];
  return {
    calls,
    async fetchImpl(url, options = {}) {
      const authorization = options.headers?.authorization ?? options.headers?.Authorization;
      calls.push({ url: String(url), authorization });
      if (String(url).includes('/token')) {
        if (privatePackage && !authorization) return new Response('', { status: 403 });
        return Response.json({ token: privatePackage ? 'private-pull-token' : 'anonymous-pull-token' });
      }
      if (String(url).endsWith('/manifests/edge')) {
        return new Response(JSON.stringify({ manifests: [
          { digest: platformDigests[0], platform: { os: 'linux', architecture: 'amd64' } },
          { digest: platformDigests[1], platform: { os: 'linux', architecture: 'arm64' } }
        ] }), { status: 200, headers: { 'docker-content-digest': DIGEST, 'content-type': 'application/json' } });
      }
      const platform = platformDigests.indexOf(String(url).split('/').at(-1));
      if (platform >= 0) return Response.json({ config: { digest: configDigests[platform] } });
      if (configDigests.some((digest) => String(url).endsWith(`/blobs/${digest}`))) {
        return Response.json({ config: { Labels: { 'io.opensphere.source-revision': REVISION } } });
      }
      return new Response('', { status: 404 });
    }
  };
}

test('public package resolution proves anonymous access and never sends a host credential', async () => {
  const fixture = registryFixture();
  const resolved = await resolveImage('opensphere-console', 'edge', {
    fetchImpl: fixture.fetchImpl,
    registryCredentials: { username: 'opensphere-platform', token: 'must-not-be-sent' }
  });
  assert.equal(resolved.registryCredentialsRequired, false);
  assert.equal(fixture.calls[0].authorization, undefined);
  assert.equal(fixture.calls.some(({ authorization }) => String(authorization).startsWith('Basic ')), false);
});

test('private package resolution falls back to the supplied read credential without placing it in release metadata', async () => {
  const fixture = registryFixture({ privatePackage: true });
  const resolved = await resolveImage('opensphere-console', 'edge', {
    fetchImpl: fixture.fetchImpl,
    registryCredentials: { username: 'opensphere-platform', token: 'read-packages-token' }
  });
  assert.equal(resolved.registryCredentialsRequired, true);
  assert.equal(fixture.calls[0].authorization, undefined);
  assert.match(fixture.calls[1].authorization, /^Basic /);
  assert.doesNotMatch(JSON.stringify(resolved), /read-packages-token/);
});

test('private package resolution fails closed when no read credential is available', async () => {
  const fixture = registryFixture({ privatePackage: true });
  const oldToken = process.env.GHCR_TOKEN;
  const oldUsername = process.env.GHCR_USERNAME;
  process.env.GHCR_TOKEN = '';
  process.env.GHCR_USERNAME = '';
  try {
    await assert.rejects(resolveImage('opensphere-console', 'edge', {
      fetchImpl: fixture.fetchImpl,
      registryCredentials: null
    }), /private; provide a read-only registry credential/);
  } finally {
    if (oldToken === undefined) delete process.env.GHCR_TOKEN; else process.env.GHCR_TOKEN = oldToken;
    if (oldUsername === undefined) delete process.env.GHCR_USERNAME; else process.env.GHCR_USERNAME = oldUsername;
  }
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
  lock.components.supabaseAuth.sourceRevision = '2'.repeat(40);
  assert.throws(() => validateLock(lock), /source revision differs/);
});

test('release lock accepts only a boolean registry credential requirement', () => {
  const lock = validLock();
  lock.components.console.registryCredentialsRequired = 'yes';
  lock.releaseDigest = calculateReleaseDigest(lock.channel, lock.components);
  assert.throws(() => validateLock(lock), /registry credential requirement is invalid/);
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

test('Release BOM attestation is verified against the governed workflow and immutable Console anchor', () => {
  const bom = validBom();
  const subject = bom.components.console.image;
  let invocation;
  const verified = verifyReleaseBomAttestation(subject, {
    execFile(command, args, options) {
      invocation = { command, args, options };
      return JSON.stringify([{ verificationResult: { statement: { predicate: bom } } }]);
    }
  });
  assert.equal(verified.digest, calculateReleaseBomDigest(bom));
  assert.equal(invocation.command, 'gh');
  assert.ok(invocation.args.includes(RELEASE_BOM_PREDICATE));
  assert.deepEqual(invocation.args.slice(-2), ['--format', 'json']);
});

test('a release lock is accepted only when its components and BOM digest match the verified signed BOM', async () => {
  const bom = validBom();
  const lock = validLock();
  lock.releaseBom = releaseBomPointer(bom);
  lock.releaseDigest = calculateReleaseDigest(lock.channel, lock.components, lock.trust, lock.releaseBom);
  await assert.doesNotReject(verifyReleaseLock(lock, {
    verifyBom: bomVerifier(bom),
    verifyImage() {},
    verifySbom() {}
  }));

  const tampered = structuredClone(lock);
  tampered.releaseBom.digest = `sha256:${'f'.repeat(64)}`;
  tampered.releaseDigest = calculateReleaseDigest(tampered.channel, tampered.components, tampered.trust, tampered.releaseBom);
  await assert.rejects(verifyReleaseLock(tampered, {
    verifyBom: bomVerifier(bom), verifyImage() {}, verifySbom() {}
  }), /BOM digest differs/);
});

test('an explicit private-package token is passed to gh only through its subprocess environment', () => {
  const image = `ghcr.io/opensphere-platform/opensphere-console@${DIGEST}`;
  let invocation;
  verifyImageProvenance(image, {
    authToken: 'private-read-token',
    execFile(command, args, options) { invocation = { command, args, options }; }
  });
  assert.equal(invocation.command, 'gh');
  assert.equal(invocation.options.env.GH_TOKEN, 'private-read-token');
  assert.equal(invocation.args.some((arg) => String(arg).includes('private-read-token')), false);
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
  const events = [];
  const verified = await verifyReleaseProvenance(validLock(), {
    verifyImage(image) { provenance.push(image); },
    verifySbom(image) { sboms.push(image); },
    onProgress(event) { events.push(event); }
  });
  assert.equal(provenance.length, Object.keys(COMPONENTS).length);
  assert.deepEqual(new Set(provenance), new Set(Object.values(validLock().components).map(({ image }) => image)));
  assert.deepEqual(new Set(sboms), new Set(provenance));
  assert.match(verified.provenanceVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(verified.sbomVerifiedAt, verified.provenanceVerifiedAt);
  assert.equal(events.filter(({ type }) => type === 'provenance-start').length, Object.keys(COMPONENTS).length);
  assert.equal(events.filter(({ type }) => type === 'provenance-complete').length, Object.keys(COMPONENTS).length);
  assert.equal(events.filter(({ type }) => type === 'sbom-start').length, Object.keys(COMPONENTS).length);
  assert.equal(events.filter(({ type }) => type === 'sbom-complete').length, Object.keys(COMPONENTS).length);
});

test('channel resolution verifies every Supabase/Gitea release attestation before returning a lock', async () => {
  const bom = validBom();
  const events = [];
  const resolved = await resolveChannel('edge', {
    async resolveImageFn(repository, reference) {
      assert.equal(repository, COMPONENTS.console);
      assert.equal(reference, 'edge');
      return {
        image: `ghcr.io/opensphere-platform/${repository}@${DIGEST}`,
        sourceRevision: REVISION,
        registryCredentialsRequired: false
      };
    },
    async inspectImageFn(repository, image) {
      return { image, sourceRevision: REVISION, registryCredentialsRequired: false };
    },
    verifyBom: bomVerifier(bom),
    verifyImage(image) {
      assert.match(image, /@sha256:a{64}$/);
    },
    verifySbom(image) {
      assert.match(image, /@sha256:a{64}$/);
    },
    onProgress(event) { events.push(event); }
  });
  assert.equal(resolved.trust, RELEASE_TRUST);
  assert.deepEqual(resolved.releaseBom, releaseBomPointer(bom));
  assert.match(resolved.sbomVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotThrow(() => validateLock(resolved));
  assert.equal(events[0].type, 'anchor-start');
  assert.equal(events.filter(({ type }) => type === 'component-complete').length, Object.keys(COMPONENTS).length);
  assert.equal(events.filter(({ type }) => type === 'sbom-complete').length, Object.keys(COMPONENTS).length);
});

test('release lock rejects missing or additional components', () => {
  const missing = validLock();
  delete missing.components.giteaPostgres;
  assert.throws(() => validateLock(missing), /component set is not canonical/);

  const extra = validLock();
  extra.components.unknown = extra.components.console;
  assert.throws(() => validateLock(extra), /component set is not canonical/);
});

test('pre-recovery component locks are accepted only as explicit installed rollback baselines', async () => {
  const bom = validBom();
  delete bom.components.recovery;
  const releaseBom = {
    predicateType: RELEASE_BOM_PREDICATE,
    subject: bom.components.console.image,
    digest: calculateReleaseBomDigest(bom)
  };
  const lock = {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: calculateReleaseDigest('edge', bom.components, RELEASE_TRUST, releaseBom),
    source: SOURCE,
    sourceRevision: REVISION,
    trust: RELEASE_TRUST,
    releaseBom,
    components: bom.components
  };

  assert.throws(() => validateLock(lock), /component set is not canonical/);
  assert.doesNotThrow(() => validateLock(lock, { allowLegacyComponentSet: true }));
  await assert.doesNotReject(verifyReleaseLock(lock, {
    verifyBom: bomVerifier(bom),
    verifyImage: async () => {},
    verifySbom: async () => {},
    allowLegacyComponentSet: true
  }));
});

test('channel resolution samples one mutable anchor and reads every other component by signed immutable digest', async () => {
  const bom = validBom();
  const tagCalls = [];
  const digestCalls = [];
  await resolveChannel('edge', {
    async resolveImageFn(repository, reference) {
      tagCalls.push({ repository, reference });
      return { image: bom.components.console.image, sourceRevision: REVISION, registryCredentialsRequired: false };
    },
    async inspectImageFn(repository, image) {
      digestCalls.push({ repository, image });
      return { image, sourceRevision: REVISION, registryCredentialsRequired: false };
    },
    verifyBom: bomVerifier(bom),
    verifyImage: async () => {},
    verifySbom: async () => {}
  });
  assert.deepEqual(tagCalls, [{ repository: COMPONENTS.console, reference: 'edge' }]);
  assert.deepEqual(digestCalls, Object.entries(COMPONENTS).slice(1).map(([name, repository]) => ({
    repository,
    image: bom.components[name].image
  })));
});

test('channel resolution rejects a registry component that differs from the signed BOM before provenance acceptance', async () => {
  const bom = validBom();
  let provenanceChecks = 0;
  await assert.rejects(resolveChannel('edge', {
    resolveImageFn: async () => ({ image: bom.components.console.image, sourceRevision: REVISION, registryCredentialsRequired: false }),
    inspectImageFn: async (repository, image) => ({
      image,
      sourceRevision: repository === COMPONENTS.supabaseAuth ? '2'.repeat(40) : REVISION,
      registryCredentialsRequired: false
    }),
    verifyBom: bomVerifier(bom),
    verifyImage: async () => { provenanceChecks += 1; },
    verifySbom: async () => { provenanceChecks += 1; }
  }), /differs from the signed Release BOM/);
  assert.equal(provenanceChecks, 0);
});

test('a historical source-revision tag becomes a verified explicit rollback lock only when all images match', async () => {
  const bom = validBom();
  const tagCalls = [];
  const digestCalls = [];
  const resolved = await resolveSourceRevision(REVISION, {
    async resolveImageFn(repository, tag) {
      tagCalls.push({ repository, tag });
      return { image: bom.components.console.image, sourceRevision: REVISION, registryCredentialsRequired: false };
    },
    async inspectImageFn(repository, image) {
      digestCalls.push({ repository, image });
      return { image, sourceRevision: REVISION, registryCredentialsRequired: false };
    },
    verifyBom: bomVerifier(bom),
    verifyImage() {},
    verifySbom() {}
  });
  assert.equal(resolved.channel, 'edge');
  assert.equal(resolved.sourceRevision, REVISION);
  assert.equal(resolved.releaseDigest, calculateReleaseDigest('edge', resolved.components, RELEASE_TRUST, resolved.releaseBom));
  assert.deepEqual(tagCalls, [{ repository: COMPONENTS.console, tag: `sha-${REVISION.slice(0, 7)}` }]);
  assert.equal(digestCalls.length, Object.keys(COMPONENTS).length - 1);
});

test('a historical source-revision resolver rejects a short-tag collision or mixed image set before attestation acceptance', async () => {
  const bom = validBom();
  let provenanceChecks = 0;
  await assert.rejects(
    resolveSourceRevision(REVISION, {
      async resolveImageFn() {
        return {
          image: bom.components.console.image,
          sourceRevision: 'b'.repeat(40),
          registryCredentialsRequired: false
        };
      },
      inspectImageFn: async (repository, image) => ({ image, sourceRevision: REVISION, registryCredentialsRequired: false }),
      verifyBom: bomVerifier(bom),
      verifyImage() { provenanceChecks += 1; },
      verifySbom() { provenanceChecks += 1; }
    }),
    /differs from the signed Release BOM/
  );
  assert.equal(provenanceChecks, 0);
});
