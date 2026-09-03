# Console 설치 SQL 오류 복구 — Setup edge.22

2026-09-03. 상태: Setup 전체 300개 회귀 통과, 공개 발행 및 실제 복구 결과는 완료 후 기록.

## 문제

Console `202609031353` 설치 스크립트가 PostgreSQL 예약어 `current_role`을 테이블 별칭으로 사용해 최초 Supabase 초기화 중 실패했다. 공개 edge.21 doctor는 실제 GHCR 21개 artifact와 설치 자료 47개를 검증했지만 installer SQL은 실행하지 않았다. 앞선 GHCR 404는 이미지 발행 후 해소됐으며 이번 실패와 구분한다.

Console 수정 소스는 `3d50f630a6273085e66b6a76fcd5cc8889f9ca40`다. alias를 수정하고 실제 설치 SQL의 PostgreSQL 실행을 CI에 추가했다. 기존 migration 원본과 기존 image tag는 덮어쓰지 않는다.

## Setup의 최소 변경

기존 upgrade는 OAuth credential을 무조건 거부해, 아직 Console이 뜨지 않은 Failed 최초 설치를 Console 재인증으로 복구할 수 없었다. edge.22는 임시 OAuth를 기존/대상 release 공급망 검증에만 사용한다. `ensureRegistryPullSecrets`에는 임시 OAuth credential을 넘기지 않고 이미 설치된 운영 owner/pull Secret을 보존한다.

새 read:packages OAuth 토큰으로 runtime refresh authority를 교체하지 않는다. 운영 Secret이 누락되거나 불완전하면 workload 적용 전에 실패한다. 운영 credential 자체가 만료된 경우 별도 재인증·복구가 필요하며 이 변경으로 자동 회전하지 않는다. rollback/target materialization, exact source/digest 및 기존 StorageClass/origin 조건은 유지한다.

repository/process/datastore/framework/dependency 추가: 0. 새 설치 명령이나 임시 source 검증 우회 옵션도 추가하지 않는다.

## 복구 명령

수정 Console edge 및 Setup edge.22가 실제 발행된 뒤, 기존 설치가 남은 동일 context에서 실행한다.

```powershell
.\opensphere-setup.exe --channel edge upgrade --release edge --context docker-desktop --registry-auth oauth
```

기존 bootstrap 재실행은 이전 cluster lock의 잘못된 installer를 다시 받으므로 이번 릴리스 결함의 해결 방법이 아니다. upgrade는 target을 명시적으로 바꾸는 기존 경로다. PVC, Gitea repository, Supabase Secret, TLS, runtime registry owner Secret을 삭제하지 않는다. Developer/WWW namespace도 변경하지 않는다.

새 설치는 수정 릴리스의 bootstrap을 사용한다. 실제 설치·Ready·cold-pull·runtime 갱신 검증은 공개 발행이나 단위 테스트 성공과 별도다.
