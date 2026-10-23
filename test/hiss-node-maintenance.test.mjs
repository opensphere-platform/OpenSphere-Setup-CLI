import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllDocuments } from 'yaml';
import artifact from '../src/hiss-node-maintenance-artifact.json' with {type:'json'};
import {NODE_MAINTENANCE_SOURCE,nodeMaintenanceApplyOrder,nodeMaintenanceFenceExpressions,prepareHissNodeMaintenance,verifyHissNodeMaintenanceArtifact} from '../src/hiss-prerequisites.mjs';

// Node reboot coordination design 2026-10-22 (user decision "모두 권고안대로 (권장)"): Setup prepares every permission
// of the Cluster Manager HISS facility node-maintenance and the two admission fences; Cluster Manager installs kured.
const scope={context:'rke2',channel:'edge',consoleUrl:'https://console.example.test'};
const docs=()=>parseAllDocuments(artifact.yaml).map(d=>d.toJSON()).filter(Boolean);
const find=(kind,name)=>docs().find(d=>d.kind===kind&&d.metadata.name===name);

test('the artifact is the pinned Cluster Manager source bytes',()=>{
 assert.equal(verifyHissNodeMaintenanceArtifact(artifact.yaml),artifact.yaml);
 assert.throws(()=>verifyHissNodeMaintenanceArtifact(artifact.yaml.replace('verbs: ["get", "list"]','verbs: ["get", "list", "delete"]')),{code:'UNTRUSTED_PROFILE'});
 assert.match(NODE_MAINTENANCE_SOURCE.revision,/^[0-9a-f]{40}$/);
 assert.equal(NODE_MAINTENANCE_SOURCE.path,'deploy/hiss-node-maintenance.yaml');
 assert.doesNotMatch(artifact.yaml,/\r/);
});

test('exactly the design objects: P1-P8, the operation-record Role and the kured ingress policy',()=>{
 assert.deepEqual(docs().map(d=>`${d.kind}/${d.metadata.namespace||''}/${d.metadata.name}`).sort(),[
  'ClusterRole//opensphere-hiss-kured','ClusterRoleBinding//opensphere-hiss-kured',
  'Namespace//opensphere-node-maintenance',
  'NetworkPolicy/opensphere-node-maintenance/opensphere-node-maintenance-ingress',
  'Role/monitoring/opensphere-hiss-node-maintenance-monitoring','Role/opensphere-console/opensphere-hiss-node-maintenance-recorder',
  'Role/opensphere-node-maintenance/opensphere-hiss-kured-lock','Role/opensphere-node-maintenance/opensphere-hiss-node-maintenance-executor',
  'RoleBinding/monitoring/opensphere-hiss-node-maintenance-monitoring','RoleBinding/opensphere-console/opensphere-hiss-node-maintenance-recorder',
  'RoleBinding/opensphere-node-maintenance/opensphere-hiss-kured-lock','RoleBinding/opensphere-node-maintenance/opensphere-hiss-node-maintenance-executor',
  'ServiceAccount/opensphere-node-maintenance/kured',
  'ValidatingAdmissionPolicy//opensphere-hiss-kured-writer-fence','ValidatingAdmissionPolicy//opensphere-hiss-node-maintenance-workload',
  'ValidatingAdmissionPolicyBinding//opensphere-hiss-kured-writer-fence','ValidatingAdmissionPolicyBinding//opensphere-hiss-node-maintenance-workload',
 ].sort());
 for(const d of docs())assert.equal(d.metadata.labels['opensphere.io/authority'],'hiss-chart-execution-v1');
});

test('kured: drain, cordon and its own lock only; no pods delete; Cluster Manager gets no RBAC, exec or token rights',()=>{
 assert.deepEqual(find('ClusterRole','opensphere-hiss-kured').rules,[
  {apiGroups:[''],resources:['nodes'],verbs:['get','patch']},{apiGroups:[''],resources:['pods'],verbs:['get','list']},
  {apiGroups:[''],resources:['pods/eviction'],verbs:['create']},{apiGroups:['apps'],resources:['daemonsets'],verbs:['get']}]);
 assert.deepEqual(find('Role','opensphere-hiss-kured-lock').rules,[{apiGroups:['apps'],resources:['daemonsets'],resourceNames:['kured'],verbs:['update']}]);
 assert.deepEqual(find('ClusterRoleBinding','opensphere-hiss-kured').subjects,[{kind:'ServiceAccount',name:'kured',namespace:'opensphere-node-maintenance'}]);
 for(const name of ['opensphere-hiss-node-maintenance-executor','opensphere-hiss-node-maintenance-monitoring','opensphere-hiss-node-maintenance-recorder']){
  for(const rule of find('Role',name).rules){
   assert.ok(!rule.apiGroups.includes('rbac.authorization.k8s.io'));
   assert.ok(!rule.verbs.some(v=>['*','bind','escalate','impersonate'].includes(v)));
   assert.ok(!rule.resources.some(r=>['*','pods/exec','pods/attach','serviceaccounts','serviceaccounts/token','nodes'].includes(r)));
  }
 }
 assert.deepEqual(find('Role','opensphere-hiss-node-maintenance-monitoring').rules,[{apiGroups:['networking.k8s.io'],resources:['networkpolicies'],
  resourceNames:['opensphere-prometheus-node-maintenance-access'],verbs:['get','update','patch','delete']}]);
 assert.deepEqual(find('Role','opensphere-hiss-node-maintenance-recorder').rules,[{apiGroups:[''],resources:['configmaps'],
  resourceNames:['opensphere-his-operation-node-maintenance'],verbs:['get','update']}]);
});

test('the fences deny by default and bind every approved kured flag and the image digest',()=>{
 for(const name of ['opensphere-hiss-kured-writer-fence','opensphere-hiss-node-maintenance-workload']){
  assert.equal(find('ValidatingAdmissionPolicy',name).spec.failurePolicy,'Fail');
  assert.deepEqual(find('ValidatingAdmissionPolicyBinding',name).spec,{policyName:name,validationActions:['Deny']});
 }
 const fence=nodeMaintenanceFenceExpressions(artifact.yaml);
 assert.match(fence.approvedDigests,/^\['sha256:[a-f0-9]{64}'\]$/);
 for(const flag of ['--concurrency=1','--drain-timeout=30m','--reboot-command=/bin/systemctl reboot','--alert-filter-match-only=true','--prometheus-url=http://kube-prometheus-stack-prometheus.monitoring.svc:9090'])
  assert.ok(fence.fixedArgs.includes(`'${flag}'`),flag);
 const workload=find('ValidatingAdmissionPolicy','opensphere-hiss-node-maintenance-workload');
 assert.deepEqual(workload.spec.matchConstraints.namespaceSelector,{matchLabels:{'kubernetes.io/metadata.name':'opensphere-node-maintenance'}});
 assert.ok(workload.spec.validations.some(v=>v.expression.includes("object.type == 'helm.sh/release.v1'")),'no service-account-token Secret for kured');
});

function runner(present={},{namespaces=['monitoring','opensphere-console'],livePolicy=name=>find('ValidatingAdmissionPolicy',name)}={}){
 const calls=[];
 const fn=(exe,args,options)=>{
  assert.equal(exe,'kubectl');assert.deepEqual(args.slice(0,2),['--context','rke2']);calls.push({args,input:options?.input});
  if(args[2]==='get'&&args[3]==='namespace')return namespaces.includes(args[4])?`namespace/${args[4]}\n`:'';
  if(args[2]==='get'&&args[3]==='-f')return docs().filter(d=>present[d.metadata.name+'/'+d.kind]).map(d=>`${d.kind.toLowerCase()}/${d.metadata.name}`).join('\n');
  if(args[2]==='get'&&args[3]==='validatingadmissionpolicy')return JSON.stringify(livePolicy(args[4]));
  if(args[2]==='apply'){assert.ok(args.includes('--server-side'));assert.ok(args.includes('--field-manager=opensphere-setup-hiss'));assert.ok(!args.includes('--force-conflicts'));return '';}
  assert.fail('unexpected '+args.join(' '));
 };
 return {fn,calls};
}
const all=()=>Object.fromEntries(docs().map(d=>[d.metadata.name+'/'+d.kind,true]));

test('plan is read-only: blocked without monitoring, NeedsPreparation, Present, NeedsUpdate for an older fence',()=>{
 const blocked=runner({},{namespaces:['opensphere-console']});
 assert.deepEqual(prepareHissNodeMaintenance(artifact.yaml,scope,{runner:blocked.fn}),{state:'Blocked',reason:'NamespacesMissing',missing:['monitoring'],applied:false});
 const fresh=runner();assert.equal(prepareHissNodeMaintenance(artifact.yaml,scope,{runner:fresh.fn}).state,'NeedsPreparation');
 const done=runner(all());assert.equal(prepareHissNodeMaintenance(artifact.yaml,scope,{runner:done.fn}).state,'Present');
 const olderDigest=name=>{const p=structuredClone(find('ValidatingAdmissionPolicy',name));
  if(name==='opensphere-hiss-node-maintenance-workload')p.spec.variables=p.spec.variables.map(v=>v.name==='approvedDigests'?{...v,expression:"['sha256:"+'0'.repeat(64)+"']"}:v);return p;};
 const stale=runner(all(),{livePolicy:olderDigest});assert.deepEqual(prepareHissNodeMaintenance(artifact.yaml,scope,{runner:stale.fn}),
  {state:'NeedsUpdate',reason:'FenceRevisionDiffers',fences:['opensphere-hiss-node-maintenance-workload'],applied:false,resourceCount:17});
 // A tightened validation (not only the digest) is a new revision too.
 const olderValidation=name=>{const p=structuredClone(find('ValidatingAdmissionPolicy',name));if(name==='opensphere-hiss-kured-writer-fence')p.spec.validations=p.spec.validations.slice(1);return p;};
 assert.equal(prepareHissNodeMaintenance(artifact.yaml,scope,{runner:runner(all(),{livePolicy:olderValidation}).fn}).state,'NeedsUpdate');
 for(const r of [fresh,done,stale])assert.ok(r.calls.every(c=>c.args[2]==='get'),'plan never writes');
});

test('apply: the fences first, then the permissions, server-side under the HISS field manager, never forcing conflicts',()=>{
 const r=runner();
 assert.deepEqual(prepareHissNodeMaintenance(artifact.yaml,scope,{runner:r.fn,apply:true}),{state:'Applied',applied:true,resourceCount:17});
 const applies=r.calls.filter(c=>c.args[2]==='apply');assert.equal(applies.length,2);
 const {fences,permissions}=nodeMaintenanceApplyOrder(artifact.yaml);
 assert.deepEqual([applies[0].input,applies[1].input],[fences,permissions]);
 const kinds=text=>parseAllDocuments(text).map(d=>d.toJSON()).filter(Boolean).map(d=>d.kind);
 assert.deepEqual(kinds(fences).sort(),['ValidatingAdmissionPolicy','ValidatingAdmissionPolicy','ValidatingAdmissionPolicyBinding','ValidatingAdmissionPolicyBinding']);
 assert.equal(kinds(permissions).length,13);assert.ok(!kinds(permissions).some(k=>k.startsWith('ValidatingAdmission')));
 // A failed fence apply stops before any permission is applied.
 const failing=runner();let n=0;
 assert.throws(()=>prepareHissNodeMaintenance(artifact.yaml,scope,{apply:true,runner:(e,a,o)=>{if(a[2]==='apply'){n++;throw Error('fence rejected');}return failing.fn(e,a,o);}}),/fence rejected/);
 assert.equal(n,1);
 assert.throws(()=>prepareHissNodeMaintenance(artifact.yaml.replace('kured','kured2'),scope,{runner:r.fn,apply:true}),{code:'UNTRUSTED_PROFILE'});
});
