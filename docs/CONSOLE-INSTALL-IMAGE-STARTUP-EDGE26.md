# Setup edge.26 — 실제 Console API 이미지 검증 및 클린 설치 준비

2026-09-03. 상태: 패키징 수정, 기존 공개 이미지 실패 재현, 수정 이미지의 실제 DB/HTTP 기동 검증 완료. 공개 발행 및 현재 실패 설치 삭제 준비. 사용자 요청에 따라 새 bootstrap은 실행하지 않는다.

Console source `101f770c5691ac905838c4bd2476d5b0bd02e1e8`, version `202609031742`를 고정한다.

## 문제와 변경

edge.25에서는 Secret/Beszel/Supabase가 준비됐지만 API 이미지가 runtime/package.json을 누락해 CommonJS contract를 ESM으로 해석했고 시작 직후 종료했다. 호스트 소스 E2E에는 package boundary가 존재했고 이미지 검증은 build/OCI metadata까지만 수행해 이를 놓쳤다. 앞선 Secret/PowerShell null 오류와 직접 원인은 다르지만 실제 배포 산출물 검증 공백의 문제다.

runtime/package.json을 이미지에 포함하고 commonjs를 명시했다. 새 검증은 완성된 이미지의 기본 entrypoint/UID 1001을 사용한다. 임시 internal Docker network/PostgreSQL/시험 credential만 사용해 실제 runtime DB role 연결, HTTP 200/Ready, 잘못된 DB 인증의 HTTP 503, 재시작 0을 검증하고 임시 자원을 제거한다. 운영 K8s 데이터·Secret·호스트 source mount·호스트 포트는 사용하지 않는다.

Validate CI의 API build 직후 이 검증을 수행한다. 현재 로컬 edge publisher는 exact API digest의 기동 검증을 통과해야 date/edge를 전환한다. 이미지 재사용 경로에도 동일하게 적용한다. OCI 플랫폼·labels·digest 검사 메시지는 실제 실행 검사와 구분한다. candidate/stable은 기존 HOLD 유지. schema, credential, RBAC, NetworkPolicy와 Ready 판정을 완화하지 않았다.

기존 공개 edge.25 이미지가 새 검증에서 알려진 모듈 오류로 실패했고 수정 이미지가 통과했다. API 패키징/릴리스 관련 계약 테스트 23개 및 bootstrap-core machine contracts도 통과했다. 상세 근거는 [Console 보고서](https://github.com/opensphere-platform/OpenSphere-console/blob/main/docs/CONSOLE-INSTALL-EDGE26-IMAGE-STARTUP-20260903.md)를 따른다.

공개 발행·실행·삭제 결과는 완료 후 추가한다. API 이미지 기동/DB Ready와 전체 Kubernetes bootstrap 성공을 구분한다.
