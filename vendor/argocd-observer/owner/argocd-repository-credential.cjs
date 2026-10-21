'use strict';
// Console/Gitea issues and revokes the read:repository token. PSSS alone
// projects that approved credential to Argo's fixed repository Secret.
const {createHash}=require('node:crypto');
const sourcePath='/api/v1/namespaces/opensphere-console/secrets/opensphere-gitea-argocd-readonly';
const targetPath='/api/v1/namespaces/argocd/secrets/opensphere-platform-declarations-repository';
const clusterPath='/api/v1/namespaces/kube-system';
const repositoryUrl='http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000/opensphere/platform-declarations.git';
const tokenPurpose='argocd-readonly-repository';
const bytes=value=>Buffer.from(value,'utf8').toString('base64');
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code,safelyRejected:true});};
function decoded(value){
 if(typeof value!=='string'||!value||value.length>8192||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return null;
 const raw=Buffer.from(value,'base64');
 if(raw.toString('base64')!==value||raw.toString('utf8').includes('\ufffd'))return null;
 return raw.toString('utf8');
}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).sort().join(',')===keys.slice().sort().join(',');}
function sourceCredential(secret){
 const m=secret?.metadata;
 if(secret?.kind!=='Secret'||secret.apiVersion!=='v1'||secret.type!=='Opaque'||
  m?.name!=='opensphere-gitea-argocd-readonly'||m.namespace!=='opensphere-console'||
  m.deletionTimestamp||m.labels?.['opensphere.io/managed-by']!=='console-gitea'||
  m.labels?.['opensphere.io/credential-purpose']!==tokenPurpose||
  m.annotations?.['opensphere.io/gitea-token-scope']!=='read:repository'||
  !m.uid||!m.resourceVersion||!exactKeys(secret.data,['url','username','token']))return null;
 const url=decoded(secret.data.url),username=decoded(secret.data.username),token=decoded(secret.data.token);
 if(url!==repositoryUrl||username!=='opensphere-control'||!token||
  !/^[A-Za-z0-9_.-]{20,512}$/.test(token))return null;
 return {uid:m.uid,resourceVersion:m.resourceVersion,username,token};
}
function targetState(secret){
 const m=secret?.metadata;
 if(secret?.kind!=='Secret'||secret.apiVersion!=='v1'||secret.type!=='Opaque'||
  m?.name!=='opensphere-platform-declarations-repository'||m.namespace!=='argocd'||
  m.deletionTimestamp||m.labels?.['argocd.argoproj.io/secret-type']!=='repository'||
  m.labels?.['opensphere.io/managed-by']!=='platform-support'||
  m.labels?.['opensphere.io/credential-purpose']!==tokenPurpose||
  !m.uid||!m.resourceVersion)return null;
 if(secret.data&&Object.keys(secret.data).length){
  if(!exactKeys(secret.data,['type','url','username','password'])||
    decoded(secret.data.type)!=='git'||decoded(secret.data.url)!==repositoryUrl||
    decoded(secret.data.username)!=='opensphere-control'||!decoded(secret.data.password))return null;
 }
 return {uid:m.uid,resourceVersion:m.resourceVersion};
}
function desiredData(source){return {type:bytes('git'),url:bytes(repositoryUrl),
 username:bytes(source.username),password:bytes(source.token)};}
function sameData(actual,expected){return exactKeys(actual,Object.keys(expected))&&
 Object.keys(expected).every(key=>actual[key]===expected[key]);}
function revision(clusterUid,credential,targetIdentity,blockers){
 return 'sha256:'+createHash('sha256').update(JSON.stringify([
  'opensphere.argocd-repository-plan/v1',clusterUid||null,
  credential?.uid||null,credential?.resourceVersion||null,
  targetIdentity?.uid||null,targetIdentity?.resourceVersion||null,blockers])).digest('hex');
}
function createRepositoryCredential({kube,fetchImpl=fetch,now=()=>new Date().toISOString()}){
 if(typeof kube!=='function'||typeof fetchImpl!=='function')throw TypeError('Kubernetes and Git readers are required');
 async function plan(){
  const [cluster,source,target]=await Promise.all([
   kube('GET',clusterPath),kube('GET',sourcePath),kube('GET',targetPath)]);
  const blockers=[];
  if(cluster.status!==200||!cluster.body?.metadata?.uid)blockers.push('ClusterIdentityUnknown');
  const credential=source.status===200?sourceCredential(source.body):null;
  if(!credential)blockers.push(source.status===404?'IssuerCredentialMissing':
   source.status===200?'IssuerCredentialConflict':'IssuerCredentialUnknown');
  const targetIdentity=target.status===200?targetState(target.body):null;
  if(!targetIdentity)blockers.push(target.status===404?'ArgoPlaceholderMissing':
   target.status===200?'ArgoCredentialConflict':'ArgoCredentialUnknown');
  if(credential&&targetIdentity){
   try{
    const response=await fetchImpl(repositoryUrl+'/info/refs?service=git-upload-pack',{
     method:'GET',redirect:'error',headers:{authorization:'Basic '+
      Buffer.from(`${credential.username}:${credential.token}`).toString('base64')},
     signal:AbortSignal.timeout(8000)});
    if(response.status!==200||!
       /^application\/x-git-upload-pack-advertisement(?:;|$)/i.test(
        response.headers?.get('content-type')||''))blockers.push('RepositoryReadUnverified');
    await response.body?.cancel?.();
   }catch{blockers.push('RepositoryReadUnverified');}
  }
  return {schema:'opensphere.argocd-repository-plan/v1',owner:'platform-support',
   repository:repositoryUrl,sourceRef:'opensphere-console/opensphere-gitea-argocd-readonly',
   targetRef:'argocd/opensphere-platform-declarations-repository',
   planRevision:revision(cluster.body?.metadata?.uid,credential,targetIdentity,blockers),
   executionReady:blockers.length===0,blockers,
   state:blockers.length?'Blocked':sameData(target.body.data,desiredData(credential))?'Verified':'NeedsProjection',
   observedAt:now()};
 }
 async function install({planRevision}){
  const current=await plan();
  if(current.planRevision!==planRevision)fail(409,'RepositoryPlanChanged','Repository credential plan changed; review again');
  if(!current.executionReady)fail(409,'RepositoryPlanBlocked','Repository credential preconditions are not ready');
  if(current.state==='Verified')return {state:'Verified',replayed:true,observedAt:now()};
  const [cluster,source,target]=await Promise.all([
   kube('GET',clusterPath),kube('GET',sourcePath),kube('GET',targetPath)]);
  const credential=source.status===200?sourceCredential(source.body):null;
  const identity=target.status===200?targetState(target.body):null;
  if(!credential||!identity||revision(cluster.body?.metadata?.uid,credential,identity,[])!==planRevision)
   fail(409,'RepositoryPlanChanged','Repository credential changed before projection');
  const data=desiredData(credential);
  const patch=[
   {op:'test',path:'/metadata/uid',value:identity.uid},
   {op:'test',path:'/metadata/resourceVersion',value:identity.resourceVersion},
   {op:target.body.data?'replace':'add',path:'/data',value:data},
  ];
  let result;
  try{result=await kube('PATCH',targetPath,patch,'application/json-patch+json');}
  catch{fail(503,'RepositoryOutcomeUnknown','Repository projection outcome is unknown; inspect before retrying');}
  if(result.status!==200)fail(503,'RepositoryOutcomeUnknown','Repository projection was not confirmed; inspect before retrying');
  let observed,sourceAfter;
  try{[observed,sourceAfter]=await Promise.all([
   kube('GET',targetPath),kube('GET',sourcePath)]);}
  catch{fail(503,'RepositoryOutcomeUnknown','Repository projection could not be verified');}
  if(observed.status!==200||targetState(observed.body)?.uid!==identity.uid||
    !sameData(observed.body.data,data)||sourceAfter.status!==200||
    sourceCredential(sourceAfter.body)?.uid!==credential.uid||
    sourceAfter.body.metadata.resourceVersion!==credential.resourceVersion)
   fail(503,'RepositoryOutcomeUnknown','Repository projection could not be verified');
  return {state:'Verified',replayed:false,observedAt:now()};
 }
 return {plan,install};
}
module.exports={createRepositoryCredential,repositoryUrl,sourcePath,targetPath,sourceCredential,targetState};
