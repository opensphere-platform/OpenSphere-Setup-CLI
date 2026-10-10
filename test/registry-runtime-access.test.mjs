import test from 'node:test';
import assert from 'node:assert/strict';
import {registryKubernetesEgress,discoverRegistryKubernetesEgress,renderRegistryKubernetesEgress,KUBERNETES_EGRESS_SLOT,discoverKubernetesApiCiliumPolicy,KUBERNETES_API_CILIUM_POLICIES} from '../src/registry-runtime-access.mjs';
const service=()=>({metadata:{name:'kubernetes',namespace:'default'},spec:{clusterIPs:['10.96.0.1'],ports:[{name:'https',protocol:'TCP',port:443,targetPort:6443}]}});
const slices=()=>({items:[{metadata:{namespace:'default',labels:{'kubernetes.io/service-name':'kubernetes'}},addressType:'IPv4',ports:[{name:'https',port:6443}],endpoints:[{addresses:['172.18.0.3'],conditions:{ready:true}}]}]});
const definition={metadata:{name:'ciliumnetworkpolicies.cilium.io'},spec:{group:'cilium.io',names:{kind:'CiliumNetworkPolicy'}}};
const CONSOLE_API='apps/console-api/deploy.yaml',OS_SHELL='apps/os-shell-control/deploy.yaml';

test('Cilium API access selects only Console API and the discovered HTTPS ports',()=>{
  const rules=registryKubernetesEgress(service(),slices());
  assert.equal(discoverKubernetesApiCiliumPolicy(CONSOLE_API,rules,()=>''),'');
  const policy=JSON.parse(discoverKubernetesApiCiliumPolicy(CONSOLE_API,rules,()=>JSON.stringify(definition)).split('---\n')[1]);
  assert.equal(policy.metadata.namespace,'opensphere-console');
  assert.deepEqual(policy.spec,{endpointSelector:{matchLabels:{'app.kubernetes.io/name':'opensphere-console-api'}},
    egress:[{toEntities:['kube-apiserver'],toPorts:[{ports:[{port:'443',protocol:'TCP'},{port:'6443',protocol:'TCP'}]}]}]});
  assert.throws(()=>discoverKubernetesApiCiliumPolicy(CONSOLE_API,[{to:[{ipBlock:{cidr:'0.0.0.0/0'}}],ports:[{protocol:'TCP',port:443}]}],()=>JSON.stringify(definition)),/valid/);
  assert.throws(()=>discoverKubernetesApiCiliumPolicy(CONSOLE_API,rules,()=>'{"metadata":{}}'),/Unexpected/);
});

test('Console API Cilium policy bytes are unchanged by the per-manifest generalisation',()=>{
  // Output of discoverConsoleApiCiliumPolicy at Setup 07101a0 for these rules (live on RKE2 with the same spec).
  const rules=['10.43.0.1/32:443','10.10.1.31/32:6443','10.10.1.32/32:6443'].map(target=>{
    const [cidr,port]=target.split(':');return {to:[{ipBlock:{cidr}}],ports:[{protocol:'TCP',port:Number(port)}]};});
  assert.equal(discoverKubernetesApiCiliumPolicy(CONSOLE_API,rules,()=>JSON.stringify(definition)),
    '\n---\n{"apiVersion":"cilium.io/v2","kind":"CiliumNetworkPolicy","metadata":{"name":"opensphere-console-api-kubernetes-egress",'
    +'"namespace":"opensphere-console","labels":{"app.kubernetes.io/part-of":"opensphere-console","app.kubernetes.io/managed-by":"opensphere-setup"}},'
    +'"spec":{"endpointSelector":{"matchLabels":{"app.kubernetes.io/name":"opensphere-console-api"}},"egress":[{"toEntities":["kube-apiserver"],'
    +'"toPorts":[{"ports":[{"port":"443","protocol":"TCP"},{"port":"6443","protocol":"TCP"}]}]}]}}\n');
});

test('OS Shell API gets its own Cilium policy; every other manifest gets none without a cluster read',()=>{
  const rules=registryKubernetesEgress(service(),slices());
  const policy=JSON.parse(discoverKubernetesApiCiliumPolicy(OS_SHELL,rules,()=>JSON.stringify(definition)).split('---\n')[1]);
  assert.deepEqual(policy.metadata,{name:'opensphere-shell-api-kubernetes-egress',namespace:'opensphere-console',
    labels:{'app.kubernetes.io/part-of':'opensphere-console','app.kubernetes.io/managed-by':'opensphere-setup'}});
  assert.deepEqual(policy.spec,{endpointSelector:{matchLabels:{app:'opensphere-shell-api'}},
    egress:[{toEntities:['kube-apiserver'],toPorts:[{ports:[{port:'443',protocol:'TCP'},{port:'6443',protocol:'TCP'}]}]}]});
  assert.equal(discoverKubernetesApiCiliumPolicy(OS_SHELL,rules,()=>''),'','no Cilium policy API, no document');
  assert.deepEqual(Object.keys(KUBERNETES_API_CILIUM_POLICIES).sort(),[CONSOLE_API,OS_SHELL]);
  for(const path of ['apps/extension-controller/deploy.yaml','apps/osaa-gateway/deploy.yaml','constructor','__proto__','toString']){
    assert.equal(discoverKubernetesApiCiliumPolicy(path,rules,()=>assert.fail('no cluster read')),'',path);
  }
});

test('API egress contains exact Service and ready endpoint addresses, including HA and IPv6',()=>{
 const svc=service(), list=slices();
 svc.spec.clusterIPs.push('fd00::1');
 list.items[0].endpoints.push({addresses:['172.18.0.4']},{addresses:['172.18.0.5'],conditions:{ready:false}},{addresses:['172.18.0.6'],conditions:{terminating:true}});
 list.items.push({...structuredClone(list.items[0]),addressType:'IPv6',endpoints:[{addresses:['fd00::3']}],ports:[{name:'https',port:7443}]});
 const rules=registryKubernetesEgress(svc,list);
 assert.deepEqual(rules.map(r=>[r.to[0].ipBlock.cidr,r.ports[0].port]),[['10.96.0.1/32',443],['172.18.0.3/32',6443],['172.18.0.4/32',6443],['fd00::1/128',443],['fd00::3/128',7443]]);
});

test('API discovery reads only default/kubernetes and its EndpointSlices',()=>{
 const calls=[];
 const rules=discoverRegistryKubernetesEgress((args,options)=>{calls.push({args,options});return JSON.stringify(calls.length===1?service():slices());});
 assert.equal(rules.length,2);
 assert.deepEqual(calls.map(c=>c.args),[
 ['-n','default','get','service','kubernetes','-o','json'],
 ['-n','default','get','endpointslices.discovery.k8s.io','-l','kubernetes.io/service-name=kubernetes','-o','json']]);
 assert(calls.every(c=>c.options.capture===true));
});

test('missing, malformed, non-HTTPS or unrelated endpoints fail closed',()=>{
 const mutations=[
  (s,l)=>{l.items=[];}, (s,l)=>{l.items[0].endpoints=[];},
  (s,l)=>{l.items[0].endpoints[0].conditions.ready=false;},
  (s,l)=>{l.items[0].metadata.labels['kubernetes.io/service-name']='unrelated';},
  (s,l)=>{l.items[0].ports[0].port=0;}, (s,l)=>{l.items[0].ports[0].name='http';},
  (s,l)=>{l.items[0].endpoints[0].addresses=['0.0.0.0/0'];},
  (s,l)=>{l.items[0].endpoints[0].addresses=['127.0.0.1'];},
  (s,l)=>{l.items[0].endpoints[0].addresses=['https://example.com'];},
  (s,l)=>{s.metadata.namespace='other';}, (s,l)=>{s.spec.clusterIPs=['None'];},
 ];
 for(const mutate of mutations){const s=service(),l=slices();mutate(s,l);assert.throws(()=>registryKubernetesEgress(s,l),/Registry Kubernetes egress/);}
});

test('rendering requires discovery and refuses widened rules or duplicate template slots',()=>{
 const source=`  egress:\n    - ${KUBERNETES_EGRESS_SLOT}\n`;
 const rules=registryKubernetesEgress(service(),slices());
 const rendered=renderRegistryKubernetesEgress(source,rules);
 assert(!rendered.includes('__OPENSPHERE_'));
 assert.match(rendered,/172.18.0.3\/32/);
 for(const invalid of [undefined,[],[{ports:[{protocol:'TCP',port:6443}]}],[{to:[{ipBlock:{cidr:'0.0.0.0/0'}}],ports:[{protocol:'TCP',port:6443}]}]]) {
  assert.throws(()=>renderRegistryKubernetesEgress(source,invalid),/Registry Kubernetes egress/);
 }
 assert.throws(()=>renderRegistryKubernetesEgress(source+source,rules),/Registry Kubernetes egress/);
 assert.equal(renderRegistryKubernetesEgress('legacy manifest'), 'legacy manifest');
});
