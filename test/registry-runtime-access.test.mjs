import test from 'node:test';
import assert from 'node:assert/strict';
import {registryKubernetesEgress,discoverRegistryKubernetesEgress,renderRegistryKubernetesEgress,KUBERNETES_EGRESS_SLOT} from '../src/registry-runtime-access.mjs';
const service=()=>({metadata:{name:'kubernetes',namespace:'default'},spec:{clusterIPs:['10.96.0.1'],ports:[{name:'https',protocol:'TCP',port:443,targetPort:6443}]}});
const slices=()=>({items:[{metadata:{namespace:'default',labels:{'kubernetes.io/service-name':'kubernetes'}},addressType:'IPv4',ports:[{name:'https',port:6443}],endpoints:[{addresses:['172.18.0.3'],conditions:{ready:true}}]}]});

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