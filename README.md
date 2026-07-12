# OpenSphere Setup CLI — Bootstrap Product Specification

> **Status**: Channel-aware bootstrap 0.2 implementation and clean-cluster E2E
> **Version**: 0.2.0-edge.1
> **Date**: 2026-07-12  
> **Scope**: 기존 Kubernetes 환경에 OpenSphere Console을 최초 기동하는 독립 실행형 Setup CLI와 공통 bootstrap engine  
> **Target users**: Kubernetes 전문 지식이 없는 설치 담당자와 자동화 운영자

관련 구현 계약:

- [릴리스 배포 및 버전 선택 구현 계획](./RELEASE-DISTRIBUTION-AND-VERSION-SELECTION.md)

현재 실행 가능한 channel bootstrap:

```powershell
opensphere-setup.cmd resolve --release edge
opensphere-setup.cmd bootstrap --release edge
opensphere-setup.cmd bootstrap --release candidate
opensphere-setup.cmd bootstrap --release stable
```

기본 최초 관리자 이름은 Kanidm 예약 계정 `admin`과 충돌하지 않는 `opensphere-admin`이다.
다른 이름을 원하면 최초 설치 시 `--admin-username`, `--admin-display-name`, `--admin-email`을
지정한다. `admin`, `idm_admin`, `anonymous`는 identity 예약 계정이므로 Setup이 설치 전에 거부한다.

`resolve`는 channel tag를 9개 canonical GHCR image digest로 해석해 release lock을 만든다.
새 cluster의 `bootstrap`은 요청 channel을 설치 시점에 새로 해석하고, cluster에 installation lock이
있으면 그 digest만 사용해 resume한다. `--lock`은 명시적으로 제공한 immutable 입력일 때만 사용하며
로컬 cache를 묵시적으로 재사용하지 않는다. 모든 Kubernetes workload는 digest-pinned image만 받는다.

Setup은 설치 완료 전에 다음을 직접 검증한다.

- 9개 canonical image와 동일 source revision
- Kubernetes v1.30+, linux/amd64 Ready node, 필수 RBAC, StorageClass
- 14개 Ready Pod의 정지상태와 release lock/runtime image 일치
- 4개 Bound PVC, PostgreSQL/pgvector 기능
- Kanidm 최초 관리자와 Console service credential 실제 조회
- Console, readiness, OIDC discovery, BFF, 최초 관리자 Wizard endpoint
- 재실행 시 bootstrap Secret payload 불변성

반복 가능한 파괴적 E2E:

```powershell
# Docker Desktop Kubernetes 자체를 초기화하고 edge 설치/재실행 검증
./scripts/e2e-clean-install.ps1 -Channel edge -FullClusterReset

# release lock 직후 Setup을 강제 종료한 뒤 resume 검증
./scripts/e2e-clean-install.ps1 -Channel edge -InterruptAfterLock
```

현재 구현은 로컬 `node`와 `kubectl`을
사용하는 개발 단계이며, 이 문서가 요구하는 단일 실행 파일·내장 Kubernetes client·서명 검증은
후속 distribution 단계의 완료 gate로 유지한다.

---

## 0. 목적

OpenSphere는 이미 설치·운영 중인 Kubernetes 위에 올라가는 통합 운영 솔루션이다. 설치 완료 후의 모든 일반 설치·운영은 Console Web GUI에서 수행한다.

그러나 Console이 아직 없는 최초 시점에는 사용자가 YAML, Helm, `kubectl`, StorageClass, Ingress 또는 인증서 구조를 이해하지 않아도 OpenSphere를 기동할 수 있는 진입점이 필요하다.

이 컴포넌트의 목표는 다음 사용자 경험을 제공하는 것이다.

```text
실행 파일 다운로드
→ 실행
→ Kubernetes 선택
→ “OpenSphere 설치” 선택
→ Bootstrap Console 열림
→ GUI 안내에 따라 CBS 구성
→ Main Shell 정상 모드 전환
```

최초 설치에 필요한 사용자 측 소프트웨어는 **OpenSphere Setup 실행 파일 하나**여야 한다.

---

## 1. 핵심 결정

### 결정 1 — 하나의 독립 실행 파일

Setup은 다음 도구를 사용자에게 별도로 요구하지 않는다.

- `kubectl`
- Helm
- Node.js 또는 npm
- Python
- Docker CLI
- Git
- 별도 Web server

Kubernetes client, release 검증기, bootstrap manifest, 상태 관리와 local port-forward 기능을 실행 파일에 포함한다.

### 결정 2 — CLI와 GUI는 동일한 엔진

CLI와 GUI가 서로 다른 설치 절차를 구현해서는 안 된다.

```text
CLI adapter ─┐
             ├─ Bootstrap Engine ─ Kubernetes API
GUI adapter ─┘
```

- CLI는 terminal과 자동화 환경을 위한 interface다.
- GUI는 동일 실행 파일이 제공하는 embedded web UI다.
- 두 interface는 동일한 상태머신, release digest, RBAC와 결과 계약을 사용한다.

### 결정 3 — HIS는 초기 Console 기동의 선행 gate가 아님

설치 전에 전체 HIS를 검사하고 부족하면 Console 기동 자체를 막지 않는다.

먼저 **Console Bootstrap Mode**를 기동한다. Bootstrap 단계에서는 CBS를 구성하는 데 필요한 최소 prerequisite만 확인하고 부족한 조건을 안내한다. 전체 HIS Preflight는 Main Shell과 Cluster Manager 활성화 이후 Console 내부에서 수행한다.

단, Kubernetes API 접근과 workload를 실행할 수 있는 최소 실행 조건조차 없으면 어떤 소프트웨어도 배포할 수 없다. 이는 HIS Ready gate가 아니라 물리적 연결 실패로 취급한다.

### 결정 4 — CBS 없는 정상 Console은 없음

Console Bootstrap Mode는 정상 운영 Console이 아니다. PostgreSQL·RustFS·Gitea로 구성된 **Console Backbone Service Stack (CBS)**가 Ready가 되기 전에는 설치·복구 기능만 허용한다.

```text
Kubernetes
→ Console Bootstrap Mode Available
→ CBS Prerequisite Check
→ CBS Installing
→ CBS Verifying
→ CBS Ready
→ Main Shell Baseline Ready
```

### 결정 5 — 별도 subShell 또는 Service Stack이 아님

OpenSphere Setup CLI는 다음 어느 것도 아니다.

- subShell
- plugin
- Binding
- 네 번째 Service Stack
- cluster 내부의 장기 운영 control plane

설치를 시작하고 Bootstrap Console로 인계하는 외부 bootstrap client다.

---

## 2. 제품과 실행 파일

권장 제품명과 binary name은 다음과 같다.

| 대상 | 파일/명령 | 설명 |
|---|---|---|
| Windows GUI/CLI | `OpenSphere-Setup.exe` | 더블클릭 시 GUI, terminal 인자 사용 시 CLI |
| Linux | `opensphere-setup` | GUI 또는 headless CLI |
| macOS | `OpenSphere Setup.app` / `opensphere-setup` | GUI package와 CLI entry |

내부 canonical command name은 `opensphere-setup`으로 통일한다.

### 2.1 설치 후 `os` CLI와의 경계

`opensphere-setup`과 Console-native `os`는 역할이 다르다.

| 도구 | 사용 시점 | 권위와 책임 |
|---|---|---|
| `opensphere-setup` | Console 설치 전·설치 중·bootstrap 복구 | Kubernetes 연결, Bootstrap Console 배포, CBS 설립, Main Shell 인계 |
| `os` | Main Shell Ready 이후 | Console administrator CLI, Console API와 동일한 관리 계약 |

`opensphere-setup`이 정상 운영용 `os` 명령을 복제해서는 안 된다. Main Shell 인계 후 일반 관리 기능은 Console GUI와 `os`가 소유한다.

---

## 3. 최소 사용자 흐름

### 3.1 GUI 기본 흐름

1. 실행 파일을 더블클릭한다.
2. Setup이 표준 위치에서 kubeconfig를 자동 발견한다.
3. 연결 가능한 cluster를 사람이 이해할 수 있는 이름으로 보여준다.
4. 사용자가 대상 cluster를 선택한다.
5. `OpenSphere 설치`를 선택한다.
6. Setup이 signed bootstrap release를 검증한다.
7. Setup이 Console Bootstrap Mode를 배포한다.
8. Setup 자체 port-forward로 Bootstrap Console을 연다.
9. Console에서 host capability와 CBS 구성을 완료한다.
10. CBS Ready가 확인되면 같은 URL에서 Main Shell 정상 모드로 전환한다.

### 3.2 CLI 기본 흐름

대화형 설치:

```powershell
opensphere-setup bootstrap
```

대상 context 지정:

```powershell
opensphere-setup bootstrap --context production-cluster
```

자동화 설치:

```powershell
opensphere-setup bootstrap \
  --context production-cluster \
  --release stable \
  --non-interactive
```

명령 완료는 Main Shell이 Production Ready라는 뜻이 아니다. 기본 성공 기준은 Bootstrap Console에 인계됐거나 사용자가 선택한 `--wait` 단계까지 도달했다는 의미다.

```powershell
opensphere-setup bootstrap --wait cbs-ready
opensphere-setup bootstrap --wait main-shell-ready
```

---

## 4. 명령 모델

### 4.1 초기 명령 집합

| 명령 | 목적 | 기본 변경 여부 |
|---|---|---|
| `bootstrap` | Bootstrap Console 설치 또는 기존 설치 resume | 변경 |
| `status` | live bootstrap 상태와 다음 조치 표시 | 읽기 전용 |
| `open` | local secure tunnel을 열고 Console 실행 | local 변경 |
| `resume` | 중단된 설치를 live state에서 재개 | 변경 |
| `repair` | 승인된 bootstrap resource만 desired state로 복구 | 변경 |
| `logs` | bootstrap event와 제한된 진단 로그 출력 | 읽기 전용 |
| `bundle verify` | release/offline bundle signature·digest·SBOM 검증 | 읽기 전용 |
| `cleanup` | Main Shell 인계 후 임시 bootstrap 권한·자원 제거 | 변경 |
| `version` | Setup binary와 embedded contract version 출력 | 읽기 전용 |

### 4.2 의도적으로 제공하지 않는 명령

- 임의 YAML apply
- 임의 shell/exec
- 임의 SQL 실행
- host CNI·CSI·Ingress controller·cert-manager 설치/삭제
- subShell/plugin 자동 설치
- 정상 운영용 Console API mutation

Setup은 범용 Kubernetes 관리 도구가 아니다.

---

## 5. Bootstrap 상태머신

```text
NotStarted
→ Connecting
→ ReleaseVerified
→ BootstrapConsoleInstalling
→ BootstrapConsoleAvailable
→ CBSPrerequisitesChecking
→ CBSInstalling
→ CBSVerifying
→ CBSReady
→ MainShellActivating
→ Completed

각 단계 → Blocked
각 단계 → FailedRetryable
Blocked/FailedRetryable → Resume
```

### 5.1 상태 원칙

- 상태는 local progress file이 아니라 cluster live state에서 파생한다.
- 같은 desired release를 반복 실행하면 no-op이어야 한다.
- Setup을 종료하거나 다른 PC에서 실행해도 같은 단계에서 재개해야 한다.
- 파일 존재나 Pod `Running`만으로 단계를 완료하지 않는다.
- 실패는 `reason`, 사용자 메시지, 재시도 가능 여부와 다음 조치를 포함한다.

### 5.2 상태 객체

진행 상태는 제한된 bootstrap CR로 표현한다.

```yaml
apiVersion: bootstrap.opensphere.io/v1alpha1
kind: OpenSphereBootstrap
metadata:
  name: default
spec:
  releaseRef: stable
  desiredStage: MainShellReady
status:
  phase: CBSInstalling
  bootstrapConsoleAvailable: true
  cbsReady: false
  mainShellReady: false
  conditions: []
  nextAction:
    code: ConfigureStorage
    message: 영구 데이터 저장 위치를 선택하세요.
```

CRD가 없으면 Setup이 embedded signed manifest에서 최초 1회 설치한다.

---

## 6. Console Bootstrap Mode

Bootstrap Mode는 Main Shell과 같은 Console 제품·배포 단위를 사용하되, CBS Ready 전의 제한된 상태다.

### 6.1 허용 기능

- 대상 cluster와 설치 release 확인
- host capability 발견
- CBS 설치·상태·복구
- 설치 event와 원인 진단
- 안전한 retry/resume
- Console 접근 주소 설정
- bootstrap journal 조회

### 6.2 금지 기능

- 일반 `/manage/*` mutation
- Extension, subShell, plugin 설치
- 사용자·역할·정책의 일반 관리
- Developer Catalog의 workload 설치
- 임의 Kubernetes resource 편집
- 정상 운영 상태 또는 Production Ready 표시

### 6.3 필수 표시

CBS Ready 전에는 모든 화면에서 다음 의미를 분명히 전달한다.

```text
Bootstrap Mode
OpenSphere Console의 필수 상태저장 기반을 구성하고 있습니다.
일반 관리 기능은 CBS Ready 이후 사용할 수 있습니다.
```

---

## 7. Host capability 처리

전체 HIS Ready를 bootstrap 선행조건으로 만들지 않는다. Console이 기동된 뒤 capability별로 다음 상태를 표시한다.

```text
Available | Missing | Incompatible | NotRequired | Unknown
```

| 발견 결과 | Console/Setup 동작 |
|---|---|
| IngressClass 없음 | embedded port-forward로 접근 유지, 외부 URL 설정은 Pending |
| cert-manager 없음 | bootstrap TLS 사용, 운영 인증서 설정은 Pending |
| StorageClass 없음 | Bootstrap Console 유지, CBS 영구 volume 단계에서 안내·Blocked |
| VolumeSnapshot 없음 | 설치 계속 가능, Production Backup/Restore gate는 Not Ready |
| metrics/Prometheus 없음 | Console 기동, Observability capability만 Pending |
| 선택 adapter용 Crossplane 없음 | 해당 adapter만 NotAvailable |

Setup과 Console은 host capability를 임의 설치·업그레이드·삭제하지 않는다. 부족한 capability는 설명과 호스트 관리자용 요청 자료를 제공한다.

---

## 8. CBS 설치와 Main Shell 인계

CBS는 다음 세 기둥이다.

```text
PostgreSQL + RustFS + Gitea = Console Backbone Service Stack (CBS)
```

### 8.1 설치 순서

```text
namespace/RBAC
→ CBS credentials
→ PostgreSQL
→ RustFS + Gitea
→ schema/bucket/config seed
→ actual I/O verification
→ bootstrap journal import
→ CBS Ready
→ Main Shell activation
```

신규 Setup의 CBS PostgreSQL은 PostgreSQL 19로만 clean install한다. 기존 OpenSphere/CBS가 발견되면 Setup은 실행 중인 PostgreSQL major version이나 데이터를 변경하지 않으며, 기존 데이터의 major-version migration은 초기 Setup 범위에 포함하지 않는다.

### 8.2 Ready 검증

- PostgreSQL: connect, append, read와 append-only control
- RustFS: canary object `put → get/hash verify → delete`
- Gitea: desired-state repository commit/read와 revision 확인
- 세 workload health와 persistent storage binding
- 관리 audit의 PostgreSQL import와 이후 fail-closed 확인

Pod `1/1`만으로 CBS Ready를 표시하지 않는다.

### 8.3 인계

CBS Ready 후 Setup은 다음을 수행한다.

1. Main Shell readiness를 확인한다.
2. Bootstrap Mode를 정상 Main Shell mode로 전환한다.
3. 임시 bootstrap 권한을 제거하거나 최소화한다.
4. 최종 release digest와 결과를 durable audit에 기록한다.
5. Console URL을 사용자에게 제공하고 브라우저를 연다.

---

## 9. Bootstrap 전용 감사 계약

CBS가 만들어지기 전에는 PostgreSQL durable audit가 없으므로 bootstrap 작업을 일반 Console 관리 write와 구분한다.

### 9.1 허용 범위

- embedded release에 포함된 allowlist resource만 server-side apply
- CBS와 Main Shell bootstrap에 필요한 고정된 단계만 실행
- 적용 manifest와 container image digest 기록
- 각 단계의 actor/context/time/result/reason 기록

### 9.2 Bootstrap journal

`OpenSphereBootstrap`에 hash-linked journal과 release evidence reference를 보존한다. 이 journal은 PostgreSQL audit의 대체물이 아니다.

CBS PostgreSQL이 Ready가 되면 journal을 `audit_log`로 가져오고 import 결과를 봉인한다. import가 실패하면 Main Shell 일반 write를 열지 않는다.

### 9.3 금지

- ConfigMap 또는 memory 기록을 정상 운영 감사로 승격
- journal import 전 Main Shell 일반 mutation 허용
- Secret 값, kubeconfig 또는 bearer token 기록
- bootstrap 범위를 넘는 임의 resource 변경

---

## 10. Kubernetes 연결과 자격증명

### 10.1 kubeconfig 발견

기본 탐색 순서:

1. `--kubeconfig` 명시 경로
2. `KUBECONFIG`
3. 사용자 표준 경로 `~/.kube/config`
4. GUI file picker

여러 context가 있으면 자동 선택하지 않고 cluster 이름·server·현재 context를 보여준 뒤 사용자가 선택하게 한다.

### 10.2 자격증명 안전

- kubeconfig를 cluster Pod, Console 또는 log로 복사하지 않는다.
- Setup process memory에서 필요한 동안만 사용한다.
- cluster 인증정보를 Setup 상태 CR에 저장하지 않는다.
- local GUI는 loopback에만 bind하고 session nonce를 사용한다.
- browser URL과 log에 token을 포함하지 않는다.

### 10.3 권한 부족

권한 부족을 기술 stack trace로만 표시하지 않는다.

```text
OpenSphere 설치 권한이 부족합니다.
필요 작업: namespace와 bootstrap resource 생성
호스트 관리자에게 전달할 권한 요청서를 저장할 수 있습니다.
```

Setup은 최소 RBAC 요청 manifest를 생성할 수 있지만 사용자의 승인 없이 다른 계정이나 권한을 만들지 않는다.

---

## 11. Local GUI와 Console 연결

GUI mode는 별도 Electron runtime을 요구하지 않는 방식을 우선한다.

권장 구현:

- Go single binary
- embedded Clarity v18 web assets
- loopback-only local HTTPS server
- system browser 자동 실행
- Kubernetes port-forward를 client library로 내장

```text
OpenSphere-Setup.exe
→ https://127.0.0.1:<random-port>/setup
→ embedded UI
→ Kubernetes API / Bootstrap Console tunnel
```

GUI 구성요소는 OpenSphere 통합 디자인 정책에 따라 Clarity v18을 사용하고, 승인된 Carbon icon과 지정 logo source만 사용한다.

---

## 12. Release와 공급망

Setup은 mutable tag만 신뢰해서 설치하지 않는다.

필수 release metadata:

- release version
- manifest digest
- component image digest
- supported Kubernetes range
- signature와 signer identity
- SBOM
- license metadata
- bootstrap contract version

설치 전에 signature와 digest를 검증한다. 검증 실패는 우회할 수 없는 `Blocked`다.

### 12.1 배포 파일

```text
OpenSphere-Setup-windows-amd64.exe
opensphere-setup-linux-amd64
opensphere-setup-linux-arm64
OpenSphere-Setup-darwin-universal.pkg
SHA256SUMS
SHA256SUMS.sig
setup-sbom.spdx.json
```

---

## 13. Online과 Offline 설치

### 13.1 Online 기본 경로

Setup은 signed release metadata를 받고 cluster node가 접근할 수 있는 registry의 digest-pinned image를 사용한다.

### 13.2 Offline bundle

폐쇄망용 bundle은 다음을 포함한다.

- release metadata
- Kubernetes manifests
- OCI image archive
- signature
- checksum
- SBOM
- compatibility metadata

```powershell
opensphere-setup bundle verify opensphere-airgap.osbundle
opensphere-setup bootstrap --bundle opensphere-airgap.osbundle
```

일반 Kubernetes 폐쇄망에서 node가 image를 받으려면 cluster-accessible registry 또는 지원 runtime import adapter가 필요하다. Setup은 이를 자동 발견하고 GUI로 안내해야 하며, 가능한 것처럼 가장해서는 안 된다.

---

## 14. Idempotency, resume와 repair

### 14.1 Idempotency

- 같은 release를 다시 실행하면 duplicate resource를 만들지 않는다.
- immutable field 충돌은 삭제·재생성하지 않고 영향과 조치를 표시한다.
- 사용자가 소유한 host resource를 수정하지 않는다.

### 14.2 Resume

`resume`은 local 기억이 아니라 `OpenSphereBootstrap.status`와 live resource를 다시 읽어 다음 안전 단계부터 진행한다.

```powershell
opensphere-setup status
opensphere-setup resume
```

### 14.3 Repair

`repair`는 bootstrap release가 소유한다고 명시된 resource만 desired state로 복구한다. PVC, Secret 또는 사용자 데이터를 자동 삭제하지 않는다.

---

## 15. 출력과 오류 계약

### 15.1 사람용 기본 출력

```text
[완료] Kubernetes 연결
[완료] Bootstrap Console 기동
[필요] 영구 저장 위치 선택
[대기] Console Backbone Service Stack 설치

다음 조치: OpenSphere Console에서 저장 위치를 선택하세요.
Console: https://127.0.0.1:8090/
```

### 15.2 자동화 출력

```powershell
opensphere-setup status --output json
```

```json
{
  "phase": "BootstrapConsoleAvailable",
  "retryable": true,
  "nextAction": {
    "code": "ConfigureStorage",
    "message": "영구 데이터 저장 위치를 선택하세요."
  }
}
```

### 15.3 Exit code

| code | 의미 |
|---:|---|
| 0 | 요청한 wait stage 도달 또는 읽기 명령 성공 |
| 2 | 사용자 입력 필요 |
| 3 | 권한 부족 |
| 4 | cluster 연결 실패 |
| 5 | release/signature 검증 실패 |
| 6 | retry 가능한 bootstrap 실패 |
| 7 | 수동 복구가 필요한 Blocked |
| 8 | 지원하지 않는 host/version |

---

## 16. 구현 구조 제안

```text
OpenSphere-Setup-CLI/
├─ cmd/opensphere-setup/       # binary entry
├─ internal/bootstrap/         # state machine
├─ internal/kube/              # client-go, discovery, SSA, port-forward
├─ internal/release/           # digest/signature/SBOM 검증
├─ internal/state/             # OpenSphereBootstrap contract
├─ internal/journal/           # bootstrap evidence와 CBS import
├─ internal/ui/                # embedded GUI server/asset
├─ manifests/                  # embedded bootstrap-only resources
├─ api/                        # bootstrap CRD types
├─ tests/                      # unit/contract/integration
└─ README.md
```

Go를 기본 구현 언어로 권장한다.

- 단일 static binary 배포가 용이하다.
- Kubernetes `client-go`를 직접 사용할 수 있다.
- cross-platform build와 code signing이 단순하다.
- embedded filesystem으로 GUI와 manifest를 포함할 수 있다.

---

## 17. 테스트와 승인 기준

### 17.1 사용자 경험

- Kubernetes 전문 지식이 없는 사용자가 실행 파일과 kubeconfig만으로 Bootstrap Console을 열 수 있다.
- 별도 CLI dependency 설치를 요구하지 않는다.
- 기술 오류를 사용자 조치 문장으로 변환한다.

### 17.2 기능

- clean supported Kubernetes에서 `bootstrap` 성공
- IngressClass가 없어도 embedded port-forward로 Console 접근
- StorageClass가 없어도 Bootstrap Console 접근 유지
- CBS 실패 시 Main Shell 일반 기능 차단
- 중단 후 다른 process에서 resume
- 같은 release 재실행 시 no-op
- cleanup 후 Main Shell 정상 유지

### 17.3 보안

- kubeconfig·Secret·token이 cluster object, log, URL에 노출되지 않음
- unsigned/tampered release 차단
- bootstrap allowlist 밖 mutation 차단
- CBS audit import 실패 시 Main Shell write 차단
- 최소 RBAC와 권한 제거 검증

### 17.4 Conformance

- PostgreSQL append/read
- RustFS object put/get/delete
- Gitea commit/read
- Main Shell `/readyz`
- browser login과 Bootstrap → Main Shell 전환
- failure injection과 resume

---

## 18. 구현 단계

### Phase 1 — CLI bootstrap core

- Go module과 binary entry
- kubeconfig/context 선택
- release verification
- embedded manifest와 server-side apply
- Bootstrap Console 설치
- status/resume/open

### Phase 2 — CBS engine

- PostgreSQL·RustFS·Gitea orchestration
- actual I/O conformance
- bootstrap journal import
- Main Shell handoff

### Phase 3 — GUI

- embedded Clarity v18 UI
- 초보 사용자용 cluster 선택과 progress
- capability 안내와 remediation
- local secure tunnel과 browser open

### Phase 4 — production hardening

- code signing, SBOM, release channel
- offline bundle
- rollback/repair
- cross-platform packaging
- E2E와 failure injection

---

## 19. 현재 상태와 정본 정합

이 문서는 제품 방향과 목표 계약을 정의한 **설계 초안**이다. 실행 가능한 Setup binary가 구현됐다는 뜻이 아니다.

현재 개발용 `bring-up.sh`, `install-backbone`류 스크립트는 이 제품의 사용자 설치 interface가 아니다. 향후에는 내부 개발·진단 도구로만 유지하거나 Setup engine의 테스트 fixture로 격하한다.

`CONSTITUTION-0004` v1.2.0은 초기 Console 기동과 HIS Preflight를 분리한다. Setup은 전체 HIS를 선행 검사하지 않고 Bootstrap Console과 CBS/Main Shell을 먼저 세운다. 첫 operational subShell인 Cluster Manager가 활성화된 뒤 그 live 진단 경로로 HIS를 검증한다.

```text
Console Bootstrap Available
→ CBS Ready
→ Main Shell Baseline Ready
→ Cluster Manager Activated
→ HIS Preflight Ready
→ Platform Support Profile Ready
→ PFS Established
```

Kubernetes API 연결과 Console workload 실행 가능 여부는 Setup의 최소 물리 조건이다. 이것을 CNI·DNS·Ingress·CSI·certificate·metrics·snapshot 전체에 대한 `HIS Ready` 판정으로 확대해서는 안 된다.

---

## 20. 최종 원칙

> Kubernetes가 동작하고 설치 권한이 있으면 사용자는 실행 파일 하나로 OpenSphere Bootstrap Console을 열 수 있어야 한다.

> HIS 전체 Ready는 초기 Console 기동의 선행조건이 아니다. 부족한 host capability는 Console 안에서 발견하고 안내한다.

> CBS가 Ready가 되기 전의 Console은 설치·복구용 Bootstrap Mode이며 정상 운영 또는 Production Ready를 주장하지 않는다.

> 최초 설치 이후의 일반 운영은 Console GUI와 Console-native `os` CLI가 소유한다.
