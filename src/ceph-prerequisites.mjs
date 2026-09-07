import profile from './ceph-preparation-profile.json' with {type:'json'};
import {run} from './process.mjs';

// This resource set is delivered inside the verified Setup release. There is
// deliberately no argument for a manifest, image, path, account, key or URL.
export const CEPH_EXECUTION_PROFILE = profile;
const identity=r=>`${r.apiVersion}/${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
export function prepareCephExecutionProfile(scope,{apply=false,runner=run}={}){
 if(scope.context!=='docker-desktop'||scope.channel!=='edge'||scope.consoleUrl!=='https://localhost:1114')throw Error('Ceph preparation profile is restricted to docker-desktop / edge / https://localhost:1114');
 if(profile.schema!=='opensphere.ceph-preparation-profile/v1'||profile.resources.length!==14||!/^ghcr\.io\/opensphere-platform\/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$/.test(profile.image))throw Error('Invalid bundled Ceph profile');
 const args=['--context','docker-desktop'],fieldManager='opensphere-setup-ceph';
 const resources=structuredClone(profile.resources);
 // Never reset an operation or its request identity during Setup repair/replay.
 const record=runner('kubectl',[...args,'get','configmap','opensphere-ceph-preparation','-n','opensphere-console','--ignore-not-found','-o','json','--request-timeout=20s'],{capture:true});
 if(String(record||'').trim()){
  const current=JSON.parse(record);
  if(current.metadata?.labels?.['opensphere.io/ceph-preparation']!=='profile-v1'||current.metadata?.deletionTimestamp)throw Error('Existing Ceph preparation record has another owner or is being deleted');
  resources.splice(resources.findIndex(r=>r.kind==='ConfigMap'&&r.metadata.name==='opensphere-ceph-preparation'),1);
 }
 const input=JSON.stringify({apiVersion:'v1',kind:'List',items:resources});
 // Validate every RBAC/admission definition before making any change.
 runner('kubectl',[...args,'apply','--server-side','--field-manager='+fieldManager,'--dry-run=server','-f','-','--request-timeout=20s'],{capture:true,input});
 if(apply)runner('kubectl',[...args,'apply','--server-side','--field-manager='+fieldManager,'-f','-','--request-timeout=20s'],{capture:true,input});
 return {schema:'opensphere.ceph-profile-preparation/v1',applied:apply,resourceCount:resources.length,preservedRecord:resources.length<14,image:profile.image,bundleDigest:profile.bundleDigest,
  resources:resources.map(identity),installationComplete:false,next:'22 → OS Shell → cluster-manager.ceph.prerequisites.plan / install / status'};
}
