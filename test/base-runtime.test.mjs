import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE_MANIFESTS } from '../src/bootstrap.mjs';

test('base bootstrap manifests deploy OAA Core as required native Main Shell runtime', () => {
  const paths = BASE_MANIFESTS.map((manifest) => manifest.path);
  assert.equal(paths.includes('backend/backbone/console-services.yaml'), true);
});

test('the OAA Core manifest replaces its canonical digest placeholder with the locked oaaGateway image', () => {
  const spec = BASE_MANIFESTS.find((manifest) => manifest.path === 'backend/backbone/console-services.yaml');
  assert.ok(spec, 'console-services.yaml must be a base manifest');
  assert.deepEqual(spec.replacements, [
    ['ghcr\\.io/opensphere-platform/opensphere-console-oaa-gateway@sha256:[^\\s]+', 'oaaGateway']
  ]);
});

// The real source manifest pins an underscore placeholder, not a hex digest:
// ghcr.io/opensphere-platform/opensphere-console-oaa-gateway@sha256:__OAA_GATEWAY_IMAGE_DIGEST__
// A hex-only pattern (`[a-f0-9]+`) cannot match this and would leave the
// placeholder unresolved, causing clean Setup to fail the governed-image
// gate. Replay the exact fetchManifest replacement and final validator here.
test('the OAA Core replacement resolves the real underscore digest placeholder to the canonical governed image', () => {
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
    '          image: ghcr.io/opensphere-platform/opensphere-console-oaa-gateway@sha256:__OAA_GATEWAY_IMAGE_DIGEST__'
  ].join('\n');

  const resolved = sourceYaml.replace(new RegExp(pattern, 'g'), canonicalImage);
  assert.doesNotMatch(resolved, /__OAA_GATEWAY_IMAGE_DIGEST__/);
  assert.match(resolved, new RegExp(`image: ${canonicalImage.replace(/[.+]/g, '\\$&')}$`, 'm'));

  // This is the same final governed-image validator fetchManifest applies;
  // it must not be weakened to accept the replacement result.
  const imageLine = resolved.match(/^[ \t]*image:[ \t]+["']?([^"'#\s]+)/m)[1];
  assert.match(imageLine, /^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/);
  assert.equal(imageLine, canonicalImage);
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
