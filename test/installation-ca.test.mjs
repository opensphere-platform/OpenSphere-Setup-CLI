import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectInstallationCa, installationCaSubject, normalizeSha256, planInstallationCaTrust,
  readInstalledConsoleCa, verifyServedByCa,
} from '../src/installation-ca.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LEGACY = readFileSync(join(ROOT, 'test', 'fixtures', 'legacy-installation-ca.crt'), 'utf8');
const ID = '0f9c2d4e-1a2b-4c3d-8e9f-0123456789ab';

function pwsh() {
  for (const candidate of [process.env.PWSH, 'pwsh'].filter(Boolean)) {
    try { execFileSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' }); return candidate; } catch {}
  }
  return null;
}
const PWSH = pwsh();

// Generates one installation's certificates with the real script; the directory is removed afterwards.
function generate(args) {
  const directory = mkdtempSync(join(tmpdir(), 'opensphere-ca-test-'));
  execFileSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'src', 'New-Certificates.ps1'), '-OutputDirectory', directory, ...args], { stdio: 'pipe' });
  const read = (name) => readFileSync(join(directory, name), 'utf8');
  const files = readdirSync(directory).sort();
  const result = { files, ca: read('ca.crt'), leaf: read('tls.crt'), key: read('tls.key') };
  rmSync(directory, { recursive: true, force: true });
  return result;
}

test('a new installation CA is named after the installation and linked to its leaf by key identifiers', { skip: !PWSH && 'pwsh unavailable' }, () => {
  const out = generate(['-DnsNames', 'console.example.test', '-InstallationId', ID]);
  // The CA private key is never written: only these four files exist, and ca.crt holds no key.
  assert.deepEqual(out.files, ['ca.crt', 'sig.key', 'tls.crt', 'tls.key']);
  assert.doesNotMatch(out.ca, /PRIVATE KEY/);
  const ca = new X509Certificate(out.ca), leaf = new X509Certificate(out.leaf);
  assert.equal(ca.subject, installationCaSubject(ID).split(', ').reverse().join('\n'));
  assert.equal(leaf.subject, 'CN=console.example.test');
  assert.equal(leaf.issuer, ca.subject);
  assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
  assert.match(leaf.subjectAltName, /DNS:console\.example\.test/);
  // AKI of the leaf equals SKI of the CA (lets a client pick the issuer by key, not by name).
  const ski = execFileSync('openssl', ['x509', '-noout', '-ext', 'subjectKeyIdentifier'], { input: out.ca }).toString().split('\n')[1]?.trim();
  const aki = execFileSync('openssl', ['x509', '-noout', '-ext', 'authorityKeyIdentifier'], { input: out.leaf }).toString().split('\n')[1]?.trim();
  assert.ok(ski && ski === aki.replace(/^keyid:/, ''), `${ski} vs ${aki}`);
  const inspected = inspectInstallationCa(out.ca);
  assert.deepEqual([inspected.form, inspected.installationId], ['per-installation', ID]);
});

test('without an installation identity the generator keeps the legacy name, and an invalid id is refused', { skip: !PWSH && 'pwsh unavailable' }, () => {
  const legacy = generate(['-DnsNames', 'console.example.test']);
  assert.equal(new X509Certificate(legacy.ca).subject, 'CN=OpenSphere Installation CA');
  assert.throws(() => generate(['-InstallationId', 'not-a-uuid']));
});

test('only an OpenSphere installation CA is accepted for trust, legacy or per-installation, never a leaf or an expiring CA', { skip: !PWSH && 'pwsh unavailable' }, () => {
  const legacy = inspectInstallationCa(LEGACY);
  assert.equal(legacy.form, 'legacy-shared-name');
  assert.equal(legacy.sha256, '02d835f188ed41edeb551b79dd2f8d49f2ce291527264abeb0a00567b2f10785');
  const out = generate(['-DnsNames', 'console.example.test', '-InstallationId', ID]);
  assert.throws(() => inspectInstallationCa(out.leaf), /Not an OpenSphere installation CA/);
  assert.throws(() => inspectInstallationCa(out.ca + out.ca), /exactly one/);
  // Five years of validity from now: a day before the end it is refused.
  const end = new Date(new X509Certificate(out.ca).validTo);
  assert.throws(() => inspectInstallationCa(out.ca, { now: new Date(end.getTime() - 12 * 3600 * 1000) }), /expires/);
  assert.equal(inspectInstallationCa(out.ca, { now: new Date(end.getTime() - 3 * 24 * 3600 * 1000) }).form, 'per-installation');
  assert.equal(normalizeSha256(legacy.sha256.replace(/(..)/g, '$1:').slice(0, -1).toUpperCase()), legacy.sha256);
});

test('trusting requires the served Console to verify with this CA and, to apply, the fingerprint the operator compared', () => {
  const ca = inspectInstallationCa(LEGACY);
  const ok = { authorized: true, error: null };
  const plan = (over) => planInstallationCaTrust({ ca, served: ok, consoleUrl: 'https://c.example', platform: 'win32', ...over });
  assert.equal(plan({}).eligible, true);
  assert.match(plan({ apply: true }).blockers.join(), /ExpectedFingerprintRequired/);
  assert.match(plan({ apply: true, expectedSha256: 'a'.repeat(64) }).blockers.join(), /FingerprintMismatch/);
  assert.equal(plan({ apply: true, expectedSha256: ca.sha256.toUpperCase() }).eligible, true);
  assert.match(plan({ served: { authorized: false, error: 'CERT_SIGNATURE_FAILURE' } }).blockers.join(), /ServedCertificateNotSignedByThisCa/);
  assert.match(plan({ apply: true, expectedSha256: ca.sha256, platform: 'linux' }).blockers.join(), /UnsupportedPlatform/);
});

test('the served-certificate check accepts only the CA that signed the server and checks the host name', { skip: !PWSH && 'pwsh unavailable' }, async () => {
  const out = generate(['-DnsNames', 'localhost', '-InstallationId', ID]);
  const server = createServer({ cert: out.leaf, key: out.key }, (_, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `https://localhost:${server.address().port}`;
    assert.equal((await verifyServedByCa(url, out.ca)).authorized, true);
    // Another installation's CA with the shared legacy name does not verify it: the RKE2 failure, reproduced.
    const other = await verifyServedByCa(url, LEGACY);
    assert.equal(other.authorized, false);
    const wrongHost = await verifyServedByCa(`https://127.0.0.2:${server.address().port}`, out.ca).catch((e) => ({ authorized: false, error: e.code }));
    assert.equal(wrongHost.authorized === true && wrongHost.error === null, false);
  } finally {
    server.close();
  }
});

test('reading the installed CA asks kubectl only for public fields and refuses an external certificate', () => {
  const calls = [];
  const fake = (secret) => (args) => {
    calls.push(args.join(' '));
    const path = args.at(-1);
    if (path.includes('source-secret')) return secret.source || '';
    if (path.includes('ca\\.crt')) return secret.ca || '';
    throw new Error('unexpected field ' + path);
  };
  assert.equal(readInstalledConsoleCa({ kubectl: fake({ ca: Buffer.from(LEGACY).toString('base64') }) }), LEGACY);
  assert.ok(calls.every((call) => !call.includes('tls.key') && !/ -o json( |$)/.test(call) && / -o jsonpath=\{/.test(call)), calls.join('\n'));
  assert.throws(() => readInstalledConsoleCa({ kubectl: fake({ source: 'tls/customer-cert' }) }), /external certificate tls\/customer-cert/);
  assert.throws(() => readInstalledConsoleCa({ kubectl: fake({}) }), /no ca\.crt/);
});

test('bootstrap names the CA after the installation, shows its fingerprint and installs trust only for that fingerprint', () => {
  const bootstrap = readFileSync(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  assert.match(bootstrap, /'-InstallationId', preparedState\.config\.installationId/);
  assert.match(bootstrap, /SHA-256 \$\{installedCa\.sha256\}/);
  assert.match(bootstrap, /'-ExpectedSha256', installedCa\.sha256/);
  const cli = readFileSync(join(ROOT, 'src', 'cli.mjs'), 'utf8');
  assert.match(cli, /command === 'trust-ca'/);
  assert.match(cli, /if \(!plan\.eligible\) throw/);
  assert.match(cli, /verifyServedBySystemTrust\(consoleUrl\)/);
});

test('trust-ca runs the installer with PowerShell 7 when present and otherwise with Windows PowerShell', async () => {
  const { powershellCommand } = await import('../src/installation-ca.mjs');
  assert.deepEqual(powershellCommand({ run: () => '' }), ['pwsh']);
  assert.deepEqual(powershellCommand({ run: () => { throw new Error('ENOENT'); } }), ['powershell.exe', '-ExecutionPolicy', 'Bypass']);
});
