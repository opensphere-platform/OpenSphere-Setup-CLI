import {createInterface} from 'node:readline/promises';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve, join} from 'node:path';
import {kubectl} from './process.mjs';
import {normalizeConsoleUrl} from './console-url.mjs';
import {assertStorageProfile} from './storage-profile.mjs';
import {DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB} from './doctor.mjs';

export function createTerminalQuestions(input=process.stdin,output=process.stdout) {
  const reader=createInterface({input,output});
  const ended=new AbortController();
  reader.once('close',()=>ended.abort());
  reader.once('SIGINT',()=>reader.close());
  return {
    async ask(question) {
      if(ended.signal.aborted)throw Error('Administrator input ended; installation cancelled');
      try{return await reader.question(question,{signal:ended.signal});}
      catch(error){if(ended.signal.aborted)throw Error('Administrator input ended; installation cancelled');throw error;}
    },
    close:()=>reader.close(),
  };
}

export function readBootstrapEnvironment() {
  const context=kubectl(['config','view','--minify','-o','jsonpath={.current-context}'],{capture:true});
  const classes=JSON.parse(kubectl(['get','storageclass','-o','json'],{capture:true})).items;
  const raw=kubectl(['-n','opensphere-console','get','configmap','opensphere-installation-lock','--ignore-not-found','-o','json'],{capture:true});
  const installed=raw.trim()?JSON.parse(JSON.parse(raw).data['config.json']):null;
  if(installed && (installed.kind!=='OpenSphereInstallationConfig'||!installed.consoleUrl||!installed.storageClass))throw Error('Existing installation configuration is incomplete');
  return {context,classes,installed};
}

// Gather the administrator's decision before authentication, lock migration or
// cluster mutation. Conversation history is deliberately not an input source.
export async function collectBootstrapInput({channel,consoleUrl,storageClass,nonInteractive=false,yes=false}, {
  interactive=Boolean(process.stdin.isTTY&&process.stdout.isTTY),
  readEnvironment=readBootstrapEnvironment,ask,write=line=>console.log(line),
  now=()=>new Date().toISOString(),
}={}) {
  if(nonInteractive && (!yes||!consoleUrl||!storageClass))throw Error('Unattended bootstrap requires --non-interactive --yes --console and --storage-class');
  if(!nonInteractive && !interactive)throw Error('Bootstrap requires an interactive administrator terminal; automation must explicitly supply --non-interactive --yes --console and --storage-class');
  if(yes&&!nonInteractive)throw Error('--yes requires --non-interactive; interactive bootstrap asks the administrator');
  if(consoleUrl)consoleUrl=normalizeConsoleUrl(consoleUrl);
  const {context,classes,installed}=await readEnvironment();
  if(!context||!Array.isArray(classes)||!classes.length)throw Error('A Kubernetes context and available StorageClass are required');
  if(installed && ((consoleUrl&&consoleUrl!==normalizeConsoleUrl(installed.consoleUrl))||(storageClass&&storageClass!==installed.storageClass)))throw Error('Existing Console URL or StorageClass differs; bootstrap cannot perform an endpoint or storage migration');
  const available=classes.map(item=>{
    try {assertStorageProfile(item,channel);return {item};} catch(error){return {item,error:error.message};}
  });
  if(!available.some(entry=>!entry.error))throw Error('No StorageClass satisfies this release channel');
  const selectStorage=value=>{
    const entry=available.find(entry=>entry.item.metadata.name===value);
    if(!entry)throw Error('Select an existing StorageClass');
    if(entry.error)throw Error(entry.error);
    return entry.item.metadata.name;
  };
  let reader;
  try {
    if(!nonInteractive) {
      if(!ask){reader=createTerminalQuestions();ask=reader.ask;}
      const question=async text=>{
        const value=await ask(text);
        if(typeof value!=='string')throw Error('Administrator input ended; installation cancelled');
        return value.trim();
      };
      write(`설치 대상 Kubernetes context: ${context}`);
      if(installed){
        consoleUrl=normalizeConsoleUrl(installed.consoleUrl);storageClass=selectStorage(installed.storageClass);
        write('기존 설치를 같은 주소와 저장소로 재개합니다.');
      }else{
        write('Console 접속 주소를 입력하세요. 예: https://localhost:1114 또는 관리자가 준비한 HTTPS 도메인');
        write('도메인 DNS와 접속 IP는 관리자가 준비해야 합니다. Setup은 DNS 레코드를 자동 등록하지 않습니다.');
        while(true){
          const value=await question(`Console URL${consoleUrl?` [${consoleUrl}]`:''}: `);
          try {consoleUrl=normalizeConsoleUrl(value||consoleUrl);break;}catch{write('유효한 HTTPS 주소를 입력하세요. localhost 개발 환경만 HTTP도 허용합니다.');}
        }
        write(`Console 신규 데이터 저장소: 총 ${DOCTOR_PERSISTENT_VOLUME_REQUEST_GIB}Gi 요청. Longhorn은 필수가 아닙니다.`);
        available.forEach(({item,error},index)=>write(`${index+1}. ${item.metadata.name} (${item.provisioner})${error?' — 이 채널에서 사용 불가':''}`));
        while(true){
          const value=await question(`StorageClass 번호 또는 이름${storageClass?` [${storageClass}]`:''}: `);
          const selected=/^[1-9][0-9]*$/.test(value)?available[Number(value)-1]?.item.metadata.name:value||storageClass;
          try{storageClass=selectStorage(selected);break;}catch(error){write(error.message);}
        }
      }
      write(`설치 확인: context=${context}, Console=${consoleUrl}, StorageClass=${storageClass}, channel=${channel}`);
      if(!/^(yes|y|예)$/i.test(await question('이 설정으로 진행하시겠습니까? [y/N]: ')))throw Error('Administrator cancelled bootstrap before installation');
    }else{
      storageClass=selectStorage(storageClass);
    }
    return {schemaVersion:'1.0',kind:'OpenSphereBootstrapInput',mode:nonInteractive?'explicit-automation':'administrator-terminal',confirmedAt:now(),context,channel,consoleUrl,storageClass,installation:installed?'resume':'fresh'};
  } finally {reader?.close();}
}

export async function saveBootstrapInput(input,folder=resolve('.opensphere-setup','inputs')) {
  // Closed non-secret fields only: never persist argv, environment or tokens.
  const receipt=Object.fromEntries(['schemaVersion','kind','mode','confirmedAt','context','channel','consoleUrl','storageClass','installation'].map(key=>[key,input[key]]));
  await mkdir(folder,{recursive:true});
  const path=join(folder,randomUUID()+'.json');
  await writeFile(path,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  return path;
}
