import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReleaseDigest,
  calculateReleaseBomDigest,
  calculateLegacyReleaseDigest,
  AUXILIARY_ARTIFACTS,
  BASE_RUNTIME_COMPONENTS,
  COMPONENTS,
  HISTORICAL_COMPONENTS,
  LEGACY_BASE_RUNTIME_COMPONENTS,
  PRE_OSDST_BASE_RUNTIME_COMPONENTS,
  LEGACY_RELEASE_TRUST,
  LOCAL_EDGE_TRUST,
  RETIRED_EDGE_ATTESTATION_TRUST,
  migrateLegacyReleaseLock,
  RELEASE_API_VERSION,
  RELEASE_BOM_PREDICATE,
  RELEASE_PLATFORMS,
  RELEASE_SCOPE_COMPONENT,
  RELEASE_TRUST,
  resolveSourceRevision,
  releaseBomPointer,
  SOURCE,
  validateReleaseBom,
  validateChannel,
  validateLock,
  validateReleaseTransition,
  verifyImageProvenance,
  verifyImageSbom,
  verifyReleaseProvenance,
  verifyReleaseBomAttestation,
  verifyReleaseLock,
  resolveImage,
  resolveChannel,
  requiredPlatformDescriptors
} from '../src/release.mjs';
import { LEGACY_INSTALLED_AGENT_COMPONENTS } from '../src/release-agent-identity-cutover.mjs';

const REVISION = '1'.repeat(40);
const DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE_TAG = '202609020101';
const MIGRATION_MANIFEST = Object.freeze({
  path: 'migrations/manifest.json',
  sha256: `sha256:${'b'.repeat(64)}`,
  setDigest: `sha256:${'c'.repeat(64)}`,
  latestGlobalId: 'opensphere-console/20260902/0001',
  migrationCount: 1
});

function artifactEntries(repositories, revision = REVISION, digest = DIGEST) {
  return Object.fromEntries(Object.entries(repositories).map(([name, repository]) => [
    name,
    {
      repository,
      image: `ghcr.io/opensphere-platform/${repository}@${digest}`,
      sourceRevision: revision
    }
  ]));
}

function artifactScope(repository) {
  return Object.values(AUXILIARY_ARTIFACTS).includes(repository) ? 'auxiliary' : 'canonical';
}

function releaseLabels(repository, {
  revision = REVISION,
  releaseTag = RELEASE_TAG,
  overrides = {}
} = {}) {
  return {
    'io.opensphere.channel': 'edge',
    'io.opensphere.release-tag': releaseTag,
    'io.opensphere.source-revision': revision,
    'io.opensphere.release-scope': artifactScope(repository),
    'opensphere.io/build-authority': 'localhost',
    'opensphere.io/release-class': 'pre-ga',
    'opensphere.io/ga-eligible': 'false',
    ...overrides
  };
}

function inspectedArtifact(repository, image, {
  revision = REVISION,
  releaseTag = RELEASE_TAG,
  overrides
} = {}) {
  return {
    image,
    sourceRevision: revision,
    labels: releaseLabels(repository, { revision, releaseTag, overrides }),
    registryCredentialsRequired: false
  };
}

function signedArtifact(repository, image, {
  revision = REVISION,
  releaseTag = RELEASE_TAG
} = {}) {
  return {
    image,
    sourceRevision: revision,
    labels: {
      'io.opensphere.release-tag': releaseTag,
      'io.opensphere.source-revision': revision,
      'io.opensphere.release-scope': artifactScope(repository)
    },
    registryCredentialsRequired: false
  };
}

function validLock(channel = 'edge') {
  const components = artifactEntries(COMPONENTS);
  const auxiliaryArtifacts = artifactEntries(AUXILIARY_ARTIFACTS);
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel,
    releaseDigest: calculateReleaseDigest(channel, components, RELEASE_TRUST, undefined, { auxiliaryArtifacts }),
    source: SOURCE,
    sourceRevision: REVISION,
    trust: RELEASE_TRUST,
    auxiliaryArtifacts,
    components
  };
}

function validComponentTransition(changedComponents = ['consoleApi']) {
  const base = validLock('edge');
  base.trust = LOCAL_EDGE_TRUST;
  base.releaseDigest = calculateReleaseDigest(
    'edge',
    base.components,
    LOCAL_EDGE_TRUST,
    undefined,
    { auxiliaryArtifacts: base.auxiliaryArtifacts }
  );
  const targetRevision = '2'.repeat(40);
  const target = structuredClone(base);
  target.releaseScope = RELEASE_SCOPE_COMPONENT;
  target.baseReleaseDigest = base.releaseDigest;
  target.changedComponents = [...changedComponents].sort();
  target.sourceRevision = targetRevision;
  for (const name of target.changedComponents) {
    target.components[name].image =
      `ghcr.io/opensphere-platform/${target.components[name].repository}@sha256:${'b'.repeat(64)}`;
    target.components[name].sourceRevision = targetRevision;
  }
  target.releaseDigest = calculateReleaseDigest(
    target.channel,
    target.components,
    target.trust,
    undefined,
    {
      releaseScope: target.releaseScope,
      baseReleaseDigest: target.baseReleaseDigest,
      changedComponents: target.changedComponents,
      auxiliaryArtifacts: target.auxiliaryArtifacts
    }
  );
  return { base, target };
}

function validLegacyAgentLock() {
  const components = artifactEntries(HISTORICAL_COMPONENTS);
  delete components.osaaGateway;
  delete components.osaaGovernedAdapter;
  Object.assign(components, artifactEntries(LEGACY_INSTALLED_AGENT_COMPONENTS));
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: calculateReleaseDigest('edge', components, LOCAL_EDGE_TRUST),
    source: SOURCE,
    sourceRevision: REVISION,
    trust: LOCAL_EDGE_TRUST,
    components
  };
}

function validBom(channel = 'edge', revision = REVISION, digest = DIGEST) {
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseBOM',
    channel,
    status: channel === 'candidate' ? 'Candidate' : 'Active',
    source: SOURCE,
    sourceRevision: revision,
    releaseTag: RELEASE_TAG,
    artifacts: { supabaseMigrationManifest: { ...MIGRATION_MANIFEST } },
    supportedPlatforms: ['linux/amd64', 'linux/arm64'],
    components: artifactEntries(COMPONENTS, revision, digest)
  };
}

test('signed release BOM requires exact Supabase migration manifest evidence', () => {
  const bom = validBom();
  delete bom.artifacts;
  assert.throws(() => validateReleaseBom(bom), /migration manifest evidence/u);
  assert.doesNotThrow(() => validateReleaseBom(bom, { allowLegacyReleaseArtifacts: true }));
});

function bomVerifier(bom = validBom()) {
  return async (subject) => ({ bom, digest: calculateReleaseBomDigest(bom), subject });
}

test('canonical release set contains the full target Console distribution', () => {
  assert.deepEqual(Object.values(COMPONENTS), [
    'opensphere-console',
    'opensphere-console-api',
    'opensphere-extension-controller',
    'opensphere-registry',
    'opensphere-console-osaa-gateway',
    'opensphere-osdst',
    'opensphere-osaa-governed-adapter',
    'opensphere-console-notification-dispatcher',
    'opensphere-console-gitea',
    'opensphere-console-supabase-postgres',
    'opensphere-console-supabase-auth',
    'opensphere-console-supabase-rest',
    'opensphere-console-supabase-storage',
    'opensphere-console-gitea-postgres',
    'opensphere-console-recovery',
    'opensphere-console-beszel-hub',
    'opensphere-console-beszel-agent',
    'opensphere-console-beszel-bootstrap'
  ]);
  assert.deepEqual(AUXILIARY_ARTIFACTS, {
    cliArtifacts: 'opensphere-os-cli',
    osShellControl: 'opensphere-console-os-shell-control',
    osShellRuntime: 'opensphere-os-shell-runtime'
  });
});

test('base release distribution includes bootstrap core and Console-activated modules', () => {
  assert.deepEqual(BASE_RUNTIME_COMPONENTS, Object.keys(COMPONENTS));
  assert.equal(BASE_RUNTIME_COMPONENTS.includes('consoleApi'), true);
  assert.equal(BASE_RUNTIME_COMPONENTS.includes('extensionController'), true);
  assert.equal(BASE_RUNTIME_COMPONENTS.includes('beszelHub'), true);
  assert.equal(BASE_RUNTIME_COMPONENTS.includes('beszelAgent'), true);
  assert.equal(BASE_RUNTIME_COMPONENTS.includes('beszelBootstrap'), true);
  assert.deepEqual(PRE_OSDST_BASE_RUNTIME_COMPONENTS, Object.keys(HISTORICAL_COMPONENTS).filter((name) => name !== 'osdst'));
  assert.deepEqual(
    LEGACY_BASE_RUNTIME_COMPONENTS,
    Object.keys(HISTORICAL_COMPONENTS).filter((name) => name !== 'osdst' && name !== 'recovery')
  );
});

test('installed pre-OSAA lock remains readable only through the explicit historical gate', () => {
  const base = validLegacyAgentLock();
  assert.throws(() => validateLock(base), /component set is not canonical/u);
  assert.equal(validateLock(base, { allowInstalledAgentIdentityCutover: true }), base);
  assert.throws(() => validateReleaseTransition(validLock(), base), /component set is not canonical/u);
});

test('historical agent identity gate rejects a canonical repository substituted into the old name', () => {
  const base = validLegacyAgentLock();
  const wrongRepository = structuredClone(base);
  wrongRepository.components.oaaGateway.repository = 'opensphere-console-osaa-gateway';
  wrongRepository.releaseDigest = calculateReleaseDigest(
    wrongRepository.channel,
    wrongRepository.components,
    wrongRepository.trust
  );
  assert.throws(
    () => validateLock(wrongRepository, { allowInstalledAgentIdentityCutover: true }),
    /repository is not canonical/u
  );
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
  assert.equal(requiredPlatformDescriptors(index, 'opensphere-console', ['linux/amd64']).length, 1);
});

test('only governed release channels are accepted', () => {
  for (const channel of ['edge', 'candidate', 'stable']) assert.doesNotThrow(() => validateChannel(channel));
  assert.throws(() => validateChannel('latest'), /Unsupported channel/);
});

test('only edge may declare one supported target platform', () => {
  const edge = validBom('edge');
  edge.supportedPlatforms = ['linux/amd64'];
  assert.doesNotThrow(() => validateReleaseBom(edge, {
    channel: 'edge',
    requiredPlatforms: ['linux/amd64']
  }));
  assert.throws(() => validateReleaseBom(edge, {
    channel: 'edge',
    requiredPlatforms: ['linux/arm64']
  }), /does not support target platform/);

  const candidate = validBom('candidate');
  candidate.supportedPlatforms = ['linux/amd64'];
  assert.throws(() => validateReleaseBom(candidate), /platform set is not canonical/);
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

test('localhost build trust is accepted only for edge and cannot claim a signed BOM', () => {
  const edge = validLock('edge');
  edge.trust = LOCAL_EDGE_TRUST;
  edge.releaseDigest = calculateReleaseDigest('edge', edge.components, LOCAL_EDGE_TRUST, undefined, { auxiliaryArtifacts: edge.auxiliaryArtifacts });
  assert.equal(validateLock(edge), edge);

  const promoted = structuredClone(edge);
  promoted.channel = 'candidate';
  promoted.releaseDigest = calculateReleaseDigest('candidate', promoted.components, LOCAL_EDGE_TRUST, undefined, { auxiliaryArtifacts: promoted.auxiliaryArtifacts });
  assert.throws(() => validateLock(promoted), /accepted only for the edge channel/);

  edge.releaseBom = releaseBomPointer(validBom('edge'));
  edge.releaseDigest = calculateReleaseDigest('edge', edge.components, LOCAL_EDGE_TRUST, edge.releaseBom, { auxiliaryArtifacts: edge.auxiliaryArtifacts });
  assert.throws(() => validateLock(edge), /cannot claim a signed Release BOM/);
});

test('localhost edge lock revalidation inspects every immutable governed artifact without a signed BOM', async () => {
  const edge = validLock('edge');
  edge.trust = LOCAL_EDGE_TRUST;
  edge.releaseDigest = calculateReleaseDigest(
    'edge',
    edge.components,
    LOCAL_EDGE_TRUST,
    undefined,
    { auxiliaryArtifacts: edge.auxiliaryArtifacts }
  );
  const inspected = [];
  const verified = await verifyReleaseLock(edge, {
    requiredPlatforms: ['linux/amd64'],
    async inspectImageFn(repository, image, options) {
      inspected.push({ repository, image, requiredPlatforms: options.requiredPlatforms });
      return inspectedArtifact(repository, image);
    },
    verifyBom() {
      throw new Error('localhost edge must not require a signed Release BOM');
    }
  });
  assert.equal(inspected.length, Object.keys(COMPONENTS).length + Object.keys(AUXILIARY_ARTIFACTS).length);
  assert.equal(inspected.every(({ requiredPlatforms }) => requiredPlatforms[0] === 'linux/amd64'), true);
  assert.match(verified.localVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('localhost edge revalidation accepts a pre-OSDST lock only as an explicit historical baseline', async () => {
  const components = artifactEntries(HISTORICAL_COMPONENTS);
  delete components.osdst;
  const edge = {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: calculateReleaseDigest('edge', components, LOCAL_EDGE_TRUST),
    source: SOURCE,
    sourceRevision: REVISION,
    trust: LOCAL_EDGE_TRUST,
    components
  };
  await assert.rejects(
    verifyReleaseLock(edge, { async inspectImageFn() { throw new Error('must not inspect'); } }),
    /component set is not canonical/
  );
  const verified = await verifyReleaseLock(edge, {
    allowLegacyComponentSet: true,
    requiredPlatforms: ['linux/amd64'],
    async inspectImageFn(repository, image) {
      return inspectedArtifact(repository, image);
    }
  });
  assert.equal(Object.hasOwn(verified.components, 'osdst'), false);
  assert.match(verified.localVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
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

test('component release transition reuses every unlisted component exactly', () => {
  const { base, target } = validComponentTransition(['consoleApi']);
  assert.equal(validateLock(target), target);
  assert.equal(validateReleaseTransition(base, target), target);
  assert.equal(target.components.console.image, base.components.console.image);
  assert.notEqual(target.components.consoleApi.image, base.components.consoleApi.image);
});

test('component release transition binds its base digest and explicit change set', () => {
  const { base, target } = validComponentTransition(['consoleApi']);

  const wrongBase = structuredClone(target);
  wrongBase.baseReleaseDigest = `sha256:${'c'.repeat(64)}`;
  wrongBase.releaseDigest = calculateReleaseDigest(
    wrongBase.channel,
    wrongBase.components,
    wrongBase.trust,
    undefined,
    {
      releaseScope: wrongBase.releaseScope,
      baseReleaseDigest: wrongBase.baseReleaseDigest,
      changedComponents: wrongBase.changedComponents,
      auxiliaryArtifacts: wrongBase.auxiliaryArtifacts
    }
  );
  assert.throws(
    () => validateReleaseTransition(base, wrongBase),
    /does not name the installed base release digest/
  );

  const hiddenChange = structuredClone(target);
  hiddenChange.components.console.image =
    `ghcr.io/opensphere-platform/${COMPONENTS.console}@sha256:${'d'.repeat(64)}`;
  hiddenChange.releaseDigest = calculateReleaseDigest(
    hiddenChange.channel,
    hiddenChange.components,
    hiddenChange.trust,
    undefined,
    {
      releaseScope: hiddenChange.releaseScope,
      baseReleaseDigest: hiddenChange.baseReleaseDigest,
      changedComponents: hiddenChange.changedComponents,
      auxiliaryArtifacts: hiddenChange.auxiliaryArtifacts
    }
  );
  assert.throws(
    () => validateReleaseTransition(base, hiddenChange),
    /Unlisted component console differs/
  );

  const noChange = structuredClone(target);
  noChange.components.consoleApi = structuredClone(base.components.consoleApi);
  noChange.releaseDigest = calculateReleaseDigest(
    noChange.channel,
    noChange.components,
    noChange.trust,
    undefined,
    {
      releaseScope: noChange.releaseScope,
      baseReleaseDigest: noChange.baseReleaseDigest,
      changedComponents: noChange.changedComponents,
      auxiliaryArtifacts: noChange.auxiliaryArtifacts
    }
  );
  assert.throws(
    () => validateReleaseTransition(base, noChange),
    /Changed component consoleApi (?:source revision differs|is identical)/
  );
});

test('component release scope is edge-local, canonical, and digest-bound', () => {
  const { target } = validComponentTransition(['consoleApi', 'console']);
  assert.doesNotThrow(() => validateLock(target));

  const promoted = structuredClone(target);
  promoted.channel = 'candidate';
  promoted.releaseDigest = calculateReleaseDigest(
    promoted.channel,
    promoted.components,
    promoted.trust,
    undefined,
    {
      releaseScope: promoted.releaseScope,
      baseReleaseDigest: promoted.baseReleaseDigest,
      changedComponents: promoted.changedComponents,
      auxiliaryArtifacts: promoted.auxiliaryArtifacts
    }
  );
  assert.throws(() => validateLock(promoted), /localhost edge trust|accepted only for the edge channel/);

  const unsorted = structuredClone(target);
  unsorted.changedComponents.reverse();
  unsorted.releaseDigest = calculateReleaseDigest(
    unsorted.channel,
    unsorted.components,
    unsorted.trust,
    undefined,
    {
      releaseScope: unsorted.releaseScope,
      baseReleaseDigest: unsorted.baseReleaseDigest,
      changedComponents: unsorted.changedComponents,
      auxiliaryArtifacts: unsorted.auxiliaryArtifacts
    }
  );
  assert.throws(() => validateLock(unsorted), /canonical sorted set/);

  const tamperedContract = structuredClone(target);
  tamperedContract.baseReleaseDigest = `sha256:${'e'.repeat(64)}`;
  assert.throws(() => validateLock(tamperedContract), /digest does not match/);
});

test('component edge verification accepts inherited old tags and groups changed tags', async () => {
  const { target } = validComponentTransition(['consoleApi', 'console']);
  const verified = await verifyReleaseLock(target, {
    requiredPlatforms: ['linux/amd64'],
    async inspectImageFn(repository, image) {
      const canonical = Object.entries(COMPONENTS).find(([, value]) => value === repository);
      const auxiliary = Object.entries(AUXILIARY_ARTIFACTS).find(([, value]) => value === repository);
      const [name] = canonical ?? auxiliary;
      const artifact = canonical ? target.components[name] : target.auxiliaryArtifacts[name];
      return inspectedArtifact(repository, image, {
        revision: artifact.sourceRevision,
        releaseTag: target.changedComponents.includes(name) ? '202607301900' : '202607291200'
      });
    }
  });
  assert.match(verified.localVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('release lock accepts only a boolean registry credential requirement', () => {
  const lock = validLock();
  lock.components.console.registryCredentialsRequired = 'yes';
  lock.releaseDigest = calculateReleaseDigest(lock.channel, lock.components, lock.trust, undefined, { auxiliaryArtifacts: lock.auxiliaryArtifacts });
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
  delete legacyTrusted.auxiliaryArtifacts;
  legacyTrusted.trust = LEGACY_RELEASE_TRUST;
  legacyTrusted.releaseDigest = calculateReleaseDigest('edge', legacyTrusted.components, LEGACY_RELEASE_TRUST);
  assert.doesNotThrow(() => validateLock(legacyTrusted));

  legacyTrusted.channel = 'candidate';
  legacyTrusted.releaseDigest = calculateReleaseDigest('candidate', legacyTrusted.components, LEGACY_RELEASE_TRUST);
  assert.throws(() => validateLock(legacyTrusted), /require signed SBOM trust v2/);
});

test('the retired GitHub Actions edge trust is rollback-only', async () => {
  const retired = validLock('edge');
  delete retired.auxiliaryArtifacts;
  retired.trust = RETIRED_EDGE_ATTESTATION_TRUST;
  retired.releaseDigest = calculateReleaseDigest('edge', retired.components, RETIRED_EDGE_ATTESTATION_TRUST);
  retired.provenanceVerifiedAt = '2026-07-24T00:32:49.216Z';
  retired.sbomVerifiedAt = '2026-07-24T00:32:49.216Z';
  assert.doesNotThrow(() => validateLock(retired));
  await assert.rejects(verifyReleaseLock(retired), /accepted only as an installed rollback baseline/);
  const verified = await verifyReleaseLock(retired, { allowRetiredEdgeRollback: true });
  assert.equal(verified.retiredEdgeRollbackBaseline, true);
  retired.channel = 'candidate';
  retired.releaseDigest = calculateReleaseDigest('candidate', retired.components, RETIRED_EDGE_ATTESTATION_TRUST);
  assert.throws(() => validateLock(retired), /Retired GitHub Actions edge trust is accepted only for the edge channel/);
});

test('a pre-auxiliary legacy lock cannot be upgraded into the current trusted target', () => {
  const legacy = validLock();
  delete legacy.trust;
  delete legacy.auxiliaryArtifacts;
  legacy.releaseDigest = calculateLegacyReleaseDigest(legacy.channel, legacy.components);
  assert.throws(
    () => migrateLegacyReleaseLock(legacy),
    /complete governed auxiliary artifact set/
  );
  assert.equal(Object.hasOwn(legacy, 'trust'), false);
});

test('a tampered legacy lock cannot be upgraded into the trusted format', () => {
  const legacy = validLock();
  delete legacy.trust;
  delete legacy.auxiliaryArtifacts;
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
      '--signer-workflow', 'opensphere-platform/OpenSphere-console/.github/workflows/publish-candidate-images.yml',
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

test('a release lock is accepted only when its canonical set, auxiliary set and BOM match', async () => {
  const bom = validBom();
  const lock = validLock();
  lock.releaseBom = releaseBomPointer(bom);
  assert.deepEqual(lock.releaseBom.migrationManifest, MIGRATION_MANIFEST);
  assert.equal(lock.releaseBom.releaseTag, RELEASE_TAG);
  lock.releaseDigest = calculateReleaseDigest(
    lock.channel,
    lock.components,
    lock.trust,
    lock.releaseBom,
    { auxiliaryArtifacts: lock.auxiliaryArtifacts }
  );
  const inspectImageFn = async (repository, image) => signedArtifact(repository, image);
  await assert.doesNotReject(verifyReleaseLock(lock, {
    verifyBom: bomVerifier(bom),
    verifyImage() {},
    verifySbom() {},
    inspectImageFn
  }));

  const tampered = structuredClone(lock);
  tampered.releaseBom.digest = `sha256:${'f'.repeat(64)}`;
  tampered.releaseDigest = calculateReleaseDigest(
    tampered.channel,
    tampered.components,
    tampered.trust,
    tampered.releaseBom,
    { auxiliaryArtifacts: tampered.auxiliaryArtifacts }
  );
  await assert.rejects(verifyReleaseLock(tampered, {
    verifyBom: bomVerifier(bom), verifyImage() {}, verifySbom() {}, inspectImageFn
  }), /BOM digest differs/);

  const substitutedManifest = structuredClone(lock);
  substitutedManifest.releaseBom.migrationManifest.setDigest = `sha256:${'f'.repeat(64)}`;
  substitutedManifest.releaseDigest = calculateReleaseDigest(
    substitutedManifest.channel,
    substitutedManifest.components,
    substitutedManifest.trust,
    substitutedManifest.releaseBom,
    { auxiliaryArtifacts: substitutedManifest.auxiliaryArtifacts }
  );
  await assert.rejects(verifyReleaseLock(substitutedManifest, {
    verifyBom: bomVerifier(bom), verifyImage() {}, verifySbom() {}, inspectImageFn
  }), /migration manifest evidence differs/u);
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

test('release provenance verification requires every canonical and auxiliary image', async () => {
  const provenance = [];
  const sboms = [];
  const events = [];
  const lock = validLock();
  const governedImages = [
    ...Object.values(lock.components),
    ...Object.values(lock.auxiliaryArtifacts)
  ].map(({ image }) => image);
  const verified = await verifyReleaseProvenance(lock, {
    verifyImage(image) { provenance.push(image); },
    verifySbom(image) { sboms.push(image); },
    onProgress(event) { events.push(event); }
  });
  const artifactCount = Object.keys(COMPONENTS).length + Object.keys(AUXILIARY_ARTIFACTS).length;
  assert.equal(provenance.length, artifactCount);
  assert.deepEqual(new Set(provenance), new Set(governedImages));
  assert.deepEqual(new Set(sboms), new Set(provenance));
  assert.match(verified.provenanceVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(verified.sbomVerifiedAt, verified.provenanceVerifiedAt);
  for (const type of ['provenance-start', 'provenance-complete', 'sbom-start', 'sbom-complete']) {
    assert.equal(events.filter((event) => event.type === type).length, artifactCount);
  }
});

test('channel resolution verifies all canonical and auxiliary release artifacts before returning a lock', async () => {
  const bom = validBom();
  const events = [];
  const resolveCalls = [];
  const resolved = await resolveChannel('edge', {
    async resolveImageFn(repository, reference) {
      resolveCalls.push({ repository, reference });
      const image = repository === COMPONENTS.console
        ? bom.components.console.image
        : `ghcr.io/opensphere-platform/${repository}@${DIGEST}`;
      return signedArtifact(repository, image);
    },
    async inspectImageFn(repository, image) {
      return signedArtifact(repository, image);
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
  assert.deepEqual(Object.keys(resolved.auxiliaryArtifacts), Object.keys(AUXILIARY_ARTIFACTS));
  assert.match(resolved.sbomVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotThrow(() => validateLock(resolved));
  assert.deepEqual(resolveCalls[0], { repository: COMPONENTS.console, reference: 'edge' });
  assert.deepEqual(
    resolveCalls.slice(1),
    Object.values(AUXILIARY_ARTIFACTS).map((repository) => ({ repository, reference: RELEASE_TAG }))
  );
  assert.equal(events.filter(({ type }) => type === 'component-complete').length, Object.keys(COMPONENTS).length);
  assert.equal(
    events.filter(({ type }) => type === 'sbom-complete').length,
    Object.keys(COMPONENTS).length + Object.keys(AUXILIARY_ARTIFACTS).length
  );
});

test('localhost edge resolves one target platform through immutable local tags without GitHub attestations', async () => {
  const calls = [];
  const resolved = await resolveChannel('edge', {
    requiredPlatforms: ['linux/amd64'],
    async resolveImageFn(repository, reference, options) {
      calls.push({ repository, reference, platforms: options.requiredPlatforms });
      return inspectedArtifact(
        repository,
        `ghcr.io/opensphere-platform/${repository}@${DIGEST}`
      );
    },
    verifyBom() {
      throw new Error('localhost edge must not request a GitHub Release BOM attestation');
    },
    verifyImage() {
      throw new Error('localhost edge must not claim GitHub provenance');
    },
    verifySbom() {
      throw new Error('localhost edge must not claim a GitHub SPDX attestation');
    }
  });

  assert.equal(resolved.trust, LOCAL_EDGE_TRUST);
  assert.equal(resolved.releaseBom, undefined);
  assert.equal(resolved.sourceRevision, REVISION);
  assert.deepEqual(Object.keys(resolved.auxiliaryArtifacts), Object.keys(AUXILIARY_ARTIFACTS));
  for (const [name, repository] of Object.entries(AUXILIARY_ARTIFACTS)) {
    assert.deepEqual(resolved.auxiliaryArtifacts[name], {
      repository,
      image: `ghcr.io/opensphere-platform/${repository}@${DIGEST}`,
      sourceRevision: REVISION,
      registryCredentialsRequired: false
    });
  }
  assert.deepEqual(calls[0], {
    repository: COMPONENTS.console,
    reference: 'edge',
    platforms: ['linux/amd64']
  });
  assert.equal(calls.length, Object.keys(COMPONENTS).length + Object.keys(AUXILIARY_ARTIFACTS).length + 1);
  assert.equal(calls.slice(1).every(({ reference }) => reference === `local-${REVISION.slice(0, 12)}`), true);
  assert.equal(calls.every(({ platforms }) => platforms.length === 1 && platforms[0] === 'linux/amd64'), true);
  assert.doesNotThrow(() => validateLock(resolved));
});

test('localhost edge rejects any auxiliary artifact from another source revision', async () => {
  await assert.rejects(resolveChannel('edge', {
    requiredPlatforms: ['linux/amd64'],
    async resolveImageFn(repository) {
      const sourceRevision = repository === AUXILIARY_ARTIFACTS.cliArtifacts
        ? '2'.repeat(40)
        : REVISION;
      return inspectedArtifact(
        repository,
        `ghcr.io/opensphere-platform/${repository}@${DIGEST}`,
        { revision: sourceRevision }
      );
    }
  }), /opensphere-os-cli source revision differs from the Console anchor/u);
});

test('current locks require the exact digest-bound three-artifact auxiliary set', () => {
  const signed = validLock();
  assert.equal(validateLock(signed), signed);

  const missing = structuredClone(signed);
  delete missing.auxiliaryArtifacts.osShellRuntime;
  missing.releaseDigest = calculateReleaseDigest(
    missing.channel,
    missing.components,
    missing.trust,
    undefined,
    { auxiliaryArtifacts: missing.auxiliaryArtifacts }
  );
  assert.throws(() => validateLock(missing), /auxiliary artifact set is not canonical/u);

  const local = structuredClone(signed);
  local.trust = LOCAL_EDGE_TRUST;
  local.releaseDigest = calculateReleaseDigest(
    local.channel,
    local.components,
    local.trust,
    undefined,
    { auxiliaryArtifacts: local.auxiliaryArtifacts }
  );
  assert.equal(validateLock(local), local);
  local.auxiliaryArtifacts.osShellRuntime.image =
    'ghcr.io/opensphere-platform/opensphere-os-shell-runtime:edge';
  assert.throws(() => validateLock(local), /not digest-pinned/u);
});

test('component release preserves every auxiliary artifact byte-for-byte', () => {
  const { base, target } = validComponentTransition(['consoleApi']);
  assert.equal(validateReleaseTransition(base, target), target);
  target.auxiliaryArtifacts.osShellControl.image =
    `ghcr.io/opensphere-platform/opensphere-console-os-shell-control@sha256:${'d'.repeat(64)}`;
  target.releaseDigest = calculateReleaseDigest(
    target.channel,
    target.components,
    target.trust,
    undefined,
    {
      releaseScope: target.releaseScope,
      baseReleaseDigest: target.baseReleaseDigest,
      changedComponents: target.changedComponents,
      auxiliaryArtifacts: target.auxiliaryArtifacts
    }
  );
  assert.throws(() => validateReleaseTransition(base, target), /cannot change auxiliary runtime artifacts/u);
});

test('localhost edge fails closed when any image lacks its development trust labels', async () => {
  await assert.rejects(resolveChannel('edge', {
    requiredPlatforms: ['linux/amd64'],
    async resolveImageFn(repository) {
      return inspectedArtifact(
        repository,
        `ghcr.io/opensphere-platform/${repository}@${DIGEST}`,
        {
          overrides: repository === COMPONENTS.supabaseAuth
            ? { 'opensphere.io/ga-eligible': 'true' }
            : {}
        }
      );
    }
  }), /supabase-auth has invalid opensphere\.io\/ga-eligible label/);
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
  const components = artifactEntries(HISTORICAL_COMPONENTS);
  delete components.recovery;
  delete components.osdst;
  const bom = {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseBOM',
    channel: 'edge',
    status: 'Active',
    source: SOURCE,
    sourceRevision: REVISION,
    releaseTag: RELEASE_TAG,
    supportedPlatforms: [...RELEASE_PLATFORMS],
    components
  };
  const releaseBom = releaseBomPointer(bom, components.console.image, {
    allowLegacyComponentSet: true,
    allowLegacyReleaseArtifacts: true
  });
  const lock = {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: calculateReleaseDigest('edge', components, RELEASE_TRUST, releaseBom),
    source: SOURCE,
    sourceRevision: REVISION,
    trust: RELEASE_TRUST,
    releaseBom,
    components
  };

  assert.throws(() => validateLock(lock), /component set is not canonical/);
  assert.doesNotThrow(() => validateLock(lock, { allowLegacyComponentSet: true }));
  await assert.doesNotReject(verifyReleaseLock(lock, {
    verifyBom: bomVerifier(bom),
    verifyImage: async () => {},
    verifySbom: async () => {},
    allowLegacyComponentSet: true,
    allowLegacyReleaseArtifacts: true
  }));
});

test('channel resolution samples one mutable anchor, canonical digests and immutable auxiliary tags', async () => {
  const bom = validBom();
  const tagCalls = [];
  const digestCalls = [];
  await resolveChannel('edge', {
    async resolveImageFn(repository, reference) {
      tagCalls.push({ repository, reference });
      const image = repository === COMPONENTS.console
        ? bom.components.console.image
        : `ghcr.io/opensphere-platform/${repository}@${DIGEST}`;
      return signedArtifact(repository, image);
    },
    async inspectImageFn(repository, image) {
      digestCalls.push({ repository, image });
      return signedArtifact(repository, image);
    },
    verifyBom: bomVerifier(bom),
    verifyImage: async () => {},
    verifySbom: async () => {}
  });
  assert.deepEqual(tagCalls, [
    { repository: COMPONENTS.console, reference: 'edge' },
    ...Object.values(AUXILIARY_ARTIFACTS).map((repository) => ({
      repository,
      reference: RELEASE_TAG
    }))
  ]);
  assert.deepEqual(digestCalls, Object.entries(COMPONENTS).slice(1).map(([name, repository]) => ({
    repository,
    image: bom.components[name].image
  })));
});

test('channel resolution rejects a canonical registry component that differs from the signed BOM', async () => {
  const bom = validBom();
  let provenanceChecks = 0;
  await assert.rejects(resolveChannel('edge', {
    resolveImageFn: async (repository) => signedArtifact(repository, bom.components.console.image),
    inspectImageFn: async (repository, image) => signedArtifact(repository, image, {
      revision: repository === COMPONENTS.supabaseAuth ? '2'.repeat(40) : REVISION
    }),
    verifyBom: bomVerifier(bom),
    verifyImage: async () => { provenanceChecks += 1; },
    verifySbom: async () => { provenanceChecks += 1; }
  }), /differs from the signed Release BOM/);
  assert.equal(provenanceChecks, 0);
});

test('a historical source-revision tag becomes a verified explicit rollback lock', async () => {
  const bom = validBom();
  const tagCalls = [];
  const digestCalls = [];
  const resolved = await resolveSourceRevision(REVISION, {
    async resolveImageFn(repository, tag) {
      tagCalls.push({ repository, tag });
      const image = repository === COMPONENTS.console
        ? bom.components.console.image
        : `ghcr.io/opensphere-platform/${repository}@${DIGEST}`;
      return signedArtifact(repository, image);
    },
    async inspectImageFn(repository, image) {
      digestCalls.push({ repository, image });
      return signedArtifact(repository, image);
    },
    verifyBom: bomVerifier(bom),
    verifyImage() {},
    verifySbom() {}
  });
  assert.equal(resolved.channel, 'edge');
  assert.equal(resolved.sourceRevision, REVISION);
  assert.equal(
    resolved.releaseDigest,
    calculateReleaseDigest(
      'edge',
      resolved.components,
      RELEASE_TRUST,
      resolved.releaseBom,
      { auxiliaryArtifacts: resolved.auxiliaryArtifacts }
    )
  );
  assert.deepEqual(tagCalls, [
    { repository: COMPONENTS.console, tag: `sha-${REVISION.slice(0, 7)}` },
    ...Object.values(AUXILIARY_ARTIFACTS).map((repository) => ({
      repository,
      tag: RELEASE_TAG
    }))
  ]);
  assert.equal(digestCalls.length, Object.keys(COMPONENTS).length - 1);
});

test('a historical source-revision resolver rejects a short-tag collision before attestation acceptance', async () => {
  const bom = validBom();
  let provenanceChecks = 0;
  await assert.rejects(
    resolveSourceRevision(REVISION, {
      async resolveImageFn(repository) {
        return signedArtifact(repository, bom.components.console.image, { revision: 'b'.repeat(40) });
      },
      inspectImageFn: async (repository, image) => signedArtifact(repository, image),
      verifyBom: bomVerifier(bom),
      verifyImage() { provenanceChecks += 1; },
      verifySbom() { provenanceChecks += 1; }
    }),
    /differs from the signed Release BOM/
  );
  assert.equal(provenanceChecks, 0);
});
