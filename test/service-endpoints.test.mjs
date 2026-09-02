import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRequiredServiceEndpoints } from '../src/verify.mjs';

const required = [
  ['opensphere-console-data', 'opensphere-supabase-postgres'],
  ['opensphere-console-data', 'opensphere-supabase-auth'],
  ['opensphere-console-data', 'opensphere-supabase-rest'],
  ['opensphere-console-data', 'opensphere-supabase-storage'],
  ['opensphere-console-change', 'opensphere-gitea-postgres'],
  ['opensphere-console-change', 'opensphere-gitea'],
  ['opensphere-monitoring', 'beszel-hub'],
  ['opensphere-console', 'opensphere-console-api'],
  ['opensphere-console', 'opensphere-registry'],
  ['opensphere-console', 'opensphere-console-ext']
];

function fixture({ ready = true } = {}) {
  return {
    services: required.map(([namespace, name]) => ({
      metadata: { namespace, name },
      spec: { selector: { app: name } }
    })),
    slices: required.map(([namespace, name]) => ({
      metadata: { namespace, labels: { 'kubernetes.io/service-name': name } },
      endpoints: [{ addresses: ['10.0.0.1'], conditions: { ready } }]
    }))
  };
}

test('installation verification requires every Supabase, Gitea, Beszel and Console API Service endpoint', () => {
  const { services, slices } = fixture();
  assert.equal(verifyRequiredServiceEndpoints(services, slices).length, required.length);
  slices[0].endpoints[0].conditions.ready = false;
  assert.throws(
    () => verifyRequiredServiceEndpoints(services, slices),
    /has no ready EndpointSlice endpoint: opensphere-console-data\/opensphere-supabase-postgres/
  );
});

test('a lock-bound CLI artifact requires its independent Service endpoint', () => {
  const { services, slices } = fixture();
  assert.throws(
    () => verifyRequiredServiceEndpoints(services, slices, { includeCliArtifacts: true }),
    /Required Service is missing: opensphere-console\/os-cli/u
  );
  services.push({ metadata: { namespace: 'opensphere-console', name: 'os-cli' } });
  slices.push({
    metadata: {
      namespace: 'opensphere-console',
      labels: { 'kubernetes.io/service-name': 'os-cli' }
    },
    endpoints: [{ addresses: ['10.0.0.2'], conditions: { ready: true } }]
  });
  assert.equal(
    verifyRequiredServiceEndpoints(services, slices, { includeCliArtifacts: true }).length,
    required.length + 1
  );
});

test('Console-activated optional modules are not required during bootstrap verification', () => {
  const { services, slices } = fixture();
  assert.equal(
    services.some(({ metadata }) => ['opensphere-osdst', 'opensphere-console-osaa-gateway'].includes(metadata.name)),
    false
  );
  assert.equal(verifyRequiredServiceEndpoints(services, slices).length, required.length);
});
