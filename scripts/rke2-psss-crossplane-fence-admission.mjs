// RKE2 API-schema admission of the candidate fence; no object is persisted.
import {execFileSync} from 'node:child_process';
import {POLICY,BINDING,POLICY_NAME,matchesWriterFence} from '../src/psss-crossplane-writer-fence.mjs';
const host='cmars@10.10.1.31';
const base='sudo -n /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml --context default';
function remote(command,input){return execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8',host,base+' '+command],
 {input,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true});}
const actual=[];
for(const row of [POLICY,BINDING]){
 const admitted=JSON.parse(remote('create --dry-run=server -f - -o json',JSON.stringify(row)));
 actual.push(admitted);
}
if(!matchesWriterFence(...actual))throw Error('Admission changed the reviewed writer fence: '+
 JSON.stringify(actual.map((row,index)=>({kind:row.kind,spec:row.spec,expected:[POLICY,BINDING][index].spec}))));
for(const kind of ['validatingadmissionpolicy','validatingadmissionpolicybinding']){
 const found=remote(`get ${kind} ${POLICY_NAME} --ignore-not-found -o name`);
 if(found.trim())throw Error('Candidate writer fence was unexpectedly persisted');
}
process.stdout.write(JSON.stringify({cluster:'10.10.1.31',policy:POLICY_NAME,admitted:2,persisted:false})+'\n');
