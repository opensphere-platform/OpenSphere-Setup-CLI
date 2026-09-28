// Read-only RKE2 acceptance probe for the pinned PSSS authority transition.
// The only PATCH requests use Kubernetes server dry-run and never persist.
import {execFileSync} from 'node:child_process';
import {PROFILE} from '../src/psss-argocd-rbac-profile.mjs';
import {planPsssArgoRbac,psssArgoPatchOperations} from '../src/psss-argocd-rbac-transition.mjs';
const host='cmars@10.10.1.31';
const kubectl='sudo -n /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml --context default';
const scope={context:'default',clusterUid:'8cdee47b-abb7-4dba-b989-cf9ca292efcb',
  consoleUrl:'https://console.opensphere.triangles.com',channel:'edge'};
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
function remote(args,input){
 try{return execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8',host,kubectl+' '+args],
  {input,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,windowsHide:true});}
 catch(error){throw Error('RKE2 admission probe failed: '+String(error.stderr||error.message).slice(0,600));}
}
const client={
 async readClusterUid(){return JSON.parse(remote('get namespace kube-system -o json')).metadata.uid;},
 async read(row){const resource=row.kind.toLowerCase(),ns=row.namespace?'-n argocd ':'';
  const raw=remote('get '+ns+resource+' '+row.name+' --ignore-not-found -o json');return raw.trim()?JSON.parse(raw):null;},
};
const plan=await planPsssArgoRbac(scope,{client});
if(plan.state!=='NeedsPreparation'||plan.resources.some(row=>row.state!=='NeedsPreparation'))
 throw Error('RKE2 did not match the six exact pinned original Argo roles');
const admitted=[];
for(const row of PROFILE.resources){
 const current=await client.read(row),ops=psssArgoPatchOperations(row,current);
 const ns=row.namespace?'-n argocd ':'';
 const output=JSON.parse(remote('patch '+ns+row.kind.toLowerCase()+' '+row.name+
  ' --type=json --patch-file=/dev/stdin --dry-run=server -o json',JSON.stringify(ops)));
 if(output.metadata?.uid!==current.metadata.uid||JSON.stringify(ordered(output.rules))!==JSON.stringify(ordered(row.next)))
  throw Error('RKE2 dry-run result differs from the fixed role: '+row.kind+'/'+row.name);
 admitted.push(row.kind+'/'+row.name);
}
const after=await planPsssArgoRbac(scope,{client});
if(after.state!=='NeedsPreparation'||after.resources.some(row=>row.state!=='NeedsPreparation'))
 throw Error('Server dry-run persisted or altered an Argo role');
process.stdout.write(JSON.stringify({clusterUid:scope.clusterUid,planState:plan.state,
 profileSha256:plan.profileSha256,admitted,afterState:after.state,persisted:false})+'\n');
