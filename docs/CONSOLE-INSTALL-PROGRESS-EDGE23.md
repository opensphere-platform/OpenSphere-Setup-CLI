# Setup 0.5.0-edge.23 — 설치 진행 표시와 bootstrap 오류 수정

2026-09-03. 상태: Setup 공개 발행·실행 확인 완료, 두 번째 실패 설치 삭제 완료. Console GHCR 채널 전환 및 63개 태그 검증도 완료했다. 새 설치는 실행하지 않았다.

Console 고정 source: `91cb7c99c3b8b499e204e4b6277e37d6bb901137`, Console 버전 `202609031558`.

## 바뀐 동작

- Setup에서 검증한 Kubernetes API egress가 실제 target installer 파일에도 반영된다. PowerShell이 담당하는 이미지/Console origin placeholder는 유지한다. 이전에는 render 검증 결과와 달리 raw template을 전달해 C_API 설치가 실패했다.
- Console의 fresh REST schema 설정, 기존 session key 읽기 검증을 수정한 source를 고정한다.
- Supabase~API/Controller 설치를 12개 실제 세부 단계로 표시한다. 시작/완료/실패, 경과 시간, migration N/28, native Ready 진행과 15초 readiness 대기 갱신이 보인다.
- 운영 Secret/SQL/manifest 원문은 진행 로그에 출력하지 않는다. 기존 kubectl Ready와 timeout 판정은 바꾸지 않는다.
- OAuth App, 공개 실행 파일 방식, 기존 runtime cache 검증/재사용, 운영 credential 인계 범위는 그대로 유지한다.

## 검증

Setup 전체 309개 테스트 통과. 실제 materialization 함수가 쓴 파일을 검사해 “검사한 egress와 전달한 egress가 다름” 회귀를 막고, endpoint discovery 실패 시 파일을 쓰지 않음을 확인했다.

Console은 실제 PowerShell 함수의 key 재사용·비정상 key 거부·live heartbeat·실패 출력·stdout 보존, 실제 PostgreSQL 28개 migration/28개 SQL 및 초기 관리자/API/Controller HTTP E2E를 통과했다. 신규 release의 실제 Kubernetes 클린 설치 성공은 아직 검증하지 않았다.

## 사용자 재시도

사용자가 “업데이트 후 기존 설치 삭제, 클린 설치는 직접 재시도”를 지시했다. 실패한 Console 설치만 purge했으며 다른 Developer/WWW 서비스와 공유 Kubernetes 기반 자원을 보존했다.

이전 EXE는 edge.22 runtime을 계속 사용할 수 있으므로 새 공개 EXE를 다운로드하거나 기존 실행 파일에서 `--version 0.5.0-edge.23`을 명시한다. 저장된 설치 lock이 제거된 뒤에는 신규 bootstrap 경로를 사용한다. 사용자 요청 없이 자동 새 설치는 시작하지 않는다.

계약·버전·채널 검증을 우회하는 임시 설치 파일이나 직접 수정한 공개 release asset은 만들지 않는다.

## 공개 Windows 검증에서 발견한 동시 파일 처리 수정

첫 공개 플랫폼 검증 33725982659에서 8개 동시 receipt writer 중 하나가 디렉터리 열거 직후 다른 writer에 의해 사라진 staging 파일을 lstat하여 ENOENT로 종료했다. 임시 디렉터리의 관찰 단계에서만 이런 ENOENT를 허용한다. 실제 append/promotion/cleanup의 정확한 pending/final bytes 검증과 directory identity, symbolic/hard link, 파일 타입, 권한 오류 거부는 유지한다.

`.tmp`와 `.staging` 각각에 대해 열거 직후 삭제되는 상황을 결정적으로 재현한다. hard link 및 directory로 교체되는 경우는 계속 실패한다. Windows 실제 8 writer 검증을 포함한 전체 309개 테스트가 통과했다. 새 lock, 프로세스 또는 저장소는 추가하지 않았다.

## 두 번째 실패 설치 삭제

2026-09-03 16:10 KST경 공개 edge.22 실행 파일을 명시적으로 버전 고정하여 `uninstall --purge-data --confirm DELETE-OPENSPHERE --context docker-desktop`을 수행했다. 기존 실패 release `sha256:a1eef0bbe196b02fe312d8cb861f5e8792ddf0e669db62534d5b2febf3626cce`의 전용 namespace 5개와 볼륨 4개가 제거됐다. provisioner 로그로 실제 저장 경로 4개 삭제를 확인했다. 다른 namespace 9개 및 Bound PV 8개는 원래 UID와 claim을 보존했다. 고정 관리 cluster resource 12종도 잔여 0건이다. 새 설치는 실행하지 않았다.
## 공개 배포 및 실제 실행 확인

- [공개 Release setup-v0.5.0-edge.23](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/tag/setup-v0.5.0-edge.23): 2026-09-03 16:16:39 KST 발행, prerelease.
- Release source/tag: `c2c24606bc3e2be4e7b9180e656bd342a7f541ed`.
- [Setup CI 33726928128](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33726928128) 성공.
- [공개 5개 플랫폼 빌드 33726928343](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33726928343) 성공. Windows amd64, Linux amd64/arm64, macOS amd64/arm64의 packaged runtime smoke test 포함.
- 공개 asset 7개: 5개 platform archive, Windows portable EXE, SHA256SUMS.
- 공개 Windows EXE는 7,497,216 bytes. SHA-256 `3bff50b81d01897cba9ecc509d91bb59663127d9b53b21af9fede86c09cd47e5`. GitHub asset digest 및 공개 SHA256SUMS 둘 다 일치.
- 공개 Windows runtime ZIP은 173,881,874 bytes. SHA-256 `3207828ec6c5148ff39dfa5fef5083312b48d4ff4af597dc40ebe07dd7dae220`.
- 내려받은 EXE에서 exact version 출력 확인. 새 runtime을 검증·다운로드한 뒤 `status --context docker-desktop` 종료 0. Console 설치 namespace/Pod가 없는 클린 상태와 보존된 다른 서비스가 표시됐다.
- 같은 명령을 다시 실행해 `reusing verified runtime; no runtime download` 확인. 호스트 설치/PATH/service 등록은 수행하지 않았다.
- 위 실행은 읽기 전용 version/status이며, bootstrap 및 새로운 OAuth 승인은 시작하지 않았다.

로컬 검증 근거는 `.release/public-edge23/public-release-evidence.json`, `public-version.log`, `public-clean-status.log`, `public-cache-reuse-status.log`에 있으며 credential 원문은 포함하지 않는다.
## Console GHCR 완료 및 사용자 재시도

Console `202609031558` / `local-91cb7c99c3b8`, source `91cb7c99c3b8b499e204e4b6277e37d6bb901137`가 edge에 반영됐다. canonical 18 + auxiliary 3개의 source/date/edge 총 63개 태그에 대해 GHCR 응답 bytes SHA-256과 Docker-Content-Digest를 BOM과 대조했다. 모두 일치했다. anchor는 `sha256:84348d9b833d77cda3c2ab5a37c7620085d5379ccf28292c37e51980e6c3b217`이다. localhost/pre-ga/linux-amd64이며 stable/GA 발행으로 표현하지 않는다.

게시 스크립트는 마지막 전체 조회에서 실패했고 후속 Docker 조회의 anonymous 401을 확인했다. 이미 반영한 image/tag를 다시 쓰지 않고, 별도 인증된 read-only GHCR API 검증으로 위 63개를 모두 확인했다. 공개 EXE 빌드/발행 성공과 Console 게시 스크립트의 종료 결과를 혼동하지 않는다.

[새 Windows EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.23/opensphere-setup.exe)를 내려받은 뒤 다음 명령으로 사용자가 클린 설치를 시작한다.

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.23 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

명령 실행 후 새 device code로 승인한다. 이전 설치의 운영 OAuth/pull Secret은 purge로 제거됐다. 호스트 CA 신뢰 등록은 위 명령에 포함하지 않았다. 이 명령의 새로운 bootstrap은 이번 작업에서 실행하지 않았으며 실제 클린 설치 완료/전체 기능/GA를 주장하지 않는다.