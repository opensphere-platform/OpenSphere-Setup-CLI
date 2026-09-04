import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {auxiliaryCatalogForAnchor,AUXILIARY_ARTIFACTS} from '../src/release.mjs';
import {renderManifest,BASE_MANIFESTS} from '../src/bootstrap.mjs';

test('legacy anchor keeps three artifacts; v1 renderer requires independent content; unknown contract fails',()=>{
  assert.equal(Object.keys(auxiliaryCatalogForAnchor({labels:{}})).length,3);
  assert.deepEqual(auxiliaryCatalogForAnchor({labels:{'io.opensphere.console-index-content':'console-index-renderer/v1'}}),AUXILIARY_ARTIFACTS);
  assert.throws(()=>auxiliaryCatalogForAnchor({labels:{'io.opensphere.console-index-content':'v99'}}),/Unsupported/);
});

test('new Console manifest cannot render without its exact content image; legacy source needs no new artifact',()=>{
  const spec=BASE_MANIFESTS.find(s=>s.path==='deploy/opensphere-console.yaml');
  const consoleSource=process.env.OPENSPHERE_CONSOLE_SOURCE
    ?? fileURLToPath(new URL('../../OpenSphere-console/',import.meta.url));
  const source=fs.readFileSync(path.join(consoleSource,spec.path),'utf8');
  const lock={sourceRevision:'a'.repeat(40),components:{console:{image:'ghcr.io/opensphere-platform/opensphere-console@sha256:'+'b'.repeat(64)}}};
  assert.throws(()=>renderManifest(lock,spec,source,'standard'),/consoleIndexContent/);
  lock.auxiliaryArtifacts={consoleIndexContent:{image:'ghcr.io/opensphere-platform/opensphere-console-index-content:edge'}};
  assert.throws(()=>renderManifest(lock,spec,source,'standard'),/digest-pinned/);
  lock.auxiliaryArtifacts.consoleIndexContent.image='ghcr.io/opensphere-platform/opensphere-console-index-content@sha256:'+'c'.repeat(64);
  const rendered=renderManifest(lock,spec,source,'standard');
  assert.ok(rendered.includes(lock.auxiliaryArtifacts.consoleIndexContent.image));
  assert.ok(!rendered.includes('__OPENSPHERE_'));
  const legacy='apiVersion: v1\nkind: Pod\nmetadata:\n  name: fixture\nspec:\n  containers:\n    - name: shell\n      image: ghcr.io/opensphere-platform/opensphere-console@sha256:'+'b'.repeat(64)+'\n';
  delete lock.auxiliaryArtifacts;
  assert.ok(renderManifest(lock,spec,legacy,'standard').includes(lock.components.console.image));
});
