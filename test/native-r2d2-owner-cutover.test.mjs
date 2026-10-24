import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{buildNativeCutoverProof}from'../src/native-r2d2-owner-cutover.mjs';
const sha=x=>'sha256:'+createHash('sha256').update(JSON.stringify(x)).digest('hex');
const image=name=>`ghcr.io/opensphere-platform/${name}@sha256:${'a'.repeat(64)}`;
function fixture(){
 const previousLock={releaseDigest:'sha256:'+'b'.repeat(64),components:{osaaGateway:{image:image('opensphere-console-osaa-gateway')},r2d2HermesWorker:{repository:'opensphere-console-r2d2-hermes-worker',image:image('opensphere-console-r2d2-hermes-worker')}}};
 const targetLock={releaseDigest:'sha256:'+'c'.repeat(64),components:{osaaGateway:{image:image('opensphere-console-osaa-gateway').replace(/a{64}$/,'d'.repeat(64))},r2d2OpenClawGateway:{image:image('opensphere-console-r2d2-openclaw')}}};
 const installationId='11111111-1111-4111-8111-111111111111',clusterUid='22222222-2222-4222-8222-222222222222';
 const reviewed={schema:'opensphere.r2d2-runtime-preparation/v1',installedReleaseDigest:previousLock.releaseDigest,clusterUid,installationId,policy:{installationId,image:targetLock.components.r2d2OpenClawGateway.image,bridgeImage:targetLock.components.osaaGateway.image},capacity:{}};
 const plan={schema:reviewed.schema,installedReleaseDigest:previousLock.releaseDigest,releaseDigest:targetLock.releaseDigest,installationId,clusterUid,inputSha256:sha(reviewed),entries:[{object:{kind:'ConfigMap',metadata:{name:'opensphere-r2d2-runtime-policy'},data:{'preparation.json':JSON.stringify(reviewed)}}}]};plan.planDigest=sha(plan);
 const before={kind:'Deployment',metadata:{namespace:'opensphere-console',name:'opensphere-console-osaa-gateway'},spec:{replicas:1,selector:{matchLabels:{app:'c-ai'}},template:{metadata:{labels:{app:'c-ai'}},spec:{serviceAccountName:'opensphere-console-osaa-gateway',containers:[{name:'gateway',image:previousLock.components.osaaGateway.image,env:[{name:'OTHER_PUBLIC_OPTION',value:'unchanged'},{name:'R2D2_HERMES_SOCK',value:'/run/r2d2/hermes.sock'},{name:'R2D2_HERMES_ENABLED',value:'true'}],volumeMounts:[{name:'tmp',mountPath:'/tmp'},{name:'r2d2-hermes-ipc',mountPath:'/run/r2d2'}]},{name:'hermes-worker',image:previousLock.components.r2d2HermesWorker.image}],volumes:[{name:'tmp',emptyDir:{}},{name:'worker-tmp',emptyDir:{sizeLimit:'256Mi'}},{name:'r2d2-hermes-ipc',emptyDir:{medium:'Memory',sizeLimit:'1Mi'}}]}}}};
 const after=structuredClone(before),pod=after.spec.template.spec,gateway=pod.containers[0];pod.containers=[gateway];gateway.image=targetLock.components.osaaGateway.image;gateway.env=gateway.env.filter(x=>!x.name.startsWith('R2D2_HERMES_'));
 gateway.env.push(...[{name:'R2D2_BACKEND',value:'openclaw-native'},{name:'R2D2_NATIVE_GATEWAY_IMAGE',value:reviewed.policy.image},{name:'R2D2_NATIVE_BRIDGE_IMAGE',value:reviewed.policy.bridgeImage},{name:'POD_IP',valueFrom:{fieldRef:{apiVersion:'v1',fieldPath:'status.podIP'}}},...Object.entries({OPENSPHERE_INSTALLATION_ID:'installationId',R2D2_NATIVE_RUNTIME_POLICY:'policy.json'}).map(([name,key])=>({name,valueFrom:{configMapKeyRef:{name:'opensphere-r2d2-runtime-policy',key}}}))]);
 gateway.volumeMounts=gateway.volumeMounts.filter(x=>x.name!=='r2d2-hermes-ipc');pod.volumes=pod.volumes.filter(x=>!['worker-tmp','r2d2-hermes-ipc'].includes(x.name));
 return{previousLock,targetLock,plan,before,after};
}
test('signed native profile proof accepts only the exact reviewed engine boundary',()=>{const f=fixture(),proof=buildNativeCutoverProof(f);assert.equal(Object.keys(proof).length,13);assert.equal(proof.installedReleaseDigest,f.previousLock.releaseDigest);assert.equal(proof.reviewedPolicyDigest,f.plan.inputSha256);assert.notEqual(proof.beforeConfigurationDigest,proof.afterConfigurationDigest);});
for(const[name,change]of[
 ['differentoldlock',f=>f.previousLock.releaseDigest='sha256:'+'f'.repeat(64)],
 ['differenttargetlock',f=>f.targetLock.releaseDigest='sha256:'+'f'.repeat(64)],
 ['policytamper',f=>f.plan.entries[0].object.data['preparation.json']='{}'],
 ['differentnamespace',f=>f.after.metadata.namespace='foreign'],
 ['differentimage',f=>f.after.spec.template.spec.containers[0].image=image('foreign')],
 ['foreignworker',f=>f.before.spec.template.spec.containers[1].image=image('foreign')],
 ['additionalenv',f=>f.after.spec.template.spec.containers[0].env.push({name:'NEW_AUTHORITY',value:'true'})],
 ['serviceaccountchange',f=>f.after.spec.template.spec.serviceAccountName='admin'],
 ['privilegedcontainer',f=>f.after.spec.template.spec.containers[0].securityContext={privileged:true}],
 ['additionalmount',f=>f.after.spec.template.spec.containers[0].volumeMounts.push({name:'tmp',mountPath:'/host'})],
 ['foreignpolicy',f=>f.after.spec.template.spec.containers[0].env.find(x=>x.name==='R2D2_NATIVE_RUNTIME_POLICY').valueFrom.configMapKeyRef.name='foreign'],
 ['optionalpolicy',f=>f.after.spec.template.spec.containers[0].env.find(x=>x.name==='R2D2_NATIVE_RUNTIME_POLICY').valueFrom.configMapKeyRef.optional=true],
 ['duplicatebackend',f=>f.after.spec.template.spec.containers[0].env.push({name:'R2D2_BACKEND',value:'disabled'})],
 ['oldsocketretained',f=>f.after.spec.template.spec.volumes.push({name:'r2d2-hermes-ipc',emptyDir:{}})],
 ['otherpodlabels',f=>f.after.spec.template.metadata.labels.extra='authority'],
 ])test('native cutover rejects '+name,()=>{const f=fixture();change(f);assert.throws(()=>buildNativeCutoverProof(f));});
