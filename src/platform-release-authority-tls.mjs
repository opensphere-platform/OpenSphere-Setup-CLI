import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { kubectl, run } from './process.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AUTHORITY_HOST = 'opensphere-platform-release-authority.opensphere-console.svc.cluster.local';
export const AUTHORITY_SECRET = 'opensphere-platform-release-authority-tls';
export const AUTHORITY_CA = 'opensphere-platform-release-control-ca';
export const AUTHORITY_SERVICE = 'opensphere-platform-release-authority';
const NAMESPACE = 'opensphere-console';

function decode(value, label) {
  const encoded = String(value || '');
  const bytes = Buffer.from(encoded, 'base64');
  if (!encoded || bytes.toString('base64') !== encoded) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

function hasDerSequence(raw, hexadecimal) {
  return raw.indexOf(Buffer.from(hexadecimal.replaceAll(' ', ''), 'hex')) >= 0;
}

function exactP256PublicKey(key) {
  const curve = String(key?.asymmetricKeyDetails?.namedCurve || '').toLowerCase();
  return key?.asymmetricKeyType === 'ec'
    && ['prime256v1', 'p-256', 'secp256r1'].includes(curve);
}

export function validateAuthorityObjects(secret, configMap) {
  if (!secret || !configMap || secret.metadata?.name !== AUTHORITY_SECRET
    || configMap.metadata?.name !== AUTHORITY_CA || secret.metadata?.namespace !== NAMESPACE
    || configMap.metadata?.namespace !== NAMESPACE || secret.type !== 'kubernetes.io/tls'
    || secret.immutable !== true || configMap.immutable !== true
    || Object.keys(secret.data || {}).sort().join(',') !== 'ca.crt,tls.crt,tls.key'
    || Object.keys(configMap.data || {}).join(',') !== 'ca.crt') {
    throw new Error('Platform Release TLS objects are outside the immutable exact contract');
  }
  const caPem = decode(secret.data['ca.crt'], 'Platform Release CA').toString('utf8');
  const certPem = decode(secret.data['tls.crt'], 'Platform Release certificate').toString('utf8');
  const keyPem = decode(secret.data['tls.key'], 'Platform Release private key').toString('utf8');
  if (configMap.data['ca.crt'] !== caPem) throw new Error('public CA differs from the private TLS custody object');
  const ca = new X509Certificate(caPem);
  const cert = new X509Certificate(certPem);
  const now = Date.now();
  const validFrom = Date.parse(cert.validFrom);
  const validTo = Date.parse(cert.validTo);
  const minimumLifetime = 700 * 24 * 60 * 60 * 1000;
  const maximumLifetime = 740 * 24 * 60 * 60 * 1000;
  if (!ca.ca || cert.ca || !exactP256PublicKey(ca.publicKey) || !exactP256PublicKey(cert.publicKey)
    || !ca.verify(ca.publicKey) || cert.checkHost(AUTHORITY_HOST) !== AUTHORITY_HOST
    || !cert.verify(ca.publicKey) || !Number.isFinite(validFrom) || !Number.isFinite(validTo)
    || validFrom > now + (5 * 60 * 1000) || validFrom < now - (10 * 60 * 1000)
    || validTo - validFrom < minimumLifetime || validTo - validFrom > maximumLifetime
    || !hasDerSequence(cert.raw, '06 03 55 1d 13 01 01 ff 04 02 30 00')
    || !hasDerSequence(cert.raw, '06 03 55 1d 0f 01 01 ff 04 04 03 02 07 80')
    || !hasDerSequence(cert.raw, '06 03 55 1d 25 01 01 ff 04 0c 30 0a 06 08 2b 06 01 05 05 07 03 01')) {
    throw new Error('Platform Release certificate chain or exact service SAN is invalid');
  }
  const sans = String(cert.subjectAltName || '').split(', ').sort();
  const expectedSans = [
    'DNS:opensphere-platform-release-authority.opensphere-console.svc',
    `DNS:${AUTHORITY_HOST}`,
  ].sort();
  if (JSON.stringify(sans) !== JSON.stringify(expectedSans)) {
    throw new Error('Platform Release certificate contains a missing or extra SAN');
  }
  const privateSpki = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
  const certSpki = cert.publicKey.export({ type: 'spki', format: 'der' });
  if (!privateSpki.equals(certSpki) || validTo < now + (30 * 24 * 60 * 60 * 1000)) {
    throw new Error('Platform Release TLS private key or remaining validity is invalid');
  }
  return { secret, configMap };
}

function getObject(kind, name, kubectlFn) {
  const output = kubectlFn(['-n', NAMESPACE, 'get', kind, name, '--ignore-not-found', '-o', 'json'],
    { capture: true });
  return output ? JSON.parse(output) : null;
}

export function validateAuthorityService(service) {
  const port = service?.spec?.ports?.[0];
  if (service?.apiVersion !== 'v1' || service?.kind !== 'Service'
    || service?.metadata?.name !== AUTHORITY_SERVICE || service?.metadata?.namespace !== NAMESPACE
    || JSON.stringify(service?.metadata?.labels || {})
      !== JSON.stringify({ app: 'opensphere-platform-release-authority' })
    || JSON.stringify(service?.spec?.selector || {})
      !== JSON.stringify({ app: 'opensphere-console-backend' })
    || !Array.isArray(service?.spec?.ports) || service.spec.ports.length !== 1
    || port?.name !== 'https' || port?.port !== 8446 || port?.protocol !== 'TCP'
    || port?.targetPort !== 'release-tls') {
    throw new Error('Platform Release TLS Service is outside the exact authority contract');
  }
  return service;
}

function authorityServiceObject() {
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: AUTHORITY_SERVICE, namespace: NAMESPACE,
      labels: { app: 'opensphere-platform-release-authority' } },
    spec: {
      selector: { app: 'opensphere-console-backend' },
      ports: [{ name: 'https', port: 8446, protocol: 'TCP', targetPort: 'release-tls' }],
    },
  };
}

export async function ensurePlatformReleaseAuthorityTls({ kubectlFn = kubectl, runFn = run } = {}) {
  let secret = getObject('secret', AUTHORITY_SECRET, kubectlFn);
  let configMap = getObject('configmap', AUTHORITY_CA, kubectlFn);
  let service = getObject('service', AUTHORITY_SERVICE, kubectlFn);
  if ((!secret || !configMap) && service) {
    throw new Error('Platform Release TLS Service exists without the complete immutable custody pair');
  }
  if (!secret && configMap) throw new Error('Platform Release public CA exists without its private TLS custody object');
  if (!secret) {
    const work = await mkdtemp(join(tmpdir(), 'opensphere-platform-release-tls-'));
    try {
      runFn('pwsh', ['-NoLogo','-NoProfile','-NonInteractive','-File',
        join(HERE, 'New-PlatformReleaseAuthorityCertificates.ps1'), '-OutputDirectory', work]);
      const [ca, cert, key] = await Promise.all([
        readFile(join(work, 'ca.crt')), readFile(join(work, 'tls.crt')), readFile(join(work, 'tls.key')),
      ]);
      const object = {
        apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/tls', immutable: true,
        metadata: { name: AUTHORITY_SECRET, namespace: NAMESPACE,
          labels: { 'opensphere.io/purpose': 'platform-release-internal-tls' } },
        data: { 'ca.crt': ca.toString('base64'), 'tls.crt': cert.toString('base64'),
          'tls.key': key.toString('base64') },
      };
      try { kubectlFn(['create','-f','-'], { capture: true, input: JSON.stringify(object) }); }
      catch { /* response loss/concurrent create is resolved by exact re-read below */ }
    } finally { await rm(work, { recursive: true, force: true }); }
    secret = getObject('secret', AUTHORITY_SECRET, kubectlFn);
    if (!secret) throw new Error('Platform Release TLS Secret was not durably created');
  }
  if (!configMap) {
    const caPem = decode(secret.data?.['ca.crt'], 'Platform Release CA').toString('utf8');
    const object = { apiVersion: 'v1', kind: 'ConfigMap', immutable: true,
      metadata: { name: AUTHORITY_CA, namespace: NAMESPACE,
        labels: { 'opensphere.io/purpose': 'platform-release-internal-ca' } }, data: { 'ca.crt': caPem } };
    try { kubectlFn(['create','-f','-'], { capture: true, input: JSON.stringify(object) }); }
    catch { /* response loss/concurrent create is resolved by exact re-read below */ }
    configMap = getObject('configmap', AUTHORITY_CA, kubectlFn);
  }
  const pair = validateAuthorityObjects(secret, configMap);
  if (!service) {
    const object = authorityServiceObject();
    try { kubectlFn(['create','-f','-'], { capture: true, input: JSON.stringify(object) }); }
    catch { /* response loss/concurrent create is resolved by exact re-read below */ }
    service = getObject('service', AUTHORITY_SERVICE, kubectlFn);
  }
  return { ...pair, service: validateAuthorityService(service) };
}
