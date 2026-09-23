import {kubectl} from './process.mjs';

export const EXTERNAL_CONSOLE_RBAC=Object.freeze([
  {namespace:'default',name:'opensphere-extension-controller-kubernetes-egress-discovery'},
  ...['argocd','crossplane-system'].flatMap(namespace=>[
    {namespace,name:'opensphere-platform-support-runtime'},
    {namespace,name:'opensphere-extension-installation-profile-reader'},
  ]),
]);
const namespace='opensphere-monitoring';
const planName='opensphere-console-purge-plan';
const dataPath='/var/lib/opensphere/beszel-agent';
const read=(args,run)=>{const raw=run([...args,'--ignore-not-found','-o','json'],{capture:true});return raw.trim()?JSON.parse(raw):null;};

export function beszelCleanupJob(node,image,releaseDigest) {
  if(!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(node)||node.length>253)throw Error('Invalid cleanup node');
  if(!/^ghcr\.io\/opensphere-platform\/opensphere-console-beszel-bootstrap@sha256:[a-f0-9]{64}$/.test(image))throw Error('Cleanup requires the installed Beszel bootstrap digest');
  if(!/^sha256:[a-f0-9]{64}$/.test(releaseDigest))throw Error('Invalid cleanup release');
  return {apiVersion:'batch/v1',kind:'Job',metadata:{generateName:'console-purge-beszel-',namespace,
    labels:{'opensphere.io/purge-release':releaseDigest.slice(7,47)}},spec:{backoffLimit:0,activeDeadlineSeconds:180,
    template:{spec:{nodeName:node,restartPolicy:'Never',automountServiceAccountToken:false,
      tolerations:[{operator:'Exists'}],imagePullSecrets:[{name:'opensphere-ghcr-pull'}],
      containers:[{name:'purge',image,command:['/bin/sh','-ec',
        'test -d /state; find /state -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; test -z "$(ls -A /state)"'],
        securityContext:{runAsUser:0,allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},
        resources:{requests:{cpu:'10m',memory:'16Mi'},limits:{cpu:'100m',memory:'64Mi'}},
        volumeMounts:[{name:'state',mountPath:'/state'}]}],
      volumes:[{name:'state',hostPath:{path:dataPath,type:'DirectoryOrCreate'}}]}}}};
}

// Run before namespace deletion so pull credentials and retry evidence remain.
// Stop the agent first; never infer cleanup from a deleted or offline workload.
export function purgeBeszelHostState(lock,{run=kubectl}={}) {
  const image=lock.components?.beszelBootstrap?.image;
  const checkpoint=read(['-n',namespace,'get','configmap',planName],run);
  let plan=checkpoint?JSON.parse(checkpoint.data?.['plan.json']??'null'):null;
  const daemon=read(['-n',namespace,'get','daemonset','beszel-agent'],run);
  if(!plan){
    if(!daemon)return {nodes:[],status:'NotInstalled'};
    if(!daemon.spec?.template?.spec?.volumes?.some(v=>v.hostPath?.path===dataPath))throw Error('Beszel host path differs; refusing cleanup');
    const inventory=JSON.parse(run(['get','nodes','-o','json'],{capture:true}));
    const nodes=inventory.items.map(n=>({name:n.metadata.name,uid:n.metadata.uid}));
    if(!nodes.length||nodes.some(n=>!n.uid))throw Error('Cleanup requires an exact node inventory');
    for(const n of nodes)beszelCleanupJob(n.name,image,lock.releaseDigest);
    plan={releaseDigest:lock.releaseDigest,daemonUid:daemon.metadata.uid,nodes};
    run(['create','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'ConfigMap',metadata:{name:planName,namespace},data:{'plan.json':JSON.stringify(plan)}})});
  }
  if(plan.releaseDigest!==lock.releaseDigest||!Array.isArray(plan.nodes)||!plan.nodes.length||!plan.daemonUid)throw Error('Cleanup checkpoint differs from the installation');
  if(daemon && daemon.metadata.uid!==plan.daemonUid)throw Error('Beszel agent was replaced during purge');
  const current=JSON.parse(run(['get','nodes','-o','json'],{capture:true})).items;
  for(const node of plan.nodes){
    const live=current.find(n=>n.metadata.name===node.name);
    if(live?.metadata.uid!==node.uid||!live.status?.conditions?.some(c=>c.type==='Ready'&&c.status==='True'))throw Error(`Cleanup node is missing, replaced or not Ready: ${node.name}`);
  }
  if(daemon)run(['-n',namespace,'delete','daemonset','beszel-agent','--cascade=foreground','--wait=true','--timeout=180s']);
  for(const node of plan.nodes){
    const created=JSON.parse(run(['create','-f','-','-o','json'],{capture:true,input:JSON.stringify(beszelCleanupJob(node.name,image,lock.releaseDigest))}));
    if(!/^console-purge-beszel-[a-z0-9-]+$/.test(created.metadata?.name??''))throw Error('Invalid cleanup Job identity');
    run(['-n',namespace,'wait','--for=condition=complete','job/'+created.metadata.name,'--timeout=210s'],{capture:true});
    run(['-n',namespace,'delete','job',created.metadata.name,'--wait=true']);
  }
  return {nodes:plan.nodes.map(n=>n.name),status:'Purged'};
}

export function purgeExternalConsoleRbac(lock,{run=kubectl}={}) {
  const checkpointName='opensphere-console-rbac-purge-plan';
  const checkpoint=read(['-n','opensphere-console','get','configmap',checkpointName],run);
  let plan=checkpoint?JSON.parse(checkpoint.data?.['plan.json']??'null'):null;
  if(!plan){
    const resources=[];
    for(const {namespace,name} of EXTERNAL_CONSOLE_RBAC){
      const binding=read(['-n',namespace,'get','rolebinding',name],run);
      const role=read(['-n',namespace,'get','role',name],run);
      if(!binding&&!role)continue;
      if(!binding||binding.roleRef?.kind!=='Role'||binding.roleRef.name!==name
        ||!binding.subjects?.length||binding.subjects.some(s=>s.kind!=='ServiceAccount'||s.namespace!=='opensphere-console'
          ||!['opensphere-extension-controller','opensphere-platform-support-runtime'].includes(s.name)))throw Error(`Shared RBAC ownership differs: ${namespace}/${name}`);
      for(const [kind,resource] of [['rolebinding',binding],['role',role]])if(resource){
        if(!resource.metadata?.uid)throw Error('Missing RBAC identity');
        resources.push({namespace,name,kind,uid:resource.metadata.uid});
      }
    }
    plan={releaseDigest:lock.releaseDigest,resources};
    run(['create','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'ConfigMap',metadata:{name:checkpointName,namespace:'opensphere-console'},data:{'plan.json':JSON.stringify(plan)}})});
  }
  if(plan?.releaseDigest!==lock.releaseDigest||!Array.isArray(plan.resources))throw Error('RBAC cleanup checkpoint differs');
  for(const resource of plan.resources){
    const {namespace,name,kind,uid}=resource;
    if(!EXTERNAL_CONSOLE_RBAC.some(r=>r.namespace===namespace&&r.name===name)||!['role','rolebinding'].includes(kind)||!uid)throw Error('Unexpected RBAC cleanup target');
    const live=read(['-n',namespace,'get',kind,name],run);
    if(!live)continue;
    if(live.metadata?.uid!==uid)throw Error(`Shared RBAC was replaced during purge: ${namespace}/${name}`);
    run(['-n',namespace,'delete',kind,name,'--ignore-not-found','--wait=true']);
  }
}
