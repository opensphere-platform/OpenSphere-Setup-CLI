import {createHash} from 'node:crypto';
import {normalizeConsoleUrl} from './console-url.mjs';
import {selectAuthEnvironment} from './auth-environment.mjs';
import {renderRegistryKubernetesEgress} from './registry-runtime-access.mjs';
import {parseAllDocuments} from 'yaml';

// These are installed by Install-ConsoleNativeRuntime.ps1 after the API/DB
// installer, not by Setup's early base apply. Preview never changes that order.
export const NATIVE_OWNER_SOURCE_PATHS=Object.freeze([
  'apps/osaa-gateway/deploy.yaml','apps/osdst/deploy.yaml','apps/os-shell-control/deploy.yaml',
]);
const AUTH_SLOT='__OPENSPHERE_AUTH_ENVIRONMENT__';
const TEMPLATE='apps/os-shell-control/runtime-template.js';
const sha256=value=>'sha256:'+createHash('sha256').update(value.replace(/\r\n/g,'\n')).digest('hex');
const validateAuthEnvironment=value=>{
  if(!['development','production'].includes(value))throw Error('Native Owner preview authentication environment is invalid');
  return value;
};
export function bindNativeInstallerAuthEnvironment(raw,authEnvironment,channel='edge'){
  const selected=selectAuthEnvironment(channel,validateAuthEnvironment(authEnvironment));
  if(typeof raw!=='string'||raw.split(AUTH_SLOT).length!==2)throw Error('Native C_AI source must expose exactly one authentication environment slot');
  // The immutable installer otherwise infers development from edge. Resolve
  // only this slot from the validated installation input before it reads it.
  return raw.replace(AUTH_SLOT,selected);
}

export function renderFoundationOwnerPreview(release,artifacts){
  const manifestPath='backend/gitea/bootstrap/gitea.yaml',installerPath='backend/gitea/bootstrap/install.ps1';
  if(!release.some(item=>item.path===manifestPath))return release;
  const installers=artifacts.filter(item=>item.path===installerPath);
  if(installers.length!==1||typeof installers[0].contents!=='string')throw Error('Gitea final Owner preview requires its selected installer source');
  const scales=[...installers[0].contents.matchAll(/Invoke-Kubectl\s+@\('-n',\s*\$GiteaNamespace,\s*'scale',\s*'deployment\/opensphere-gitea',\s*'--replicas=(\d+)'\)/g)];
  if(scales.length!==1||scales[0][1]!=='1')throw Error('Gitea installer final scale contract differs');
  return release.map(item=>{
    if(item.path!==manifestPath)return item;
    const documents=parseAllDocuments(item.yaml);
    if(documents.some(document=>document.errors.length))throw Error('Gitea final Owner preview source is invalid YAML');
    const deployments=documents.filter(document=>document.get('kind')==='Deployment'&&document.getIn(['metadata','namespace'])==='opensphere-console-change'&&document.getIn(['metadata','name'])==='opensphere-gitea');
    if(deployments.length!==1||deployments[0].getIn(['spec','replicas'])!==0)throw Error('Gitea staged Owner declaration differs');
    // The normal installer owns this fixed scale after its PostgreSQL boundary.
    // Change only the comparison copy; its staged apply template remains zero.
    deployments[0].setIn(['spec','replicas'],1);
    return {...item,yaml:documents.map(document=>document.toString({lineWidth:0})).join('---\n')};
  });
}

export function renderNativeOwnerPreview(lock,{artifacts,knowledgeProjection,kubernetesApiEgress,consoleUrl,authEnvironment}={}){
  const origin=normalizeConsoleUrl(consoleUrl),auth=selectAuthEnvironment(lock.channel,validateAuthEnvironment(authEnvironment));
  const source=path=>{
    const matches=artifacts.filter(item=>item.path===path);
    if(matches.length!==1||typeof matches[0].contents!=='string')throw Error('Native Owner preview source is missing or duplicated: '+path);
    return matches[0].contents;
  };
  const replace=(raw,substitutions)=>{
    let rendered=raw;
    for(const [slot,value]of substitutions){
      if(typeof value!=='string'||!value)throw Error('Native Owner preview requires exact release inputs');
      rendered=rendered.replaceAll(slot,value);
    }
    if(/__OPENSPHERE_[A-Z0-9_]+__/.test(rendered))throw Error('Native Owner preview contains an unresolved installer slot');
    return rendered;
  };
  const componentImage=(name,auxiliary=false)=>{
    const image=(auxiliary?lock.auxiliaryArtifacts:lock.components)?.[name]?.image;
    if(!/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(image??''))throw Error('Native Owner preview image is not in the exact release lock');
    return image;
  };
  if(!['edge','candidate','stable','lts'].includes(lock.channel)||!/^sha256:[a-f0-9]{64}$/.test(lock.releaseDigest??''))throw Error('Native Owner preview release identity is invalid');
  if(!Array.isArray(knowledgeProjection?.sources)||!knowledgeProjection.sources.length||!Array.isArray(knowledgeProjection.configMaps)||!knowledgeProjection.configMaps.length)
    throw Error('Native Owner preview requires the actual verified Knowledge projection');
  const osaaSource=source(NATIVE_OWNER_SOURCE_PATHS[0]);
  if(osaaSource.includes(AUTH_SLOT)||!osaaSource.includes(`name: OPENSPHERE_AUTH_ENVIRONMENT, value: "${auth}"`))
    throw Error('Native C_AI installer authentication input is not bound to the preview');
  const osaa=replace(osaaSource,[
    ['__OPENSPHERE_OSAA_GATEWAY_IMAGE__',componentImage('osaaGateway')],
    ['__OPENSPHERE_R2D2_OPENCLAW_GATEWAY_IMAGE__',componentImage('r2d2OpenClawGateway')],
    ['__OPENSPHERE_RELEASE_CHANNEL__',lock.channel],['__OPENSPHERE_CONSOLE_URL__',origin],
    ['__OPENSPHERE_KNOWLEDGE_SOURCES__',JSON.stringify(knowledgeProjection.sources)],
  ]);
  const osdst=replace(source(NATIVE_OWNER_SOURCE_PATHS[1]),[['__OPENSPHERE_OSDST_IMAGE__',componentImage('osdst')]]);
  const shellSource=source(NATIVE_OWNER_SOURCE_PATHS[2]),runtimeTemplate=source(TEMPLATE);
  const shell=replace(renderRegistryKubernetesEgress(shellSource,kubernetesApiEgress),[
    ['__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__',componentImage('osShellControl',true)],
    ['__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__',componentImage('osShellRuntime',true)],
    ['__OPENSPHERE_CONSOLE_URL__',origin],
    ['__OPENSPHERE_OS_SHELL_OS_ARTIFACT_DIGEST__',componentImage('cliArtifacts',true).split('@')[1]],
    ['__OPENSPHERE_OS_SHELL_MANIFEST_SHA256__',sha256(shellSource)],
    ['__OPENSPHERE_OS_SHELL_RELEASE_EVIDENCE_REF__',`release://${lock.channel}/${lock.releaseDigest.slice(7)}/native-console-runtime`],
    ['__OPENSPHERE_OS_SHELL_RUNTIME_TEMPLATE_SHA256__',sha256(runtimeTemplate)],
  ]);
  // Match stage 6 exactly: Knowledge ConfigMaps, C_AI, OSDST and OS Shell.
  // No component-only Cilium policy, new object or live Owner reconstruction.
  return [
    {path:NATIVE_OWNER_SOURCE_PATHS[0],yaml:knowledgeProjection.configMaps.map(map=>JSON.stringify(map)).join('\n---\n')+'\n---\n'+osaa},
    {path:NATIVE_OWNER_SOURCE_PATHS[1],yaml:osdst},{path:NATIVE_OWNER_SOURCE_PATHS[2],yaml:shell},
  ];
}
