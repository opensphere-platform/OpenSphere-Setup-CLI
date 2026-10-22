// A single reviewed Console-native engine transition, not a general exception
// to Owner preservation. Called only after the attested BOM was verified.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const sha=v=>'sha256:'+createHash('sha256').update(JSON.stringify(v)).digest('hex');
const configuration=w=>{const spec=structuredClone(w.spec);delete spec.replicas;for(const c of spec.template.spec.containers)delete c.image;return sha(stable(spec));};
const nativeEnvs=['R2D2_BACKEND','R2D2_NATIVE_GATEWAY_IMAGE','R2D2_NATIVE_BRIDGE_IMAGE','POD_IP','OPENSPHERE_INSTALLATION_ID','R2D2_NATIVE_RUNTIME_POLICY'];
const oldEnvs=['R2D2_HERMES_SOCK','R2D2_HERMES_ENABLED'];
const identity=w=>`${w.kind}/${w.metadata?.namespace}/${w.metadata?.name}`;
function one(list,name){const rows=(list??[]).filter(x=>x.name===name);assert.equal(rows.length,1,'Native cutover requires one '+name);return rows[0];}
function exactKeys(value,keys){assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),'Native cutover contains an unexpected field');}
function envValue(env,name,value){const e=one(env,name);exactKeys(e,['name','value']);assert.equal(e.value,value,'Native cutover image or feature differs');}
function ref(env,name,key){const e=one(env,name);exactKeys(e,['name','valueFrom']);exactKeys(e.valueFrom,['configMapKeyRef']);const r=e.valueFrom.configMapKeyRef;assert.ok(Object.keys(r).every(x=>['name','key','optional'].includes(x)));assert.equal(r.name,'opensphere-r2d2-runtime-policy');assert.equal(r.key,key);assert.notEqual(r.optional,true);}

export function buildNativeCutoverProof({previousLock,targetLock,plan,before,after}={}){
 assert.equal(identity(before),'Deployment/opensphere-console/opensphere-console-osaa-gateway');
 assert.equal(identity(after),identity(before));
 assert.ok(plan&&plan.schema==='opensphere.r2d2-runtime-preparation/v1','Reviewed native policy preparation is required');
 const {planDigest,...content}=plan;assert.equal(sha(content),planDigest,'Native preparation plan changed');
 assert.equal(plan.installedReleaseDigest,previousLock.releaseDigest,'Reviewed policy names a different installed lock');
 assert.equal(plan.releaseDigest,targetLock.releaseDigest,'Reviewed policy names a different target lock');
 const policyObject=plan.entries?.find(e=>e.object?.kind==='ConfigMap'&&e.object.metadata?.name==='opensphere-r2d2-runtime-policy')?.object;
 const reviewed=JSON.parse(policyObject?.data?.['preparation.json']??'null');
 assert.equal(sha(reviewed),plan.inputSha256,'Reviewed preparation bytes changed');
 assert.equal(reviewed.installedReleaseDigest,previousLock.releaseDigest);
 assert.equal(reviewed.clusterUid,plan.clusterUid);assert.equal(reviewed.installationId,plan.installationId);
 assert.equal(reviewed.policy.installationId,plan.installationId);
 assert.equal(reviewed.policy.image,targetLock.components.r2d2OpenClawGateway.image);
 assert.equal(reviewed.policy.bridgeImage,targetLock.components.osaaGateway.image);
 assert.equal(previousLock.components.r2d2HermesWorker?.repository,'opensphere-console-r2d2-hermes-worker','Only the exact retired engine inventory may use this cutover');
 assert.ok(!previousLock.components.r2d2OpenClawGateway&&!targetLock.components.r2d2HermesWorker);
 const a=structuredClone(before.spec),b=structuredClone(after.spec),ap=a.template.spec,bp=b.template.spec;
 assert.deepEqual(ap.containers.map(x=>x.name),['gateway','hermes-worker'],'Unexpected old shared-runtime containers');
 assert.deepEqual(bp.containers.map(x=>x.name),['gateway'],'Unexpected native control-plane containers');
 const ag=one(ap.containers,'gateway'),bg=one(bp.containers,'gateway'),worker=one(ap.containers,'hermes-worker');
 assert.equal(ag.image,previousLock.components.osaaGateway.image);assert.equal(bg.image,targetLock.components.osaaGateway.image);
 assert.equal(worker.image,previousLock.components.r2d2HermesWorker.image);
 for(const g of[ag,bg])assert.equal(new Set((g.env??[]).map(x=>x.name)).size,(g.env??[]).length,'Duplicate native cutover environment');
 assert.deepEqual(ag.env.filter(x=>x.name.startsWith('R2D2_HERMES_')).map(x=>x.name).sort(),[...oldEnvs].sort());
 assert.ok(!ag.env.some(x=>nativeEnvs.includes(x.name)));assert.ok(!bg.env.some(x=>x.name.startsWith('R2D2_HERMES_')));
 envValue(ag.env,'R2D2_HERMES_SOCK','/run/r2d2/hermes.sock');envValue(ag.env,'R2D2_HERMES_ENABLED','true');
 envValue(bg.env,'R2D2_BACKEND','openclaw-native');envValue(bg.env,'R2D2_NATIVE_GATEWAY_IMAGE',reviewed.policy.image);envValue(bg.env,'R2D2_NATIVE_BRIDGE_IMAGE',reviewed.policy.bridgeImage);
 ref(bg.env,'OPENSPHERE_INSTALLATION_ID','installationId');ref(bg.env,'R2D2_NATIVE_RUNTIME_POLICY','policy.json');
 const ip=one(bg.env,'POD_IP');exactKeys(ip,['name','valueFrom']);exactKeys(ip.valueFrom,['fieldRef']);assert.ok(Object.keys(ip.valueFrom.fieldRef).every(k=>['apiVersion','fieldPath'].includes(k)));assert.equal(ip.valueFrom.fieldRef.fieldPath,'status.podIP');assert.ok(ip.valueFrom.fieldRef.apiVersion===undefined||ip.valueFrom.fieldRef.apiVersion==='v1');
 const ipc=one(ag.volumeMounts,'r2d2-hermes-ipc');assert.equal(ipc.mountPath,'/run/r2d2');assert.ok(Object.keys(ipc).every(k=>['name','mountPath','readOnly'].includes(k)));assert.notEqual(ipc.readOnly,true);
 for(const[name,expected]of[['worker-tmp',{sizeLimit:'256Mi'}],['r2d2-hermes-ipc',{medium:'Memory',sizeLimit:'1Mi'}]]){
  const volume=one(ap.volumes,name);exactKeys(volume,['name','emptyDir']);const value={...volume.emptyDir};if(value.medium==='')delete value.medium;assert.deepEqual(value,expected,'Retired runtime volume differs');
  assert.ok(!(bp.volumes??[]).some(x=>x.name===name));assert.ok(!(bg.volumeMounts??[]).some(x=>x.name===name));
 }
 ag.env=ag.env.filter(x=>!oldEnvs.includes(x.name));bg.env=bg.env.filter(x=>!nativeEnvs.includes(x.name));
 ag.volumeMounts=ag.volumeMounts.filter(x=>x.name!=='r2d2-hermes-ipc');ap.volumes=ap.volumes.filter(x=>!['worker-tmp','r2d2-hermes-ipc'].includes(x.name));
 ap.containers=ap.containers.filter(x=>x.name!=='hermes-worker');
 delete a.replicas;delete b.replicas;delete ag.image;delete bg.image;
 assert.deepEqual(stable(b),stable(a),'Native cutover changes more than the reviewed engine boundary');
 return {ownerIdentity:identity(before),previousOwner:'osaaGateway+r2d2HermesWorker',nextOwner:'osaaGateway',beforeConfigurationDigest:configuration(before),afterConfigurationDigest:configuration(after),removedContainer:'hermes-worker',previousWorkerImage:worker.image,reviewedPolicyDigest:plan.inputSha256,installedReleaseDigest:previousLock.releaseDigest,installationId:plan.installationId,clusterUid:plan.clusterUid,gatewayImage:reviewed.policy.bridgeImage,nativeImage:reviewed.policy.image};
}
