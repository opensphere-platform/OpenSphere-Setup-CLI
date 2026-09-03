# Setup edge.25 — Beszel null 출력 오류 수정 및 클린 설치 준비

2026-09-03. 상태: 수정·실제 오류 재현 및 관련 회귀 검증 완료, 공개 발행·실패 설치 삭제 준비. 사용자가 업데이트 후 클린 설치 준비·보고를 지시했다. 새 bootstrap은 실행하지 않는다.

Console source `4a35cf46d5bcf31118cae25ab4ce2846a719b0db`, version `202609031708`을 고정한다.

## 원인과 수정

edge.24에서 Beszel Hub/Agent/Job/reader Secret이 정상 준비된 뒤, 아직 없는 Console API의 조회 결과에 Trim을 호출해 설치가 중단됐다. production Get-KubectlValue에서 native 무출력은 null이 된다. 기존 테스트는 이 helper를 빈 문자열 반환으로 대체하여 실제 경계를 놓쳤다. 예측 불가능한 인프라 문제가 아니라 게시한 installer와 검증의 결함이다.

공개 PowerShell 7.6.4와 실제 Kubernetes 읽기 전용 조회로 exit 0/null/Trim 예외를 재현했다. null-safe 분기로 수정하고 production helper 및 native no-output fixture를 포함하도록 테스트를 보강했다. 같은 테스트에서 정확한 공개 edge.24 installer가 실패하고 수정본이 통과했다. API 존재 시 refresh, native 오류와 잘못된 identity 거부는 유지했다. 실제 Kubernetes 조회와 수정 분기도 mutation 금지 상태에서 통과했다.

앞선 CRD/trusted-key → Gitea → Beszel → Supabase/API/Controller → 나머지 workload 순서는 그대로다. schema, credential, RBAC, NetworkPolicy, Ready 기준이나 공급망 검증을 완화하지 않았다. 상세 원인 및 근거는 [Console 보고서](https://github.com/opensphere-platform/OpenSphere-console/blob/main/docs/CONSOLE-INSTALL-EDGE25-NULL-OUTPUT-20260903.md)에 있다.

공개 발행, 실행 파일 검증, 현재 실패 설치의 정확한 삭제 범위와 보존 검증은 완료 후 추가한다. 실제 새 클린 설치 성공으로 해석하지 않는다.
