'use strict';
// The upstream-pinned payload stays byte-for-byte in contracts/. These exact
// local policy changes are materialized into the owner artifact revision.
const source=require('../contracts/argocd-core.bundle.json');
const {createHash}=require('node:crypto');
const {ACCOUNT,psssPeer}=require('./argocd-observer-policy.cjs');
const policyId='opensphere.argocd-core-policy/v3';
const upstreamSha256='69114b8c9eb48a1d08598e6f654a0869b10ae902456ea4b70796cb563760f5ec';
const sourceBundleSha256='ca5b9adbefd7efed7dea66d9fc4f0de2aaa382f5adf28e8824097a0e2a376f37';
const sources=['argocd-applicationset-controller','argocd-dex-server','argocd-notifications-controller'];
function ordered(value){return Array.isArray(value)?value.map(ordered):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;}
const digest=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
function target(runtime,kind,name){
  const rows=runtime.filter(row=>row.kind===kind&&row.metadata?.name===name&&
    (row.metadata.namespace||null)===(kind==='ClusterRole'?null:'argocd'));
  if(rows.length!==1)throw Error(`Pinned Argo resource missing or duplicated: ${kind}/${name}`);
  return rows[0];
}
function materialize(base=source,{observer=true}={}){
  if(base.schema!=='opensphere.argocd-core-bundle/v1'||base.version!=='3.4.2'||
    base.source?.commit!=='0dc6b1b57dd5bb925d5b03c3d09419ab9fb4225e'||
    base.source.sha256!==upstreamSha256||digest(base)!==sourceBundleSha256||!Array.isArray(base.runtime))
    throw Error('Unrecognized pinned Argo source');
  const result=structuredClone(base),runtime=result.runtime;
  const config=target(runtime,'ConfigMap','argocd-cm');
  config.data={...config.data,'admin.enabled':'false','resource.respectRBAC':'normal'};
  const params=target(runtime,'ConfigMap','argocd-cmd-params-cm');
  params.data={...params.data,'server.disable.auth':'false'};
  const server=target(runtime,'Service','argocd-server');
  server.spec.type='ClusterIP';
  const network=target(runtime,'NetworkPolicy','argocd-server-network-policy');
  network.spec.ingress=[{from:sources.map(name=>({
    namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':'argocd'}},
    podSelector:{matchLabels:{'app.kubernetes.io/name':name}},
  })),ports:[{protocol:'TCP',port:8080}]}];
  if(observer){
    config.data['accounts.'+ACCOUNT]='apiKey';
    config.data['accounts.'+ACCOUNT+'.enabled']='true';
    const rbac=target(runtime,'ConfigMap','argocd-rbac-cm');
    rbac.data={'policy.default':'role:opensphere-no-default-permissions','policy.matchMode':'glob','policy.csv':''};
    network.spec.ingress[0].from.push(psssPeer());
  }
  const prerequisites=result.prerequisites;
  const rule=(apiGroups,resources,verbs)=>({apiGroups,resources,verbs});
  // The controller receives only discovery of namespaces at cluster scope.
  // A reviewed first-delivery action must grant target-namespace writes later.
  for(const name of ['argocd-application-controller','argocd-applicationset-controller','argocd-server'])
    target(prerequisites,'ClusterRole',name).rules=[rule([''],['namespaces'],['get','list','watch'])];
  target(prerequisites,'Role','argocd-application-controller').rules=[
    rule([''],['secrets','configmaps'],['get','list','watch']),
    rule(['argoproj.io'],['applications','applicationsets','appprojects'],['get','list','watch']),
    rule(['argoproj.io'],['applications/status','applications/finalizers'],['get','patch','update']),
    rule([''],['events'],['create','list']),
    rule(['apps'],['deployments'],['get','list','watch']),
  ];
  target(prerequisites,'Role','argocd-applicationset-controller').rules=[
    rule(['argoproj.io'],['applications','applicationsets','appprojects'],['get','list','watch']),
    rule(['argoproj.io'],['applicationsets/status','applicationsets/finalizers'],['get','patch','update']),
    rule([''],['events'],['create','get','list','patch','watch']),
    rule([''],['secrets','configmaps'],['get','list','watch']),
    rule(['coordination.k8s.io'],['leases'],['create']),
    {apiGroups:['coordination.k8s.io'],resources:['leases'],resourceNames:['58ac56fa.applicationsets.argoproj.io'],verbs:['get','update','create']},
  ];
  target(prerequisites,'Role','argocd-server').rules=[
    rule([''],['secrets','configmaps'],['get','list','watch']),
    rule(['argoproj.io'],['applications','appprojects','applicationsets'],['get','list','watch']),
    rule([''],['events'],['create','list']),
  ];
  result.policy={schema:observer?policyId:'opensphere.argocd-core-policy/v2',changes:[
    'disable-initial-admin','require-server-auth','internal-service-only','restrict-server-ingress',
    'respect-kubernetes-rbac','remove-cluster-write','restrict-control-plane-writes',
    ...(observer?['setup-owned-signing-credentials','private-observer-peer','explicit-observer-default-deny']:[]),
  ]};
  return result;
}
module.exports={materialize,policyId};
