import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE_MANIFESTS } from '../src/bootstrap.mjs';

test('base bootstrap manifests deploy OAA Core as required native Main Shell runtime', () => {
  const paths = BASE_MANIFESTS.map((manifest) => manifest.path);
  assert.equal(paths.includes('backend/backbone/console-services.yaml'), true);
});

test('the OAA Core manifest replacement targets only the canonical oaaGateway repository', () => {
  const spec = BASE_MANIFESTS.find((manifest) => manifest.path === 'backend/backbone/console-services.yaml');
  assert.ok(spec, 'console-services.yaml must be a base manifest');
  assert.deepEqual(spec.replacements, [
    ['ghcr\\.io/opensphere-platform/opensphere-console-oaa-gateway(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)', 'oaaGateway']
  ]);
});

// Replay the exact fetchManifest replacement and its final governed-image
// validator (the same `image:` line regex fetchManifest applies) against
// every historically-observed source form of the OAA reference, so a clean
// bootstrap or an upgrade/rollback to any signed prior release keeps working:
//   1. the current source's underscore digest placeholder
//   2. an already-resolved canonical @sha256 digest (e.g. a prior lock file
//      replayed verbatim, or a source revision that pinned a real digest)
//   3. a historical signed release that pinned the canonical repo with a
//      mutable tag (the exact CI failure: :2.0.0-rc.1)
// A substituted repo/org must NOT be replaced and must still fail the
// validator -- governed image acceptance stays scoped to the canonical repo.
function finalGovernedImageValidator(imageLine) {
  return /^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(imageLine);
}

function replayOaaReplacement(sourceImageRef) {
  const spec = BASE_MANIFESTS.find((manifest) => manifest.path === 'backend/backbone/console-services.yaml');
  const [[pattern, component]] = spec.replacements;
  assert.equal(component, 'oaaGateway');

  const canonicalDigest = `sha256:${'a'.repeat(64)}`;
  const canonicalImage = `ghcr.io/opensphere-platform/opensphere-console-oaa-gateway@${canonicalDigest}`;
  const sourceYaml = [
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: oaa-gateway',
    `          image: ${sourceImageRef} # pinned by release manifest`
  ].join('\n');

  const resolved = sourceYaml.replace(new RegExp(pattern, 'g'), canonicalImage);
  const imageLine = resolved.match(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/m)[1];
  return { resolved, imageLine, canonicalImage };
}

test('the OAA Core replacement resolves the current underscore digest placeholder to the canonical governed image', () => {
  const { resolved, imageLine, canonicalImage } = replayOaaReplacement(
    'ghcr.io/opensphere-platform/opensphere-console-oaa-gateway@sha256:__OAA_GATEWAY_IMAGE_DIGEST__'
  );
  assert.doesNotMatch(resolved, /__OAA_GATEWAY_IMAGE_DIGEST__/);
  assert.equal(imageLine, canonicalImage);
  assert.ok(finalGovernedImageValidator(imageLine), 'must not be weakened to accept the replacement result');
});

test('the OAA Core replacement resolves an exact canonical @sha256 digest reference to the locked governed image', () => {
  const historicalDigest = `sha256:${'b'.repeat(64)}`;
  const { imageLine, canonicalImage } = replayOaaReplacement(
    `ghcr.io/opensphere-platform/opensphere-console-oaa-gateway@${historicalDigest}`
  );
  assert.equal(imageLine, canonicalImage);
  assert.ok(finalGovernedImageValidator(imageLine));
});

// This is the observed CI failure (run 29385717474): a historical signed
// release pinned the canonical OAA repository with a mutable tag, and clean
// bootstrap / previous-release rollback against that source revision must
// still rewrite it to the locked, digest-pinned governed image.
test('the OAA Core replacement resolves an exact canonical :tag reference (2.0.0-rc.1) to the locked governed image', () => {
  const { imageLine, canonicalImage } = replayOaaReplacement(
    'ghcr.io/opensphere-platform/opensphere-console-oaa-gateway:2.0.0-rc.1'
  );
  assert.equal(imageLine, canonicalImage);
  assert.ok(finalGovernedImageValidator(imageLine));
});

test('the OAA Core replacement does not broaden acceptance to a substituted repository/org and the result still fails the governed-image validator', () => {
  const { imageLine } = replayOaaReplacement(
    'ghcr.io/some-other-org/opensphere-console-oaa-gateway:2.0.0-rc.1'
  );
  assert.equal(imageLine, 'ghcr.io/some-other-org/opensphere-console-oaa-gateway:2.0.0-rc.1');
  assert.ok(!finalGovernedImageValidator(imageLine), 'a non-canonical repo/org must remain unreplaced and rejected');
});

test('the OAA Core replacement regex stops at YAML token boundaries and does not consume quotes, comments, or whitespace', () => {
  const spec = BASE_MANIFESTS.find((manifest) => manifest.path === 'backend/backbone/console-services.yaml');
  const [[pattern]] = spec.replacements;
  const re = new RegExp(pattern);

  const quoted = re.exec('image: "ghcr.io/opensphere-platform/opensphere-console-oaa-gateway:2.0.0-rc.1"');
  assert.ok(quoted, 'must match inside a quoted scalar');
  assert.equal(quoted[0], 'ghcr.io/opensphere-platform/opensphere-console-oaa-gateway:2.0.0-rc.1');

  const commented = re.exec('image: ghcr.io/opensphere-platform/opensphere-console-oaa-gateway:2.0.0-rc.1 # pinned');
  assert.equal(commented[0], 'ghcr.io/opensphere-platform/opensphere-console-oaa-gateway:2.0.0-rc.1');

  const digestPlaceholder = re.exec('image: ghcr.io/opensphere-platform/opensphere-console-oaa-gateway@sha256:__OAA_GATEWAY_IMAGE_DIGEST__\n');
  assert.equal(digestPlaceholder[0], 'ghcr.io/opensphere-platform/opensphere-console-oaa-gateway@sha256:__OAA_GATEWAY_IMAGE_DIGEST__');
});

test('upgrade materialization uses the canonical base manifest set', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function materializeRelease[\s\S]*?BASE_MANIFESTS\.map/);
  assert.doesNotMatch(source, /\bMANIFESTS\.map/);
});

test('bootstrap never deletes the OAA Core deployment after a base apply', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /removeOptionalOaaStaging/);
  assert.doesNotMatch(source, /delete[\s\S]{0,80}opensphere-console-oaa-gateway/);
});

test('OAA Core rollout is awaited after CBS and before Console readiness completes', () => {
  const source = readFileSync(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
  const match = source.match(/const CORE_ROLLOUTS = \[([\s\S]*?)\];/);
  assert.ok(match, 'CORE_ROLLOUTS must be defined');
  const entries = match[1];
  const cbsIndex = entries.indexOf("'opensphere-backbone', 'deployment/backbone-gitea'");
  const oaaIndex = entries.indexOf("'opensphere-backbone', 'deployment/opensphere-console-oaa-gateway'");
  const consoleIndex = entries.indexOf("'opensphere-console', 'deployment/opensphere-console'");
  assert.ok(cbsIndex >= 0 && oaaIndex >= 0 && consoleIndex >= 0);
  assert.ok(cbsIndex < oaaIndex, 'OAA Core rollout must be awaited after CBS');
  assert.ok(oaaIndex < consoleIndex, 'OAA Core rollout must be awaited before Console readiness completes');
});
