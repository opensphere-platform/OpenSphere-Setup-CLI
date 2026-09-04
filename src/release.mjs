import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fetchWithRetry } from './http.mjs';
import {
  CANONICAL_AGENT_COMPONENTS,
  canonicalNameForInstalledComponent,
  installedNameForCanonicalComponent,
  isAgentIdentityCutover,
  legacyInstalledComponentMap
} from './release-agent-identity-cutover.mjs';

export const RELEASE_API_VERSION = 'release.opensphere.io/v1alpha1';
export const RELEASE_BOM_PREDICATE = 'https://opensphere.io/attestations/release-bom/v1';
export const RELEASE_SCOPE_INTEGRATED = 'integrated';
export const RELEASE_SCOPE_COMPONENT = 'component';
export const REGISTRY = 'ghcr.io';
export const OWNER = 'opensphere-platform';
export const SOURCE = 'https://github.com/opensphere-platform/OpenSphere-console';
export const SUPABASE_MIGRATION_MANIFEST_PATH = 'migrations/manifest.json';
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
  // Promotion and GA images are rebuilt only by the dedicated GA workflow.
  // The retired edge workflow remains recorded solely in LEGACY_RELEASE_TRUST
  // so an already-installed pre-policy lock can be identified and rejected
  // from every new promotion path.
  signerWorkflow: 'opensphere-platform/OpenSphere-console/.github/workflows/publish-candidate-images.yml',
  oidcIssuer: LEGACY_RELEASE_TRUST.oidcIssuer,
  sourceRef: LEGACY_RELEASE_TRUST.sourceRef,
  provenancePredicate: 'https://slsa.dev/provenance/v1',
  sbomPredicate: 'https://spdx.dev/Document/v2.3'
});

// This exact trust root was used by the retired GitHub Actions edge publisher.
// It is retained only to read an already-installed edge lock as an explicit
// rollback baseline during the one-way transition to localhost edge releases.
// It can never resolve, verify, or install a new release target.
export const RETIRED_EDGE_ATTESTATION_TRUST = Object.freeze({
  type: 'github-actions-attestation/v2',
  repository: LEGACY_RELEASE_TRUST.repository,
  signerWorkflow: LEGACY_RELEASE_TRUST.signerWorkflow,
  oidcIssuer: LEGACY_RELEASE_TRUST.oidcIssuer,
  sourceRef: LEGACY_RELEASE_TRUST.sourceRef,
  provenancePredicate: 'https://slsa.dev/provenance/v1',
  sbomPredicate: 'https://spdx.dev/Document/v2.3'
});

// Edge is the development channel. A developer with GHCR write permission may
// publish one host-native platform from the governed local publisher. This
// trust class is deliberately ineligible for candidate/stable promotion and
// never substitutes for the GitHub Actions attestation trust above.
export const LOCAL_EDGE_TRUST = Object.freeze({
  type: 'localhost-edge/v1',
  repository: LEGACY_RELEASE_TRUST.repository,
  publisher: 'scripts/Publish-LocalEdge.ps1',
  buildAuthority: 'localhost',
  releaseClass: 'pre-ga',
  gaEligible: false
});

function report(onProgress, event) {
  if (typeof onProgress === 'function') onProgress(event);
}

export const COMPONENTS = Object.freeze({
  console: 'opensphere-console',
  consoleApi: 'opensphere-console-api',
  extensionController: 'opensphere-extension-controller',
  registry: 'opensphere-registry',
  osaaGateway: 'opensphere-console-osaa-gateway',
  osdst: 'opensphere-osdst',
  osaaGovernedAdapter: 'opensphere-osaa-governed-adapter',
  notificationDispatcher: 'opensphere-console-notification-dispatcher',
  gitea: 'opensphere-console-gitea',
  supabasePostgres: 'opensphere-console-supabase-postgres',
  supabaseAuth: 'opensphere-console-supabase-auth',
  supabaseRest: 'opensphere-console-supabase-rest',
  supabaseStorage: 'opensphere-console-supabase-storage',
  giteaPostgres: 'opensphere-console-gitea-postgres',
  recovery: 'opensphere-console-recovery',
  beszelHub: 'opensphere-console-beszel-hub',
  beszelAgent: 'opensphere-console-beszel-agent',
  beszelBootstrap: 'opensphere-console-beszel-bootstrap'
});

export const HISTORICAL_COMPONENTS = Object.freeze({
  console: 'opensphere-console',
  backend: 'opensphere-console-backend',
  dupaController: 'opensphere-console-dupa-controller',
  registry: 'opensphere-registry',
  osaaGateway: 'opensphere-console-osaa-gateway',
  osdst: 'opensphere-osdst',
  osaaGovernedAdapter: 'opensphere-osaa-governed-adapter',
  notificationDispatcher: 'opensphere-console-notification-dispatcher',
  gitea: 'opensphere-console-gitea',
  supabasePostgres: 'opensphere-console-supabase-postgres',
  supabaseAuth: 'opensphere-console-supabase-auth',
  supabaseRest: 'opensphere-console-supabase-rest',
  supabaseStorage: 'opensphere-console-supabase-storage',
  giteaPostgres: 'opensphere-console-gitea-postgres',
  recovery: 'opensphere-console-recovery'
});

const LEGACY_INSTALLED_COMPONENTS = legacyInstalledComponentMap(HISTORICAL_COMPONENTS);

// Runtime-distributed artifacts are independently published and deployed but
// are not part of the canonical Console component lifecycle. They
// remain digest-pinned in the installation lock so a mutable auxiliary tag can
// never decide which executable a fresh cluster serves.
export const AUXILIARY_ARTIFACTS = Object.freeze({
  cliArtifacts: 'opensphere-os-cli',
  osShellControl: 'opensphere-console-os-shell-control',
  osShellRuntime: 'opensphere-os-shell-runtime',
  consoleIndexContent: 'opensphere-console-index-content'
});

export const BOOTSTRAP_AUXILIARY_ARTIFACTS = Object.freeze([
  'cliArtifacts',
  'osShellControl',
  'osShellRuntime',
  'consoleIndexContent'
]);
const LEGACY_AUXILIARY_ARTIFACTS = Object.freeze(
  Object.fromEntries(Object.entries(AUXILIARY_ARTIFACTS).filter(([name]) => name !== 'consoleIndexContent'))
);

export function auxiliaryCatalogForAnchor(anchor) {
  const contract = anchor.labels?.['io.opensphere.console-index-content'];
  if (contract !== undefined && contract !== 'console-index-renderer/v1') {
    throw new Error('Unsupported Console index renderer contract');
  }
  return contract ? AUXILIARY_ARTIFACTS : LEGACY_AUXILIARY_ARTIFACTS;
}
export const AVAILABLE_AUXILIARY_ARTIFACTS = Object.freeze([]);

// The canonical distribution catalog is complete even though Setup deploys only
// BOOTSTRAP_CORE_COMPONENTS. Console activates AVAILABLE_MODULE_COMPONENTS later
// from the exact digests retained in the same installation lock.
export const BASE_RUNTIME_COMPONENTS = Object.freeze(Object.keys(COMPONENTS));

export const BOOTSTRAP_CORE_COMPONENTS = Object.freeze([
  'console',
  'consoleApi',
  'extensionController',
  'registry',
  'osaaGateway',
  'osdst',
  'gitea',
  'giteaPostgres',
  'supabasePostgres',
  'supabaseAuth',
  'supabaseRest',
  'supabaseStorage',
  'beszelHub',
  'beszelAgent',
  'beszelBootstrap'
]);

export const AVAILABLE_MODULE_COMPONENTS = Object.freeze([
  'osaaGovernedAdapter',
  'notificationDispatcher',
  'recovery'
]);

export function releaseResponsibilityProfile(components = COMPONENTS, auxiliaryArtifacts = AUXILIARY_ARTIFACTS) {
  const names = new Set(Object.keys(components));
  const auxiliaryNames = new Set(Object.keys(auxiliaryArtifacts ?? {}));
  const missingBootstrapCore = BOOTSTRAP_CORE_COMPONENTS.filter((name) => !names.has(name));
  const missingAvailableModules = AVAILABLE_MODULE_COMPONENTS.filter((name) => !names.has(name));
  const missingBootstrapArtifacts = BOOTSTRAP_AUXILIARY_ARTIFACTS.filter((name) => !auxiliaryNames.has(name));
  const missingAvailableArtifacts = AVAILABLE_AUXILIARY_ARTIFACTS.filter((name) => !auxiliaryNames.has(name));
  return Object.freeze({
    bootstrapCore: Object.freeze(BOOTSTRAP_CORE_COMPONENTS.filter((name) => names.has(name))),
    availableModules: Object.freeze(AVAILABLE_MODULE_COMPONENTS.filter((name) => names.has(name))),
    bootstrapAuxiliaryArtifacts: Object.freeze(BOOTSTRAP_AUXILIARY_ARTIFACTS.filter((name) => auxiliaryNames.has(name))),
    availableAuxiliaryArtifacts: Object.freeze(AVAILABLE_AUXILIARY_ARTIFACTS.filter((name) => auxiliaryNames.has(name))),
    missingBootstrapCore: Object.freeze(missingBootstrapCore),
    missingAvailableModules: Object.freeze(missingAvailableModules),
    missingBootstrapArtifacts: Object.freeze(missingBootstrapArtifacts),
    missingAvailableArtifacts: Object.freeze(missingAvailableArtifacts)
  });
}

const HISTORICAL_BASE_RUNTIME_COMPONENTS = Object.freeze(Object.keys(HISTORICAL_COMPONENTS));

// Installed releases from before OSDST became an independent CBSS service are
// accepted only as upgrade baselines. Newly resolved releases remain strict.
export const PRE_OSDST_BASE_RUNTIME_COMPONENTS = Object.freeze(
  HISTORICAL_BASE_RUNTIME_COMPONENTS.filter((name) => name !== 'osdst')
);

// Registry & Catalog was introduced after the immediately preceding historical
// component set. It is accepted only as an installed transition baseline.
export const PRE_REGISTRY_BASE_RUNTIME_COMPONENTS = Object.freeze(
  HISTORICAL_BASE_RUNTIME_COMPONENTS.filter((name) => name !== 'registry')
);

// Releases published before both recovery and OSDST were governed contain
// this exact historical set. They remain rollback/upgrade baselines only.
export const LEGACY_BASE_RUNTIME_COMPONENTS = Object.freeze(
  HISTORICAL_BASE_RUNTIME_COMPONENTS.filter((name) => name !== 'recovery' && name !== 'osdst')
);

// Promotion channels remain multi-platform. Edge may contain only the
// platform(s) used by the target development cluster.
export const RELEASE_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);
const LOCAL_EDGE_LABELS = Object.freeze({
  'io.opensphere.channel': 'edge',
  'opensphere.io/build-authority': 'localhost',
  'opensphere.io/release-class': 'pre-ga',
  'opensphere.io/ga-eligible': 'false'
});
const RELEASE_METADATA_LABELS = Object.freeze([
  'io.opensphere.console-index-content',
  'io.opensphere.channel',
  'io.opensphere.release-tag',
  'io.opensphere.source-revision',
  'io.opensphere.release-scope',
  'opensphere.io/build-authority',
  'opensphere.io/release-class',
  'opensphere.io/ga-eligible'
]);

export function defaultEdgePlatforms(platform = process.platform, arch = process.arch) {
  const architecture = arch === 'x64' ? 'amd64' : arch;
  if (!['amd64', 'arm64'].includes(architecture)) {
    throw new Error(`Unsupported edge architecture: ${platform}/${arch}`);
  }
  return [`linux/${architecture}`];
}

function canonicalRequiredPlatforms(platforms = RELEASE_PLATFORMS) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('At least one target Linux platform is required');
  }
  const unique = [...new Set(platforms)];
  if (unique.length !== platforms.length || unique.some((platform) => !RELEASE_PLATFORMS.includes(platform))) {
    throw new Error(`Unsupported or duplicate target platform set: ${platforms.join(', ')}`);
  }
  return unique;
}

function ghToken() {
  if (process.env.GHCR_TOKEN) return process.env.GHCR_TOKEN.trim();
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function ghUsername() {
  if (process.env.GHCR_USERNAME) return process.env.GHCR_USERNAME.trim();
  try {
    return execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return OWNER;
  }
}

export function normalizeRegistryCredentials(credentials) {
  if (!credentials) return null;
  const username = String(credentials.username ?? '').trim();
  const token = String(credentials.token ?? '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(username)) {
    throw new Error('GHCR registry username is invalid');
  }
  if (!token) throw new Error('GHCR registry token is empty');
  return { username, token };
}

// Host credentials are a convenience for an authenticated developer machine,
// never release metadata.  The token is kept in memory and must not be written
// into a release lock, ConfigMap, URL, argv or log.
export function hostRegistryCredentials() {
  const token = ghToken();
  return token ? normalizeRegistryCredentials({ username: ghUsername(), token }) : null;
}

async function requestRegistryToken(endpoint, fetchImpl, credentials) {
  const headers = credentials
    ? { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64')}` }
    : {};
  return fetchWithRetry(endpoint, { headers }, { fetchImpl });
}

async function registryToken(repository, fetchImpl, suppliedCredentials) {
  const endpoint = new URL(`https://${REGISTRY}/token`);
  endpoint.searchParams.set('service', REGISTRY);
  endpoint.searchParams.set('scope', `repository:${OWNER}/${repository}:pull`);

  // Public packages are deliberately resolved anonymously even when the host
  // happens to be logged in.  This proves that a public release has no hidden
  // credential dependency and avoids sending a credential unnecessarily.
  let response = await requestRegistryToken(endpoint, fetchImpl, null);
  if (response.ok) {
    const body = await response.json();
    if (!body.token) throw new Error(`GHCR did not issue an anonymous pull token for ${repository}`);
    return { token: body.token, credentialsRequired: false };
  }
  if (![401, 403].includes(response.status)) {
    throw new Error(`GHCR anonymous token request failed for ${repository}: HTTP ${response.status}`);
  }

  const credentials = normalizeRegistryCredentials(
    suppliedCredentials === undefined ? hostRegistryCredentials() : suppliedCredentials
  );
  if (!credentials) {
    throw new Error(`GHCR package ${repository} is private; provide a read-only registry credential`);
  }
  response = await requestRegistryToken(endpoint, fetchImpl, credentials);
  if (!response.ok) throw new Error(`GHCR authenticated token request failed for ${repository}: HTTP ${response.status}`);
  const body = await response.json();
  if (!body.token) throw new Error(`GHCR did not issue a pull token for ${repository}`);
  return { token: body.token, credentialsRequired: true };
}

export function requiredPlatformDescriptors(index, repository, requiredPlatforms = RELEASE_PLATFORMS) {
  if (!Array.isArray(index?.manifests)) {
    throw new Error(`${repository} must publish a multi-platform image index`);
  }
  const required = canonicalRequiredPlatforms(requiredPlatforms);
  const found = new Map(index.manifests
    .filter((entry) => entry?.platform?.os === 'linux' && typeof entry?.platform?.architecture === 'string')
    .map((entry) => [`${entry.platform.os}/${entry.platform.architecture}`, entry]));
  return required.map((platform) => {
    const descriptor = found.get(platform);
    if (!/^sha256:[a-f0-9]{64}$/.test(descriptor?.digest ?? '')) {
      throw new Error(`${repository} is missing required ${platform} manifest`);
    }
    return descriptor;
  });
}

async function inspectRegistryImage(repository, reference, expectedDigest, {
  fetchImpl = fetch,
  registryCredentials,
  requiredPlatforms = RELEASE_PLATFORMS
} = {}) {
  const authorization = await registryToken(repository, fetchImpl, registryCredentials);
  const token = authorization.token;
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
  const response = await fetchWithRetry(`${base}/manifests/${reference}`, {
    headers: {
      ...headers
    }
  }, { fetchImpl });
  if (!response.ok) {
    throw new Error(`${REGISTRY}/${OWNER}/${repository}:${reference} not available: HTTP ${response.status}`);
  }
  const digest = response.headers.get('docker-content-digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new Error(`Invalid registry digest for ${repository}:${reference}`);
  }
  if (expectedDigest && digest !== expectedDigest) {
    throw new Error(`Registry digest for ${repository} differs from the signed release BOM`);
  }
  const document = await response.json();
  const descriptors = requiredPlatformDescriptors(document, repository, requiredPlatforms);
  const manifests = await Promise.all(descriptors.map(async (descriptor) => {
    const platformResponse = await fetchWithRetry(`${base}/manifests/${descriptor.digest}`, { headers }, { fetchImpl });
    if (!platformResponse.ok) throw new Error(`Platform manifest unavailable for ${repository}: HTTP ${platformResponse.status}`);
    return platformResponse.json();
  }));
  const configs = await Promise.all(manifests.map(async (manifest) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest ?? '')) {
      throw new Error(`Image config descriptor missing for ${repository}:${reference}`);
    }
    const configResponse = await fetchWithRetry(`${base}/blobs/${manifest.config.digest}`, {
      headers: { authorization: `Bearer ${token}` }
    }, { fetchImpl });
    if (!configResponse.ok) throw new Error(`Image config unavailable for ${repository}: HTTP ${configResponse.status}`);
    return configResponse.json();
  }));
  const revisions = new Set(configs.map((config) => config.config?.Labels?.['io.opensphere.source-revision']));
  if (revisions.size !== 1 || !/^[a-f0-9]{40}$/.test([...revisions][0] ?? '')) {
    throw new Error(`Source revision labels differ across required platforms for ${repository}:${reference}`);
  }
  const metadata = Object.fromEntries(RELEASE_METADATA_LABELS.map((label) => {
    const values = new Set(configs.map((config) => config.config?.Labels?.[label]).filter((value) => value !== undefined));
    if (values.size > 1) {
      throw new Error(`Release metadata label ${label} differs across required platforms for ${repository}:${reference}`);
    }
    return [label, [...values][0]];
  }));
  const [sourceRevision] = revisions;
  return {
    image: `${REGISTRY}/${OWNER}/${repository}@${digest}`,
    sourceRevision,
    labels: metadata,
    platforms: canonicalRequiredPlatforms(requiredPlatforms),
    registryCredentialsRequired: authorization.credentialsRequired
  };
}

export async function resolveImage(repository, channel, options = {}) {
  return inspectRegistryImage(repository, channel, null, options);
}

export async function inspectImageReference(repository, image, options = {}) {
  const prefix = `${REGISTRY}/${OWNER}/${repository}@`;
  if (!String(image ?? '').startsWith(prefix)) {
    throw new Error(`Signed release BOM image repository differs for ${repository}`);
  }
  const digest = String(image).slice(prefix.length);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Signed release BOM image is not digest-pinned for ${repository}`);
  }
  return inspectRegistryImage(repository, digest, digest, options);
}

export function validateChannel(channel) {
  if (!['edge', 'candidate', 'stable'].includes(channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function calculateReleaseBomDigest(bom) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(bom))).digest('hex')}`;
}

export function calculateReleaseDigest(
  channel,
  components,
  trust = RELEASE_TRUST,
  releaseBom,
  contract
) {
  const payload = JSON.stringify({
    channel,
    components,
    trust,
    ...(releaseBom ? { releaseBom } : {}),
    ...(contract?.releaseScope ? { releaseScope: contract.releaseScope } : {}),
    ...(contract?.baseReleaseDigest ? { baseReleaseDigest: contract.baseReleaseDigest } : {}),
    ...(contract?.changedComponents ? { changedComponents: contract.changedComponents } : {}),
    ...(contract?.changedAuxiliaryArtifacts
      ? { changedAuxiliaryArtifacts: contract.changedAuxiliaryArtifacts }
      : {}),
    ...(contract?.auxiliaryArtifacts ? { auxiliaryArtifacts: contract.auxiliaryArtifacts } : {})
  });
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
  for (const trust of [RELEASE_TRUST, RETIRED_EDGE_ATTESTATION_TRUST, LEGACY_RELEASE_TRUST, LOCAL_EDGE_TRUST]) {
    const keys = Object.keys(trust);
    if (candidate && Object.keys(candidate).length === keys.length && keys.every((key) => candidate[key] === trust[key])) {
      return trust;
    }
  }
  return null;
}

export function isLocalEdgeLock(lock) {
  return lock?.channel === 'edge' && canonicalTrust(lock?.trust) === LOCAL_EDGE_TRUST;
}

export function isRetiredEdgeAttestationLock(lock) {
  return lock?.channel === 'edge' && canonicalTrust(lock?.trust) === RETIRED_EDGE_ATTESTATION_TRUST;
}

function attestationArgs(image, predicateType) {
  return [
    'attestation', 'verify', `oci://${image}`,
    // `actions/attest` publishes the signed bundle alongside the immutable
    // subject in GHCR.  Resolve it there rather than through the GitHub API:
    // package-attestation API indexing is asynchronous and must not decide
    // whether a newly published, otherwise valid release is installable.
    '--bundle-from-oci',
    '--repo', RELEASE_TRUST.repository,
    '--signer-workflow', RELEASE_TRUST.signerWorkflow,
    '--cert-oidc-issuer', RELEASE_TRUST.oidcIssuer,
    '--source-ref', RELEASE_TRUST.sourceRef,
    '--deny-self-hosted-runners',
    ...(predicateType ? ['--predicate-type', predicateType] : [])
  ];
}

const RETRYABLE_ATTESTATION_STATUS = /\bHTTP\s+(?:408|425|429|500|502|503|504)\b/i;

function delaySync(milliseconds) {
  // `gh attestation verify` is a synchronous subprocess today. Keep its retry
  // boundary synchronous too: a metadata outage may delay a release, never
  // weaken the signature, workflow, repository, or predicate checks.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function verifyImageAttestation(image, predicateType, subjectError, failureLabel, {
  execFile = execFileSync,
  attempts = 4,
  baseDelayMs = 500,
  sleep = delaySync,
  authToken
} = {}) {
  if (!canonicalImage(image)) throw new Error(subjectError);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      execFile('gh', attestationArgs(image, predicateType), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(authToken ? { env: { ...process.env, GH_TOKEN: authToken } } : {})
      });
      return { image, trust: RELEASE_TRUST };
    } catch (error) {
      lastError = error;
      const detail = String(error?.stderr ?? error?.message ?? 'unknown failure').trim();
      if (!RETRYABLE_ATTESTATION_STATUS.test(detail) || attempt === attempts) {
        throw new Error(`${failureLabel} for ${image}: ${detail}`);
      }
      sleep(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function canonicalComponentProfile(components, { allowLegacyComponentSet = false } = {}) {
  const names = Object.keys(components ?? {});
  const current = Object.keys(COMPONENTS);
  if (names.length === current.length && current.every((name) => names.includes(name))) {
    return { names: current, repositories: COMPONENTS };
  }
  if (allowLegacyComponentSet) {
    for (const historical of [
      HISTORICAL_BASE_RUNTIME_COMPONENTS,
      PRE_REGISTRY_BASE_RUNTIME_COMPONENTS,
      PRE_OSDST_BASE_RUNTIME_COMPONENTS,
      LEGACY_BASE_RUNTIME_COMPONENTS
    ]) {
      if (names.length === historical.length && historical.every((name) => names.includes(name))) {
        return { names: historical, repositories: HISTORICAL_COMPONENTS };
      }
    }
  }
  return null;
}

function canonicalComponentNames(components, options = {}) {
  return canonicalComponentProfile(components, options)?.names ?? null;
}

function installedComponentProfile(components, {
  allowLegacyComponentSet = false,
  allowInstalledAgentIdentityCutover = false
} = {}) {
  const canonicalProfile = canonicalComponentProfile(components, { allowLegacyComponentSet });
  if (canonicalProfile) {
    return { ...canonicalProfile, agentIdentity: 'canonical' };
  }
  const names = Object.keys(components ?? {});
  const legacyNames = Object.keys(LEGACY_INSTALLED_COMPONENTS);
  if (allowInstalledAgentIdentityCutover
      && names.length === legacyNames.length
      && legacyNames.every((name) => names.includes(name))) {
    return {
      names: legacyNames,
      repositories: LEGACY_INSTALLED_COMPONENTS,
      agentIdentity: 'installed-pre-osaa'
    };
  }
  return null;
}

export function validateReleaseBom(bom, {
  channel,
  subject,
  allowLegacyComponentSet = false,
  allowLegacyReleaseArtifacts = false,
  requiredPlatforms
} = {}) {
  if (bom?.apiVersion !== RELEASE_API_VERSION || bom?.kind !== 'OpenSphereReleaseBOM') {
    throw new Error('Invalid signed OpenSphere release BOM');
  }
  validateChannel(bom.channel);
  if (channel && bom.channel !== channel) throw new Error('Signed release BOM channel differs from the requested channel');
  const installableStatus = bom.channel === 'candidate' ? 'Candidate' : 'Active';
  if (bom.status !== installableStatus) {
    throw new Error(`Signed release BOM status differs from ${bom.channel} policy: ${bom.status ?? 'missing status'}`);
  }
  if (bom.source !== SOURCE || !/^[a-f0-9]{40}$/.test(bom.sourceRevision ?? '')
      || !/^\d{12}$/u.test(bom.releaseTag ?? '')) {
    throw new Error('Signed release BOM source identity or immutable release tag is invalid');
  }
  const platforms = Array.isArray(bom.supportedPlatforms) ? [...new Set(bom.supportedPlatforms)] : [];
  const canonicalPlatformSet = platforms.length === bom.supportedPlatforms?.length
    && platforms.length > 0
    && platforms.every((platform) => RELEASE_PLATFORMS.includes(platform))
    && (bom.channel === 'edge'
      || (platforms.length === RELEASE_PLATFORMS.length
        && RELEASE_PLATFORMS.every((platform) => platforms.includes(platform))));
  if (!canonicalPlatformSet) {
    throw new Error('Signed release BOM platform set is not canonical');
  }
  if (requiredPlatforms) {
    const required = canonicalRequiredPlatforms(requiredPlatforms);
    const missing = required.filter((platform) => !platforms.includes(platform));
    if (missing.length) {
      throw new Error(`Release BOM does not support target platform(s): ${missing.join(', ')}`);
    }
  }
  const componentProfile = canonicalComponentProfile(bom.components, { allowLegacyComponentSet });
  if (!componentProfile) {
    throw new Error('Signed release BOM component set is not canonical');
  }
  const { names: expectedNames, repositories } = componentProfile;
  for (const name of expectedNames) {
    const repository = repositories[name];
    const component = bom.components[name];
    if (component?.repository !== repository) {
      throw new Error(`Signed release BOM component ${name} repository is not canonical`);
    }
    if (!new RegExp(`^${REGISTRY}/${OWNER}/${repository}@sha256:[a-f0-9]{64}$`).test(component?.image ?? '')) {
      throw new Error(`Signed release BOM component ${name} is not digest-pinned`);
    }
    if (component.sourceRevision !== bom.sourceRevision) {
      throw new Error(`Signed release BOM component ${name} source revision differs`);
    }
  }
  if (subject && bom.components.console.image !== subject) {
    throw new Error('Signed release BOM subject is not its Console anchor image');
  }
  const migration = bom.artifacts?.supabaseMigrationManifest;
  const validMigrationEvidence = migration?.path === SUPABASE_MIGRATION_MANIFEST_PATH
    && /^sha256:[a-f0-9]{64}$/.test(migration?.sha256 ?? '')
    && /^sha256:[a-f0-9]{64}$/.test(migration?.setDigest ?? '')
    && /^opensphere-console\/[0-9]{8}\/[0-9]{4}$/.test(migration?.latestGlobalId ?? '')
    && Number.isInteger(migration?.migrationCount) && migration.migrationCount > 0;
  if (!validMigrationEvidence && !allowLegacyReleaseArtifacts) {
    throw new Error('Signed release BOM lacks canonical Supabase migration manifest evidence');
  }
  return bom;
}

export function releaseBomPointer(bom, subject = bom?.components?.console?.image, options = {}) {
  const validated = validateReleaseBom(bom, { subject, ...options });
  return {
    predicateType: RELEASE_BOM_PREDICATE,
    subject,
    digest: calculateReleaseBomDigest(validated),
    releaseTag: validated.releaseTag,
    ...(validated.artifacts?.supabaseMigrationManifest
      ? { migrationManifest: structuredClone(validated.artifacts.supabaseMigrationManifest) }
      : {})
  };
}

export function assertSignedReleaseBom(lock) {
  const pointer = lock?.releaseBom;
  const consoleImage = lock?.components?.console?.image;
  if (pointer?.predicateType !== RELEASE_BOM_PREDICATE
      || pointer?.subject !== consoleImage
      || !/^sha256:[a-f0-9]{64}$/.test(pointer?.digest ?? '')
      || !/^\d{12}$/u.test(pointer?.releaseTag ?? '')) {
    throw new Error('Release lock has no governed signed Release BOM');
  }
  return pointer;
}

export function verifyReleaseBomAttestation(subject, {
  execFile = execFileSync,
  attempts = 4,
  baseDelayMs = 500,
  sleep = delaySync,
  authToken,
  channel,
  allowLegacyComponentSet = false,
  allowLegacyReleaseArtifacts = false,
  requiredPlatforms
} = {}) {
  if (!canonicalImage(subject)) throw new Error('Release BOM subject is not a governed digest-pinned image');
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = execFile('gh', [...attestationArgs(subject, RELEASE_BOM_PREDICATE), '--format', 'json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(authToken ? { env: { ...process.env, GH_TOKEN: authToken } } : {})
      });
      const entries = JSON.parse(output);
      if (!Array.isArray(entries) || entries.length === 0) throw new Error('verified attestation output is empty');
      const boms = entries
        .map((entry) => validateReleaseBom(entry?.verificationResult?.statement?.predicate, {
          subject,
          allowLegacyComponentSet,
          allowLegacyReleaseArtifacts,
          requiredPlatforms
        }))
        .filter((bom) => !channel || bom.channel === channel);
      if (boms.length === 0) throw new Error(`no signed Release BOM exists for channel ${channel ?? 'any'}`);
      const digests = new Set(boms.map(calculateReleaseBomDigest));
      if (digests.size !== 1) throw new Error('multiple different signed Release BOMs exist for one immutable subject');
      return { bom: boms[0], digest: [...digests][0], subject };
    } catch (error) {
      lastError = error;
      const detail = String(error?.stderr ?? error?.message ?? 'unknown failure').trim();
      if (!RETRYABLE_ATTESTATION_STATUS.test(detail) || attempt === attempts) {
        throw new Error(`Release BOM attestation verification failed for ${subject}: ${detail}`);
      }
      sleep(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

// `gh attestation verify --bundle-from-oci` verifies the registry-bound
// certificate chain, OIDC issuer, workflow path, repository and source ref.
// Its non-zero exit is intentionally fatal: an unsigned image must never become
// an installation lock merely because its tag resolved to a syntactically valid
// digest.
export function verifyImageProvenance(image, options = {}) {
  return verifyImageAttestation(
    image,
    RELEASE_TRUST.provenancePredicate,
    'Attestation subject is not a governed digest-pinned image',
    'Image provenance verification failed',
    options
  );
}

export function verifyImageSbom(image, options = {}) {
  return verifyImageAttestation(
    image,
    RELEASE_TRUST.sbomPredicate,
    'SBOM subject is not a governed digest-pinned image',
    'Image SPDX SBOM verification failed',
    options
  );
}


export function assertReleaseArtifactMetadata(image, {
  repository,
  sourceRevision,
  releaseTag,
  artifactScope
} = {}) {
  const labels = image?.labels ?? {};
  if (!['canonical', 'auxiliary'].includes(artifactScope)
      || labels['io.opensphere.release-scope'] !== artifactScope) {
    throw new Error(`Release image ${repository ?? 'artifact'} has invalid io.opensphere.release-scope label`);
  }
  if (image?.sourceRevision !== sourceRevision
      || labels['io.opensphere.source-revision'] !== sourceRevision) {
    throw new Error(`Release image ${repository ?? 'artifact'} source revision differs from the signed release`);
  }
  if (!/^\d{12}$/u.test(releaseTag ?? '')
      || labels['io.opensphere.release-tag'] !== releaseTag) {
    throw new Error(`Release image ${repository ?? 'artifact'} release tag differs from the signed release`);
  }
  return image;
}

export function assertLocalEdgeImage(image, {
  repository,
  sourceRevision,
  releaseTag,
  artifactScope = 'canonical'
} = {}) {
  const labels = image?.labels ?? {};
  for (const [name, expected] of Object.entries(LOCAL_EDGE_LABELS)) {
    if (labels[name] !== expected) {
      throw new Error(`Local edge image ${repository ?? 'component'} has invalid ${name} label`);
    }
  }
  if (!['canonical', 'auxiliary'].includes(artifactScope)
      || labels['io.opensphere.release-scope'] !== artifactScope) {
    throw new Error('Local edge image ' + (repository ?? 'component') + ' has invalid io.opensphere.release-scope label');
  }
  if (!/^[a-f0-9]{40}$/.test(image?.sourceRevision ?? '')
      || labels['io.opensphere.source-revision'] !== image.sourceRevision) {
    throw new Error(`Local edge image ${repository ?? 'component'} has invalid source revision labels`);
  }
  const observedReleaseTag = labels['io.opensphere.release-tag'];
  if (!/^\d{12}$/.test(observedReleaseTag ?? '')) {
    throw new Error(`Local edge image ${repository ?? 'component'} has invalid date release tag`);
  }
  if (sourceRevision && image.sourceRevision !== sourceRevision) {
    throw new Error(`Local edge image ${repository ?? 'component'} source revision differs from the Console anchor`);
  }
  if (releaseTag && observedReleaseTag !== releaseTag) {
    throw new Error(`Local edge image ${repository ?? 'component'} release tag differs from the Console anchor`);
  }
  return {
    sourceRevision: image.sourceRevision,
    releaseTag: observedReleaseTag,
    immutableTag: `local-${image.sourceRevision.slice(0, 12)}`
  };
}

async function verifyLocalEdgeLock(lock, {
  inspectImageFn = inspectImageReference,
  registryCredentials,
  requiredPlatforms = defaultEdgePlatforms(),
  onProgress,
  allowLegacyComponentSet = false,
  allowInstalledAgentIdentityCutover = false
} = {}) {
  const validated = validateLock(lock, {
    allowLegacyComponentSet,
    allowInstalledAgentIdentityCutover
  });
  if (canonicalTrust(validated.trust) !== LOCAL_EDGE_TRUST || validated.channel !== 'edge') {
    throw new Error('Only a localhost edge lock may use local image verification');
  }
  const releaseEntries = [
    ...Object.entries(validated.components).map(([name, component]) => [name, component, 'canonical']),
    ...Object.entries(validated.auxiliaryArtifacts ?? {}).map(([name, component]) => [name, component, 'auxiliary'])
  ];
  const metadata = await Promise.all(releaseEntries.map(async ([name, component, artifactScope]) => {
    report(onProgress, { type: 'local-component-start', component: name, image: component.image });
    const inspected = await inspectImageFn(component.repository, component.image, {
      registryCredentials,
      requiredPlatforms
    });
    if (inspected.image !== component.image) {
      throw new Error(`Local edge image ${name} differs from the release lock`);
    }
    const observed = assertLocalEdgeImage(inspected, {
      repository: component.repository,
      sourceRevision: component.sourceRevision,
      artifactScope
    });
    report(onProgress, { type: 'local-component-complete', component: name, image: component.image });
    return { name, ...observed };
  }));
  const releaseScope = validated.releaseScope ?? RELEASE_SCOPE_INTEGRATED;
  const comparable = releaseScope === RELEASE_SCOPE_COMPONENT
    ? metadata.filter(({ name }) => validated.changedComponents.includes(name))
    : metadata;
  if (new Set(comparable.map(({ releaseTag }) => releaseTag)).size !== 1) {
    throw new Error(
      releaseScope === RELEASE_SCOPE_COMPONENT
        ? 'Changed local edge component release tags differ'
        : 'Local edge component release tags differ'
    );
  }
  return { ...validated, localVerifiedAt: new Date().toISOString() };
}

export async function verifyReleaseProvenance(lock, {
  verifyImage = verifyImageProvenance,
  verifySbom = verifyImageSbom,
  registryCredentials,
  onProgress,
  allowLegacyComponentSet = false,
  allowInstalledAgentIdentityCutover = false
} = {}) {
  const validated = validateLock(lock, {
    allowLegacyComponentSet,
    allowInstalledAgentIdentityCutover
  });
  if (canonicalTrust(validated.trust) !== RELEASE_TRUST) {
    throw new Error('Legacy attestation trust cannot satisfy the signed SBOM release gate');
  }
  const governedArtifacts = [
    ...Object.entries(validated.components),
    ...Object.entries(validated.auxiliaryArtifacts ?? {})
  ];
  await Promise.all(governedArtifacts.map(async ([name, { image }]) => {
    const options = registryCredentials?.token ? { authToken: registryCredentials.token } : undefined;
    report(onProgress, { type: 'provenance-start', component: name, image });
    await verifyImage(image, options);
    report(onProgress, { type: 'provenance-complete', component: name, image });
    report(onProgress, { type: 'sbom-start', component: name, image });
    await verifySbom(image, options);
    report(onProgress, { type: 'sbom-complete', component: name, image });
  }));
  const verifiedAt = new Date().toISOString();
  return { ...validated, provenanceVerifiedAt: verifiedAt, sbomVerifiedAt: verifiedAt };
}

export async function verifyReleaseLock(lock, {
  verifyBom = verifyReleaseBomAttestation,
  verifyImage = verifyImageProvenance,
  verifySbom = verifyImageSbom,
  inspectImageFn = inspectImageReference,
  registryCredentials,
  requiredPlatforms,
  onProgress,
  allowLegacyComponentSet = false,
  allowInstalledAgentIdentityCutover = false,
  allowLegacyReleaseArtifacts = false,
  allowRetiredEdgeRollback = false
} = {}) {
  const validated = validateLock(lock, {
    allowLegacyComponentSet,
    allowInstalledAgentIdentityCutover
  });
  if (isRetiredEdgeAttestationLock(validated)) {
    if (!allowRetiredEdgeRollback) {
      throw new Error('Retired GitHub Actions edge trust is accepted only as an installed rollback baseline');
    }
    if (!Number.isFinite(Date.parse(validated.provenanceVerifiedAt ?? '')) || !Number.isFinite(Date.parse(validated.sbomVerifiedAt ?? ''))) {
      throw new Error('Retired edge rollback baseline lacks recorded provenance/SBOM verification evidence');
    }
    return { ...validated, retiredEdgeRollbackBaseline: true };
  }
  if (isLocalEdgeLock(validated)) {
    return verifyLocalEdgeLock(validated, {
      inspectImageFn,
      registryCredentials,
      requiredPlatforms,
      onProgress,
      allowLegacyComponentSet,
      allowInstalledAgentIdentityCutover
    });
  }
  const pointer = assertSignedReleaseBom(validated);
  report(onProgress, { type: 'bom-start', image: pointer.subject, channel: validated.channel });
  const verifiedBom = await verifyBom(pointer.subject, {
    channel: validated.channel,
    ...(registryCredentials?.token ? { authToken: registryCredentials.token } : {}),
    allowLegacyComponentSet,
    allowLegacyReleaseArtifacts,
    requiredPlatforms
  });
  report(onProgress, { type: 'bom-complete', image: pointer.subject, channel: validated.channel });
  if (verifiedBom.digest !== pointer.digest) {
    throw new Error('Release lock BOM digest differs from the signed Release BOM');
  }
  const bom = validateReleaseBom(verifiedBom.bom, {
    channel: validated.channel,
    subject: pointer.subject,
    allowLegacyComponentSet,
    allowLegacyReleaseArtifacts,
    requiredPlatforms
  });
  const expectedMigrationManifest = bom.artifacts?.supabaseMigrationManifest;
  if (pointer.releaseTag !== bom.releaseTag) {
    throw new Error('Release lock immutable tag differs from the signed Release BOM');
  }
  if (expectedMigrationManifest
      && JSON.stringify(stableValue(pointer.migrationManifest)) !== JSON.stringify(stableValue(expectedMigrationManifest))) {
    throw new Error('Release lock migration manifest evidence differs from the signed Release BOM');
  }
  if (bom.sourceRevision !== validated.sourceRevision) {
    throw new Error('Release lock source revision differs from the signed Release BOM');
  }
  for (const name of Object.keys(validated.components)) {
    const expected = bom.components[name];
    const actual = validated.components[name];
    if (actual.repository !== expected.repository || actual.image !== expected.image || actual.sourceRevision !== expected.sourceRevision) {
      throw new Error(`Release lock component ${name} differs from the signed Release BOM`);
    }
  }
  for (const [name, actual] of Object.entries(validated.auxiliaryArtifacts ?? {})) {
    const inspected = await inspectImageFn(actual.repository, actual.image, {
      registryCredentials,
      requiredPlatforms
    });
    if (inspected.image !== actual.image) {
      throw new Error(`Release lock auxiliary artifact ${name} differs from the registry`);
    }
    assertReleaseArtifactMetadata(inspected, {
      repository: actual.repository,
      sourceRevision: validated.sourceRevision,
      releaseTag: pointer.releaseTag,
      artifactScope: 'auxiliary'
    });
  }
  return verifyReleaseProvenance(validated, {
    verifyImage,
    verifySbom,
    registryCredentials,
    onProgress,
    allowLegacyComponentSet,
    allowInstalledAgentIdentityCutover
  });
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

export function validateLock(lock, {
  allowLegacyComponentSet = false,
  allowInstalledAgentIdentityCutover = false
} = {}) {
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
  if (trust === LOCAL_EDGE_TRUST && lock.channel !== 'edge') {
    throw new Error('Localhost build trust is accepted only for the edge channel');
  }
  if (trust === RETIRED_EDGE_ATTESTATION_TRUST && lock.channel !== 'edge') {
    throw new Error('Retired GitHub Actions edge trust is accepted only for the edge channel');
  }
  if (lock.channel !== 'edge' && trust !== RELEASE_TRUST) {
    throw new Error('candidate and stable release locks require signed SBOM trust v2');
  }
  const releaseScope = lock.releaseScope ?? RELEASE_SCOPE_INTEGRATED;
  if (![RELEASE_SCOPE_INTEGRATED, RELEASE_SCOPE_COMPONENT].includes(releaseScope)) {
    throw new Error(`Release lock scope is invalid: ${releaseScope}`);
  }
  if (releaseScope === RELEASE_SCOPE_INTEGRATED
      && (lock.baseReleaseDigest !== undefined
        || lock.changedComponents !== undefined
        || lock.changedAuxiliaryArtifacts !== undefined)) {
    throw new Error('Integrated release lock cannot declare a component transition');
  }
  if (releaseScope === RELEASE_SCOPE_COMPONENT) {
    if (lock.channel !== 'edge' || trust !== LOCAL_EDGE_TRUST) {
      throw new Error('Component release locks require localhost edge trust');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(lock.baseReleaseDigest ?? '')) {
      throw new Error('Component release lock base digest is invalid');
    }
    const changed = lock.changedComponents ?? [];
    const changedAuxiliary = lock.changedAuxiliaryArtifacts ?? [];
    const canonicalChanged = Array.isArray(changed)
      ? [...new Set(changed)].sort()
      : [];
    const canonicalChangedAuxiliary = Array.isArray(changedAuxiliary)
      ? [...new Set(changedAuxiliary)].sort()
      : [];
    if (!Array.isArray(lock.changedComponents)
        || changed.length !== canonicalChanged.length
        || changed.some((name, index) => name !== canonicalChanged[index])
        || changed.some((name) => !Object.hasOwn(COMPONENTS, name))) {
      throw new Error('Component release lock changedComponents must be a canonical sorted set');
    }
    if (!Array.isArray(changedAuxiliary)
        || changedAuxiliary.length !== canonicalChangedAuxiliary.length
        || changedAuxiliary.some((name, index) => name !== canonicalChangedAuxiliary[index])
        || changedAuxiliary.some((name) => name !== 'consoleIndexContent')) {
      throw new Error('Component release lock changedAuxiliaryArtifacts must contain only the canonical Console index artifact');
    }
    if (changed.length === 0 && changedAuxiliary.length === 0) {
      throw new Error('Component release lock must change at least one component or auxiliary artifact');
    }
    if (lock.releaseBom !== undefined) {
      throw new Error('Component release locks cannot claim a signed Release BOM');
    }
  }
  const componentProfile = installedComponentProfile(lock.components, {
    allowLegacyComponentSet,
    allowInstalledAgentIdentityCutover
  });
  if (!componentProfile) {
    throw new Error('Release lock component set is not canonical');
  }
  const { names: expectedNames, repositories } = componentProfile;
  if (repositories === COMPONENTS
      && [LOCAL_EDGE_TRUST, RELEASE_TRUST].includes(trust)
      && lock.auxiliaryArtifacts === undefined) {
    throw new Error('Current release lock requires the complete governed auxiliary artifact set');
  }
  for (const name of expectedNames) {
    const repository = repositories[name];
    const component = lock.components[name];
    const image = component?.image;
    if (component?.repository !== repository) {
      throw new Error(`Component ${name} repository is not canonical`);
    }
    if (!new RegExp(`^${REGISTRY}/${OWNER}/${repository}@sha256:[a-f0-9]{64}$`).test(image ?? '')) {
      throw new Error(`Component ${name} is not digest-pinned`);
    }
    if (!/^[a-f0-9]{40}$/.test(component.sourceRevision ?? '')) {
      throw new Error(`Component ${name} source revision is invalid`);
    }
    if (releaseScope === RELEASE_SCOPE_INTEGRATED && component.sourceRevision !== lock.sourceRevision) {
      throw new Error(`Component ${name} source revision differs from the release`);
    }
    if (releaseScope === RELEASE_SCOPE_COMPONENT
        && (lock.changedComponents ?? []).includes(name)
        && component.sourceRevision !== lock.sourceRevision) {
      throw new Error(`Changed component ${name} source revision differs from the component release`);
    }
    if (component.registryCredentialsRequired !== undefined && typeof component.registryCredentialsRequired !== 'boolean') {
      throw new Error(`Component ${name} registry credential requirement is invalid`);
    }
  }
  if (lock.auxiliaryArtifacts !== undefined) {
    if (![LOCAL_EDGE_TRUST, RELEASE_TRUST].includes(trust)) {
      throw new Error('Auxiliary runtime artifacts require governed local-edge or signed release trust');
    }
    const names = Object.keys(lock.auxiliaryArtifacts);
    const expectedAuxiliaryNames = Object.keys(
      names.includes('consoleIndexContent') ? AUXILIARY_ARTIFACTS : LEGACY_AUXILIARY_ARTIFACTS
    );
    if (JSON.stringify(names) !== JSON.stringify(expectedAuxiliaryNames)) {
      throw new Error('Release lock auxiliary artifact set is not canonical');
    }
    for (const name of expectedAuxiliaryNames) {
      const repository = AUXILIARY_ARTIFACTS[name];
      const artifact = lock.auxiliaryArtifacts[name];
      if (artifact?.repository !== repository) {
        throw new Error(`Auxiliary artifact ${name} repository is not canonical`);
      }
      if (!new RegExp(`^${REGISTRY}/${OWNER}/${repository}@sha256:[a-f0-9]{64}$`).test(artifact?.image ?? '')) {
        throw new Error(`Auxiliary artifact ${name} is not digest-pinned`);
      }
      if (!/^[a-f0-9]{40}$/.test(artifact?.sourceRevision ?? '')) {
        throw new Error(`Auxiliary artifact ${name} source revision is invalid`);
      }
      if (releaseScope === RELEASE_SCOPE_INTEGRATED
          && artifact.sourceRevision !== lock.sourceRevision) {
        throw new Error(`Auxiliary artifact ${name} source revision differs from the release`);
      }
      if (releaseScope === RELEASE_SCOPE_COMPONENT
          && (lock.changedAuxiliaryArtifacts ?? []).includes(name)
          && artifact.sourceRevision !== lock.sourceRevision) {
        throw new Error(`Changed auxiliary artifact ${name} source revision differs from the component release`);
      }
      if (artifact.registryCredentialsRequired !== undefined
          && typeof artifact.registryCredentialsRequired !== 'boolean') {
        throw new Error(`Auxiliary artifact ${name} registry credential requirement is invalid`);
      }
    }
  }
  if (trust === LOCAL_EDGE_TRUST && lock.releaseBom !== undefined) {
    throw new Error('Local edge release locks cannot claim a signed Release BOM');
  }
  if (lock.releaseBom !== undefined) assertSignedReleaseBom(lock);
  const digestContract = lock.releaseScope
    ? {
        releaseScope,
        ...(releaseScope === RELEASE_SCOPE_COMPONENT
          ? {
              baseReleaseDigest: lock.baseReleaseDigest,
              changedComponents: lock.changedComponents,
              ...(lock.changedAuxiliaryArtifacts !== undefined
                ? { changedAuxiliaryArtifacts: lock.changedAuxiliaryArtifacts }
                : {})
            }
          : {}),
        ...(lock.auxiliaryArtifacts ? { auxiliaryArtifacts: lock.auxiliaryArtifacts } : {})
      }
    : (lock.auxiliaryArtifacts ? { auxiliaryArtifacts: lock.auxiliaryArtifacts } : undefined);
  const expectedDigest = calculateReleaseDigest(
    lock.channel,
    lock.components,
    trust,
    lock.releaseBom,
    digestContract
  );
  if (lock.releaseDigest !== expectedDigest) {
    throw new Error('Release lock digest does not match its component set');
  }
  return lock;
}

function sameComponent(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

// A component release remains a complete installation lock. The transition
// contract proves that only the explicitly named components changed and that
// every other digest and provenance field was inherited byte-for-byte from the
// installed base lock. It is deliberately upgrade-only.
export function validateReleaseTransition(baseLock, targetLock) {
  const base = validateLock(baseLock, {
    allowLegacyComponentSet: true,
    allowInstalledAgentIdentityCutover: true
  });
  const target = validateLock(targetLock);
  if ((target.releaseScope ?? RELEASE_SCOPE_INTEGRATED) !== RELEASE_SCOPE_COMPONENT) {
    return target;
  }
  if (target.baseReleaseDigest !== base.releaseDigest) {
    throw new Error('Component release lock does not name the installed base release digest');
  }
  if (target.channel !== base.channel) {
    throw new Error('Component release lock channel differs from its base release');
  }
  if (canonicalTrust(target.trust) !== canonicalTrust(base.trust)) {
    throw new Error('Component release lock trust root differs from its base release');
  }
  const changedAuxiliary = new Set(target.changedAuxiliaryArtifacts ?? []);
  const baseAuxiliaryNames = Object.keys(base.auxiliaryArtifacts ?? {}).sort();
  const targetAuxiliaryNames = Object.keys(target.auxiliaryArtifacts ?? {}).sort();
  const introducedConsoleIndex = !baseAuxiliaryNames.includes('consoleIndexContent')
    && targetAuxiliaryNames.includes('consoleIndexContent')
    && JSON.stringify([...baseAuxiliaryNames, 'consoleIndexContent'].sort()) === JSON.stringify(targetAuxiliaryNames)
    && changedAuxiliary.has('consoleIndexContent');
  if (introducedConsoleIndex && !target.changedComponents.includes('console')) {
    throw new Error('Console index artifact introduction must change the Console component manifest');
  }
  if (JSON.stringify(baseAuxiliaryNames) !== JSON.stringify(targetAuxiliaryNames)
      && !introducedConsoleIndex) {
    throw new Error('Component release cannot add or remove auxiliary runtime artifacts');
  }
  for (const name of targetAuxiliaryNames) {
    const differs = introducedConsoleIndex && name === 'consoleIndexContent'
      ? true : !sameComponent(base.auxiliaryArtifacts?.[name], target.auxiliaryArtifacts?.[name]);
    if (changedAuxiliary.has(name) && !differs) {
      throw new Error(`Changed auxiliary artifact ${name} is identical to the base release`);
    }
    if (!changedAuxiliary.has(name) && differs) {
      throw new Error(`Unlisted auxiliary artifact ${name} differs from the base release`);
    }
  }
  const cutover = isAgentIdentityCutover(base.components, target.components);
  if (cutover) {
    const required = Object.keys(CANONICAL_AGENT_COMPONENTS);
    if (!required.every((name) => target.changedComponents.includes(name))) {
      throw new Error('OSAA identity cutover must change both canonical agent components together');
    }
  }
  const baseNames = Object.keys(base.components ?? {})
    .map((name) => cutover ? canonicalNameForInstalledComponent(name) : name)
    .sort();
  const targetNames = Object.keys(target.components ?? {}).sort();
  const registryIntroduction = !baseNames.includes('registry')
    && targetNames.includes('registry')
    && JSON.stringify([...baseNames, 'registry'].sort()) === JSON.stringify(targetNames)
    && target.changedComponents.includes('registry');
  if (JSON.stringify(baseNames) !== JSON.stringify(targetNames) && !registryIntroduction) {
    throw new Error('Component release lock cannot change the installed component set');
  }
  const changed = new Set(target.changedComponents);
  for (const name of targetNames) {
    const installedName = cutover ? installedNameForCanonicalComponent(name) : name;
    const differs = registryIntroduction && name === 'registry'
      ? true : !sameComponent(base.components[installedName], target.components[name]);
    if (changed.has(name) && !differs) {
      throw new Error(`Changed component ${name} is identical to the base release`);
    }
    if (!changed.has(name) && differs) {
      throw new Error(`Unlisted component ${name} differs from the base release`);
    }
  }
  return target;
}

function releaseComponent(repository, inspected) {
  return {
    repository,
    image: inspected.image,
    sourceRevision: inspected.sourceRevision,
    registryCredentialsRequired: inspected.registryCredentialsRequired
  };
}

async function resolveLocalEdgeRelease(reference, anchor, {
  resolveImageFn = resolveImage,
  registryCredentials,
  requiredPlatforms = defaultEdgePlatforms(),
  onProgress
} = {}) {
  if (reference !== 'edge') {
    throw new Error('Localhost releases may be resolved only through the edge channel');
  }
  const targetPlatforms = canonicalRequiredPlatforms(requiredPlatforms);
  const anchorMetadata = assertLocalEdgeImage(anchor, { repository: COMPONENTS.console, artifactScope: 'canonical' });
  const resolved = await Promise.all(Object.entries(COMPONENTS).map(async ([name, repository]) => {
    report(onProgress, {
      type: 'local-component-start',
      component: name,
      repository,
      reference: anchorMetadata.immutableTag
    });
    const inspected = await resolveImageFn(repository, anchorMetadata.immutableTag, {
      registryCredentials,
      requiredPlatforms: targetPlatforms
    });
    if (name === 'console' && inspected.image !== anchor.image) {
      throw new Error('Local edge immutable Console tag differs from the channel anchor');
    }
    assertLocalEdgeImage(inspected, {
      repository,
      sourceRevision: anchorMetadata.sourceRevision,
      releaseTag: anchorMetadata.releaseTag,
      artifactScope: 'canonical'
    });
    report(onProgress, { type: 'local-component-complete', component: name, image: inspected.image });
    return [name, releaseComponent(repository, inspected)];
  }));
  const components = Object.fromEntries(resolved);
  const auxiliaryResolved = await Promise.all(Object.entries(auxiliaryCatalogForAnchor(anchor)).map(async ([name, repository]) => {
    report(onProgress, {
      type: 'local-auxiliary-start',
      component: name,
      repository,
      reference: anchorMetadata.immutableTag
    });
    const inspected = await resolveImageFn(repository, anchorMetadata.immutableTag, {
      registryCredentials,
      requiredPlatforms: targetPlatforms
    });
    assertLocalEdgeImage(inspected, {
      repository,
      sourceRevision: anchorMetadata.sourceRevision,
      releaseTag: anchorMetadata.releaseTag,
      artifactScope: 'auxiliary'
    });
    report(onProgress, { type: 'local-auxiliary-complete', component: name, image: inspected.image });
    return [name, releaseComponent(repository, inspected)];
  }));
  const auxiliaryArtifacts = Object.fromEntries(auxiliaryResolved);
  const releaseDigest = calculateReleaseDigest('edge', components, LOCAL_EDGE_TRUST, undefined, {
    auxiliaryArtifacts
  });
  return validateLock({
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest,
    resolvedAt: new Date().toISOString(),
    source: SOURCE,
    sourceRevision: anchorMetadata.sourceRevision,
    trust: LOCAL_EDGE_TRUST,
    auxiliaryArtifacts,
    components
  });
}

async function resolveSignedRelease(reference, channel, {
  resolveImageFn = resolveImage,
  inspectImageFn = inspectImageReference,
  verifyBom = verifyReleaseBomAttestation,
  registryCredentials,
  verifyImage = verifyImageProvenance,
  verifySbom = verifyImageSbom,
  onProgress,
  allowLegacyReleaseArtifacts = false,
  requiredPlatforms = channel === 'edge' ? defaultEdgePlatforms() : RELEASE_PLATFORMS,
  resolvedAnchor
} = {}) {
  validateChannel(channel);
  const targetPlatforms = canonicalRequiredPlatforms(requiredPlatforms);
  // The Console digest is the atomic channel anchor. The publisher moves its
  // mutable channel tag only after the signed BOM and every component digest
  // are available, so readers always see the previous complete release or the
  // new complete release, never independently sampled mutable component tags.
  let anchor = resolvedAnchor;
  if (!anchor) {
    report(onProgress, {
      type: 'anchor-start',
      component: 'console',
      repository: COMPONENTS.console,
      reference
    });
    anchor = await resolveImageFn(COMPONENTS.console, reference, {
      registryCredentials,
      requiredPlatforms: targetPlatforms
    });
    report(onProgress, {
      type: 'anchor-complete',
      component: 'console',
      image: anchor.image,
      reference
    });
  }
  report(onProgress, { type: 'bom-start', image: anchor.image, channel });
  const verifiedBom = await verifyBom(anchor.image, {
    channel,
    ...(registryCredentials?.token ? { authToken: registryCredentials.token } : {}),
    requiredPlatforms: targetPlatforms,
    allowLegacyReleaseArtifacts
  });
  report(onProgress, { type: 'bom-complete', image: anchor.image, channel });
  const bom = validateReleaseBom(verifiedBom.bom, {
    channel,
    subject: anchor.image,
    requiredPlatforms: targetPlatforms,
    allowLegacyReleaseArtifacts
  });
  const releaseBom = releaseBomPointer(bom, anchor.image, { allowLegacyReleaseArtifacts });
  if (verifiedBom.digest !== releaseBom.digest) {
    throw new Error('Verified Release BOM digest differs from its canonical document');
  }

  const resolved = await Promise.all(Object.entries(COMPONENTS).map(async ([name, repository]) => {
    const signed = bom.components[name];
    report(onProgress, { type: 'component-start', component: name, image: signed.image });
    const inspected = name === 'console'
      ? anchor
      : await inspectImageFn(repository, signed.image, {
        registryCredentials,
        requiredPlatforms: targetPlatforms
      });
    if (inspected.image !== signed.image || inspected.sourceRevision !== signed.sourceRevision) {
      throw new Error(`Registry image ${name} differs from the signed Release BOM`);
    }
    assertReleaseArtifactMetadata(inspected, {
      repository,
      sourceRevision: bom.sourceRevision,
      releaseTag: bom.releaseTag,
      artifactScope: 'canonical'
    });
    report(onProgress, { type: 'component-complete', component: name, image: inspected.image });
    return [name, releaseComponent(repository, inspected)];
  }));
  const components = Object.fromEntries(resolved);
  const auxiliaryResolved = await Promise.all(Object.entries(auxiliaryCatalogForAnchor(anchor)).map(async ([name, repository]) => {
    report(onProgress, { type: 'auxiliary-start', component: name, repository, reference: bom.releaseTag });
    const inspected = await resolveImageFn(repository, bom.releaseTag, {
      registryCredentials,
      requiredPlatforms: targetPlatforms
    });
    assertReleaseArtifactMetadata(inspected, {
      repository,
      sourceRevision: bom.sourceRevision,
      releaseTag: bom.releaseTag,
      artifactScope: 'auxiliary'
    });
    report(onProgress, { type: 'auxiliary-complete', component: name, image: inspected.image });
    return [name, releaseComponent(repository, inspected)];
  }));
  const auxiliaryArtifacts = Object.fromEntries(auxiliaryResolved);
  const sourceRevision = bom.sourceRevision;
  if (Object.values(components).some((component) => component.sourceRevision !== sourceRevision)) {
    throw new Error('Registry component source revisions differ from the signed Release BOM');
  }
  const releaseDigest = calculateReleaseDigest(channel, components, RELEASE_TRUST, releaseBom, {
    auxiliaryArtifacts
  });
  const lock = {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel,
    releaseDigest,
    resolvedAt: new Date().toISOString(),
    source: SOURCE,
    sourceRevision,
    trust: RELEASE_TRUST,
    releaseBom,
    auxiliaryArtifacts,
    components
  };
  return verifyReleaseProvenance(lock, {
    verifyImage,
    verifySbom,
    registryCredentials,
    onProgress
  });
}

export async function resolveChannel(channel, options = {}) {
  validateChannel(channel);
  const requiredPlatforms = options.requiredPlatforms
    ?? (channel === 'edge' ? defaultEdgePlatforms() : RELEASE_PLATFORMS);
  report(options.onProgress, {
    type: 'anchor-start',
    component: 'console',
    repository: COMPONENTS.console,
    reference: channel
  });
  const anchor = await (options.resolveImageFn ?? resolveImage)(COMPONENTS.console, channel, {
    registryCredentials: options.registryCredentials,
    requiredPlatforms
  });
  report(options.onProgress, {
    type: 'anchor-complete',
    component: 'console',
    image: anchor.image,
    reference: channel
  });
  if (channel === 'edge' && anchor.labels?.['opensphere.io/build-authority'] === 'localhost') {
    report(options.onProgress, { type: 'local-verification-start', image: anchor.image, channel });
    const lock = await resolveLocalEdgeRelease(channel, anchor, { ...options, requiredPlatforms });
    report(options.onProgress, { type: 'local-verification-complete', image: anchor.image, channel });
    return lock;
  }
  return resolveSignedRelease(channel, channel, {
    ...options,
    requiredPlatforms,
    resolvedAnchor: anchor
  });
}

// Historical revisions are not install channels.  This narrow resolver exists
// for the clean-cluster upgrade/rollback evidence harness: it turns the
// immutable short-SHA image tags emitted by the publisher into the same
// provenance-verified lock used by normal Setup operations.  The image config
// label must still prove the complete requested commit, so a short-tag
// collision or a substituted image cannot become a rollback target.
export async function resolveSourceRevision(sourceRevision, {
  resolveImageFn = resolveImage,
  inspectImageFn = inspectImageReference,
  verifyBom = verifyReleaseBomAttestation,
  registryCredentials,
  verifyImage = verifyImageProvenance,
  verifySbom = verifyImageSbom,
  onProgress
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '')) {
    throw new Error('Source revision must be a full 40-character lowercase Git commit');
  }
  const tag = `sha-${sourceRevision.slice(0, 7)}`;
  const lock = await resolveSignedRelease(tag, 'edge', {
    resolveImageFn,
    inspectImageFn,
    verifyBom,
    registryCredentials,
    verifyImage,
    verifySbom,
    onProgress,
    allowLegacyReleaseArtifacts: true
  });
  if (lock.sourceRevision !== sourceRevision) {
    throw new Error(`Source revision tag ${tag} does not resolve to one exact governed release`);
  }
  return lock;
}
