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
  ['opensphere-console', 'opensphere-console-backend'],
  ['opensphere-console', 'opensphere-console-dupa-controller'],
  ['opensphere-console', 'opensphere-notification-dispatcher'],
  ['opensphere-console', 'opensphere-external-channel-executor'],
  ['opensphere-console', 'opensphere-console-oaa-gateway'],
  ['opensphere-console', 'oaa-governed-adapter'],
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

test('installation verification requires every Supabase/Gitea/Main Shell Service endpoint', () => {
  const { services, slices } = fixture();
  assert.equal(verifyRequiredServiceEndpoints(services, slices).length, required.length);
  slices[0].endpoints[0].conditions.ready = false;
  assert.throws(
    () => verifyRequiredServiceEndpoints(services, slices),
    /has no ready EndpointSlice endpoint: opensphere-console-data\/opensphere-supabase-postgres/
  );
});
