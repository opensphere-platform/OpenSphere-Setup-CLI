import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllDocuments } from 'yaml';
import backupAlerting from '../src/hiss-backup-alerting-artifact.json' with {type:'json'};
import scrapeAccess from '../src/hiss-scrape-access-artifact.json' with {type:'json'};
import {BACKUP_ALERTING_SOURCE,SCRAPE_ACCESS_SOURCE,backupAlertingParts,prepareHissBackupAlerting,prepareHissScrapeAccess,selects,
 verifyHissBackupAlertingArtifact,verifyHissScrapeAccessArtifact} from '../src/hiss-backup-alerting.mjs';

// RKE2 readiness stage R1 (plan 2026-10-24, user approval "전부 승인 (권장)"): BK-P6 and AL-P4 Roles with their four
// admission fences, and the AL-P5 Prometheus scrape policies applied only where they cannot cut other traffic.
const scope={context:'rke2',channel:'edge',consoleUrl:'https://console.example.test'};
const docs=raw=>parseAllDocuments(raw).map(d=>d.toJSON()).filter(Boolean);

test('both artifacts are the pinned Cluster Manager bytes',()=>{
 assert.equal(verifyHissBackupAlertingArtifact(backupAlerting.yaml),backupAlerting.yaml);
 assert.equal(verifyHissScrapeAccessArtifact(scrapeAccess.yaml),scrapeAccess.yaml);
 assert.throws(()=>verifyHissBackupAlertingArtifact(backupAlerting.yaml.replace('verbs: ["get"]','verbs: ["get", "list"]')),{code:'UNTRUSTED_PROFILE'});
 assert.throws(()=>verifyHissScrapeAccessArtifact(scrapeAccess.yaml.replace('10254','80')),{code:'UNTRUSTED_PROFILE'});
 for(const source of [BACKUP_ALERTING_SOURCE,SCRAPE_ACCESS_SOURCE])assert.match(source.revision,/^[0-9a-f]{40}$/);
 assert.doesNotMatch(backupAlerting.yaml,/\r/);
});

test('the parts: alerting and Longhorn halves, fences apart from the rights they fence, nothing lost',()=>{
 const parts=backupAlertingParts(backupAlerting.yaml);
 const names=raw=>docs(raw).map(d=>`${d.kind}/${d.metadata.name}`);
 assert.deepEqual(names(parts.alertingFences),['ValidatingAdmissionPolicy/opensphere-hiss-alert-emergency-route','ValidatingAdmissionPolicyBinding/opensphere-hiss-alert-emergency-route']);
 assert.deepEqual(names(parts.alertingPermissions),['Role/opensphere-hiss-core-alerts','RoleBinding/opensphere-hiss-core-alerts']);
 assert.equal(names(parts.backupFences).length,6);assert.ok(names(parts.backupFences).every(n=>n.startsWith('ValidatingAdmission')));
 assert.deepEqual(names(parts.backupPermissions),['Role/opensphere-hiss-backup-executor','RoleBinding/opensphere-hiss-backup-executor']);
 assert.equal(Object.values(parts).flatMap(docs).length,docs(backupAlerting.yaml).length);
 // No Secret write anywhere: the credentials come from prepare-hiss-secret.
 for(const role of docs(backupAlerting.yaml).filter(d=>d.kind==='Role'))for(const rule of role.rules)
  if(rule.resources.includes('secrets'))assert.deepEqual(rule.verbs,['get']);
});

function kube({namespaces=['monitoring','opensphere-console','longhorn-system','ingress-nginx','cert-manager'],crd=true,present=[],pods={},policies={},cilium={}}={}){
 const calls=[];
 const fn=(exe,args,options)=>{
  assert.equal(exe,'kubectl');assert.deepEqual(args.slice(0,2),['--context','rke2']);calls.push({args:args.slice(2),input:options?.input});
  const a=args.slice(2);
  if(a[0]==='get'&&a[1]==='namespace')return namespaces.includes(a[2])?`namespace/${a[2]}`:'';
  if(a[0]==='get'&&a[1]==='customresourcedefinition')return crd?'customresourcedefinition.apiextensions.k8s.io/'+a[2]:'';
  if(a[0]==='get'&&a[1]==='-f')return docs(options.input).filter(d=>present.includes(d.metadata.name)).map(d=>d.kind.toLowerCase()+'/'+d.metadata.name).join('\n');
  if(a[0]==='get'&&a[1]==='validatingadmissionpolicy')return JSON.stringify(docs(backupAlerting.yaml).find(d=>d.kind==='ValidatingAdmissionPolicy'&&d.metadata.name===a[2]));
  if(a[0]==='-n'&&a[2]==='get'&&a[3]==='pods')return JSON.stringify({items:pods[a[1]]||[]});
  if(a[0]==='-n'&&a[2]==='get'&&a[3]==='networkpolicies')return JSON.stringify({items:policies[a[1]]||[]});
  if(a[0]==='-n'&&a[2]==='get'&&a[3]==='ciliumnetworkpolicies.cilium.io'){if(cilium==='absent')throw Error('no such resource');return JSON.stringify({items:cilium[a[1]]||[]});}
  if(a[0]==='apply'){assert.ok(a.includes('--server-side'));assert.ok(a.includes('--field-manager=opensphere-setup-hiss'));assert.ok(!a.includes('--force-conflicts'));return '';}
  if(a[0]==='-n'&&a[2]==='delete')return '';
  assert.fail('unexpected '+a.join(' '));
 };
 return {fn,calls};
}

test('backup and alerting plan: blocked without monitoring, Longhorn half only where Longhorn runs, Present when all match',()=>{
 assert.deepEqual(prepareHissBackupAlerting(backupAlerting.yaml,scope,{runner:kube({namespaces:['opensphere-console']}).fn}),
  {state:'Blocked',reason:'NamespacesMissing',missing:['monitoring'],applied:false});
 const noLonghorn=prepareHissBackupAlerting(backupAlerting.yaml,scope,{runner:kube({crd:false}).fn});
 assert.deepEqual(noLonghorn,{state:'NeedsPreparation',applied:false,resourceCount:4,longhorn:'NotApplicable'});
 const all=docs(backupAlerting.yaml).map(d=>d.metadata.name);
 const k=kube({present:all});
 assert.deepEqual(prepareHissBackupAlerting(backupAlerting.yaml,scope,{runner:k.fn}),{state:'Present',applied:false,resourceCount:12,longhorn:'Included'});
 assert.ok(k.calls.every(c=>c.args[0]==='get'),'plan never writes');
 assert.equal(prepareHissBackupAlerting(backupAlerting.yaml,scope,{runner:kube({present:all.slice(0,3)}).fn}).state,'NeedsUpdate');
});

test('backup and alerting apply: fences before rights, a failed fence stops everything after it',()=>{
 const k=kube();
 assert.deepEqual(prepareHissBackupAlerting(backupAlerting.yaml,scope,{runner:k.fn,apply:true}),{state:'Applied',applied:true,resourceCount:12,longhorn:'Included'});
 const applies=k.calls.filter(c=>c.args[0]==='apply').map(c=>docs(c.input).map(d=>d.kind));
 assert.equal(applies.length,4);
 assert.ok(applies[0].every(x=>x.startsWith('ValidatingAdmission'))&&applies[2].every(x=>x.startsWith('ValidatingAdmission')));
 assert.deepEqual(applies[1],['Role','RoleBinding']);assert.deepEqual(applies[3],['Role','RoleBinding']);
 let n=0;const failing=kube();
 assert.throws(()=>prepareHissBackupAlerting(backupAlerting.yaml,scope,{apply:true,runner:(e,a,o)=>{if(a[2]==='apply'){n++;throw Error('fence rejected');}return failing.fn(e,a,o);}}),/fence rejected/);
 assert.equal(n,1);
});

const controller={metadata:{name:'ingress-nginx-controller-1',labels:{'app.kubernetes.io/name':'ingress-nginx','app.kubernetes.io/component':'controller'}}};
const certManager=['cert-manager','cainjector','webhook'].map(n=>({metadata:{name:n,labels:{'app.kubernetes.io/instance':'cert-manager','app.kubernetes.io/name':n}}}));
const denyAll=(ns,selector={})=>({metadata:{name:'default-deny',namespace:ns},spec:{podSelector:selector,policyTypes:['Ingress']}});
const ours=ns=>docs(scrapeAccess.yaml).find(d=>d.metadata.namespace===ns);

test('scrape access: an unisolated namespace needs nothing, and applying there would have cut traffic, so nothing is applied',()=>{
 const k=kube({pods:{'ingress-nginx':[controller],'cert-manager':certManager}});
 const plan=prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:k.fn});
 assert.deepEqual(plan.policies.map(p=>p.state),['NotNeeded','NotNeeded']);assert.equal(plan.state,'Present');
 const applied=prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:k.fn,apply:true});
 assert.deepEqual(applied.policies.map(p=>p.state),['NotNeeded','NotNeeded']);
 assert.ok(!k.calls.some(c=>c.args[0]==='apply'),'never applied where it would isolate the Pods');
});

test('scrape access: added where a deny-all already isolates the Pods; Cilium policies count; a lone leftover is removed',()=>{
 const isolated=kube({pods:{'ingress-nginx':[controller],'cert-manager':certManager},policies:{'ingress-nginx':[denyAll('ingress-nginx')]},
  cilium:{'cert-manager':[{metadata:{name:'webhook-only'},spec:{endpointSelector:{matchLabels:{'app.kubernetes.io/instance':'cert-manager'}},ingress:[{}]}}]}});
 const plan=prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:isolated.fn});
 assert.deepEqual(plan.policies.map(p=>[p.state,p.isolatedBy]),[['NeedsPreparation',['NetworkPolicy/default-deny']],['NeedsPreparation',['CiliumNetworkPolicy/webhook-only']]]);
 const applied=prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:isolated.fn,apply:true});
 assert.deepEqual(applied.policies.map(p=>p.state),['Applied','Applied']);
 assert.equal(isolated.calls.filter(c=>c.args[0]==='apply').length,2);
 const present=kube({pods:{'ingress-nginx':[controller]},policies:{'ingress-nginx':[denyAll('ingress-nginx'),ours('ingress-nginx')]},cilium:'absent'});
 assert.equal(prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:present.fn}).policies[0].state,'Present');
 // Our policy alone would be the one isolating the controller: it goes on apply.
 const alone=kube({pods:{'ingress-nginx':[controller]},policies:{'ingress-nginx':[ours('ingress-nginx')]}});
 assert.equal(prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:alone.fn}).policies[0].state,'IsolatesAlone');
 assert.equal(prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:alone.fn,apply:true}).policies[0].state,'Removed');
 assert.ok(alone.calls.some(c=>c.args.join(' ').startsWith('-n ingress-nginx delete networkpolicy opensphere-prometheus-scrape')));
 // An egress-only policy, or one selecting other Pods, does not isolate the controller.
 const other=kube({pods:{'ingress-nginx':[controller]},policies:{'ingress-nginx':[{metadata:{name:'egress'},spec:{podSelector:{},policyTypes:['Egress']}},
  denyAll('ingress-nginx',{matchLabels:{app:'something-else'}})]}});
 assert.equal(prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:other.fn}).policies[0].state,'NotNeeded');
 assert.equal(prepareHissScrapeAccess(scrapeAccess.yaml,scope,{runner:kube({namespaces:['monitoring']}).fn}).policies[0].state,'NamespaceMissing');
});

test('label selectors evaluate like Kubernetes',()=>{
 const l={a:'1',b:'2'};
 assert.ok(selects({},l));assert.ok(selects({matchLabels:{a:'1'}},l));assert.ok(!selects({matchLabels:{a:'2'}},l));
 assert.ok(selects({matchExpressions:[{key:'a',operator:'In',values:['1','3']}]},l));assert.ok(!selects({matchExpressions:[{key:'a',operator:'NotIn',values:['1']}]},l));
 assert.ok(selects({matchExpressions:[{key:'c',operator:'DoesNotExist'}]},l));assert.ok(!selects({matchExpressions:[{key:'c',operator:'Exists'}]},l));
 assert.ok(!selects(undefined,l));assert.ok(!selects({matchExpressions:[{key:'a',operator:'Bogus'}]},l));
});
