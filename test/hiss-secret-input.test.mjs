import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {EMERGENCY_DEADLINE,MAX_INPUT_BYTES,buildHissSecret,hissSecretTarget,readHissSecretInput,writeHissSecret} from '../src/hiss-secret-input.mjs';

// The protected input for the HISS credentials of RKE2 readiness R1 (plan 2026-10-24 §4.2). Values come only from
// stdin; the output and every error name the Secret and its keys, never a value.
const scope={context:'rke2',channel:'edge',consoleUrl:'https://console.example.test'};
const NOW=Date.parse('2026-10-24T03:00:00Z');
const decode=secret=>Object.fromEntries(Object.entries(secret.data).map(([k,v])=>[k,Buffer.from(v,'base64').toString('utf8')]));
const SLACK='https://hooks.slack.com/services/T000/B000/secretpart';

test('fixed names: the emergency receiver and the etcd S3 Secret are one name each; a store Secret is opensphere-backup-<name>',()=>{
 assert.deepEqual(hissSecretTarget('alert-emergency'),{namespace:'monitoring',name:'opensphere-alert-emergency'});
 assert.deepEqual(hissSecretTarget('etcd-s3'),{namespace:'kube-system',name:'opensphere-etcd-s3'});
 assert.deepEqual(hissSecretTarget('backup-store','main'),{namespace:'longhorn-system',name:'opensphere-backup-main'});
 for(const bad of [undefined,'Main','a/b','x'.repeat(41)])assert.throws(()=>hissSecretTarget('backup-store',bad),{code:'INVALID_INPUT'});
 assert.throws(()=>hissSecretTarget('kubeconfig'),{code:'INVALID_INPUT'});
});

test('emergency receiver: Slack webhook only on Slack hosts, SMTP to DNS names, dead-man over https, expiry at the deadline at most',()=>{
 const slack=buildHissSecret('alert-emergency',{receiverKind:'slack',slackApiUrl:SLACK,deadmanUrl:'https://hc-ping.example.com/abc'},{now:NOW});
 assert.deepEqual(Object.keys(decode(slack)),['deadman-url','receiver-kind','slack-api-url']);
 assert.equal(slack.metadata.annotations['opensphere.io/expires-at'],new Date(EMERGENCY_DEADLINE).toISOString());
 assert.equal(buildHissSecret('alert-emergency',{receiverKind:'slack',slackApiUrl:SLACK},{now:NOW,expiresAt:'2026-11-10T00:00:00Z'}).metadata.annotations['opensphere.io/expires-at'],'2026-11-10T00:00:00.000Z');
 assert.throws(()=>buildHissSecret('alert-emergency',{receiverKind:'slack',slackApiUrl:SLACK},{now:NOW,expiresAt:'2027-01-01T00:00:00Z'}),/at the latest/);
 assert.throws(()=>buildHissSecret('alert-emergency',{receiverKind:'slack',slackApiUrl:SLACK},{now:NOW,expiresAt:'2026-10-01T00:00:00Z'}),/future/);
 const smtp=decode(buildHissSecret('alert-emergency',{receiverKind:'smtp',smtpHost:'smtp.example.com',smtpPort:587,from:'alerts@example.com',to:['a@example.com','b@example.com'],
  username:'alerts',password:'pw'},{now:NOW}));
 assert.deepEqual(smtp,{'receiver-kind':'smtp','smtp-auth-password':'pw','smtp-auth-username':'alerts','smtp-from':'alerts@example.com','smtp-require-tls':'true',
  'smtp-smarthost':'smtp.example.com:587','smtp-to':'a@example.com,b@example.com'});
 for(const bad of [
  {receiverKind:'slack',slackApiUrl:'https://evil.example/services/x'},{receiverKind:'slack',slackApiUrl:'http://hooks.slack.com/services/x'},
  {receiverKind:'slack',slackApiUrl:'https://u:p@hooks.slack.com/services/x'},{receiverKind:'slack',slackApiUrl:SLACK,deadmanUrl:'http://hc.example.com/x'},
  {receiverKind:'slack',slackApiUrl:SLACK,extra:'x'},{receiverKind:'pagerduty'},
  {receiverKind:'smtp',smtpHost:'10.0.0.1',smtpPort:25,from:'a@example.com',to:'b@example.com'},
  {receiverKind:'smtp',smtpHost:'localhost',smtpPort:25,from:'a@example.com',to:'b@example.com'},
  {receiverKind:'smtp',smtpHost:'smtp.example.com',smtpPort:'25',from:'a@example.com',to:'b@example.com'},
  {receiverKind:'smtp',smtpHost:'smtp.example.com',smtpPort:25,from:'a@example.com',to:'b@example.com',username:'only-user'},
  {receiverKind:'smtp',smtpHost:'smtp.example.com',smtpPort:25,from:'a@example.com',to:'not-an-address'},
 ])assert.throws(()=>buildHissSecret('alert-emergency',bad,{now:NOW}),{code:'INVALID_INPUT'},JSON.stringify(bad));
});

test('backup store and etcd S3: the key names Longhorn and RKE2 read',()=>{
 const store=decode(buildHissSecret('backup-store',{accessKeyId:'AK',secretAccessKey:'SK',endpoint:'https://s3.example.com/'},{name:'main',now:NOW}));
 assert.deepEqual(store,{AWS_ACCESS_KEY_ID:'AK',AWS_ENDPOINTS:'https://s3.example.com',AWS_SECRET_ACCESS_KEY:'SK'});
 const etcd=decode(buildHissSecret('etcd-s3',{endpoint:'s3.example.com',accessKey:'AK',secretKey:'SK',bucket:'osp-etcd',region:'kr-1',folder:'rke2/etcd',timeout:'5m'},{now:NOW}));
 assert.deepEqual(Object.keys(etcd).sort(),['etcd-s3-access-key','etcd-s3-bucket','etcd-s3-endpoint','etcd-s3-folder','etcd-s3-region','etcd-s3-secret-key','etcd-s3-timeout']);
 assert.throws(()=>buildHissSecret('etcd-s3',{endpoint:'https://s3.example.com',accessKey:'a',secretKey:'b',bucket:'osp-etcd'},{now:NOW}),/without a scheme/);
 assert.throws(()=>buildHissSecret('backup-store',{accessKeyId:'AK',secretAccessKey:'SK',endpoint:'http://s3.example.com'},{name:'main',now:NOW}),{code:'INVALID_INPUT'});
 assert.throws(()=>buildHissSecret('backup-store',{accessKeyId:'AK\nX',secretAccessKey:'SK',endpoint:'https://s3.example.com'},{name:'main',now:NOW}),{code:'INVALID_INPUT'});
});

test('input: a pipe only, bounded, one JSON object',async()=>{
 const tty=Readable.from([]);tty.isTTY=true;
 await assert.rejects(readHissSecretInput(tty),/Pipe the JSON input/);
 await assert.rejects(readHissSecretInput(Readable.from([Buffer.alloc(MAX_INPUT_BYTES+1,'a')])),/too large/);
 await assert.rejects(readHissSecretInput(Readable.from(['{not json'])),/not JSON/);
 assert.deepEqual(await readHissSecretInput(Readable.from(['{"a":1}'])),{a:1});
});

function kube({namespace=true,failApply=false}={}){
 const calls=[];
 const fn=(exe,args,options)=>{assert.equal(exe,'kubectl');calls.push({args:args.slice(2),input:options?.input});const a=args.slice(2);
  if(a[0]==='get'&&a[1]==='namespace')return namespace?'namespace/'+a[2]:'';
  if(a[0]==='apply'){if(failApply)throw Object.assign(Error(`kubectl ${args.join(' ')} failed\nThe Secret "x" is invalid: data[slack-api-url]: Invalid value: "${SLACK}"`),{exitStatus:1});return '';}
  if(a[0]==='-n'&&a[2]==='delete')return '';assert.fail(a.join(' '));};
 return {fn,calls};
}

test('write: server-side apply through stdin; the result and the errors never carry a value',()=>{
 const k=kube();
 const out=writeHissSecret('alert-emergency',{receiverKind:'slack',slackApiUrl:SLACK},scope,{runner:k.fn,now:NOW});
 assert.deepEqual(out,{state:'Applied',secret:'monitoring/opensphere-alert-emergency',keys:['receiver-kind','slack-api-url'],
  expiresAt:new Date(EMERGENCY_DEADLINE).toISOString(),next:'cluster-manager.hiss.alerts.apply part=emergency'});
 const apply=k.calls.find(c=>c.args[0]==='apply');
 assert.ok(apply.args.includes('--server-side')&&apply.args.includes('--field-manager=opensphere-setup-hiss')&&apply.args.includes('-f')&&apply.args.includes('-'));
 assert.ok(!apply.args.join(' ').includes('secretpart'),'no value in the arguments');assert.match(apply.input,/"kind":"Secret"/);
 assert.ok(!JSON.stringify(out).includes('secretpart'));
 const failing=kube({failApply:true});
 assert.throws(()=>writeHissSecret('alert-emergency',{receiverKind:'slack',slackApiUrl:SLACK},scope,{runner:failing.fn,now:NOW}),
  e=>e.code==='KUBECTL_FAILED'&&!e.message.includes('secretpart')&&!e.message.includes('hooks.slack.com')&&/diagnostics withheld/.test(e.message));
 assert.throws(()=>writeHissSecret('alert-emergency',{receiverKind:'slack',slackApiUrl:SLACK},scope,{runner:kube({namespace:false}).fn,now:NOW}),{code:'PREPARATION_BLOCKED'});
});

test('clear: only with the exact Secret name as confirmation',()=>{
 const k=kube();
 assert.throws(()=>writeHissSecret('etcd-s3',undefined,scope,{runner:k.fn,clear:true,confirm:'yes'}),/--confirm opensphere-etcd-s3/);
 assert.deepEqual(writeHissSecret('etcd-s3',undefined,scope,{runner:k.fn,clear:true,confirm:'opensphere-etcd-s3'}),{state:'Removed',secret:'kube-system/opensphere-etcd-s3'});
 assert.deepEqual(k.calls.at(-1).args.slice(0,5),['-n','kube-system','delete','secret','opensphere-etcd-s3']);
});
