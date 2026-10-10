import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { connect } from 'node:tls';
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
    const port = server.address().port;
    const url = `https://localhost:${port}`;
    assert.equal((await verifyServedByCa(url, out.ca)).authorized, true);
    // Another installation's CA with the shared legacy name does not verify it: the RKE2 failure, reproduced.
    const other = await verifyServedByCa(url, LEGACY);
    assert.equal(other.authorized, false);
    // The same listener reached under a name the certificate does not carry (the leaf always names
    // localhost and 127.0.0.1, so the connection is routed there): the TLS session completes and the
    // refusal is the name check itself, not a connection failure.
    const sameListener = (options, callback) => connect({ ...options, host: '127.0.0.1' }, callback);
    const wrongHost = await verifyServedByCa(`https://console.not-in-san.test:${port}`, out.ca, { connectFn: sameListener });
    assert.deepEqual([wrongHost.authorized, wrongHost.error, wrongHost.servedSubject], [false, 'ERR_TLS_CERT_ALTNAME_INVALID', 'CN=localhost']);
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
  assert.match(cli, /readInstallationIdentity\(\{ kubectl \}\)/);
  assert.match(cli, /const windows = await verifyServedByWindowsChain\(consoleUrl\)/);
  assert.match(cli, /if \(windows\.verified !== true\) process\.exitCode = 1/);
});

test('trust-ca runs the installer with PowerShell 7 when present and otherwise with Windows PowerShell', async () => {
  const { powershellCommand } = await import('../src/installation-ca.mjs');
  assert.deepEqual(powershellCommand({ run: () => '' }), ['pwsh']);
  assert.deepEqual(powershellCommand({ run: () => { throw new Error('ENOENT'); } }), ['powershell.exe', '-ExecutionPolicy', 'Bypass']);
});

test('the trusted-root signature match tries every same-name CA and is reported as supporting evidence only', { skip: !PWSH && 'pwsh unavailable' }, async () => {
  const { matchTrustedRootSignature } = await import('../src/installation-ca.mjs');
  // Legacy certificates (no key identifiers): the RKE2 Console leaf and its CA (public fixtures), and
  // another CA with the same shared name trusted earlier.
  const leaf = new X509Certificate(readFileSync(join(ROOT, 'test', 'fixtures', 'legacy-console-leaf.crt'), 'utf8'));
  const earlier = generate(['-DnsNames', 'console.example.test']).ca;
  const fetchFn = async () => leaf;
  const url = 'https://console.opensphere.triangles.com';
  const before = await matchTrustedRootSignature(url, { fetchFn, systemCas: () => [earlier] });
  assert.deepEqual([before.matched, before.error], [false, 'CERT_SIGNATURE_FAILURE']);
  // Both trusted, the earlier one first: still matched to the right CA.
  const after = await matchTrustedRootSignature(url, { fetchFn, systemCas: () => [earlier, LEGACY] });
  assert.deepEqual([after.matched, after.issuerSha256, after.candidatesWithSameName], [true, inspectInstallationCa(LEGACY).sha256, 2]);
  assert.equal((await matchTrustedRootSignature('https://other.example.test', { fetchFn, systemCas: () => [LEGACY] })).error, 'HOSTNAME_MISMATCH');
  assert.equal((await matchTrustedRootSignature(url, { fetchFn, systemCas: () => [] })).error, 'UNABLE_TO_GET_ISSUER_CERT');
  // New certificates carry key identifiers, so a same-name CA of another installation is not even a candidate.
  const serving = generate(['-DnsNames', 'console.example.test', '-InstallationId', ID]);
  const other = generate(['-DnsNames', 'console.example.test', '-InstallationId', ID]).ca;
  const newLeaf = new X509Certificate(serving.leaf);
  const onlyOther = await matchTrustedRootSignature('https://console.example.test', { fetchFn: async () => newLeaf, systemCas: () => [other] });
  assert.deepEqual([onlyOther.matched, onlyOther.candidatesWithSameName], [false, 0]);
  assert.equal((await matchTrustedRootSignature('https://console.example.test', { fetchFn: async () => newLeaf, systemCas: () => [other, serving.ca] })).matched, true);
  // The CLI reports it under its own name, beside Windows' verification, never as the result.
  const cli = readFileSync(join(ROOT, 'src', 'cli.mjs'), 'utf8');
  assert.match(cli, /trustedRootSignatureMatch: signature/);
  assert.doesNotMatch(cli, /systemTrustVerifiesConsole/);
});

test('a per-installation CA must name the installation recorded on this cluster; the legacy name is reported as not proven', () => {
  const legacy = inspectInstallationCa(LEGACY);
  const ok = { authorized: true, error: null };
  const plan = (ca, installation) => planInstallationCaTrust({ ca, served: ok, consoleUrl: 'https://c.example', platform: 'win32', installation });
  const legacyPlan = plan(legacy, { installationId: ID });
  assert.deepEqual([legacyPlan.eligible, legacyPlan.installationBinding, legacyPlan.recordedInstallationId], [true, 'not-proven-legacy-name', ID]);
  const perInstallation = { ...legacy, form: 'per-installation', installationId: ID };
  assert.deepEqual([plan(perInstallation, { installationId: ID }).eligible, plan(perInstallation, { installationId: ID }).installationBinding], [true, 'matched']);
  const other = plan(perInstallation, { installationId: '1a2b3c4d-0000-4000-8000-000000000000' });
  assert.equal(other.installationBinding, 'mismatch');
  assert.match(other.blockers.join(), /InstallationIdMismatch: the CA names installation 0f9c2d4e/);
  assert.match(plan(perInstallation, null).blockers.join(), /InstallationIdentityUnavailable/);
});

test('the installation identity is read without creating one and refused when it belongs to another cluster', async () => {
  const { readInstallationIdentity } = await import('../src/installation-identity.mjs');
  const UID = '8cdee47b-abb7-4dba-b989-cf9ca292efcb';
  const stored = (clusterUid) => JSON.stringify({ immutable: true, data: { installationId: ID, clusterUid, createdAt: '2026-10-01T00:00:00Z' } });
  const fake = (text) => (args) => {
    if (args.includes('create')) throw new Error('must not create');
    return args.includes('kube-system') ? UID : text;
  };
  assert.deepEqual(readInstallationIdentity({ kubectl: fake(stored(UID)) }), { installationId: ID, clusterUid: UID });
  assert.equal(readInstallationIdentity({ kubectl: fake('') }), null);
  assert.throws(() => readInstallationIdentity({ kubectl: fake(stored('00000000-0000-0000-0000-000000000000')) }), /another cluster/);
});

test('a CA that is not valid yet is refused', { skip: !PWSH && 'pwsh unavailable' }, () => {
  const out = generate(['-DnsNames', 'console.example.test', '-InstallationId', ID]);
  const start = new Date(new X509Certificate(out.ca).validFrom);
  assert.throws(() => inspectInstallationCa(out.ca, { now: new Date(start.getTime() - 3600 * 1000) }), /not valid yet/);
});

// The installer on its own (as bootstrap calls it), in a copy whose store write throws instead, so a
// broken guard can never add a certificate to the real store.
function windowsPowerShells() {
  if (process.platform !== 'win32') return [];
  return [PWSH, 'powershell.exe'].filter(Boolean).filter((shell, index, all) => all.indexOf(shell) === index).filter((shell) => {
    try { execFileSync(shell, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'pipe' }); return true; } catch { return false; }
  });
}
const SHELLS = windowsPowerShells();

test('the installer verifies the CA self-signature and validity before any store access', { skip: (!PWSH || !SHELLS.length) && 'Windows PowerShell unavailable' }, () => {
  const source = readFileSync(join(ROOT, 'src', 'Install-LocalDevelopmentCa.ps1'), 'utf8');
  const write = '& $certutil -user -f -addstore Root $resolved | Out-Null';
  assert.ok(source.includes(write));
  assert.ok(source.indexOf('NotSignatureValid') < source.indexOf('X509Store]::new'));
  assert.ok(source.indexOf('NotBefore') < source.indexOf('X509Store]::new'));
  const directory = mkdtempSync(join(tmpdir(), 'opensphere-ca-installer-'));
  try {
    const installer = join(directory, 'installer.ps1');
    writeFileSync(installer, source.replace(write, "throw 'STORE-REACHED'"));
    const good = generate(['-DnsNames', 'console.example.test', '-InstallationId', ID]).ca;
    const der = Buffer.from(good.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
    der[der.length - 3] ^= 0x01; // inside the signature
    const bad = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
    const files = { good, bad };
    for (const [name, pem] of Object.entries(files)) writeFileSync(join(directory, `${name}.crt`), pem);
    const attempt = (shell, name) => {
      const sha256 = normalizeSha256(new X509Certificate(files[name]).fingerprint256);
      try {
        execFileSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer,
          '-CertificatePath', join(directory, `${name}.crt`), '-ExpectedSha256', sha256], { stdio: 'pipe' });
        return 'completed';
      } catch (error) { return String(error.stderr || error.message); }
    };
    for (const shell of SHELLS) {
      assert.match(attempt(shell, 'bad'), /self-signature does not verify/, shell);
      assert.match(attempt(shell, 'good'), /STORE-REACHED/, shell);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Windows chain verification checks the name first and reports the chain engine result', { skip: !PWSH && 'pwsh unavailable' }, async () => {
  const { verifyServedByWindowsChain } = await import('../src/installation-ca.mjs');
  const serving = generate(['-DnsNames', 'console.example.test', '-InstallationId', ID]);
  const leaf = new X509Certificate(serving.leaf);
  const fetchFn = async () => leaf;
  const url = 'https://console.example.test';
  assert.deepEqual(await verifyServedByWindowsChain(url, { fetchFn, platform: 'linux' }), { verified: null, error: 'NotWindows' });
  const calls = [];
  const fakeRun = (output) => (command, args) => { calls.push([command, ...args].join(' ')); return args.includes('-EncodedCommand') ? output : ''; };
  assert.equal((await verifyServedByWindowsChain('https://other.example.test', { fetchFn, platform: 'win32', run: fakeRun('{}') })).error, 'HOSTNAME_MISMATCH');
  assert.equal(calls.length, 0);
  const ok = await verifyServedByWindowsChain(url, { fetchFn, platform: 'win32', run: fakeRun('{"built":true,"status":[],"rootSha256":"ab"}') });
  assert.deepEqual([ok.verified, ok.error, ok.rootSha256], [true, null, 'ab']);
  // Windows PowerShell 5.1 writes a one-element array as a string.
  const untrusted = await verifyServedByWindowsChain(url, { fetchFn, platform: 'win32', run: fakeRun('{"built":false,"status":"UntrustedRoot"}') });
  assert.deepEqual([untrusted.verified, untrusted.status], [false, ['UntrustedRoot']]);
  if (process.platform === 'win32') {
    // The real engine: this generated CA is in no store, so Windows does not verify the Console.
    const real = await verifyServedByWindowsChain(url, { fetchFn });
    assert.equal(real.verified, false);
    assert.ok(real.status.length > 0, JSON.stringify(real));
  }
});
