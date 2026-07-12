import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fetchWithRetry } from './http.mjs';

export const RELEASE_API_VERSION = 'release.opensphere.io/v1alpha1';
export const REGISTRY = 'ghcr.io';
export const OWNER = 'opensphere-platform';
export const SOURCE = 'https://github.com/opensphere-platform/OpenSphere-console';

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
  let manifest = document;
  if (Array.isArray(document.manifests)) {
    const descriptor = document.manifests.find((entry) =>
      entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64'
    );
    if (!descriptor?.digest) throw new Error(`${repository}:${channel} has no linux/amd64 manifest`);
    const platformResponse = await fetchWithRetry(`${base}/manifests/${descriptor.digest}`, { headers }, { fetchImpl });
    if (!platformResponse.ok) throw new Error(`Platform manifest unavailable for ${repository}: HTTP ${platformResponse.status}`);
    manifest = await platformResponse.json();
  }
  if (!manifest.config?.digest) throw new Error(`Image config descriptor missing for ${repository}:${channel}`);
  const configResponse = await fetchWithRetry(`${base}/blobs/${manifest.config.digest}`, {
    headers: { authorization: `Bearer ${token}` }
  }, { fetchImpl });
  if (!configResponse.ok) throw new Error(`Image config unavailable for ${repository}: HTTP ${configResponse.status}`);
  const config = await configResponse.json();
  const sourceRevision = config.config?.Labels?.['io.opensphere.source-revision'];
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '')) {
    throw new Error(`Source revision label missing for ${repository}:${channel}`);
  }
  return { image: `${REGISTRY}/${OWNER}/${repository}@${digest}`, sourceRevision };
}

export function validateChannel(channel) {
  if (!['edge', 'candidate', 'stable'].includes(channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
}

export function calculateReleaseDigest(channel, components) {
  const payload = JSON.stringify({ channel, components });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
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
  const expectedDigest = calculateReleaseDigest(lock.channel, lock.components);
  if (lock.releaseDigest !== expectedDigest) {
    throw new Error('Release lock digest does not match its component set');
  }
  return lock;
}

export async function resolveChannel(channel) {
  validateChannel(channel);
  const resolved = await Promise.all(Object.entries(COMPONENTS).map(async ([name, repository]) => [
    name,
    { repository, ...await resolveImage(repository, channel) }
  ]));
  const components = Object.fromEntries(resolved);
  const revisions = new Set(Object.values(components).map((component) => component.sourceRevision));
  if (revisions.size !== 1) {
    throw new Error(`Channel ${channel} is not atomic: component source revisions differ`);
  }
  const [sourceRevision] = revisions;
  const releaseDigest = calculateReleaseDigest(channel, components);
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel,
    releaseDigest,
    resolvedAt: new Date().toISOString(),
    source: SOURCE,
    sourceRevision,
    components
  };
}
