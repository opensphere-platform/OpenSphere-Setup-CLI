import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseResourceInventory } from '../src/bootstrap.mjs';

test('release inventory decodes manifests without patching live CRDs', () => {
  const calls = [];
  const inventory = releaseResourceInventory(
    [{ path: 'release.yaml', yaml: 'multi-document release' }],
    (args, options) => {
      calls.push({ args, options });
      return JSON.stringify({
        apiVersion: 'v1',
        kind: 'List',
        items: [
          {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { namespace: 'opensphere-console', name: 'console' }
          },
          {
            apiVersion: 'apiextensions.k8s.io/v1',
            kind: 'CustomResourceDefinition',
            metadata: { name: 'uipluginregistrations.plugins.opensphere.io' }
          }
        ]
      });
    }
  );

  assert.deepEqual(calls[0].args, [
    'create', '--dry-run=client', '--validate=false', '-f', '-', '-o', 'json'
  ]);
  assert.equal(calls[0].options.capture, true);
  assert.equal(calls[0].options.input, 'multi-document release');
  assert.deepEqual(inventory, [{
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    name: 'console',
    namespace: 'opensphere-console'
  }]);
});
