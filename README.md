# OpenSphere Setup CLI

OpenSphere OS Console의 신뢰 가능한 최초 설치, 재개, 검증, 업그레이드 및 제거를 담당한다.
현재 정본은 **Supabase Data & Identity Backbone + 별도 Gitea Change Authority**이다.

## 다운로드 후 바로 실행

Setup CLI는 Windows에 설치해 상시 사용하는 프로그램이 아니다. 필요한 때 실행해 Kubernetes의 Console을 준비·설치·검증하고 종료한다. **Setup 설치, PATH 등록, 서비스 등록은 하지 않는다.**

현재 소스 버전은 `0.5.0-edge.28`이며 OpenSphere 전용 OAuth App의 Device Flow를 포함한다. 이번 버전은 Main Index 콘텐츠를 Console 실행 이미지와 독립적으로 잠그고, Docker Desktop의 Kubernetes API endpoint 변경을 최소 권한으로 복구한다. [변경 사항](docs/CONSOLE-INDEX-CONTENT-EDGE28.md)을 참고한다.

**현재 수정 범위:** edge.28은 Console 실행 이미지와 Main Index 콘텐츠의 릴리스 단위를 분리하되 하나의 installation lock으로 검증한다. 첫 도입은 renderer와 콘텐츠를 원자적으로 전환하고, 이후 콘텐츠 전용 변경은 Console Deployment만 다시 적용한다. Extension Controller는 Docker Desktop 재기동으로 바뀐 Kubernetes API endpoint를 exact host CIDR로 복구한다. 이미지 기동이나 단위 시험만으로 전체 Kubernetes 설치 성공을 표시하지 않는다.

### Windows amd64 — 한 번 다운로드하고 재사용하는 포터블 실행 파일

[**opensphere-setup.exe 다운로드**](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.28/opensphere-setup.exe)

```powershell
.\opensphere-setup.exe version
.\opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop --registry-auth oauth
.\opensphere-setup.exe --version 0.5.0-edge.28 resolve --release edge --registry-auth oauth
```

버전·채널 선택자는 명령 앞에 두며 상호 배타적이다. 옵션을 생략하면 EXE가 발행된 exact Release를 사용한다. `--release`와 `--lock`은 Console 배포 선택자다.

**같은 버전은 한 번만 다운로드한다.** 실행 파일 옆의 `opensphere-setup-runtime/<release-tag>/`에 검증된 ZIP과 압축 해제한 런타임을 보관한다. 이후 같은 버전의 명령은 파일 무결성을 확인해 그대로 재사용한다. 정상 종료·명령 실패 뒤에도 보존하며, `edge`가 새 버전을 가리킬 때만 해당 버전을 새로 받는다.

채널·immutable Release 메타데이터의 작은 온라인 조회는 실행마다 유지한다. 보관 ZIP의 GitHub SHA-256을 대조하고, 런타임 파일 전체를 원본 ZIP과 비교한다. 훼손된 버전은 실행하지 않으며 자동 삭제하거나 덮어쓰지 않는다. 읽기 전용 위치라면 EXE를 쓰기 가능한 폴더로 옮긴다. LocalAppData에 우회 설치하지 않는다.

**첫 다운로드는 버전당 약 174MB이며 내부 Node CLI는 여전히 약 99MiB다.** 보관 ZIP과 런타임을 합쳐 버전당 약 610MiB를 사용하므로 1GiB 이상 여유 공간을 확보한다. EXE와 `opensphere-setup-runtime` 폴더를 함께 옮기면 재사용할 수 있고, 사용 중인 명령을 종료한 뒤 함께 지우면 제거된다. 이전 버전도 자동으로 삭제하지 않는다. `edge.19` 실행기는 이 동작으로 자동 변경되지 않으므로 **새 EXE로 한 번 교체해야 한다.**

### 압축형 포터블 패키지 — Windows/Linux/macOS

해당 OS·CPU 아카이브를 검증해 원하는 폴더에 풀고 그 자리에서 실행한다. Windows는 `.\opensphere-setup.exe`, Linux/macOS는 `./opensphere-setup`을 사용하며 `runtime` 폴더를 함께 보존한다. 호스트에 Node.js, PowerShell, kubectl을 별도 설치할 필요는 없다.

이후 `opensphere-setup` 예제는 위 실행 파일의 경로로 대체한다. 전역 PATH 등록을 전제하지 않는다.

실행·체크섬 절차는 [`docs/PLATFORM-INSTALL.md`](docs/PLATFORM-INSTALL.md), 제품 기준은 [`docs/PORTABLE-EXECUTION-CONTRACT.md`](docs/PORTABLE-EXECUTION-CONTRACT.md)를 따른다. 이전 `Install-OpenSphereSetup.exe` 설치기는 사용하지 않는다. candidate/stable은 서명·공증 전까지 HOLD다.

`bootstrap`과 `upgrade`는 호스트 `os` CLI를 자동 설치하지 않는다. 필요하면 `install-cli`를 별도로 실행한다. Windows 개발 CA 신뢰 등록도 `bootstrap --trust-local-ca`를 명시한 경우에만 수행한다.

대화형 터미널에서 `bootstrap`, `doctor`, `upgrade` 같은 운영 명령을 시작하면 ANSI Shadow
OpenSphere 배너를 표시한다. 파이프·CI 및 `version` 같은 기계 판독 출력에는 표시하지
않는다. 제한된 터미널에서는 `OPENSPHERE_NO_BANNER=1`로 끌 수 있다.

소스 설치 요구 사항은 Node.js 24 이상, PowerShell 7(`pwsh`), `kubectl`, Kubernetes Ready
노드, 기본 또는 명시한 동적 StorageClass이다. 공개 platform 아카이브는 Node.js,
PowerShell, kubectl과 Linux의 libatomic을 포함한다. 공개 `edge` 설치에는 GitHub CLI가
필요하지 않으며, `candidate`/`stable` OCI attestation 검증에서만 `gh`를 요구한다. Console
GHCR package가 private이면 `--registry-auth oauth`로 인증하거나 read-only package credential을 stdin으로 전달한다.

지원 계약:

| 항목 | 지원/요구 |
|---|---|
| Setup 실행 호스트 | Windows amd64, Linux amd64/arm64, macOS amd64/arm64 |
| Kubernetes | v1.30 이상 |
| Kubernetes 노드 | linux/amd64, linux/arm64 |
| 영속 볼륨 요청 | Supabase 70Gi + Gitea 18Gi + Beszel 10Gi = 총 98Gi |
| Docker Desktop 검증 시작 프로필 | 10 CPU, 16GiB RAM; 최소값이 아니라 검증된 시작점 |

StorageClass가 98Gi를 provision할 수 있는지와 실제 물리 디스크 여유 공간은 운영자가 확인한다.
macOS 준비·설치·인증서 신뢰 절차는
[`docs/MACOS-INSTALL.md`](docs/MACOS-INSTALL.md)를 따른다.

## 현재 설치 방법론

클러스터 운영자는 지원 버전의 건강한 Kubernetes, Ready 노드, StorageClass와 필요한 권한을 제공한다. Setup은 Docker Desktop이나 kubelet을 재시작하지 않고 Pod Security를 낮추지 않는다. node health 또는 Beszel Agent의 root/read-only hostPath 계약이 admission 정책과 충돌하면 변경 전에 원인을 표시하고 중단한다.

Setup은 태그를 그대로 설치하지 않는다.

1. 선택 채널의 Release BOM 또는 local-edge release lock을 조회한다.
2. canonical 18개와 renderer-aware auxiliary 4개의 source revision, repository, exact image digest, release scope를 검증한다. 이전 3개 auxiliary 설치 lock은 rollback·원자적 전환을 위해 계속 읽을 수 있다.
3. installation 상태를 `Preparing`으로 만들고 immutable lock과 materialized source를 준비한다.
4. Supabase, Gitea, Beszel bootstrap core를 설치하고 migration, control-plane seed, monitoring bootstrap Job을 완료한다.
5. Console API(C_API), Extension Controller(C_EXT), Registry, OS CLI와 Main Shell을 digest-pinned image로 설치한다.
6. 데이터 경계, rollout, endpoint, image digest, Storage/Gitea/Beszel 동작을 검증한다.
7. 검증 증거를 기록한 뒤에만 installation 상태를 `Ready`로 전이한다.
8. 이후 optional module과 OS Shell 활성화는 Console 설정 기능이 담당한다.

설치 중 생성한 암호와 키는 argv나 release lock에 넣지 않는다. 기존 Secret이 있으면 누락된 키만 보완하며 정상 재개에서 암묵적으로 회전하지 않는다.

## 기본 런타임

Release BOM의 canonical component는 18개다. 이 중 Setup이 fresh bootstrap에서 배포하는 core는 13개다.

| bootstrap core | 역할 |
|---|---|
| `console` | Main Shell UI |
| `consoleApi` | Console API(C_API), identity와 operation 경계 |
| `extensionController` | Extension Controller(C_EXT), 플러그인 control plane |
| `registry` | extension registry |
| `supabasePostgres`, `supabaseAuth`, `supabaseRest`, `supabaseStorage` | 데이터와 identity backbone |
| `gitea`, `giteaPostgres` | 선언 변경, review와 이력 권위 |
| `beszelHub`, `beszelAgent`, `beszelBootstrap` | baseline host observability |

나머지 canonical 5개는 lock에 exact digest를 보존하되 Setup이 암묵 배포하지 않는다. Console이 설치 후 `osaaGateway`, `osdst`, `osaaGovernedAdapter`, `notificationDispatcher`, `recovery`를 활성화한다. 활성화된 `osaaGateway`는 이후 구성 단위 릴리스에서 전용 매니페스트와 롤아웃 계약으로 갱신하며, Console core를 재배포하지 않는다.

Auxiliary artifact는 `cliArtifacts`, `osShellControl`, `osShellRuntime`, `consoleIndexContent` 4개다. Setup은 `cliArtifacts`를 lock에서 검증하지만 호스트에는 자동 설치하지 않는다. `install-cli`를 명시한 경우에만 내려받는다. OS Shell 2개는 Console 활성화에 필요한 digest를 lock에서 제공하며 bootstrap core에는 포함하지 않는다. `consoleIndexContent`는 Console Pod의 initContainer가 Main Index 정적 콘텐츠를 공유 볼륨에 투영하며, 콘텐츠만 바꿀 때 Console 실행 이미지를 다시 만들지 않는다.

Supabase Auth의 `auth.users.id`가 사용자 canonical subject다. Supabase PostgreSQL은 Console state, RBAC와 audit을 소유하고 Supabase Storage는 object storage를 소유한다. Gitea는 선언형 desired state, review와 signed change history를 소유한다. Kubernetes Secret은 runtime credential 전달 수단이며 사용자 identity authority가 아니다.

DUPA control-plane 책임은 C_EXT에 통합되었다. `backend`와 `dupaController`는 legacy lock 복구에서만 해석하며 target canonical component가 아니다.

## 네임스페이스와 영속 볼륨

Setup이 소유하는 namespace는 정확히 다음 5개다.

```text
opensphere-console-data
opensphere-console-change
opensphere-monitoring
opensphere-console
opensphere-system
```

`opensphere-developer*`, `opensphere-www`, Foundation, Recovery와 optional module namespace는 다른 owner의 영역이다. bootstrap, verify, E2E cleanup과 uninstall은 이들을 prefix로 추정하거나 삭제하지 않는다.

필수 PVC:

```text
opensphere-console-data/opensphere-supabase-postgres-data
opensphere-console-data/opensphere-supabase-storage-data
opensphere-console-change/opensphere-gitea-postgres-data
opensphere-console-change/opensphere-gitea-data
opensphere-monitoring/beszel-hub-data
```

총 요청량은 98Gi다. 각 Setup 소유 namespace에는 `opensphere-ghcr-pull`이 생성되고 모든 workload가 이를 명시한다. 공개 package는 anonymous docker config를, 비공개 package는 stdin으로 받은 GHCR credential을 사용한다.

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
확인한 뒤 target manifest, migration과 installer를 실제 source revision에서 모두
다운로드하고 렌더링한다. 이 단계가 실패하면 namespace, installation lock과 Secret을 만들지
않는다. PVC 98Gi는 요청량으로 보고하며 실제 provisioner 용량을 대신 보증하지 않는다.

`edge`는 개발 클러스터의 Linux 노드 아키텍처만 포함한 host-native 이미지도 허용한다.
로컬 발행본은 `localhost`, `pre-ga`, `ga-eligible=false`, 날짜 태그와 전체 source
revision 라벨 및 immutable release tag가 canonical 18개와 renderer-aware auxiliary 4개에서 일치해야 한다.
각 artifact의 `io.opensphere.release-scope`도 canonical 또는 auxiliary 역할과 일치해야 한다.
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

- installation lock의 소유권과 5개 Setup target namespace가 불일치
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

- 13개 bootstrap core와 배포된 OS CLI image가 release lock의 exact digest와 일치
- Console API, Extension Controller, Registry, Supabase, Gitea, Beszel Hub/Agent rollout과 Pod Ready
- 필수 Service의 ready EndpointSlice, Secret key와 5개 PVC `Bound`
- Supabase target schema, role, RLS와 트랜잭션 round trip
- Supabase Auth/REST health와 Storage `put → get/byte compare → delete`
- Gitea private repository, protected `main`, signed commit 정책과 임시 branch round trip
- Beszel bootstrap Job 완료, Hub public key, private ClusterIP-only Hub와 Agent 연결
- C_API readiness, cookie 기반 최초 관리자 상태
- installation state의 ownership, `verification.completed=true`, 그리고 `Ready` phase

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

## 설치 후 모듈 활성화

Setup은 available module을 자동으로 배포하거나 provider 설정을 추정하지 않는다. 관리자는 Console 설정에서 OAA, notification, recovery와 OS Shell을 활성화한다. Console은 최초 installation lock에 보존된 exact digest만 사용해야 하며 mutable `:edge`를 다시 해석하지 않는다.

OAA semantic search는 별도 OpenAI-compatible embedding provider, API key와 승인된 model이 검증되기 전까지 `Degraded`일 수 있다. 이 상태는 bootstrap core 실패가 아니다. provider credential과 기능 준비 상태는 설치 후 Console이 관리한다.

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
대상으로 삼는다. lock이 없거나 소유 네임스페이스가 불완전하면 제거를 거부한다. 관리 namespace가
종료된 뒤 namespaced CRD의 cluster-wide 인스턴스를 다시 조회하며, 하나라도 남아 있으면 다른 제품의
리소스로 간주해 CRD와 후속 cluster-scoped 삭제를 중단한다.

개발 E2E 전체 초기화:

```powershell
npm run test:e2e:edge
```

이 명령은 정확한 5개 Setup target namespace와 target-owned cluster-scoped resource만
정리한다. `opensphere-developer*`, `opensphere-www` 등 다른 OpenSphere 제품 namespace의
UID가 유지되는지 전후로 검증하며 cluster-wide reset은 수행하지 않는다.

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
launchers/windows/             Windows 무설치 포터블 실행기
src/cli.mjs                    명령 진입점
src/installation-contract.mjs  Setup ownership와 installation phase 계약
src/release.mjs                서명 BOM, attestation과 digest lock
src/bootstrap.mjs              설치, 재개, 업그레이드, rollback과 제거
src/verify.mjs                 설치 후 데이터, 서비스와 image 검증
src/doctor.mjs                 무변경 로컬, 클러스터 설치 사전진단
scripts/e2e-clean-install.ps1  target-scoped clean-install 반복 검증
scripts/e2e-first-admin.mjs    C_API cookie 기반 최초 관리자 E2E
```

실제 runtime 정본은 같은 release revision의 `OpenSphere-Console`에 있다.

```text
migrations/
backend/supabase/target/
backend/gitea/bootstrap/
deploy/baseline-monitoring/
apps/console-api/
apps/extension-controller/
backend/registry/
cmd/os-cli/
deploy/opensphere-console.yaml
```


## GitHub OAuth 인증과 GHCR 접근

`--registry-auth oauth`를 지정하면 등록된 OpenSphere 앱으로 기기 인증을 시작한다. 표시된 GitHub 주소에서 일회용 코드를 승인한다. 공개 Client ID는 실행 파일에 포함되며 Client Secret/PAT는 포함되지 않는다. 기본 auto 모드는 자동으로 브라우저 인증을 시작하지 않는다.

`resolve`는 선택된 Console 릴리스의 GHCR 접근·공급망 정책을 검사하고 토큰 없는 lock을 저장한다. `doctor`는 동일 인증에 더해 로컬 Kubernetes 설치 준비 상태를 읽기 전용으로 검사한다. `status`는 Kubernetes Pod 조회이며 GitHub 로그인을 수행하지 않는다.

`read:packages offline_access`만 요청하며 repo/write/admin 권한이 포함된 credential은 운영 인계를 거부한다. 토큰은 실행 프로세스 메모리에만 두며 Windows 런타임 보관 폴더에 저장하지 않는다. 따라서 별도 명령을 새로 실행하면 OAuth 승인이 다시 필요할 수 있다. 런타임 ZIP 다운로드 재사용과 OAuth 로그인은 별개다.

**Console 설치와 운영 인계는 별도 호환 조건이다.** OAuth credential을 `bootstrap`에 넘기려면 대상 Console이 `registry-auth/v1`을 활성화해야 한다. 기존 Console 릴리스가 이를 지원하지 않으면 namespace/credential 쓰기 전에 중단한다. 이 Setup 릴리스만으로 기존 Console에 refresh worker를 설치하거나 활성화하지 않는다. 기존 설치의 `upgrade --registry-auth oauth`는 임시 인증을 공급망 검증에만 사용하며 기존 운영 Secret을 보존한다. 운영 credential 교체·갱신은 Console 재인증 또는 별도 복구 절차를 따른다.

[인증·저장·재인증 계약과 현재 검증 범위](docs/REGISTRY-AUTH-LIFECYCLE.md)를 참고한다.
