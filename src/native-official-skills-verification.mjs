// Native readiness and official Skill file loadability are independent evidence.
// The normally admitted immutable image supplies the loader authority. No image-
// specific source hash, fabricated HTTP envelope or permissive fallback is used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {kubectl} from './process.mjs';
import {validateLock} from './release.mjs';
import {officialSkillReport} from './official-skills-verification.mjs';
const NS='opensphere-console',NAME='opensphere-console-osaa-gateway',MAX_BODY=64*1024;
const FILES=['official-skills.cjs','skill-binding.cjs','module-skills.cjs'];
const SHA=/^sha256:[a-f0-9]{64}$/;
const exact=(value,keys)=>assert.ok(value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join()===keys.slice().sort().join(),'Native Gateway evidence has unexpected fields');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Fixed public metadata only: no environment, catalog, network, DB or Secret
// access. env -i is applied before Node starts, preventing inherited preloads.
export const NATIVE_OFFICIAL_SKILL_PROBE=String.raw`'use strict';
try {
 const fs=require('node:fs'),crypto=require('node:crypto');
 for(const directory of ['/app','/app/skills'])if(fs.realpathSync(directory)!==directory||!fs.lstatSync(directory).isDirectory())throw Error('directory');
 const files=['official-skills.cjs','skill-binding.cjs','module-skills.cjs'];
 const regular=file=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||fs.realpathSync(file)!==file)throw Error('public image file');};
 const loaders=files.map(name=>{const file='/app/'+name;regular(file);return {name,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};});
 regular('/app/skills/manifest.json');
 const manifest=require('/app/skill-binding.cjs').validateManifest(JSON.parse(fs.readFileSync('/app/skills/manifest.json','utf8')));
 for(const skill of manifest.skills){const directory='/app/skills/'+skill.skillId;if(fs.realpathSync(directory)!==directory||!fs.lstatSync(directory).isDirectory())throw Error('Skill directory');regular('/app/skills/'+skill.binding);regular(directory+'/SKILL.md');}
 const runtime=require('/app/official-skills.cjs').createOfficialSkills({dir:'/app/skills',catalog:()=>{throw Error('catalog forbidden');}});
 const loaded=runtime.loaded();
 const report={manifestSha256:runtime.manifestSha256(),shipped:loaded.length,valid:loaded.filter(s=>s.valid).length,skills:loaded.map(s=>({skillId:s.skillId,revision:s.revision})),invalid:loaded.filter(s=>!s.valid).map(s=>({skillId:s.skillId,reason:s.reason}))};
 const result=JSON.stringify({schema:'opensphere.native-official-skills-probe/v1',origin:'installed-official-skill-loader',loaders,report});
 if(Buffer.byteLength(result)>65536)throw Error('budget');process.stdout.write(result);
}catch{process.stderr.write('Installed official Skill loader probe failed');process.exitCode=1;}`;

export function nativeGatewayReadinessEvidence(value,status){
 exact(value,['ready','components','reason']);exact(value.components,['reviewedPolicy','requestJournal']);
 assert.ok(status===200&&value.ready===true&&value.components.reviewedPolicy===true
  &&value.components.requestJournal===true&&value.reason==='native-core-ready','Native Gateway metadata authority is not Ready');
 return {httpStatus:status,ready:true,components:{reviewedPolicy:true,requestJournal:true},reason:value.reason};
}
function noOverlay(mount){
 assert.ok(typeof mount.mountPath==='string'&&mount.mountPath.startsWith('/'),'Gateway mount path is invalid');
 const actual=path.posix.normalize(mount.mountPath);
 for(const protectedPath of ['/app','/usr','/bin','/sbin','/lib','/lib64','/etc'])
  assert.ok(actual!==protectedPath&&!actual.startsWith(protectedPath+'/')&&!protectedPath.startsWith(actual==='/'?'/':actual+'/'),'Gateway loader or executable path is overlaid');
}
function gateway(spec,lock){
 assert.ok(spec&&Array.isArray(spec.containers)&&spec.containers.length===1
  &&!spec.initContainers?.length&&!spec.ephemeralContainers?.length,'Native Gateway container set differs');
 const c=spec.containers[0];assert.equal(c.name,'gateway');assert.equal(c.image,lock.components.osaaGateway.image);
 assert.ok(!c.command?.length&&!c.args?.length&&!c.envFrom?.length,'Gateway image entrypoint or environment source was overridden');
 assert.ok(spec.hostPID!==true&&spec.hostIPC!==true&&spec.hostNetwork!==true,'Gateway cannot share host namespaces');
 assert.ok(c.securityContext?.privileged!==true&&c.securityContext?.allowPrivilegeEscalation===false
  &&!c.securityContext.capabilities?.add?.length&&Array.isArray(c.securityContext.capabilities?.drop)
  &&c.securityContext.capabilities.drop.includes('ALL'),'Gateway privileges can bypass the immutable filesystem');
 const podSecurity=spec.securityContext??{},user=c.securityContext.runAsUser??podSecurity.runAsUser;
 assert.ok((c.securityContext.runAsNonRoot??podSecurity.runAsNonRoot)===true&&Number.isSafeInteger(user)&&user>0,'Gateway must run as a non-root identity');
 assert.equal((c.securityContext.seccompProfile??podSecurity.seccompProfile)?.type,'RuntimeDefault','Gateway executable isolation differs');
 assert.equal(c.securityContext?.readOnlyRootFilesystem,true,'Gateway loader filesystem is writable');
 for(const mount of c.volumeMounts??[])noOverlay(mount);
 assert.ok(!c.volumeDevices?.length,'Gateway executable filesystem cannot have device overlays');
 assert.ok(Array.isArray(c.ports)&&c.ports.length===1&&c.ports[0].name==='http'&&c.ports[0].containerPort===8080
  &&(c.ports[0].protocol??'TCP')==='TCP','Gateway named HTTP port differs');
 const env=c.env??[],one=name=>{const items=env.filter(e=>e.name===name);assert.equal(items.length,1,'Native Gateway reference missing or duplicated');return items[0];};
 assert.ok(!env.some(e=>/^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/.test(e.name??'')),'Gateway executable preload environment is forbidden');
 assert.equal(one('R2D2_BACKEND').value,'openclaw-native');
 assert.equal(one('R2D2_NATIVE_GATEWAY_IMAGE').value,lock.components.r2d2OpenClawGateway.image);
 assert.equal(one('R2D2_NATIVE_BRIDGE_IMAGE').value,lock.components.osaaGateway.image);
 assert.ok(!env.some(e=>e.name?.startsWith('R2D2_HERMES_')),'Retired engine cannot use native evidence');
 return c;
}
function metadata(value,kind){
 assert.ok(value?.apiVersion==='apps/v1'&&value.kind===kind&&value.metadata?.namespace===NS
  &&value.metadata.uid&&value.metadata.resourceVersion&&!value.metadata.deletionTimestamp,'Gateway owner identity is invalid');
}
function snapshot(lock,query){
 const read=args=>{const raw=query(['-n',NS,'get',...args,'-o','json'],{capture:true,spawn:{timeout:15000,maxBuffer:4*1024*1024}});
  assert.ok(typeof raw==='string'&&Buffer.byteLength(raw)<=4*1024*1024,'Gateway observation exceeds budget');return JSON.parse(raw);};
 const service=read(['service',NAME]);
 assert.ok(service?.apiVersion==='v1'&&service.kind==='Service'&&service.metadata?.name===NAME&&service.metadata.namespace===NS
  &&service.metadata.uid&&service.metadata.resourceVersion&&!service.metadata.deletionTimestamp,'Gateway Service identity is invalid');
 assert.deepEqual(service.spec?.selector,{app:NAME},'Gateway Service selector differs');
 const ports=service.spec?.ports;assert.ok(Array.isArray(ports)&&ports.length===1&&ports[0].name==='http'
  &&ports[0].port===8080&&ports[0].targetPort==='http'&&(ports[0].protocol??'TCP')==='TCP'
  &&(service.spec.type??'ClusterIP')==='ClusterIP','Gateway Service port differs');
 const deployment=read(['deployment',NAME]);metadata(deployment,'Deployment');assert.equal(deployment.metadata.name,NAME);
 const desired=deployment.spec?.replicas;assert.ok(Number.isSafeInteger(desired)&&desired>0&&desired<=32,'Gateway replica count is invalid');
 assert.ok(!deployment.spec.paused&&Number.isSafeInteger(deployment.metadata.generation)
  &&deployment.status?.observedGeneration===deployment.metadata.generation&&deployment.status.updatedReplicas===desired
  &&deployment.status.availableReplicas===desired,'Gateway rollout is not current');gateway(deployment.spec.template?.spec,lock);
 assert.deepEqual(deployment.spec.selector?.matchLabels,{app:NAME},'Gateway selector differs');
 const sets=read(['replicasets','-l','app='+NAME]),list=read(['pods','-l','app='+NAME]);
 for(const value of [sets,list])assert.ok(Array.isArray(value?.items)&&!value.metadata?.continue,'Gateway observation is incomplete');
 const activeSets=new Map();
 for(const rs of sets.items){
  if(!rs.metadata?.ownerReferences?.some(o=>o.controller===true&&o.apiVersion==='apps/v1'&&o.kind==='Deployment'&&o.uid===deployment.metadata.uid))continue;
  if(!(Number(rs.spec?.replicas)>0||Number(rs.status?.replicas)>0))continue;
  metadata(rs,'ReplicaSet');gateway(rs.spec?.template?.spec,lock);assert.ok(!activeSets.has(rs.metadata.uid),'Duplicate Gateway ReplicaSet');activeSets.set(rs.metadata.uid,rs);
 }
 assert.ok(activeSets.size>0,'Gateway has no current ReplicaSet');assert.equal(list.items.length,desired,'Gateway does not have exactly its current replica set');
 const seen=new Set(),pods=list.items.map(pod=>{
  assert.ok(pod?.apiVersion==='v1'&&pod.kind==='Pod'&&pod.metadata?.namespace===NS&&pod.metadata.name&&pod.metadata.uid
   &&pod.metadata.resourceVersion&&!pod.metadata.deletionTimestamp&&!seen.has(pod.metadata.uid),'Gateway Pod identity is invalid');seen.add(pod.metadata.uid);
  assert.ok(pod.metadata.labels?.app===NAME&&pod.metadata.ownerReferences?.some(o=>o.controller===true&&o.apiVersion==='apps/v1'&&o.kind==='ReplicaSet'&&activeSets.has(o.uid)),'Gateway Pod has a foreign owner');
  gateway(pod.spec,lock);assert.ok(pod.status?.phase==='Running'&&pod.status.conditions?.some(c=>c.type==='Ready'&&c.status==='True'),'Gateway Pod is not Ready');
  const statuses=pod.status.containerStatuses;assert.ok(Array.isArray(statuses)&&statuses.length===1&&statuses[0].name==='gateway'&&statuses[0].ready===true&&statuses[0].state?.running,'Gateway container is not Running/Ready');
  const status=statuses[0],image=lock.components.osaaGateway.image,digest=image.slice(image.indexOf('@')+1);
  assert.ok([image,'docker-pullable://'+image,'containerd://'+digest].includes(status.imageID),'Gateway imageID differs from the immutable image');
  return {name:pod.metadata.name,uid:pod.metadata.uid,resourceVersion:pod.metadata.resourceVersion,image,imageID:status.imageID,
   fingerprint:hash(pod),replicaSetUid:pod.metadata.ownerReferences.find(o=>o.controller===true).uid};
 }).sort((a,b)=>a.name.localeCompare(b.name));
 const slices=read(['endpointslices.discovery.k8s.io','-l','kubernetes.io/service-name='+NAME]);
 assert.ok(Array.isArray(slices?.items)&&slices.items.length>0&&!slices.metadata?.continue,'Gateway EndpointSlice list is incomplete');
 const endpoints=new Set();
 for(const slice of slices.items){
  assert.ok(slice.apiVersion==='discovery.k8s.io/v1'&&slice.kind==='EndpointSlice'&&slice.metadata?.namespace===NS
   &&slice.metadata.uid&&slice.metadata.resourceVersion&&!slice.metadata.deletionTimestamp&&slice.metadata.labels?.['kubernetes.io/service-name']===NAME
   &&slice.metadata.ownerReferences?.some(o=>o.controller===true&&o.kind==='Service'&&o.uid===service.metadata.uid),'Gateway EndpointSlice has a foreign Service');
  assert.ok(Array.isArray(slice.ports)&&slice.ports.length===1&&slice.ports[0].name==='http'&&slice.ports[0].port===8080
   &&(slice.ports[0].protocol??'TCP')==='TCP'&&Array.isArray(slice.endpoints),'Gateway EndpointSlice port or endpoints differ');
  for(const endpoint of slice.endpoints){
   assert.ok(endpoint.conditions?.ready===true&&endpoint.conditions.terminating!==true,'Gateway EndpointSlice is not Ready');
   const ref=endpoint.targetRef,pod=list.items.find(p=>p.metadata.uid===ref?.uid);
   assert.ok(pod&&ref.kind==='Pod'&&ref.name===pod.metadata.name&&ref.namespace===NS&&!endpoints.has(ref.uid),'Gateway Service selects a foreign or duplicate Pod');
   const addresses=new Set([pod.status.podIP,...(pod.status.podIPs??[]).map(item=>item.ip)].filter(Boolean));
   assert.ok(Array.isArray(endpoint.addresses)&&endpoint.addresses.length>0&&endpoint.addresses.every(ip=>addresses.has(ip)),'Gateway EndpointSlice address differs from its Pod');endpoints.add(ref.uid);
  }
 }
 assert.equal(endpoints.size,pods.length,'Gateway Service omits a current Pod');
 return {service:{uid:service.metadata.uid,resourceVersion:service.metadata.resourceVersion,fingerprint:hash(service)},deployment:{uid:deployment.metadata.uid,resourceVersion:deployment.metadata.resourceVersion,generation:deployment.metadata.generation,fingerprint:hash(deployment)},replicaSets:[...activeSets.values()].map(rs=>({uid:rs.metadata.uid,resourceVersion:rs.metadata.resourceVersion,fingerprint:hash(rs)})).sort((a,b)=>a.uid.localeCompare(b.uid)),endpointSlices:slices.items.map(slice=>({uid:slice.metadata.uid,resourceVersion:slice.metadata.resourceVersion,fingerprint:hash(slice)})).sort((a,b)=>a.uid.localeCompare(b.uid)),pods};
}
function parseProbe(raw,expected){
 assert.ok(typeof raw==='string'&&Buffer.byteLength(raw)<=MAX_BODY,'Installed Skill probe exceeds budget');const value=JSON.parse(raw);
 exact(value,['schema','origin','loaders','report']);assert.equal(value.schema,'opensphere.native-official-skills-probe/v1');assert.equal(value.origin,'installed-official-skill-loader');
 assert.ok(Array.isArray(value.loaders)&&value.loaders.length===FILES.length,'Skill loader inventory differs');
 for(const [i,item]of value.loaders.entries()){exact(item,['name','sha256']);assert.equal(item.name,FILES[i]);assert.match(item.sha256,/^[a-f0-9]{64}$/);}
 exact(value.report,['manifestSha256','shipped','valid','skills','invalid']);const report=officialSkillReport(value.report);
 for(const skill of value.report.skills){exact(skill,['skillId','revision']);assert.ok(Number.isSafeInteger(skill.revision)&&skill.revision>0,'Native Skill revision is invalid');}
 assert.equal(report.manifestSha256,expected,'Installed native Gateway Skill manifest differs from the release');
 assert.equal(new Set(report.skills.map(s=>s.skillId)).size,report.skills.length,'Skill inventory contains duplicate identities');
 return {loaders:value.loaders,report};
}
async function boundedBody(response){
 assert.ok(response.body,'Native Gateway readiness body is absent');const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BODY){await reader.cancel();throw Error('Native Gateway readiness exceeds budget');}chunks.push(Buffer.from(value));}
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes));
 }finally{reader.releaseLock();}
}
export async function verifyNativeOfficialSkills(lock,{withService,query=kubectl,fetchImpl=fetch}={}){
 validateLock(lock);assert.ok(lock.components?.r2d2OpenClawGateway&&!lock.components.r2d2HermesWorker,'Only the exact native release uses installed-loader evidence');
 const expected=lock.components.osaaGateway.officialSkills;assert.match(expected??'',SHA,'Native release must declare its official Skill manifest');
 const before=snapshot(lock,query);
 const readiness=await withService(NS,NAME,8080,async base=>{
  const response=await fetchImpl(base+'/readyz',{redirect:'error',signal:AbortSignal.timeout(15000)}),raw=await boundedBody(response);
  return nativeGatewayReadinessEvidence(JSON.parse(raw),response.status);
 });
 const observations=before.pods.map(pod=>{
  const raw=query(['-n',NS,'exec',pod.name,'-c','gateway','--','/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','-e',NATIVE_OFFICIAL_SKILL_PROBE],{capture:true,spawn:{timeout:15000,maxBuffer:MAX_BODY}});
  return {...pod,...parseProbe(raw,expected)};
 });
 for(const item of observations)assert.deepEqual({loaders:item.loaders,report:item.report},{loaders:observations[0].loaders,report:observations[0].report},'Gateway replicas disagree about installed Skill files or loader');
 assert.deepEqual(snapshot(lock,query),before,'Gateway identity, image or state changed during Skill verification');
 return {state:'Verified',declared:true,origin:'installed-official-skill-loader',releaseDigest:lock.releaseDigest,
  sourceRevision:lock.components.osaaGateway.sourceRevision??lock.sourceRevision,image:lock.components.osaaGateway.image,readiness,
  ...observations[0].report,loaders:observations[0].loaders,pods:observations.map(({report,loaders,...pod})=>pod)};
}
