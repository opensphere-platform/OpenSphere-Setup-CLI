function duration(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function suffix(detail) {
  return detail ? ` — ${detail}` : '';
}

export function createProgressReporter({
  write = (line) => console.log(line),
  now = () => Date.now(),
  journal = null
} = {}) {
  const startedAt = now();
  let sequence = 0;
  let current;

  function completeCurrent(detail, explicit = true) {
    if (!current) return;
    write(
      `[${explicit ? '완료' : '이동'} ${String(current.number).padStart(2, '0')}] ${current.message}`
      + suffix(detail)
      + (explicit ? '' : ' — 명시적 단계 반환 기록 없음')
      + ` (${duration(Math.max(0, now() - current.startedAt))})`
    );
    current = undefined;
  }

  return Object.freeze({
    begin(message, detail) {
      write(`[시작] ${message}${suffix(detail)}`);
    },
    step(message, detail) {
      journal?.step(message);
      completeCurrent(undefined, false);
      sequence += 1;
      current = { number: sequence, message, startedAt: now() };
      write(`[단계 ${String(sequence).padStart(2, '0')}] ${message}${suffix(detail)}`);
    },
    done(detail) {
      journal?.done();
      completeCurrent(detail);
    },
    item(label, message) {
      journal?.item(label, message);
      write(`[${label}] ${message}`);
    },
    wait(message, detail) {
      write(`[대기] ${message}${suffix(detail)}`);
    },
    finish(message, detail) {
      journal?.complete();
      completeCurrent(undefined, false);
      write(`[성공] ${message}${suffix(detail)} (총 ${duration(Math.max(0, now() - startedAt))})`);
    },
    fail() { journal?.fail(); },
    deliverJournal(publish) { journal?.enableDelivery(publish); }
  });
}

function imageDigest(image = '') {
  return String(image).split('@')[1] ?? image;
}

export function reportReleaseProgress(progress, event) {
  if (!progress || !event) return;
  const component = event.component ?? 'console';
  switch (event.type) {
    case 'anchor-start':
      progress.item('릴리스', `${event.repository}:${event.reference} anchor 해석`);
      break;
    case 'anchor-complete':
      progress.item('릴리스', `console anchor 고정 (${imageDigest(event.image)})`);
      break;
    case 'bom-start':
      progress.item('서명', `Release BOM attestation 검증 시작 (${imageDigest(event.image)})`);
      break;
    case 'bom-complete':
      progress.item('서명', `Release BOM attestation 검증 완료 (${event.channel})`);
      break;
    case 'local-verification-start':
      progress.item('개발 신뢰', `localhost edge 라벨·immutable tag 검증 시작 (${imageDigest(event.image)})`);
      break;
    case 'local-verification-complete':
      progress.item('개발 신뢰', `localhost edge 검증 완료 (${event.channel})`);
      break;
    case 'local-component-start':
      progress.item('레지스트리', `${component} local immutable tag·라벨 검사`);
      break;
    case 'local-component-complete':
      progress.item('레지스트리', `${component} local edge 일치 (${imageDigest(event.image)})`);
      break;
    case 'local-auxiliary-start':
      progress.item('보조 artifact', `${component} local immutable tag·라벨 검사`);
      break;
    case 'local-auxiliary-complete':
      progress.item('보조 artifact', `${component} local edge 일치 (${imageDigest(event.image)})`);
      break;
    case 'component-start':
      progress.item('레지스트리', `${component} digest·source revision 검사`);
      break;
    case 'component-complete':
      progress.item('레지스트리', `${component} 일치 (${imageDigest(event.image)})`);
      break;
    case 'provenance-start':
      progress.item('공급망', `${component} provenance 검증 시작`);
      break;
    case 'provenance-complete':
      progress.item('공급망', `${component} provenance 검증 완료`);
      break;
    case 'sbom-start':
      progress.item('SBOM', `${component} SPDX 검증 시작`);
      break;
    case 'sbom-complete':
      progress.item('SBOM', `${component} SPDX 검증 완료`);
      break;
    default:
      break;
  }
}
