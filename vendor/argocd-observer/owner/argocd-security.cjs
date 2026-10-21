'use strict';
// Read-only first-delivery gate. Never project ConfigMap or Secret bodies.
const {materialize}=require('./argocd-policy-overlay.cjs');
const deliveryAdmission=require('../contracts/argocd-first-delivery-policy.json');
const {repositoryUrl}=require('./argocd-repository-credential.cjs');
const {psssPeer}=require('./argocd-observer-policy.cjs');
const reviewedRoles=new Map(materialize().prerequisites
 .filter(v=>['Role','ClusterRole'].includes(v.kind)&&
   ['argocd-application-controller','argocd-applicationset-controller','argocd-server']
    .includes(v.metadata?.name))
 .map(v=>[`${v.kind}/${v.metadata.namespace||''}/${v.metadata.name}`,v]));
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(key=>[key,ordered(v[key])])):v;
const canonical=v=>JSON.stringify(ordered(v));
function reviewedDeliveryAdmission(v,kind,name='opensphere-psss-first-delivery'){
 const expected=deliveryAdmission.find(item=>item.kind===kind&&item.metadata.name===name);
 if(!expected||v?.apiVersion!==expected.apiVersion||v.kind!==kind||
   v.metadata?.name!==expected.metadata.name||v.metadata?.deletionTimestamp)
  return 'Unsafe';
 return canonical(v.spec)===canonical(expected.spec)?'Pass':'Unsafe';
}
function reviewedAuthority(v,kind,name){
 const expected=reviewedRoles.get(`${kind}/${kind==='Role'?'argocd':''}/${name}`);
 if(!expected||v?.kind!==kind||v.apiVersion!=='rbac.authorization.k8s.io/v1'||
   v.metadata?.name!==name||(v.metadata?.namespace||null)!==(expected.metadata.namespace||null)||
   v.aggregationRule||!Array.isArray(v.rules))return 'Unsafe';
 return canonical(v.rules)===canonical(expected.rules)?'Pass':'Unsafe';
}
const paths=Object.freeze({
 server:'/api/v1/namespaces/argocd/services/argocd-server',
 network:'/apis/networking.k8s.io/v1/namespaces/argocd/networkpolicies/argocd-server-network-policy',
 config:'/api/v1/namespaces/argocd/configmaps/argocd-cm',
 params:'/api/v1/namespaces/argocd/configmaps/argocd-cmd-params-cm',
 ingress:'/apis/networking.k8s.io/v1/namespaces/argocd/ingresses',
 controller:'/apis/rbac.authorization.k8s.io/v1/clusterroles/argocd-application-controller',
 controllerRole:'/apis/rbac.authorization.k8s.io/v1/namespaces/argocd/roles/argocd-application-controller',
 controllerBinding:'/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/argocd-application-controller',
 controllerRoleBinding:'/apis/rbac.authorization.k8s.io/v1/namespaces/argocd/rolebindings/argocd-application-controller',
 applicationSet:'/apis/rbac.authorization.k8s.io/v1/clusterroles/argocd-applicationset-controller',
 applicationSetRole:'/apis/rbac.authorization.k8s.io/v1/namespaces/argocd/roles/argocd-applicationset-controller',
 applicationSetBinding:'/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/argocd-applicationset-controller',
 applicationSetRoleBinding:'/apis/rbac.authorization.k8s.io/v1/namespaces/argocd/rolebindings/argocd-applicationset-controller',
 serverClusterRole:'/apis/rbac.authorization.k8s.io/v1/clusterroles/argocd-server',
 serverRole:'/apis/rbac.authorization.k8s.io/v1/namespaces/argocd/roles/argocd-server',
 serverBinding:'/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/argocd-server',
 serverRoleBinding:'/apis/rbac.authorization.k8s.io/v1/namespaces/argocd/rolebindings/argocd-server',
 projects:'/apis/argoproj.io/v1alpha1/namespaces/argocd/appprojects',
 deliveryPolicy:'/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/opensphere-psss-first-delivery',
 deliveryBinding:'/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/opensphere-psss-first-delivery',
 deliveryProjectPolicy:'/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/opensphere-psss-first-delivery-projects',
 deliveryProjectBinding:'/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/opensphere-psss-first-delivery-projects',
});
function dedicatedProject(v){
 if(v.kind!=='AppProjectList'||!Array.isArray(v.items)||v.metadata?.continue)return 'Unknown';
 const project=v.items.find(item=>item.metadata?.name==='opensphere-platform-delivery');
 if(!project)return 'Missing';
 if(project.kind!=='AppProject'||project.apiVersion!=='argoproj.io/v1alpha1'||
   project.metadata?.namespace!=='argocd'||
   project.metadata?.labels?.['opensphere.io/managed-by']!=='platform-support'||
   project.metadata?.deletionTimestamp||project.metadata?.finalizers?.length||
   project.metadata?.ownerReferences?.length)return 'Unsafe';
 const spec=project.spec||{},source=spec.sourceRepos,dest=spec.destinations;
 if(source?.length!==1||source[0]!==repositoryUrl||dest?.length!==1||
   !Array.isArray(spec.clusterResourceWhitelist)||spec.clusterResourceWhitelist.length||spec.roles?.length||
   spec.sourceNamespaces?.length||spec.orphanedResources?.warn!==true||
   Object.keys(spec.orphanedResources).length!==1||
   Object.keys(spec).some(key=>!['description','sourceRepos','destinations',
    'clusterResourceWhitelist','namespaceResourceWhitelist','orphanedResources',
    'roles','sourceNamespaces'].includes(key)))return 'Unsafe';
 const target=dest[0],namespace=target.namespace;
 if(target.server!=='https://kubernetes.default.svc'||target.name||
   namespace!=='opensphere-platform-delivery'||Object.keys(target).length!==2)return 'Unsafe';
 const kinds=spec.namespaceResourceWhitelist;
 if(!Array.isArray(kinds)||kinds.length!==1||kinds[0].group!==''||
   kinds[0].kind!=='ConfigMap'||Object.keys(kinds[0]).length!==2)return 'Unsafe';
 const demo=v.items.find(item=>item.metadata?.name==='psss-opensphere-adoption-demo');
 if(demo&&!demoObservationProject(demo))return 'Unsafe';
 return 'Pass';
}
function demoObservationProject(project){
 const spec={sourceRepos:[repositoryUrl],destinations:[{server:'https://kubernetes.default.svc',namespace:'opensphere-platform-delivery'}],clusterResourceWhitelist:[],namespaceResourceWhitelist:[{group:'apps',kind:'Deployment'},{group:'',kind:'Service'},{group:'',kind:'ConfigMap'},{group:'apps',kind:'ReplicaSet'},{group:'',kind:'Pod'}],orphanedResources:{warn:true}};
 return project?.kind==='AppProject'&&project.apiVersion==='argoproj.io/v1alpha1'&&project.metadata?.name==='psss-opensphere-adoption-demo'&&project.metadata.namespace==='argocd'&&project.metadata.labels?.['opensphere.io/managed-by']==='platform-support'&&!project.metadata.deletionTimestamp&&!project.metadata.finalizers?.length&&!project.metadata.ownerReferences?.length&&canonical(project.spec)===canonical(spec);
}
function serverIngress(v){
 if(v.kind!=='NetworkPolicy'||v.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name']!=='argocd-server'||
   !v.spec?.policyTypes?.includes('Ingress')||!Array.isArray(v.spec.ingress)||!v.spec.ingress.length)return 'Unsafe';
 return v.spec.ingress.every(rule=>Array.isArray(rule.from)&&rule.from.length>0&&
   Array.isArray(rule.ports)&&rule.ports.length>0&&rule.ports.every(port=>port.protocol==='TCP'&&port.port===8080)&&
   rule.from.every(from=>{
     if(canonical(from)===canonical(psssPeer()))return true;
     const namespace=from.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'];
     const pod=from.podSelector?.matchLabels?.['app.kubernetes.io/name'];
     return namespace==='argocd'&&['argocd-applicationset-controller','argocd-dex-server',
       'argocd-notifications-controller'].includes(pod);
   }))?'Pass':'Unsafe';
}
function privilegedAuthority(v){
 if(!['ClusterRole','Role'].includes(v.kind)||!Array.isArray(v.rules))return 'Unknown';
 if(!v.rules.length)return 'Unsafe';
 const sensitive=new Set(['secrets','serviceaccounts','roles','rolebindings','clusterroles',
   'clusterrolebindings','namespaces','nodes','validatingadmissionpolicies','mutatingwebhookconfigurations',
   'applications','applicationsets','appprojects']);
 return v.rules.some(rule=>rule.apiGroups?.includes('*')||rule.resources?.includes('*')||
   rule.verbs?.includes('*')||rule.nonResourceURLs?.includes('*')||
   rule.verbs?.some(verb=>['impersonate','bind','escalate'].includes(verb))||
   rule.resources?.some(resource=>sensitive.has(resource)&&
     rule.verbs?.some(verb=>['create','update','patch','delete','deletecollection'].includes(verb))))?'Unsafe':'Pass';
}
function binding(v,kind,name,roleKind,subject){
 if(v.kind!==kind||v.metadata?.name!==name||
   (v.metadata.namespace||null)!==(kind==='RoleBinding'?'argocd':null)||
   v.roleRef?.apiGroup!=='rbac.authorization.k8s.io'||v.roleRef.kind!==roleKind||
   v.roleRef.name!==name||!Array.isArray(v.subjects)||v.subjects.length!==1)return 'Unsafe';
 const actual=v.subjects[0];
 return actual.kind==='ServiceAccount'&&actual.name===subject&&actual.namespace==='argocd'?'Pass':'Unsafe';
}
function assess(raw,coreState){
 const checks=[];
 const add=(id,state)=>checks.push({id,state});
 const check=(key,id,fn)=>{
  const r=raw[paths[key]];
  if(!r||r.status===403||![200,404].includes(r.status))return add(id,'Unknown');
  if(r.status===404)return add(id,'Missing');
  try{return add(id,r.body?.metadata?.deletionTimestamp?'Unsafe':fn(r.body));}catch{return add(id,'Unknown');}
 };
 check('server','InternalService',v=>v.kind==='Service'&&v.spec?.type==='ClusterIP'&&
   !v.spec?.externalIPs?.length?'Pass':'Unsafe');
 check('network','ServerIngress',serverIngress);
 check('config','InitialAdminDisabled',v=>v.kind==='ConfigMap'&&v.data?.['admin.enabled']==='false'?'Pass':'Unsafe');
 check('params','AuthRequired',v=>v.kind==='ConfigMap'&&v.data?.['server.disable.auth']==='false'?'Pass':'Unsafe');
 check('ingress','NoPublicIngress',v=>v.kind==='IngressList'&&Array.isArray(v.items)&&!v.metadata?.continue
   ?v.items.length?'Unsafe':'Pass':'Unknown');
 check('controller','ControllerAuthority',v=>reviewedAuthority(v,'ClusterRole','argocd-application-controller'));
 check('controllerRole','ControllerNamespaceAuthority',v=>reviewedAuthority(v,'Role','argocd-application-controller'));
 check('controllerBinding','ControllerBinding',v=>binding(v,'ClusterRoleBinding','argocd-application-controller','ClusterRole','argocd-application-controller'));
 check('controllerRoleBinding','ControllerNamespaceBinding',v=>binding(v,'RoleBinding','argocd-application-controller','Role','argocd-application-controller'));
 check('applicationSet','ApplicationSetAuthority',v=>reviewedAuthority(v,'ClusterRole','argocd-applicationset-controller'));
 check('applicationSetRole','ApplicationSetNamespaceAuthority',v=>reviewedAuthority(v,'Role','argocd-applicationset-controller'));
 check('applicationSetBinding','ApplicationSetBinding',v=>binding(v,'ClusterRoleBinding','argocd-applicationset-controller','ClusterRole','argocd-applicationset-controller'));
 check('applicationSetRoleBinding','ApplicationSetNamespaceBinding',v=>binding(v,'RoleBinding','argocd-applicationset-controller','Role','argocd-applicationset-controller'));
 check('serverClusterRole','ServerClusterAuthority',v=>reviewedAuthority(v,'ClusterRole','argocd-server'));
 check('serverRole','ServerNamespaceAuthority',v=>reviewedAuthority(v,'Role','argocd-server'));
 check('serverBinding','ServerClusterBinding',v=>binding(v,'ClusterRoleBinding','argocd-server','ClusterRole','argocd-server'));
 check('serverRoleBinding','ServerNamespaceBinding',v=>binding(v,'RoleBinding','argocd-server','Role','argocd-server'));
 check('projects','DedicatedProject',dedicatedProject);
 check('deliveryPolicy','FirstDeliveryAdmissionPolicy',v=>reviewedDeliveryAdmission(v,'ValidatingAdmissionPolicy'));
 check('deliveryBinding','FirstDeliveryAdmissionBinding',v=>reviewedDeliveryAdmission(v,'ValidatingAdmissionPolicyBinding'));
 check('deliveryProjectPolicy','FirstDeliveryProjectAdmissionPolicy',v=>reviewedDeliveryAdmission(v,'ValidatingAdmissionPolicy','opensphere-psss-first-delivery-projects'));
 check('deliveryProjectBinding','FirstDeliveryProjectAdmissionBinding',v=>reviewedDeliveryAdmission(v,'ValidatingAdmissionPolicyBinding','opensphere-psss-first-delivery-projects'));
 const state=coreState!=='Ready'?'CoreIncomplete'
   :checks.some(row=>row.state==='Unsafe')?'Blocked'
   :checks.some(row=>row.state==='Unknown')?'Unknown'
   :checks.some(row=>row.state==='Missing')?'NeedsPolicy':'ReviewRequired';
 // Passing these observations alone cannot prove repository scope, rendered
 // manifest safety, or the maintained admin recovery path.
 return {schema:'opensphere.argocd-delivery-security/v1',state,checks,
  firstDeliveryReady:false,firstDeliveryComplete:false};
}
module.exports={paths,assess,dedicatedProject,demoObservationProject,serverIngress,privilegedAuthority,reviewedAuthority,reviewedDeliveryAdmission,binding};
