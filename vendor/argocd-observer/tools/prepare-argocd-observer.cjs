'use strict';
// Setup-owned, explicit-cluster preparation. Tokens are captured in memory and
// sent to Kubernetes on stdin only. Neither command output nor error output is
// forwarded. Normal module installation and updates still run through OS Shell.
const fs=require('node:fs');
const path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {createHash,randomBytes,randomUUID,X509Certificate,createPrivateKey}=require('node:crypto');
const P=require('../owner/argocd-observer-policy.cjs');
const Core=require('../owner/argocd-core.cjs');
const {repositoryUrl}=require('../owner/argocd-repository-credential.cjs');
const projectPolicies=require('../contracts/argocd-first-delivery-policy.json');
const legacyProjectPolicy=require('../contracts/argocd-demo-observation-project-policy-legacy.json');
const schema='opensphere.argocd-observer-preparation/v1';
const LOCAL_CLUSTER_SECRET='opensphere-local-namespace-cluster';
const LOCAL_CLUSTER_SERVER='https://kubernetes.default.svc';
const LOCAL_TARGET_NAMESPACES=['opensphere-console','opensphere-platform-delivery'];
const PROJECT_POLICY='opensphere-psss-first-delivery-projects';
const sourceKinds=[{group:'apps',kind:'Deployment'},{group:'',kind:'Service'},{group:'',kind:'ConfigMap'}];
const observationKinds=[...sourceKinds,{group:'apps',kind:'ReplicaSet'},{group:'',kind:'Pod'}];
const demoProjectSpec=kinds=>({sourceRepos:[repositoryUrl],destinations:[{server:LOCAL_CLUSTER_SERVER,namespace:'opensphere-platform-delivery'}],clusterResourceWhitelist:[],namespaceResourceWhitelist:kinds,orphanedResources:{warn:true}});
const metadata=o=>({uid:o?.metadata?.uid||null,resourceVersion:o?.metadata?.resourceVersion||null});
const json=v=>JSON.stringify(v);
function replacementInput(value){
 const result=structuredClone(value);
 // kubectl replace refreshes an existing last-applied annotation even without
 // --save-config. Never serialize live UID/RV/status, or sealed token data,
 // into that declarative baseline. Keep the outer RV for optimistic locking.
 if(result.metadata?.annotations)delete result.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
 return result;
}
function requireValue(ok,message){if(!ok)throw Object.assign(Error(message),{code:'PreparationRejected'});}
function options(argv){const allowed=new Set(['kubeconfig','context','expected-cluster-uid','kubectl','argocd','argocd-sha256','openssl','openssl-sha256','mode','approve-plan','compat-source','compat-digest','authenticated-proof']);const out={};for(let i=0;i<argv.length;i+=2){requireValue(/^--[a-z][a-z0-9-]*$/.test(argv[i]||'')&&argv[i+1]&&!argv[i+1].startsWith('--'),'Every option requires a value');const key=argv[i].slice(2);requireValue(allowed.has(key),'Unsupported preparation option');requireValue(!Object.hasOwn(out,key),'Duplicate option');out[key]=argv[i+1];}return out;}
function createPreparation(config,{execute=spawnSync,readFile=fs.readFileSync,now=()=>Date.now()}={}){
 for(const key of ['kubeconfig','context','expected-cluster-uid'])requireValue(typeof config[key]==='string'&&config[key].length>0,`Missing --${key}`);
 requireValue(/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(config.context),'Invalid explicit context');
 requireValue(/^[a-f0-9-]{36}$/.test(config['expected-cluster-uid']),'Invalid expected cluster UID');
 const k=['--kubeconfig',config.kubeconfig,'--context',config.context];
 let approvedTargets;
 function run(binary,args,input,environment={}){const result=execute(binary,args,{input:input===undefined?undefined:typeof input==='string'?input:json(input),encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,windowsHide:true,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ARGOCD_'))),KUBECONFIG:config.kubeconfig,...environment}});requireValue(result.status===0&&!result.error,'Preparation command failed; credential-bearing output withheld');return result.stdout||'';}
 function kubectl(args,input){
  if(args[0]==='replace'&&input!==undefined)input=replacementInput(input);
  if(args.some(v=>['create','replace','patch','delete'].includes(v))){
   const uid=run(config.kubectl||'kubectl',k.concat(['get','namespace','kube-system','-o','jsonpath={.metadata.uid}'])).trim();
   requireValue(uid===config['expected-cluster-uid'],'Cluster UID changed before mutation; nothing further applied');
  }
  return run(config.kubectl||'kubectl',k.concat(args),input);
 }
 function get(kind,name,namespace,{metadataOnly=false}={}){
  const args=['get',kind,...(name?[name]:[]),...(namespace?['--namespace',namespace]:[]),'--ignore-not-found','-o',metadataOnly?'jsonpath={.metadata}':'json'];
  const value=kubectl(args).trim();if(!value)return null;const parsed=JSON.parse(value);return metadataOnly?{kind,metadata:parsed}:parsed;
 }
 function current(){
  const ns=get('namespace','kube-system');requireValue(ns?.metadata?.uid===config['expected-cluster-uid'],'Cluster UID mismatch; nothing applied');
  const argo=get('namespace','argocd');requireValue(argo&&!argo.metadata.deletionTimestamp,'Argo namespace is not prepared');
  const apps=get('applications.argoproj.io',null,'argocd')||{items:[]};requireValue(!apps.metadata?.continue,'Application inventory is paginated');
  const rows=P.inventory(apps.items,repositoryUrl),objects={};
  for(const [key,kind,name,namespace]of [['config','configmap','argocd-cm','argocd'],['rbac','configmap','argocd-rbac-cm','argocd'],['network','networkpolicy','argocd-server-network-policy','argocd'],['authority','role','opensphere-platform-support-core-executor','argocd'],['trust','configmap',P.TRUST,'argocd']])objects[key]=get(kind,name,namespace);
  for(const name of ['argocd-secret','argocd-notifications-secret','argocd-server-tls',P.SECRET])objects[name]=get('secret',name,'argocd',{metadataOnly:true});
  const clusterScope=inspectClusterScope(rows);objects[LOCAL_CLUSTER_SECRET]=clusterScope.observed;
  const projectObservation=inspectProjectObservation();
  for(const target of projectObservation.targets)objects[target.key]=target.observed;
  for(const row of [...P.readerResources(),{kind:'Role',metadata:{name:'opensphere-foundation-delivery-registration-reader',namespace:'opensphere-console'}},{kind:'RoleBinding',metadata:{name:'opensphere-foundation-delivery-registration-reader',namespace:'opensphere-console'}}])objects[row.kind+'/'+row.metadata.namespace+'/'+row.metadata.name]=get(row.kind,row.metadata.name,row.metadata.namespace);
  for(const name of ['argocd-secret','argocd-notifications-secret'])if(objects[name])requireValue(objects[name].metadata?.labels?.['opensphere.io/managed-by']==='platform-support'&&[Core.artifactRevision,Core.legacyArtifactRevision].includes(objects[name].metadata?.annotations?.['opensphere.io/core-artifact']),'Existing Core credential ownership differs; explicit recovery review required');
  if(objects[P.SECRET])requireValue(objects[P.SECRET].metadata?.labels?.['opensphere.io/managed-by']===P.labels['opensphere.io/managed-by']&&objects[P.SECRET].metadata?.labels?.['opensphere.io/purpose']===P.labels['opensphere.io/purpose'],'Observer Secret belongs to a different owner');
  if(objects.trust)requireValue(objects.trust.metadata?.labels?.['opensphere.io/managed-by']===P.labels['opensphere.io/managed-by']&&objects.trust.metadata?.labels?.['opensphere.io/purpose']===P.labels['opensphere.io/purpose'],'Observer trust belongs to a different owner');
  const registration=get('uipluginregistration.plugins.opensphere.io','platform-support','opensphere-console');
  return {clusterUid:ns.metadata.uid,namespaceUid:argo.metadata.uid,rows,objects,registration,clusterScope,projectObservation};
 }
 function coreResource(kind,name){return structuredClone(Core.bundle.runtime.find(r=>r.kind===kind&&r.metadata.name===name));}
 function attributed(value){value.metadata.labels={...value.metadata.labels,'opensphere.io/managed-by':'platform-support'};value.metadata.annotations={...value.metadata.annotations,'opensphere.io/core-artifact':Core.artifactRevision};return value;}
 function ownObject(kind,name,data){return {apiVersion:'v1',kind,metadata:{name,namespace:'argocd',labels:P.labels},...(kind==='ConfigMap'?{data}:{type:'Opaque',stringData:data})};}
 function inspectClusterScope(rows){
  const namespaces=[...new Set(rows.map(row=>row.destinationNamespace))].sort();
  requireValue(namespaces.every(ns=>LOCAL_TARGET_NAMESPACES.includes(ns)),'Local cluster scope contains an unapproved target namespace');
  const desired=ownObject('Secret',LOCAL_CLUSTER_SECRET,{name:'in-cluster',server:LOCAL_CLUSTER_SERVER,namespaces:namespaces.join(','),clusterResources:'false',config:'{}'});
  desired.metadata.labels['argocd.argoproj.io/secret-type']='cluster';
  // kubectl projects only descriptor names and the public server URL. No cluster
  // config, bearer token, key or certificate from other Secrets reaches stdout.
  const projection='{{range .items}}{{.metadata.name}}{{"\\t"}}{{index .data "server"}}{{"\\n"}}{{end}}';
  const raw=kubectl(['get','secrets','--namespace','argocd','--selector','argocd.argoproj.io/secret-type=cluster','-o','go-template='+projection]);
  const local=raw.trim()?raw.trim().split(/\r?\n/).map(line=>line.split('\t')).filter(pair=>Buffer.from(pair[1]||'','base64').toString('utf8')===LOCAL_CLUSTER_SERVER):[];
  requireValue(local.every(pair=>pair[0]===LOCAL_CLUSTER_SECRET)&&local.length<=1,'A different or duplicate local cluster descriptor exists; explicit review required');
  const observed=get('secret',LOCAL_CLUSTER_SECRET,'argocd',{metadataOnly:true});
  if(observed){
   requireValue(!observed.metadata.deletionTimestamp&&Object.entries(desired.metadata.labels).every(([key,value])=>observed.metadata.labels?.[key]===value),'Local cluster descriptor belongs to a different owner or is deleting');
   const keys=kubectl(['get','secret',LOCAL_CLUSTER_SECRET,'--namespace','argocd','-o','go-template={{range $key,$value := .data}}{{$key}}{{"\\n"}}{{end}}']).trim().split(/\r?\n/).filter(Boolean).sort();
   requireValue(json(keys)===json(Object.keys(desired.stringData).sort()),'Local cluster descriptor has additional or missing data fields');
   const predicates=Object.entries(desired.stringData).map(([key,value])=>`(eq (index .data ${json(key)}) ${json(Buffer.from(value).toString('base64'))})`);
   const comparison='{{if and (eq .type "Opaque") '+predicates.join(' ')+'}}true{{else}}false{{end}}';
   // Compare the exact config bytes inside kubectl's template; an unsafe config
   // is rejected without printing or hashing its potentially secret contents.
   requireValue(kubectl(['get','secret',LOCAL_CLUSTER_SECRET,'--namespace','argocd','-o','go-template='+comparison]).trim()==='true','Local cluster descriptor public fields or config differ from the exact reviewed scope');
  }
  const publicData=Object.fromEntries(Object.entries(desired.stringData).map(([key,value])=>[key,Buffer.from(value).toString('base64')]));
  return {observed,desired,namespaces,contentDigest:observed?P.digest({type:'Opaque',data:publicData}):null,state:namespaces.length?(observed?'Prepared':'NeedsPreparation'):'AwaitingApprovedApplications'};
 }
 function inspectProjectObservation(){
  const project=get('appproject.argoproj.io',P.DEMO,'argocd'),policy=get('validatingadmissionpolicy.admissionregistration.k8s.io',PROJECT_POLICY);
  const desiredPolicy=projectPolicies.find(row=>row.kind==='ValidatingAdmissionPolicy'&&row.metadata.name===PROJECT_POLICY);
  const validIdentity=(value,kind,name,namespace)=>value?.apiVersion===(kind==='AppProject'?'argoproj.io/v1alpha1':'admissionregistration.k8s.io/v1')&&value.kind===kind&&value.metadata?.name===name&&(value.metadata.namespace||null)===(namespace||null)&&value.metadata.uid&&value.metadata.resourceVersion&&!value.metadata.deletionTimestamp&&!value.metadata.finalizers?.length&&!value.metadata.ownerReferences?.length;
  const projectState=project&&validIdentity(project,'AppProject',P.DEMO,'argocd')&&project.metadata.labels?.['opensphere.io/managed-by']==='platform-support'?(P.digest(project.spec)===P.digest(demoProjectSpec(observationKinds))?'Prepared':P.digest(project.spec)===P.digest(demoProjectSpec(sourceKinds))?'Legacy':'Unreviewed'):project?'Unreviewed':'Missing';
  const policyState=policy&&validIdentity(policy,'ValidatingAdmissionPolicy',PROJECT_POLICY)&&(P.digest(policy.spec)===P.digest(desiredPolicy.spec)||P.digest(policy.spec)===P.digest(legacyProjectPolicy.spec))?(P.digest(policy.spec)===P.digest(desiredPolicy.spec)?'Prepared':'Legacy'):policy?'Unreviewed':'Missing';
  const targets=[{key:'AppProject/argocd/'+P.DEMO,kind:'AppProject',name:P.DEMO,namespace:'argocd',observed:project,state:projectState,expected:demoProjectSpec(observationKinds),field:'namespaceResourceWhitelist',value:observationKinds},
   {key:'ValidatingAdmissionPolicy//'+PROJECT_POLICY,kind:'ValidatingAdmissionPolicy',name:PROJECT_POLICY,observed:policy,state:policyState,expected:desiredPolicy.spec,field:'validations',value:desiredPolicy.spec.validations}];
  return {targets,state:targets.some(row=>row.state==='Unreviewed')?'Unreviewed':targets.some(row=>row.state==='Missing')?'AwaitingDemoProject':targets.every(row=>row.state==='Prepared')?'Prepared':'NeedsPreparation'};
 }
 function policyObjects(state){
  const config=attributed(coreResource('ConfigMap','argocd-cm'));
  if(state.objects.config){requireValue(Core.matches(state.objects.config,coreResource('ConfigMap','argocd-cm')),'Current Core config is not an exact reviewed policy');config.data={...state.objects.config.data,...config.data};}
  const rbac=attributed(coreResource('ConfigMap','argocd-rbac-cm'));rbac.data['policy.csv']=P.policy(state.rows,repositoryUrl);
  const old=state.objects.rbac?.data||{};
  requireValue(!old['policy.default']||old['policy.default']==='role:opensphere-no-default-permissions','Current Argo default role is not empty; refuse silent policy changes');
  if(old['policy.csv']){
   const previous=state.objects.trust?.data?.['inventory.json'];
   requireValue(previous&&old['policy.csv']===P.policy(JSON.parse(previous),repositoryUrl),'Current Argo RBAC contains unreviewed policies');
  }
  requireValue(Object.keys(old).every(key=>['policy.csv','policy.default','policy.matchMode'].includes(key)),'Current Argo RBAC has additional policy fragments; explicit review required');
  const network=attributed(coreResource('NetworkPolicy','argocd-server-network-policy'));
  if(state.objects.network)requireValue(Core.matches(state.objects.network,coreResource('NetworkPolicy','argocd-server-network-policy')),'Current server ingress differs from the reviewed policy');
  const foundationNames=[...new Set(state.rows.flatMap(row=>{
   // The source inventory is later matched against live Application resources.
   const app=get('application.argoproj.io',row.name,'argocd');
   return (app?.status?.resources||[]).filter(r=>r.group==='plugins.opensphere.io'&&r.kind==='UIPluginRegistration'&&(r.namespace||app.spec.destination.namespace)==='opensphere-console').map(r=>r.name);
  }))].sort();
  requireValue(foundationNames.every(name=>/^[a-z0-9][a-z0-9.-]{0,251}$/.test(name)),'Foundation registration inventory invalid');
  const name='opensphere-foundation-delivery-registration-reader';
  const foundation=foundationNames.length?[{apiVersion:'rbac.authorization.k8s.io/v1',kind:'Role',metadata:{name,namespace:'opensphere-console',labels:P.labels},rules:[{apiGroups:['plugins.opensphere.io'],resources:['uipluginregistrations'],verbs:['get'],resourceNames:foundationNames}]},{apiVersion:'rbac.authorization.k8s.io/v1',kind:'RoleBinding',metadata:{name,namespace:'opensphere-console',labels:P.labels},subjects:[{kind:'ServiceAccount',name:'opensphere-foundation-runtime',namespace:'opensphere-console'}],roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:'Role',name}}]:[];
  const result=[config,rbac,network,...P.readerResources(),...foundation];
  for(const value of [...P.readerResources(),...foundation]){
   const old=state.objects[value.kind+'/'+value.metadata.namespace+'/'+value.metadata.name];if(!old)continue;
   requireValue(old.metadata?.labels?.['opensphere.io/managed-by']===P.labels['opensphere.io/managed-by']&&old.metadata?.labels?.['opensphere.io/purpose']===P.labels['opensphere.io/purpose'],'An observer Role or Binding belongs to a different owner');
   if(value.kind==='RoleBinding')requireValue(P.digest([old.roleRef,old.subjects])===P.digest([value.roleRef,value.subjects]),'Existing observer binding scope differs from the reviewed subject');
   else if(value.metadata.name==='opensphere-foundation-delivery-registration-reader'){
    const prior=state.objects.trust?.data?.['registrations.json'];const names=prior?JSON.parse(prior):foundationNames;
    const expected=[{apiGroups:['plugins.opensphere.io'],resources:['uipluginregistrations'],verbs:['get'],resourceNames:names}];
    requireValue(P.digest(old.rules)===P.digest(value.rules)||P.digest(old.rules)===P.digest(expected),'Existing Foundation reader grant differs from the previous approved registration inventory');
   }else requireValue(P.digest(old.rules)===P.digest(value.rules),'Existing observer reader grant has unexpected permissions');
  }
  return result;
 }
 function plan(){
  const state=current(),desired=policyObjects(state);
  const authority=state.objects.authority;
  requireValue(authority&&(Core.prepared(authority,Core.executorAuthority.resources[0])||Core.prepared(authority,Core.legacyExecutorAuthority.resources[0])),'Core executor authority differs from either exact approved transition');
  const registration=state.registration;
  const certificate=publicCertificate({optional:true});
  const targetObjects=[...desired,Core.executorAuthority.resources[0],{kind:'ConfigMap',metadata:{name:P.TRUST,namespace:'argocd'}},...state.projectObservation.targets.map(row=>({kind:row.kind,metadata:{name:row.name,namespace:row.namespace}})),...['argocd-secret','argocd-notifications-secret','argocd-server-tls',P.SECRET,LOCAL_CLUSTER_SECRET].map(name=>({kind:'Secret',metadata:{name,namespace:'argocd'}}))];
  const targets=[...new Map(targetObjects.map(row=>[row.kind+'/'+(row.metadata.namespace||'')+'/'+row.metadata.name,row])).values()].map(row=>{const key=row.kind+'/'+(row.metadata.namespace||'')+'/'+row.metadata.name,aliases={'ConfigMap/argocd/argocd-cm':'config','ConfigMap/argocd/argocd-rbac-cm':'rbac','NetworkPolicy/argocd/argocd-server-network-policy':'network','Role/argocd/opensphere-platform-support-core-executor':'authority',['ConfigMap/argocd/'+P.TRUST]:'trust'};const value=state.objects[aliases[key]||key]||state.objects[row.metadata.name];return {key,...metadata(value),contentDigest:value&&row.kind!=='Secret'?P.digest({data:value.data,spec:value.spec,rules:value.rules,roleRef:value.roleRef,subjects:value.subjects}):null};});
  const publicPlan={schema,clusterUid:state.clusterUid,namespaceUid:state.namespaceUid,context:config.context,toolSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),argocdSha256:config['argocd-sha256']||null,coreArtifactRevision:Core.artifactRevision,sourceAuthorityDigest:P.digest(authority.rules),compatibility:{registrationUid:registration?.metadata?.uid||null,source:registration?.status?.currentRevision||null,imageDigest:registration?.status?.currentDigest||null,servingPhase:registration?.status?.serving?.phase||null},tls:certificate?{sha256:createHash('sha256').update(certificate).digest('hex'),validTo:new X509Certificate(certificate).validTo}:{state:'ServingCertificatePreparationRequired',secret:'argocd-server-tls',keyAlgorithm:'RSA-3072',validDays:90,dnsNames:['argocd-server.argocd.svc','argocd-server.argocd.svc.cluster.local'],opensslSha256:config['openssl-sha256']||null},inventory:state.rows,policyDigest:P.digest(P.policy(state.rows,repositoryUrl)),objects:desired.map(o=>({kind:o.kind,namespace:o.metadata.namespace,name:o.metadata.name,digest:P.digest(o)})),observed:Object.fromEntries(Object.entries(state.objects).map(([key,value])=>[key,metadata(value)])),token:{account:P.ACCOUNT,expiresSeconds:604800,secret:P.SECRET,privateOutput:'never'},security:{newTargetNamespaces:['opensphere-platform-delivery'],workloadList:false,secretList:false,coreSigningSecretGet:false,coreSigningSecretCreate:false,serverAuthDisabled:false}};
  const clusterTarget=targets.find(row=>row.key==='Secret/argocd/'+LOCAL_CLUSTER_SECRET);clusterTarget.contentDigest=state.clusterScope.contentDigest;
  publicPlan.clusterScope={state:state.clusterScope.state,secret:'argocd/'+LOCAL_CLUSTER_SECRET,namespaces:state.clusterScope.namespaces,desiredDigest:P.digest(state.clusterScope.desired),existingContentDigest:state.clusterScope.contentDigest,newRbac:false,credentialMaterial:false};
  publicPlan.projectObservation={state:state.projectObservation.state,project:'argocd/'+P.DEMO,policy:PROJECT_POLICY,sourceKinds:['Deployment','Service','ConfigMap'],addedObservationKinds:['ReplicaSet','Pod'],newRbac:false,tokenRotation:false,targets:state.projectObservation.targets.map(row=>({key:row.key,state:row.state,...metadata(row.observed),contentDigest:row.observed?P.digest(row.observed.spec):null,desiredDigest:P.digest(row.expected)}))};
  publicPlan.targets=targets;return {...publicPlan,planDigest:P.digest(publicPlan)};
 }
 function ensure(value){
  const old=get(value.kind,value.metadata.name,value.metadata.namespace,{metadataOnly:value.kind==='Secret'});
  const key=value.kind+'/'+value.metadata.namespace+'/'+value.metadata.name,expected=approvedTargets?.get(key);
  requireValue(expected&&metadata(old).uid===expected.uid&&metadata(old).resourceVersion===expected.resourceVersion,'Target changed after the approved plan; replan before continuing');
  if(old){
   if(value.kind==='Secret')throw Error('Existing Secret cannot be overwritten by ensure');
   value={...value,metadata:{...old.metadata,...value.metadata,resourceVersion:old.metadata.resourceVersion}};
   for(const key of ['uid','generation','creationTimestamp','managedFields'])delete value.metadata[key];
   kubectl(['replace','--dry-run=server','-f','-','-o','name'],value);kubectl(['replace','-f','-','-o','name'],value);
  }else{kubectl(['create','--dry-run=server','-f','-','-o','name'],value);kubectl(['create','-f','-','-o','name'],value);}
  approvedTargets.set(key,{key,...metadata(get(value.kind,value.metadata.name,value.metadata.namespace,{metadataOnly:value.kind==='Secret'}))});
 }
 function approved(){const p=plan();requireValue(config['approve-plan']===p.planDigest,'Plan changed or --approve-plan is missing; nothing applied');approvedTargets=new Map(p.targets.map(row=>[row.key,row]));return p;}
 function prepareCredentials(){
  const p=approved(),state=current();
  for(const name of ['argocd-secret','argocd-notifications-secret']){
   if(state.objects[name])continue;
   const value=attributed(coreResource('Secret',name));
   if(name==='argocd-secret')value.stringData={'server.secretkey':randomBytes(32).toString('hex')};
   ensure(value);
  }
  // Trust marker contains only public state. It permits Core first install,
  // without requiring an observer token or an already running Argo server.
  ensure(P.readerResources()[0]);ensure(P.readerResources()[1]);
  ensure(ownObject('ConfigMap',P.TRUST,{...(state.objects.trust?.data||{}),schema,server:P.SERVER,'credentials.prepared':'true','preparation.planDigest':p.planDigest}));
  return {schema,state:'CoreCredentialsPrepared',clusterUid:p.clusterUid,secretsPrinted:false,observerTokenRequiredForCore:false};
 }
 function prepareClusterScope(){
  const p=approved(),state=current(),scope=state.clusterScope;
  requireValue(scope.namespaces.length>0,'No approved Application target namespaces exist; cluster descriptor was not created');
  const key='Secret/argocd/'+LOCAL_CLUSTER_SECRET,expected=approvedTargets.get(key);
  requireValue(expected&&metadata(scope.observed).uid===expected.uid&&metadata(scope.observed).resourceVersion===expected.resourceVersion&&scope.contentDigest===expected.contentDigest,'Local cluster descriptor changed after plan review');
  if(scope.observed)return {schema,state:'Noop',clusterUid:p.clusterUid,secret:'argocd/'+LOCAL_CLUSTER_SECRET,namespaces:scope.namespaces,contentDigest:scope.contentDigest,tokenRotation:false,newRbac:false,secretsPrinted:false};
  ensure(scope.desired);
  const verified=inspectClusterScope(state.rows);requireValue(verified.state==='Prepared','Local cluster descriptor creation requires reinspection');
  return {schema,state:'LocalNamespaceClusterPrepared',clusterUid:p.clusterUid,secret:'argocd/'+LOCAL_CLUSTER_SECRET,namespaces:scope.namespaces,contentDigest:verified.contentDigest,tokenRotation:false,newRbac:false,secretsPrinted:false};
 }
 function prepareProjectObservation(){
  const p=approved(),scope=inspectProjectObservation();
  requireValue(['Prepared','NeedsPreparation'].includes(scope.state),'Demo Project or admission policy is missing, foreign or outside the exact approved transition');
  for(const row of scope.targets){const expected=approvedTargets.get(row.key);requireValue(expected&&metadata(row.observed).uid===expected.uid&&metadata(row.observed).resourceVersion===expected.resourceVersion&&expected.contentDigest===P.digest({spec:row.observed.spec}),'Demo Project or policy changed after plan review');}
  const pending=scope.targets.filter(row=>row.state==='Legacy').sort((a,b)=>a.kind==='ValidatingAdmissionPolicy'?-1:1);
  const replacement=row=>{const value=structuredClone(row.observed);value.spec[row.field]=structuredClone(row.value);return value;};
  const args=dry=>['replace',...(dry?['--dry-run=server']:[]),'-f','-','-o','name'];
  // Initial plan/ownership bindings for BOTH objects were checked above. Then
  // prepare the VAP before dry-running the five-kind Project against it.
  // Preserve all other fields and resourceVersion compare/swap. This bounded
  // two-object transition is not atomic; a lost outcome needs reinspection.
  const changed=[];
  for(const row of pending){
   const unchanged=()=>{const live=get(row.kind,row.name,row.namespace);requireValue(live?.metadata?.uid===row.observed.metadata.uid&&live.metadata.resourceVersion===row.observed.metadata.resourceVersion&&P.digest(live.spec)===P.digest(row.observed.spec),'Demo Project or policy changed before replacement; nothing further applied');};
   unchanged();kubectl(args(true),replacement(row));unchanged();
   kubectl(args(false),replacement(row));changed.push(row.key);
   const verified=get(row.kind,row.name,row.namespace);requireValue(verified?.metadata?.uid===row.observed.metadata.uid&&P.digest(verified.spec)===P.digest(row.expected),'Demo observation patch outcome requires reinspection; no retry or rollback performed');
  }
  const verified=inspectProjectObservation();requireValue(verified.state==='Prepared','Demo observation transition remains incomplete; replan before continuing');
  return {schema,state:changed.length?'DemoProjectObservationPrepared':'Noop',clusterUid:p.clusterUid,planDigest:p.planDigest,changed,project:'argocd/'+P.DEMO,addedObservationKinds:['ReplicaSet','Pod'],newRbac:false,tokenRotation:false,sourceDeploymentKinds:['Deployment','Service','ConfigMap'],installationComplete:false};
 }
 function observerCredential(expected,currentId,previousId){
  const value=get('secret',P.SECRET,'argocd');
  requireValue(value?.metadata?.uid===expected.metadata.uid&&value.metadata.resourceVersion===expected.metadata.resourceVersion&&!value.metadata.deletionTimestamp&&value.metadata.labels?.['opensphere.io/managed-by']===P.labels['opensphere.io/managed-by']&&value.metadata.labels?.['opensphere.io/purpose']===P.labels['opensphere.io/purpose'],'Observer credential identity or ownership changed');
  requireValue(value.metadata.annotations?.['opensphere.io/token-id']===currentId&&(!previousId||value.metadata.annotations?.['opensphere.io/previous-token-id']===previousId),'Observer token identifiers changed');
  const data={...value.data,...Object.fromEntries(Object.entries(value.stringData||{}).map(([key,text])=>[key,Buffer.from(text).toString('base64')]))};
  requireValue(Object.keys(data).every(key=>['token','previousToken'].includes(key))&&typeof data.token==='string','Observer credential fields are outside the fixed schema');
  const tokenId=encoded=>{try{const token=Buffer.from(encoded,'base64').toString('utf8'),claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));return claims.sub===P.ACCOUNT+':apiKey'?claims.jti:null;}catch{return null;}};
  requireValue(tokenId(data.token)===currentId&&(!previousId||tokenId(data.previousToken)===previousId),'Sealed observer credential token identity does not match metadata');
  const result=structuredClone(value);delete result.stringData;result.data=data;return result;
 }
 function replaceObserverCredential(value,expected){
  value=replacementInput(value);
  kubectl(['replace','--dry-run=server','-f','-','-o','name'],value);
  const fresh=get('secret',P.SECRET,'argocd',{metadataOnly:true});requireValue(fresh?.metadata?.uid===expected.metadata.uid&&fresh.metadata.resourceVersion===expected.metadata.resourceVersion,'Observer credential changed before stdin replacement');
  kubectl(['replace','-f','-','-o','name'],value);
  const verified=get('secret',P.SECRET,'argocd');
  requireValue(verified?.metadata?.uid===expected.metadata.uid&&P.digest(verified.data)===P.digest(value.data)&&P.digest(verified.metadata.annotations)===P.digest(value.metadata.annotations),'Observer credential replacement outcome uncertain; reinspection required');
 }
 function accountTokenIds(){
  // Read exactly the observer account's public token metadata. Never request
  // the signing key or a complete Argo signing Secret into this process.
  const key='accounts.'+P.ACCOUNT+'.tokens',encoded=kubectl(['get','secret','argocd-secret','--namespace','argocd','-o','go-template={{index .data '+json(key)+'}}']).trim();
  requireValue(encoded.length>0&&encoded.length<131072,'Observer account token metadata is unavailable');
  let values;try{values=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));}catch{requireValue(false,'Observer account token metadata is invalid');}
  requireValue(Array.isArray(values)&&values.length<=256&&values.every(row=>typeof row.id==='string'&&/^psss-observer-[a-f0-9-]{36}$/.test(row.id)),'Observer account token identifiers are invalid');
  return values.map(row=>row.id);
 }
 function retirePreviousToken(previous,currentId){
  requireValue(/^psss-observer-[a-f0-9-]{36}$/.test(previous)&&/^psss-observer-[a-f0-9-]{36}$/.test(currentId)&&previous!==currentId,'Invalid observer rotation token identifiers');
  const before=accountTokenIds();requireValue(before.includes(currentId),'Current observer token is not present in account metadata');
  if(before.includes(previous)){
   let failed=false;try{cli(['account','delete-token','--account',P.ACCOUNT,previous]);}catch{failed=true;}
   const after=accountTokenIds();requireValue(!after.includes(previous)&&after.includes(currentId),failed?'Token revocation failed and absence was not verified; sealed recovery material preserved':'Token revocation postcondition not verified; sealed recovery material preserved');
  }
 }
 function cli(args){
  requireValue(config.argocd&&/^[a-f0-9]{64}$/.test(config['argocd-sha256']||''),'Pinned --argocd and --argocd-sha256 are required');
  const sha=createHash('sha256').update(readFile(config.argocd)).digest('hex');requireValue(sha===config['argocd-sha256'],'Pinned Argo CLI digest mismatch');
  const version=run(config.argocd,['version','--client','--short']);requireValue(/^argocd:\s+v3\.4\.2(?:\+|\s|$)/m.test(version),'Argo CLI must be exactly v3.4.2');
  const context=JSON.parse(kubectl(['config','view','--minify','-o','jsonpath={.contexts[0].context}']));
  requireValue(typeof context.cluster==='string'&&typeof context.user==='string','Original Kubernetes context is incomplete');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'opensphere-argocd-public-context-')),overlay=path.join(directory,'context.json');
  try{
   // This file contains public references only, never certificates, keys or
   // tokens. KUBECONFIG merges it with the unchanged existing credential file.
   fs.writeFileSync(overlay,json({apiVersion:'v1',kind:'Config','current-context':'opensphere-observer-preparation',contexts:[{name:'opensphere-observer-preparation',context:{cluster:context.cluster,user:context.user,namespace:'argocd'}}]}),{mode:0o600});
   return run(config.argocd,['--core','--loglevel','error','--prompts-enabled=false',...args],undefined,{KUBECONFIG:overlay+path.delimiter+config.kubeconfig});
  }finally{fs.unlinkSync(overlay);fs.rmdirSync(directory);}
 }
 function publicCertificate({optional=false}={}){
  let certificate=kubectl(['get','secret','argocd-server-tls','--namespace','argocd','--ignore-not-found','-o','jsonpath={.data.tls\\.crt}']).trim();
  if(!certificate)certificate=kubectl(['get','secret','argocd-secret','--namespace','argocd','-o','jsonpath={.data.tls\\.crt}']).trim();
  if(!certificate&&optional)return null;
  requireValue(!!certificate,'Argo public serving certificate is not available; install Core runtime before observer activation');
  const pem=Buffer.from(certificate,'base64').toString('utf8'),cert=new X509Certificate(pem);
  requireValue(!!cert.checkHost(new URL(P.SERVER).hostname),'Argo serving certificate SAN does not include the fixed internal service hostname');
  requireValue(Date.parse(cert.validTo)>now()+24*60*60*1000&&Date.parse(cert.validFrom)<=now(),'Argo certificate is expired or not yet valid');
  return pem;
 }
 function prepareTls(){
  const p=approved(),state=current();requireValue(!state.objects['argocd-server-tls'],'Serving TLS Secret already exists; replacement requires a separate rotation plan');
  requireValue(config.openssl&&/^[a-f0-9]{64}$/.test(config['openssl-sha256']||''),'Pinned --openssl and --openssl-sha256 are required');
  requireValue(createHash('sha256').update(readFile(config.openssl)).digest('hex')===config['openssl-sha256'],'Pinned OpenSSL digest mismatch');
  // Both PEM blocks go only to this process's captured stdout. No key file,
  // certificate store, browser value, command argument or log is created.
  let generated=run(config.openssl,['req','-x509','-newkey','rsa:3072','-sha256','-days','90','-nodes','-keyout','-','-out','-','-subj','/CN=argocd-server.argocd.svc.cluster.local','-addext','subjectAltName=DNS:argocd-server.argocd.svc,DNS:argocd-server.argocd.svc.cluster.local']);
  let key=generated.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/)?.[0],certificate=generated.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  try{
   requireValue(key&&certificate,'TLS issuer output invalid; output withheld');
   const parsed=new X509Certificate(certificate);requireValue(parsed.checkHost(new URL(P.SERVER).hostname)&&parsed.checkPrivateKey(createPrivateKey(key)),'Generated serving key/certificate identity mismatch');
   const value=ownObject('Secret','argocd-server-tls',{'tls.crt':certificate,'tls.key':key});value.type='kubernetes.io/tls';value.metadata.annotations={'opensphere.io/plan-digest':p.planDigest,'opensphere.io/public-certificate-sha256':createHash('sha256').update(certificate).digest('hex'),'opensphere.io/expires-at':new Date(parsed.validTo).toISOString()};ensure(value);
   return {schema,state:'ServingTlsPrepared',clusterUid:p.clusterUid,secret:'argocd/argocd-server-tls',certificateSha256:value.metadata.annotations['opensphere.io/public-certificate-sha256'],expiresAt:new Date(parsed.validTo).toISOString(),secretsPrinted:false,replacesExisting:false};
  }finally{generated=undefined;key=undefined;certificate=undefined;}
 }
 function activate({renew=false}={}){
  const p=approved(),state=current(),desired=policyObjects(state);
  const old=state.objects[P.SECRET];requireValue(!old||renew,'An observer token already exists; use the explicit renew operation');
  requireValue(!old?.metadata?.annotations?.['opensphere.io/previous-token-id'],'A previous rotation still needs authenticated cutover; do not issue another token');
  requireValue(state.objects['argocd-secret']&&state.objects['argocd-notifications-secret'],'Setup Core credentials must be prepared first');
  const certificate=publicCertificate();
  // Compatibility PSSS must be installed before these policy changes. The root
  // invokes this only after its signed package/readiness verification succeeds.
  requireValue(config['compat-source']&&/^[a-f0-9]{40}$/.test(config['compat-source']),'--compat-source of the deployed compatibility release is required');
  const reg=state.registration;
  requireValue(/^sha256:[a-f0-9]{64}$/.test(config['compat-digest']||'')&&reg?.status?.currentRevision===config['compat-source']&&reg.status.currentDigest===config['compat-digest']&&reg.status.serving?.phase==='Current'&&reg.status.serving.digest===config['compat-digest']&&reg.status.activation?.phase==='Completed','Deployed PSSS source/digest and Current proof do not match the approved compatibility release');
  for(const value of desired)ensure(value);
  const id='psss-observer-'+randomUUID();let token,stored=false,previousToken;
  if(renew){const previousCredential=observerCredential(old,old.metadata.annotations?.['opensphere.io/token-id']);previousToken=previousCredential.data?.token?Buffer.from(previousCredential.data.token,'base64').toString('utf8'):undefined;requireValue(typeof previousToken==='string'&&previousToken.length>20,'Previous observer token is unavailable for safe rotation');}
  try{
   token=cli(['account','generate-token','--account',P.ACCOUNT,'--expires-in','168h','--id',id]).trim();
   requireValue(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),'CLI token output invalid; output withheld');
   const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
   requireValue(claims.sub===P.ACCOUNT+':apiKey'&&claims.jti===id&&claims.exp>claims.iat&&claims.exp-claims.iat<=604800,'Observer token claims do not match the approved account or lifetime');
   const value=ownObject('Secret',P.SECRET,{token});value.metadata.annotations={'opensphere.io/token-id':id,'opensphere.io/expires-at':new Date(claims.exp*1000).toISOString(),'opensphere.io/plan-digest':p.planDigest};
   const previous=old?.metadata?.annotations?.['opensphere.io/token-id'];if(previous)value.metadata.annotations['opensphere.io/previous-token-id']=previous;
   if(previousToken)value.stringData.previousToken=previousToken;
   if(old){value.metadata={...old.metadata,...value.metadata,uid:old.metadata.uid,resourceVersion:old.metadata.resourceVersion,labels:{...old.metadata.labels,...value.metadata.labels},annotations:{...old.metadata.annotations,...value.metadata.annotations}};kubectl(['replace','--dry-run=server','-f','-','-o','name'],value);kubectl(['replace','-f','-','-o','name'],value);}else ensure(value);
   stored=true;
   const foundationRole=desired.find(v=>v.kind==='Role'&&v.metadata.name==='opensphere-foundation-delivery-registration-reader');
   ensure(ownObject('ConfigMap',P.TRUST,{...(state.objects.trust?.data||{}),schema,server:P.SERVER,'ca.crt':certificate,'credentials.prepared':'true','inventory.json':json(state.rows),'registrations.json':json(foundationRole?.rules[0].resourceNames||[]),'policy.sha256':p.policyDigest,'preparation.planDigest':p.planDigest,'observer.expiresAt':new Date(claims.exp*1000).toISOString(),'tls.expiresAt':new Date(new X509Certificate(certificate).validTo).toISOString()}));
   // Revocation happens only after the replacement Secret and public trust are
   // stored. Runtime API acceptance is independently checked before final cutover.
   return {schema,state:'ObserverPrepared',clusterUid:p.clusterUid,planDigest:p.planDigest,tokenId:id,expiresAt:new Date(claims.exp*1000).toISOString(),authorityCutover:'PendingAuthenticatedRuntimeProof',secretsPrinted:false};
  }catch(error){
   if(stored&&previousToken){
    try{const current=get('secret',P.SECRET,'argocd',{metadataOnly:true}),value=observerCredential(current,id,old.metadata.annotations['opensphere.io/token-id']);value.metadata.annotations['opensphere.io/token-id']=old.metadata.annotations['opensphere.io/token-id'];value.metadata.annotations['opensphere.io/expires-at']=old.metadata.annotations['opensphere.io/expires-at'];delete value.metadata.annotations['opensphere.io/previous-token-id'];value.data.token=value.data.previousToken;delete value.data.previousToken;replaceObserverCredential(value,current);stored=false;}catch{requireValue(false,'Observer rotation outcome uncertain; both issued tokens remain valid and sealed recovery material is retained');}
   }
   if(token&&!stored){try{cli(['account','delete-token','--account',P.ACCOUNT,id]);}catch{}}
   if(stored)requireValue(false,'Observer activation outcome uncertain; the stored token is preserved for authenticated recovery');
   throw error;
  }finally{token=undefined;previousToken=undefined;}
 }
 function cutover(){
  const p=approved(),state=current();
  requireValue(config['authenticated-proof']===p.policyDigest,'--authenticated-proof must match the policy digest after OS Shell API verification');
  requireValue(state.objects[P.SECRET]&&state.objects.trust?.data?.['policy.sha256']===p.policyDigest,'Prepared observer credentials and policy are not current');
  ensure(structuredClone(Core.executorAuthority.resources[0]));
  ensure(ownObject('ConfigMap',P.TRUST,{...state.objects.trust.data,'authority.reduced':'true'}));
  const previous=state.objects[P.SECRET].metadata?.annotations?.['opensphere.io/previous-token-id'];
  if(previous){const currentId=state.objects[P.SECRET].metadata.annotations['opensphere.io/token-id'],value=observerCredential(state.objects[P.SECRET],currentId,previous);retirePreviousToken(previous,currentId);delete value.metadata.annotations['opensphere.io/previous-token-id'];delete value.data.previousToken;replaceObserverCredential(value,state.objects[P.SECRET]);}
  return {schema,state:'SigningSecretAuthorityRemoved',clusterUid:p.clusterUid,planDigest:p.planDigest,removed:['get secrets/argocd-secret','get secrets/argocd-notifications-secret','create secrets'],secretsPrinted:false};
 }
 function revoke(){
  const p=approved(),state=current(),id=state.objects[P.SECRET]?.metadata?.annotations?.['opensphere.io/token-id'];
  requireValue(id&&/^psss-observer-[a-f0-9-]{36}$/.test(id),'Current token identifier unavailable');
  cli(['account','delete-token','--account',P.ACCOUNT,id]);
  kubectl(['delete','secret',P.SECRET,'--namespace','argocd','--wait=true','--ignore-not-found','-o','name']);
  return {schema,state:'ObserverRevoked',clusterUid:p.clusterUid,tokenId:id,secretsPrinted:false};
 }
 return {plan,prepareCredentials,prepareClusterScope,prepareProjectObservation,prepareTls,activate,cutover,revoke};
}
if(require.main===module){try{const config=options(process.argv.slice(2)),tool=createPreparation(config);const mode=config.mode||'plan';const result=mode==='plan'?tool.plan():mode==='core-credentials'?tool.prepareCredentials():mode==='cluster-scope'?tool.prepareClusterScope():mode==='project-observation'?tool.prepareProjectObservation():mode==='tls-prepare'?tool.prepareTls():mode==='apply'?tool.activate():mode==='renew'?tool.activate({renew:true}):mode==='cutover'?tool.cutover():mode==='revoke'?tool.revoke():(()=>{requireValue(false,'Unsupported mode');})();process.stdout.write(json(result)+'\n');}catch(error){process.stderr.write((error.code==='PreparationRejected'?error.message:'Preparation failed; potentially credential-bearing diagnostics withheld')+'\n');process.exitCode=1;}}
module.exports={createPreparation,options,schema,LOCAL_CLUSTER_SECRET};
