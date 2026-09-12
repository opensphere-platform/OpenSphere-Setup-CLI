import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createSetupJournal,publishSetupJournal,STAGES,MAX_JOURNAL_EVENTS} from '../src/setup-journal.mjs';
import {createProgressReporter} from '../src/progress.mjs';
const withFolder=async body=>{const p=await mkdtemp(join(tmpdir(),'setup-journal-test-'));try{await body(p);}finally{await rm(p,{recursive:true,force:true});}};
const options=directory=>({directory,command:'bootstrap',channel:'edge',now:()=>new Date('2026-09-10T00:00:00.000Z'),warn:()=>{}});

test('real progress persists failure, distinguishes implicit advancement, excludes arbitrary inputs',()=>withFolder(async directory=>{
 const journal=createSetupJournal(options(directory)),p=createProgressReporter({journal,write:()=>{}});
 const credential='Bearer synthetic-sensitive-content';
 p.begin(credential,credential);p.step('로컬 실행 환경 fail-fast 검증',credential);
 p.step('kubectl 및 Kubernetes API 연결 확인');p.done(credential);
 p.step(credential);p.item('설치',credential);p.wait(credential);p.fail(new Error(credential));
 const raw=await readFile(journal.path,'utf8'),doc=JSON.parse(raw);
 assert.doesNotMatch(raw,/Bearer|synthetic-sensitive-content/);
 assert.equal(doc.state,'Failed');assert.equal(doc.unknownStages,1);
 assert.equal(doc.currentResourceState,'NotObserved');assert.equal(doc.acceptance,'NotEvaluated');
 assert.deepEqual(doc.events.map(e=>e.kind),['CommandStarted','StageStarted','StageAdvancedWithoutExplicitReturn','StageStarted','StageReturned','StageStarted','StageFailed','CommandFailed']);
 assert.equal((await readdir(directory)).length,1);
}));

test('interrupted process record is not interpreted as live, returned step or success',()=>withFolder(async directory=>{
 const journal=createSetupJournal(options(directory));journal.step('Supabase·Gitea·Beszel backbone 및 OpenSphere workload 적용');
 journal.item('설치','Supabase Data & Identity + Console API/Extension Controller');
 const d=JSON.parse(await readFile(journal.path,'utf8'));
 assert.equal(d.state,'Running');assert.equal(d.endedAt,null);assert.equal(d.processLiveness,'NotObserved');
 assert.equal(d.events.at(-1).stageId,'supabase-api-installer');
 assert.equal(d.events.at(-1).kind,'StageStarted');assert.equal(d.events.some(e=>e.kind==='CommandReturned'),false);
}));

test('doctor never publishes; bootstrap buffers before managed namespace and publishes failure without raw error',()=>withFolder(async directory=>{
 const doctor=createSetupJournal({...options(directory),command:'doctor'});
 assert.throws(()=>doctor.enableDelivery(()=>{}),/Forbidden/);
 const journal=createSetupJournal(options(directory)),writes=[];
 journal.step('입력 옵션과 설치 정책 검증');journal.done();
 assert.equal(writes.length,0);
 journal.enableDelivery(doc=>publishSetupJournal(doc,{apply:(args,opts)=>{assert.equal(opts.spawn.timeout,15000);writes.push({args,body:JSON.parse(opts.input)});}}));
 journal.step('Supabase·Gitea·Beszel backbone 및 OpenSphere workload 적용');
 journal.item('설치','Beszel baseline host observability');journal.fail(new Error('sensitive-fixture'));
 const final=writes.at(-1),d=JSON.parse(final.body.data['journal.json']);
 assert.deepEqual(final.args,['apply','--request-timeout=10s','-f','-']);
 assert.deepEqual(Object.keys(final.body.data),['journal.json']);
 assert.equal(final.body.metadata.name,'opensphere-setup-journal');assert.equal(final.body.metadata.namespace,'opensphere-console');
 assert.equal(d.state,'Failed');assert.equal(d.events.some(e=>e.kind==='StageFailed'&&e.stageId==='beszel-installer'),true);
 assert.doesNotMatch(JSON.stringify(writes),/sensitive-fixture|Secret|ClusterRole|Deployment/);
}));

test('unavailable delivery preserves local file, retries, and prevents false success',()=>withFolder(async directory=>{
 let unavailable=true,calls=0;const warnings=[];
 const journal=createSetupJournal({...options(directory),warn:m=>warnings.push(m)}),p=createProgressReporter({journal,write:()=>{}});
 p.deliverJournal(()=>{calls++;if(unavailable)throw Error('credential-containing upstream error');});
 p.step('입력 옵션과 설치 정책 검증');p.done();
 assert.throws(()=>p.finish('설치 완료'),/SetupJournalDeliveryUnavailable/);p.fail();
 assert.equal(JSON.parse(await readFile(journal.path,'utf8')).state,'Failed');assert.equal(warnings.length,1);
 assert.doesNotMatch(warnings.join(''),/credential-containing/);
 unavailable=false;
 const retry=createSetupJournal(options(directory));retry.enableDelivery(()=>{calls++;});retry.complete();
 assert.equal(retry.snapshot().state,'Returned');assert.notEqual(retry.snapshot().runId,journal.snapshot().runId);assert.equal(calls,5);
 assert.equal(retry.snapshot().acceptance,'NotEvaluated');
}));

test('bounded journal reports dropped records; two runs retain separate local files',()=>withFolder(async directory=>{
 const a=createSetupJournal(options(directory)),b=createSetupJournal(options(directory));
 for(let i=0;i<140;i++){a.step('입력 옵션과 설치 정책 검증');a.done();}
 a.complete();const d=a.snapshot();
 assert.equal(d.events.length,MAX_JOURNAL_EVENTS);assert.equal(d.droppedEvents,26);
 assert.equal(d.events[0].sequence,d.droppedEvents+1);assert.equal(d.events.at(-1).kind,'CommandReturned');
 assert.notEqual(a.path,b.path);assert.equal(JSON.parse(await readFile(b.path,'utf8')).state,'Running');
 assert.ok(Buffer.byteLength(await readFile(a.path,'utf8'))<65536);
}));

test('normal CLI bootstrap input rejection records failure locally before any cluster work',()=>withFolder(async directory=>{
 const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[cli,'bootstrap','--release','edge','--admin-username','anonymous'],{cwd:directory,encoding:'utf8',windowsHide:true});
 assert.notEqual(result.status,0);assert.match(result.stderr,/reserved by Supabase Auth/);
 const folder=join(directory,'.opensphere-setup','journal'),files=await readdir(folder);
 assert.equal(files.length,1);const d=JSON.parse(await readFile(join(folder,files[0]),'utf8'));
 assert.equal(d.state,'Failed');assert.equal(d.events.at(-2).stageId,'bootstrap-input');
 assert.match(result.stdout,/단계 기록/);assert.doesNotMatch(JSON.stringify(d),/anonymous|admin-username/);
}));

test('source progress vocabulary is completely classified and delivery starts only after managed state',async()=>{
 for(const file of ['cli.mjs','bootstrap.mjs']){
  const source=await readFile(new URL('../src/'+file,import.meta.url),'utf8');
  for(const match of source.matchAll(/progress(?:\?)?\.step\(\s*'([^']+)'/g))assert.ok(Object.hasOwn(STAGES,match[1]),'Unclassified static stage: '+match[1]);
 }
 const source=await readFile(new URL('../src/bootstrap.mjs',import.meta.url),'utf8');
 const target=source.indexOf('progress?.deliverJournal?.(');
 assert.ok(target>source.indexOf("ensureNamespace('opensphere-console')"));
 assert.match(source.slice(target-100,target),/installationStateRecorded = true;/);
 assert.equal(source.match(/deliverJournal/g)?.length,1);
});
