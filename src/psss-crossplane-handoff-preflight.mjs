// Read-only live evidence required before the CM Crossplane writer is fenced.
// The pinned hashes are of reviewed source bytes copied into the two images.
import {run} from './process.mjs';
export const MODULES=Object.freeze([
 {id:'cluster-manager',repository:'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager',
  signatureIdentity:'opensphere-module-local-v1',
  path:'/app/platform-core-writer-owner.js',
  sha256:'dd063b6c900eb417d1c42ecd85be5d846324ef7637103010e249312eac6a68be'},
 {id:'platform-support',repository:'ghcr.io/opensphere-platform/opensphere-platform-support',
  signatureIdentity:'opensphere-platform-support-local-v1',
  path:'/app/owner/crossplane-writer-handoff.cjs',
  sha256:'7895753945122b410577f9c7375337731d6b889c1f70e9fc2b725ca0e0734d32'},
]);
const cm={kind:'ServiceAccount',name:'opensphere-cluster-manager-runtime',namespace:'opensphere-console'};
export const BINDINGS=Object.freeze([
 {kind:'RoleBinding',namespace:'crossplane-system',name:'opensphere-platform-support-crossplane-executor',
  roleKind:'Role',roleName:'opensphere-platform-support-crossplane-executor'},
 {kind:'RoleBinding',namespace:'opensphere-console',name:'opensphere-platform-support-core-recorder',
  roleKind:'Role',roleName:'opensphere-platform-support-core-recorder'},
 {kind:'ClusterRoleBinding',namespace:null,name:'opensphere-platform-support-core-observer',
  roleKind:'ClusterRole',roleName:'opensphere-platform-support-core-observer'},
]);
const active=new Set(['Queued','Installing','Upgrading','Recovering','RollingBack','Uninstalling',
 'Validating','Configuring','Migrating']);
const terminal=new Set(['Ready','Removed','Failed','RollbackStalled']);
const digest=/^sha256:[a-f0-9]{64}$/;
const revision=/^[a-f0-9]{40}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function moduleState(module,record){
 const pkg=record?.package,registration=record?.registration,
  deployments=record?.deployments,pods=record?.pods;
 if(!pkg||!registration||!Array.isArray(deployments)||!Array.isArray(pods))
  return {state:'ObservationUnavailable'};
 const resolved=pkg.spec?.resolution,d=pkg.spec?.image?.digest;
 if(pkg.kind!=='UIPluginPackage'||pkg.metadata?.name!==module.id||
  !pkg.metadata?.uid||!pkg.metadata?.resourceVersion||
  pkg.metadata?.deletionTimestamp||resolved?.requestedChannel!=='edge'||
  resolved.signatureIdentity!==module.signatureIdentity||
  !revision.test(resolved.revision||'')||!digest.test(d||'')||resolved.resolvedDigest!==d)
  return {state:'PackageUnverified'};
 const status=registration.status;
 if(registration.kind!=='UIPluginRegistration'||registration.metadata?.name!==module.id||
  !registration.metadata?.uid||!registration.metadata?.resourceVersion||
  registration.metadata?.deletionTimestamp||!Number.isInteger(registration.metadata?.generation)||
  status?.observedGeneration!==registration.metadata.generation||
  status.phase!=='Activated'||status.revalidation?.phase!=='Passed'||
  status.verification?.signature!=='Verified'||status.verification?.manifest!=='Verified'||
  status.verification?.entryDigest!=='Verified'||status.verification?.permissions!=='Approved'||
  status.serving?.phase!=='Current'||status.workload?.phase!=='Ready'||
  status.currentDigest!==d||status.serving.digest!==d||
  status.currentRepository!==module.repository||status.currentRequestedChannel!=='edge'||
  status.currentRevision!==resolved.revision||
  status.currentSignatureIdentity!==module.signatureIdentity||
  status.currentManifestSha256!==pkg.spec.manifest?.sha256||
  status.serving.manifestSha256!==pkg.spec.manifest?.sha256||
  !/^[0-9]{12}$/.test(status.currentArtifactVersion||''))
  return {state:'RegistrationUnverified'};
 if(deployments.length!==1)return {state:'DeploymentUnverified'};
 const deployment=deployments[0],name=deployment.metadata?.name,
  labels=deployment.spec?.selector?.matchLabels||{},replicas=deployment.spec?.replicas;
 const image=module.repository+'@'+d;
 if(deployment.kind!=='Deployment'||!name||deployment.metadata?.deletionTimestamp||
  !deployment.metadata?.uid||!deployment.metadata?.resourceVersion||
  deployment.metadata?.labels?.['opensphere.io/extension-id']!==module.id||
  labels['opensphere.io/extension-id']!==module.id||
  !labels['opensphere.io/extension-revision']||
  !Number.isInteger(replicas)||replicas<1||replicas>10||
  !Number.isInteger(deployment.metadata?.generation)||
  !Number.isInteger(deployment.status?.observedGeneration)||
  deployment.status.observedGeneration<deployment.metadata.generation||
  deployment.status?.updatedReplicas!==replicas||deployment.status?.availableReplicas!==replicas||
  deployment.spec?.template?.spec?.containers?.length!==1||
  deployment.spec.template.spec.containers[0].image!==image)
  return {state:'DeploymentUnverified'};
 if(status.workload.deployment!==name||status.serving.artifactServiceId!==name)
  return {state:'RegistrationUnverified'};
 if(pods.length!==replicas||pods.some(pod=>
  pod.metadata?.deletionTimestamp||
  pod.metadata?.labels?.['opensphere.io/extension-revision']!==labels['opensphere.io/extension-revision']||
  pod.status?.phase!=='Running'||pod.spec?.containers?.length!==1||
  pod.spec.containers[0].image!==image||
  pod.status?.containerStatuses?.length!==1||
  pod.status.containerStatuses[0].ready!==true||
  pod.status.containerStatuses[0].imageID!==image||
  !pod.metadata?.uid||!pod.metadata?.resourceVersion))
  return {state:'PodUnverified'};
 if(pods.some(pod=>record.hashes?.[pod.metadata.name]!==module.sha256))
  return {state:'GuardNotDeployed'};
 return {state:'Verified',digest:d,sourceRevision:resolved.revision,
  registrationUid:registration.metadata.uid,
  registrationResourceVersion:registration.metadata.resourceVersion,
  packageUid:pkg.metadata.uid,packageResourceVersion:pkg.metadata.resourceVersion,
  deploymentUid:deployment.metadata.uid,deploymentResourceVersion:deployment.metadata.resourceVersion,
  pods:pods.map(pod=>({uid:pod.metadata.uid,resourceVersion:pod.metadata.resourceVersion}))};
}
function operationState(value){
 if(value===null)return {state:'NoRecord'};
 if(!value||value.kind!=='ConfigMap'||value.metadata?.namespace!=='opensphere-console'||
  value.metadata?.name!=='opensphere-his-operation-crossplane-core'||!value.metadata?.uid||
  !value.metadata?.resourceVersion||value.metadata?.deletionTimestamp||
  value.metadata?.labels?.['opensphere.io/platform-core-operation']!=='crossplane-core'||
  ![undefined,'suspended'].includes(value.metadata.labels['opensphere.io/platform-core-handoff']))
  return {state:'Conflict'};
 const suspended=value.metadata.labels['opensphere.io/platform-core-handoff']==='suspended';
 if(suspended && !value.data?.operation)return {state:'NoRecord',suspended:true,
  uid:value.metadata.uid,resourceVersion:value.metadata.resourceVersion};
 let operation;try{operation=JSON.parse(value.data?.operation);}catch{return {state:'Conflict'};}
 if(operation?.itemId!=='crossplane-core'||!uuid.test(operation.id||''))return {state:'Conflict'};
 return {state:active.has(operation.phase)?'ActiveOrUncertain':terminal.has(operation.phase)?'Terminal':'Conflict',
  suspended,uid:value.metadata.uid,resourceVersion:value.metadata.resourceVersion};
}
function bindingState(row,value){
 if(value===null)return {state:'Missing'};
 if(!value||value.kind!==row.kind||value.metadata?.name!==row.name||
  (value.metadata.namespace||null)!==row.namespace||!value.metadata?.uid||
  !value.metadata?.resourceVersion||value.metadata?.deletionTimestamp||
  value.roleRef?.apiGroup!=='rbac.authorization.k8s.io'||
  value.roleRef.kind!==row.roleKind||value.roleRef.name!==row.roleName||
  value.subjects?.length!==1)return {state:'Conflict'};
 const subject=value.subjects[0];
 return {state:subject.kind===cm.kind&&subject.name===cm.name&&subject.namespace===cm.namespace
  ?'ClusterManager':subject.kind==='ServiceAccount'&&
   subject.name==='opensphere-platform-support-runtime'&&subject.namespace==='opensphere-console'
   ?'PlatformSupport':'Other',
  uid:value.metadata.uid,resourceVersion:value.metadata.resourceVersion};
}
function coreState(values){
 if(!Array.isArray(values)||values.length!==3)return 'ObservationUnavailable';
 if(values.every(value=>value===null))return 'Absent';
 if(values.some(value=>value===undefined))return 'ObservationUnavailable';
 return 'PresentOrPartial';
}
export async function observePsssCrossplaneHandoff(client){
 if(!client||!['observeModule','readOperation','readBinding','readCore'].every(name=>
  typeof client[name]==='function'))throw Error('Read-only handoff client required');
 const [modules,operation,bindings,core]=await Promise.all([
  Promise.all(MODULES.map(async module=>{
   try{return {id:module.id,...moduleState(module,await client.observeModule(module))};}
   catch{return {id:module.id,state:'ObservationUnavailable'};}
  })),
  Promise.resolve().then(()=>client.readOperation()).then(operationState,
   ()=>({state:'ObservationUnavailable'})),
  Promise.all(BINDINGS.map(async row=>{
   try{return {kind:row.kind,namespace:row.namespace,name:row.name,
    ...bindingState(row,await client.readBinding(row))};}
   catch{return {kind:row.kind,namespace:row.namespace,name:row.name,state:'ObservationUnavailable'};}
  })),
  Promise.resolve().then(()=>client.readCore()).then(coreState,()=> 'ObservationUnavailable'),
 ]);
 const drain=operation.suspended===true && ['NoRecord','Terminal'].includes(operation.state)
  ?{state:'Ready',uid:operation.uid,resourceVersion:operation.resourceVersion}
  :{state:'Unverified'};
 const blockers=[
  ...modules.filter(row=>row.state!=='Verified').map(row=>row.id+':'+row.state),
  ...(['NoRecord','Terminal'].includes(operation.state)?[]:['CoreOperation:'+operation.state]),
  ...bindings.filter(row=>row.state!=='ClusterManager').map(row=>row.name+':'+row.state),
  ...(core==='Absent'?[]:['Core:'+core]),
  ...(drain.state==='Ready'?[]:['NewCmCoreWorkNotSuspended']),
 ];
 return {schema:'opensphere.psss-crossplane-handoff-preflight/v1',
  state:blockers.length?'Unverified':'Ready',blockers,modules,operation,bindings,core,drain};
}

export function createPsssCrossplaneHandoffClient({context,kubectl='kubectl',kubeconfig='',runner=run}={}){
 if(!context||typeof context!=='string'||!/^[A-Za-z0-9_.:@/-]+$/.test(context)||
  !kubectl||typeof kubectl!=='string'||(kubeconfig&&typeof kubeconfig!=='string'))
  throw Error('Explicit kubectl context and executable required');
 const base=[...(kubeconfig?['--kubeconfig',kubeconfig]:[]),'--context',context];
 const execute=(args,{json=true}={})=>runner(kubectl,[...base,'--request-timeout=10s',...args,
  ...(json?['-o','json']:[])],{capture:true,spawn:{maxBuffer:4*1024*1024,timeout:30000}});
 const get=(kind,name,namespace)=>{const args=['get',kind,name,'--ignore-not-found'];
  if(namespace)args.push('-n',namespace);
  const raw=execute(args);return raw?JSON.parse(raw):null;};
 const list=(kind,selector,namespace)=>{const body=JSON.parse(execute(
  ['get',kind,'-n',namespace,'-l',selector]));
  if(body?.metadata?.continue||!Array.isArray(body?.items))throw Error('Incomplete Kubernetes list');
  return body.items;};
 return {
  async observeModule(module){
   if(!MODULES.includes(module))throw Error('Unpinned module');
   const selector='opensphere.io/extension-id='+module.id;
   const pkg=get('uipluginpackage',module.id,'opensphere-console');
   const registration=get('uipluginregistration',module.id,'opensphere-console');
   const deployments=list('deployments',selector,'opensphere-console');
   const pods=list('pods',selector,'opensphere-console');
   const hashes={};
   for(const pod of pods){
    if(!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(pod.metadata?.name||''))continue;
    try{
     const output=execute(['exec','-n','opensphere-console',pod.metadata.name,
      '--','sha256sum',module.path],{json:false});
     hashes[pod.metadata.name]=/^([a-f0-9]{64})\s/.exec(output)?.[1]||null;
    }catch{hashes[pod.metadata.name]=null;}
   }
   return {package:pkg,registration,deployments,pods,hashes};
  },
  async readOperation(){return get('configmap','opensphere-his-operation-crossplane-core','opensphere-console');},
  async readBinding(row){return get(row.kind.toLowerCase(),row.name,row.namespace);},
  async readCore(){return [
   get('crd','providers.pkg.crossplane.io'),
   get('deployment','crossplane','crossplane-system'),
   get('deployment','crossplane-rbac-manager','crossplane-system'),
  ];},
 };
}
