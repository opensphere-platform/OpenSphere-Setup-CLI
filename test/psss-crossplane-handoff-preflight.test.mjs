import test from 'node:test';
import assert from 'node:assert/strict';
import {MODULES,BINDINGS,observePsssCrossplaneHandoff,
 createPsssCrossplaneHandoffClient} from '../src/psss-crossplane-handoff-preflight.mjs';

const digest='sha256:'+'a'.repeat(64);
function moduleRecord(module){
 const labels={'opensphere.io/extension-id':module.id,'opensphere.io/extension-revision':'reviewed'};
 const image=module.repository+'@'+digest;
 return {
  package:{kind:'UIPluginPackage',metadata:{name:module.id,uid:module.id+'-package',
   resourceVersion:'5'},
   spec:{image:{digest},manifest:{sha256:'c'.repeat(64)},
    resolution:{requestedChannel:'edge',resolvedDigest:digest,
     signatureIdentity:module.signatureIdentity,revision:'b'.repeat(40)}}},
  registration:{kind:'UIPluginRegistration',metadata:{name:module.id,uid:module.id+'-registration',
   resourceVersion:'6',generation:1},status:{
    observedGeneration:1,phase:'Activated',revalidation:{phase:'Passed'},
    verification:{signature:'Verified',manifest:'Verified',entryDigest:'Verified',permissions:'Approved'},
    serving:{phase:'Current',digest,manifestSha256:'c'.repeat(64),
     artifactServiceId:module.id+'-r-reviewed'},
    workload:{phase:'Ready',deployment:module.id+'-r-reviewed'},
    currentDigest:digest,currentRepository:module.repository,currentRequestedChannel:'edge',
    currentRevision:'b'.repeat(40),currentSignatureIdentity:module.signatureIdentity,
    currentManifestSha256:'c'.repeat(64),currentArtifactVersion:'202609290601',
   }},
  deployments:[{kind:'Deployment',metadata:{name:module.id+'-r-reviewed',uid:module.id+'-deploy',
   resourceVersion:'10',generation:1,labels},spec:{replicas:2,selector:{matchLabels:labels},
   template:{spec:{containers:[{image}]}}},status:{observedGeneration:1,updatedReplicas:2,availableReplicas:2}}],
  pods:[0,1].map(i=>({metadata:{name:module.id+'-'+i,uid:module.id+'-pod-'+i,
   resourceVersion:String(i+1),labels},spec:{containers:[{image}]},
   status:{phase:'Running',containerStatuses:[{ready:true,imageID:image}]}})),
  hashes:Object.fromEntries([0,1].map(i=>[module.id+'-'+i,module.sha256])),
 };
}
function binding(row,i){
 return {kind:row.kind,metadata:{name:row.name,...(row.namespace?{namespace:row.namespace}:{}),
  uid:'binding-'+i,resourceVersion:String(i+1)},
  roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:row.roleKind,name:row.roleName},
  subjects:[{kind:'ServiceAccount',name:'opensphere-cluster-manager-runtime',
   namespace:'opensphere-console'}]};
}
function fixture(){
 const modules=new Map(MODULES.map(row=>[row.id,moduleRecord(row)]));
 const bindings=new Map(BINDINGS.map((row,i)=>[row.name,binding(row,i)]));
 return {modules,bindings,operation:{kind:'ConfigMap',metadata:{
   name:'opensphere-his-operation-crossplane-core',namespace:'opensphere-console',
   uid:'drain-uid',resourceVersion:'7',labels:{
    'opensphere.io/platform-core-operation':'crossplane-core',
    'opensphere.io/platform-core-handoff':'suspended'}},data:{}},core:[null,null,null],
  async observeModule(row){return structuredClone(modules.get(row.id));},
  async readOperation(){return structuredClone(this.operation);},
  async readBinding(row){return structuredClone(bindings.get(row.name));},
  async readCore(){return structuredClone(this.core);},
 };
}
test('reviewed live images, guard bytes, drained work and exact CM bindings make the fence stage ready',async()=>{
 const result=await observePsssCrossplaneHandoff(fixture());
 assert.equal(result.state,'Ready');assert.deepEqual(result.blockers,[]);
 assert.deepEqual(result.modules.map(row=>row.state),['Verified','Verified']);
 assert.equal(result.operation.state,'NoRecord');
 assert.equal(result.core,'Absent');
 assert.equal(result.bindings.every(row=>row.state==='ClusterManager'),true);
});
test('a missing guard, active operation and mixed writer cannot be treated as a safe stage',async()=>{
 const f=fixture();
 f.modules.get('cluster-manager').hashes['cluster-manager-0']=null;
 f.operation={kind:'ConfigMap',metadata:{name:'opensphere-his-operation-crossplane-core',
  namespace:'opensphere-console',uid:'operation',resourceVersion:'1',
  labels:{'opensphere.io/platform-core-operation':'crossplane-core',
   'opensphere.io/platform-core-handoff':'suspended'}},
  data:{operation:JSON.stringify({itemId:'crossplane-core',id:'11111111-1111-4111-8111-111111111111',
   phase:'Installing'})}};
 f.bindings.get(BINDINGS[0].name).subjects[0].name='opensphere-platform-support-runtime';
 const result=await observePsssCrossplaneHandoff(f);
 assert.equal(result.state,'Unverified');
 assert.ok(result.blockers.includes('cluster-manager:GuardNotDeployed'));
 assert.ok(result.blockers.includes('CoreOperation:ActiveOrUncertain'));
 assert.ok(result.blockers.includes(BINDINGS[0].name+':PlatformSupport'));
});
test('a stale image, extra pod, present Core or denied read stays unverified',async()=>{
 const f=fixture();
 f.modules.get('platform-support').pods.push(structuredClone(f.modules.get('platform-support').pods[0]));
 f.modules.get('cluster-manager').deployments[0].status.availableReplicas=1;
 f.core[0]={kind:'CustomResourceDefinition'};
 f.readBinding=async row=>{if(row===BINDINGS[1])throw Error('forbidden');return f.bindings.get(row.name);};
 const result=await observePsssCrossplaneHandoff(f);
 assert.equal(result.state,'Unverified');
 assert.ok(result.blockers.includes('cluster-manager:DeploymentUnverified'));
 assert.ok(result.blockers.includes('platform-support:PodUnverified'));
 assert.ok(result.blockers.includes('Core:PresentOrPartial'));
 assert.ok(result.blockers.includes(BINDINGS[1].name+':ObservationUnavailable'));
});
test('a failed signed registration or a package digest mismatch cannot authorize the cutover',async()=>{
 const f=fixture();
 f.modules.get('cluster-manager').registration.status.verification.signature='Rejected';
 f.modules.get('platform-support').registration.status.currentDigest='sha256:'+'d'.repeat(64);
 const result=await observePsssCrossplaneHandoff(f);
 assert.equal(result.state,'Unverified');
 assert.deepEqual(result.modules.map(row=>row.state),
  ['RegistrationUnverified','RegistrationUnverified']);
});
test('an empty CM operation is insufficient without an exclusive new-work drain',async()=>{
 const f=fixture();f.operation=null;
 const result=await observePsssCrossplaneHandoff(f);
 assert.equal(result.operation.state,'NoRecord');
 assert.equal(result.state,'Unverified');
 assert.ok(result.blockers.includes('NewCmCoreWorkNotSuspended'));
});
test('kubectl adapter never uses a mutating verb and places timeout before exec command',async()=>{
 const calls=[],f=createPsssCrossplaneHandoffClient({context:'default',kubectl:'kubectl',
  runner:(_exe,args)=>{calls.push(args);return args.includes('exec')
   ?MODULES[0].sha256+'  '+MODULES[0].path
   :JSON.stringify(args.includes('uipluginpackage')?moduleRecord(MODULES[0]).package:
     args.includes('uipluginregistration')?moduleRecord(MODULES[0]).registration:
     args.includes('deployments')?{items:moduleRecord(MODULES[0]).deployments}:
       {items:moduleRecord(MODULES[0]).pods});}});
 await f.observeModule(MODULES[0]);
 assert.equal(calls.some(args=>args.includes('exec')),true);
 assert.equal(calls.every(args=>!['create','apply','patch','delete'].some(verb=>args.includes(verb))),true);
 const exec=calls.find(args=>args.includes('exec'));
 assert.ok(exec.indexOf('--request-timeout=10s')<exec.indexOf('--'));
});
