import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const RELEASE_API_VERSION = 'release.opensphere.io/v1alpha1';
export const REGISTRY = 'ghcr.io';
export const OWNER = 'opensphere-platform';

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

async function registryToken(repository) {
  const endpoint = new URL(`https://${REGISTRY}/token`);
  endpoint.searchParams.set('service', REGISTRY);
  endpoint.searchParams.set('scope', `repository:${OWNER}/${repository}:pull`);
  const token = ghToken();
  const headers = token
    ? { authorization: `Basic ${Buffer.from(`${OWNER}:${token}`).toString('base64')}` }
    : {};
  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    throw new Error(`GHCR token request failed for ${repository}: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body.token) throw new Error(`GHCR did not issue a pull token for ${repository}`);
  return body.token;
}

export async function resolveImage(repository, channel, { fetchImpl = fetch } = {}) {
  const token = await registryToken(repository);
  const url = `https://${REGISTRY}/v2/${OWNER}/${repository}/manifests/${channel}`;
  const response = await fetchImpl(url, {
    method: 'HEAD',
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json'
      ].join(', ')
    }
  });
  if (!response.ok) {
    throw new Error(`${REGISTRY}/${OWNER}/${repository}:${channel} not available: HTTP ${response.status}`);
  }
  const digest = response.headers.get('docker-content-digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new Error(`Invalid registry digest for ${repository}:${channel}`);
  }
  return `${REGISTRY}/${OWNER}/${repository}@${digest}`;
}

export function validateChannel(channel) {
  if (!['edge', 'candidate', 'stable'].includes(channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
}

export function validateLock(lock) {
  if (lock?.apiVersion !== RELEASE_API_VERSION || lock?.kind !== 'OpenSphereReleaseLock') {
    throw new Error('Invalid OpenSphere release lock');
  }
  validateChannel(lock.channel);
  for (const name of Object.keys(COMPONENTS)) {
    const image = lock.components?.[name]?.image;
    if (!new RegExp(`^${REGISTRY}/${OWNER}/[a-z0-9-]+@sha256:[a-f0-9]{64}$`).test(image ?? '')) {
      throw new Error(`Component ${name} is not digest-pinned`);
    }
  }
  return lock;
}

export async function resolveChannel(channel) {
  validateChannel(channel);
  const sourceResponse = await fetch('https://api.github.com/repos/opensphere-platform/OpenSphere-console/commits/main', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'opensphere-setup' }
  });
  if (!sourceResponse.ok) throw new Error(`Console source revision lookup failed: HTTP ${sourceResponse.status}`);
  const sourceRevision = (await sourceResponse.json()).sha;
  const resolved = await Promise.all(Object.entries(COMPONENTS).map(async ([name, repository]) => [
    name,
    { repository, image: await resolveImage(repository, channel) }
  ]));
  const components = Object.fromEntries(resolved);
  const payload = JSON.stringify({ channel, components });
  const releaseDigest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel,
    releaseDigest,
    resolvedAt: new Date().toISOString(),
    source: 'https://github.com/opensphere-platform/OpenSphere-console',
    sourceRevision,
    components
  };
}
