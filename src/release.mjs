import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fetchWithRetry } from './http.mjs';

export const RELEASE_API_VERSION = 'release.opensphere.io/v1alpha1';
export const REGISTRY = 'ghcr.io';
export const OWNER = 'opensphere-platform';
export const SOURCE = 'https://github.com/opensphere-platform/OpenSphere-console';
// v1 locks predate the signed SBOM gate.  They are accepted only as an already
// installed edge rollback baseline; no new channel resolution may produce one.
export const LEGACY_RELEASE_TRUST = Object.freeze({
  type: 'github-actions-attestation/v1',
  repository: 'opensphere-platform/OpenSphere-console',
  signerWorkflow: 'opensphere-platform/OpenSphere-console/.github/workflows/publish-edge-images.yml',
  oidcIssuer: 'https://token.actions.githubusercontent.com',
  sourceRef: 'refs/heads/main'
});

// The CLI embeds the expected GitHub Actions identity and both predicates. A
// new digest is accepted only after GitHub's Sigstore-backed provenance *and*
// SPDX SBOM attestations prove this protected-main workflow produced it.
export const RELEASE_TRUST = Object.freeze({
  type: 'github-actions-attestation/v2',
  repository: LEGACY_RELEASE_TRUST.repository,
  signerWorkflow: LEGACY_RELEASE_TRUST.signerWorkflow,
  oidcIssuer: LEGACY_RELEASE_TRUST.oidcIssuer,
  sourceRef: LEGACY_RELEASE_TRUST.sourceRef,
  provenancePredicate: 'https://slsa.dev/provenance/v1',
  sbomPredicate: 'https://spdx.dev/Document/v2.3'
});

export const COMPONENTS = Object.freeze({
  console: 'opensphere-console',
  auth: 'opensphere-console-auth',
  backend: 'opensphere-console-backend',
  dupaController: 'opensphere-console-dupa-controller',
  oaaGateway: 'opensphere-console-oaa-gateway',
  kanidm: 'opensphere-console-kanidm',
  cbsPostgresql: 'opensphere-cbs-postgresql',
  cbsRustfs: 'opensphere-cbs-rustfs',
  cbsGitea: 'opensphere-cbs-gitea'
});

// A resolved image is a multi-platform index.  Do not let a channel appear
// installable on arm64 merely because its amd64 variant has the right label.
export const RELEASE_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);

function ghToken() {
  if (process.env.GHCR_TOKEN) return process.env.GHCR_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

async function registryToken(repository, fetchImpl) {
  const endpoint = new URL(`https://${REGISTRY}/token`);
  endpoint.searchParams.set('service', REGISTRY);
  endpoint.searchParams.set('scope', `repository:${OWNER}/${repository}:pull`);
  const token = ghToken();
  const headers = token
    ? { authorization: `Basic ${Buffer.from(`${OWNER}:${token}`).toString('base64')}` }
    : {};
  const response = await fetchWithRetry(endpoint, { headers }, { fetchImpl });
  if (!response.ok) {
    throw new Error(`GHCR token request failed for ${repository}: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body.token) throw new Error(`GHCR did not issue a pull token for ${repository}`);
  return body.token;
}

export function requiredPlatformDescriptors(index, repository) {
  if (!Array.isArray(index?.manifests)) {
    throw new Error(`${repository} must publish a multi-platform image index`);
  }
  const found = new Map(index.manifests
    .filter((entry) => entry?.platform?.os === 'linux' && typeof entry?.platform?.architecture === 'string')
    .map((entry) => [`${entry.platform.os}/${entry.platform.architecture}`, entry]));
  return RELEASE_PLATFORMS.map((platform) => {
    const descriptor = found.get(platform);
    if (!/^sha256:[a-f0-9]{64}$/.test(descriptor?.digest ?? '')) {
      throw new Error(`${repository} is missing required ${platform} manifest`);
    }
    return descriptor;
  });
}

export async function resolveImage(repository, channel, { fetchImpl = fetch } = {}) {
  const token = await registryToken(repository, fetchImpl);
  const base = `https://${REGISTRY}/v2/${OWNER}/${repository}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json'
    ].join(', ')
  };
  const response = await fetchWithRetry(`${base}/manifests/${channel}`, {
    headers: {
      ...headers
    }
  }, { fetchImpl });
  if (!response.ok) {
    throw new Error(`${REGISTRY}/${OWNER}/${repository}:${channel} not available: HTTP ${response.status}`);
  }
  const digest = response.headers.get('docker-content-digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new Error(`Invalid registry digest for ${repository}:${channel}`);
  }
  const document = await response.json();
  const descriptors = requiredPlatformDescriptors(document, repository);
  const manifests = await Promise.all(descriptors.map(async (descriptor) => {
    const platformResponse = await fetchWithRetry(`${base}/manifests/${descriptor.digest}`, { headers }, { fetchImpl });
    if (!platformResponse.ok) throw new Error(`Platform manifest unavailable for ${repository}: HTTP ${platformResponse.status}`);
    return platformResponse.json();
  }));
  const configs = await Promise.all(manifests.map(async (manifest) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest ?? '')) {
      throw new Error(`Image config descriptor missing for ${repository}:${channel}`);
    }
    const configResponse = await fetchWithRetry(`${base}/blobs/${manifest.config.digest}`, {
      headers: { authorization: `Bearer ${token}` }
    }, { fetchImpl });
    if (!configResponse.ok) throw new Error(`Image config unavailable for ${repository}: HTTP ${configResponse.status}`);
    return configResponse.json();
  }));
  const revisions = new Set(configs.map((config) => config.config?.Labels?.['io.opensphere.source-revision']));
  if (revisions.size !== 1 || !/^[a-f0-9]{40}$/.test([...revisions][0] ?? '')) {
    throw new Error(`Source revision labels differ across required platforms for ${repository}:${channel}`);
  }
  const [sourceRevision] = revisions;
  return { image: `${REGISTRY}/${OWNER}/${repository}@${digest}`, sourceRevision };
}

export function validateChannel(channel) {
  if (!['edge', 'candidate', 'stable'].includes(channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
}

export function calculateReleaseDigest(channel, components, trust = RELEASE_TRUST) {
  const payload = JSON.stringify({ channel, components, trust });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

// Releases created before the attestation trust root existed used this digest
// shape. It is kept only to prove an already-installed lock was not altered
// before its images are re-verified and the lock is migrated below.
export function calculateLegacyReleaseDigest(channel, components) {
  const payload = JSON.stringify({ channel, components });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function canonicalImage(image) {
  return new RegExp(`^${REGISTRY}/${OWNER}/opensphere-[a-z0-9-]+@sha256:[a-f0-9]{64}$`).test(image ?? '');
}

function canonicalTrust(candidate) {
  for (const trust of [RELEASE_TRUST, LEGACY_RELEASE_TRUST]) {
    const keys = Object.keys(trust);
    if (candidate && Object.keys(candidate).length === keys.length && keys.every((key) => candidate[key] === trust[key])) {
      return trust;
    }
  }
  return null;
}

function attestationArgs(image, predicateType) {
  return [
    'attestation', 'verify', `oci://${image}`,
    '--repo', RELEASE_TRUST.repository,
    '--signer-workflow', RELEASE_TRUST.signerWorkflow,
    '--cert-oidc-issuer', RELEASE_TRUST.oidcIssuer,
    '--source-ref', RELEASE_TRUST.sourceRef,
    '--deny-self-hosted-runners',
    ...(predicateType ? ['--predicate-type', predicateType] : [])
  ];
}

// `gh attestation verify` verifies the certificate chain, OIDC issuer, workflow
// path, repository and source ref. Its non-zero exit is intentionally fatal: an
// unsigned image must never become an installation lock merely because its tag
// resolved to a syntactically valid digest.
export function verifyImageProvenance(image, { execFile = execFileSync } = {}) {
  if (!canonicalImage(image)) throw new Error('Attestation subject is not a governed digest-pinned image');
  try {
    execFile('gh', attestationArgs(image, RELEASE_TRUST.provenancePredicate), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? 'unknown failure').trim();
    throw new Error(`Image provenance verification failed for ${image}: ${detail}`);
  }
  return { image, trust: RELEASE_TRUST };
}

export function verifyImageSbom(image, { execFile = execFileSync } = {}) {
  if (!canonicalImage(image)) throw new Error('SBOM subject is not a governed digest-pinned image');
  try {
    execFile('gh', attestationArgs(image, RELEASE_TRUST.sbomPredicate), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? 'unknown failure').trim();
    throw new Error(`Image SPDX SBOM verification failed for ${image}: ${detail}`);
  }
  return { image, trust: RELEASE_TRUST };
}

export async function verifyReleaseProvenance(lock, {
  verifyImage = verifyImageProvenance,
  verifySbom = verifyImageSbom
} = {}) {
  const validated = validateLock(lock);
  if (canonicalTrust(validated.trust) !== RELEASE_TRUST) {
    throw new Error('Legacy attestation trust cannot satisfy the signed SBOM release gate');
  }
  await Promise.all(Object.values(validated.components).map(async ({ image }) => {
    await verifyImage(image);
    await verifySbom(image);
  }));
  const verifiedAt = new Date().toISOString();
  return { ...validated, provenanceVerifiedAt: verifiedAt, sbomVerifiedAt: verifiedAt };
}

// Legacy locks must never be accepted merely because they predate the trust
// field. Their original digest is checked first; callers must then verify every
// component attestation before persisting the returned canonical lock.
export function migrateLegacyReleaseLock(lock) {
  if (!lock || Object.hasOwn(lock, 'trust')) {
    throw new Error('Only a pre-attestation release lock can be migrated');
  }
  const expectedLegacyDigest = calculateLegacyReleaseDigest(lock.channel, lock.components);
  if (lock.releaseDigest !== expectedLegacyDigest) {
    throw new Error('Legacy release lock digest does not match its component set');
  }
  const migrated = {
    ...lock,
    trust: RELEASE_TRUST,
    releaseDigest: calculateReleaseDigest(lock.channel, lock.components)
  };
  return validateLock(migrated);
}

export function validateLock(lock) {
  if (lock?.apiVersion !== RELEASE_API_VERSION || lock?.kind !== 'OpenSphereReleaseLock') {
    throw new Error('Invalid OpenSphere release lock');
  }
  validateChannel(lock.channel);
  if (lock.source !== SOURCE) throw new Error('Release lock source is not canonical');
  if (!/^[a-f0-9]{40}$/.test(lock.sourceRevision ?? '')) {
    throw new Error('Release lock source revision is invalid');
  }
  const trust = canonicalTrust(lock.trust);
  if (!trust) {
    throw new Error('Release lock trust root is not canonical');
  }
  if (lock.channel !== 'edge' && trust !== RELEASE_TRUST) {
    throw new Error('candidate and stable release locks require signed SBOM trust v2');
  }
  const names = Object.keys(lock.components ?? {});
  const expectedNames = Object.keys(COMPONENTS);
  if (names.length !== expectedNames.length || expectedNames.some((name) => !names.includes(name))) {
    throw new Error('Release lock component set is not canonical');
  }
  for (const [name, repository] of Object.entries(COMPONENTS)) {
    const component = lock.components[name];
    const image = component?.image;
    if (component?.repository !== repository) {
      throw new Error(`Component ${name} repository is not canonical`);
    }
    if (!new RegExp(`^${REGISTRY}/${OWNER}/${repository}@sha256:[a-f0-9]{64}$`).test(image ?? '')) {
      throw new Error(`Component ${name} is not digest-pinned`);
    }
    if (component.sourceRevision !== lock.sourceRevision) {
      throw new Error(`Component ${name} source revision differs from the release`);
    }
  }
  const expectedDigest = calculateReleaseDigest(lock.channel, lock.components, trust);
  if (lock.releaseDigest !== expectedDigest) {
    throw new Error('Release lock digest does not match its component set');
  }
  return lock;
}

export async function resolveChannel(channel, {
  resolveImageFn = resolveImage,
  verifyImage = verifyImageProvenance,
  verifySbom = verifyImageSbom
} = {}) {
  validateChannel(channel);
  const resolved = await Promise.all(Object.entries(COMPONENTS).map(async ([name, repository]) => [
    name,
    { repository, ...await resolveImageFn(repository, channel) }
  ]));
  const components = Object.fromEntries(resolved);
  const revisions = new Set(Object.values(components).map((component) => component.sourceRevision));
  if (revisions.size !== 1) {
    throw new Error(`Channel ${channel} is not atomic: component source revisions differ`);
  }
  const [sourceRevision] = revisions;
  const releaseDigest = calculateReleaseDigest(channel, components);
  const lock = {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel,
    releaseDigest,
    resolvedAt: new Date().toISOString(),
    source: SOURCE,
    sourceRevision,
    trust: RELEASE_TRUST,
    components
  };
  return verifyReleaseProvenance(lock, { verifyImage, verifySbom });
}
