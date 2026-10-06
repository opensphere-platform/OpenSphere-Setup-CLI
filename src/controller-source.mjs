import {createHash} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import comparison from './controller-template.cjs';
import {calculateReleaseBomDigest} from './release.mjs';
import {normalizeConsoleUrl} from './console-url.mjs';
const {controllerTemplateMatches}=comparison;

export const CONTROLLER_SOURCE_KEY = 'controller-source.json';
export const PENDING_CONTROLLER_SOURCE_KEY = 'controller-source.pending.json';
const PATH = 'apps/extension-controller/deploy.yaml';
const NAME = 'opensphere-extension-controller';
const NS = 'opensphere-console';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k,stable(v[k])])) : v;
const json = v => JSON.stringify(stable(v));
const fail = () => {throw Error('ControllerSourceMismatch');};
// A projected credential's fixed, read-only file reference is safe to capture;
// credential bytes are not. Only the two reviewed C_EXT audience projections
// qualify, with their exact mount, path and bounded lifetime.
const PROVIDER_FILES={
  CONSOLE_PROVIDER_DISPATCH_TOKEN_FILE:{name:'provider-dispatch',audience:'opensphere-foundation-dispatch'},
  CONSOLE_PROVIDER_ENGINE_TOKEN_FILE:{name:'provider-engine',audience:'opensphere-provider-engine-evidence'},
};
function projectedProviderFile(env,container,pod) {
  const approved=PROVIDER_FILES[env.name];if(!approved)return false;
  const mountPath='/var/run/opensphere/'+approved.name;
  const mounts=(container.volumeMounts||[]).filter(m=>m.name===approved.name);
  const volumes=(pod.volumes||[]).filter(v=>v.name===approved.name);
  const source=volumes[0]?.projected?.sources;
  return env.value===mountPath+'/token'&&mounts.length===1&&mounts[0].mountPath===mountPath
    &&mounts[0].readOnly===true&&!mounts[0].subPath&&!mounts[0].subPathExpr&&volumes.length===1
    &&source?.length===1&&json(source[0])===json({serviceAccountToken:{path:'token',audience:approved.audience,expirationSeconds:600}});
}
function deploymentDocument(yaml) {
  if(typeof yaml !== 'string' || Buffer.byteLength(yaml)>262144) fail();
  const docs=parseAllDocuments(yaml);
  if(docs.some(d=>d.errors.length)) fail();
  const found=docs.filter(d=>{const v=d.toJSON();return v?.kind==='Deployment'&&v.metadata?.name===NAME&&v.metadata.namespace===NS;});
  if(found.length!==1) fail();
  const d=found[0],value=d.toJSON();
  if(value.apiVersion!=='apps/v1'||value.metadata.uid||value.metadata.generation||value.status) fail();
  // Retain the exact original Deployment document bytes, not a YAML serializer's rewrite.
  const index=docs.indexOf(d);
  const bytes=yaml.slice(index===0?0:docs[index-1].range[2],d.range[2]);
  return {bytes,value};
}

// Called only by the existing Setup materializer, after its release verification.
// Captured bytes/digests are custody, not a replacement for signature verification.
export function captureControllerSource({lock,sourceRevision=lock?.sourceRevision,sourceYaml,renderedYaml,renderInputs,verifiedBom=null}) {
  const component=lock?.components?.extensionController;
  if(!component||!/^sha256:[a-f0-9]{64}$/.test(lock.releaseDigest||'')
      ||!/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(component.image||'')
      ||sourceRevision!==component.sourceRevision) fail();
  const source=deploymentDocument(sourceYaml),rendered=deploymentDocument(renderedYaml);
  if(verifiedBom&&(verifiedBom.subject!==lock.releaseBom?.subject||verifiedBom.digest!==lock.releaseBom?.digest
      ||calculateReleaseBomDigest(verifiedBom.bom)!==verifiedBom.digest
      ||json(verifiedBom.bom.components?.extensionController)!==json(component)))fail();
  const containers=rendered.value.spec?.template?.spec?.containers;
  if(containers?.length!==1||containers[0].name!=='controller'||containers[0].image!==component.image
      ||rendered.value.spec.template.spec.serviceAccountName!==NAME) fail();
  if(!renderInputs||Object.keys(renderInputs).some(k=>!['storageClass','consoleUrl','authEnvironment','kubernetesApiEgress'].includes(k))) fail();
  if(typeof renderInputs.storageClass!=='string'||renderInputs.storageClass.length>253
      ||!['development','production'].includes(renderInputs.authEnvironment))fail();
  try{if(normalizeConsoleUrl(renderInputs.consoleUrl)!==renderInputs.consoleUrl)fail();}catch{fail();}
  // This source-owned Deployment uses references for credentials. Refuse a future
  // literal credential rather than putting it in the installation ConfigMap.
  for(const c of [...containers,...(rendered.value.spec.template.spec.initContainers||[])])
    for(const e of c.env||[]) if(e.value!==undefined&&/password|token|credential|secret|database.*url/i.test(e.name)
      &&!projectedProviderFile(e,c,rendered.value.spec.template.spec)) fail();
  const result={schema:'opensphere.controller-source/v1',component:structuredClone(component),
    sourceReleaseDigest:lock.releaseDigest,releaseBom:structuredClone(lock.releaseBom??null),
    trust:structuredClone(lock.trust),verifiedBom:structuredClone(verifiedBom),artifact:{path:PATH,sourceRevision,
      sourceFileDigest:sha(sourceYaml),sourceDocumentDigest:sha(source.bytes),sourceDocument:source.bytes,
      renderedDocumentDigest:sha(rendered.bytes),renderedDocument:rendered.bytes},
    renderInputs:structuredClone(renderInputs),approvedTemplate:structuredClone(rendered.value.spec.template),
    templateDigest:sha(json(rendered.value.spec.template)),applied:null};
  if(Buffer.byteLength(JSON.stringify(result))>131072) fail();
  return result;
}

export function bindControllerSource(source,{installationId,lock,deployment}={}) {
  if(!source||source.schema!=='opensphere.controller-source/v1'
      ||!/^sha256:[a-f0-9]{64}$/.test(lock?.releaseDigest||'')
      ||!UUID.test(installationId||'')
      ||json(source.component)!==json(lock?.components?.extensionController)
      ||source.templateDigest!==sha(json(source.approvedTemplate))
      ||source.artifact?.path!==PATH||source.artifact.sourceRevision!==source.component.sourceRevision
      ||source.artifact.sourceDocumentDigest!==sha(source.artifact.sourceDocument)
      ||source.artifact.renderedDocumentDigest!==sha(source.artifact.renderedDocument)
      ||json(deploymentDocument(source.artifact.renderedDocument).value.spec.template)!==json(source.approvedTemplate)) fail();
  const out={...structuredClone(source),installationId,adoptedReleaseDigest:lock.releaseDigest,
    adoptedReleaseBom:structuredClone(lock.releaseBom??null)};
  if(deployment){
    if(deployment.apiVersion!=='apps/v1'||deployment.kind!=='Deployment'||deployment.metadata?.name!==NAME
        ||deployment.metadata.namespace!==NS||!UUID.test(deployment.metadata.uid||'')
        ||deployment.metadata.deletionTimestamp||!Number.isSafeInteger(deployment.metadata.generation)
        ||deployment.metadata.generation<1||deployment.status?.observedGeneration!==deployment.metadata.generation
        ||!controllerTemplateMatches(deployment.spec?.template,source.approvedTemplate)) fail();
    out.applied={namespace:NS,deploymentName:NAME,deploymentUid:deployment.metadata.uid,
      deploymentGeneration:deployment.metadata.generation,containerName:'controller',
      imageDigest:source.component.image.split('@')[1],templateDigest:source.templateDigest};
  }
  return out;
}

// Existing record writer owns persistence and CAS. No new ConfigMap, queue, or
// independent writer. Retain an earlier component only with its exact identity.
export function controllerSourceData({existingData={},source,installationId,lock,deployment,pendingSource,pendingLock,phase,transition}={}) {
  const data={};
  if(phase!=='Ready'&&existingData[PENDING_CONTROLLER_SOURCE_KEY]){
    let pending;try{pending=JSON.parse(existingData[PENDING_CONTROLLER_SOURCE_KEY]);}catch{fail();}
    if(pending.installationId!==installationId)fail();
    data[PENDING_CONTROLLER_SOURCE_KEY]=existingData[PENDING_CONTROLLER_SOURCE_KEY];
  }
  if(pendingSource){
    if(phase!=='Installing'||transition?.targetReleaseDigest!==pendingLock?.releaseDigest)fail();
    data[PENDING_CONTROLLER_SOURCE_KEY]=JSON.stringify(bindControllerSource(pendingSource,{installationId,lock:pendingLock}));
  }
  let old;
  if(existingData[CONTROLLER_SOURCE_KEY]){
    try{old=JSON.parse(existingData[CONTROLLER_SOURCE_KEY]);}catch{fail();}
    if(old.installationId!==installationId) fail();
  }
  const candidate=source??(old&&json(old.component)===json(lock?.components?.extensionController)?old:null);
  if(candidate)data[CONTROLLER_SOURCE_KEY]=JSON.stringify(bindControllerSource(candidate,{installationId,lock,deployment}));
  return data;
}
