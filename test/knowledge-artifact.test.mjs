import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractKnowledgeLayer, materializeKnowledge, materializeKnowledgeDirectory, renderKnowledgeManifest, KNOWLEDGE_SLOT } from '../src/knowledge-artifact.mjs';
import contract from '../src/knowledge-package.cjs';
import { fetchManifest, pruneReleaseResources } from '../src/bootstrap.mjs';
import { verifyKnowledgeDelivery } from '../src/knowledge-delivery.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const imageDigest = b => 'sha256:' + sha(b);
const source = contract.SOURCE;
function bundle(content = 'A synthetic platform baseline.') {
  return Buffer.from(JSON.stringify({ schema: 'opensphere.knowledge-bundle/v1', packageName: 'OpenSphere-Knowledge', version: 'knowledge-v0.1.0-edge.7',
    sourceRepository: source, executable: false, documents: [{ id: 'KB-BASELINE', title: 'Baseline', path: '10-PLATFORM/BASELINE.md', baseline: true, content, sha256: sha(content) }] }));
}
async function archive(entries) {
  const pack = tar.pack(), chunks = [];
  const done = new Promise((resolve, reject) => { pack.on('data', b => chunks.push(b)); pack.on('end', () => resolve(Buffer.concat(chunks))); pack.on('error', reject); });
  for (const [header, bytes] of entries) pack.entry(header, bytes);
  pack.finalize(); return done;
}
async function fixture({ mutateConfig = () => {}, entries, index = false, mutateIndex = () => {} } = {}) {
  const bytes = bundle();
  const raw = await archive(entries || [[{ name: 'knowledge/', type: 'directory' }, null], [{ name: 'knowledge/bundle.json', type: 'file' }, bytes]]);
  const layer = gzipSync(raw), objects = new Map();
  const put = b => { const digest = imageDigest(b); objects.set(digest, b); return { digest, size: b.length }; };
  const config = { architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [imageDigest(raw)] }, config: { Labels: {
    'org.opencontainers.image.source': source, 'org.opencontainers.image.revision': 'a'.repeat(40), 'org.opencontainers.image.version': '202609091615',
    'io.opensphere.source-revision': 'a'.repeat(40), 'io.opensphere.release-tag': '202609091615', 'io.opensphere.channel': 'edge',
    'opensphere.io/build-authority': 'localhost', 'opensphere.io/release-class': 'pre-ga', 'opensphere.io/ga-eligible': 'false' } } };
  mutateConfig(config);
  const descriptor = put(Buffer.from(JSON.stringify(config))); descriptor.mediaType = 'application/vnd.oci.image.config.v1+json';
  const layerDescriptor = put(layer); layerDescriptor.mediaType = 'application/vnd.oci.image.layer.v1.tar+gzip';
  const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: descriptor, layers: [layerDescriptor] };
  let selected = put(Buffer.from(JSON.stringify(manifest)));
  if (index) {
    const body = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ ...selected, mediaType: manifest.mediaType, platform: { os: 'linux', architecture: 'amd64' } }] };
    mutateIndex(body); selected = put(Buffer.from(JSON.stringify(body)));
  }
  const lock = { schema: 'opensphere.knowledge-lock/v1', source, version: 'knowledge-v0.1.0-edge.7', sourceRevision: 'a'.repeat(40), sha256: sha(bytes), knowledgeImage: 'ghcr.io/opensphere-platform/opensphere-knowledge@' + selected.digest };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('https://ghcr.io/token?')) return Response.json({ token: 'fixture-pull-token' });
    assert.match(String(url), /^https:\/\/ghcr.io\/v2\/opensphere-platform\/opensphere-knowledge\/(manifests|blobs)\/sha256:[a-f0-9]{64}$/);
    const object = objects.get(String(url).split('/').at(-1)); assert(object, 'only exact expected digests are requested');
    return new Response(object);
  };
  return { lock, objects, fetchImpl, calls, bytes, layerDescriptor, raw };
}
test('exact data-only OCI bytes become immutable ConfigMaps without Docker, file extraction or new credentials', async () => {
  for (const index of [false, true]) {
    const f = await fixture({ index }), projected = await materializeKnowledge(f.lock, { fetchImpl: f.fetchImpl });
    assert.equal(projected.sha256, f.lock.sha256); assert.equal(projected.configMaps.length, 2);
    assert.equal(projected.registryCredentialsRequired, false);
    assert(f.calls.every(c => !c.options.headers?.authorization?.startsWith('Basic')));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'knowledge-projection-'));
    try {
      for (const cm of projected.configMaps) {
        assert.equal(cm.kind, 'ConfigMap'); assert.equal(cm.immutable, true);
        assert.equal(cm.metadata.namespace, 'opensphere-console');
        assert(Buffer.byteLength(JSON.stringify(cm)) < 200 * 1024, 'client-side apply annotation stays below 256 KiB');
        for (const [file, value] of Object.entries(cm.data || {})) writeFileSync(path.join(dir, file), value);
        for (const [file, value] of Object.entries(cm.binaryData || {})) writeFileSync(path.join(dir, file), Buffer.from(value, 'base64'));
      }
      assert.deepEqual(contract.readBundleBytes(dir, fs, path), f.bytes);
      assert.equal(contract.validatePackage(f.lock, contract.readBundleBytes(dir, fs, path)).documents.length, 1);
      writeFileSync(path.join(dir, 'part-0000'), 'tampered');
      assert.throws(() => contract.readBundleBytes(dir, fs, path), /length mismatch/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
test('native installer receives the exact verified package in its fixed file format', async () => {
  const f = await fixture(); const dir=mkdtempSync(path.join(os.tmpdir(),'knowledge-native-'));
  try {
    await materializeKnowledgeDirectory(f.lock,dir,{fetchImpl:f.fetchImpl});
    assert.deepEqual(contract.readBundleBytes(dir,fs,path),f.bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'lock.json'),'utf8')),f.lock);
    assert.equal(contract.validatePackage(f.lock,contract.readBundleBytes(dir,fs,path)).version,f.lock.version);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('OCI digest and provenance tampering fail before a deployable manifest exists', async () => {
  const f = await fixture(); f.objects.set(f.layerDescriptor.digest, Buffer.from('corrupt'));
  await assert.rejects(materializeKnowledge(f.lock, { fetchImpl: f.fetchImpl }), /digest or length mismatch/);
  for (const mutateConfig of [c => c.config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40), c => c.config.Cmd = ['sh'], c => c.rootfs.diff_ids = ['sha256:' + '0'.repeat(64)]]) {
    const x = await fixture({ mutateConfig }); await assert.rejects(materializeKnowledge(x.lock, { fetchImpl: x.fetchImpl }), /source or data-only|layer digest/);
  }
  const x = await fixture({ index: true, mutateIndex: i => i.manifests.push(i.manifests[0]) });
  await assert.rejects(materializeKnowledge(x.lock, { fetchImpl: x.fetchImpl }), /one deterministic/);
});
test('unexpected files, traversal, links, duplicate entries and truncated archives are rejected', async () => {
  const good = [{ name: 'knowledge/bundle.json', type: 'file' }, bundle()];
  for (const bad of [
    [{ name: '../bundle.json', type: 'file' }, bundle()],
    [{ name: '/knowledge/bundle.json', type: 'file' }, bundle()],
    [{ name: 'knowledge/bundle.json', type: 'symlink', linkname: '/etc/shadow' }, null],
    [{ name: 'knowledge/extra.txt', type: 'file' }, Buffer.from('extra')], good
  ]) await assert.rejects(extractKnowledgeLayer(await archive([good, bad])), /unexpected/);
  const raw = await archive([good]);
  await assert.rejects(extractKnowledgeLayer(raw.subarray(0, 600)), /Unexpected end|length/i);
});
test('GHCR CDN gets no authorization and arbitrary redirect destinations fail', async () => {
  const f = await fixture(), cdn = 'https://pkg-containers.githubusercontent.com/fixture?signature=opaque';
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/blobs/' + f.layerDescriptor.digest)) return new Response(null, { status: 307, headers: { location: cdn } });
    if (url === cdn) { assert.equal(options.headers?.authorization, undefined); assert.equal(options.redirect, 'error'); return new Response(f.objects.get(f.layerDescriptor.digest)); }
    return f.fetchImpl(url, options);
  };
  await materializeKnowledge(f.lock, { fetchImpl });
  await assert.rejects(materializeKnowledge(f.lock, { fetchImpl: async (url, options) => String(url).includes('/blobs/')
    ? new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/private' } }) : f.fetchImpl(url, options) }), /redirect is not allowed/);
});
test('large knowledge uses bounded shards; metadata/part corruption never becomes a readable package', () => {
  const b = JSON.parse(bundle()), content = '문'.repeat(99000);
  b.documents = Array.from({ length: 6 }, (_, i) => ({ ...b.documents[0], id: 'KB-DOC-' + i, baseline: i === 0, content, sha256: sha(content) }));
  const bytes = Buffer.from(JSON.stringify(b)), lock = { schema: 'opensphere.knowledge-lock/v1', source, version: b.version, sourceRevision: 'a'.repeat(40), sha256: sha(bytes), knowledgeImage: 'ghcr.io/opensphere-platform/opensphere-knowledge@sha256:' + 'b'.repeat(64) };
  const result = contract.packageProjection(lock, bytes);
  assert(result.configMaps.length > 3); assert(result.configMaps.every(cm => Buffer.byteLength(JSON.stringify(cm)) < 200 * 1024));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'knowledge-shards-'));
  try {
    for (const cm of result.configMaps) {
      for (const [file, value] of Object.entries(cm.data || {})) writeFileSync(path.join(dir, file), value);
      for (const [file, value] of Object.entries(cm.binaryData || {})) writeFileSync(path.join(dir, file), Buffer.from(value, 'base64'));
    }
    assert.deepEqual(contract.readBundleBytes(dir, fs, path), bytes);
    const indexPath = path.join(dir, 'bundle.parts.json'), index = JSON.parse(fs.readFileSync(indexPath));
    index.parts[0].file = '../escape'; writeFileSync(indexPath, JSON.stringify(index));
    assert.throws(() => contract.readBundleBytes(dir, fs, path), /Invalid knowledge part/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('normal manifest preparation binds exact source lock and places data before the Gateway; errors yield no manifest', async () => {
  const f = await fixture(), seen = [];
  const sourceYaml = 'kind: Deployment\nspec:\n  volumes: [{projected: {sources: ' + KNOWLEDGE_SLOT + '}}]\n';
  const rendered = await renderKnowledgeManifest(sourceYaml, {
    readLock: async p => { seen.push(p); return JSON.stringify(f.lock); },
    materialize: (lock, options) => materializeKnowledge(lock, { ...options, fetchImpl: f.fetchImpl })
  });
  assert.deepEqual(seen, ['apps/osaa-gateway/knowledge-bundle/lock.json']);
  assert(!rendered.includes(KNOWLEDGE_SLOT)); assert(rendered.indexOf('ConfigMap') < rendered.indexOf('Deployment'));
  await assert.rejects(renderKnowledgeManifest(sourceYaml, { readLock: async () => JSON.stringify({ ...f.lock, knowledgeImage: 'ghcr.io/attacker/image:edge' }) }), /Invalid knowledge source lock/);
  await assert.rejects(renderKnowledgeManifest(sourceYaml + KNOWLEDGE_SLOT, { readLock: () => { throw Error('must not read'); } }), /exactly once/);
  assert.equal(await renderKnowledgeManifest('old manifest with image-bundled knowledge'), 'old manifest with image-bundled knowledge');
});
test('actual Setup fetchManifest fetches the Knowledge pointer at the same admitted source revision and forwards registry custody', async () => {
  const f = await fixture(), originalFetch = globalThis.fetch, sourceRevision = 'c'.repeat(40), paths = [];
  const yaml = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - name: gateway\n          image: __OPENSPHERE_OSAA_GATEWAY_IMAGE__\n      volumes: [{projected: {sources: ' + KNOWLEDGE_SLOT + '}}]\n';
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('raw.githubusercontent.com')) {
      paths.push(String(url)); assert(String(url).includes('/' + sourceRevision + '/'));
      return new Response(String(url).endsWith('/lock.json') ? JSON.stringify(f.lock) : yaml);
    }
    if (String(url).startsWith('https://ghcr.io/token?')) {
      if (!options.headers.authorization) return new Response(null, { status: 403 });
      assert.equal(options.headers.authorization, 'Basic ' + Buffer.from('fixture:fixture-only-token-value').toString('base64'));
      return Response.json({ token: 'fixture-pull-token' });
    }
    return f.fetchImpl(url, options);
  };
  try {
    const image = 'ghcr.io/opensphere-platform/opensphere-console-osaa-gateway@sha256:' + 'd'.repeat(64);
    const rendered = await fetchManifest({ channel: 'edge', sourceRevision: 'e'.repeat(40), components: { osaaGateway: { image } } },
      { path: 'apps/osaa-gateway/deploy.yaml', replacements: [['__OPENSPHERE_OSAA_GATEWAY_IMAGE__', 'osaaGateway']] },
      'standard', 'https://localhost:1114', 'development', { sourceRevision, registryCredentials: { username: 'fixture', token: 'fixture-only-token-value' } });
    assert.equal(paths.length, 2); assert(rendered.includes(image)); assert(!rendered.includes('__OPENSPHERE_'));
    assert(rendered.indexOf('ConfigMap') < rendered.indexOf('Deployment'));
  } finally { globalThis.fetch = originalFetch; }
});
test('normal retirement retains Knowledge used by a Pod or active ReplicaSet and retries after references disappear', () => {
  const map = i => ({ apiVersion: 'v1', kind: 'ConfigMap', namespace: 'opensphere-console', name: 'os-knowledge-' + String(i).repeat(32) });
  const refs = [map(1), map(2), map(3)], deleted = [];
  const volumes = name => [{ projected: { sources: [{ configMap: { name } }] } }];
  const read = args => {
    if (args.includes('delete')) { deleted.push(args.find(s => s.startsWith('ConfigMap/'))); return ''; }
    return JSON.stringify({ items: args.includes('pods')
      ? [{ spec: { volumes: volumes(refs[0].name) }, status: { phase: 'Running' } }]
      : [{ spec: { replicas: 1, template: { spec: { volumes: volumes(refs[1].name) } } } }] });
  };
  const retained = pruneReleaseResources(refs, [], read);
  assert.deepEqual(retained, refs.slice(0, 2)); assert.deepEqual(deleted, ['ConfigMap/' + refs[2].name]);
  const again = [];
  assert.deepEqual(pruneReleaseResources(retained, [], args => {
    if (args.includes('delete')) { again.push(args.find(s => s.startsWith('ConfigMap/'))); return ''; }
    return JSON.stringify({ items: [] });
  }), []);
  assert.equal(again.length, 2);
  assert.throws(() => pruneReleaseResources(refs, [], () => JSON.stringify({ error: 'unavailable' })), /Cannot verify/);
});
test('admitted independent pointer overrides the old source pointer and unsupported Gateway fails closed', async () => {
 const f=await fixture();let reads=0;
 const options={admittedLock:f.lock,readLock:async()=>{reads++;throw Error('must not read the old pointer');},materialize:lock=>materializeKnowledge(lock,{fetchImpl:f.fetchImpl})};
 const rendered=await renderKnowledgeManifest('sources: '+KNOWLEDGE_SLOT,options);
 assert.equal(reads,0);assert(rendered.includes(f.lock.version));
 await assert.rejects(renderKnowledgeManifest('old Gateway without data volume',options),/update Gateway first/);
 const corrupted={...f.lock,sha256:'0'.repeat(64)};
 await assert.rejects(renderKnowledgeManifest('sources: '+KNOWLEDGE_SLOT,{...options,admittedLock:corrupted}),/digest mismatch/);
});
test('runtime delivery checks actual immutable bytes and every live Gateway volume, not just Ready labels', async()=>{
 const f=await fixture(),projection=contract.packageProjection(f.lock,f.bytes);
 const lock={knowledge:f.lock,components:{osaaGateway:{image:'ghcr.io/opensphere-platform/opensphere-console-osaa-gateway@sha256:'+'c'.repeat(64)}}};
 const spec={containers:[{name:'gateway',image:lock.components.osaaGateway.image,env:[{name:'OSAA_KNOWLEDGE_BUNDLE_DIR',value:'/var/run/opensphere-knowledge'}],volumeMounts:[{name:'platform-knowledge',mountPath:'/var/run/opensphere-knowledge',readOnly:true}]}],volumes:[{name:'platform-knowledge',projected:{defaultMode:292,sources:projection.sources}}]};
 const make=()=>({
  maps:structuredClone(projection.configMaps),
  deployment:{kind:'Deployment',apiVersion:'apps/v1',
   metadata:{namespace:'opensphere-console',name:'opensphere-console-osaa-gateway',uid:'deployment-1',resourceVersion:'5',generation:3},
   spec:{replicas:2,template:{spec:structuredClone(spec)}},status:{observedGeneration:3,updatedReplicas:2,availableReplicas:2}},
  replicaSets:[{metadata:{namespace:'opensphere-console',uid:'rs-1',ownerReferences:[{controller:true,kind:'Deployment',uid:'deployment-1'}]},
   spec:{template:{spec:structuredClone(spec)}}}],
  pods:[0,1].map(i=>({metadata:{namespace:'opensphere-console',name:'gateway-'+i,uid:'pod-'+i,labels:{app:'opensphere-console-osaa-gateway'},
   ownerReferences:[{controller:true,kind:'ReplicaSet',uid:'rs-1'}]},spec:structuredClone(spec),
   status:{phase:'Running',conditions:[{type:'Ready',status:'True'}]}}))
 });
 const check=state=>verifyKnowledgeDelivery(lock,{query:(args,options)=>{
  assert.equal(options.capture,true,'real kubectl must return JSON rather than inherit stdout');
  assert.deepEqual(args.slice(0,3),['-n','opensphere-console','get']);
  return JSON.stringify(args[3]==='configmap'?state.maps.find(cm=>cm.metadata.name===args[4]):args[3]==='deployment'?state.deployment:{items:args[3]==='replicasets'?state.replicaSets:state.pods});
 }});
 const evidence=check(make());assert.equal(evidence.state,'Delivered');assert.equal(evidence.documents,1);assert.equal(evidence.pods,2);
 assert.equal(evidence.activation,'NotObserved');assert.equal(evidence.semanticSearch,'NotObserved');
 for(const mutate of [s=>{s.maps[1].binaryData['part-0000']=Buffer.from('tampered').toString('base64');},s=>{s.maps[0].immutable=false;},s=>{s.pods[1].spec.volumes[0].projected.sources=[];},s=>{s.pods[0].spec.containers[0].volumeMounts[0].readOnly=false;},s=>{s.deployment.status.observedGeneration=2;},s=>{s.pods.pop();},s=>{s.pods[0].status.conditions=[];}]){
  const state=make();mutate(state);assert.throws(()=>check(state));
 }
 assert.equal(verifyKnowledgeDelivery({}, {query:()=>{throw Error('no unexpected reads');}}).state,'NotRecorded');
});
