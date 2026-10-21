'use strict';
// Fixed read-only observer preparation contract. Never export token material.
const {createHash}=require('node:crypto');
const NAMESPACE='argocd',ACCOUNT='opensphere-psss-observer';
const SECRET='opensphere-platform-support-argocd-observer';
const TRUST=SECRET+'-trust';
const SERVER='https://argocd-server.argocd.svc.cluster.local:443';
const ROLE='role:opensphere-psss-observer';
const DEMO='psss-opensphere-adoption-demo';
const labels={'opensphere.io/managed-by':'opensphere-setup','opensphere.io/purpose':'argocd-observer'};
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=v=>'sha256:'+createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
function required(ok,message){if(!ok)throw Error(message);}
function inventory(applications,repository){
 required(Array.isArray(applications)&&applications.length<=300,'Application inventory is invalid');
 const seen=new Set(),rows=[];
 for(const app of applications){
  const name=app.metadata?.name,project=app.spec?.project;
  required(app.kind==='Application'&&app.metadata?.namespace===NAMESPACE&&/^[a-z0-9][a-z0-9.-]{0,251}$/.test(name||'')&&/^[a-z0-9][a-z0-9.-]{0,251}$/.test(project||''),'Application identity is invalid');
  required(app.spec?.destination?.server==='https://kubernetes.default.svc','Only the approved local cluster is supported');
  required(app.spec?.source?.repoURL===repository&&!app.spec?.sources,'Application repository is not the approved source');
  required(!seen.has(project+'/'+name),'Duplicate Application identity');seen.add(project+'/'+name);
  rows.push({name,project,uid:app.metadata.uid,destinationNamespace:app.spec.destination.namespace});
 }
 return rows.sort((a,b)=>(a.project+'/'+a.name).localeCompare(b.project+'/'+b.name));
}
function policy(rows,repository){
 required(typeof repository==='string'&&repository.length<1000&&!/[*,\r\n]/.test(repository),'Repository RBAC object must be exact');
 const lines=rows.map(a=>`p, ${ROLE}, applications, get, ${a.project}/${a.name}, allow`);
 if(rows.some(a=>a.name===DEMO&&a.project===DEMO))lines.push(`p, ${ROLE}, logs, get, ${DEMO}/${DEMO}, allow`);
 lines.push(`p, ${ROLE}, repositories, get, ${repository}, allow`);
 lines.push(`p, ${ROLE}, clusters, get, https://kubernetes.default.svc, allow`);
 lines.push(`g, ${ACCOUNT}, ${ROLE}`);
 return lines.join('\n')+'\n';
}
function readerResources(){
 const resource=(kind,namespace,name,extra)=>({apiVersion:'rbac.authorization.k8s.io/v1',kind,metadata:{name,namespace,labels},...extra});
 const binding=(namespace,name,subject)=>resource('RoleBinding',namespace,name,{subjects:[subject],roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:'Role',name}});
 const name='opensphere-platform-support-argo-reader-credential';
 const demo='opensphere-argocd-server-demo-reader';
 return [resource('Role',NAMESPACE,name,{rules:[{apiGroups:[''],resources:['secrets'],verbs:['get'],resourceNames:[SECRET]},{apiGroups:[''],resources:['configmaps'],verbs:['get'],resourceNames:[TRUST]}]}),
  binding(NAMESPACE,name,{kind:'ServiceAccount',name:'opensphere-platform-support-runtime',namespace:'opensphere-console'}),
  resource('Role','opensphere-platform-delivery',demo,{rules:[{apiGroups:['apps'],resources:['deployments'],verbs:['get'],resourceNames:['opensphere-adoption-demo']},{apiGroups:[''],resources:['services'],verbs:['get'],resourceNames:['opensphere-adoption-demo']},{apiGroups:['apps'],resources:['replicasets'],verbs:['get']},{apiGroups:[''],resources:['pods','pods/log'],verbs:['get']},{apiGroups:[''],resources:['events'],verbs:['list']}]}),
  binding('opensphere-platform-delivery',demo,{kind:'ServiceAccount',name:'argocd-server',namespace:NAMESPACE})];
}
function psssPeer(){return {namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':'opensphere-console'}},podSelector:{matchLabels:{'opensphere.io/extension-id':'platform-support'}}};}
module.exports={NAMESPACE,ACCOUNT,SECRET,TRUST,SERVER,ROLE,DEMO,labels,stable,digest,inventory,policy,readerResources,psssPeer};
