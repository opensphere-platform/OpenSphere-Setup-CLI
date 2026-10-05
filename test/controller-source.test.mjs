import test from 'node:test';
import assert from 'node:assert/strict';
import {stringify} from 'yaml';
import {captureControllerSource,bindControllerSource,controllerSourceData,CONTROLLER_SOURCE_KEY} from '../src/controller-source.mjs';
import comparison from '../src/controller-template.cjs';
import {calculateReleaseBomDigest} from '../src/release.mjs';
import {fetchManifest,EXTENSION_CONTROLLER_MANIFEST,recordInstallationState} from '../src/bootstrap.mjs';
const {controllerTemplateMatches}=comparison;
const revision='a'.repeat(40),digest='sha256:'+ 'b'.repeat(64);
const installationId='11111111-1111-4111-8111-111111111111';
const uid='22222222-2222-4222-8222-222222222222';
function fixture(){
 const component={repository:'opensphere-extension-controller',sourceRevision:revision,image:'ghcr.io/opensphere-platform/opensphere-extension-controller@'+digest};
 const bom={components:{extensionController:component}},bomDigest=calculateReleaseBomDigest(bom);
 const lock={sourceRevision:revision,releaseDigest:'sha256:'+'c'.repeat(64),components:{extensionController:component},releaseBom:{subject:'oci://release@'+digest,digest:bomDigest},trust:{mode:'signed-release'}};
 const template={metadata:{labels:{app:'opensphere-extension-controller'}},spec:{serviceAccountName:'opensphere-extension-controller',automountServiceAccountToken:true,containers:[{name:'controller',image:component.image,securityContext:{allowPrivilegeEscalation:false},env:[{name:'CONSOLE_URL',value:'https://console.example.test'},{name:'OWNER_KEY',valueFrom:{secretKeyRef:{name:'owner-key',key:'key'}}}],ports:[{containerPort:8080}],readinessProbe:{httpGet:{path:'/health',port:8080}}}]}};
 const deployment={apiVersion:'apps/v1',kind:'Deployment',metadata:{name:'opensphere-extension-controller',namespace:'opensphere-console'},spec:{template}};
 const renderedYaml='# rendered approved bytes\n'+stringify(deployment);
 const sourceYaml=renderedYaml.replace('# rendered approved bytes','# original source comment').replace(component.image,'__IMAGE__').replace('https://console.example.test','__CONSOLE_URL__');
 const source=captureControllerSource({lock,sourceYaml,renderedYaml,renderInputs:{storageClass:'local-path',consoleUrl:'https://console.example.test',authEnvironment:'development'},verifiedBom:{bom,digest:bomDigest,subject:lock.releaseBom.subject}});
 return {lock,source,sourceYaml,renderedYaml,deployment};
}
function applied(f){const d=structuredClone(f.deployment);d.metadata.uid=uid;d.metadata.generation=7;d.status={observedGeneration:7};return d;}
function injected(template){
 const t=structuredClone(template),name='kube-api-access-abc12';
 t.spec.nodeName='node-a';t.spec.volumes=[{name,projected:{defaultMode:420,sources:[{serviceAccountToken:{expirationSeconds:3607,path:'token'}},{configMap:{name:'kube-root-ca.crt',items:[{key:'ca.crt',path:'ca.crt'}]}},{downwardAPI:{items:[{path:'namespace',fieldRef:{apiVersion:'v1',fieldPath:'metadata.namespace'}}]}}]}}];
 t.spec.containers[0].volumeMounts=[{name,mountPath:'/var/run/secrets/kubernetes.io/serviceaccount',readOnly:true}];
 t.spec.tolerations=[{key:'node.kubernetes.io/not-ready',operator:'Exists',effect:'NoExecute',tolerationSeconds:300},{key:'node.kubernetes.io/unreachable',operator:'Exists',effect:'NoExecute',tolerationSeconds:300}];
 return t;
}
test('custody retains distinct original and rendered bytes plus public verified BOM predicate',()=>{
 const f=fixture();assert.equal(f.source.artifact.sourceDocument,f.sourceYaml);assert.equal(f.source.artifact.renderedDocument,f.renderedYaml);
 assert.notEqual(f.source.artifact.sourceDocumentDigest,f.source.artifact.renderedDocumentDigest);assert.equal(f.source.applied,null);
 assert.deepEqual(f.source.approvedTemplate,f.deployment.spec.template);assert.equal(f.source.verifiedBom.digest,f.lock.releaseBom.digest);
});
test('actual fetch/render path captures source before rendering and passes the exact returned template',async()=>{
 const f=fixture();let captured,request;
 const yaml=await fetchManifest(f.lock,EXTENSION_CONTROLLER_MANIFEST,'local-path','https://console.example.test','development',{
  onControllerSource:s=>{captured=s;},verifiedBom:f.source.verifiedBom,
  fetchFn:async(url)=>{request=url;return {ok:true,text:async()=>f.sourceYaml.replace('__IMAGE__','__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__').replace('__CONSOLE_URL__','__OPENSPHERE_CONSOLE_URL__')};}
 });
 assert.match(request,new RegExp(revision));assert.equal(captured.artifact.renderedDocument,yaml);
 assert.match(captured.artifact.sourceDocument,/__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__/);assert.equal(captured.component.image,f.lock.components.extensionController.image);
 assert.equal(captured.approvedTemplate.spec.containers[0].env[0].value,'https://console.example.test');
});
test('applied UID/generation are separate coordinates and never replace approved bytes',()=>{
 const f=fixture(),s=bindControllerSource(f.source,{installationId,lock:f.lock,deployment:applied(f)});
 assert.equal(s.applied.deploymentUid,uid);assert.equal(s.applied.deploymentGeneration,7);assert.equal(s.artifact.renderedDocument,f.renderedYaml);
 assert.deepEqual(s.approvedTemplate,f.source.approvedTemplate);
});
test('exact Kubernetes defaults compare equal without changing the approved template',()=>{
 const f=fixture(),d=applied(f),s=d.spec.template.spec,c=s.containers[0];
 d.spec.template.metadata.creationTimestamp=null;
 Object.assign(s,{restartPolicy:'Always',dnsPolicy:'ClusterFirst',schedulerName:'default-scheduler',terminationGracePeriodSeconds:30,enableServiceLinks:true,serviceAccount:s.serviceAccountName});
 Object.assign(c,{terminationMessagePath:'/dev/termination-log',terminationMessagePolicy:'File'});c.ports[0].protocol='TCP';Object.assign(c.readinessProbe,{timeoutSeconds:1,periodSeconds:10,successThreshold:1,failureThreshold:3});c.readinessProbe.httpGet.scheme='HTTP';
 assert.doesNotThrow(()=>bindControllerSource(f.source,{installationId,lock:f.lock,deployment:d}));
 assert.equal(f.source.approvedTemplate.spec.restartPolicy,undefined);
});
test('unknown injected fields, changed image, privilege, owner, generation, and source bytes fail closed',()=>{
 for(const mutate of [d=>d.spec.template.spec.containers[0].image+='x',d=>d.spec.template.spec.hostNetwork=true,d=>d.spec.template.spec.containers[0].securityContext.privileged=true,d=>d.spec.template.spec.containers.push({name:'sidecar',image:'x'}),d=>d.metadata.name='other',d=>d.status.observedGeneration=6,d=>d.metadata.deletionTimestamp='now']){
  const f=fixture(),d=applied(f);mutate(d);assert.throws(()=>bindControllerSource(f.source,{installationId,lock:f.lock,deployment:d}),/ControllerSourceMismatch/);
 }
 const f=fixture();f.source.artifact.sourceDocument+='changed';assert.throws(()=>bindControllerSource(f.source,{installationId,lock:f.lock}),/ControllerSourceMismatch/);
});
test('same component reuse retains origin and binds current adoption; changed components cannot inherit it',()=>{
 const f=fixture(),data=controllerSourceData({source:f.source,installationId,lock:f.lock,deployment:applied(f)}),lock=structuredClone(f.lock);lock.releaseDigest='sha256:'+'d'.repeat(64);
 const saved=JSON.parse(controllerSourceData({existingData:data,installationId,lock})[CONTROLLER_SOURCE_KEY]);
 assert.equal(saved.sourceReleaseDigest,f.lock.releaseDigest);assert.equal(saved.adoptedReleaseDigest,lock.releaseDigest);assert.equal(saved.applied.deploymentUid,uid);
 lock.components.extensionController.sourceRevision='e'.repeat(40);assert.deepEqual(controllerSourceData({existingData:data,installationId,lock}),{});
});
test('legacy absence stays missing and replacement installations or corrupt prior records are refused',()=>{
 const f=fixture();assert.deepEqual(controllerSourceData({installationId,lock:f.lock}),{});
 const data=controllerSourceData({source:f.source,installationId,lock:f.lock});
 assert.throws(()=>controllerSourceData({existingData:data,source:f.source,installationId:uid,lock:f.lock}),/ControllerSourceMismatch/);
 assert.throws(()=>controllerSourceData({existingData:{[CONTROLLER_SOURCE_KEY]:'broken'},installationId,lock:f.lock}),/ControllerSourceMismatch/);
});
test('existing CAS writer persists custody, preserves it on failure and rejects ownership change before patch',()=>{
 const f=fixture(),original={metadata:{uid,resourceVersion:'1'},data:{}};let record=structuredClone(original),patches=0;
 const kubectlFn=(args)=>{
  if(args.includes('get'))return JSON.stringify(record);
  if(args.includes('patch')){patches++;const patch=JSON.parse(args.at(-1));assert.equal(patch[0].value,uid);assert.equal(patch[1].value,record.metadata.resourceVersion);record={metadata:{uid,resourceVersion:String(Number(record.metadata.resourceVersion)+1)},data:patch[2].value};return JSON.stringify(record);}
  throw Error('UnexpectedMutation');
 };
 const write=(phase,options={})=>recordInstallationState(f.lock,'local-path',{},'https://console.example.test','development',null,phase,{installationIdentity:{installationId},recordPrecondition:{uid,resourceVersion:record.metadata.resourceVersion},...options},{kubectlFn});
 write('Preparing',{controllerSource:f.source});assert.ok(record.data[CONTROLLER_SOURCE_KEY]);
 write('Failed',{failureCode:'installation-verification-incomplete'});assert.equal(JSON.parse(record.data[CONTROLLER_SOURCE_KEY]).artifact.sourceDocument,f.source.artifact.sourceDocument);
 const expected=record.metadata.resourceVersion;record.metadata.resourceVersion='other';
 assert.throws(()=>write('Preparing',{recordPrecondition:{uid,resourceVersion:expected}}),/precondition changed/);assert.equal(patches,2);
});
test('upgrade custody is persisted as pending before apply and retained on failure; Ready never treats it as current',()=>{
 const f=fixture(),transition={targetReleaseDigest:f.lock.releaseDigest};
 const data=controllerSourceData({installationId,lock:{components:{}},pendingSource:f.source,pendingLock:f.lock,phase:'Installing',transition});
 assert.ok(data['controller-source.pending.json']);assert.equal(data[CONTROLLER_SOURCE_KEY],undefined);
 assert.deepEqual(controllerSourceData({existingData:data,installationId,lock:{components:{}},phase:'Failed'}),data);
 assert.deepEqual(controllerSourceData({existingData:data,installationId,lock:{components:{}},phase:'Ready'}),{});
 assert.throws(()=>controllerSourceData({installationId,lock:f.lock,pendingSource:f.source,pendingLock:f.lock,phase:'Installing',transition:{targetReleaseDigest:'other'}}),/ControllerSourceMismatch/);
});
test('capture refuses unrelated revision, BOM substitution and literal credential',()=>{
 const f=fixture(),args={lock:f.lock,sourceYaml:f.sourceYaml,renderedYaml:f.renderedYaml,renderInputs:f.source.renderInputs};
 assert.throws(()=>captureControllerSource({...args,sourceRevision:'e'.repeat(40)}),/ControllerSourceMismatch/);
 assert.throws(()=>captureControllerSource({...args,verifiedBom:{...f.source.verifiedBom,digest:'sha256:'+'f'.repeat(64)}}),/ControllerSourceMismatch/);
 const d=structuredClone(f.deployment);d.spec.template.spec.containers[0].env.push({name:'ACCESS_TOKEN',value:'test-only'});
 assert.throws(()=>captureControllerSource({...args,renderedYaml:stringify(d)}),/ControllerSourceMismatch/);
});
test('standard Pod service-account injection and scheduling defaults are narrowly accepted',()=>{
 const f=fixture();assert.equal(controllerTemplateMatches(injected(f.source.approvedTemplate),f.source.approvedTemplate,{pod:true}),true);
 const a=structuredClone(f.source.approvedTemplate);a.spec.nodeName='node-a';assert.equal(controllerTemplateMatches(injected(a),a,{pod:true}),true);
});
test('Pod injection cannot add custom audience, writable mount, sidecar, or custom toleration',()=>{
 for(const mutate of [t=>t.spec.volumes[0].projected.sources[0].serviceAccountToken.audience='other',t=>t.spec.containers[0].volumeMounts[0].readOnly=false,t=>t.spec.containers.push({name:'other',image:'x'}),t=>t.spec.tolerations.push({key:'all',operator:'Exists'})]){
  const f=fixture(),t=injected(f.source.approvedTemplate);mutate(t);assert.equal(controllerTemplateMatches(t,f.source.approvedTemplate,{pod:true}),false);
 }
 const f=fixture(),a=structuredClone(f.source.approvedTemplate);a.spec.automountServiceAccountToken=false;assert.equal(controllerTemplateMatches(injected(a),a,{pod:true}),false);
});
