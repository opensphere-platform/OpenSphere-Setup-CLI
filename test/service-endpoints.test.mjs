import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRequiredServiceEndpoints } from '../src/verify.mjs';

const required = [
  ['opensphere-console-auth', 'kanidm'], ['opensphere-console-auth', 'kanidm-core'], ['opensphere-console-auth', 'kanidm-ext'],
  ['opensphere-console', 'opensphere-console-auth'], ['opensphere-console', 'opensphere-console-auth-ext'],
  ['opensphere-console', 'opensphere-console-backend'], ['opensphere-console', 'opensphere-console-dupa-controller'], ['opensphere-console', 'opensphere-console-ext'],
  ['opensphere-backbone', 'backbone-postgres'], ['opensphere-backbone', 'backbone-rustfs'], ['opensphere-backbone', 'backbone-gitea'], ['opensphere-backbone', 'opensphere-console-oaa-gateway']
];

function fixture({ ready = true } = {}) {
  return {
    services: required.map(([namespace, name]) => ({ metadata: { namespace, name }, spec: { selector: { app: name } } })),
    slices: required.map(([namespace, name]) => ({
      metadata: { namespace, labels: { 'kubernetes.io/service-name': name } },
      endpoints: [{ conditions: { ready } }]
    }))
  };
}

test('installation verification requires every core Service to have a ready endpoint', () => {
  const { services, slices } = fixture();
  assert.equal(verifyRequiredServiceEndpoints(services, slices).length, 12);
  slices[0].endpoints[0].conditions.ready = false;
  assert.throws(() => verifyRequiredServiceEndpoints(services, slices), /has no ready EndpointSlice endpoint: opensphere-console-auth\/kanidm/);
});
