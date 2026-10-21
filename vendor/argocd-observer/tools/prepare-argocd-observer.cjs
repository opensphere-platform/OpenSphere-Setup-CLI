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
const schema='opensphere.argocd-observer-preparation/v1';
const metadata=o=>({uid:o?.metadata?.uid||null,resourceVersion:o?.metadata?.resourceVersion||null});
const json=v=>JSON.stringify(v);
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
  for(const row of [...P.readerResources(),{kind:'Role',metadata:{name:'opensphere-foundation-delivery-registration-reader',namespace:'opensphere-console'}},{kind:'RoleBinding',metadata:{name:'opensphere-foundation-delivery-registration-reader',namespace:'opensphere-console'}}])objects[row.kind+'/'+row.metadata.namespace+'/'+row.metadata.name]=get(row.kind,row.metadata.name,row.metadata.namespace);
  for(const name of ['argocd-secret','argocd-notifications-secret'])if(objects[name])requireValue(objects[name].metadata?.labels?.['opensphere.io/managed-by']==='platform-support'&&[Core.artifactRevision,Core.legacyArtifactRevision].includes(objects[name].metadata?.annotations?.['opensphere.io/core-artifact']),'Existing Core credential ownership differs; explicit recovery review required');
  if(objects[P.SECRET])requireValue(objects[P.SECRET].metadata?.labels?.['opensphere.io/managed-by']===P.labels['opensphere.io/managed-by']&&objects[P.SECRET].metadata?.labels?.['opensphere.io/purpose']===P.labels['opensphere.io/purpose'],'Observer Secret belongs to a different owner');
  if(objects.trust)requireValue(objects.trust.metadata?.labels?.['opensphere.io/managed-by']===P.labels['opensphere.io/managed-by']&&objects.trust.metadata?.labels?.['opensphere.io/purpose']===P.labels['opensphere.io/purpose'],'Observer trust belongs to a different owner');
  const registration=get('uipluginregistration.plugins.opensphere.io','platform-support','opensphere-console');
  return {clusterUid:ns.metadata.uid,namespaceUid:argo.metadata.uid,rows,objects,registration};
 }
 function coreResource(kind,name){return structuredClone(Core.bundle.runtime.find(r=>r.kind===kind&&r.metadata.name===name));}
 function attributed(value){value.metadata.labels={...value.metadata.labels,'opensphere.io/managed-by':'platform-support'};value.metadata.annotations={...value.metadata.annotations,'opensphere.io/core-artifact':Core.artifactRevision};return value;}
 function ownObject(kind,name,data){return {apiVersion:'v1',kind,metadata:{name,namespace:'argocd',labels:P.labels},...(kind==='ConfigMap'?{data}:{type:'Opaque',stringData:data})};}
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
  const targetObjects=[...desired,Core.executorAuthority.resources[0],{kind:'ConfigMap',metadata:{name:P.TRUST,namespace:'argocd'}},...['argocd-secret','argocd-notifications-secret','argocd-server-tls',P.SECRET].map(name=>({kind:'Secret',metadata:{name,namespace:'argocd'}}))];
  const targets=[...new Map(targetObjects.map(row=>[row.kind+'/'+row.metadata.namespace+'/'+row.metadata.name,row])).values()].map(row=>{const key=row.kind+'/'+row.metadata.namespace+'/'+row.metadata.name,aliases={'ConfigMap/argocd/argocd-cm':'config','ConfigMap/argocd/argocd-rbac-cm':'rbac','NetworkPolicy/argocd/argocd-server-network-policy':'network','Role/argocd/opensphere-platform-support-core-executor':'authority',['ConfigMap/argocd/'+P.TRUST]:'trust'};const value=state.objects[aliases[key]||key]||state.objects[row.metadata.name];return {key,...metadata(value),contentDigest:value&&row.kind!=='Secret'?P.digest({data:value.data,spec:value.spec,rules:value.rules,roleRef:value.roleRef,subjects:value.subjects}):null};});
  const publicPlan={schema,clusterUid:state.clusterUid,namespaceUid:state.namespaceUid,context:config.context,toolSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),argocdSha256:config['argocd-sha256']||null,coreArtifactRevision:Core.artifactRevision,sourceAuthorityDigest:P.digest(authority.rules),compatibility:{registrationUid:registration?.metadata?.uid||null,source:registration?.status?.currentRevision||null,imageDigest:registration?.status?.currentDigest||null,servingPhase:registration?.status?.serving?.phase||null},tls:certificate?{sha256:createHash('sha256').update(certificate).digest('hex'),validTo:new X509Certificate(certificate).validTo}:{state:'ServingCertificatePreparationRequired',secret:'argocd-server-tls',keyAlgorithm:'RSA-3072',validDays:90,dnsNames:['argocd-server.argocd.svc','argocd-server.argocd.svc.cluster.local'],opensslSha256:config['openssl-sha256']||null},inventory:state.rows,policyDigest:P.digest(P.policy(state.rows,repositoryUrl)),objects:desired.map(o=>({kind:o.kind,namespace:o.metadata.namespace,name:o.metadata.name,digest:P.digest(o)})),observed:Object.fromEntries(Object.entries(state.objects).map(([key,value])=>[key,metadata(value)])),token:{account:P.ACCOUNT,expiresSeconds:604800,secret:P.SECRET,privateOutput:'never'},security:{newTargetNamespaces:['opensphere-platform-delivery'],workloadList:false,secretList:false,coreSigningSecretGet:false,coreSigningSecretCreate:false,serverAuthDisabled:false}};
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
  requireValue(state.objects['argocd-secret']&&state.objects['argocd-notifications-secret'],'Setup Core credentials must be prepared first');
  const certificate=publicCertificate();
  // Compatibility PSSS must be installed before these policy changes. The root
  // invokes this only after its signed package/readiness verification succeeds.
  requireValue(config['compat-source']&&/^[a-f0-9]{40}$/.test(config['compat-source']),'--compat-source of the deployed compatibility release is required');
  const reg=state.registration;
  requireValue(/^sha256:[a-f0-9]{64}$/.test(config['compat-digest']||'')&&reg?.status?.currentRevision===config['compat-source']&&reg.status.currentDigest===config['compat-digest']&&reg.status.serving?.phase==='Current'&&reg.status.serving.digest===config['compat-digest']&&reg.status.activation?.phase==='Completed','Deployed PSSS source/digest and Current proof do not match the approved compatibility release');
  for(const value of desired)ensure(value);
  const id='psss-observer-'+randomUUID();let token,stored=false,previousToken;
  if(renew){const previousCredential=get('secret',P.SECRET,'argocd');requireValue(previousCredential?.metadata?.uid===old.metadata.uid&&previousCredential.metadata.resourceVersion===old.metadata.resourceVersion,'Observer Secret changed before rotation');previousToken=previousCredential.stringData?.token||(previousCredential.data?.token?Buffer.from(previousCredential.data.token,'base64').toString('utf8'):undefined);requireValue(typeof previousToken==='string'&&previousToken.length>20,'Previous observer token is unavailable for safe rotation');}
  try{
   token=cli(['account','generate-token','--account',P.ACCOUNT,'--expires-in','168h','--id',id]).trim();
   requireValue(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),'CLI token output invalid; output withheld');
   const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
   requireValue(claims.sub===P.ACCOUNT+':apiKey'&&claims.jti===id&&claims.exp>claims.iat&&claims.exp-claims.iat<=604800,'Observer token claims do not match the approved account or lifetime');
   const value=ownObject('Secret',P.SECRET,{token});value.metadata.annotations={'opensphere.io/token-id':id,'opensphere.io/expires-at':new Date(claims.exp*1000).toISOString(),'opensphere.io/plan-digest':p.planDigest};
   const previous=old?.metadata?.annotations?.['opensphere.io/token-id'];if(previous)value.metadata.annotations['opensphere.io/previous-token-id']=previous;
   if(previousToken)value.stringData.previousToken=previousToken;
   if(old){value.metadata.resourceVersion=old.metadata.resourceVersion;kubectl(['replace','--dry-run=server','-f','-','-o','name'],value);kubectl(['replace','-f','-','-o','name'],value);}else ensure(value);
   stored=true;
   const foundationRole=desired.find(v=>v.kind==='Role'&&v.metadata.name==='opensphere-foundation-delivery-registration-reader');
   ensure(ownObject('ConfigMap',P.TRUST,{...(state.objects.trust?.data||{}),schema,server:P.SERVER,'ca.crt':certificate,'credentials.prepared':'true','inventory.json':json(state.rows),'registrations.json':json(foundationRole?.rules[0].resourceNames||[]),'policy.sha256':p.policyDigest,'preparation.planDigest':p.planDigest,'observer.expiresAt':new Date(claims.exp*1000).toISOString(),'tls.expiresAt':new Date(new X509Certificate(certificate).validTo).toISOString()}));
   // Revocation happens only after the replacement Secret and public trust are
   // stored. Runtime API acceptance is independently checked before final cutover.
   return {schema,state:'ObserverPrepared',clusterUid:p.clusterUid,planDigest:p.planDigest,tokenId:id,expiresAt:new Date(claims.exp*1000).toISOString(),authorityCutover:'PendingAuthenticatedRuntimeProof',secretsPrinted:false};
  }catch(error){
   if(stored&&previousToken){
    try{const current=get('secret',P.SECRET,'argocd',{metadataOnly:true});requireValue(current.metadata?.annotations?.['opensphere.io/token-id']===id,'Observer credential changed during failed rotation');kubectl(['patch','secret',P.SECRET,'--namespace','argocd','--type=merge','--patch-file','-','-o','name'],{metadata:{resourceVersion:current.metadata.resourceVersion,annotations:{'opensphere.io/token-id':old.metadata.annotations['opensphere.io/token-id'],'opensphere.io/previous-token-id':null,'opensphere.io/expires-at':old.metadata.annotations['opensphere.io/expires-at']}},data:{token:Buffer.from(previousToken).toString('base64'),previousToken:null}});stored=false;}catch{requireValue(false,'Observer rotation outcome uncertain; both issued tokens remain valid and sealed recovery material is retained');}
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
  if(previous){cli(['account','delete-token','--account',P.ACCOUNT,previous]);kubectl(['patch','secret',P.SECRET,'--namespace','argocd','--type=merge','--patch-file','-','-o','name'],{metadata:{resourceVersion:state.objects[P.SECRET].metadata.resourceVersion,annotations:{'opensphere.io/previous-token-id':null}},data:{previousToken:null}});}
  return {schema,state:'SigningSecretAuthorityRemoved',clusterUid:p.clusterUid,planDigest:p.planDigest,removed:['get secrets/argocd-secret','get secrets/argocd-notifications-secret','create secrets'],secretsPrinted:false};
 }
 function revoke(){
  const p=approved(),state=current(),id=state.objects[P.SECRET]?.metadata?.annotations?.['opensphere.io/token-id'];
  requireValue(id&&/^psss-observer-[a-f0-9-]{36}$/.test(id),'Current token identifier unavailable');
  cli(['account','delete-token','--account',P.ACCOUNT,id]);
  kubectl(['delete','secret',P.SECRET,'--namespace','argocd','--wait=true','--ignore-not-found','-o','name']);
  return {schema,state:'ObserverRevoked',clusterUid:p.clusterUid,tokenId:id,secretsPrinted:false};
 }
 return {plan,prepareCredentials,prepareTls,activate,cutover,revoke};
}
if(require.main===module){try{const config=options(process.argv.slice(2)),tool=createPreparation(config);const mode=config.mode||'plan';const result=mode==='plan'?tool.plan():mode==='core-credentials'?tool.prepareCredentials():mode==='tls-prepare'?tool.prepareTls():mode==='apply'?tool.activate():mode==='renew'?tool.activate({renew:true}):mode==='cutover'?tool.cutover():mode==='revoke'?tool.revoke():(()=>{requireValue(false,'Unsupported mode');})();process.stdout.write(json(result)+'\n');}catch(error){process.stderr.write((error.code==='PreparationRejected'?error.message:'Preparation failed; potentially credential-bearing diagnostics withheld')+'\n');process.exitCode=1;}}
module.exports={createPreparation,options,schema};
