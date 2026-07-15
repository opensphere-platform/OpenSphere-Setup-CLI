import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// console-services.yaml (a BASE_MANIFESTS entry) mounts
// opensphere-backbone/opensphere-console-auth-ca as the OAA gateway's trust
// anchor. Clean bootstrap must create that Secret before any BASE_MANIFESTS
// entry is applied, or the gateway is unschedulable on first apply.
test('clean bootstrap creates the Backbone CA Secret before BASE_MANIFESTS apply', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const backboneCaIndex = source.indexOf("ensureGenericSecret('opensphere-backbone', 'opensphere-console-auth-ca'");
  const releaseLoopIndex = source.indexOf('for (const spec of BASE_MANIFESTS)');
  assert.ok(backboneCaIndex >= 0, 'bootstrap must create opensphere-backbone/opensphere-console-auth-ca');
  assert.ok(releaseLoopIndex >= 0, 'bootstrap must apply BASE_MANIFESTS');
  assert.ok(backboneCaIndex < releaseLoopIndex, 'Backbone CA Secret must be created before BASE_MANIFESTS apply');
});

test('clean bootstrap mirrors only the public ca.crt into the Backbone namespace, never a private key or leaf cert', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/ensureGenericSecret\('opensphere-backbone', 'opensphere-console-auth-ca',\s*\{\},\s*\{([^}]*)\}\);/);
  assert.ok(match, 'Backbone CA Secret must be created via ensureGenericSecret with only file-backed data');
  assert.match(match[1], /'ca\.crt':\s*ca/);
  assert.doesNotMatch(match[1], /'tls\.crt'/);
  assert.doesNotMatch(match[1], /'tls\.key'/);
  assert.doesNotMatch(match[1], /'sig\.key'/);
});

test('the upgrade CA mirror helper reads and writes only ca.crt on Kubernetes JSON/YAML stdin, never argv', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/function mirrorConsoleAuthCaToBackbone\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'mirrorConsoleAuthCaToBackbone must be defined');
  const body = match[0];
  // Uses the JSON-on-stdin Secret apply path (applyYaml/JSON.stringify), never
  // `kubectl ... --from-literal=` which would place the CA value on argv.
  assert.match(body, /applyYaml\(`\$\{JSON\.stringify\(/);
  assert.doesNotMatch(body, /--from-literal/);
  // Only ca.crt is read from the source and written to the target; unrelated
  // existing target keys are preserved via a spread of the existing data.
  assert.match(body, /source\.data\?\.\['ca\.crt'\]/);
  assert.match(body, /\.\.\.\(existing\?\.data \|\| \{\}\),\s*'ca\.crt':\s*sourceCa/);
});

test('prepareUpgradePrerequisites invokes the CA mirror unconditionally, before the no-TLS-migration early return', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/async function prepareUpgradePrerequisites\(consoleUrl\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'prepareUpgradePrerequisites must be defined');
  const body = match[1];
  const mirrorIndex = body.indexOf('mirrorConsoleAuthCaToBackbone()');
  const earlyReturnIndex = body.indexOf('if (!needsPostgresTls && !needsRustfsTls)');
  assert.ok(mirrorIndex >= 0, 'prepareUpgradePrerequisites must call mirrorConsoleAuthCaToBackbone');
  assert.ok(earlyReturnIndex >= 0, 'prepareUpgradePrerequisites must retain the no-TLS-migration early return');
  assert.ok(mirrorIndex < earlyReturnIndex, 'CA mirror must run before the CBS-no-migration early return, not be bypassed by it');
});

test('the rollback snapshot list for upgrade prerequisites covers the Backbone CA Secret', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/async function prepareUpgradePrerequisites\(consoleUrl\) \{\s*const snapshots = \[([\s\S]*?)\];/);
  assert.ok(match, 'prepareUpgradePrerequisites must define a snapshots array');
  assert.match(match[1], /readSecretSnapshot\('opensphere-backbone', 'opensphere-console-auth-ca'\)/);
});

test('restarting trust consumers after prerequisite changes includes the Backbone OAA gateway in its own namespace', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/function restartBackboneTrustConsumers\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'restartBackboneTrustConsumers must be defined');
  const body = match[0];
  assert.match(body, /\['opensphere-backbone', 'opensphere-console-oaa-gateway'\]/);
  // Restart iterates namespace/deployment pairs rather than assuming a single
  // namespace for every consumer.
  assert.match(body, /for \(const \[namespace, deployment\] of \[/);
  assert.match(body, /kubectl\(\['-n', namespace, 'rollout', 'restart', `deployment\/\$\{deployment\}`\]\)/);
});

test('upgrade still invokes prepareUpgradePrerequisites and a conditional trust-consumer restart before applying the target release', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const match = source.match(/export async function upgrade\([\s\S]*?\n\}/);
  assert.ok(match, 'upgrade must be defined');
  const body = match[0];
  const prereqIndex = body.indexOf('operations.prepareUpgradePrerequisites(');
  const applyIndex = body.indexOf('operations.applyRelease(targetRelease');
  const restartIndex = body.indexOf('operations.restartBackboneTrustConsumers()');
  assert.ok(prereqIndex >= 0 && applyIndex >= 0 && restartIndex >= 0);
  assert.ok(prereqIndex < applyIndex, 'prerequisites (including the CA mirror) must run before the target release apply');
});
