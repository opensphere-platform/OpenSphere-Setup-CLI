# Setup edge.24 — 클린 설치 의존성 순서 수정

2026-09-03. 상태: 로컬 전체 테스트 316개 통과, 공개 발행 준비. 사용자 요청은 현재 실패한 설치를 정리하고 클린 설치를 준비하는 것이다. 새 bootstrap은 실행하지 않는다.

Console source `787b82193125d6c592b16dd05ce09007a01d0998`, Console version `202609031642`를 고정한다.

## 원인과 수정

edge.23의 C_API는 필수 `opensphere-baseline-monitoring-reader` Secret이 없어 `CreateContainerConfigError`였고 5분 동안 시작되지 못했다. Supabase 4개 Pod는 정상 Ready였다. Setup이 Beszel installer를 C_API Ready 이후 호출해 필수 선행 입력을 뒤늦게 생성하는 순서 오류였다.

뒤이어 C_EXT readiness도 foundation 이후 적용되는 CRD를 먼저 요구한다는 점을 코드에서 확인했다. CRD·신뢰 키가 먼저 적용되고 CRD가 Established인 것을 확인한 뒤 Gitea → Beszel reader 준비 → Supabase/C_API/C_EXT → 나머지 base workload 순서로 설치한다. verified artifact만 사용하고 기존 source/hash/권한/Ready 기준을 보존한다.

Beszel은 C_API가 아직 없으면 재시작하지 않으며, 이미 존재하면 기존대로 갱신·Ready를 확인한다. 조회 실패를 없음으로 취급하지 않는다. C_API installer는 입력 단계에서 reader Secret을 확인하여 이 선행 입력이 없으면 DB 작업·rollout 대기 전에 실패한다. optional Secret이나 임의 빈 credential은 추가하지 않는다.

## 검증

새 테스트는 실제 production orchestration 함수를 실행한다. 이전 게시된 함수에서 missing-reader 오류가 재현되는 것을 확인했다. 수정 함수의 fresh 성공, Beszel 실패 시 API 미실행, CRD Established 실패 시 workload 미실행, prerequisite 누락 시 write 이전 실패, legacy 경로 보존을 검증한다.

Console의 실제 PowerShell fresh/existing consumer 분기와 조회 오류/다른 identity 거부, credential/progress runtime 테스트, Beszel/installer 계약 12개 및 machine contracts가 통과했다. Setup 전체 316개 테스트가 통과했다. 공개 발행·삭제 결과는 완료 뒤 추가한다. 실제 새 클린 설치의 성공을 아직 주장하지 않는다.