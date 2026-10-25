// Synthetic Kubernetes/HTTP I/O; the producer-loader test executes exact
// governed source in an isolated public filesystem view. None is RKE2 proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {NATIVE_OFFICIAL_SKILL_PROBE,nativeGatewayReadinessEvidence,verifyNativeOfficialSkills} from '../src/native-official-skills-verification.mjs';
import {COMPONENTS,AUXILIARY_ARTIFACTS,SOURCE,RELEASE_API_VERSION,LOCAL_EDGE_TRUST,calculateReleaseDigest} from '../src/release.mjs';
const NS='opensphere-console',NAME='opensphere-console-osaa-gateway',DIGEST='sha256:da9f1fd9588047bed81203a721c8f14080459966d24488ba41fff5f74d7acd38';
const nativeReady=()=>({ready:true,components:{reviewedPolicy:true,requestJournal:true},reason:'native-core-ready'});
const image=name=>'ghcr.io/opensphere-platform/'+name+'@sha256:'+'a'.repeat(64);
const report=()=>({manifestSha256:DIGEST,shipped:3,valid:3,invalid:[],skills:[{skillId:'module-installation',revision:1},{skillId:'module-product-lifecycle',revision:6},{skillId:'personal-memory',revision:2}]});
const loaders=()=>['official-skills.cjs','skill-binding.cjs','module-skills.cjs'].map(name=>({name,sha256:'f'.repeat(64)}));
const output=()=>({schema:'opensphere.native-official-skills-probe/v1',origin:'installed-official-skill-loader',loaders:loaders(),report:report()});
function fixture(){
 const source='b'.repeat(40),components=Object.fromEntries(Object.entries(COMPONENTS).map(([id,name])=>[id,{repository:name,image:image(name),sourceRevision:source,artifactVersion:'26.1025.1904.87'}]));
 components.osaaGateway.officialSkills=DIGEST;
 const auxiliaryArtifacts=Object.fromEntries(Object.entries(AUXILIARY_ARTIFACTS).map(([id,name])=>[id,{repository:name,image:image(name),sourceRevision:source,artifactVersion:'26.1025.1904.87'}]));
 const lock={apiVersion:RELEASE_API_VERSION,kind:'OpenSphereReleaseLock',source:SOURCE,sourceRevision:source,channel:'edge',trust:LOCAL_EDGE_TRUST,components,auxiliaryArtifacts};
 lock.releaseDigest=calculateReleaseDigest('edge',components,LOCAL_EDGE_TRUST,undefined,{auxiliaryArtifacts});
 const spec={securityContext:{runAsNonRoot:true,runAsUser:1000,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'gateway',image:components.osaaGateway.image,ports:[{name:'http',containerPort:8080}],securityContext:{readOnlyRootFilesystem:true,allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}},volumeMounts:[{name:'tmp',mountPath:'/tmp'}],env:[
  {name:'R2D2_BACKEND',value:'openclaw-native'},{name:'R2D2_NATIVE_GATEWAY_IMAGE',value:components.r2d2OpenClawGateway.image},{name:'R2D2_NATIVE_BRIDGE_IMAGE',value:components.osaaGateway.image}]}]};
 const meta=(name,uid)=>({namespace:NS,name,uid,resourceVersion:'10'});
 const deployment={apiVersion:'apps/v1',kind:'Deployment',metadata:{...meta(NAME,'deployment-uid'),generation:4},spec:{replicas:2,selector:{matchLabels:{app:NAME}},template:{spec:structuredClone(spec)}},status:{observedGeneration:4,updatedReplicas:2,availableReplicas:2}};
 const rs={apiVersion:'apps/v1',kind:'ReplicaSet',metadata:{...meta(NAME+'-rs','rs-uid'),ownerReferences:[{controller:true,apiVersion:'apps/v1',kind:'Deployment',uid:deployment.metadata.uid}]},spec:{replicas:2,template:{spec:structuredClone(spec)}},status:{replicas:2}};
 const pods=[0,1].map(i=>({apiVersion:'v1',kind:'Pod',metadata:{...meta(NAME+'-'+i,'pod-uid-'+i),labels:{app:NAME},ownerReferences:[{controller:true,apiVersion:'apps/v1',kind:'ReplicaSet',uid:rs.metadata.uid}]},spec:structuredClone(spec),status:{podIP:'10.22.0.'+(i+2),phase:'Running',conditions:[{type:'Ready',status:'True'}],containerStatuses:[{name:'gateway',ready:true,imageID:components.osaaGateway.image,state:{running:{startedAt:'2026-10-25T00:00:00Z'}}}]}}));
 const service={apiVersion:'v1',kind:'Service',metadata:meta(NAME,'service-uid'),spec:{selector:{app:NAME},ports:[{name:'http',port:8080,targetPort:'http'}]}};
 const slices={items:[{apiVersion:'discovery.k8s.io/v1',kind:'EndpointSlice',metadata:{...meta('slice','slice-uid'),labels:{'kubernetes.io/service-name':NAME},ownerReferences:[{controller:true,kind:'Service',uid:service.metadata.uid}]},ports:[{name:'http',port:8080}],endpoints:pods.map(p=>({conditions:{ready:true},addresses:[p.status.podIP],targetRef:{kind:'Pod',namespace:NS,name:p.metadata.name,uid:p.metadata.uid}}))}]};
 const f={lock,service,deployment,slices,sets:{items:[rs]},pods:{items:pods},calls:[],reads:0,probes:0,http:0,ready:nativeReady(),status:200,output:output()};
 f.query=(args,options)=>{
  f.calls.push(args);assert.equal(options.capture,true);assert.equal(options.spawn.timeout,15000);
  if(args[2]==='get'){
   if(args[3]==='service')return JSON.stringify(f.service);
   if(args[3]==='endpointslices.discovery.k8s.io')return JSON.stringify(f.slices);
   if(args[3]==='deployment'){f.reads++;f.onRead?.(f.reads);return JSON.stringify(f.deployment);}
   if(args[3]==='replicasets')return JSON.stringify(f.sets);if(args[3]==='pods')return JSON.stringify(f.pods);throw Error('Unexpected observation');
  }
  assert.deepEqual(args,['-n',NS,'exec',pods[f.probes].metadata.name,'-c','gateway','--','/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','-e',NATIVE_OFFICIAL_SKILL_PROBE]);
  assert.equal(options.spawn.maxBuffer,65536);f.probes++;return f.probeRaw?.(f.probes)??JSON.stringify(f.output);
 };
 f.withService=async(ns,name,port,operation)=>{assert.deepEqual([ns,name,port],[NS,NAME,8080]);return operation('http://127.0.0.1:1');};
 f.fetchImpl=async(url,options)=>{f.http++;assert.equal(url,'http://127.0.0.1:1/readyz');assert.equal(options.redirect,'error');return new Response(f.httpRaw??JSON.stringify(f.ready),{status:f.status});};
 f.verify=()=>verifyNativeOfficialSkills(f.lock,{query:f.query,withService:f.withService,fetchImpl:f.fetchImpl});return f;
}
test('native metadata readiness and exact installed Skill files are verified independently for every current replica',async()=>{
 const f=fixture(),before=structuredClone({deployment:f.deployment,pods:f.pods,sets:f.sets}),value=await f.verify();
 assert.equal(value.origin,'installed-official-skill-loader');assert.equal(value.state,'Verified');assert.equal(value.manifestSha256,DIGEST);assert.equal(value.valid,3);
 assert.equal(value.service,undefined);assert.equal(value.pods.length,2);assert.equal(f.probes,2);assert.equal(f.http,1);assert.equal(f.reads,2);
 assert.deepEqual({deployment:f.deployment,pods:f.pods,sets:f.sets},before);assert.ok(f.calls.every(args=>['get','exec'].includes(args[2])));
});
for(const [name,change]of [
 ['HTTP503',f=>{f.status=503;}],['nativefalse',f=>{f.ready.ready=false;}],['componentfalse',f=>{f.ready.components.requestJournal=false;}],
 ['unknownreason',f=>{f.ready.reason='other';}],['legacyenvelope',f=>{f.ready={service:NAME,officialSkills:report()};}],
 ['extrareadyfield',f=>{f.ready.verified=true;}],['extracomponent',f=>{f.ready.components.admin=true;}],['HTML',f=>{f.httpRaw='<html>'; }],['hugebody',f=>{f.httpRaw='x'.repeat(65537);}],
])test('native HTTP evidence refuses '+name+' before invoking any installed loader',async()=>{const f=fixture();change(f);await assert.rejects(f.verify());assert.equal(f.probes,0);});
for(const [name,change]of [
 ['absentnativecomponent',f=>{delete f.lock.components.r2d2OpenClawGateway;f.lock.native=true;}],
 ['Hermescomponent',f=>{f.lock.components.r2d2HermesWorker={...f.lock.components.osaaGateway};}],
 ['absentdeclaration',f=>{delete f.lock.components.osaaGateway.officialSkills;}],
 ['wrongdeployment',f=>{f.deployment.metadata.name='foreign';}],['incompletePodlist',f=>{f.pods.metadata={continue:'more'};}],['incompleteRSlist',f=>{f.sets.metadata={continue:'more'};}],
 ['foreignServiceselector',f=>{f.service.spec.selector={app:'foreign'};}],['foreignServiceport',f=>{f.service.spec.ports[0].targetPort=7777;}],
 ['foreignEndpointPod',f=>{f.slices.items[0].endpoints[0].targetRef.uid='foreign';}],['foreignEndpointIP',f=>{f.slices.items[0].endpoints[0].addresses=['10.0.0.99'];}],['foreignEndpointService',f=>{f.slices.items[0].metadata.ownerReferences[0].uid='foreign';}],
 ['foreignRS',f=>{f.sets.items[0].metadata.ownerReferences[0].uid='other';}],['foreignPod',f=>{f.pods.items[0].metadata.ownerReferences[0].uid='other';}],
 ['wrongimage',f=>{f.pods.items[0].spec.containers[0].image=image('unrelated');}],['wrongimageID',f=>{f.pods.items[0].status.containerStatuses[0].imageID=image('unrelated');}],
 ['missingreplica',f=>{f.pods.items.pop();}],['extrareplica',f=>{f.pods.items.push(structuredClone(f.pods.items[0]));}],['unreadyreplica',f=>{f.pods.items[0].status.conditions[0].status='False';}],
 ['sidecar',f=>{f.pods.items[0].spec.containers.push({name:'other'});}],['initinjection',f=>{f.pods.items[0].spec.initContainers=[{name:'other'}];}],['ephemeralinjection',f=>{f.pods.items[0].spec.ephemeralContainers=[{name:'other'}];}],
 ['writablefilesystem',f=>{f.pods.items[0].spec.containers[0].securityContext.readOnlyRootFilesystem=false;}],
 ['privileged',f=>{f.pods.items[0].spec.containers[0].securityContext.privileged=true;}],['escalation',f=>{f.pods.items[0].spec.containers[0].securityContext.allowPrivilegeEscalation=true;}],
 ['addedcapability',f=>{f.pods.items[0].spec.containers[0].securityContext.capabilities.add=['SYS_ADMIN'];}],['missingcapdrop',f=>{f.pods.items[0].spec.containers[0].securityContext.capabilities.drop=[];}],
 ['hostPID',f=>{f.pods.items[0].spec.hostPID=true;}],['hostIPC',f=>{f.pods.items[0].spec.hostIPC=true;}],['hostNetwork',f=>{f.pods.items[0].spec.hostNetwork=true;}],
 ['rootidentity',f=>{f.pods.items[0].spec.securityContext.runAsUser=0;}],
 ['unconfinedseccomp',f=>{f.pods.items[0].spec.securityContext.seccompProfile.type='Unconfined';}],
 ['commandoverride',f=>{f.pods.items[0].spec.containers[0].command=['node','evil.js'];}],['argsoverride',f=>{f.pods.items[0].spec.containers[0].args=['evil.js'];}],
 ['envFromoverride',f=>{f.pods.items[0].spec.containers[0].envFrom=[{secretRef:{name:'other'}}];}],
 ['Nodepreload',f=>{f.pods.items[0].spec.containers[0].env.push({name:'NODE_OPTIONS',value:'--require=/tmp/other.js'});}],
 ['loaderpreload',f=>{f.pods.items[0].spec.containers[0].env.push({name:'LD_PRELOAD',value:'/tmp/other.so'});}],
 ['appoverlay',f=>{f.pods.items[0].spec.containers[0].volumeMounts.push({mountPath:'/app/skills'});}],
 ['binaryoverlay',f=>{f.pods.items[0].spec.containers[0].volumeMounts.push({mountPath:'/usr/local'});}],
 ['busyboxoverlay',f=>{f.pods.items[0].spec.containers[0].volumeMounts.push({mountPath:'/bin'});}],['ldconfigoverlay',f=>{f.pods.items[0].spec.containers[0].volumeMounts.push({mountPath:'/etc/ld.so.preload'});}],['lib64overlay',f=>{f.pods.items[0].spec.containers[0].volumeMounts.push({mountPath:'/lib64'});}],
 ['rootmount',f=>{f.pods.items[0].spec.containers[0].volumeMounts.push({mountPath:'/'});}],
 ['Hermesenv',f=>{f.pods.items[0].spec.containers[0].env.push({name:'R2D2_HERMES_ENABLED',value:'true'});}],
 ['wrongbackend',f=>{f.pods.items[0].spec.containers[0].env[0].value='legacy';}],
])test('native evidence refuses '+name+' without executing the loader',async()=>{const f=fixture();change(f);await assert.rejects(f.verify());assert.equal(f.probes,0);});
for(const [name,change]of [
 ['wrongdigest',o=>{o.report.manifestSha256='sha256:'+'d'.repeat(64);}],['badfile',o=>{o.report.valid=2;o.report.invalid=[{skillId:'personal-memory',reason:'content-mismatch'}];}],
 ['missingreport',o=>{delete o.report;}],['extrafield',o=>{o.service=NAME;}],['badloaderhash',o=>{o.loaders[0].sha256='short';}],['reorderedloaders',o=>{o.loaders.reverse();}],
 ['duplicateskill',o=>{o.report.skills[1]={...o.report.skills[0]};}],['unknownreportfield',o=>{o.report.verified=true;}],
])test('native probe evidence refuses '+name,async()=>{const f=fixture();change(f.output);await assert.rejects(f.verify());});
test('every replica must agree about loader bytes and reported Skill inventory',async()=>{
 const f=fixture();f.probeRaw=n=>{const value=output();if(n===2)value.loaders[0].sha256='e'.repeat(64);return JSON.stringify(value);};await assert.rejects(f.verify(),/replicas disagree/);
 const huge=fixture();huge.probeRaw=()=>'{'.repeat(65537);await assert.rejects(huge.verify(),/exceeds budget/);
});
for(const [name,change]of [['PodUID',f=>{f.pods.items[0].metadata.uid='replacement';}],['PodRV',f=>{f.pods.items[0].metadata.resourceVersion='new';}],['image',f=>{f.pods.items[0].spec.containers[0].image=image('other');}],['DeploymentUID',f=>{f.deployment.metadata.uid='new';}],['RSUID',f=>{f.sets.items[0].metadata.uid='new';}],['ServiceUID',f=>{f.service.metadata.uid='new';}],['EndpointUID',f=>{f.slices.items[0].metadata.uid='new';}]])test('probe race refuses changed '+name,async()=>{const f=fixture();f.probeRaw=n=>{if(n===2)change(f);return JSON.stringify(f.output);};await assert.rejects(f.verify());assert.equal(f.probes,2);});
test('the existing legacy validator body and native choice remain explicit and cannot be selected by a response hint',()=>{
 const source=readFileSync(new URL('../src/verify.mjs',import.meta.url),'utf8');assert.match(source,/lock\.components\?\.r2d2OpenClawGateway\s*\?await verifyNativeOfficialSkills\(lock,\{withService\}\)\s*:await verifyOfficialSkills/);
 assert.throws(()=>nativeGatewayReadinessEvidence({native:true,ready:true},200));
});

// Execute exact producer loader bytes with an isolated POSIX /app filesystem.
// This is unit source conformance, not an installed Pod or upstream acceptance.
function producerProbe(corrupt){
 const root=process.env.OPENSPHERE_CONSOLE_SOURCE,files=new Map(),source=relative=>execFileSync('git',['-C',root,'show','HEAD:apps/osaa-gateway/'+relative]);
 for(const name of ['official-skills.cjs','skill-binding.cjs','module-skills.cjs','skills/manifest.json'])files.set('/app/'+name,source(name));
 const manifest=JSON.parse(files.get('/app/skills/manifest.json'));for(const entry of manifest.skills){files.set('/app/skills/'+entry.binding,source('skills/'+entry.binding));files.set('/app/skills/'+entry.skillId+'/SKILL.md',source('skills/'+entry.skillId+'/SKILL.md'));}
 corrupt?.(files);const directories=new Set(['/app','/app/skills',...manifest.skills.map(s=>'/app/skills/'+s.skillId)]),reads=[];
 const fs={readFileSync:(file,encoding)=>{assert.ok(file.startsWith('/app/'),'Probe tried to read outside public image files');reads.push(file);assert.ok(files.has(file),'Missing public fixture file');const value=files.get(file);return encoding?value.toString(encoding):Buffer.from(value);},realpathSync:file=>file,
  lstatSync:file=>({isDirectory:()=>directories.has(file),isFile:()=>files.has(file),isSymbolicLink:()=>false,size:files.get(file)?.length})};
 const cache=new Map(),load=file=>{if(cache.has(file))return cache.get(file).exports;const module={exports:{}};cache.set(file,module);
  const localRequire=name=>name==='node:fs'?fs:name==='node:path'?path.posix:name==='node:crypto'?crypto:load(path.posix.resolve(path.posix.dirname(file),name));
  new vm.Script('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{filename:file}).runInThisContext()(localRequire,module,module.exports);return module.exports;};
 let stdout='',stderr='';const probeProcess={stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}},exitCode:0};
 new vm.Script(NATIVE_OFFICIAL_SKILL_PROBE).runInNewContext({require:name=>name==='node:fs'?fs:name==='node:crypto'?crypto:load(name),process:probeProcess,Buffer});
 return {stdout,stderr,exitCode:probeProcess.exitCode,reads};
}
test('the actual governed producer loader verifies real Skill files and refuses corrupted manifest/binding/content', {skip:!process.env.OPENSPHERE_CONSOLE_SOURCE},async()=>{
 const baseline=producerProbe();assert.equal(baseline.exitCode,0);assert.equal(JSON.parse(baseline.stdout).report.manifestSha256,DIGEST);assert.equal(JSON.parse(baseline.stdout).report.valid,3);
 const f=fixture();f.probeRaw=()=>baseline.stdout;assert.equal((await f.verify()).valid,3);
 for(const name of ['manifest','binding','content']){
  const bad=producerProbe(files=>{const manifest=JSON.parse(files.get('/app/skills/manifest.json')),entry=manifest.skills[0];
   if(name==='manifest'){manifest.skills[0].revision++;files.set('/app/skills/manifest.json',Buffer.from(JSON.stringify(manifest)));}
   else{const file='/app/skills/'+(name==='binding'?entry.binding:entry.skillId+'/SKILL.md');files.set(file,Buffer.concat([files.get(file),Buffer.from('\ncorrupt\n')]));}
  });
  const f=fixture();f.probeRaw=()=>{if(bad.exitCode)throw Error('Actual installed loader probe refused');return bad.stdout;};await assert.rejects(f.verify(),undefined,name);
 }
 const missing=producerProbe(files=>files.delete('/app/official-skills.cjs'));assert.equal(missing.exitCode,1);assert.equal(missing.stdout,'');
});
