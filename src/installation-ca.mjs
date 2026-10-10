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
  if (new Date(certificate.validFrom).getTime() > now.getTime()) throw new Error('The installation CA is not valid yet');
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
 * Whether the CA belongs to this installation. A per-installation CA names its installation in OU and
 * must name the one recorded on this cluster (`installation`, from readInstallationIdentity, or null).
 * The legacy shared name carries no installation id, so it is accepted as an explicit compatibility
 * exception and reported as not proven; the served-certificate check and the fingerprint still bind it.
 */
function installationBinding(ca, installation) {
  if (ca.form !== 'per-installation') return { state: 'not-proven-legacy-name', blocker: null };
  if (!installation) {
    return { state: 'unavailable', blocker: 'InstallationIdentityUnavailable: this cluster records no installation identity to compare with the CA' };
  }
  return installation.installationId === ca.installationId
    ? { state: 'matched', blocker: null }
    : { state: 'mismatch', blocker: `InstallationIdMismatch: the CA names installation ${ca.installationId}; this cluster records ${installation.installationId}` };
}

/**
 * The trust plan for one installation: what would be trusted and why. With apply, the caller must name
 * the fingerprint it compared (expectedSha256); a mismatch refuses before any change.
 */
export function planInstallationCaTrust({ ca, served, consoleUrl, expectedSha256, apply, installation = null, platform = process.platform }) {
  const blockers = [];
  const binding = installationBinding(ca, installation);
  if (binding.blocker) blockers.push(binding.blocker);
  if (!served.authorized) blockers.push(`ServedCertificateNotSignedByThisCa: ${served.error}`);
  if (apply && expectedSha256 === undefined) blockers.push('ExpectedFingerprintRequired: pass --expect-sha256 with the fingerprint you compared');
  if (expectedSha256 !== undefined && normalizeSha256(expectedSha256) !== ca.sha256) blockers.push('FingerprintMismatch');
  if (apply && platform !== 'win32') blockers.push('UnsupportedPlatform: import ca.crt with your operating system trust tool');
  return Object.freeze({
    consoleUrl, subject: ca.subject, form: ca.form, installationId: ca.installationId,
    recordedInstallationId: installation?.installationId ?? null, installationBinding: binding.state, sha256: ca.sha256,
    notBefore: ca.notBefore, notAfter: ca.notAfter, served, store: 'Windows CurrentUser\\Root',
    note: ca.form === 'legacy-shared-name'
      ? 'This installation uses the older shared CA name. Another installation CA with the same name may already be trusted; it does not need removing, but the Console only verifies once this CA is trusted.'
      : null,
    blockers, eligible: blockers.length === 0,
  });
}

/** The certificate the Console serves (public data only), without trusting it. */
export function fetchServedCertificate(consoleUrl, { connectFn = connect, timeoutMs = 10000 } = {}) {
  const url = new URL(consoleUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = connectFn({ host, port: Number(url.port || 443), servername: /^[\d.:]+$/.test(host) ? undefined : host,
      rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      const raw = socket.getPeerCertificate()?.raw;
      socket.destroy();
      raw ? resolve(new X509Certificate(raw)) : reject(new Error('The Console presented no certificate'));
    });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('error', reject);
  });
}

const within = (certificate, now) => new Date(certificate.validFrom) <= now && now < new Date(certificate.validTo);

/** The served certificate names the Console host and is valid now; otherwise the reason. */
function servedNameAndValidity(consoleUrl, served, now) {
  const host = new URL(consoleUrl).hostname.replace(/^\[|\]$/g, '');
  if (!within(served, now)) return 'CERT_NOT_VALID_NOW';
  if (!(/^[\d.:]+$/.test(host) ? served.checkIP(host) : served.checkHost(host))) return 'HOSTNAME_MISMATCH';
  return null;
}

/**
 * Supporting evidence only, not a chain verification: does some CA in the trust store that Node reads
 * (getCACertificates('system')) have the served certificate's issuer name and a key that verifies its
 * signature? OpenSSL picks one issuer by name; with two installation CAs that share the legacy name it
 * tries the first and fails even when the right CA is trusted (observed 2026-10-11). This match tries
 * every same-name candidate. It checks no key usage, EKU, policy or revocation, so it never stands in for
 * the operating system's own verification (verifyServedByWindowsChain) or a browser check.
 */
export async function matchTrustedRootSignature(consoleUrl, { fetchFn = fetchServedCertificate, systemCas = () => getCACertificates('system'), now = new Date() } = {}) {
  let served;
  try { served = await fetchFn(consoleUrl); } catch (error) { return { matched: false, error: error.code || error.message }; }
  const reason = servedNameAndValidity(consoleUrl, served, now);
  if (reason) return { matched: false, error: reason };
  const candidates = systemCas().map((pem) => { try { return new X509Certificate(pem); } catch { return null; } })
    .filter((ca) => ca && ca.ca && served.checkIssued(ca));
  const issuer = candidates.find((ca) => within(ca, now) && served.verify(ca.publicKey));
  return issuer
    ? { matched: true, error: null, issuerSha256: normalizeSha256(issuer.fingerprint256), candidatesWithSameName: candidates.length }
    : { matched: false, error: candidates.length ? 'CERT_SIGNATURE_FAILURE' : 'UNABLE_TO_GET_ISSUER_CERT', candidatesWithSameName: candidates.length };
}

// Builds the served certificate's chain with the Windows chain engine (the trust store Windows and
// Chrome on Windows use), for TLS server use: the chain must be valid for serverAuth
// (1.3.6.1.5.5.7.3.1; a certificate without an EKU extension is valid for any use, as in browsers).
// Revocation is not checked: an installation CA publishes no CRL or OCSP.
// The engine does not check the host name; servedNameAndValidity does that first.
export const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
function windowsChainScript(certificatePath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new('${certificatePath.replace(/'/g, "''")}')`,
    '$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()',
    'try {',
    '  $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck',
    `  [void]$chain.ChainPolicy.ApplicationPolicy.Add([System.Security.Cryptography.Oid]::new('${SERVER_AUTH_OID}'))`,
    '  $built = $chain.Build($certificate)',
    '  $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate',
    '  [pscustomobject]@{ built = $built; status = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() });',
    '    rootSha256 = $root.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() } | ConvertTo-Json -Compress',
    '} finally { $chain.Dispose(); $certificate.Dispose() }',
  ].join('\n');
}

/**
 * Does Windows itself verify the Console? The served certificate (public data) is checked for host name
 * and validity, then its chain is built by the Windows chain engine against the current user's and the
 * machine's trust stores. A browser may still hold an earlier result until it is restarted, so a browser
 * check stays a separate step.
 */
export async function verifyServedByWindowsChain(consoleUrl, { fetchFn = fetchServedCertificate, run = defaultRun, now = new Date(), platform = process.platform } = {}) {
  if (platform !== 'win32') return { verified: null, error: 'NotWindows' };
  let served;
  try { served = await fetchFn(consoleUrl); } catch (error) { return { verified: false, error: error.code || error.message }; }
  const reason = servedNameAndValidity(consoleUrl, served, now);
  if (reason) return { verified: false, error: reason };
  const directory = await mkdtemp(join(tmpdir(), 'opensphere-console-chain-'));
  try {
    const path = join(directory, 'console.crt');
    await writeFile(path, served.toString(), 'utf8');
    const [shell, ...shellArgs] = powershellCommand({ run });
    const output = run(shell, [...shellArgs, '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(windowsChainScript(path), 'utf16le').toString('base64')], { capture: true });
    const result = JSON.parse(output);
    const status = [].concat(result.status ?? []).map(String);
    const verified = result.built === true && status.length === 0;
    return { verified, error: verified ? null : (status.join(',') || 'ChainNotBuilt'), status, rootSha256: result.rootSha256 ?? null };
  } catch (error) {
    return { verified: false, error: `WindowsChainCheckFailed: ${String(error.message).split('\n')[0]}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * PowerShell 7 when present; otherwise the Windows PowerShell 5.1 that every Windows has. The trust
 * installer and the chain check use only APIs both provide (checked 2026-10-11), so trust-ca needs no
 * extra install. `-ExecutionPolicy Bypass` applies to that one process only; no policy is changed.
 */
export function powershellCommand({ run = defaultRun } = {}) {
  try {
    run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { capture: true });
    return ['pwsh'];
  } catch {
    return ['powershell.exe', '-ExecutionPolicy', 'Bypass'];
  }
}

/**
 * Adds exactly this CA to Windows CurrentUser\Root through the reviewed installer, which refuses a
 * different fingerprint. Nothing is removed. Callers have checked planInstallationCaTrust().eligible.
 */
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
