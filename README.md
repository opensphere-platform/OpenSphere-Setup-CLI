# OpenSphere Setup CLI

OpenSphere OS Console의 신뢰 가능한 최초 설치, 재개, 검증, 업그레이드 및 제거를 담당한다.
현재 정본은 **Supabase Data & Identity Backbone + 별도 Gitea Change Authority**이다.

## 공식 설치 명령

사용자·운영자에게 노출하는 유일한 진입점은 `opensphere-setup`이다. 저장소 위치:

```text
OpenSphere-Platform-V2/OpenSphere-Setup-CLI
```

Windows에서 명령 등록:

```powershell
cd OpenSphere-Setup-CLI
.\Install-OpenSphereSetup.ps1
opensphere-setup version
```

Linux/macOS에서 명령 등록:

```bash
cd OpenSphere-Setup-CLI
npm install --global . --no-audit --no-fund
opensphere-setup version
```

비공개 실제 관리 호스트에는 저장소 clone이나 개발 런타임 설치 대신 GitHub Release의
Windows amd64, Linux amd64/arm64, macOS amd64/arm64 자체 포함 아카이브를 사용한다.
인증 다운로드, SHA-256·immutable release attestation 검증과 설치 절차는
[`docs/PRIVATE-PLATFORM-INSTALL.md`](docs/PRIVATE-PLATFORM-INSTALL.md)가 정본이다. Setup
저장소가 public이면 platform Release 발행 workflow는 fail-closed한다.

`node src/cli.mjs`와 저장소의 `opensphere-setup.cmd`는 내부 개발·진단용 구현 세부사항이며
설치 문서나 운영 runbook의 사용자 명령으로 사용하지 않는다.

대화형 터미널에서 `bootstrap`, `doctor`, `upgrade` 같은 운영 명령을 시작하면 ANSI Shadow
OpenSphere 배너를 표시한다. 파이프·CI 및 `version` 같은 기계 판독 출력에는 표시하지
않는다. 제한된 터미널에서는 `OPENSPHERE_NO_BANNER=1`로 끌 수 있다.

소스 설치 요구 사항은 Node.js 24 이상, PowerShell 7(`pwsh`), GitHub CLI(`gh`),
`kubectl`, Kubernetes Ready 노드, 기본 또는 명시한 동적 StorageClass이다. 비공개 platform
아카이브는 Node.js, PowerShell, kubectl과 Linux의 libatomic을 포함한다. 대상 호스트에
필요한 외부 도구는 Git, 인증된 GitHub CLI(`gh`), 접근 가능한 Kubernetes cluster뿐이다.

지원 계약:

| 항목 | 지원/요구 |
|---|---|
| Setup 실행 호스트 | Windows amd64, Linux amd64/arm64, macOS amd64/arm64 |
| Kubernetes | v1.30 이상 |
| Kubernetes 노드 | linux/amd64, linux/arm64 |
| 영속 볼륨 요청 | Supabase 70Gi + Gitea 18Gi = 총 88Gi |
| Docker Desktop 검증 시작 프로필 | 10 CPU, 16GiB RAM; 최소값이 아니라 검증된 시작점 |

StorageClass가 88Gi를 provision할 수 있는지와 실제 물리 디스크 여유 공간은 운영자가 확인한다.
macOS 준비·설치·인증서 신뢰 절차는
[`docs/MACOS-INSTALL.md`](docs/MACOS-INSTALL.md)를 따른다.

## 현재 설치 방법론

Setup은 태그를 그대로 설치하지 않는다.

1. 선택한 채널의 Release BOM 또는 local-edge release lock을 조회한다.
2. GitHub Actions provenance, SPDX SBOM, 소스 revision, 13개 이미지 digest를 검증한다.
3. 검증된 immutable release lock을 로컬과 클러스터에 기록한다.
4. 정확히 그 소스 revision의 설치 스크립트, SQL migration, Kubernetes manifest를 받는다.
5. 모든 이미지 슬롯을 BOM의 `ghcr.io/...@sha256:...` 값으로 치환한다.
6. Supabase와 Gitea를 먼저 설치하고 migration/control-plane seed를 완료한다.
7. Backend, DUPA, Notification, OAA, Main Shell을 설치한다.
8. 데이터 경계, 서비스 endpoint, 이미지 digest, Storage/Gitea 쓰기 왕복까지 검증한다.
9. Console이 제공하는 `os` CLI artifact를 digest 검증 후 설치한다.
10. 사람 관리자는 Console의 Supabase 최초 접속 Wizard에서 직접 생성한다.

설치 중 생성한 암호·키는 argv나 release lock에 넣지 않는다. 기존 Secret이 있으면 누락된
키만 보완하며 정상 재개에서 암묵적으로 회전하지 않는다.

## 기본 런타임

Release BOM/lock의 필수 13개 컴포넌트:

| 컴포넌트 | 역할 |
|---|---|
| `console` | Main Shell UI |
| `backend` | Console API, RBAC, bootstrap |
| `dupaController` | 플랫폼·플러그인 control plane |
| `oaaGateway` | OAA Gateway |
| `oaaGovernedAdapter` | OAA governed adapter |
| `notificationDispatcher` | 외부 알림 전달 |
| `supabasePostgres` | Console 데이터·감사·Auth·Storage DB |
| `supabaseAuth` | 사용자 인증과 canonical subject |
| `supabaseRest` | PostgREST |
| `supabaseStorage` | Console object storage |
| `gitea` | 선언 변경·이력 권위 |
| `giteaPostgres` | Gitea 전용 DB |
| `recovery` | 암호화된 S3 archive와 격리 restore drill 전용 executor |

권위 경계:

- Supabase Auth의 `auth.users.id`가 사용자 canonical subject이다.
- Supabase PostgreSQL이 Console state, RBAC, audit, OAA ledger를 소유한다.
- Supabase Storage가 Console object storage를 소유한다.
- Gitea는 선언형 desired state, review, signed change history를 소유한다.
- Kubernetes Secret은 런타임 자격증명 전달 수단이지 사용자 identity authority가 아니다.

## 네임스페이스와 영속 볼륨

Setup이 소유하는 네임스페이스:

```text
opensphere-console-data
opensphere-console-change
opensphere-console
opensphere-oaa-credentials
opensphere-foundation
opensphere-system
```

필수 PVC:

```text
opensphere-console-data/opensphere-supabase-postgres-data
opensphere-console-data/opensphere-supabase-storage-data
opensphere-console-change/opensphere-gitea-postgres-data
opensphere-console-change/opensphere-gitea-data
```

각 네임스페이스에는 `opensphere-ghcr-pull`이 생성되고 모든 workload가 이를 명시한다.
공개 package는 anonymous docker config를, 비공개 package는 stdin으로 받은 GHCR credential을
사용한다.

## Fresh bootstrap

설치 전에 클러스터를 변경하지 않는 진단을 먼저 실행한다.

```powershell
opensphere-setup doctor `
  --release edge `
  --context docker-desktop `
  --storage-class hostpath `
  --console https://localhost:1114
```

`doctor`는 Setup 호스트 플랫폼, Node runtime, `kubectl`·`pwsh`·`gh`, Kubernetes
v1.30+, Ready 노드와 권한, StorageClass, 신규 설치 포트와 채널별 공급망 정책을
확인한 뒤 46개 필수 manifest·migration·installer를 실제 source revision에서 모두
다운로드·렌더링한다. 이 단계가 실패하면 namespace, installation lock과 Secret을 만들지
않는다. PVC 88Gi는 요청량으로 보고하며 실제 provisioner 용량을 대신 보증하지 않는다.

`edge`는 개발 클러스터의 Linux 노드 아키텍처만 포함한 host-native 이미지도 허용한다.
로컬 발행본은 `localhost`, `pre-ga`, `ga-eligible=false`, 날짜 태그와 전체 source
revision 라벨 및 `local-<commit12>` immutable tag가 13개 이미지에서 모두 일치해야 한다.
local-edge lock은 서명된 Release BOM이라고 주장하지 않는다. 따라서 Supabase migration
manifest는 exact source revision과 per-file SHA-256, manifest set digest, v2 predecessor
lineage를 모두 검증해 결속하며 독립 BOM 서명은 GitHub release/GA 경로에서만 성립한다.
local-edge 결과물은 이 차이를 유지한 채 candidate/stable/ga로 승격할 수 없다.
`candidate`와 `stable`은 계속 `linux/amd64`·`linux/arm64` 양쪽과 GitHub Actions
Release BOM·provenance·SPDX SBOM attestation을 모두 요구한다.

Docker Desktop Kubernetes 개발 환경:

```powershell
kubectl --context docker-desktop get nodes
opensphere-setup bootstrap `
  --release edge `
  --context docker-desktop `
  --storage-class hostpath `
  --console https://localhost:1114
```

StorageClass 이름을 생략하면 preflight가 기본 StorageClass를 선택한다. 설치가 끝나면 브라우저의
최초 관리자 Wizard에서 사용자명, 표시 이름, 이메일, 비밀번호를 입력한다. Setup은 사람의
비밀번호나 일회용 reset URL을 생성·출력·저장하지 않는다.

비공개 GHCR package를 읽어야 할 때:

```powershell
$env:GHCR_TOKEN | opensphere-setup bootstrap `
  --release edge `
  --context docker-desktop `
  --registry-username <github-login> `
  --registry-token-stdin
```

토큰을 command argument에 직접 넣지 않는다.

## 재개와 멱등성

같은 명령을 다시 실행하면 mutable 채널을 재조회하지 않고 클러스터의
`opensphere-installation-lock`을 사용한다.

```powershell
opensphere-setup bootstrap --release edge --context docker-desktop
```

다음 경우에는 fail-closed한다.

- release lock 없이 `opensphere-*` 네임스페이스가 이미 존재
- 설치된 release와 다른 digest를 bootstrap으로 덮어쓰려는 경우
- 설치된 StorageClass 또는 Console origin을 즉석에서 변경하려는 경우
- 서명 BOM과 이미지·source revision이 불일치
- tag-only 또는 비공식 registry 이미지가 manifest에 남음
- 구형 아키텍처 installation lock을 in-place 변환하려는 경우

## 검증

```powershell
opensphere-setup verify --context docker-desktop --console https://localhost:1114 --require-zero-restarts
```

검증 범위:

- 13개 release 이미지(2개 suspended recovery CronJob 포함)가 release lock digest와 정확히 일치
- rollout, Pod Ready, 필요 시 restart 0
- 12개 Service의 ready EndpointSlice
- 필수 Secret key 존재와 4개 PVC `Bound`
- Supabase schema, role, RLS 및 트랜잭션 append/read/rollback
- Supabase Auth/REST health
- Supabase Storage `put → get/byte compare → delete`
- Gitea private repository, protected `main`, signed commit 정책
- Gitea 임시 branch `commit → read → delete/revert → branch cleanup`
- Backend readiness와 최초 관리자 상태

검증 결과는 `opensphere-installation-evidence` ConfigMap에 비밀값 없이 기록한다.

```powershell
kubectl --context docker-desktop -n opensphere-console `
  get configmap opensphere-installation-evidence `
  -o jsonpath="{.data.evidence\\.json}"
```

## 업그레이드

```powershell
opensphere-setup upgrade --release edge --context docker-desktop
```

Setup은 target과 현재 rollback artifact를 먼저 모두 검증·materialize한 다음 target을 적용한다.
target 검증이 실패하면 이전 Supabase/Gitea release를 다시 적용하고 이전 release 검증까지
완료해야 rollback 성공으로 본다. PostgreSQL migration은 forward-compatible 원칙을 전제로 한다.

lock 기록 전후, workload 일부 적용, Console 완료 후 `os` CLI 설치 실패, StorageClass 불일치
등의 복구 판단은
[`docs/PARTIAL-FAILURE-RECOVERY.md`](docs/PARTIAL-FAILURE-RECOVERY.md)를 따른다.

## OAA 기능 준비 상태

기본 설치는 OAA schema와 PostgreSQL lexical search를 제공한다. 별도 OpenAI-compatible
embedding provider, API key와 1536차원 모델이 검증되기 전에는 semantic vector search가
`Degraded`이고 lexical fallback이 사용된다. 이는 플랫폼 bootstrap 실패가 아니지만 OAA의
`fullyOperational` 조건은 아니다. 설치 후 OAA 관리 화면에서 provider를 등록하고 실제
`/embeddings` probe가 성공해 `semanticSearch.ready=true`인지 확인한다.

## 채널 상태

- `edge`: disposable 개발 클러스터용 현재 구현 경로
- `candidate`, `stable`: **HOLD**

`candidate`와 `stable`은 별도 클러스터/장애 도메인에서 Supabase PostgreSQL, Supabase Storage,
Gitea와 Gitea PostgreSQL의 통합 백업·복구 drill 및 증거 계약이 구현되기 전까지 bootstrap과
upgrade가 의도적으로 실패한다. 구형 RustFS 감사 백업 옵션으로 이 gate를 우회할 수 없다.

## 제거

데이터를 포함한 관리 설치 전체 삭제:

```powershell
opensphere-setup uninstall `
  --context docker-desktop `
  --purge-data `
  --confirm DELETE-OPENSPHERE
```

Setup은 installation lock이 소유권을 증명한 네임스페이스, 관리 CRD/RBAC, 관련 retained PV만
대상으로 삼는다. lock이 없거나 소유 네임스페이스가 불완전하면 제거를 거부한다.

개발 E2E 전체 초기화:

```powershell
npm run test:e2e:edge
```

이 명령의 Docker Desktop cluster reset은 로컬 개발 전용이다.

## 폐기된 아키텍처

다음 요소는 현재 bootstrap 대상이 아니다.

- Kanidm 및 구형 Auth BFF/OIDC bootstrap
- `opensphere-console-auth`
- `opensphere-backbone`
- 별도 Console Backbone PostgreSQL
- RustFS
- `BackboneClaim` 기반 CBS orchestration
- 구형 service credential rotation 명령

구형 installation lock 또는 위 리소스가 남아 있으면 자동 혼합 설치하지 않는다. 데이터가 필요하면
별도의 명시적 migration/export-import 절차를 작성하고, 그렇지 않은 새 설치는 관리 제거 또는
검증된 수동 정리 후 수행한다.

## 주요 소스

```text
Install-OpenSphereSetup.ps1     Windows 사용자 명령 등록
src/cli.mjs                    명령 진입점
src/release.mjs                서명 BOM·attestation·digest lock
src/bootstrap.mjs              설치·재개·업그레이드·rollback·제거
src/verify.mjs                 설치 후 데이터/서비스/이미지 검증
src/doctor.mjs                 무변경 로컬·클러스터 설치 사전진단
src/reset-initial-admin.mjs    edge 개발용 Supabase 관리자 초기화
scripts/e2e-clean-install.ps1  Docker Desktop clean-install 반복 검증
scripts/e2e-first-admin.mjs    Supabase 최초 관리자 Wizard E2E
```

실제 runtime 정본은 같은 release revision의 `OpenSphere-console`에 있다.

```text
backend/supabase/
backend/gitea/
backend/notification-dispatcher/
backend/opensphere-console-backend/
backend/opensphere-console-oaa-gateway/
backend/oaa-governed-adapter/
backend/dupa-control/
deploy/opensphere-console.yaml
```
