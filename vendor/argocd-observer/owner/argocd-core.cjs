'use strict';
// ADR-0015: fixed original Argo CD payload. No shell command, URL supplied by
// callers, credential transfer, RBAC creation, or automatic Application sync.
const {createHash}=require('node:crypto');
const {materialize}=require('./argocd-policy-overlay.cjs');
const {privilegedAuthority}=require('./argocd-security.cjs');
const executorAuthority=require('../contracts/argocd-executor-authority.json');
const legacyExecutorAuthority=require('../contracts/argocd-executor-authority-legacy.json');
const observer=require('./argocd-observer-policy.cjs');
const {repositoryUrl}=require('./argocd-repository-credential.cjs');
const bundle=materialize();
const legacyBundle=materialize(undefined,{observer:false});
if(executorAuthority.schema!=='opensphere.argocd-core-executor-authority/v1'||
  executorAuthority.resources?.length!==2||
  !['Role','RoleBinding'].every(kind=>executorAuthority.resources.some(row=>
    row.kind===kind&&row.metadata?.name==='opensphere-platform-support-core-executor'&&
    row.metadata?.namespace==='argocd')))
  throw Error('Unrecognized pinned Argo executor authority');
const canonical=v=>JSON.stringify(order(v));
function order(v){return Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;}
const digest=v=>'sha256:'+createHash('sha256').update(canonical(v)).digest('hex');
if(digest(legacyExecutorAuthority.resources)!=='sha256:efe1ca4fbffbb4438768d2fea124cee5ae9ac23b78d2181eacb0ce6c3a455c18')
  throw Error('Pinned Argo executor authority changed');
if(digest(executorAuthority.resources)!=='sha256:16f066db5bd41c142d41b57152a644f7c1dfb014cf3761129252c80706fd2aea')
  throw Error('Pinned reduced Argo executor authority changed');
const artifactRevision=digest(bundle),ownerLabel='opensphere.io/managed-by',artifactLabel='opensphere.io/core-artifact';
const legacyArtifactRevision=digest(legacyBundle);
const plural={Namespace:'namespaces',CustomResourceDefinition:'customresourcedefinitions',ServiceAccount:'serviceaccounts',Role:'roles',RoleBinding:'rolebindings',ClusterRole:'clusterroles',ClusterRoleBinding:'clusterrolebindings',Deployment:'deployments',StatefulSet:'statefulsets',Service:'services',ConfigMap:'configmaps',Secret:'secrets',NetworkPolicy:'networkpolicies'};
const ns={apiVersion:'v1',kind:'Namespace',metadata:{name:'argocd'}};
const workloads=bundle.runtime.filter(r=>['Deployment','StatefulSet'].includes(r.kind));
function fault(status,code,message){return Object.assign(Error(message),{status,code});}
function paths(r){
  if(!plural[r.kind])throw fault(503,'CoreBundleInvalid','Unrecognized bundled resource');
  const base=(r.apiVersion==='v1'?'/api/v1':'/apis/'+r.apiVersion)+(r.metadata.namespace?'/namespaces/'+r.metadata.namespace:'')+'/'+plural[r.kind];
  return {base,item:base+'/'+r.metadata.name};
}
function contains(actual,expected){
  if(Array.isArray(expected))return Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>contains(actual[i],v));
  if(expected&&typeof expected==='object')return actual&&typeof actual==='object'&&Object.keys(expected).every(k=>contains(actual[k],expected[k]));
  return actual===expected;
}
function prepared(actual,expected){
  if(actual?.metadata?.deletionTimestamp||actual?.kind!==expected.kind||actual?.apiVersion!==expected.apiVersion||actual.metadata.name!==expected.metadata.name||actual.metadata.namespace!==expected.metadata.namespace)return false;
  if(expected.kind==='CustomResourceDefinition')return contains(actual.spec,expected.spec)&&actual.status?.conditions?.some(c=>c.type==='Established'&&c.status==='True');
  if(expected.rules)return !actual.aggregationRule&&canonical(actual.rules)===canonical(expected.rules);
  if(expected.roleRef)return canonical(actual.roleRef)===canonical(expected.roleRef)&&canonical(actual.subjects)===canonical(expected.subjects);
  if(expected.kind==='ServiceAccount')return actual.automountServiceAccountToken!==false&&!actual.secrets?.length&&!actual.imagePullSecrets?.length;
  return true;
}
function matches(actual,expected,options={}){
  if(actual?.metadata?.deletionTimestamp)return false;
  if(actual?.metadata?.name!==expected.metadata.name||actual.metadata.namespace!==expected.metadata.namespace)return false;
  if(expected.kind==='Secret'){
    if(!((actual.kind==='Secret'&&actual.apiVersion==='v1')||(actual.kind==='PartialObjectMetadata'&&actual.apiVersion==='meta.k8s.io/v1')))return false;
  }else if(actual.kind!==expected.kind||actual.apiVersion!==expected.apiVersion)return false;
  if(actual?.metadata?.labels?.[ownerLabel]!=='platform-support')return false;
  const revision=actual?.metadata?.annotations?.[artifactLabel];
  if(revision===legacyArtifactRevision)expected=legacyBundle.runtime.find(r=>r.kind===expected.kind&&r.metadata.name===expected.metadata.name);
  else if(revision!==artifactRevision)return false;
  if(!expected)return false;
  // Existing generated credentials are never read, replaced, or reset.
  if(expected.kind==='Secret')return true;
  if(expected.kind==='ConfigMap'&&expected.metadata.name==='argocd-rbac-cm'&&revision===legacyArtifactRevision)
    return !actual.data||Object.keys(actual.data).length===0;
  // Kubernetes drops an empty externalIPs list at admission. Keep that field
  // absent in the manifest, but reject a later exposure on the live Service.
  if(expected.kind==='Service'&&expected.metadata.name==='argocd-server'&&
    (actual.spec?.type!=='ClusterIP'||!!actual.spec?.externalIPs?.length))return false;
  if(expected.kind==='ConfigMap'&&expected.metadata.name==='argocd-rbac-cm'&&revision===artifactRevision){
    if(canonical(actual.data)!==canonical({...expected.data,'policy.csv':options.observerPolicy||''}))return false;
    return true;
  }
  return ['spec','data','type'].every(k=>!Object.hasOwn(expected,k)||contains(actual[k],expected[k]));
}
function ready(actual,expected,options){
  if(!matches(actual,expected,options))return false;
  if(!['Deployment','StatefulSet'].includes(expected.kind))return true;
  const n=actual.spec?.replicas??1,s=actual.status||{},g=actual.metadata?.generation;
  if(!Number.isInteger(g)||!Number.isInteger(s.observedGeneration)||s.observedGeneration<g||n<1||s.updatedReplicas!==n||s.readyReplicas!==n)return false;
  return expected.kind==='Deployment'?s.availableReplicas===n:!!s.currentRevision&&s.currentRevision===s.updateRevision;
}
function createArgoCore({kube}){
  async function read(expected,signal){
    let r;try{r=await kube('GET',paths(expected).item,undefined,'application/json',{signal});}
    catch{return {status:503};}
    // A denied or failed read is unknown, never proof that an object is absent.
    // Project only status for errors; upstream messages can contain internals.
    return [200,404].includes(r.status)?r:{status:r.status===403?403:503};
  }
  async function snapshot(signal=AbortSignal.timeout(18000)){
    const objects=[ns,...bundle.prerequisites,...bundle.runtime,...executorAuthority.resources],result=[];
    let next=0;
    await Promise.all(Array.from({length:6},async()=>{for(;;){const i=next++;if(i>=objects.length)return;
      // Signing/notification credentials are Setup-owned. A metadata-only Accept
      // never restricts Kubernetes authority, so the owner must not read them.
      result[i]=objects[i].kind==='Secret'?{status:0,setupOwned:true}:await read(objects[i],signal);}}));
    let trust;try{trust=await kube('GET','/api/v1/namespaces/argocd/configmaps/'+observer.TRUST,undefined,'application/json',{signal});}catch{trust={status:503};}
    let observerPolicy;
    if(trust.status===200&&trust.body?.kind==='ConfigMap'&&trust.body.metadata?.labels?.['opensphere.io/managed-by']==='opensphere-setup'){
      try{
        const rows=JSON.parse(trust.body.data?.['inventory.json']||'[]');
        if(Array.isArray(rows)&&rows.every(r=>r&&/^[a-z0-9][a-z0-9.-]{0,251}$/.test(r.name||'')&&/^[a-z0-9][a-z0-9.-]{0,251}$/.test(r.project||''))){
          const value=observer.policy(rows,repositoryUrl);
          if(trust.body.data?.['policy.sha256']===digest(value))observerPolicy=value;
        }
      }catch{}
    }
    const matchOptions={observerPolicy};
    const records=objects.map((expected,i)=>({expected,...result[i]}));
    const prerequisites=records.slice(0,1+bundle.prerequisites.length),
      runtime=records.slice(1+bundle.prerequisites.length,1+bundle.prerequisites.length+bundle.runtime.length),
      authority=records.slice(1+bundle.prerequisites.length+bundle.runtime.length);
    const readFailure=r=>r.status===403?'ReadForbidden':'ObservationUnavailable';
    const blockers=prerequisites.filter(r=>r.status!==200||!prepared(r.body,r.expected)).map(r=>({kind:r.expected.kind,name:r.expected.metadata.name,reason:r.status===404?'PrerequisiteMissing':r.status===200?'PrerequisiteMismatch':readFailure(r)}));
    for(const r of prerequisites){
      if(r.status===200&&['Role','ClusterRole'].includes(r.expected.kind)&&
        ['argocd-application-controller','argocd-applicationset-controller','argocd-server'].includes(r.expected.metadata.name)&&
        privilegedAuthority(r.body)!=='Pass')
        blockers.push({kind:r.expected.kind,name:r.expected.metadata.name,reason:'UnsafeAuthority'});
    }
    for(const r of authority){
      const legacy=legacyExecutorAuthority.resources.find(v=>v.kind===r.expected.kind&&v.metadata.name===r.expected.metadata.name);
      const requireReduced=trust.status===200&&trust.body?.data?.['authority.reduced']==='true';
      if(r.status!==200||!prepared(r.body,r.expected)&&(requireReduced||!prepared(r.body,legacy)))
        blockers.push({kind:r.expected.kind,name:r.expected.metadata.name,
          reason:r.status===404?'ExecutionAuthorityMissing':r.status===200?'ExecutionAuthorityMismatch':readFailure(r)});
    }
    for(const r of runtime){
      if(r.setupOwned)continue;
      if(![200,404].includes(r.status))blockers.push({kind:r.expected.kind,name:r.expected.metadata.name,reason:readFailure(r)});
      else if(r.status===200&&!matches(r.body,r.expected,matchOptions))blockers.push({kind:r.expected.kind,name:r.expected.metadata.name,reason:r.body?.metadata?.labels?.[ownerLabel]==='platform-support'?'RuntimeDrift':'ExternalOwnership'});
    }
    const revision=digest({artifactRevision,objects:records.map(r=>[paths(r.expected).item,r.status,r.body?.metadata?.uid||null,r.body?.metadata?.resourceVersion||null]),preparation:[trust.status,trust.body?.metadata?.uid||null,trust.body?.metadata?.resourceVersion||null],blockers});
    return {records,runtime,blockers,revision,matchOptions,credentials:{owner:'Setup',state:trust.status===200&&trust.body.data?.['credentials.prepared']==='true'?'PreparedBySetup':'PreparationUnverified',inspected:false}};
  }
  function view(s){return {schema:'opensphere.argocd-core-plan/v1',owner:'platform-support',version:bundle.version,artifactRevision,planRevision:s.revision,
    state:s.blockers.length?'Blocked':s.runtime.every(r=>r.setupOwned||r.status===200&&ready(r.body,r.expected,s.matchOptions))?'Ready':s.runtime.some(r=>r.status===404)?'NotInstalled':'Applying',
    executionReady:s.blockers.length===0,blockers:s.blockers,
    credentials:s.credentials,
    resources:s.runtime.map(r=>({kind:r.expected.kind,name:r.expected.metadata.name,state:r.setupOwned?'SetupOwnedNotInspected':r.status===404?'Missing':r.status!==200?'Unknown':ready(r.body,r.expected,s.matchOptions)?'Ready':matches(r.body,r.expected,s.matchOptions)?'Pending':'Conflict'})),
    retained:['Namespace','CRD','RBAC','Applications','AppProjects','credentials','L5 services and data'],
    nextCommand:'platform-support.argocd.inspect'};}
  return {
    async plan(){return view(await snapshot());},
    async install(input,actor){
      // One deadline for observation and creation together, within Shell's
      // owner request budget. A slow review must not start a new write budget.
      const signal=AbortSignal.timeout(18000),s=await snapshot(signal);
      if(s.blockers.length)throw fault(409,'CorePrerequisitesNotReady','Argo CD Core preparation is incomplete; inspect the plan blockers. No authority was created.');
      const inputDigest=digest({command:input.command,arguments:input.arguments,subjectId:actor.subjectId});
      const prior=s.runtime.filter(r=>r.body?.metadata?.annotations?.['opensphere.io/command-request-id']===input.requestId);
      if(prior.some(r=>r.body.metadata.annotations['opensphere.io/command-input-sha256']!==inputDigest))throw fault(409,'IdempotencyConflict','Request ID belongs to different Argo Core input or actor');
      if(!prior.length&&input.arguments.planRevision!==s.revision)throw fault(409,'StateConflict','Argo CD Core changed since review; obtain a new plan');
      const pending=s.runtime.filter(r=>r.status===404),created=[];
      if(pending.length&&s.credentials.state!=='PreparedBySetup')throw fault(409,'CoreCredentialsPreparationRequired','Setup must prepare Core credentials first; the observer token is not required for initial Core installation.');
      for(const {expected} of pending){
        if(signal.aborted)throw fault(503,'CoreOutcomeUncertain','Installation stopped before the next resource; inspect and review remaining work');
        const value=structuredClone(expected);
        // Secrets are excluded from pending: Setup owns their initial creation,
        // preservation and recovery. Core never reads or creates key material.
        value.metadata.labels={...value.metadata.labels,[ownerLabel]:'platform-support'};
        value.metadata.annotations={...value.metadata.annotations,[artifactLabel]:artifactRevision,'opensphere.io/command-request-id':input.requestId,'opensphere.io/command-input-sha256':inputDigest};
        let r;try{r=await kube('POST',paths(value).base,value,'application/json',{signal});}
        catch{throw fault(503,'CoreOutcomeUncertain','Cannot confirm Argo CD creation; inspect before retrying');}
        if(r.status===409){const current=await read(expected,signal);if(current.status!==200||!matches(current.body,expected))throw fault(409,'CoreOwnershipConflict','Concurrent resource differs; no takeover was attempted');}
        else if(r.status!==201)throw fault(r.status===403?403:503,'CoreCreationFailed','Argo CD creation was rejected; earlier resources are preserved for inspection');
        else created.push({kind:expected.kind,name:expected.metadata.name});
      }
      return {schema:'opensphere.argocd-core-installation/v1',owner:'platform-support',operationId:input.requestId,requestId:input.requestId,
        version:bundle.version,artifactRevision,state:pending.length?'Applying':view(s).state,noChange:pending.length===0,replayed:prior.length>0,created,
        nextCommand:'platform-support.argocd.inspect',message:'Core resources accepted. Workload readiness and Gitea delivery verification must be observed separately.'};
    },
  };
}
module.exports={createArgoCore,artifactRevision,legacyArtifactRevision,bundle,legacyBundle,executorAuthority,legacyExecutorAuthority,paths,prepared,matches,ready,workloads};
