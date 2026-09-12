import {randomUUID} from 'node:crypto';
import {mkdirSync, openSync, writeFileSync, closeSync, renameSync} from 'node:fs';
import {join, resolve} from 'node:path';

// Only source-owned vocabulary enters the journal. Details, stdout/stderr,
// arguments, credentials, environment and arbitrary exception text never do.
export const STAGES = Object.freeze({
  '로컬 실행 환경 확인': 'doctor-local',
  'Kubernetes API·노드·권한·StorageClass 확인': 'doctor-cluster',
  '신규 설치 Console 포트 점유 확인': 'doctor-port',
  '릴리스 정책·이미지 공급망 네트워크 검증': 'doctor-release',
  '필수 manifest·migration·installer 전체 다운로드 검증': 'doctor-artifacts',
  '입력 옵션과 설치 정책 검증': 'bootstrap-input',
  '로컬 실행 환경 fail-fast 검증': 'bootstrap-local',
  'kubectl 및 Kubernetes API 연결 확인': 'bootstrap-cluster',
  '기존 OpenSphere 설치 상태와 release lock 확인': 'bootstrap-existing',
  '릴리스 anchor·bootstrap core·available module·독립 CLI artifact 공급망 검증': 'bootstrap-release',
  'release lock 구조와 채널 공급망 재검증': 'bootstrap-lock',
  '설치 상태·endpoint·StorageClass 호환성 확인': 'bootstrap-compatibility',
  'Kubernetes 노드와 StorageClass 사전검증': 'bootstrap-preflight',
  '서명된 release artifact 전체 다운로드와 digest 고정 manifest 생성': 'bootstrap-artifacts',
  '관리 namespace, installation lock과 GHCR image pull 경로 준비': 'bootstrap-namespaces',
  'Console HTTPS 인증서와 TLS Secret 준비': 'bootstrap-tls',
  '내부 runtime Secret과 설치 상태 기록': 'bootstrap-secrets',
  'Supabase·Gitea·Beszel backbone 및 OpenSphere workload 적용': 'bootstrap-apply',
  'Supabase·Gitea·Beszel·C_API·C_EXT·Registry·CLI·Main Shell rollout 대기': 'bootstrap-rollout',
  'Console registry credential 인계 및 Secret 전파 확인': 'bootstrap-registry-handoff',
  'Pod·Service·runtime image·초기 관리자 상태 최종 검증': 'bootstrap-verification',
  '최초 관리자 onboarding 인계': 'bootstrap-onboarding',
});
const CHILDREN = Object.freeze({
  'Gitea Declarative Change Authority': ['gitea-installer','StageStarted'],
  'Gitea bootstrap 및 control-plane credential': ['gitea-installer','StageReturned'],
  'Beszel baseline host observability': ['beszel-installer','StageStarted'],
  'Beszel Hub bootstrap Job 및 Agent restart 검증': ['beszel-installer','StageReturned'],
  'Supabase Data & Identity + Console API/Extension Controller': ['supabase-api-installer','StageStarted'],
  'fresh migration prefix 및 최소권한 C_API/C_EXT runtime': ['supabase-api-installer','StageReturned'],
  'Console native core — OSAA, OSDST/R2D2, OS Shell': ['native-installer','StageStarted'],
  'native core runtime과 exact-release activation evidence': ['native-installer','StageReturned'],
});
export const SETUP_JOURNAL_CONFIGMAP = 'opensphere-setup-journal';
export const MAX_JOURNAL_EVENTS = 256;
export const MAX_JOURNAL_BYTES = 65536;

export function createSetupJournal({directory, command, channel, now=()=>new Date(), warn=console.warn}={}) {
  if (!['bootstrap','doctor'].includes(command)) throw new TypeError('Unsupported journal command');
  const runId=randomUUID();
  const folder=resolve(directory ?? '.opensphere-setup/journal');
  mkdirSync(folder,{recursive:true,mode:0o700});
  const path=join(folder,runId+'.json');
  const timestamp=()=>now().toISOString();
  const document={schema:'opensphere.setup-journal/v1',runId,command,
    channel:['edge','candidate','stable'].includes(channel)?channel:'Unrecognized',
    startedAt:timestamp(),recordedAt:timestamp(),endedAt:null,state:'Running',
    evidenceKind:'InstallerProgress',currentResourceState:'NotObserved',processLiveness:'NotObserved',
    acceptance:'NotEvaluated',rawOutput:'NotCollected',retention:'LocalUntilUserRemoval',
    clusterRetention:'LatestDeliveredInvocationUntilNamespaceRemoval',
    unknownStages:0,droppedEvents:0,events:[]};
  let publisher=null, deliveryError=false, warned=false, current=null, child=null, retryAfter=0;
  function save(deliver=true,force=false) {
    document.recordedAt=timestamp();
    const body=JSON.stringify(document);
    if (Buffer.byteLength(body)>MAX_JOURNAL_BYTES) throw Error('SetupJournalSizeExceeded');
    // New temporary name, exclusive creation; readers see old or complete JSON.
    const temporary=join(folder,runId+'.'+randomUUID()+'.tmp');
    const fd=openSync(temporary,'wx',0o600);
    try {writeFileSync(fd,body,'utf8');} finally {closeSync(fd);}
    renameSync(temporary,path);
    if(publisher&&deliver&&(force||+now()>=retryAfter)){
      try{publisher(JSON.parse(body));deliveryError=false;retryAfter=0;}
      catch{
        deliveryError=true;retryAfter=+now()+15000;
        if(!warned){warn('[설치 기록] 클러스터 전달 실패; 로컬 단계 기록은 보존됩니다. 최종 성공 전에 전달을 재확인합니다.');warned=true;}
      }
    }
  }
  function event(kind,stageId=null){
    const e={sequence:(document.events.at(-1)?.sequence??0)+1,kind,stageId,recordedAt:timestamp()};
    if(document.events.length===MAX_JOURNAL_EVENTS){document.events.shift();document.droppedEvents++;}
    document.events.push(e);
    // Starting a stage delivers preceding returns as well. Avoid one kubectl
    // process per console line; failed delivery backs off, terminal state retries.
    save(['CommandStarted','StageStarted','CommandReturned','CommandFailed'].includes(kind),
      ['CommandReturned','CommandFailed'].includes(kind));
  }
  event('CommandStarted');
  return Object.freeze({path,
    step(message){
      if(current)event('StageAdvancedWithoutExplicitReturn',current);
      current=Object.hasOwn(STAGES,message)?STAGES[message]:'unclassified';
      if(current==='unclassified')document.unknownStages++;
      event('StageStarted',current);
    },
    done(){if(current){event('StageReturned',current);current=null;}},
    item(label,message){
      if(!['설치','완료'].includes(label)||!Object.hasOwn(CHILDREN,message))return;
      const [id,kind]=CHILDREN[message];
      if((label==='설치')!==(kind==='StageStarted'))return;
      child=kind==='StageStarted'?id:null;event(kind,id);
    },
    complete(){
      if(current){event('StageAdvancedWithoutExplicitReturn',current);current=null;}
      document.state='Returned';document.endedAt=timestamp();event('CommandReturned');
      if(publisher&&deliveryError)throw Object.assign(Error('SetupJournalDeliveryUnavailable'),{code:'SetupJournalDeliveryUnavailable'});
    },
    fail(){
      if(document.state==='Failed')return;
      if(child)event('StageFailed',child);
      if(current)event('StageFailed',current);
      document.state='Failed';document.endedAt=timestamp();event('CommandFailed');
    },
    enableDelivery(publish){
      if(command!=='bootstrap'||typeof publish!=='function')throw Error('SetupJournalDeliveryForbidden');
      publisher=publish;save();
    },
    snapshot(){return structuredClone(document);},
  });
}

export function publishSetupJournal(document,{apply}={}) {
  if(document?.schema!=='opensphere.setup-journal/v1'||document.command!=='bootstrap')throw Error('SetupJournalInvalid');
  const input=JSON.stringify({apiVersion:'v1',kind:'ConfigMap',metadata:{
    name:SETUP_JOURNAL_CONFIGMAP,namespace:'opensphere-console',labels:{
      'app.kubernetes.io/managed-by':'opensphere-setup','opensphere.io/evidence-kind':'installer-progress'}},
    data:{'journal.json':JSON.stringify(document)}});
  if(Buffer.byteLength(input)>MAX_JOURNAL_BYTES+2048)throw Error('SetupJournalSizeExceeded');
  // Existing Setup identity only. No C_API/Gateway RBAC, key or DB privilege.
  apply(['apply','--request-timeout=10s','-f','-'],{capture:true,input,spawn:{timeout:15000}});
}
