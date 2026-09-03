# Setup edge.25 — Beszel null 출력 오류 수정 및 클린 설치 준비

2026-09-03. 상태: 수정·공개 발행·실행 검증 및 실패 설치 삭제 완료. 사용자가 업데이트 후 클린 설치 준비·보고를 지시했다. 새 bootstrap은 실행하지 않는다.

Console source `4a35cf46d5bcf31118cae25ab4ce2846a719b0db`, version `202609031708`을 고정한다.

## 원인과 수정

edge.24에서 Beszel Hub/Agent/Job/reader Secret이 정상 준비된 뒤, 아직 없는 Console API의 조회 결과에 Trim을 호출해 설치가 중단됐다. production Get-KubectlValue에서 native 무출력은 null이 된다. 기존 테스트는 이 helper를 빈 문자열 반환으로 대체하여 실제 경계를 놓쳤다. 예측 불가능한 인프라 문제가 아니라 게시한 installer와 검증의 결함이다.

공개 PowerShell 7.6.4와 실제 Kubernetes 읽기 전용 조회로 exit 0/null/Trim 예외를 재현했다. null-safe 분기로 수정하고 production helper 및 native no-output fixture를 포함하도록 테스트를 보강했다. 같은 테스트에서 정확한 공개 edge.24 installer가 실패하고 수정본이 통과했다. API 존재 시 refresh, native 오류와 잘못된 identity 거부는 유지했다. 실제 Kubernetes 조회와 수정 분기도 mutation 금지 상태에서 통과했다.

앞선 CRD/trusted-key → Gitea → Beszel → Supabase/API/Controller → 나머지 workload 순서는 그대로다. schema, credential, RBAC, NetworkPolicy, Ready 기준이나 공급망 검증을 완화하지 않았다. 상세 원인 및 근거는 [Console 보고서](https://github.com/opensphere-platform/OpenSphere-console/blob/main/docs/CONSOLE-INSTALL-EDGE25-NULL-OUTPUT-20260903.md)에 있다.

공개 발행, 실행 파일 검증, 현재 실패 설치의 정확한 삭제 범위와 보존 검증은 아래에 기록했다. 실제 새 클린 설치 성공으로 해석하지 않는다.

## 공개 발행·검증 완료

- [Setup edge.25 공개 Release](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/tag/setup-v0.5.0-edge.25): 2026-09-03 17:16:14 KST, immutable prerelease. 발행 tag/source `695e8d5b937aebca08310fc1fcbacc653b80d1b7`. 이후 문서 commit은 불변 asset/source를 변경하지 않는다.
- [Setup CI 33731934465](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33731934465), [공개 5개 플랫폼 빌드 33732080756](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33732080756), [Console CI 33731723688](https://github.com/opensphere-platform/OpenSphere-console/actions/runs/33731723688) 성공. Setup 전체 316개 테스트 및 플랫폼별 packaged runtime smoke 검증 포함.
- Windows EXE 7,497,216 bytes, SHA-256 `33ed8c1fdb2dd10b8ea9be58986626844e6cbfc941fb7db14651eb34c0fc7b56`. GitHub asset digest와 공개 SHA256SUMS 모두 일치.
- Windows runtime ZIP 173,882,227 bytes, SHA-256 `71d0d5fb0420fd19e6b18b2f1426b5015e3fd14cd491ad6e5b611af3f9f588ac`.
- 공개 EXE의 exact version, uninstall, 삭제 후 status가 모두 종료 0. 첫 운영 명령에서 runtime을 검증·다운로드했고 다음 status에서 `reusing verified runtime; no runtime download`를 확인했다. Windows Setup 설치/PATH/service 등록 없음.
- Console `202609031708` / `local-4a35cf46d5bc`, source `4a35cf46d5bcf31118cae25ab4ce2846a719b0db`를 공식 로컬 발행 스크립트로 게시했고 종료 0이었다. canonical 18 + auxiliary 3개 이미지의 source/date/edge 총 63개 태그를 별도 인증된 read-only GHCR API로 검증했다. 응답 bytes SHA-256과 Docker-Content-Digest가 모두 BOM과 일치했다.
- Console anchor `sha256:657292b10ddf91e7550295192c9bf1b1086ac560c6fb7b37a02d0d85ab3ec1b7`. localhost/pre-ga/linux-amd64, ga-eligible=false. candidate/stable/GA 승격 없음.

## 네 번째 실패 설치 삭제 및 보존

새 공개 edge.25 CLI를 버전 고정하여 `uninstall --purge-data --confirm DELETE-OPENSPHERE --context docker-desktop`을 수행했다. 삭제한 실패 release digest는 `sha256:ef2a88e700e5377087291785370f9043d781028780d41398109d568f831c9cd4`다.

Console 전용 namespace 5개(`opensphere-console`, `opensphere-console-data`, `opensphere-console-change`, `opensphere-monitoring`, `opensphere-system`)와 PV 3개가 사라졌다. 이번에는 Gitea DB/data와 Beszel data만 생성됐으며 Supabase 설치 전 실패했다. provisioner 로그로 실제 저장 경로 3개 삭제도 확인했다. 고정 관리 cluster resource 12종은 잔여 0건이다.

다른 namespace 9개와 Bound PV 8개는 원래 UID와 claim을 보존했다. Developer/Developer-standalone/WWW 및 공유 Kubernetes는 삭제하지 않았다. K8s 6/6 Ready, 127.0.0.1:1114 사용 가능. 소스·문서·포터블 실행 파일/캐시와 GitHub OAuth App은 보존했다. 새 bootstrap 및 새 OAuth 인증은 실행하지 않았다.

로컬 근거: Setup `.release/public-edge25/public-release-evidence.json`, `public-execution-verification.json`, `public-version.log`, `public-clean-cache-reuse-status.log`; Console `.release/registry-auth-verification/console-edge25-publish.log`, `console-edge25-release-bom.json`, `console-edge25-final-tag-verification.json`, `console-edge25-purge-before.json`, `console-edge25-purge-after.json`, `console-edge25-fourth-purge.log`, `console-edge25-clean-readiness.json`. credential 원문 없음.

## 사용자가 시작할 클린 설치

[새 Windows EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.25/opensphere-setup.exe)로 교체하고 실행한다.

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.25 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

명령에 표시된 새 device code를 GitHub에서 승인한다. 삭제한 실패 설치의 운영 OAuth/pull Secret은 남아 있지 않다. 호스트 CA 신뢰 등록과 `os` CLI 호스트 설치는 이 명령에 포함하지 않는다. 수정 분기의 실제 읽기 전용 조회 및 공개 실행 파일 검증을 전체 Kubernetes 클린 bootstrap 성공으로 표현하지 않는다. 그 설치는 사용자가 다음에 시작한다.
