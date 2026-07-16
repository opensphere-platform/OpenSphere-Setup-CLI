const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Canonical browser origin for a managed Console installation. */
export function normalizeConsoleUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--console must be an absolute HTTPS URL or loopback HTTP origin');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('--console must be an HTTPS origin or loopback HTTP origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function defaultConsoleUrl(channel, authEnvironment) {
  return 'https://localhost:8090';
}

// c8bde85 temporarily made loopback HTTP the edge/development default. A managed
// installation carrying exactly that origin may be repaired in place when Setup's
// canonical default returns to HTTPS. No other endpoint change is implicit.
export function isLegacyEdgeLoopbackHttpOrigin({ channel, authEnvironment, storedUrl, requestedUrl } = {}) {
  return channel === 'edge'
    && authEnvironment === 'development'
    && normalizeConsoleUrl(storedUrl) === 'http://localhost:8090'
    && normalizeConsoleUrl(requestedUrl) === 'https://localhost:8090';
}

/**
 * The signed Console manifest exposes both nginx listeners. Setup selects the
 * listener that matches the immutable installation origin while preserving
 * compatibility with already-signed manifests that predate endpoint tokens.
 */
export function configureShellServiceEndpoint(yaml, consoleUrl) {
  const normalized = normalizeConsoleUrl(consoleUrl);
  if (new URL(normalized).protocol === 'https:') return yaml;

  const service = /(name:\s*opensphere-console-ext[\s\S]{0,600}?ports:\s*\n\s*-\s*name:)\s*https([\s\S]{0,120}?targetPort:)\s*8443/;
  const configured = yaml.replace(service, '$1 http$2 8080');
  if (yaml.includes('name: opensphere-console-ext') && configured === yaml) {
    throw new Error('Console manifest does not expose the governed shell service endpoint');
  }
  return configured;
}

export function oidcIssuer(consoleUrl) {
  return `${normalizeConsoleUrl(consoleUrl)}/oauth2/openid/opensphere-console`;
}
