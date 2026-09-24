import profile from './hiss-preparation-profile.json' with {type:'json'};
import validation from './hiss-validation-artifact.json' with {type:'json'};
import {createHissPrerequisiteClient,prepareHissPrerequisites,prepareHissValidation,verifyHissValidationArtifact} from './hiss-prerequisites.mjs';
import {run} from './process.mjs';
import {installTarget} from './install-target.mjs';

// Existing installs use this same immutable profile as bootstrap. Bind every
// write to the installation UID, release digest, origin and physical cluster.
export async function prepareInstalledHiss({context,apply=false,runner=run,onProgress=()=>{}}) {
  const read=args=>JSON.parse(runner('kubectl',['--context',context,...args,'--request-timeout=10s','-o','json'],{capture:true}));
  const observe=()=>{
    const cluster=read(['get','namespace','kube-system']);
    const record=read(['-n','opensphere-console','get','configmap','opensphere-installation-lock']);
    const lock=JSON.parse(record.data?.['release.json']||'null'),config=JSON.parse(record.data?.['config.json']||'null');
    if(!cluster.metadata?.uid||!record.metadata?.uid||!/^sha256:[a-f0-9]{64}$/.test(lock?.releaseDigest||''))throw Error('Managed installation identity is unavailable');
    const scope=installTarget({context,channel:lock.channel,consoleUrl:config?.consoleUrl});
    return {scope,clusterUid:cluster.metadata.uid,installationUid:record.metadata.uid,releaseDigest:lock.releaseDigest};
  };
  // Validate context before it is used as a kubectl argument.
  if(typeof context!=='string'||!context||context.startsWith('-')||/\s/.test(context))throw Error('Explicit Kubernetes context required');
  const target=observe(),client=createHissPrerequisiteClient(target.scope,runner);
  verifyHissValidationArtifact(validation.yaml);
  const assertTarget=()=>{if(JSON.stringify(observe())!==JSON.stringify(target))throw Error('Installation or cluster changed; no further HISS preparation writes allowed');};
  const result=await prepareHissPrerequisites(JSON.stringify(profile,null,2)+'\n',target.scope,{apply,onProgress,client:{
    read:resources=>{assertTarget();return client.read(resources);},
    create:resource=>{assertTarget();return client.create(resource);},
  }});
  assertTarget();
  const validationResult=apply?prepareHissValidation(validation.yaml,target.scope,{runner}):{applied:false,verificationRequired:true};
  assertTarget();return {...result,target,validation:validationResult};
}
