import { REGISTRY, normalizeRegistryCredentials } from './release.mjs';

export const REGISTRY_PULL_SECRET = 'opensphere-ghcr-pull';

export function releaseNeedsRegistryCredentials(lock) {
  return Object.values(lock?.components ?? {})
    .some((component) => component?.registryCredentialsRequired === true);
}

export function dockerConfigJson(credentials) {
  const normalized = normalizeRegistryCredentials(credentials);
  if (!normalized) return JSON.stringify({ auths: {} });
  return JSON.stringify({
    auths: {
      [REGISTRY]: {
        username: normalized.username,
        password: normalized.token,
        auth: Buffer.from(`${normalized.username}:${normalized.token}`).toString('base64')
      }
    }
  });
}

export function registryPullSecretManifest(namespace, credentials) {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace ?? '')) {
    throw new Error('Registry pull Secret namespace is invalid');
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: REGISTRY_PULL_SECRET,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'opensphere-setup',
        'opensphere.io/credential-purpose': 'registry-pull'
      }
    },
    type: 'kubernetes.io/dockerconfigjson',
    data: {
      '.dockerconfigjson': Buffer.from(dockerConfigJson(credentials)).toString('base64')
    }
  };
}

export function secretHasGhcrCredential(secret) {
  if (secret?.type !== 'kubernetes.io/dockerconfigjson') return false;
  const encoded = secret?.data?.['.dockerconfigjson'];
  if (!encoded) return false;
  try {
    const config = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const entry = config?.auths?.[REGISTRY];
    return Boolean(entry?.username && entry?.password && entry?.auth);
  } catch {
    return false;
  }
}
