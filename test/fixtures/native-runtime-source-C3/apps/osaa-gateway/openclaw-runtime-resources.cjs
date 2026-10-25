'use strict';

// CON-FR-018/019, C_AI: personal native execution resources. This module renders
// resources only; it has no Kubernetes client, agent loop or deployment side effect.
const { createHash } = require('node:crypto');
const { renderNativeOpenClawConfig } = require('./openclaw-native-config.cjs');

const NAMESPACE = 'opensphere-r2d2';
const SERVICE_ACCOUNT = 'r2d2-personal-runtime';
const PORT = 18789;
const BRIDGE_PORT = 18790;
const LABEL = 'opensphere.io/r2d2-runtime';
const OWNER = 'opensphere.io/r2d2-owner-digest';
const TEMPLATE = 'opensphere.io/r2d2-template-digest';
const MANAGED = 'opensphere-r2d2';
const TOKEN_ENV = 'OPENSPHERE_MODEL_PROXY_TOKEN';
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, message) {
  throw Object.assign(new Error(message), { status: 503, errorCode: code });
}
function nonempty(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('PersonalRuntimeConfigurationInvalid', `${field} is invalid`);
  }
  return value;
}
function positive(value, field, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail('PersonalRuntimeConfigurationInvalid', `${field} is invalid`);
  }
  return value;
}

function personalRuntimeIdentity({ installationId, subject } = {}) {
  nonempty(installationId, 'installationId');
  nonempty(subject, 'subject');
  const ownerDigest = hash(JSON.stringify(['opensphere.r2d2.personal-runtime/v1', installationId, subject]));
  const id = ownerDigest.slice(0, 40);
  const name = `r2d2-${id}`;
  return Object.freeze({ namespace: NAMESPACE, name, id, ownerDigest,
    installationDigest: hash(installationId), homeName: `${name}-home`,
    secretName: `${name}-auth`, configName: `${name}-seed` });
}

function validatePersonalRuntimePolicy(policy) {
  if (!plain(policy)) fail('PersonalRuntimeNotConfigured', 'Personal runtime installation policy is missing');
  nonempty(policy.installationId, 'installationId');
  if (policy.namespace !== undefined && policy.namespace !== NAMESPACE) {
    fail('PersonalRuntimeConfigurationInvalid', 'Personal runtime namespace is fixed');
  }
  const pinned = /^ghcr\.io\/[a-z0-9-]+\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u;
  if (typeof policy.image !== 'string' || !pinned.test(policy.image)
    || typeof policy.bridgeImage !== 'string' || !pinned.test(policy.bridgeImage)) {
    fail('PersonalRuntimeNotConfigured', 'An approved digest-pinned native runtime image is required');
  }
  if (policy.imagePullSecretName !== undefined
    && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(policy.imagePullSecretName)) {
    fail('PersonalRuntimeConfigurationInvalid', 'Runtime image pull credential reference is invalid');
  }
  const storage = policy.storage;
  if (!plain(storage) || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(storage.className || '')
    || storage.className.length > 253 || storage.accessMode !== 'ReadWriteOncePod') {
    fail('PersonalRuntimeNotConfigured', 'An approved ReadWriteOncePod storage profile is required');
  }
  positive(storage.sizeGi, 'storage.sizeGi', 1024);
  const r = policy.resources;
  if (!plain(r)) fail('PersonalRuntimeNotConfigured', 'Explicit runtime resource limits are required');
  positive(r.cpuRequestMilli, 'resources.cpuRequestMilli', 64000);
  positive(r.cpuLimitMilli, 'resources.cpuLimitMilli', 64000);
  positive(r.memoryRequestMi, 'resources.memoryRequestMi', 262144);
  positive(r.memoryLimitMi, 'resources.memoryLimitMi', 262144);
  positive(r.temporaryMi, 'resources.temporaryMi', 65536);
  if (r.cpuRequestMilli > r.cpuLimitMilli || r.memoryRequestMi > r.memoryLimitMi) {
    fail('PersonalRuntimeConfigurationInvalid', 'Runtime requests exceed their limits');
  }
  const bridge = policy.bridgeResources;
  if (!plain(bridge)) fail('PersonalRuntimeNotConfigured', 'Explicit bridge resource limits are required');
  for (const key of ['cpuRequestMilli', 'cpuLimitMilli', 'memoryRequestMi', 'memoryLimitMi']) {
    positive(bridge[key], `bridgeResources.${key}`, 262144);
  }
  if (bridge.cpuRequestMilli > bridge.cpuLimitMilli || bridge.memoryRequestMi > bridge.memoryLimitMi) {
    fail('PersonalRuntimeConfigurationInvalid', 'Bridge requests exceed their limits');
  }
  return structuredClone(policy);
}

function runtimeMetadata(identity, name = identity.name) {
  return { name, namespace: NAMESPACE,
    labels: { 'app.kubernetes.io/name': 'r2d2-openclaw-runtime',
      'app.kubernetes.io/managed-by': MANAGED, [LABEL]: identity.id },
    annotations: { [OWNER]: identity.ownerDigest,
      'opensphere.io/r2d2-installation-digest': identity.installationDigest } };
}
function validateToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/u.test(value)) {
    fail('PersonalRuntimeCredentialInvalid', 'Personal runtime credential is invalid');
  }
  return value;
}

function renderPersonalRuntimeSecret(identity, { gatewayToken, bridgeToken, proxyCredential }) {
  validateToken(gatewayToken); validateToken(bridgeToken); validateToken(proxyCredential);
  if (new Set([gatewayToken, bridgeToken, proxyCredential]).size !== 3) fail('PersonalRuntimeCredentialInvalid', 'Runtime credentials must have separate purposes');
  return { apiVersion: 'v1', kind: 'Secret', metadata: runtimeMetadata(identity, identity.secretName),
    type: 'Opaque', data: { 'gateway-token': Buffer.from(gatewayToken).toString('base64'),
      'bridge-token': Buffer.from(bridgeToken).toString('base64'),
      'proxy-token': Buffer.from(proxyCredential).toString('base64') } };
}

function configSeed(config) {
  if (!plain(config)) fail('PersonalRuntimeConfigurationInvalid', 'Native configuration seed is missing');
  const result = { ...renderNativeOpenClawConfig(), ...structuredClone(config) };
  // The seed has references only. Shared provider credentials never enter it.
  function check(value) {
    if (Array.isArray(value)) return value.forEach(check);
    if (!plain(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:apiKey|token|password|secret|clientSecret)$/iu.test(key)
        && child !== undefined && child !== null
        && !['${OPENCLAW_GATEWAY_TOKEN}', '${OPENSPHERE_MODEL_PROXY_TOKEN}'].includes(child)) {
        fail('PersonalRuntimeCredentialInvalid', 'Native configuration must use approved credential environment references');
      }
      check(child);
    }
  }
  check(result);
  result.gateway = { ...(plain(result.gateway) ? result.gateway : {}), mode: 'local', port: PORT,
    bind: 'loopback', auth: { mode: 'token' }, controlUi: { enabled: false }, terminal: { enabled: false }, tailscale: { mode: 'off' } };
  result.agents = { ...(plain(result.agents) ? result.agents : {}),
    defaults: { ...(plain(result.agents?.defaults) ? result.agents.defaults : {}), workspace: '/data/workspace' } };
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > 262144) fail('PersonalRuntimeConfigurationInvalid', 'Native configuration seed is too large');
  try { managedConfiguration(result, true); }
  catch { fail('PersonalRuntimeConfigurationInvalid', 'Managed native policy differs from its reviewed boundary'); }
  return json;
}

// D-M2: these eight paths are the entire update vocabulary. This is not a
// general configuration merger. Functions below are serialized into node -e;
// their only dependencies are Node built-ins, not a second runtime package.
function managedConfiguration(config, target = false) {
  const assert = require('node:assert/strict');
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  assert.ok(object(config), 'Personal configuration must be a JSON object');
  const paths = [['gateway'], ['models'], ['agents','defaults','workspace'], ['agents','defaults','model'],
    ['memory','search'], ['plugins'], ['tools'], ['cron','enabled']];
  const read = keys => keys.reduce((value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined, config);
  // Per-agent overrides could undo a managed workspace, model or tool boundary.
  // Unrelated preferences and credential values are preserved, never logged.
  for (const agent of [config.agents?.defaults, ...(Array.isArray(config.agents?.list) ? config.agents.list : [])]) {
    if (!object(agent)) continue;
    for (const key of ['tools','sandbox','memorySearch','subagents']) assert.ok(!Object.hasOwn(agent,key), 'Unreviewed per-agent security override');
    if (agent !== config.agents?.defaults) for (const key of ['workspace','model']) assert.ok(!Object.hasOwn(agent,key), 'Unreviewed per-agent configuration override');
  }
  const projection = Object.fromEntries(paths.map(keys => ['/'+keys.join('/'), read(keys) ?? null]));
  if (target) {
    assert.ok(paths.every(keys => read(keys) !== undefined && read(keys) !== null), 'Managed configuration path is missing');
    assert.deepEqual(config.gateway, {mode:'local',port:18789,bind:'loopback',auth:{mode:'token'},controlUi:{enabled:false},terminal:{enabled:false},tailscale:{mode:'off'}}, 'Managed gateway policy differs');
    assert.equal(config.agents.defaults.workspace, '/data/workspace');
    const model = config.agents.defaults.model;
    if (object(model)) assert.deepEqual(Object.keys(model), ['primary'], 'Managed model override differs');
    assert.match(object(model) ? model.primary : model, /^opensphere-model-proxy\/[a-zA-Z0-9._:-]{1,160}$/, 'Managed model must use the existing Console proxy');
    assert.equal(config.models.mode, 'replace');
    assert.deepEqual(Object.keys(config.models.providers ?? {}), ['opensphere-model-proxy'], 'Managed model provider differs');
    const provider = config.models.providers['opensphere-model-proxy'];
    assert.deepEqual(Object.keys(provider).sort(), ['agentRuntime','api','apiKey','baseUrl','models']);
    assert.equal(provider.baseUrl, 'http://127.0.0.1:18790/model/v1');
    assert.equal(provider.apiKey, '${OPENSPHERE_MODEL_PROXY_TOKEN}');
    assert.equal(provider.api, 'openai-completions'); assert.deepEqual(provider.agentRuntime, {id:'openclaw'});
    assert.ok(Array.isArray(provider.models) && provider.models.length > 0, 'Managed model inventory is missing');
    assert.deepEqual(config.memory.search, {provider:'none',fallback:'none',sources:['memory'],rememberAcrossConversations:false}, 'Managed memory privacy differs');
    assert.deepEqual(config.plugins, {allow:['opensphere-console-bridge','memory-core'],load:{paths:['/opt/opensphere-integration/opensphere-plugin']},entries:{'opensphere-console-bridge':{enabled:true},'memory-core':{enabled:true}}}, 'Managed plugin boundary differs');
    assert.deepEqual(config.tools, {fs:{workspaceOnly:true},exec:{mode:'deny'},codeMode:false,elevated:{enabled:false},deny:['group:runtime','cron','sessions_spawn']}, 'Managed tool authority differs');
    assert.equal(config.cron.enabled, false, 'Native automation remains disabled');
  }
  return {paths, projection};
}

function initializePersonalHome(binding, {dataRoot = '/data', seedRoot = '/runtime-seed'} = {}) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
  const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k,stable(x[k])])) : x;
  const digest = x => crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(stable(x))).digest('hex');
  const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Managed configuration record shape differs');
  exact(binding, ['schema','ownerDigest','installationDigest','image','bridgeImage','seedSha256','managedSha256','uid']);
  assert.equal(binding.schema, 'opensphere.personal-managed-config/v1');
  for (const key of ['ownerDigest','installationDigest','seedSha256','managedSha256']) assert.match(binding[key], /^[a-f0-9]{64}$/);
  for (const key of ['image','bridgeImage']) assert.match(binding[key], /^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(binding.uid) && binding.uid >= 0);
  if (process.getuid) assert.equal(process.getuid(), binding.uid, 'Personal configuration process owner differs');
  const root = path.resolve(dataRoot), seedDir = path.resolve(seedRoot);
  assert.notEqual(root, path.parse(root).root, 'Personal data root must be a dedicated mount');
  const directories = new Map();
  const inspectDir = (name, rootMount = false) => {
    const s = fs.lstatSync(name);
    assert.ok(s.isDirectory() && !s.isSymbolicLink(), 'Personal directory is not a regular directory');
    assert.ok(s.uid === binding.uid || (rootMount && s.uid === 0), 'Personal directory owner differs');
    const old = directories.get(name); if (old) assert.ok(s.dev === old.dev && s.ino === old.ino, 'Personal directory identity changed');
    else directories.set(name, s);
  };
  inspectDir(root, true); inspectDir(seedDir, true);
  const read = (name, privateFile = true, optional = false) => {
    let s; try {s = fs.lstatSync(name);} catch (e) {if (optional && e.code === 'ENOENT') return null; throw e;}
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, 'Personal configuration must be a regular unlinked file');
    assert.ok(privateFile ? s.uid === binding.uid : [0,binding.uid].includes(s.uid), 'Personal configuration file owner differs');
    if (privateFile && process.platform !== 'win32') assert.equal(s.mode & 0o077, 0, 'Personal configuration file is not private');
    assert.ok(s.size <= 262144, 'Personal configuration file exceeds the byte limit');
    const fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {const opened = fs.fstatSync(fd); assert.ok(opened.dev === s.dev && opened.ino === s.ino, 'Personal file identity changed');
      const bytes = fs.readFileSync(fd); assert.ok(bytes.length <= 262144, 'Personal configuration exceeds the byte limit');
      const after = fs.lstatSync(name); assert.ok(after.dev === s.dev && after.ino === s.ino && !after.isSymbolicLink(), 'Personal file changed while reading');
      return {bytes, sha256:digest(bytes), stat:s};
    } finally {fs.closeSync(fd);}
  };
  const json = record => {try {return JSON.parse(new (require('node:util').TextDecoder)('utf-8',{fatal:true,ignoreBOM:true}).decode(record.bytes));} catch {throw Error('Personal configuration contains invalid JSON or UTF-8');}};
  const seedRecord = read(path.join(seedDir,'openclaw.json'), false);
  assert.equal(seedRecord.sha256, binding.seedSha256, 'Managed configuration seed changed');
  const seed = json(seedRecord), target = managedConfiguration(seed, true);
  assert.equal(digest(target.projection), binding.managedSha256, 'Managed target fields changed');
  // Check every existing path before creating anything, and never follow a
  // personal symlink. These fixed directories contain no destructive reset.
  const relatives = ['config','state','workspace','workspace/skills','home','cache'];
  for (const relative of relatives) {const name = path.join(root,relative); if (fs.existsSync(name) || (()=>{try{fs.lstatSync(name);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}})()) inspectDir(name);}
  for (const relative of relatives) {const name = path.join(root,relative); if (!directories.has(name)) {fs.mkdirSync(name,{mode:0o700});inspectDir(name);}}
  const configPath = path.join(root,'config/openclaw.json'), statePath = path.join(root,'config/.opensphere-managed-config.json');
  const refreshDirs = () => {for (const name of directories.keys()) inspectDir(name, name === root || name === seedDir);};
  const syncDir = () => {if (process.platform === 'win32') return; const fd = fs.openSync(path.dirname(configPath), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}};
  const atomic = (name, bytes, before) => {
    refreshDirs(); const temporary = path.join(path.dirname(name), '.opensphere-config-'+crypto.randomBytes(16).toString('hex'));
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const own = fs.fstatSync(fd); let closed = false, moved = false;
    try {assert.equal(own.uid,binding.uid);fs.writeFileSync(fd,bytes);fs.fchmodSync(fd,0o600);fs.fsyncSync(fd);fs.closeSync(fd);closed = true;
      refreshDirs(); const current = read(name,true,true);
      assert.equal(current?.sha256 ?? null, before?.sha256 ?? null, 'Personal configuration changed before atomic replacement');
      if (before) assert.ok(current.stat.dev === before.stat.dev && current.stat.ino === before.stat.ino, 'Personal configuration identity changed');
      fs.renameSync(temporary,name); moved = true; syncDir(); const written = read(name);
      assert.equal(written.sha256,digest(bytes),'Atomic personal configuration changed after replacement'); return written;
    } finally {if (!closed) fs.closeSync(fd); if (!moved) {let s;try{s=fs.lstatSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}if(s){assert.ok(s.dev===own.dev&&s.ino===own.ino&&!s.isSymbolicLink(),'Temporary configuration identity changed');fs.unlinkSync(temporary);}}}
  };
  const context = {schema:binding.schema,ownerDigest:binding.ownerDigest,installationDigest:binding.installationDigest,uid:binding.uid};
  let stateRecord = read(statePath,true,true), currentRecord = read(configPath,true,true), current = currentRecord ? json(currentRecord) : null;
  const currentManaged = currentRecord ? digest(managedConfiguration(current).projection) : null;
  let state = stateRecord ? json(stateRecord) : null;
  if (stateRecord) assert.ok(state && typeof state === 'object' && !Array.isArray(state), 'Managed configuration checkpoint is not an object');
  if (state) {
    exact(state,['schema','ownerDigest','installationDigest','uid','managedSha256','seedSha256','image','bridgeImage','recordSha256',...(state.pending?['pending']:[])]);
    const {recordSha256,...content} = state; assert.equal(recordSha256,digest(content),'Managed configuration checkpoint hash changed');
    for (const [key,value] of Object.entries(context)) assert.equal(state[key],value,'Managed configuration ownership differs');
  } else if (current) {
    assert.equal(currentManaged,binding.managedSha256,'Existing configuration has no verified managed baseline');
  }
  const commit = (expectedConfig = currentRecord) => {
    const observedConfig = read(configPath);
    assert.ok(expectedConfig && observedConfig.sha256 === expectedConfig.sha256
      && observedConfig.stat.dev === expectedConfig.stat.dev && observedConfig.stat.ino === expectedConfig.stat.ino,
    'Personal configuration changed before checkpoint commit');
    const final = {...context,managedSha256:binding.managedSha256,seedSha256:binding.seedSha256,image:binding.image,bridgeImage:binding.bridgeImage};
    stateRecord = atomic(statePath,JSON.stringify({...final,recordSha256:digest(final)})+'\n',stateRecord);
  };
  if (state?.pending) {
    const pending = state.pending; exact(pending,['seedSha256','image','bridgeImage','beforeSha256','afterSha256','beforeManagedSha256','afterManagedSha256']);
    for (const key of ['seedSha256','image','bridgeImage']) assert.equal(pending[key],binding[key],'Incomplete configuration update requires its exact original target');
    assert.equal(pending.afterManagedSha256,binding.managedSha256);
    if (currentRecord?.sha256 === pending.afterSha256 && currentManaged === pending.afterManagedSha256) {commit();return {operation:'recovered',previousManagedSha256:pending.beforeManagedSha256,managedSha256:binding.managedSha256,seedSha256:binding.seedSha256};}
    assert.equal(currentRecord?.sha256 ?? null,pending.beforeSha256,'Incomplete configuration differs from both checked states');
    assert.equal(currentManaged,pending.beforeManagedSha256,'Incomplete managed configuration differs');
  } else if (state) {
    assert.ok(currentRecord,'Managed configuration file is missing');
    assert.equal(currentManaged,state.managedSha256,'Managed configuration was changed outside its approved update');
  }
  if (current && currentManaged === binding.managedSha256 && !state?.pending) {commit();return {operation:state?'unchanged':'adopted',previousManagedSha256:currentManaged,managedSha256:binding.managedSha256,seedSha256:binding.seedSha256};}
  const after = current ? structuredClone(current) : structuredClone(seed);
  for (const keys of target.paths) {let from = seed, to = after;for(const key of keys.slice(0,-1)){from=from[key];to=to[key];}to[keys.at(-1)] = structuredClone(from[keys.at(-1)]);}
  // Only managed paths may differ; original private values never enter a log.
  const unmanaged = value => {const copy = structuredClone(value);for(const keys of target.paths){let at=copy;for(const key of keys.slice(0,-1))at=at[key];delete at[keys.at(-1)];}return stable(copy);};
  if (current) assert.ok(require('node:util').isDeepStrictEqual(unmanaged(after),unmanaged(current)), 'Unmanaged configuration changed');
  const bytes = JSON.stringify(after,null,2)+'\n', afterSha256 = digest(bytes);
  assert.ok(Buffer.byteLength(bytes) <= 262144, 'Updated personal configuration exceeds the byte limit');
  if (current) assert.ok(require('node:util').isDeepStrictEqual(unmanaged(JSON.parse(bytes)),unmanaged(current)), 'Unmanaged JSON cannot be preserved by serialization');
  const pending = {seedSha256:binding.seedSha256,image:binding.image,bridgeImage:binding.bridgeImage,beforeSha256:currentRecord?.sha256 ?? null,afterSha256,beforeManagedSha256:currentManaged,afterManagedSha256:binding.managedSha256};
  if (state?.pending) assert.deepEqual(state.pending,pending,'Incomplete configuration target bytes changed');
  else {const content = {...context,managedSha256:state?.managedSha256 ?? null,seedSha256:state?.seedSha256 ?? null,image:state?.image ?? null,bridgeImage:state?.bridgeImage ?? null,pending};
    stateRecord = atomic(statePath,JSON.stringify({...content,recordSha256:digest(content)})+'\n',stateRecord);}
  const writtenConfig = atomic(configPath,bytes,currentRecord); commit(writtenConfig);
  return {operation:current?'updated':'created',previousManagedSha256:currentManaged,managedSha256:binding.managedSha256,seedSha256:binding.seedSha256};
}

function personalHomeInitialization(identity, policy, seed) {
  const projection = managedConfiguration(JSON.parse(seed),true).projection;
  const stable = x => Array.isArray(x) ? x.map(stable) : plain(x) ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])) : x;
  const binding = {schema:'opensphere.personal-managed-config/v1',ownerDigest:identity.ownerDigest,installationDigest:identity.installationDigest,
    image:policy.image,bridgeImage:policy.bridgeImage,seedSha256:hash(seed),managedSha256:hash(JSON.stringify(stable(projection))),uid:1000};
  return 'const managedConfiguration='+managedConfiguration.toString()+';try{const result=('+initializePersonalHome.toString()+')('+JSON.stringify(binding)+');console.log(JSON.stringify(result));}catch{throw new Error("Personal managed configuration validation or atomic update failed; private file contents withheld");}';
}
// Only reviewed runtime assets are copied from the digest-pinned C_AI image.
// No test harness, fixtures, personal workspace or credential is in this volume.
const INITIALIZE_INTEGRATION = "const fs=require('node:fs');const root='/app/openclaw-native/';for(const p of ['opensphere-plugin','skills/opensphere-operations'])fs.mkdirSync('/integration/'+p,{recursive:true,mode:0o755});for(const p of ['opensphere-plugin/index.mjs','opensphere-plugin/runtime.mjs','opensphere-plugin/package.json','opensphere-plugin/openclaw.plugin.json','opensphere-plugin/tool-contracts.json','skills/opensphere-operations/SKILL.md']){if(!fs.lstatSync(root+p).isFile())throw Error('Invalid pinned integration asset');fs.copyFileSync(root+p,'/integration/'+p);fs.chmodSync('/integration/'+p,0o644);}";

function renderPersonalRuntimeResources({ identity, policy, nativeConfig }) {
  policy = validatePersonalRuntimePolicy(policy);
  if (!identity || identity.namespace !== NAMESPACE
    || identity.installationDigest !== hash(policy.installationId)) {
    fail('PersonalRuntimeOwnershipMismatch', 'Runtime identity is outside the installation policy');
  }
  const seed = configSeed(nativeConfig), r = policy.resources;
  const initializeHome = personalHomeInitialization(identity, policy, seed);
  const resources = { requests: { cpu: `${r.cpuRequestMilli}m`, memory: `${r.memoryRequestMi}Mi` },
    limits: { cpu: `${r.cpuLimitMilli}m`, memory: `${r.memoryLimitMi}Mi`, 'ephemeral-storage': `${r.temporaryMi}Mi` } };
  const security = { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
    allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
  const configMap = { apiVersion: 'v1', kind: 'ConfigMap', metadata: runtimeMetadata(identity, identity.configName),
    data: { 'openclaw.json': seed } };
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: runtimeMetadata(identity, identity.homeName),
    spec: { accessModes: ['ReadWriteOncePod'], storageClassName: policy.storage.className,
      resources: { requests: { storage: `${policy.storage.sizeGi}Gi` } } } };
  const service = { apiVersion: 'v1', kind: 'Service', metadata: runtimeMetadata(identity),
    spec: { type: 'ClusterIP', selector: { [LABEL]: identity.id },
      ports: [{ name: 'bridge', port: BRIDGE_PORT, targetPort: 'bridge', protocol: 'TCP' }] } };
  const bridgeResources = { requests: { cpu: `${policy.bridgeResources.cpuRequestMilli}m`, memory: `${policy.bridgeResources.memoryRequestMi}Mi` },
    limits: { cpu: `${policy.bridgeResources.cpuLimitMilli}m`, memory: `${policy.bridgeResources.memoryLimitMi}Mi`, 'ephemeral-storage': `${r.temporaryMi}Mi` } };
  const templateDigest = hash(JSON.stringify({ image: policy.image, bridgeImage: policy.bridgeImage, resources, bridgeResources, seed,
    initialization: [initializeHome, INITIALIZE_INTEGRATION], integrationLayout: 'read-only-plugin-and-skill/v1' }));
  const podMetadata = runtimeMetadata(identity);
  delete podMetadata.namespace; delete podMetadata.name;
  podMetadata.annotations[TEMPLATE] = templateDigest;
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: runtimeMetadata(identity),
    spec: { replicas: 1, strategy: { type: 'Recreate' }, revisionHistoryLimit: 1, progressDeadlineSeconds: 600,
      selector: { matchLabels: { [LABEL]: identity.id } }, template: { metadata: podMetadata, spec: {
        serviceAccountName: SERVICE_ACCOUNT, automountServiceAccountToken: false,
        ...(policy.imagePullSecretName ? { imagePullSecrets: [{ name: policy.imagePullSecretName }] } : {}),
        terminationGracePeriodSeconds: 90,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
          fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
        initContainers: [{ name: 'initialize-integration', image: policy.bridgeImage, imagePullPolicy: 'IfNotPresent',
          command: ['node', '-e', INITIALIZE_INTEGRATION], securityContext: security, resources: bridgeResources,
          volumeMounts: [{ name: 'integration', mountPath: '/integration' }, { name: 'bridge-tmp', mountPath: '/tmp' }] },
        { name: 'initialize-personal-home', image: policy.image, imagePullPolicy: 'IfNotPresent',
          command: ['node', '-e', initializeHome], securityContext: security, resources,
          volumeMounts: [{ name: 'home', mountPath: '/data' },
            { name: 'seed', mountPath: '/runtime-seed/openclaw.json', subPath: 'openclaw.json', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }] }],
        containers: [{ name: 'gateway', image: policy.image, imagePullPolicy: 'IfNotPresent',
          args: ['node', 'openclaw.mjs', 'gateway', '--bind', 'loopback', '--port', String(PORT)],
          ports: [{ name: 'gateway', containerPort: PORT, protocol: 'TCP' }], securityContext: security, resources,
          env: [{ name: 'HOME', value: '/data/home' }, { name: 'XDG_CACHE_HOME', value: '/data/cache' },
            { name: 'OPENCLAW_STATE_DIR', value: '/data/state' },
            { name: 'OPENCLAW_CONFIG_PATH', value: '/data/config/openclaw.json' },
            { name: 'OPENCLAW_GATEWAY_TOKEN', valueFrom: { secretKeyRef: { name: identity.secretName, key: 'gateway-token' } } },
            { name: TOKEN_ENV, valueFrom: { secretKeyRef: { name: identity.secretName, key: 'proxy-token' } } }],
          // Kubelet cannot probe a Pod's loopback directly. The private bridge
          // exposes fixed native health paths without exposing its RPC surface.
          startupProbe: { httpGet: { path: '/native-startupz', port: BRIDGE_PORT }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
          readinessProbe: { httpGet: { path: '/native-readyz', port: BRIDGE_PORT }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 },
          livenessProbe: { httpGet: { path: '/native-healthz', port: BRIDGE_PORT }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 6 },
          volumeMounts: [{ name: 'home', mountPath: '/data' }, { name: 'tmp', mountPath: '/tmp' },
            { name: 'integration', mountPath: '/opt/opensphere-integration', readOnly: true },
            { name: 'integration', subPath: 'skills/opensphere-operations', mountPath: '/data/workspace/skills/opensphere-operations', readOnly: true }] },
        { name: 'bridge', image: policy.bridgeImage, imagePullPolicy: 'IfNotPresent',
          command: ['node', '/app/openclaw-local-bridge.cjs'],
          ports: [{ name: 'bridge', containerPort: BRIDGE_PORT, protocol: 'TCP' }], securityContext: security, resources: bridgeResources,
          env: [{ name: 'PORT', value: String(BRIDGE_PORT) },
            { name: 'OPENCLAW_GATEWAY_URL', value: `ws://127.0.0.1:${PORT}` },
            { name: 'OPENCLAW_GATEWAY_TOKEN', valueFrom: { secretKeyRef: { name: identity.secretName, key: 'gateway-token' } } },
            { name: 'OPENSPHERE_R2D2_BRIDGE_TOKEN', valueFrom: { secretKeyRef: { name: identity.secretName, key: 'bridge-token' } } },
            { name: TOKEN_ENV, valueFrom: { secretKeyRef: { name: identity.secretName, key: 'proxy-token' } } }],
          startupProbe: { httpGet: { path: '/healthz', port: 'bridge' }, periodSeconds: 3, timeoutSeconds: 3, failureThreshold: 30 },
          readinessProbe: { httpGet: { path: '/readyz', port: 'bridge' }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 },
          livenessProbe: { httpGet: { path: '/healthz', port: 'bridge' }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 6 },
          volumeMounts: [{ name: 'bridge-tmp', mountPath: '/tmp' }] }],
        volumes: [{ name: 'home', persistentVolumeClaim: { claimName: identity.homeName } },
          { name: 'seed', configMap: { name: identity.configName, defaultMode: 292 } },
          { name: 'integration', emptyDir: { sizeLimit: '16Mi' } },
          { name: 'bridge-tmp', emptyDir: { sizeLimit: `${r.temporaryMi}Mi` } },
          { name: 'tmp', emptyDir: { sizeLimit: `${r.temporaryMi}Mi` } }],
      } } } };
  deployment.metadata.annotations[TEMPLATE] = templateDigest;
  return { configMap, pvc, service, deployment };
}

function assertPersonalRuntimeOwnership(resource, identity, expectedName, kind) {
  if (!resource || resource.kind !== kind || resource.metadata?.name !== expectedName
    || resource.metadata?.namespace !== NAMESPACE
    || resource.metadata?.labels?.['app.kubernetes.io/managed-by'] !== MANAGED
    || resource.metadata?.labels?.[LABEL] !== identity.id
    || resource.metadata?.annotations?.[OWNER] !== identity.ownerDigest
    || resource.metadata?.annotations?.['opensphere.io/r2d2-installation-digest'] !== identity.installationDigest) {
    fail('PersonalRuntimeOwnershipMismatch', 'An existing resource is not owned by this personal runtime');
  }
  return resource;
}

// Setup applies this reviewed prerequisite set before runtime activation. C_AI
// cannot create namespaces, identities, RBAC, network policy or quota itself.
function renderPersonalRuntimePrerequisites({ policy, capacity } = {}) {
  policy = validatePersonalRuntimePolicy(policy);
  if (!plain(capacity)) fail('PersonalRuntimeNotConfigured', 'Explicit runtime namespace capacity is required');
  positive(capacity.maxRuntimes, 'capacity.maxRuntimes', 10000);
  positive(capacity.totalStorageGi, 'capacity.totalStorageGi', 1048576);
  positive(capacity.cpuLimitMilli, 'capacity.cpuLimitMilli', 1048576);
  positive(capacity.memoryLimitMi, 'capacity.memoryLimitMi', 4194304);
  if (capacity.totalStorageGi < policy.storage.sizeGi
    || capacity.cpuLimitMilli < policy.resources.cpuLimitMilli + policy.bridgeResources.cpuLimitMilli
    || capacity.memoryLimitMi < policy.resources.memoryLimitMi + policy.bridgeResources.memoryLimitMi) {
    fail('PersonalRuntimeConfigurationInvalid', 'Namespace capacity cannot fit one approved runtime');
  }
  const metadata = name => ({ name, namespace: NAMESPACE });
  const runtimeSelector = { matchLabels: { 'app.kubernetes.io/name': 'r2d2-openclaw-runtime' } };
  const consolePeer = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'opensphere-console' } },
    podSelector: { matchLabels: { app: 'opensphere-console-osaa-gateway' } } };
  const namespace = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NAMESPACE, labels: {
    'app.kubernetes.io/part-of': 'opensphere-console', 'opensphere.io/scope': 'r2d2-personal-runtimes',
    'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/audit': 'restricted',
    'pod-security.kubernetes.io/warn': 'restricted' } } };
  const sa = { apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata(SERVICE_ACCOUNT), automountServiceAccountToken: false };
  const role = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: metadata('r2d2-personal-runtime-provisioner'), rules: [
    { apiGroups: [''], resources: ['secrets', 'persistentvolumeclaims', 'services'], verbs: ['get', 'create'] },
    { apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'create', 'update'] },
    { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'create', 'update'] },
  ] };
  const binding = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: metadata('r2d2-personal-runtime-provisioner'),
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role.metadata.name },
    subjects: [{ kind: 'ServiceAccount', name: 'opensphere-console-osaa-gateway', namespace: 'opensphere-console' }] };
  const deny = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: metadata('r2d2-default-deny'),
    spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] } };
  const network = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: metadata('r2d2-personal-runtime'),
    spec: { podSelector: runtimeSelector, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [consolePeer], ports: [{ protocol: 'TCP', port: BRIDGE_PORT }] }],
      egress: [{ to: [consolePeer], ports: [{ protocol: 'TCP', port: 8080 }] },
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
        ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }] } };
  const apiIngress = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'r2d2-personal-runtime-to-gateway', namespace: 'opensphere-console' }, spec: {
      podSelector: consolePeer.podSelector, policyTypes: ['Ingress'], ingress: [{ from: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': NAMESPACE } }, podSelector: runtimeSelector }],
      ports: [{ protocol: 'TCP', port: 8080 }] }] } };
  const quota = { apiVersion: 'v1', kind: 'ResourceQuota', metadata: metadata('r2d2-personal-runtime-capacity'), spec: { hard: {
    'count/deployments.apps': String(capacity.maxRuntimes), 'count/services': String(capacity.maxRuntimes),
    'count/persistentvolumeclaims': String(capacity.maxRuntimes),
    // Kubernetes publishes kube-root-ca.crt in every namespace.
    'count/configmaps': String(capacity.maxRuntimes + 1),
    // One additional image-pull Secret may be installed by Setup; runtime Pods
    // can never read it through a Kubernetes identity of their own.
    'count/secrets': String(capacity.maxRuntimes + (policy.imagePullSecretName ? 1 : 0)),
    'count/pods': String(capacity.maxRuntimes * 2), 'requests.storage': `${capacity.totalStorageGi}Gi`,
    'limits.cpu': `${capacity.cpuLimitMilli}m`, 'limits.memory': `${capacity.memoryLimitMi}Mi`,
  } } };
  return [namespace, sa, role, binding, deny, network, apiIngress, quota];
}

module.exports = { NAMESPACE, SERVICE_ACCOUNT, PORT, BRIDGE_PORT, LABEL, OWNER, TEMPLATE, MANAGED, TOKEN_ENV,
  personalRuntimeIdentity, validatePersonalRuntimePolicy, runtimeMetadata, validateToken, configSeed,
  managedConfiguration, initializePersonalHome,
  renderPersonalRuntimeSecret, renderPersonalRuntimeResources, assertPersonalRuntimeOwnership,
  renderPersonalRuntimePrerequisites };
