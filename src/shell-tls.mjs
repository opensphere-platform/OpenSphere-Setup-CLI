import { createPrivateKey, X509Certificate } from 'node:crypto';

export const EXTERNAL_SHELL_TLS_ANNOTATION = 'opensphere.io/shell-tls-profile';
export const EXTERNAL_SHELL_TLS_PROFILE = 'external-ca-v1';

const REQUIRED_KEYS = Object.freeze(['tls.crt', 'tls.key']);
const MINIMUM_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

function decode(data, key) {
  const encoded = data?.[key];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8').trim() : '';
}

function certificateChain(pem, certificateFactory = X509Certificate) {
  const values = String(pem ?? '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (values.length < 2) {
    throw new Error('External shell TLS Secret tls.crt must contain the leaf and its issuing CA chain');
  }
  try {
    return values.map((value) => new certificateFactory(value));
  } catch {
    throw new Error('External shell TLS Secret tls.crt is not a valid PEM certificate chain');
  }
}

export function parseShellTlsSecretRef(value) {
  const match = String(value ?? '').trim().match(/^([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)$/);
  if (!match) throw new Error('--shell-tls-secret must be an existing namespace/name TLS Secret reference');
  return { namespace: match[1], name: match[2] };
}

export function shellTlsSecretRefText(reference) {
  return reference ? `${reference.namespace}/${reference.name}` : undefined;
}

export function assertReleaseShellTlsReference(channel, reference) {
  if (channel !== 'edge' && !reference) {
    throw new Error(`${channel} requires --shell-tls-secret with an operator-provided external CA certificate`);
  }
}

export function inspectExternalShellTlsSecret(secret, consoleUrl, {
  now = Date.now(),
  certificateFactory = X509Certificate,
  privateKeyFactory = createPrivateKey
} = {}) {
  const missing = REQUIRED_KEYS.filter((key) => !secret?.data?.[key]);
  if (missing.length) throw new Error(`External shell TLS Secret is missing required keys: ${missing.join(', ')}`);
  if (secret.type !== 'kubernetes.io/tls') {
    throw new Error('External shell TLS Secret must have type kubernetes.io/tls');
  }
  if (secret.metadata?.annotations?.[EXTERNAL_SHELL_TLS_ANNOTATION] !== EXTERNAL_SHELL_TLS_PROFILE) {
    throw new Error(`External shell TLS Secret must declare ${EXTERNAL_SHELL_TLS_ANNOTATION}=${EXTERNAL_SHELL_TLS_PROFILE}`);
  }

  const hostname = new URL(consoleUrl).hostname;
  const certificates = certificateChain(decode(secret.data, 'tls.crt'), certificateFactory);
  const [leaf, ...issuers] = certificates;
  if (leaf.ca || leaf.subject === leaf.issuer) {
    throw new Error('External shell TLS leaf must be a non-CA certificate issued by an external CA');
  }
  if (!leaf.checkHost(hostname)) {
    throw new Error(`External shell TLS certificate does not cover Console hostname ${hostname}`);
  }
  const validFrom = Date.parse(leaf.validFrom);
  const validTo = Date.parse(leaf.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now || validTo < now + MINIMUM_VALIDITY_MS) {
    throw new Error('External shell TLS leaf must already be valid and remain valid for at least 30 days');
  }
  try {
    const privateKey = privateKeyFactory(decode(secret.data, 'tls.key'));
    if (!leaf.checkPrivateKey(privateKey)) throw new Error('mismatch');
  } catch {
    throw new Error('External shell TLS private key is invalid or does not match tls.crt');
  }
  for (let index = 0; index < issuers.length; index += 1) {
    const issuer = issuers[index];
    if (!issuer.ca || !certificates[index].verify(issuer.publicKey)) {
      throw new Error('External shell TLS certificate chain is incomplete or invalid');
    }
  }
  return {
    hostname,
    subject: leaf.subject,
    validTo: leaf.validTo,
    certificateCount: certificates.length,
    profile: EXTERNAL_SHELL_TLS_PROFILE
  };
}

export function shellTlsSecretData(secret) {
  return Object.fromEntries(REQUIRED_KEYS.map((key) => [key, secret.data[key]]));
}
