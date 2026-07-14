/**
 * Canonical browser origin for a managed Console installation. Keeping this
 * in one place prevents the OIDC issuer, redirect URI, TLS SAN and CLI API
 * base from silently drifting apart.
 */
export function normalizeConsoleUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--console must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('--console must be an HTTPS origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function oidcIssuer(consoleUrl) {
  return `${normalizeConsoleUrl(consoleUrl)}/oauth2/openid/opensphere-console`;
}
