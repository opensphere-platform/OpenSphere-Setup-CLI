import test from 'node:test';
import assert from 'node:assert/strict';
import {beszelCleanupJob,beszelInspectionJob,purgeBeszelHostState,purgeExternalConsoleRbac} from '../src/uninstall-residuals.mjs';
const lock={releaseDigest:'sha256:'+'a'.repeat(64),components:{beszelBootstrap:{image:'ghcr.io/opensphere-platform/opensphere-console-beszel-bootstrap@sha256:'+'b'.repeat(64)}}};
function hostRuntime(){
  const state={events:[],plan:null,daemon:{metadata:{uid:'agent-uid'},spec:{template:{spec:{volumes:[{hostPath:{path:'/var/lib/opensphere/beszel-agent'}}]}}}},
    nodes:[{metadata:{name:'node-a',uid:'node-uid'},status:{conditions:[{type:'Ready',status:'True'}]}}]};
  const run=(args,options={})=>{
    state.events.push(args.join(' '));
    if(args[0]==='create'){
      const object=JSON.parse(options.input);
      if(object.kind==='ConfigMap'){state.plan=object;return '';}
      state.job=object;return JSON.stringify({metadata:{name:object.metadata.generateName+'test'}});
    }
    if(args.includes('configmap'))return state.plan?JSON.stringify(state.plan):'';
    if(args.includes('nodes'))return JSON.stringify({items:state.nodes});
    if(args.includes('pods'))return JSON.stringify({items:state.pods||[]});
    if(args.includes('get')&&args.includes('daemonset'))return state.daemon?JSON.stringify(state.daemon):'';
    if(args.includes('delete')&&args.includes('daemonset'))state.daemon=null;
    if(state.failWait&&args.includes('wait'))throw Error('cleanup timeout');
    return '';
  };return {state,run};
}
test('cleanup is pinned to installed utility and exact Console host path',()=>{
  const job=beszelCleanupJob('node-a',lock.components.beszelBootstrap.image,lock.releaseDigest);
  assert.equal(job.spec.template.spec.volumes[0].hostPath.path,'/var/lib/opensphere/beszel-agent');
  assert.equal(job.spec.template.spec.automountServiceAccountToken,false);
  assert.equal(job.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation,false);
  assert.throws(()=>beszelCleanupJob('node-a','busybox:latest',lock.releaseDigest),/installed/);
  assert.throws(()=>beszelCleanupJob('../node',lock.components.beszelBootstrap.image,lock.releaseDigest),/node/);
});
test('stop agents before per-node cleanup and require completed Job',()=>{
  const {state,run}=hostRuntime();
  assert.deepEqual(purgeBeszelHostState(lock,{run}),{nodes:['node-a'],status:'Purged'});
  const stop=state.events.findIndex(e=>e.includes('delete daemonset'));
  const create=state.events.findIndex(e=>e==='create -f - -o json');
  assert.ok(stop>=0&&stop<create);
  assert.equal(state.job.spec.template.spec.nodeName,'node-a');
  assert.ok(state.events.some(e=>e.includes('--for=condition=complete')));
});
test('offline and replaced nodes fail before agent deletion',()=>{
  const {state,run}=hostRuntime();state.nodes[0].status.conditions[0].status='False';
  assert.throws(()=>purgeBeszelHostState(lock,{run}),/not Ready/);
  assert.ok(!state.events.some(e=>e.includes('delete')));
  state.nodes[0].status.conditions[0].status='True';state.nodes[0].metadata.uid='replacement';
  assert.throws(()=>purgeBeszelHostState(lock,{run}),/replaced/);
});
test('failed cleanup remains resumable after agent deletion',()=>{
  const {state,run}=hostRuntime();state.failWait=true;
  assert.throws(()=>purgeBeszelHostState(lock,{run}),/timeout/);
  assert.equal(state.daemon,null);assert.ok(state.plan);
  state.failWait=false;
  assert.equal(purgeBeszelHostState(lock,{run}).status,'Purged');
});
test('an interrupted install before Beszel needs successful read-only inspection of every node',()=>{
  const {state,run}=hostRuntime();state.daemon=null;
  assert.deepEqual(purgeBeszelHostState(lock,{run}),{nodes:['node-a'],status:'VerifiedEmpty'});
  assert.equal(state.plan,null,'inspection must not invent a deleted DaemonSet ownership checkpoint');
  assert.equal(state.job.spec.template.spec.containers[0].volumeMounts[0].readOnly,true);
  assert.doesNotMatch(state.job.spec.template.spec.containers[0].command.join(' '),/rm |delete/);
  assert.ok(!state.events.some(e=>e.includes('delete daemonset')||e.includes('delete namespace')));
});

test('missing agent with nonempty/unreadable/offline host state or a remaining writer refuses purge',()=>{
  const {state,run}=hostRuntime();state.daemon=null;state.failWait=true;
  assert.throws(()=>purgeBeszelHostState(lock,{run}),/not verified empty/);
  assert.ok(!state.events.some(e=>e.includes('delete')));
  state.failWait=false;state.nodes[0].status.conditions[0].status='False';
  assert.throws(()=>purgeBeszelHostState(lock,{run}),/every exact node/);
  state.nodes[0].status.conditions[0].status='True';
  state.pods=[{status:{phase:'Running'},spec:{volumes:[{hostPath:{path:'/var/lib/opensphere/beszel-agent'}}]}}];
  assert.throws(()=>purgeBeszelHostState(lock,{run}),/live Pod/);
  const job=beszelInspectionJob('node-a',lock.components.beszelBootstrap.image,lock.releaseDigest);
  assert.equal(job.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem,true);
  assert.deepEqual(job.spec.template.spec.containers[0].securityContext.capabilities,{drop:['ALL']});
});
test('shared namespaces are never deleted and foreign RBAC subjects prevent deletion',()=>{
  for(const foreign of [false,true]){
    const calls=[],name='opensphere-extension-controller-kubernetes-egress-discovery';
    const run=(args,opts={})=>{
      calls.push(args);
      if(args.includes('configmap'))return '';
      if(args[0]==='create')return '';
      if(args.includes('get')&&args.includes(name))return JSON.stringify({metadata:{uid:args.includes('role')?'role-uid':'binding-uid'},
        roleRef:{kind:'Role',name},subjects:[{kind:'ServiceAccount',name:'opensphere-extension-controller',namespace:foreign?'foreign':'opensphere-console'}]});
      return '';
    };
    if(foreign){assert.throws(()=>purgeExternalConsoleRbac(lock,{run}),/ownership differs/);assert.ok(!calls.some(a=>a.includes('delete')));}
    else{purgeExternalConsoleRbac(lock,{run});assert.equal(calls.filter(a=>a.includes('delete')).length,2);assert.ok(!calls.some(a=>a.includes('namespace')));}
  }
});
