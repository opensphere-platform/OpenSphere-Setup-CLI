import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';
import { renderRegistryKubernetesEgress, KUBERNETES_EGRESS_SLOT, discoverConsoleApiCiliumPolicy } from '../src/registry-runtime-access.mjs';

// Execute the actual materialization function with only external I/O isolated.
// A render-only test missed the old branch that wrote raw instead of verified egress.
const source = await readFile(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
const begin = source.indexOf('async function materializeFoundationInstallers(');
const end = source.indexOf('\nfunction currentKubeContext()', begin);
assert.ok(begin >= 0 && end > begin);
const body = source.slice(begin, end);
const dependencyBegin = source.indexOf('export async function fetchFoundationInstallerArtifacts(');
const dependencyEnd = source.indexOf('\nfunction isPreRecoveryRelease(', dependencyBegin);
assert.ok(dependencyBegin >= 0 && dependencyEnd > dependencyBegin);
const dependencyBody = source.slice(dependencyBegin, dependencyEnd).replace(/^export /, '');
const raw = 'image: __OPENSPHERE_CONSOLE_API_IMAGE__\norigin: __OPENSPHERE_CONSOLE_URL__\negress:\n  - ' + KUBERNETES_EGRESS_SLOT + '\n';
const rules = [{to:[{ipBlock:{cidr:'10.96.0.1/32'}}],ports:[{protocol:'TCP',port:443}]}];
const KNOWLEDGE_LOCK_PATH='apps/osaa-gateway/knowledge-bundle/lock.json';
const knowledge={schema:'synthetic-source-package',sha256:'a'.repeat(64),knowledgeImage:'synthetic-verified-image'};
function harness(discovered = rules, cilium=false) {
  const writes = []; const knowledgeCalls=[]; let discoveries = 0;
  const context = {
    Set, Promise, KUBERNETES_EGRESS_SLOT, KNOWLEDGE_LOCK_PATH, join,
    isTargetConsoleRelease: () => true,
    foundationManifestSpecs: () => [{path:'apps/console-api/deploy.yaml'}],
    foundationArtifactPaths: () => [KNOWLEDGE_LOCK_PATH],
    fetchReleaseArtifact: async (_lock,path) => path===KNOWLEDGE_LOCK_PATH ? JSON.stringify(knowledge) : raw,
    materializeKnowledgeDirectory: async (lock,directory,options) => {knowledgeCalls.push({lock,directory,options});},
    kubectl: args => {
      assert.deepEqual(Array.from(args),['get','customresourcedefinition','ciliumnetworkpolicies.cilium.io','--ignore-not-found','-o','json']);
      return cilium ? JSON.stringify({metadata:{name:'ciliumnetworkpolicies.cilium.io'},spec:{group:'cilium.io',names:{kind:'CiliumNetworkPolicy'}}}) : '';
    },
    discoverRegistryKubernetesEgress: () => { discoveries++; return discovered; },
    renderRegistryKubernetesEgress,
    discoverConsoleApiCiliumPolicy,
    renderManifest: (_lock,_spec,value,_sc,_url,_auth,{kubernetesApiEgress}) =>
      renderRegistryKubernetesEgress(value,kubernetesApiEgress)
        .replace('__OPENSPHERE_CONSOLE_API_IMAGE__','ghcr.io/example/api@sha256:'+'a'.repeat(64))
        .replace('__OPENSPHERE_CONSOLE_URL__','https://localhost:1114'),
    materializeSupabaseMigrationSet: async () => ({evidence:{}}),
    writeReleaseArtifact: async (_root,path,contents) => { writes.push({path,contents}); },
  };
  context.fetchFoundationInstallerArtifacts = vm.runInNewContext('(' + dependencyBody + ')',context);
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

test('Cilium compatibility policy reaches both preflight and the actual PowerShell installer template',async()=>{
  const h=harness(rules,true);
  const result=await h.run({sourceRevision:'a'.repeat(40),knowledge},'/unused','longhorn','https://console.example.test','production');
  const installer=h.writes.find(w=>w.path==='apps/console-api/deploy.yaml').contents;
  assert.match(installer,/"kind":"CiliumNetworkPolicy"/);
  assert.match(result.release[0].yaml,/"toEntities":\["kube-apiserver"\]/);
  assert.equal(installer.split('---\n')[1],result.release[0].yaml.split('---\n')[1]);
});

// 2026-09-27: B0 (a component record) carried Knowledge edge.12 promoted by a Console Knowledge
// release while its Gateway source named edge.7, so preparing it as the rollback baseline of an
// integrated upgrade failed before anything ran.
const recorded={...knowledge,sha256:'c'.repeat(64),knowledgeImage:'synthetic-promoted-image'};
test('reinstalling a component record admits its recorded Knowledge through the installer release root',async()=>{
  const h=harness();
  const result=await h.run({sourceRevision:'a'.repeat(40),releaseScope:'component',knowledge:recorded},'/unused','standard','https://localhost:1114','development');
  const locks=h.writes.filter(w=>w.path===KNOWLEDGE_LOCK_PATH);
  assert.equal(locks.length,2);
  assert.deepEqual(JSON.parse(locks[0].contents),knowledge);
  assert.deepEqual(JSON.parse(locks[1].contents),recorded);
  assert.equal(h.knowledgeCalls.length,1);
  assert.deepEqual(h.knowledgeCalls[0].lock,recorded);
  assert.equal(result.knowledgeDirectory,join('/unused','verified-knowledge'));
});
test('a newly resolved integrated release still needs exactly its Gateway source Knowledge',async()=>{
  for(const lock of [{sourceRevision:'a'.repeat(40),knowledge:recorded},{sourceRevision:'a'.repeat(40),releaseScope:'integrated',knowledge:recorded},
    {sourceRevision:'a'.repeat(40),releaseScope:'component'}]){
    const h=harness();
    await assert.rejects(h.run(lock,'/unused','standard','https://localhost:1114','development'),/exact source-admitted Knowledge package/);
    assert.equal(h.writes.filter(w=>w.path===KNOWLEDGE_LOCK_PATH).length,1);
    assert.equal(h.knowledgeCalls.length,0);
  }
});
