# Setup edge.24 — 클린 설치 의존성 순서 수정

2026-09-03. 상태: 수정본 공개 발행·검증 및 실패 설치 삭제 완료. 사용자 요청은 현재 실패한 설치를 정리하고 클린 설치를 준비하는 것이다. 새 bootstrap은 실행하지 않는다.

Console source `787b82193125d6c592b16dd05ce09007a01d0998`, Console version `202609031642`를 고정한다.

## 원인과 수정

edge.23의 C_API는 필수 `opensphere-baseline-monitoring-reader` Secret이 없어 `CreateContainerConfigError`였고 5분 동안 시작되지 못했다. Supabase 4개 Pod는 정상 Ready였다. Setup이 Beszel installer를 C_API Ready 이후 호출해 필수 선행 입력을 뒤늦게 생성하는 순서 오류였다.

뒤이어 C_EXT readiness도 foundation 이후 적용되는 CRD를 먼저 요구한다는 점을 코드에서 확인했다. CRD·신뢰 키가 먼저 적용되고 CRD가 Established인 것을 확인한 뒤 Gitea → Beszel reader 준비 → Supabase/C_API/C_EXT → 나머지 base workload 순서로 설치한다. verified artifact만 사용하고 기존 source/hash/권한/Ready 기준을 보존한다.

Beszel은 C_API가 아직 없으면 재시작하지 않으며, 이미 존재하면 기존대로 갱신·Ready를 확인한다. 조회 실패를 없음으로 취급하지 않는다. C_API installer는 입력 단계에서 reader Secret을 확인하여 이 선행 입력이 없으면 DB 작업·rollout 대기 전에 실패한다. optional Secret이나 임의 빈 credential은 추가하지 않는다.

## 검증

새 테스트는 실제 production orchestration 함수를 실행한다. 이전 게시된 함수에서 missing-reader 오류가 재현되는 것을 확인했다. 수정 함수의 fresh 성공, Beszel 실패 시 API 미실행, CRD Established 실패 시 workload 미실행, prerequisite 누락 시 write 이전 실패, legacy 경로 보존을 검증한다.

Console의 실제 PowerShell fresh/existing consumer 분기와 조회 오류/다른 identity 거부, credential/progress runtime 테스트, Beszel/installer 계약 12개 및 machine contracts가 통과했다. Setup 전체 316개 테스트가 통과했다. 공개 발행·삭제 결과는 아래에 기록했다. 실제 새 클린 설치의 성공을 아직 주장하지 않는다.
## 공개 발행 및 실제 실행 확인

- [Setup 0.5.0-edge.24](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/tag/setup-v0.5.0-edge.24): 2026-09-03 16:53:16 KST 공개 prerelease. 불변 tag/source는 `21af3001e8eb08e321ca2cfd963a9b10132dfdfb`이다. 이후 문서 정리는 발행한 asset/source를 바꾸지 않는다.
- [Setup CI 33729666564](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33729666564) 및 [공개 5개 플랫폼 빌드 33730087302](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33730087302) 성공. Windows amd64, Linux amd64/arm64, macOS amd64/arm64의 실제 packaged runtime smoke test 포함.
- Windows EXE 7,497,216 bytes, SHA-256 `2bab26601ceed64f3b228d572d4b3760c7415af05780ef3ae25ecfeb60238265`. GitHub asset digest와 공개 SHA256SUMS 모두 일치.
- Windows runtime ZIP 173,882,226 bytes, SHA-256 `7ecd50ac6233c2d408e742ae2c05e269e5cc137cd163660170dd8e98ab594ba9`.
- 공개 EXE의 exact version, 첫 runtime 다운로드·검증 후 `status --context docker-desktop`, 두 번째 캐시 재사용 status가 모두 종료 0. `reusing verified runtime; no runtime download` 확인. 새 OAuth 또는 bootstrap은 실행하지 않았다.
- 공개 Release 본문에 잘못 남아 있던 edge.21 설명을 edge.24의 실제 변경·검증 한계로 수정했다. PLATFORM-INSTALL의 다운로드 버전과 현재 검증 상태도 갱신했다. 불변 tag/asset은 수정하지 않았다.

로컬 근거: `.release/public-edge24/public-release-evidence.json`, `public-execution-verification.json`, `public-version.log`, `public-clean-status.log`, `public-cache-reuse-status.log`. credential 원문은 없다.

## Console GHCR 채널 검증

Console `202609031642` / `local-787b82193125`, source `787b82193125d6c592b16dd05ce09007a01d0998`를 공식 로컬 발행 스크립트로 빌드·push했다. 게시 스크립트는 종료 0으로 완료했다. canonical 18개 및 auxiliary 3개, 총 21개 이미지의 source/date/edge 태그 63개를 별도 인증된 read-only GHCR API로 다시 읽었다. 응답 bytes SHA-256 및 Docker-Content-Digest가 BOM과 모두 일치했다. 최종 독립 검증 시각은 2026-09-03 16:58:50 KST다.

Console anchor: `sha256:6b034f2117f9972a08225b31cfec74da545358ba52e233e00f7674602e939dcf`. `localhost`, `pre-ga`, `linux/amd64`, `ga-eligible=false`이다. candidate/stable/GA로 승격하지 않았다.

[Console CI 33729459392](https://github.com/opensphere-platform/OpenSphere-console/actions/runs/33729459392)의 두 번째 실행이 성공했다. 첫 실행은 HTTP E2E의 58080 포트 충돌(EADDRINUSE)로 실패했다. 동일 source·동일 검증을 재실행해 통과했으며 검증 기준을 완화하거나 실패를 성공으로 바꾸지 않았다.

## 세 번째 실패 설치 삭제 및 클린 상태

공개 edge.23 CLI를 버전 고정하여 `uninstall --purge-data --confirm DELETE-OPENSPHERE --context docker-desktop`을 실행했고 종료 0이었다. 삭제한 실패 release digest는 `sha256:3236870044fa77b23fcb227b508a7dd35aff34655d80234d5432de7ce0c39035`다.

전용 namespace `opensphere-console`, `opensphere-console-data`, `opensphere-console-change`, `opensphere-monitoring`, `opensphere-system` 5개와 PV 4개가 사라졌다. provisioner 로그로 실제 데이터 저장 경로 4개 삭제도 확인했다. 고정 관리 cluster resource 12종은 잔여 0건이다. 다른 namespace 9개 및 Bound PV 8개는 원래 UID와 claim을 보존했다. Developer/Developer-standalone/WWW와 공유 Kubernetes 기반 자원을 지우지 않았다.

노드 6/6 Ready, `127.0.0.1:1114` 사용 가능을 확인했다. 소스·문서·공개 실행 파일 및 검증된 runtime cache는 보존했다. GitHub OAuth App이나 다른 서비스 credential을 삭제하지 않았다. 삭제 전후 증거는 Console 저장소의 `.release/registry-auth-verification/console-edge24-purge-before.json`, `console-edge24-purge-after.json`, `console-edge24-third-purge.log`, `console-edge24-clean-readiness.json`에 있다.

## 사용자가 시작할 클린 설치

[새 Windows EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.24/opensphere-setup.exe)로 기존 EXE를 교체하고 다음 명령을 실행한다.

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.24 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

명령에서 표시하는 새 device code를 GitHub에서 승인한다. 실패 설치의 운영 OAuth/pull Secret은 purge로 제거됐다. 호스트 CA 신뢰 등록이나 `os` CLI 호스트 설치는 위 명령에 포함하지 않는다. 새 bootstrap은 이번 작업에서 실행하지 않았으며, 실제 클린 설치 완료나 Console 전체 기능/GA 검증을 주장하지 않는다.
