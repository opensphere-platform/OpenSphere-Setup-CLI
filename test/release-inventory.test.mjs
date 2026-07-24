import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseResourceInventory } from '../src/bootstrap.mjs';

test('release inventory decodes manifests without patching live CRDs', () => {
  const calls = [];
  const inventory = releaseResourceInventory(
    [{ path: 'release.yaml', yaml: 'multi-document release' }],
    (args, options) => {
      calls.push({ args, options });
      return [
        'apps/v1\tDeployment\topensphere-console\tconsole',
        'apiextensions.k8s.io/v1\tCustomResourceDefinition\t\tuipluginregistrations.plugins.opensphere.io',
        ''
      ].join('\n');
    }
  );

  assert.deepEqual(calls[0].args, [
    'create', '--dry-run=client', '--validate=false', '-f', '-',
    '-o', 'jsonpath={.apiVersion}{"\\t"}{.kind}{"\\t"}{.metadata.namespace}{"\\t"}{.metadata.name}{"\\n"}'
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
