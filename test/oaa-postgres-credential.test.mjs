import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSecretData } from '../src/bootstrap.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// OpenSphere-console manifests (console-services.yaml / backend/backbone/bootstrap/backbone.yaml,
// CONSTITUTION-0004 §4.5 OAA bootstrap boundary) require a dedicated, independently-generated
// opensphere-backbone/backbone-postgres oaa_password key for the OAA gateway's own
// least-privilege PostgreSQL role, distinct from the Console runtime `password` and the
// superuser `bootstrap_password`.

test('mergeSecretData: existing data always wins over freshly-generated candidate data (idempotent preservation)', () => {
  const existing = { password: 'ZXhpc3Rpbmc=', oaa_password: 'ZXhpc3Rpbmctb2Fh' };
  const candidate = { password: 'bmV3', bootstrap_password: 'bmV3', oaa_password: 'bmV3' };
  const merged = mergeSecretData(existing, candidate);
  assert.equal(merged.password, existing.password, 'an existing password must never be rotated by a re-run');
  assert.equal(merged.oaa_password, existing.oaa_password, 'an existing non-empty oaa_password must be preserved exactly, not regenerated');
  assert.equal(merged.bootstrap_password, candidate.bootstrap_password, 'a key absent from existing data must be added from the candidate');
});

test('mergeSecretData: an empty-object existing data (clean bootstrap) takes every candidate key, including oaa_password', () => {
  const candidate = { password: 'cA==', bootstrap_password: 'YnA=', oaa_password: 'b2Fh' };
  const merged = mergeSecretData({}, candidate);
  assert.deepEqual(merged, candidate);
});

test('mergeSecretData: an explicit empty-string existing value is falsy and is still replaced (never left blank)', () => {
  // ensureGenericSecret's own `missing` check uses the same falsy test
  // (`!existing?.data?.[key]`), so an empty string is treated as absent.
  const merged = mergeSecretData({ oaa_password: '' }, { oaa_password: 'ZnJlc2g=' });
  assert.equal(merged.oaa_password, 'ZnJlc2g=');
});

// The file also contains an unrelated, narrower ensureGenericSecret('opensphere-backbone',
// 'backbone-postgres', ...) call in the legacy-upgrade bootstrap_password backfill path, and
// another in the oaa_password upgrade backfill path (both asserted separately below). Anchor on
// the clean-bootstrap block specifically via the unique `password: hex(32),` + `bootstrap_password:
// hex(32),` pair that only appears together in the clean-bootstrap credential literal object.
function cleanBootstrapCredentialBlock(source) {
  const anchor = source.match(/password:\s*hex\(32\),\r?\n\s*bootstrap_password:\s*hex\(32\),/);
  assert.ok(anchor, 'clean bootstrap must declare password and bootstrap_password together as the backbone-postgres literal object');
  const start = anchor.index;
  const end = source.indexOf("}, { 'ca.crt': ca });", start);
  assert.ok(end >= 0);
  return source.slice(start, end);
}

test('clean bootstrap declares an independently hex(32)-generated oaa_password on the backbone-postgres Secret, in the same ensureGenericSecret call as password/bootstrap_password', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const body = cleanBootstrapCredentialBlock(source);
  assert.match(body, /password:\s*hex\(32\)/);
  assert.match(body, /bootstrap_password:\s*hex\(32\)/);
  assert.match(body, /oaa_password:\s*hex\(32\)/);
});

test('oaa_password is never assigned by reusing the password or bootstrap_password expression/value', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const body = cleanBootstrapCredentialBlock(source);
  // Each credential key must be its own independent hex(32) call (a fresh
  // randomBytes draw), not a shared variable or a copy of another key. The
  // clean-bootstrap block declares password, bootstrap_password, oaa_password and
  // backup_password -- four independent draws (backup_password asserted in detail
  // in the opensphere_backup credential tests below).
  const calls = body.match(/hex\(32\)/g) || [];
  assert.equal(calls.length, 4, 'password, bootstrap_password, oaa_password and backup_password must each call hex(32) independently');
  assert.doesNotMatch(body, /oaa_password:\s*password\b/);
  assert.doesNotMatch(body, /oaa_password:\s*bootstrap_password\b/);
});

test('an upgrade/resume of a legacy installation adds a missing oaa_password via ensureGenericSecret (add-missing-key semantics), unconditionally in prepareUpgradePrerequisites', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/async function prepareUpgradePrerequisites\(consoleUrl\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'prepareUpgradePrerequisites must be defined');
  const body = match[1];
  assert.match(body, /ensureGenericSecret\('opensphere-backbone', 'backbone-postgres', \{ oaa_password: hex\(32\) \}, \{\}\)/,
    'prepareUpgradePrerequisites must idempotently backfill oaa_password using ensureGenericSecret, which preserves any existing value');
  const backfillIndex = body.indexOf("ensureGenericSecret('opensphere-backbone', 'backbone-postgres', { oaa_password: hex(32) }, {})");
  const earlyReturnIndex = body.indexOf('if (!needsPostgresTls && !needsRustfsTls)');
  assert.ok(backfillIndex >= 0 && earlyReturnIndex >= 0);
  assert.ok(backfillIndex < earlyReturnIndex, 'the oaa_password backfill must run unconditionally, before the no-TLS-migration early return');
});

test('the upgrade rollback snapshot list still covers backbone-postgres so an oaa_password backfill can be rolled back on verification failure', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/async function prepareUpgradePrerequisites\(consoleUrl\) \{\s*const snapshots = \[([\s\S]*?)\];/);
  assert.ok(match, 'prepareUpgradePrerequisites must define a snapshots array');
  assert.match(match[1], /readSecretSnapshot\('opensphere-backbone', 'backbone-postgres'\)/);
});

test('installation verification requires oaa_password on opensphere-backbone/backbone-postgres and fails closed when absent', async () => {
  const source = await readFile(join(ROOT, 'src', 'verify.mjs'), 'utf8');
  const match = source.match(/'opensphere-backbone\/backbone-postgres':\s*\[([^\]]*)\]/);
  assert.ok(match, 'REQUIRED_SECRETS must declare opensphere-backbone/backbone-postgres');
  assert.match(match[1], /'password'/);
  assert.match(match[1], /'bootstrap_password'/);
  assert.match(match[1], /'oaa_password'/);
});

test('the Secret carrying oaa_password is applied via stdin JSON, never via --from-literal on argv', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const fnMatch = source.match(/function ensureGenericSecret\([\s\S]*?\n\}/);
  assert.ok(fnMatch, 'ensureGenericSecret must be defined');
  const body = fnMatch[0];
  assert.match(body, /applyYaml\(`\$\{JSON\.stringify\(/);
  // The function body contains only an explanatory comment referencing the
  // argv-observable form (`kubectl --from-literal`, no `=`); it must never
  // actually invoke kubectl with a `--from-literal=` argument.
  assert.doesNotMatch(body, /--from-literal=/);
});

// -----------------------------------------------------------------------------
// opensphere_backup credential (dedicated, read-only pg_dump role)
//
// OpenSphere-console backbone.yaml provisions a least-privilege opensphere_backup
// PostgreSQL role (pg_read_all_data) that the scheduled backup job authenticates
// as. Its credential is a dedicated backbone-postgres/backup_password key, distinct
// from the Console runtime `password`, the superuser `bootstrap_password`, and the
// OAA `oaa_password`. These tests mirror the oaa_password contract above.
// -----------------------------------------------------------------------------

test('clean bootstrap declares an independently hex(32)-generated backup_password on the backbone-postgres Secret, in the same ensureGenericSecret call as password/bootstrap_password', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const body = cleanBootstrapCredentialBlock(source);
  assert.match(body, /password:\s*hex\(32\)/);
  assert.match(body, /bootstrap_password:\s*hex\(32\)/);
  assert.match(body, /backup_password:\s*hex\(32\)/);
});

test('backup_password is never assigned by reusing the password, bootstrap_password or oaa_password expression/value', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const body = cleanBootstrapCredentialBlock(source);
  assert.doesNotMatch(body, /backup_password:\s*password\b/);
  assert.doesNotMatch(body, /backup_password:\s*bootstrap_password\b/);
  assert.doesNotMatch(body, /backup_password:\s*oaa_password\b/);
});

test('an upgrade/resume of a legacy installation adds a missing backup_password via ensureGenericSecret (add-missing-key semantics), unconditionally in prepareUpgradePrerequisites', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/async function prepareUpgradePrerequisites\(consoleUrl\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'prepareUpgradePrerequisites must be defined');
  const body = match[1];
  assert.match(body, /ensureGenericSecret\('opensphere-backbone', 'backbone-postgres', \{ backup_password: hex\(32\) \}, \{\}\)/,
    'prepareUpgradePrerequisites must idempotently backfill backup_password using ensureGenericSecret, which preserves any existing value');
  const backfillIndex = body.indexOf("ensureGenericSecret('opensphere-backbone', 'backbone-postgres', { backup_password: hex(32) }, {})");
  const earlyReturnIndex = body.indexOf('if (!needsPostgresTls && !needsRustfsTls)');
  assert.ok(backfillIndex >= 0 && earlyReturnIndex >= 0);
  assert.ok(backfillIndex < earlyReturnIndex, 'the backup_password backfill must run unconditionally, before the no-TLS-migration early return');
});

test('mergeSecretData preserves an existing backup_password while still adding it when absent', () => {
  // Existing value must win (never rotated on resume/upgrade)...
  const preserved = mergeSecretData(
    { backup_password: 'ZXhpc3RpbmctYmFja3Vw' },
    { backup_password: 'bmV3', oaa_password: 'bmV3' }
  );
  assert.equal(preserved.backup_password, 'ZXhpc3RpbmctYmFja3Vw', 'an existing backup_password must never be rotated by a re-run');
  assert.equal(preserved.oaa_password, 'bmV3', 'a key absent from existing data must be added from the candidate');
  // ...but a missing/blank value is filled from the fresh candidate.
  assert.equal(mergeSecretData({}, { backup_password: 'ZnJlc2g=' }).backup_password, 'ZnJlc2g=');
  assert.equal(mergeSecretData({ backup_password: '' }, { backup_password: 'ZnJlc2g=' }).backup_password, 'ZnJlc2g=');
});

test('installation verification requires backup_password on opensphere-backbone/backbone-postgres and fails closed when absent', async () => {
  const source = await readFile(join(ROOT, 'src', 'verify.mjs'), 'utf8');
  const match = source.match(/'opensphere-backbone\/backbone-postgres':\s*\[([^\]]*)\]/);
  assert.ok(match, 'REQUIRED_SECRETS must declare opensphere-backbone/backbone-postgres');
  assert.match(match[1], /'password'/);
  assert.match(match[1], /'bootstrap_password'/);
  assert.match(match[1], /'oaa_password'/);
  assert.match(match[1], /'backup_password'/);
});
