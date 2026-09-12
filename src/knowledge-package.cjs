'use strict';
// opensphere.knowledge-package/v1: non-executable release data; no credentials or authority.
const {createHash}=require('node:crypto');
const sha=b=>createHash('sha256').update(b).digest('hex');
const SOURCE='https://github.com/opensphere-platform/OpenSphere-Knowledge';
const MAX_BYTES=4*1024*1024, PART_BYTES=128*1024;
const STRUCTURED=new Set(['10-PLATFORM/PLATFORM-MODULE-MAP.json','30-OPERATIONS/OPERATIONS-INSTALLATION-DEPENDENCIES.json','40-TERMINOLOGY/TERMINOLOGY-NAMES-AND-ALIASES.json']);
function validateLock(lock){
 if(!lock||lock.schema!=='opensphere.knowledge-lock/v1'||lock.source!==SOURCE
 ||!/^[a-f0-9]{64}$/.test(lock.sha256||'')||!/^[a-f0-9]{40}$/.test(lock.sourceRevision||'')
 ||!/^knowledge-v\d+\.\d+\.\d+(?:-(?:edge|beta|rc)\.\d+)?$/.test(lock.version||'')
 ||!/^ghcr\.io\/opensphere-platform\/opensphere-knowledge@sha256:[a-f0-9]{64}$/.test(lock.knowledgeImage||'')
 ||Object.keys(lock).sort().join(',')!=='knowledgeImage,schema,sha256,source,sourceRevision,version')throw Error('Invalid knowledge source lock');
 return lock;
}
function validateBundle(bytes,expected){
 if(Buffer.byteLength(bytes)>MAX_BYTES||!/^[a-f0-9]{64}$/.test(expected)||sha(bytes)!==expected)throw Error('Knowledge bundle digest mismatch or read budget exceeded');
 const b=JSON.parse(bytes);
 if(b.schema!=='opensphere.knowledge-bundle/v1'||b.packageName!=='OpenSphere-Knowledge'||b.executable!==false||b.sourceRepository!==SOURCE
 ||!/^[a-zA-Z0-9._-]{1,80}$/.test(b.version)||!Array.isArray(b.documents)||!b.documents.length||b.documents.length>100)throw Error('Invalid knowledge bundle');
 const ids=new Set();let total=0;
 for(const d of b.documents){
  if(!/^KB-[A-Z0-9-]+$/.test(d.id)||ids.has(d.id)||typeof d.content!=='string'||sha(d.content)!==d.sha256
  ||(!STRUCTURED.has(d.path)&&!/^(10-PLATFORM|20-MODULE|30-OPERATIONS|40-TERMINOLOGY|50-GOVERNANCE)\/[A-Za-z0-9_./-]+\.md$/.test(d.path))
  ||d.path.includes('..')||typeof d.title!=='string'||typeof d.baseline!=='boolean'||d.content.length>100000)throw Error('Invalid knowledge document');
  ids.add(d.id);total+=d.content.length;if(STRUCTURED.has(d.path))JSON.parse(d.content);
 }
 if(total>1000000||b.documents.filter(d=>d.baseline).length!==1)throw Error('Invalid baseline/bundle budget');
 return b;
}
function validatePackage(lock,bytes){validateLock(lock);const b=validateBundle(bytes,lock.sha256);if(b.version!==lock.version)throw Error('Knowledge lock version mismatch');return b;}
function knowledgeConfigMapName(lock){
 validateLock(lock);
 return 'os-knowledge-'+sha(JSON.stringify(Object.fromEntries(Object.keys(lock).sort().map(key=>[key,lock[key]])))).slice(0,32);
}
function packageProjection(lock,bytes){
 const b=validatePackage(lock,bytes),buffer=Buffer.from(bytes);
 const lockText=JSON.stringify(Object.fromEntries(Object.keys(lock).sort().map(key=>[key,lock[key]])));
 // Names bind all provenance as well as content. Immutable objects make rollout/retry atomic per Pod.
 const name=knowledgeConfigMapName(lock);
 const metadata=n=>({name:n,namespace:'opensphere-console',labels:{'app.kubernetes.io/part-of':'opensphere-console','app.kubernetes.io/managed-by':'opensphere-setup-cli','opensphere.io/artifact':'knowledge'},
 annotations:{'opensphere.io/knowledge-version':b.version,'opensphere.io/knowledge-sha256':lock.sha256}});
 const parts=[],maps=[],sources=[];
 for(let at=0;at<buffer.length;at+=PART_BYTES){
  const file='part-'+String(parts.length).padStart(4,'0'),data=buffer.subarray(at,at+PART_BYTES);
  const mapName=name+'-'+parts.length;parts.push({file,bytes:data.length,sha256:sha(data)});
  maps.push({apiVersion:'v1',kind:'ConfigMap',metadata:metadata(mapName),immutable:true,binaryData:{[file]:data.toString('base64')}});
  sources.push({configMap:{name:mapName,items:[{key:file,path:file}]}});
 }
 const index={schema:'opensphere.knowledge-parts/v1',bytes:buffer.length,parts};
 maps.unshift({apiVersion:'v1',kind:'ConfigMap',metadata:metadata(name),immutable:true,data:{'lock.json':lockText,'bundle.parts.json':JSON.stringify(index)}});
 sources.unshift({configMap:{name,items:[{key:'lock.json',path:'lock.json'},{key:'bundle.parts.json',path:'bundle.parts.json'}]}});
 return {configMaps:maps,sources,version:b.version,sha256:lock.sha256};
}
function readBundleBytes(dir,fs,path){
 const whole=path.join(dir,'bundle.json');
 if(fs.existsSync(whole)){if(fs.statSync(whole).size>MAX_BYTES)throw Error('Knowledge artifact exceeds the read budget');return fs.readFileSync(whole);}
 const indexPath=path.join(dir,'bundle.parts.json');
 if(fs.statSync(indexPath).size>8192)throw Error('Knowledge parts index exceeds read budget');
 const index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
 if(index.schema!=='opensphere.knowledge-parts/v1'||!Number.isSafeInteger(index.bytes)||index.bytes<1||index.bytes>MAX_BYTES
 ||!Array.isArray(index.parts)||index.parts.length<1||index.parts.length>32)throw Error('Invalid knowledge parts index');
 const buffers=index.parts.map((p,i)=>{
  if(p.file!=='part-'+String(i).padStart(4,'0')||!Number.isSafeInteger(p.bytes)||p.bytes<1||p.bytes>PART_BYTES)throw Error('Invalid knowledge part');
  const file=path.join(dir,p.file);if(fs.statSync(file).size!==p.bytes)throw Error('Knowledge part length mismatch');
  const bytes=fs.readFileSync(file);if(sha(bytes)!==p.sha256)throw Error('Knowledge part digest mismatch');return bytes;
 });
 const bytes=Buffer.concat(buffers);if(bytes.length!==index.bytes)throw Error('Knowledge parts total mismatch');return bytes;
}
module.exports={SOURCE,MAX_BYTES,validateLock,validateBundle,validatePackage,knowledgeConfigMapName,packageProjection,readBundleBytes};
