import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_RUNTIME_COMPONENTS,
  COMPONENTS,
  LOCAL_EDGE_TRUST,
  calculateReleaseDigest,
  validateReleaseTransition,
} from '../src/release.mjs';
import { BASE_MANIFESTS, COMPONENT_ROLLOUTS, renderManifest } from '../src/bootstrap.mjs';

const digest = (value) => `sha256:${value.repeat(64)}`;

function lock({ registry = true } = {}) {
  const names = BASE_RUNTIME_COMPONENTS.filter((name) => registry || name !== 'registry');
  const value = {
    apiVersion: 'release.opensphere.io/v1alpha1',
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: '',
    resolvedAt: '2026-08-24T00:00:00.000Z',
    source: 'https://github.com/opensphere-platform/OpenSphere-console',
    sourceRevision: 'a'.repeat(40),
    trust: structuredClone(LOCAL_EDGE_TRUST),
    components: Object.fromEntries(names.map((name, index) => [name, {
      repository: COMPONENTS[name],
      image: `ghcr.io/opensphere-platform/${COMPONENTS[name]}@${digest((index % 10).toString())}`,
      sourceRevision: 'a'.repeat(40),
    }])),
  };
  value.releaseDigest = calculateReleaseDigest(value.channel, value.components, value.trust);
  return value;
}

test('Registry is a canonical manifest and rollout owner', () => {
  assert.ok(BASE_MANIFESTS.some((item) => item.path === 'backend/registry/deploy/registry.yaml'));
  assert.deepEqual(COMPONENT_ROLLOUTS.registry, [['opensphere-console', 'deployment/opensphere-registry', '600s']]);
});

test('Registry manifest receives exact image and self-reported digest from one lock', () => {
  const current = lock();
  const spec = BASE_MANIFESTS.find((item) => item.path === 'backend/registry/deploy/registry.yaml');
  const source = `image: ghcr.io/opensphere-platform/opensphere-registry@${digest('0')}\n- { name: IMAGE_DIGEST, value: "__OPENSPHERE_REGISTRY_IMAGE_DIGEST__" }`;
  const rendered = renderManifest(current, spec, source, 'standard');
  assert.match(rendered, new RegExp(current.components.registry.image.replaceAll('.', '\\.')));
  assert.match(rendered, new RegExp(current.components.registry.image.split('@')[1]));
  assert.doesNotMatch(rendered, /__OPENSPHERE_/);
});

test('one-way Registry introduction preserves every existing component', () => {
  const base = lock({ registry: false });
  const target = structuredClone(base);
  target.components.registry = {
    repository: COMPONENTS.registry,
    image: `ghcr.io/opensphere-platform/${COMPONENTS.registry}@${digest('e')}`,
    sourceRevision: target.sourceRevision,
  };
  target.releaseScope = 'component';
  target.baseReleaseDigest = base.releaseDigest;
  target.changedComponents = ['registry'];
  target.releaseDigest = calculateReleaseDigest(target.channel, target.components, target.trust, undefined, {
    releaseScope: target.releaseScope,
    baseReleaseDigest: target.baseReleaseDigest,
    changedComponents: target.changedComponents,
  });
  assert.equal(validateReleaseTransition(base, target), target);
  for (const [name, component] of Object.entries(base.components)) assert.deepEqual(target.components[name], component);
});
