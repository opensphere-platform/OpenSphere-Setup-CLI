const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Canonical browser origin for a managed Console installation. HTTPS remains
 * mandatory everywhere except an edge/development Console bound to the local
 * host. That narrow HTTP exception makes the first-access wizard usable on a
 * clean workstation without teaching a non-technical operator to install a
 * private root CA or bypass a browser certificate warning.
 */
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
  return channel === 'edge' && authEnvironment === 'development'
    ? 'http://localhost:8090'
    : 'https://localhost:8090';
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
