# OpenSphere Setup 릴리스 배포 및 버전 선택 구현 계획

> **Status**: Implementation specification  
> **Version**: 1.0.0  
> **Date**: 2026-07-12  
> **Applies to**: `opensphere-setup` online/offline bootstrap  
> **Parent authority**: `_DOCS_/01-CONSTITUTION/CONSTITUTION-0005-OCI-IMAGE-CHANNEL-PROMOTION-INSTALLATION-POLICY.md`  
> **Parent specification**: `OpenSphere-Setup-CLI/README.md`

---

## 0. 목적

이 문서는 다음 설치 시나리오를 실제로 동작시키기 위해 필요한 저장소, 릴리스 메타데이터, 이미지 공급, 버전 선택, 검증, 설치 잠금과 운영 절차를 정의한다.

> 설치 관리자는 `stable`, `candidate`, `edge` 중 설치 의도를 나타내는 채널 또는 특정 OpenSphere 통합 릴리스를 선택한다. Setup은 선택된 채널을 서명된 BOM으로 해석하고 고정된 이미지 digest들을 검증하여 자동 설치한다. 기본값은 `stable`이다.

이 계약이 완성되기 전에는 각 channel이 실제 어느 digest 집합을 의미하는지, 어떤 이미지가 설치되는지 또는 같은 설치를 재현할 수 있는지 보장할 수 없다.

---

## 1. 최상위 결정

### 결정 1 — 설치 단위는 컴포넌트가 아니라 OpenSphere 통합 릴리스다

설치 관리자가 선택할 수 있는 버전 단위는 하나다.

```text
OpenSphere Platform 2.0.3
```

다음과 같은 개별 버전 조합은 지원하지 않는다.

```text
Console 2.0.3 + Auth 2.0.1 + Backbone latest  # 금지
```

통합 릴리스가 Console, 인증, backend, controller와 CBS 이미지의 정확한 digest를 소유한다.

### 결정 2 — Setup은 Git repository를 clone하거나 image를 build하지 않는다

각 소스 repository의 CI가 image, SBOM, signature와 provenance를 발행한다. Platform Release Pipeline은 검증을 통과한 결과만 통합 Release BOM에 편입한다.

Setup은 다음 배포 산출물만 소비한다.

- signed release index
- signed release BOM
- digest-pinned OCI images
- manifest bundle
- SBOM과 provenance
- 선택적으로 air-gap bundle

### 결정 3 — `stable`은 임의의 최신 tag가 아니다

`stable`을 선택하면 Setup은 signed release index에서 다음 조건을 모두 만족하는 `recommended` 릴리스를 해석한다.

- 현재 Kubernetes version 지원
- cluster CPU architecture 지원
- Setup bootstrap contract 호환
- 철회 또는 차단되지 않은 릴리스
- 모든 필수 artifact의 서명과 digest 검증 성공

단순히 가장 큰 semantic version이나 mutable `latest` tag를 선택해서는 안 된다.

### 결정 4 — 관리자 승인 후 전체 release를 잠근다

Setup은 설치 직전에 통합 버전, 다운로드 크기, registry, 필수 이미지와 검증 상태를 보여준다. 관리자가 승인하면 release BOM digest와 모든 component image digest를 installation lock에 기록한다.

설치 도중 release index가 바뀌더라도 잠긴 버전은 바뀌지 않는다.

### 결정 5 — 초기 Setup은 Main Shell 필수 구성만 설치한다

초기 통합 릴리스에는 다음만 포함한다.

- Console Main Shell
- Kanidm과 `opensphere-auth` 인증 기반
- Console backend와 필수 controller
- Console Backbone Service Stack(CBS): PostgreSQL, RustFS, Gitea
- Main Shell 진입과 관리에 필요한 최소 gateway/RBAC/configuration

subShell, plugin, Foundation Service Stack과 Base Service Stack workload는 초기 이미지 집합에 포함하지 않는다. Main Shell Ready 이후 Console Catalog에서 별도 버전 계약으로 설치한다.

### 결정 6 — stable 채널의 CBS PostgreSQL major version은 19다

OpenSphere는 preview뿐 아니라 `stable` 채널에서도 PostgreSQL 19 계열을 사용한다. PostgreSQL 18 이하로 자동 fallback하지 않는다.

2026-07-12 현재 PostgreSQL 19의 공식 가용 image는 `postgres:19beta1-alpine`이므로 최초 stable 후보는 해당 image의 multi-architecture digest를 고정한다.

```text
docker.io/library/postgres:19beta1-alpine
@sha256:d2e89cb432902a3b7a9d447a587fffeea0b4cddff5a07784241d35e1a16de253
```

PostgreSQL 19 GA가 발행되면 새로운 OpenSphere patch release에서 GA image digest로 교체한다. 이미 발행된 BOM의 Beta digest를 같은 version 안에서 바꾸지 않는다. PostgreSQL 19를 사용할 수 없는 환경은 해당 OpenSphere release와 비호환으로 처리하며, 이전 major version을 대신 설치하지 않는다.

이 결정은 **신규 Setup의 clean install 기준**이다.

- 다음 신규 설치는 빈 PostgreSQL 19 data directory를 생성한다.
- PostgreSQL 17/18의 기존 데이터 유지 또는 19로의 migration은 Setup 범위가 아니다.
- 기존 OpenSphere/CBS가 발견되면 Setup은 실행 중인 PostgreSQL major version을 교체하지 않는다.
- release lock이 있는 `resume`/`repair`는 잠긴 기존 image digest를 그대로 사용한다.
- 기존 설치를 19로 바꾸는 기능은 별도 upgrade 제품 계약이 정의되기 전까지 제공하지 않는다.

---

## 2. 저장소와 배포 책임

### 2.1 Source repository

| 저장소 유형 | 책임 | Setup의 직접 접근 |
|---|---|---|
| Platform source repository | Setup 사양, bootstrap API, release schema와 통합 배포 계약 | 하지 않음 |
| Console source repository | Console, auth BFF, backend, 필수 controller build | 하지 않음 |
| Upstream source | Kanidm, PostgreSQL, RustFS, Gitea 원본 | 하지 않음 |
| subShell/plugin repository | 선택 확장 기능 build | 초기 Setup에서 하지 않음 |

소스 repository URL은 provenance의 추적 정보이지 설치 입력값이 아니다.

### 2.2 Release Repository

Release Repository는 Setup이 온라인 설치에서 접근하는 정본 메타데이터 endpoint다.

권장 논리 구조:

```text
releases.opensphere.example/
├─ v1/index.json
├─ v1/channels/stable.json
├─ v1/channels/candidate.json
├─ v1/channels/edge.json
├─ v1/releases/2.0.3/release.yaml
├─ v1/releases/2.0.3/release.yaml.sig
├─ v1/releases/2.0.3/manifests.tar.zst
├─ v1/releases/2.0.3/manifests.tar.zst.sig
├─ v1/releases/2.0.3/sbom.spdx.json
└─ v1/releases/2.0.3/provenance.json
```

실제 hostname은 배포 전에 정해야 한다. URL은 Setup binary의 기본 설정에 포함하되, enterprise mirror 또는 offline bundle을 명시적으로 선택할 수 있어야 한다.

### 2.3 OCI Registry

모든 image reference는 다음 형식이어야 한다.

```text
<registry>/<organization>/<image>@sha256:<digest>
```

다음 형식은 정식 release BOM에서 거부한다.

- `image: latest`
- `image: dev`
- registry가 없는 local image name
- tag만 있고 digest가 없는 image
- `localhost:*` image

Registry는 public read 또는 scoped read-only credential을 지원해야 한다. Setup은 credential을 log, URL, bootstrap CR 또는 release lock에 기록하지 않는다.

---

## 3. Release Index 계약

Release index는 channel을 실제 통합 버전으로 해석하기 위한 signed metadata다.

예시:

```json
{
  "apiVersion": "release.opensphere.io/v1",
  "generatedAt": "2026-07-12T10:00:00Z",
  "channels": {
    "stable": {
      "recommended": "2.0.3",
      "supported": ["2.0.3", "2.0.2"]
    },
    "candidate": {
      "recommended": "2.1.0-rc.1",
      "supported": ["2.1.0-rc.1"]
    },
    "edge": {
      "recommended": "2.1.0-edge.14",
      "supported": ["2.1.0-edge.14"]
    }
  },
  "releases": {
    "2.1.0-edge.14": {
      "status": "Active",
      "bom": "v1/releases/2.1.0-edge.14/release.yaml",
      "bomDigest": "sha256:<digest>",
      "minSetupVersion": "1.0.0"
    },
    "2.1.0-rc.1": {
      "status": "Active",
      "bom": "v1/releases/2.1.0-rc.1/release.yaml",
      "bomDigest": "sha256:<digest>",
      "minSetupVersion": "1.0.0"
    },
    "2.0.3": {
      "status": "Active",
      "bom": "v1/releases/2.0.3/release.yaml",
      "bomDigest": "sha256:<digest>",
      "minSetupVersion": "1.0.0"
    },
    "2.0.2": {
      "status": "Maintenance",
      "bom": "v1/releases/2.0.2/release.yaml",
      "bomDigest": "sha256:<digest>",
      "minSetupVersion": "1.0.0"
    }
  }
}
```

허용 상태:

| 상태 | 신규 설치 | 기존 설치 복구 | 의미 |
|---|---:|---:|---|
| `Active` | 허용 | 허용 | 정상 지원 릴리스 |
| `Maintenance` | 고급 선택 | 허용 | 유지보수 기간 |
| `Deprecated` | 기본 화면에서 숨김 | 조건부 허용 | 업그레이드 권고 |
| `Revoked` | 금지 | 금지 | 보안 또는 무결성 문제로 철회 |
| `Blocked` | 금지 | 금지 | 알려진 설치 장애 |

Index와 channel metadata는 캐시할 수 있지만, 온라인 설치 직전 서명과 만료시간을 다시 검증한다. 캐시만으로 신규 설치를 진행해서는 안 된다.

---

## 4. 통합 Release BOM 계약

Release BOM은 한 번 발행한 뒤 수정할 수 없는 immutable document다. 같은 version에 다른 digest를 다시 발행하지 않는다. 수정이 필요하면 새로운 patch version을 발행한다.

```yaml
apiVersion: release.opensphere.io/v1
kind: OpenSphereRelease
metadata:
  version: 2.0.3
  channel: stable
  releaseId: opensphere-2.0.3

spec:
  bootstrapContract: v1alpha1
  minSetupVersion: 1.0.0
  supportedKubernetes: ">=1.30.0 <1.34.0"
  supportedArchitectures: [amd64, arm64]

  components:
    console:
      source: opensphere-console
      image: registry.opensphere.example/platform/opensphere-console@sha256:<digest>
      sbomDigest: sha256:<digest>
    kanidm:
      source: upstream/kanidm
      image: docker.io/kanidm/server@sha256:<digest>
      sbomDigest: sha256:<digest>
    opensphereAuth:
      source: opensphere-console
      image: registry.opensphere.example/platform/opensphere-auth@sha256:<digest>
      sbomDigest: sha256:<digest>
    consoleBackend:
      source: opensphere-console
      image: registry.opensphere.example/platform/console-backend@sha256:<digest>
      sbomDigest: sha256:<digest>
    dupaController:
      source: opensphere-console
      image: registry.opensphere.example/platform/dupa-registry-controller@sha256:<digest>
      sbomDigest: sha256:<digest>
    backbonePostgresql:
      source: curated/postgresql
      productVersion: 19beta1
      majorVersion: 19
      image: registry.opensphere.example/backbone/postgresql@sha256:<digest>
      upstreamImage: docker.io/library/postgres:19beta1-alpine@sha256:d2e89cb432902a3b7a9d447a587fffeea0b4cddff5a07784241d35e1a16de253
      sbomDigest: sha256:<digest>
    backboneRustfs:
      source: curated/rustfs
      image: registry.opensphere.example/backbone/rustfs@sha256:<digest>
      sbomDigest: sha256:<digest>
    backboneGitea:
      source: curated/gitea
      image: registry.opensphere.example/backbone/gitea@sha256:<digest>
      sbomDigest: sha256:<digest>

  manifests:
    url: v1/releases/2.0.3/manifests.tar.zst
    digest: sha256:<digest>

  requiredStorage:
    kanidm: 10Gi
    postgresql: 20Gi
    rustfs: 50Gi
    gitea: 10Gi

  estimatedDownloadBytes: 0
  releaseNotes: v1/releases/2.0.3/RELEASE-NOTES.md
  provenance: v1/releases/2.0.3/provenance.json
```

필수 validation:

- version과 releaseId 일치
- 모든 필수 component 존재
- 모든 image가 registry-qualified digest reference
- 지원 Kubernetes range와 architecture 존재
- manifest archive digest 존재
- 각 image의 SBOM과 provenance 연결
- Keycloak 등 폐기된 identity stack이 초기 manifest에 포함되지 않음
- subShell/plugin workload가 initial baseline에 포함되지 않음
- `stable` BOM의 `backbonePostgresql.majorVersion`이 `19`이고 PostgreSQL 18 이하로 fallback하지 않음

---

## 5. 버전 선택 사용자 경험

### 5.1 GUI 기본 모드

```text
OpenSphere 버전

● 2.0.3  Stable · 권장
  Kubernetes 1.30–1.33 · amd64/arm64
  서명 확인됨 · 예상 다운로드 4.2 GB

○ 다른 지원 버전 선택
○ 오프라인 설치 Bundle 사용
```

기본 모드는 `stable.recommended` 한 개를 제안한다. 사용자가 세부 화면을 열면 필수 component, image registry, digest 앞/뒤 일부, 용량과 release note를 확인할 수 있다.

### 5.2 GUI 고급 모드

고급 모드에서도 통합 릴리스만 선택한다. 개별 component version 편집 UI를 제공하지 않는다.

다음을 구분해 표시한다.

- 권장 릴리스
- 지원 중인 과거 릴리스
- 현재 cluster와 비호환인 릴리스와 사유
- 철회되어 선택할 수 없는 릴리스와 사유

### 5.3 CLI

```powershell
# stable channel의 recommended 호환 릴리스
opensphere-setup bootstrap --release stable

# 시험·검수 channel의 현재 승격 후보
opensphere-setup bootstrap --release candidate

# 개발 channel의 현재 통합 build
opensphere-setup bootstrap --release edge

# 특정 통합 릴리스
opensphere-setup bootstrap --release 2.0.3

# 자동화에서 사전 승인
opensphere-setup bootstrap --release 2.0.3 --non-interactive --accept-release-digest sha256:<digest>

# 폐쇄망 bundle
opensphere-setup bootstrap --bundle opensphere-2.0.3.osbundle
```

`--non-interactive`는 mutable channel만으로 실행할 수 없다. 자동화는 정확한 version과 예상 release BOM digest를 함께 제공해야 한다.

---

## 6. 온라인 설치 해석 절차

```text
1. Kubernetes 연결과 version/architecture 발견
2. Setup 자체 version 확인
3. Release index 다운로드
4. Index signature·expiry 검증
5. channel 또는 exact version 해석
6. release BOM 다운로드
7. BOM digest·signature 검증
8. cluster compatibility 검사
9. image registry 접근성·필요 용량 검사
10. 설치 요약 표시와 관리자 승인
11. release lock 기록
12. manifest archive 검증
13. digest-pinned image를 사용해 server-side apply
14. component별 readiness와 실제 기능 검증
15. 설치 evidence와 최종 release digest 기록
```

어떤 단계에서도 tag를 다시 조회해 digest를 바꾸지 않는다.

---

## 7. Installation Lock과 재현성

관리자 승인 후 `OpenSphereBootstrap.status` 또는 별도 `OpenSphereInstallation` CR에 다음 비밀이 아닌 정보만 기록한다.

```yaml
status:
  resolvedRelease:
    requested: stable
    version: 2.0.3
    releaseDigest: sha256:<digest>
    manifestDigest: sha256:<digest>
    resolvedAt: "2026-07-12T10:15:00Z"
    components:
      console: registry.opensphere.example/platform/opensphere-console@sha256:<digest>
      kanidm: docker.io/kanidm/server@sha256:<digest>
      opensphereAuth: registry.opensphere.example/platform/opensphere-auth@sha256:<digest>
      # 나머지 BOM component
```

원칙:

- `resume`과 `repair`는 lock의 digest를 사용한다.
- 같은 release digest 재실행은 no-op이어야 한다.
- channel이 새 version을 가리켜도 기존 설치는 자동 변경되지 않는다.
- Setup은 기존 PostgreSQL major version을 변경하거나 기존 데이터를 migration하지 않는다.
- version 변경은 향후 별도 upgrade transaction으로만 수행한다.
- registry credential, password, token과 private key는 lock에 저장하지 않는다.

---

## 8. 인증 스택과 최초 관리자 Wizard 편입

Release BOM은 인증을 선택 기능이 아닌 Console 필수 구성으로 포함한다.

```text
Kanidm
+ opensphere-auth
+ Kanidm TLS/CA
+ opensphere-auth signing key
+ auth policy
+ same-origin nginx routing
= Authentication Stack
```

Setup 단계:

```text
ReleaseLocked
→ AuthenticationStackInstalling
→ AuthenticationStackReady
→ BootstrapConsoleInstalling
→ InitialAdminRequired
→ InitialAdminReady
→ CBSInstalling
→ MainShellReady
```

최초 관리자는 Setup CLI 인자나 YAML에 비밀번호를 넣어 만드는 방식이 아니라, Setup이 연 loopback secure tunnel을 통한 Console 최초 접속 Wizard에서 생성한다.

릴리스 conformance는 다음을 검증해야 한다.

- Kanidm health와 실제 credential transaction
- `opensphere-auth` discovery와 JWKS
- Authorization Code + PKCE 로그인
- `opensphere-console-admins` 최초 등록
- admin API `401/403/2xx` 경계
- 최초 관리자 생성 후 one-time bootstrap token 폐기

---

## 9. Offline Bundle

`.osbundle`은 정확한 하나의 통합 릴리스를 포함한다.

```text
opensphere-2.0.3.osbundle
├─ release.yaml
├─ release.yaml.sig
├─ release-index-snapshot.json
├─ manifests.tar.zst
├─ images/
│  └─ OCI image archives
├─ sbom/
├─ provenance/
├─ CHECKSUMS
└─ CHECKSUMS.sig
```

Offline 설치에서도 version 선택 규칙은 동일하다. Bundle 안의 component version을 사용자가 교체할 수 없다.

필수 절차:

```powershell
opensphere-setup bundle verify opensphere-2.0.3.osbundle
opensphere-setup bootstrap --bundle opensphere-2.0.3.osbundle
```

Cluster가 bundle image를 받을 수 있도록 다음 중 지원되는 한 경로를 선택한다.

- cluster-accessible private registry로 사전 mirror
- Setup의 승인된 registry import workflow
- 지원 container runtime용 명시적 import adapter

Setup은 지원되지 않는 runtime import를 임의로 시도하지 않는다.

---

## 10. Enterprise Registry Mirror

기업 환경은 upstream registry 대신 내부 mirror를 사용할 수 있다.

```yaml
registryMirror:
  source: registry.opensphere.example
  target: registry.corp.example/opensphere
  mappingManifestDigest: sha256:<digest>
```

Mirror는 repository 경로를 바꿀 수 있지만 image content digest는 같아야 한다. digest가 다르면 다른 artifact이므로 설치를 차단한다.

Upstream Kanidm 등 외부 image도 release 승인 시점에 digest를 고정하고 필요하면 OpenSphere curated registry로 복제한다. 라이선스와 재배포 조건은 release pipeline에서 검증한다.

---

## 11. 서명과 신뢰 계약

### 11.1 검증 대상

- Setup binary와 installer package
- Release index
- Release BOM
- Manifest archive
- 각 OCI image
- Offline bundle
- SBOM과 provenance reference

### 11.2 Trust root

Setup binary에는 승인된 release signing trust root와 key ID를 포함한다. key rotation metadata는 기존 신뢰키로 서명되어야 한다.

서명 검증 실패, 알 수 없는 signer, 만료된 metadata 또는 digest 불일치는 우회할 수 없는 `Blocked`다. 일반 설치 화면에 `무시하고 계속` 기능을 제공하지 않는다.

### 11.3 공급망 승인

통합 Release Pipeline은 BOM 생성 전에 다음을 확인한다.

- source commit과 build provenance 연결
- 테스트와 conformance 통과
- vulnerability/license policy 통과
- SBOM 존재
- image signature 존재
- immutable digest 확인
- 필수 component API/schema compatibility

---

## 12. 오류 및 정책

| 상황 | 동작 |
|---|---|
| `stable`에 호환 recommended release 없음 | 설치 차단, 호환성 사유 표시 |
| exact version이 Revoked | 설치 차단 |
| Setup version이 너무 낮음 | Setup 자체 upgrade 안내 |
| 일부 image를 registry에서 받을 수 없음 | 설치 시작 전 차단 또는 offline/mirror 안내 |
| 설치 중 index 변경 | installation lock 유지 |
| image digest 불일치 | 즉시 차단, 적용하지 않음 |
| architecture image 누락 | 해당 cluster 설치 차단 |
| 이전 설치 resume | 저장된 release lock 사용 |
| release lock 없이 기존 PostgreSQL/CBS 발견 | 기존 workload 변경 금지, `ExistingInstallationUnmanaged`로 차단 |
| 사용자가 component version 혼합 요청 | 지원하지 않음을 명시 |

---

## 13. 현재 개발 참조의 정식 릴리스 전환 작업

현재 코드에 존재하는 날짜 tag, `latest`, `dev`, `localhost`와 registry 없는 image reference는 release 후보가 아니다. 다음 migration을 완료해야 한다.

1. 초기 Setup 필수 component inventory 확정
2. component owner/source repository mapping 확정
3. 중앙 OCI registry와 namespace 확정
4. 각 component CI에서 multi-architecture image build
5. image tag와 별도로 immutable digest 발행
6. SBOM, signature와 provenance 발행
7. 폐기된 Keycloak manifest를 initial release allowlist에서 제외
8. Kanidm 승인 version을 tag가 아닌 digest로 고정
9. PostgreSQL 19 + pgvector image를 빌드·검증하고 GHCR digest로 고정
10. manifest에서 local image name을 완전한 registry digest reference로 교체
11. Release Index/BOM schema와 validator 구현
12. Platform Release Pipeline에서 통합 conformance 수행
13. Setup resolver, approval UI와 installation lock 구현

---

## 14. 구현 Work Package

### WP-1 — Release schema와 validator

- `release-index.schema.json`
- `opensphere-release.schema.json`
- semantic/compatibility validator
- 금지 image reference 검사
- revoked release 처리

완료 기준: 잘못된 BOM fixture가 모두 거부되고 정상 fixture만 통과한다.

### WP-2 — Component CI publication

- digest-pinned multi-arch image
- SBOM
- signature
- provenance
- release candidate metadata

완료 기준: 모든 initial baseline component가 동일한 publication contract를 만족한다.

### WP-3 — Platform Release Pipeline

- component candidate 수집
- compatibility/conformance 실행
- immutable BOM과 manifest archive 생성
- signed release index channel promotion
- 철회 절차

완료 기준: `edge`, `candidate`, `stable`의 각 `recommended`가 서명된 하나의 설치 가능한 BOM으로 해석되고, 승격된 artifact는 동일 digest를 유지한다.

### WP-4 — Setup resolver

- repository client와 cache
- signature/digest 검증
- Kubernetes/architecture compatibility filtering
- `stable`/`candidate`/`edge`/exact version/offline bundle 해석
- installation lock

완료 기준: 같은 입력은 항상 같은 digest 집합으로 해석된다.

### WP-5 — GUI/CLI approval

- 권장 릴리스 표시
- 설치 이미지·용량·release note 표시
- 비호환/철회 사유 표시
- non-interactive digest 승인 계약

완료 기준: 사용자가 개별 component version을 알거나 선택하지 않아도 안전하게 통합 릴리스를 승인할 수 있다.

### WP-6 — Registry와 offline

- read-only credential
- enterprise mirror
- `.osbundle` 생성/검증
- air-gap import adapter

완료 기준: online과 offline 설치가 동일한 release digest 결과를 만든다.

### WP-7 — E2E와 운영

- clean cluster install
- interrupted install resume
- channel 변경 중 설치
- revoked release 차단
- registry 장애
- digest 변조
- Authentication Stack과 최초 Admin Wizard
- CBS 및 Main Shell handoff

완료 기준: release evidence로 설치 version과 모든 image digest를 재현할 수 있다.

---

## 15. 승인 기준

다음 조건을 모두 만족해야 이 시나리오가 구현 완료된 것으로 판정한다.

- [ ] 실제 Release Repository URL이 정해져 있다.
- [ ] 실제 OCI Registry와 credential 정책이 정해져 있다.
- [ ] signed release index에서 `edge`, `candidate`, `stable`의 각 `recommended`를 해석할 수 있다.
- [ ] channel 승격이 image 재build 없이 동일 digest로 수행된다.
- [ ] exact version을 선택할 수 있다.
- [ ] 모든 필수 image가 완전한 registry path와 digest를 가진다.
- [ ] 모든 필수 image에 SBOM, signature와 provenance가 있다.
- [ ] Setup이 cluster 호환성을 확인한다.
- [ ] 관리자가 통합 릴리스 하나만 승인한다.
- [ ] 승인 후 release/component digest가 잠긴다.
- [ ] resume/repair가 잠긴 digest를 사용한다.
- [ ] 개별 component version 혼합이 차단된다.
- [ ] 폐기·철회된 release 설치가 차단된다.
- [ ] online과 offline 결과가 같은 BOM으로 재현된다.
- [ ] Kanidm과 `opensphere-auth`가 필수 이미지로 설치된다.
- [ ] `stable` 채널이 PostgreSQL 19 image만 사용하며 이전 major version으로 fallback하지 않는다.
- [ ] 신규 Setup이 빈 PostgreSQL 19 data directory로 시작한다.
- [ ] 기존 CBS를 발견한 Setup이 실행 중인 PostgreSQL을 변경하지 않는다.
- [ ] 최초 Admin Wizard 완료 후 정상 로그인이 가능하다.
- [ ] CBS Ready와 Main Shell Ready까지 release evidence가 유지된다.

---

## 16. 최종 사용자 시나리오

```text
OpenSphere-Setup 실행
→ Kubernetes 선택
→ signed release index 확인
→ “OpenSphere 2.0.3 Stable · 권장” 표시
→ 관리자가 설치 승인
→ release BOM과 image digest 잠금
→ 인증 기반과 Bootstrap Console 설치
→ 최초 Admin 생성 Wizard
→ CBS 설치·검증
→ Main Shell Ready
→ 설치된 version·digest·검증 결과 보고
```

설치 관리자는 Kubernetes workload별 image version을 결정하지 않는다. OpenSphere Release Engineering이 검증된 통합 BOM을 제공하고, Setup이 그 BOM을 정확히 검증·재현하는 것이 이 시나리오의 책임 경계다.
