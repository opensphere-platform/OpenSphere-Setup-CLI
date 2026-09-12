// CON-FR-007/018. Shared data-only OCI parser. Does not confer trust, authenticate,
// extract paths, execute an image or contact a provider. Callers own admission.
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import contract from './knowledge-package.cjs';
export const knowledgeDigest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export const KNOWLEDGE_IMAGE=/^ghcr\.io\/opensphere-platform\/opensphere-knowledge@sha256:[a-f0-9]{64}$/;
const HASH=/^sha256:[a-f0-9]{64}$/;
const MANIFEST=new Set(['application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json']);
const INDEX=new Set(['application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json']);
const CONFIG=new Set(['application/vnd.oci.image.config.v1+json','application/vnd.docker.container.image.v1+json']);
const LAYER=new Set(['application/vnd.oci.image.layer.v1.tar+gzip','application/vnd.docker.image.rootfs.diff.tar.gzip','application/vnd.oci.image.layer.v1.tar']);
const fail=message=>{throw Object.assign(Error(message),{code:'ArtifactRejected',status:422});};
export async function extractKnowledgeLayer(bytes,{createExtract}={}){
 if(typeof createExtract!=='function')throw TypeError('Pinned tar-stream extractor required');
 if(bytes.length>contract.MAX_BYTES+65536)fail('Knowledge tar exceeds read budget');
 const extract=createExtract();let bundle,entries=0;
 const completed=new Promise((resolve,reject)=>{
  extract.on('error',reject);extract.on('finish',()=>bundle?resolve(bundle):reject(Error('Knowledge layer lacks bundle.json')));
  extract.on('entry',(header,stream,next)=>{
   entries++;
   const directory=header.type==='directory'&&['knowledge','knowledge/'].includes(header.name)&&header.size===0;
   const file=header.type==='file'&&header.name==='knowledge/bundle.json'&&!bundle&&Number.isSafeInteger(header.size)&&header.size>0&&header.size<=contract.MAX_BYTES;
   if(entries>3||(!directory&&!file)){stream.on('error',()=>{});extract.destroy(Error('Knowledge layer has unexpected, duplicate or non-regular entry'));return;}
   const chunks=[];let size=0;
   stream.on('error',error=>extract.destroy(error));
   stream.on('data',chunk=>{size+=chunk.length;if(size>contract.MAX_BYTES)extract.destroy(Error('Knowledge entry exceeds read budget'));else chunks.push(chunk);});
   stream.on('end',()=>{if(size!==header.size){extract.destroy(Error('Knowledge tar entry length mismatch'));return;}if(file)bundle=Buffer.concat(chunks);next();});
  });
 });
 extract.end(bytes);return completed;
}
export async function decodeKnowledgeImage(image,{readObject,createExtract,expectedLock}={}){
 if(!KNOWLEDGE_IMAGE.test(image))fail('Invalid Knowledge image reference');
 if(expectedLock)contract.validateLock(expectedLock);
 async function object(kind,descriptor,max){
  if(!HASH.test(descriptor.digest||'')||(descriptor.size!==undefined&&(!Number.isSafeInteger(descriptor.size)||descriptor.size<1||descriptor.size>max)))fail('Invalid Knowledge OCI descriptor');
  const bytes=await readObject(kind,descriptor.digest,max,descriptor.size);
  if(!Buffer.isBuffer(bytes)||bytes.length>max||knowledgeDigest(bytes)!==descriptor.digest||(descriptor.size!==undefined&&bytes.length!==descriptor.size))fail('Knowledge OCI digest or length mismatch');
  return bytes;
 }
 let manifest=JSON.parse(await object('manifests',{digest:image.split('@')[1]},262144));
 if(INDEX.has(manifest.mediaType)){
  if(manifest.schemaVersion!==2||!Array.isArray(manifest.manifests)||manifest.manifests.length>8)fail('Invalid Knowledge image index');
  const entries=manifest.manifests.filter(d=>d.platform?.os==='linux'&&d.platform?.architecture==='amd64');
  if(entries.length!==1)fail('Knowledge data index needs one deterministic linux/amd64 source');
  if(!MANIFEST.has(entries[0].mediaType)||entries[0].urls?.length)fail('Invalid Knowledge manifest descriptor');
  manifest=JSON.parse(await object('manifests',entries[0],262144));
 }
 if(manifest.schemaVersion!==2||!MANIFEST.has(manifest.mediaType)||!Array.isArray(manifest.layers)||manifest.layers.length!==1||!CONFIG.has(manifest.config?.mediaType)||manifest.config.urls?.length)fail('Knowledge must be a data-only single-layer image');
 const config=JSON.parse(await object('blobs',manifest.config,262144)),labels=config.config?.Labels;
 if(labels?.['org.opencontainers.image.source']!==contract.SOURCE||!/^[a-f0-9]{40}$/.test(labels?.['org.opencontainers.image.revision']||'')
  ||labels?.['io.opensphere.source-revision']!==labels['org.opencontainers.image.revision']
  ||!/^\d{12}$/.test(labels?.['org.opencontainers.image.version']||'')||labels?.['io.opensphere.release-tag']!==labels['org.opencontainers.image.version']
  ||config.config?.Entrypoint?.length||config.config?.Cmd?.length||!Array.isArray(config.rootfs?.diff_ids)||config.rootfs.diff_ids.length!==1
  ||config.os!=='linux'||config.architecture!=='amd64')fail('Knowledge OCI source or data-only contract differs');
 if(labels['io.opensphere.channel']!=='edge'||labels['opensphere.io/build-authority']!=='localhost'||labels['opensphere.io/release-class']!=='pre-ga'||labels['opensphere.io/ga-eligible']!=='false')fail('Knowledge edge artifact metadata differs');
 const layer=manifest.layers[0];if(!LAYER.has(layer.mediaType)||layer.urls?.length)fail('Invalid Knowledge layer descriptor');
 const compressed=await object('blobs',layer,contract.MAX_BYTES+65536);
 const raw=layer.mediaType.endsWith('gzip')?gunzipSync(compressed,{maxOutputLength:contract.MAX_BYTES+65536}):compressed;
 if(knowledgeDigest(raw)!==config.rootfs.diff_ids[0])fail('Knowledge uncompressed layer digest mismatch');
 const bytes=await extractKnowledgeLayer(raw,{createExtract}),bundle=JSON.parse(bytes);
 const lock={schema:'opensphere.knowledge-lock/v1',source:contract.SOURCE,sourceRevision:labels['org.opencontainers.image.revision'],
  knowledgeImage:image,version:bundle.version,sha256:knowledgeDigest(bytes).slice(7)};
 contract.validateLock(lock);
 if(expectedLock&&lock.sha256!==expectedLock.sha256)fail('Knowledge bundle digest mismatch');
 if(expectedLock&&Object.keys(lock).some(key=>lock[key]!==expectedLock[key]))fail('Knowledge source or data-only identity differs from admitted lock');
 return {lock,bundleBytes:bytes,projection:contract.packageProjection(lock,bytes),artifactVersion:labels['org.opencontainers.image.version']};
}
