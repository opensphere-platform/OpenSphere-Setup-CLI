'use strict';
// C_EXT-only comparison. Keep every field unless it is an exact Kubernetes
// default or the bounded standard service-account injection described below.
const fail=()=>{throw Error('ControllerTemplateMismatch');};
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const json=v=>JSON.stringify(stable(v));
function normalize(template,{pod=false,approved}={}){
 const t=structuredClone(template);if(!t?.spec)fail();const s=t.spec;
 if(t.metadata?.labels)delete t.metadata.labels['pod-template-hash'];
 const remove=(o,k,v)=>{if(o&&o[k]===v)delete o[k];};
 remove(t.metadata,'creationTimestamp',null);
 for(const[k,v]of Object.entries({restartPolicy:'Always',dnsPolicy:'ClusterFirst',schedulerName:'default-scheduler',terminationGracePeriodSeconds:30,enableServiceLinks:true}))remove(s,k,v);
 remove(s,'serviceAccount',s.serviceAccountName);
 for(const c of [...(s.containers||[]),...(s.initContainers||[])]){
  remove(c,'terminationMessagePath','/dev/termination-log');remove(c,'terminationMessagePolicy','File');
  for(const p of c.ports||[])remove(p,'protocol','TCP');
  for(const e of c.env||[])remove(e.valueFrom?.fieldRef,'apiVersion','v1');
  for(const k of ['livenessProbe','readinessProbe','startupProbe']){
   for(const[f,v]of Object.entries({timeoutSeconds:1,periodSeconds:10,successThreshold:1,failureThreshold:3}))remove(c[k],f,v);
   remove(c[k]?.httpGet,'scheme','HTTP');
  }
 }
 for(const v of s.volumes||[]){remove(v.secret,'defaultMode',420);remove(v.configMap,'defaultMode',420);remove(v.projected,'defaultMode',420);}
 if(pod){
  if(approved?.spec?.nodeName&&s.nodeName!==approved.spec.nodeName)fail();delete s.nodeName;
  const approvedVolumes=new Set((approved?.spec?.volumes||[]).map(v=>v.name));
  const additions=(s.volumes||[]).filter(v=>!approvedVolumes.has(v.name)&&/^kube-api-access-[a-z0-9]{5}$/.test(v.name||''));
  if(additions.length){
   if(additions.length!==1||approved?.spec?.automountServiceAccountToken!==true)fail();
   const v=additions[0],p=v.projected;if(Object.keys(v).some(k=>!['name','projected'].includes(k))||!p||Object.keys(p).some(k=>k!=='sources'))fail();
   const sources=p.sources;if(!Array.isArray(sources)||sources.length!==3)fail();
   const token=sources[0]?.serviceAccountToken;
   if(Object.keys(sources[0]||{}).length!==1||!token||Object.keys(token).some(k=>!['expirationSeconds','path'].includes(k))
    ||![3600,3607].includes(token.expirationSeconds)||token.path!=='token'
    ||json(sources[1])!==json({configMap:{name:'kube-root-ca.crt',items:[{key:'ca.crt',path:'ca.crt'}]}})
    ||json(sources[2])!==json({downwardAPI:{items:[{path:'namespace',fieldRef:{apiVersion:'v1',fieldPath:'metadata.namespace'}}]}}))fail();
   for(const c of [...(s.containers||[]),...(s.initContainers||[])]){
    const matches=(c.volumeMounts||[]).filter(m=>m.name===v.name);
    if(matches.length!==1||json(matches[0])!==json({name:v.name,mountPath:'/var/run/secrets/kubernetes.io/serviceaccount',readOnly:true}))fail();
    c.volumeMounts=c.volumeMounts.filter(m=>m.name!==v.name);if(!c.volumeMounts.length)delete c.volumeMounts;
   }
   s.volumes=s.volumes.filter(x=>x!==v);if(!s.volumes.length)delete s.volumes;
  }
  // Kubernetes adds exactly these two NoExecute tolerations; arbitrary admission
  // tolerations, sidecars, projected tokens, mounts and security fields remain compared.
  s.tolerations=(s.tolerations||[]).filter(x=>!['node.kubernetes.io/not-ready','node.kubernetes.io/unreachable'].some(key=>
   json(x)===json({key,operator:'Exists',effect:'NoExecute',tolerationSeconds:300})));
  if(!s.tolerations.length)delete s.tolerations;
 }
 return t;
}
function controllerTemplateMatches(observed,approved,{pod=false}={}){
 try{
  const a=normalize(approved),o=normalize(observed,{pod,approved});
  if(pod){a.spec.tolerations=(a.spec.tolerations||[]).filter(x=>!['node.kubernetes.io/not-ready','node.kubernetes.io/unreachable'].some(key=>json(x)===json({key,operator:'Exists',effect:'NoExecute',tolerationSeconds:300})));
   if(!a.spec.tolerations.length)delete a.spec.tolerations;
   delete a.spec.nodeName;
   // Pod metadata contains scheduling/ownership observations; only the spec is
   // compared here. Workload authentication independently binds Pod/RS identity.
   return json(o.spec)===json(a.spec);
  }
  return json(o)===json(a);
 }catch{return false;}
}
module.exports={controllerTemplateMatches};
