# OAuth edge.21 발행·검증 상태

2026-09-03. 사용자 요청: OAuth 인증을 포함한 새 공개 Setup 버전 발행. 발행 권한은 기존 요청으로 제공됐다. 추가 승인 요청 없이 main과 5-platform 공개 워크플로로 진행한다.

## 발행 상태

- 후보: setup-v0.5.0-edge.21. 이 문서 작성 시점은 공개 워크플로 실행 전이다. 성공한 Actions run과 불변 GitHub Release가 발행 완료의 근거다.
- package/CLI/channel을 edge.21로 일치시켰다. edge.20 릴리스와 자산은 수정·삭제하지 않는다. candidate/stable은 계속 HOLD다.
- 사용자 제공 공개 Client ID: Ov23lijzo43hyJMnNcMb. Device Flow 시작 및 실제 사용자 승인을 확인했다. Client Secret/PAT는 내장하지 않았다.

## 실제 검증 — 2026-09-03 03:41 UTC

| 항목 | 결과 |
|---|---|
| GitHub 사용자 인증 | 성공; opensphere-platform, read:packages |
| 접근 토큰 / 갱신 토큰 | 8시간 접근 토큰과 refresh token 발급 |
| refresh / identity | 성공; 동일 계정 유지 |
| 갱신 전 접근 토큰 | 거부됨; PermissionDenied |
| GHCR opensphere-console:edge | 갱신 전후 HTTP 404, MANIFEST_UNKNOWN |
| 고정 digest 접근 / 전체 릴리스 정책 | 선행 manifest 실패로 검증하지 못함 |
| Console 설치 / Secret 인계 / cold-pull | 미실행; 현재 Console 운영 인계는 미발행 |

인증 성공을 GHCR pull 성공으로 표시하지 않는다. 404는 패키지·태그 부재와 접근 제한을 구분하지 못한다. GitHub GHCR 문서는 여전히 PAT classic을 사용자 인증 수단으로 안내하므로, OAuth GHCR 호환성을 보장하지 않는다. opt-in edge 시험 기능으로 발행하고 README와 Release Notes에 같은 한계를 명시한다.

원본 진단의 org packages API 404는 계정 유형(User)에 맞지 않는 경로에서 발생했다. 패키지 부재나 권한의 증거로 쓰지 않는다. 기존 GCM credential의 scope는 gist/repo/workflow로 read:packages가 없어 그 credential의 GHCR 실패도 독립적인 부재 증거가 아니다. 과거 Console Actions 성공은 현재 패키지 상태를 입증하지 않는다.

토큰은 검사 프로세스 메모리에서만 사용하고 종료 시 폐기했다. 진단 결과 JSON은 비밀값 없는 .release/oauth-edge21-live-verification-2.json이며 git 제외 경로다. Kubernetes 쓰기 또는 GHCR 이미지 변경은 하지 않았다.

## 로컬 발행 검증

- Setup 290/290 테스트 통과. Console source lock 1c0b3973ee9881d45fef3ab308003872119bedd5의 격리 checkout으로 CI 조건을 맞췄다.
- Go Windows launcher 테스트, bundle/version, native launcher release binding 통과.
- Windows launcher 후보 7,497,216 bytes. 원격 runtime 자산이 발행되기 전에는 사용자 실행용으로 안내하지 않는다.
- Setup/Console provider와 lifecycle contract 내용 일치. provider 토큰 모양 Client ID 거부, 잘못된 OAuth CLI 옵션의 네트워크 전 차단 시험 통과.
- Console registry-auth/v1이 없는 대상에는 OAuth bootstrap을 namespace/credential 쓰기 전에 차단한다.

## 운영 활성화의 별도 조건

Console의 migration/DB/MFA 회귀 검증, 실제 이미지 발행, registry-auth/v1 인계, refresh 후 namespace 전파 및 kubelet cold-pull 검증은 남아 있다. Setup 공개 발행만으로 이 조건들을 충족했다고 주장하지 않는다.

## 근거

- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
