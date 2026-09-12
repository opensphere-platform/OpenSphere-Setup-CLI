// Read-only deployment evidence. Delivery is not DB activation or semantic retrieval.
import path from 'node:path';
import {kubectl} from './process.mjs';
import contract from './knowledge-package.cjs';
import delivery from './knowledge-delivery.cjs';
const NS='opensphere-console',NAME='opensphere-console-osaa-gateway';
export function verifyKnowledgeDelivery(lock,{query=kubectl}={}){
 if(!lock.knowledge)return {state:'NotRecorded',activation:'NotObserved',semanticSearch:'NotObserved'};
 contract.validateLock(lock.knowledge);
 const read=(args,max=1024*1024)=>{
  const raw=query(['-n',NS,'get',...args,'-o','json'],{capture:true});
  if(typeof raw!=='string'||Buffer.byteLength(raw)>max)throw Error('Knowledge delivery read exceeds its budget');
  return JSON.parse(raw);
 };
 const metadataName=contract.knowledgeConfigMapName(lock.knowledge);
 const metadata=read(['configmap',metadataName],200*1024);
 const index=JSON.parse(metadata.data?.['bundle.parts.json']||'null');
 if(!index||!Array.isArray(index.parts)||index.parts.length<1||index.parts.length>32)throw Error('Knowledge delivery part inventory is invalid');
 const maps=[metadata],files=new Map(Object.entries(metadata.data||{}).map(([name,data])=>[name,Buffer.from(data)]));
 for(let i=0;i<index.parts.length;i++){
  // A 128 KiB binary part is base64 encoded and kubectl apply may keep a
  // second encoded copy in its last-applied annotation. The payload itself
  // remains bounded and hash-checked by the 128 KiB/4 MiB package contract.
  const cm=read(['configmap',metadataName+'-'+i],512*1024);maps.push(cm);
  for(const [name,data] of Object.entries(cm.binaryData||{})){
   if(files.has(name)||typeof data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw Error('Knowledge delivery contains invalid binary data');
   files.set(name,Buffer.from(data,'base64'));
  }
 }
 const fs={existsSync:p=>files.has(path.posix.basename(p)),statSync:p=>({size:files.get(path.posix.basename(p))?.length}),readFileSync:p=>files.get(path.posix.basename(p))};
 const bytes=contract.readBundleBytes('/data',fs,path.posix);
 const expected=contract.packageProjection(lock.knowledge,bytes);
 for(let i=0;i<maps.length;i++){
  const actual=maps[i],want=expected.configMaps[i];
  if(!want)throw Error('Unexpected Knowledge ConfigMap');
  delivery.verifyConfigMap(actual,want);
 }
 const deployment=read(['deployment',NAME]);
 const response=read(['pods','-l','app='+NAME],4*1024*1024);
 const replicaSets=read(['replicasets','-l','app='+NAME],4*1024*1024);
 const result=delivery.deliveryObservation(deployment,response,lock.components.osaaGateway.image,expected.sources,replicaSets);
 if(result.state!=='Delivered')throw Error('Knowledge Gateway rollout is not current');
 return {state:'Delivered',version:expected.version,documents:contract.validatePackage(lock.knowledge,bytes).documents.length,pods:result.readyPods,immutable:true,readOnly:true,activation:'NotObserved',semanticSearch:'NotObserved'};
}
