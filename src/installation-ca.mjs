// Installation CA identity and trust (2026-10-10).
//
// Every installation creates its own CA. Until now each one was named "CN=OpenSphere Installation CA",
// had no key identifiers, and its leaf was "CN=localhost". A workstation that trusted one installation's
// CA (for example the retired localhost:1114 installation) then failed every other installation with a
// signature error: Windows picked the trusted CA by name and the signature did not match
// (RKE2 console, 2026-10-05 and 2026-10-10: ERR_CERT_AUTHORITY_INVALID / 0x80096004).
//
// New installations name the CA after the installation and carry SKI/AKI. Existing installations keep their
// CA (rotation is a separate operation); `trust-ca` lets an operator trust exactly the CA that serves the
// installed Console after comparing its fingerprint. Only public certificate data is read here; the
// installation's private keys are never read.
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect, getCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { materializeRuntimeAsset } from './runtime-assets.mjs';
import { run as defaultRun } from './process.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const LEGACY_INSTALLATION_CA_SUBJECT = 'CN=OpenSphere Installation CA';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The CA subject for one installation: unique across installations, readable by a person. */
export function installationCaSubject(installationId) {
  if (!UUID.test(String(installationId))) throw new Error('installationId must be a lowercase UUID');
  return `CN=OpenSphere Installation CA ${installationId.slice(0, 8)}, OU=installation ${installationId}, O=OpenSphere`;
}

/** Node prints a subject as newline-separated RDNs, most specific last for this CA (O, OU, CN order may vary). */
function rdns(subject) {
  return Object.fromEntries(String(subject).split('\n').map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

/** Normalizes a SHA-256 fingerprint written with or without colons, in any case. */
export function normalizeSha256(value) {
  const text = String(value || '').replace(/:/g, '').toLowerCase();
  if (!SHA256.test(text)) throw new Error('A SHA-256 fingerprint has 64 hexadecimal digits');
  return text;
}

/**
 * Reads one installation CA certificate (PEM) and checks that it is an OpenSphere installation CA:
 * self-signed, a CA, named as an installation CA (legacy or per-installation form), and not expiring
 * within a day. Returns its public identity; never trusts anything by itself.
 */
export function inspectInstallationCa(pem, { now = new Date() } = {}) {
  const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (blocks.length !== 1) throw new Error('Expected exactly one installation CA certificate');
  const certificate = new X509Certificate(blocks[0]);
  const subject = rdns(certificate.subject);
  const legacy = certificate.subject === 'CN=OpenSphere Installation CA';
  const perInstallation = /^OpenSphere Installation CA [0-9a-f]{8}$/.test(subject.CN || '')
    && /^installation [0-9a-f-]{36}$/.test(subject.OU || '') && subject.OU.slice(13, 21) === subject.CN.slice(-8)
    && subject.O === 'OpenSphere';
  if (!legacy && !perInstallation) throw new Error(`Not an OpenSphere installation CA: ${certificate.subject.replace(/\n/g, ', ')}`);
  if (!certificate.ca) throw new Error('The installation CA certificate is not a CA');
  if (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)) {
    throw new Error('The installation CA certificate is not self-signed');
  }
  const notAfter = new Date(certificate.validTo);
  if (!(notAfter.getTime() > now.getTime() + 24 * 3600 * 1000)) throw new Error('The installation CA expires within a day');
  return Object.freeze({
    subject: certificate.subject.replace(/\n/g, ', '),
    form: legacy ? 'legacy-shared-name' : 'per-installation',
    installationId: legacy ? null : subject.OU.slice('installation '.length),
    sha256: normalizeSha256(certificate.fingerprint256),
    notBefore: new Date(certificate.validFrom).toISOString(),
    notAfter: notAfter.toISOString(),
    pem: blocks[0] + '\n',
  });
}

/**
 * Reads only the public `ca.crt` of the managed Console TLS Secret. The private key in the same Secret
 * is never requested. An installation that uses an external certificate has no managed CA to trust.
 */
export function readInstalledConsoleCa({ kubectl }) {
  const field = (path) => String(kubectl(['-n', 'opensphere-console', 'get', 'secret', 'shell-tls',
    '-o', `jsonpath={${path}}`], { capture: true }) ?? '').trim();
  const source = field('.metadata.annotations.opensphere\\.io/source-secret');
  if (source) throw new Error(`The Console uses the external certificate ${source}; trust its issuer through your PKI, not trust-ca`);
  const ca = field('.data.ca\\.crt');
  if (!ca) throw new Error('The managed Console TLS Secret has no ca.crt');
  return Buffer.from(ca, 'base64').toString('utf8');
}

/**
 * Connects to the Console origin and verifies the served certificate against this CA only (no system
 * roots, hostname checked). Proves that the CA to be trusted is the one actually serving the Console.
 * Sends no HTTP request and no credential.
 */
export function verifyServedByCa(consoleUrl, caPem, { connectFn = connect, timeoutMs = 10000 } = {}) {
  const url = new URL(consoleUrl);
  if (url.protocol !== 'https:') return Promise.resolve({ authorized: false, error: 'The Console origin is not HTTPS' });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result, socket) => { if (!settled) { settled = true; socket?.destroy(); resolve(result); } };
    const socket = connectFn({ host, port: Number(url.port || 443), servername: /^[\d.:]+$/.test(host) ? undefined : host,
      ca: Array.isArray(caPem) ? caPem : [caPem], rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      const peer = socket.getPeerCertificate();
      finish({ authorized: socket.authorized === true, error: socket.authorized ? null : String(socket.authorizationError || 'unverified'),
        servedSubject: peer?.subject ? Object.entries(peer.subject).map(([k, v]) => `${k}=${v}`).join(', ') : null }, socket);
    });
    socket.setTimeout(timeoutMs, () => finish({ authorized: false, error: 'timeout' }, socket));
    socket.on('error', (error) => finish({ authorized: false, error: error.code || error.message }, socket));
  });
}

/**
 * The trust plan for one installation: what would be trusted and why. With apply, the caller must name
 * the fingerprint it compared (expectedSha256); a mismatch refuses before any change.
 */
export function planInstallationCaTrust({ ca, served, consoleUrl, expectedSha256, apply, platform = process.platform }) {
  const blockers = [];
  if (!served.authorized) blockers.push(`ServedCertificateNotSignedByThisCa: ${served.error}`);
  if (apply && expectedSha256 === undefined) blockers.push('ExpectedFingerprintRequired: pass --expect-sha256 with the fingerprint you compared');
  if (expectedSha256 !== undefined && normalizeSha256(expectedSha256) !== ca.sha256) blockers.push('FingerprintMismatch');
  if (apply && platform !== 'win32') blockers.push('UnsupportedPlatform: import ca.crt with your operating system trust tool');
  return Object.freeze({
    consoleUrl, subject: ca.subject, form: ca.form, installationId: ca.installationId, sha256: ca.sha256,
    notBefore: ca.notBefore, notAfter: ca.notAfter, served, store: 'Windows CurrentUser\\Root',
    note: ca.form === 'legacy-shared-name'
      ? 'This installation uses the older shared CA name. Another installation CA with the same name may already be trusted; it does not need removing, but the Console only verifies once this CA is trusted.'
      : null,
    blockers, eligible: blockers.length === 0,
  });
}

/** After trusting: does the operating system trust store alone now verify the Console? */
export function verifyServedBySystemTrust(consoleUrl, { connectFn = connect, systemCas = () => getCACertificates('system') } = {}) {
  return verifyServedByCa(consoleUrl, systemCas(), { connectFn });
}

/**
 * Adds exactly this CA to Windows CurrentUser\Root through the reviewed installer, which refuses a
 * different fingerprint. Nothing is removed. Callers have checked planInstallationCaTrust().eligible.
 */
/**
 * PowerShell 7 when present; otherwise the Windows PowerShell 5.1 that every Windows has. The trust
 * installer uses only APIs both provide (checked 2026-10-11), so trust-ca needs no extra install.
 */
export function powershellCommand({ run = defaultRun } = {}) {
  try {
    run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { capture: true });
    return ['pwsh'];
  } catch {
    return ['powershell.exe', '-ExecutionPolicy', 'Bypass'];
  }
}

export async function applyInstallationCaTrust(ca, { run = defaultRun, packageDirectory = HERE } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'opensphere-installation-ca-'));
  const certificate = join(directory, 'opensphere-installation-ca.crt');
  const installer = await materializeRuntimeAsset('Install-LocalDevelopmentCa.ps1', packageDirectory);
  try {
    await writeFile(certificate, ca.pem, { encoding: 'utf8', mode: 0o600 });
    const [shell, ...shellArgs] = powershellCommand({ run });
    run(shell, [...shellArgs, '-NoProfile', '-NonInteractive', '-File', installer.path, '-CertificatePath', certificate, '-ExpectedSha256', ca.sha256]);
  } finally {
    await installer.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}
