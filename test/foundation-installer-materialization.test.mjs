import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';
import { renderRegistryKubernetesEgress, KUBERNETES_EGRESS_SLOT } from '../src/registry-runtime-access.mjs';

// Execute the actual materialization function with only external I/O isolated.
// A render-only test missed the old branch that wrote raw instead of verified egress.
const source = await readFile(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
const begin = source.indexOf('async function materializeFoundationInstallers(');
const end = source.indexOf('\nfunction currentKubeContext()', begin);
assert.ok(begin >= 0 && end > begin);
const body = source.slice(begin, end);
const raw = 'image: __OPENSPHERE_CONSOLE_API_IMAGE__\norigin: __OPENSPHERE_CONSOLE_URL__\negress:\n  - ' + KUBERNETES_EGRESS_SLOT + '\n';
const rules = [{to:[{ipBlock:{cidr:'10.96.0.1/32'}}],ports:[{protocol:'TCP',port:443}]}];
const KNOWLEDGE_LOCK_PATH='apps/osaa-gateway/knowledge-bundle/lock.json';
const knowledge={schema:'synthetic-source-package',sha256:'a'.repeat(64),knowledgeImage:'synthetic-verified-image'};
function harness(discovered = rules) {
  const writes = []; const knowledgeCalls=[]; let discoveries = 0;
  const context = {
    Set, Promise, KUBERNETES_EGRESS_SLOT, KNOWLEDGE_LOCK_PATH, join,
    isTargetConsoleRelease: () => true,
    foundationManifestSpecs: () => [{path:'apps/console-api/deploy.yaml'}],
    foundationArtifactPaths: () => [KNOWLEDGE_LOCK_PATH],
    fetchReleaseArtifact: async (_lock,path) => path===KNOWLEDGE_LOCK_PATH ? JSON.stringify(knowledge) : raw,
    materializeKnowledgeDirectory: async (lock,directory,options) => {knowledgeCalls.push({lock,directory,options});},
    kubectl: () => { throw Error('No real kubectl in materialization test'); },
    discoverRegistryKubernetesEgress: () => { discoveries++; return discovered; },
    renderRegistryKubernetesEgress,
    renderManifest: (_lock,_spec,value,_sc,_url,_auth,{kubernetesApiEgress}) =>
      renderRegistryKubernetesEgress(value,kubernetesApiEgress)
        .replace('__OPENSPHERE_CONSOLE_API_IMAGE__','ghcr.io/example/api@sha256:'+'a'.repeat(64))
        .replace('__OPENSPHERE_CONSOLE_URL__','https://localhost:1114'),
    materializeSupabaseMigrationSet: async () => ({evidence:{}}),
    writeReleaseArtifact: async (_root,path,contents) => { writes.push({path,contents}); },
  };
  return { run:vm.runInNewContext('(' + body + ')',context), writes, knowledgeCalls, discoveries:()=>discoveries };
}
test('materialized target installer receives discovered egress and retains only PowerShell-owned placeholders', async () => {
  const h = harness();
  const result = await h.run({sourceRevision:'a'.repeat(40),knowledge},'/unused','standard','https://localhost:1114','development');
  assert.equal(h.discoveries(),1);
  assert.equal(h.writes.length,2);
  const installer=h.writes.find(w=>w.path==='apps/console-api/deploy.yaml');
  assert.ok(installer);
  assert.match(installer.contents,/10.96.0.1\/32/);
  assert.doesNotMatch(installer.contents,/__OPENSPHERE_REGISTRY_KUBERNETES_EGRESS__/);
  assert.match(installer.contents,/__OPENSPHERE_CONSOLE_API_IMAGE__/);
  assert.match(installer.contents,/__OPENSPHERE_CONSOLE_URL__/);
  assert.equal(h.knowledgeCalls.length,1);
  assert.equal(result.knowledgeDirectory,join('/unused','verified-knowledge'));
  assert.doesNotMatch(result.release[0].yaml,/__OPENSPHERE_/);
});
test('failed API discovery cannot write an unresolved installer template', async () => {
  const h = harness([]);
  await assert.rejects(h.run({sourceRevision:'a'.repeat(40)},'/unused','standard','https://localhost:1114','development'), /Registry Kubernetes egress/);
  assert.equal(h.writes.length,0);
});
