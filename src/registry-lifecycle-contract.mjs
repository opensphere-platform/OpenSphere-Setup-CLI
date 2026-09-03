// Versioned Setup -> Console handoff; provider and consumer keep a local contract copy.
import {randomUUID} from 'node:crypto';
export const REGISTRY_AUTH_CONTRACT='registry-auth/v1';
export const REGISTRY_AUTH_SECRET='opensphere-registry-auth';
export const REGISTRY_PULL_SECRET='opensphere-ghcr-pull';
export const REGISTRY_NAMESPACES=Object.freeze(['opensphere-console-data','opensphere-console-change','opensphere-monitoring','opensphere-console','opensphere-system']);
export const GENERATION_ANNOTATION='opensphere.io/credential-generation';
export function requiredImages(lock) {
  if(!lock?.components || typeof lock.components!=='object' || Array.isArray(lock.components))throw new Error('Installed registry release lock is unavailable');
  return [...new Set([...Object.values(lock?.components || {}),...Object.values(lock?.auxiliaryArtifacts || {})].filter(c=>c.registryCredentialsRequired).map(c=>c.image))];
}
export function validateCredential(credentials) {
  const c=credentials; const l=c?.lifecycle;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(c?.username || '') || typeof c?.token !== 'string' || c.token.length<16 || c.token.length>4096 || /\s/.test(c.token)
      || l?.schemaVersion!=='1.0' || !['pat','github-device'].includes(l.mode) || !/^\d+$/.test(l.userId || '')
      || !Array.isArray(l.scopes) || !l.scopes.includes('read:packages') || l.scopes.some(s=>!['read:packages','offline_access'].includes(s))) throw new Error('Unverified or excessive registry credential; use a dedicated read:packages credential');
  for (const key of ['expiresAt','refreshExpiresAt','verifiedAt']) if (l[key] != null && !Number.isFinite(Date.parse(l[key]))) throw new Error('Invalid registry credential expiry');
  if (l.refreshToken && (l.mode!=='github-device' || !/^[A-Za-z0-9._-]{8,128}$/.test(l.clientId || '') || !l.refreshExpiresAt || !l.expiresAt)) throw new Error('Invalid registry refresh authority');
  return c;
}
export function initialRegistryState(credentials, images, {now=new Date().toISOString(),generation=randomUUID()}={}) {
  if(credentials) validateCredential(credentials);
  if(!Array.isArray(images) || images.length>128 || images.some(i=>!/^ghcr\.io\/opensphere-platform\/[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/.test(i))) throw new Error('Invalid registry handoff image boundary');
  return {schemaVersion:'1.0',contract:REGISTRY_AUTH_CONTRACT,generation,credentials,images,phase:credentials?'Pending':'Anonymous',updatedAt:now,observation:null,pending:null,work:null};
}
export function registryStateSecret(state) {
  return {apiVersion:'v1',kind:'Secret',metadata:{name:REGISTRY_AUTH_SECRET,namespace:'opensphere-console',labels:{'app.kubernetes.io/managed-by':'opensphere-setup','opensphere.io/credential-purpose':'registry-lifecycle'},annotations:{'opensphere.io/credential-contract':REGISTRY_AUTH_CONTRACT}},type:'Opaque',data:{'state.json':Buffer.from(JSON.stringify(state)).toString('base64'),...(state.credentials?.lifecycle?.clientId ? {'oauth-client-id':Buffer.from(state.credentials.lifecycle.clientId).toString('base64')} : {})}};
}
export function parseRegistryState(secret) {
  if(secret?.metadata?.name!==REGISTRY_AUTH_SECRET || secret?.metadata?.namespace!=='opensphere-console' || secret.type!=='Opaque') throw new Error('Registry lifecycle Secret identity mismatch');
  let state;try {state=JSON.parse(Buffer.from(secret.data?.['state.json'] || '', 'base64').toString('utf8'));}catch{throw new Error('Invalid registry lifecycle state');}
  if(state?.contract!==REGISTRY_AUTH_CONTRACT || state.schemaVersion!=='1.0' || !/^[A-Za-z0-9-]{1,128}$/.test(state.generation || '')) throw new Error('Unsupported registry lifecycle contract');
  initialRegistryState(state.credentials,state.images,{generation:state.generation});
  return state;
}
export function pullSecretData(credentials,generation) {
  const config=credentials ? {'x-opensphere-credential-generation':generation,auths:{'ghcr.io':{username:credentials.username,password:credentials.token,auth:Buffer.from(credentials.username+':'+credentials.token).toString('base64')}}} : {auths:{}};
  return {'.dockerconfigjson':Buffer.from(JSON.stringify(config)).toString('base64')};
}
export function publicRegistryState(state,{clientId='',actorRef=null,now=Date.now()}={}) {
  const life=state.credentials?.lifecycle;
  const checked=Date.parse(state.observation?.verifiedAt || '');
  const fresh=Number.isFinite(checked) && now-checked<20*60*1000;
  const expired=life?.expiresAt && Date.parse(life.expiresAt)<=now;
  const ready=state.phase==='Ready' && fresh && !expired;
  const pending=state.pending && state.pending.actorRef===actorRef && Date.parse(state.pending.flow?.expiresAt)>now ? {userCode:state.pending.flow.userCode,verificationUri:state.pending.flow.verificationUri,expiresAt:state.pending.flow.expiresAt}:null;
  return {connectionId:'opensphere-ghcr',registryOrigin:'ghcr.io',registry:'ghcr.io',namespace:'opensphere-platform',contract:REGISTRY_AUTH_CONTRACT,
    credentialPresent:Boolean(state.credentials),username:state.credentials?.username || null,credentialVersion:state.generation,
    configurationState:ready?'Configured':state.phase,lastVerifiedAt:state.observation?.verifiedAt || null,lastVerificationCode:state.errorCode || null,
    phase:expired?'ReauthorizationRequired':state.phase==='Ready'&&!fresh?'Stale':state.phase,verified:ready,
    authenticationMode:life?.mode || 'anonymous',refreshPolicy:life?.refreshPolicy || 'none',expiresAt:life?.expiresAt || null,
    refreshExpiresAt:life?.refreshExpiresAt || null,verifiedAt:state.observation?.verifiedAt || null,updatedAt:state.updatedAt,
    errorCode:state.errorCode || null,oauthAvailable:Boolean(clientId),oauthProductionVerified:false,authorization:pending,
    synchronizedNamespaces:state.observation?.namespaces || [],requiredNamespaceCount:REGISTRY_NAMESPACES.length};
}
