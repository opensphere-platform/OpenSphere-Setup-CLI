# Setup edge.26 — 실제 Console API 이미지 검증 및 클린 설치 준비

2026-09-03. 상태: 패키징 수정, 최종 GHCR 이미지 실제 DB/HTTP 기동 검증, 공개 발행, 공개 실행 파일 검증 및 현재 실패 설치 삭제 완료. 사용자 요청에 따라 새 bootstrap은 실행하지 않는다.

Console source `101f770c5691ac905838c4bd2476d5b0bd02e1e8`, version `202609031742`를 고정한다.

## 문제와 변경

edge.25에서는 Secret/Beszel/Supabase가 준비됐지만 API 이미지가 runtime/package.json을 누락해 CommonJS contract를 ESM으로 해석했고 시작 직후 종료했다. 호스트 소스 E2E에는 package boundary가 존재했고 이미지 검증은 build/OCI metadata까지만 수행해 이를 놓쳤다. 앞선 Secret/PowerShell null 오류와 직접 원인은 다르지만 실제 배포 산출물 검증 공백의 문제다.

runtime/package.json을 이미지에 포함하고 commonjs를 명시했다. 새 검증은 완성된 이미지의 기본 entrypoint/UID 1001을 사용한다. 임시 internal Docker network/PostgreSQL/시험 credential만 사용해 실제 runtime DB role 연결, HTTP 200/Ready, 잘못된 DB 인증의 HTTP 503, 재시작 0을 검증하고 임시 자원을 제거한다. 운영 K8s 데이터·Secret·호스트 source mount·호스트 포트는 사용하지 않는다.

Validate CI의 API build 직후 이 검증을 수행한다. 현재 로컬 edge publisher는 exact API digest의 기동 검증을 통과해야 date/edge를 전환한다. 이미지 재사용 경로에도 동일하게 적용한다. OCI 플랫폼·labels·digest 검사 메시지는 실제 실행 검사와 구분한다. candidate/stable은 기존 HOLD 유지. schema, credential, RBAC, NetworkPolicy와 Ready 판정을 완화하지 않았다.

기존 공개 edge.25 이미지가 새 검증에서 알려진 모듈 오류로 실패했고 수정 이미지가 통과했다. API 패키징/릴리스 관련 계약 테스트 23개 및 bootstrap-core machine contracts도 통과했다. 상세 근거는 [Console 보고서](https://github.com/opensphere-platform/OpenSphere-console/blob/main/docs/CONSOLE-INSTALL-EDGE26-IMAGE-STARTUP-20260903.md)를 따른다.

공개 발행·실행·삭제 결과는 아래와 같다. API 이미지 기동/DB Ready와 전체 Kubernetes bootstrap 성공을 구분한다.
## 공개 발행·실행 결과 — 2026-09-03 18:00 KST

- 공개 source: `15e61e6d699119d01e0713967f163f18725bf333`; tag `setup-v0.5.0-edge.26`; Console lock `101f770c5691ac905838c4bd2476d5b0bd02e1e8`.
- 로컬 Setup 테스트 316/316 성공. [공개 workflow](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33735216296)에서 Windows amd64, Linux amd64/arm64, macOS amd64/arm64 및 publish 모두 성공.
- [공개 릴리스](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/tag/setup-v0.5.0-edge.26)는 immutable prerelease이며 7개 asset을 제공한다. tag의 commit이 위 Setup source와 일치함을 확인했다.
- Windows EXE 7,497,216 bytes, SHA-256 `9b4f8fb33762b243b729e5d4c1a2dee83ceca2f57be3e456b326db1c08ae48a6`. 다운로드한 bytes를 GitHub asset digest 및 SHA256SUMS와 대조했다.
- Windows runtime ZIP 173,882,227 bytes, SHA-256 `cd6384bcc582ec16a4cc11c46fe412431bbb3c8552a5372d518ed1519345ca84`. 공개 EXE가 내려받은 캐시의 ZIP을 GitHub asset digest와 대조했다.
- 공개 EXE로 version, 관리 설치 uninstall, 후속 status 모두 exit 0. 후속 실행에 `reusing verified runtime; no runtime download`를 확인했다. Windows 프로그램 설치/PATH/서비스 등록을 하지 않는다. 새 버전 runtime만 한 번 다운로드하며 인증 토큰은 portable runtime cache에 저장하지 않는다.

Console `edge`는 version `202609031742`로 발행했다. anchor는 `sha256:68b042f9f99ab8b29483776f0d458acc40ed338a345ccce4bc52eaece20d0697`, API digest는 `sha256:ff890b72adb603d36810e021e60cd610810f34ba2de418f9403b70678153fb7f`이다. Publisher에서 exact API digest로 실제 PostgreSQL/HTTP 기동 gate를 통과한 후 채널을 전환했다. 21개 이미지 × source/date/edge 태그 63개의 manifest bytes SHA-256 및 Docker-Content-Digest가 BOM과 일치한다. [Console CI](https://github.com/opensphere-platform/OpenSphere-console/actions/runs/33734772973)의 새 image gate도 성공했다.

## 클린 설치 대상 상태

공개 edge.26 CLI로 현재 실패 설치를 삭제했다. 삭제된 lock digest는 `sha256:fc605a7e245acf3b8a7ca853d34246e4d825f62ed970a24475c26b5bcd488ef6`이다.

- 관리 namespace 5개(`opensphere-console`, `opensphere-console-data`, `opensphere-console-change`, `opensphere-monitoring`, `opensphere-system`) 및 PV 5개 제거. provisioner 완료 로그로 실제 저장 경로 삭제도 확인.
- 관리 cluster resource 12개(CRD 2, ClusterRole/Binding 4, admission policy/binding 6) 부재 확인.
- 다른 namespace 9개와 PV 8개는 원래 UID/claim을 유지하고 Bound. Developer/WWW/공용 Kubernetes 자원은 보존.
- `docker-desktop` 노드 6/6 Ready·schedulable, StorageClass `standard`, loopback TCP 1114 사용 가능. 공개 CLI status에서 관리 대상 Pod 0개.

Setup `.release/public-edge26/`의 `public-release-evidence.json`, `public-workflow-evidence.json`, `public-version.log`, `public-cached-status.log`, `public-execution-verification.json`에 근거를 기록했다. Console `.release/registry-auth-verification/`의 `console-edge26-*` 파일에 실제 이미지 기동, GHCR 태그, 삭제 전후·보존 검증을 기록했다. credential 평문은 근거 파일에 저장하지 않는다.

## 다음 실행

[edge.26 Windows portable EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.26/opensphere-setup.exe)를 내려받고 다음 명령을 실행한다.

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.26 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

표시되는 새 GitHub device code를 승인한다. 이번 준비 작업은 새 Kubernetes bootstrap을 시작하지 않았다. 실제 API 이미지의 DB-backed Ready와 전체 신규 설치 성공은 별개이며, 전체 설치 완료는 사용자의 다음 실행에서 확인해야 한다. 이전 edge.25 준비 보고가 놓쳤던 패키징 결함과 검증 공백을 수정한 상태다. candidate/stable은 HOLD 유지.
