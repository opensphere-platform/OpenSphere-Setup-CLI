import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressReporter, reportReleaseProgress } from '../src/progress.mjs';

test('progress reporter emits ordered steps, completion timing, items and total timing', () => {
  const lines = [];
  let clock = 1_000;
  const progress = createProgressReporter({
    write: (line) => lines.push(line),
    now: () => clock
  });

  progress.begin('OpenSphere bootstrap', 'release=edge');
  progress.step('릴리스 검증', '12 components');
  progress.item('검증', 'console provenance');
  clock = 2_250;
  progress.done('BOM verified');
  progress.step('클러스터 준비');
  clock = 2_500;
  progress.finish('설치 완료', 'https://localhost:8090');

  assert.deepEqual(lines, [
    '[시작] OpenSphere bootstrap — release=edge',
    '[단계 01] 릴리스 검증 — 12 components',
    '[검증] console provenance',
    '[완료 01] 릴리스 검증 — BOM verified (1.3s)',
    '[단계 02] 클러스터 준비',
    '[완료 02] 클러스터 준비 (250ms)',
    '[성공] 설치 완료 — https://localhost:8090 (총 1.5s)'
  ]);
});

test('starting the next step closes the preceding step', () => {
  const lines = [];
  const progress = createProgressReporter({ write: (line) => lines.push(line), now: () => 0 });
  progress.step('첫 단계');
  progress.step('둘째 단계');
  assert.deepEqual(lines, [
    '[단계 01] 첫 단계',
    '[완료 01] 첫 단계 (0ms)',
    '[단계 02] 둘째 단계'
  ]);
});

test('release progress identifies the exact supply-chain gate without exposing credentials', () => {
  const lines = [];
  const progress = createProgressReporter({ write: (line) => lines.push(line), now: () => 0 });
  reportReleaseProgress(progress, {
    type: 'bom-start',
    image: `ghcr.io/opensphere-platform/opensphere-console@sha256:${'a'.repeat(64)}`
  });
  reportReleaseProgress(progress, { type: 'provenance-complete', component: 'supabaseAuth' });
  assert.match(lines[0], /^\[서명\] Release BOM attestation 검증 시작 \(sha256:a{64}\)$/);
  assert.equal(lines[1], '[공급망] supabaseAuth provenance 검증 완료');
});
